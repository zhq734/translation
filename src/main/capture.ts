import { clipboard, systemPreferences } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  hasClipboardCaptureCompleted,
  shouldRestoreClipboardAfterAbort,
  shouldRestoreClipboard,
  resolveCapturedClipboardState,
  type ResolvedClipboardCapture
} from '../shared/copyShortcutBehavior'
import {
  parseNativeSelectionReadOutput,
  parseSelectionPresenceOutput,
  type SelectionPresence
} from '../shared/selectionBehavior'
import { copyShortcutGuard } from './copyShortcutState'
import {
  getSelectionCapturePlan,
  resolveSelectionCaptureStrategy,
  type NativeSelectionReadResult
} from '../shared/platformCapture'
import type { SelectionCaptureOutcome } from '../shared/selectionCaptureCoordinator'

const execFileP = promisify(execFile)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const CLIPBOARD_STABILITY_DELAY_MS = 120
const SELECTION_INSPECTION_TIMEOUT_MS = 1500
const NATIVE_SELECTION_RETRY_COUNT = 2
const NATIVE_SELECTION_RETRY_DELAY_MS = 40

// macOS 通过辅助功能读取前台控件的选中文字；PRESENT 时同时输出选中文本，不读取或修改剪贴板。
const MACOS_SELECTION_PRESENCE = [
  'tell application "System Events"',
  'try',
  'set frontProcess to first application process whose frontmost is true',
  'set focusedElement to value of attribute "AXFocusedUIElement" of frontProcess',
  'set selectedText to value of attribute "AXSelectedText" of focusedElement',
  'if selectedText is missing value then return "UNKNOWN"',
  'if (selectedText as text) is "" then return "EMPTY"',
  'return "PRESENT\n" & (selectedText as text)',
  'on error',
  'return "UNKNOWN"',
  'end try',
  'end tell'
].join('\n')

// Windows 通过 UI Automation TextPattern 检查焦点控件是否存在非空选区；PRESENT 时同时输出文本，不发送 Ctrl+C。
const WINDOWS_SELECTION_PRESENCE = [
  'Add-Type -AssemblyName UIAutomationClient;',
  '$element = [System.Windows.Automation.AutomationElement]::FocusedElement;',
  "if ($null -eq $element) { Write-Output 'UNKNOWN'; exit }",
  '$pattern = $null;',
  "if (-not $element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { Write-Output 'UNKNOWN'; exit }",
  '$ranges = ([System.Windows.Automation.TextPattern]$pattern).GetSelection();',
  "if ($null -eq $ranges -or $ranges.Count -eq 0) { Write-Output 'EMPTY'; exit }",
  "$text = ($ranges | ForEach-Object { $_.GetText(-1) }) -join '';",
  "if ([string]::IsNullOrWhiteSpace($text)) { Write-Output 'EMPTY' } else { Write-Output ('PRESENT' + [char]10 + $text) }"
].join(' ')

// 使用 Windows user32.dll 向当前前台窗口发送 Ctrl+C，不抢占前台焦点。
const WINDOWS_COPY = [
  "$signature = '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);';",
  "Add-Type -MemberDefinition $signature -Name NativeKeyboard -Namespace SelectionTranslator;",
  "[SelectionTranslator.NativeKeyboard]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero);",
  "[SelectionTranslator.NativeKeyboard]::keybd_event(0x43, 0, 0, [UIntPtr]::Zero);",
  "[SelectionTranslator.NativeKeyboard]::keybd_event(0x43, 0, 2, [UIntPtr]::Zero);",
  "[SelectionTranslator.NativeKeyboard]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero);"
].join(' ')

export class PermissionError extends Error {}

/**
 * 在不模拟复制快捷键的前提下检查前台应用当前是否存在选中文字。
 * Linux 读取主选区，macOS 使用辅助功能属性，Windows 使用 UI Automation；无法确认时返回 unknown。
 * @returns 当前系统选区状态。
 * @author zhenghq
 */
export async function inspectSelectedTextPresence(): Promise<SelectionPresence> {
  try {
    if (process.platform === 'linux') {
      return clipboard.readText('selection').trim() ? 'present' : 'empty'
    }

    if (process.platform === 'darwin') {
      const { stdout } = await execFileP(
        'osascript',
        ['-e', MACOS_SELECTION_PRESENCE],
        { timeout: SELECTION_INSPECTION_TIMEOUT_MS }
      )
      return parseSelectionPresenceOutput(stdout)
    }

    if (process.platform === 'win32') {
      const { stdout } = await execFileP('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        WINDOWS_SELECTION_PRESENCE
      ], {
        timeout: SELECTION_INSPECTION_TIMEOUT_MS,
        windowsHide: true
      })
      return parseSelectionPresenceOutput(stdout)
    }
  } catch {
    return 'unknown'
  }

  return 'unknown'
}

/**
 * 在不模拟复制快捷键的前提下原生直读当前前台应用的选中文字。
 * macOS 使用辅助功能属性，Windows 使用 UI Automation，Linux 读取主选区；均不触碰剪贴板。
 * @param signal 用于在请求失效后中止原生命令的取消信号。
 * @returns 直读结果，包含状态、选中文本与可能的失败原因。
 * @author zhenghq
 */
export async function readSelectionByNative(
  signal?: AbortSignal
): Promise<NativeSelectionReadResult> {
  try {
    if (signal?.aborted) return { status: 'unknown', text: '', reason: 'unknown' }

    if (process.platform === 'linux') {
      const text = clipboard.readText('selection')
      return text.trim() ? { status: 'present', text } : { status: 'empty', text: '' }
    }

    if (process.platform === 'darwin') {
      const { stdout } = await execFileP(
        'osascript',
        ['-e', MACOS_SELECTION_PRESENCE],
        { timeout: SELECTION_INSPECTION_TIMEOUT_MS, signal }
      )
      return parseNativeSelectionReadOutput(stdout)
    }

    if (process.platform === 'win32') {
      const { stdout } = await execFileP('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        WINDOWS_SELECTION_PRESENCE
      ], {
        timeout: SELECTION_INSPECTION_TIMEOUT_MS,
        signal,
        windowsHide: true
      })
      return parseNativeSelectionReadOutput(stdout)
    }
  } catch {
    return { status: 'unknown', text: '', reason: 'unknown' }
  }

  return { status: 'unknown', text: '', reason: 'unknown' }
}

/**
 * 在选区刚建立时短暂重试原生直读，覆盖 AX/UIA 首次读取尚未同步完成的情况。
 * 全部尝试均只读取原生选区，不发送复制快捷键、不读取或修改系统剪贴板。
 * @param signal 用于在请求失效后停止后续重试的取消信号。
 * @returns 最后一次原生直读结果；仅实际读到非空文本时为 present。
 * @author zhenghq
 */
async function readSelectionByNativeWithRetry(
  signal?: AbortSignal
): Promise<NativeSelectionReadResult> {
  let result = await readSelectionByNative(signal)
  for (let attempt = 1; attempt < NATIVE_SELECTION_RETRY_COUNT; attempt += 1) {
    if (signal?.aborted || (result.status === 'present' && result.text.trim())) return result
    await sleep(NATIVE_SELECTION_RETRY_DELAY_MS)
    if (signal?.aborted) return result
    result = await readSelectionByNative(signal)
  }
  return result
}

/**
 * 检测当前应用是否已获得「辅助功能」权限，并在 macOS 未授权时触发系统授权提示。
 * @returns 是否已获得辅助功能权限。
 * @author zhenghq
 */
export async function checkAccessibilityPermission(): Promise<boolean> {
  const strategy = resolveSelectionCaptureStrategy(process.platform)
  if (strategy === 'macos-command-copy') {
    return systemPreferences.isTrustedAccessibilityClient(true)
  }
  return strategy !== 'unsupported'
}

// 用 CGEvent 发送 Cmd+C（keycode 55 = Command 键，keycode 8 = C 键）。
// 用户未按住 Command 时显式发送其按下和释放，避免部分前台应用把 C 事件当成普通字符。
// 用户已按住左、右任一 Command 时只发送带修饰键标志的 C，避免误释放物理按键。
const JXA_COPY = [
  "ObjC.import('CoreGraphics');",
  'var s=$.CGEventSourceCreate($.kCGEventSourceStateCombinedSessionState);',
  'var commandWasDown=$.CGEventSourceKeyState($.kCGEventSourceStateHIDSystemState,55)||$.CGEventSourceKeyState($.kCGEventSourceStateHIDSystemState,54);',
  'if(!commandWasDown){',
  'var commandDown=$.CGEventCreateKeyboardEvent(s,55,true);',
  '$.CGEventSetFlags(commandDown,$.kCGEventFlagMaskCommand);',
  '$.CGEventPost($.kCGHIDEventTap,commandDown);',
  '}',
  'var d=$.CGEventCreateKeyboardEvent(s,8,true);',
  '$.CGEventSetFlags(d,$.kCGEventFlagMaskCommand);',
  '$.CGEventPost($.kCGHIDEventTap,d);',
  'var u=$.CGEventCreateKeyboardEvent(s,8,false);',
  '$.CGEventSetFlags(u,$.kCGEventFlagMaskCommand);',
  '$.CGEventPost($.kCGHIDEventTap,u);',
  'if(!commandWasDown){',
  'var commandUp=$.CGEventCreateKeyboardEvent(s,55,false);',
  '$.CGEventSetFlags(commandUp,0);',
  '$.CGEventPost($.kCGHIDEventTap,commandUp);',
  '}'
].join('')

/**
 * 在 macOS 使用 CGEvent 注入 Cmd+C，在 Windows 使用 user32.dll 注入 Ctrl+C。
 * macOS 需要「辅助功能」权限（Accessibility）。
 * @returns 模拟复制完成后的 Promise。
 * @author zhenghq
 */
export async function simulateCopy(): Promise<void> {
  const strategy = resolveSelectionCaptureStrategy(process.platform)
  if (strategy === 'linux-primary-selection') return
  if (strategy === 'unsupported') throw new Error(`暂不支持当前平台：${process.platform}`)

  try {
    if (strategy === 'macos-command-copy') {
      await execFileP('osascript', ['-l', 'JavaScript', '-e', JXA_COPY])
    } else {
      await execFileP('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        WINDOWS_COPY
      ])
    }
  } catch (e) {
    const err = e as Error & { stderr?: string }
    const msg = String(err?.stderr ?? err?.message ?? err)
    if (/assistive|not allowed|-25211|-1719|1002/i.test(msg)) {
      throw new PermissionError('需要「辅助功能」权限才能模拟复制')
    }
    throw new Error(`模拟复制失败: ${msg}`)
  }
}

/**
 * 通过模拟复制快捷键从剪贴板读取当前选中文字，并在用户未主动复制时恢复取词前的剪贴板内容。
 * @param signal 用于在用户粘贴或点击其他位置时中止取词。
 * @param timeoutMs 等待前台应用写入剪贴板的最长时间。
 * @returns 结构化取词结果：成功时携带文本；超时或无可复制内容时携带失败原因。
 * @author zhenghq
 */
async function captureByCopy(
  signal?: AbortSignal,
  timeoutMs = 800
): Promise<SelectionCaptureOutcome> {
  const captureStartedAt = Date.now()
  const originalImage = clipboard.readImage()
  const hadImage = !originalImage.isEmpty()
  const originalText = clipboard.readText()
  const externalCopyVersion = copyShortcutGuard.getExternalCopyVersion()

  /**
   * 将剪贴板同步恢复为本次取词开始前的内容。
   * @returns 无返回值。
   * @author zhenghq
   */
  const restoreOriginalClipboard = (): void => {
    if (hadImage) clipboard.writeImage(originalImage)
    else clipboard.writeText(originalText)
  }

  /**
   * 在取词被取消时按取消原因决定是否恢复剪贴板，避免覆盖用户刚复制的新内容。
   * @returns 无返回值。
   * @author zhenghq
   */
  const handleAbort = (): void => {
    if (shouldRestoreClipboardAfterAbort(
      copyShortcutGuard.hasExternalCopySince(externalCopyVersion)
    )) {
      restoreOriginalClipboard()
    }
  }

  if (signal?.aborted) return { text: '' }
  if (resolveSelectionCaptureStrategy(process.platform) === 'linux-primary-selection') {
    const text = clipboard.readText('selection')
    console.log(
      `[capture] copy-finish platform=${process.platform} status=${text.trim() ? 'text' : 'empty'} ` +
      `textLength=${text.length} elapsedMs=${Date.now() - captureStartedAt}`
    )
    return text.trim() ? { text } : { text: '', reason: 'empty' }
  }
  console.log(`[capture] copy-start platform=${process.platform} timeoutMs=${timeoutMs}`)
  signal?.addEventListener('abort', handleAbort, { once: true })

  const sentinel = `__SELECTION_TRANSLATOR_SENTINEL_${Date.now()}__`
  clipboard.clear()
  clipboard.writeText(sentinel)

  let text = ''
  let hasImage = false
  // 最终捕获来源：轮询命中、剪贴板稳定期内晚到命中或真实超时，用于诊断日志与失败原因。
  let captureStatus: ResolvedClipboardCapture['status'] = 'timeout'
  try {
    const expectation = copyShortcutGuard.expectSyntheticCopyShortcut()
    try {
      await simulateCopy()
      console.log(`[capture] copy-shortcut-sent elapsedMs=${Date.now() - captureStartedAt}`)
    } catch (error) {
      console.warn(
        `[capture] copy-shortcut-failed error=${error instanceof Error ? error.name : 'unknown'} ` +
        `elapsedMs=${Date.now() - captureStartedAt}`
      )
      throw error
    } finally {
      await expectation.finish()
    }

    const start = Date.now()
    while (!signal?.aborted && Date.now() - start < timeoutMs) {
      text = clipboard.readText()
      hasImage = !clipboard.readImage().isEmpty()
      if (hasClipboardCaptureCompleted(text, hasImage, sentinel)) break
      await sleep(40)
    }
  } finally {
    try {
      if (!signal?.aborted) {
        /**
         * 给紧邻内部取词发生的用户复制留出观测和剪贴板写入时间。
         * @author zhenghq
         */
        await sleep(CLIPBOARD_STABILITY_DELAY_MS)
      }

      if (signal?.aborted) {
        if (shouldRestoreClipboardAfterAbort(
          copyShortcutGuard.hasExternalCopySince(externalCopyVersion)
        )) {
          restoreOriginalClipboard()
        }
      } else {
        const externalCopyObserved = copyShortcutGuard.hasExternalCopySince(externalCopyVersion)
        const currentText = clipboard.readText()
        const currentHasImage = !clipboard.readImage().isEmpty()
        // 轮询超时不代表取词失败：稳定期内前台应用可能刚写入选中文字或图片，
        // 必须用稳定期后的状态参与最终判定，避免把已成功的捕获误报为超时。
        const resolved = resolveCapturedClipboardState(
          { text, hasImage },
          { text: currentText, hasImage: currentHasImage },
          sentinel
        )
        text = resolved.text
        hasImage = resolved.hasImage
        captureStatus = resolved.status
        if (shouldRestoreClipboard(
          externalCopyObserved,
          currentText,
          sentinel,
          currentHasImage,
          text
        )) {
          restoreOriginalClipboard()
        }
      }
    } finally {
      signal?.removeEventListener('abort', handleAbort)
    }
  }

  if (signal?.aborted) {
    console.log(`[capture] copy-finish status=aborted elapsedMs=${Date.now() - captureStartedAt}`)
    return { text: '' }
  }
  if (hasImage) {
    console.log(
      `[capture] copy-finish status=${captureStatus === 'late' ? 'image-late' : 'image'} ` +
      `elapsedMs=${Date.now() - captureStartedAt}`
    )
    return { text: '', hasImage: true }
  }
  if (!text) {
    console.log(`[capture] copy-finish status=timeout elapsedMs=${Date.now() - captureStartedAt}`)
    return { text: '', reason: 'timeout' }
  }
  console.log(
    `[capture] copy-finish status=${captureStatus === 'late' ? 'text-late' : 'text'} ` +
    `textLength=${text.length} ` +
    `elapsedMs=${Date.now() - captureStartedAt}`
  )
  return { text }
}

/**
 * 捕获当前选中文字：优先原生直读，直读不可用或为空时回退到模拟复制，并按原因返回失败结果。
 * Linux 读取主选区，macOS 使用辅助功能属性，Windows 使用 UI Automation；
 * 直读无法覆盖的应用（如不支持 AX/UIA）自动回退到复制兜底。
 * @param signal 用于在用户粘贴或点击其他位置时中止取词。
 * @param timeoutMs 复制兜底等待前台应用写入剪贴板的最长时间。
 * @returns 结构化取词结果：成功时携带文本，失败时携带图片标志或失败原因。
 * @author zhenghq
 */
export async function captureSelectionByNativeOnly(
  signal?: AbortSignal
): Promise<SelectionCaptureOutcome> {
  if (signal?.aborted) return { text: '' }

  // “译”按钮显示期间的后台预取：只做原生直读，不注入复制键、不写剪贴板，
  // 避免在用户尚未点击按钮时干扰前台应用或占用剪贴板。
  const native = await readSelectionByNativeWithRetry(signal)
  if (native.status === 'present' && native.text.trim()) {
    return { text: native.text }
  }
  return {
    text: '',
    reason: native.status === 'empty' ? 'empty' : 'unsupported'
  }
}

/**
 * 执行点击“译”按钮后的专用取词：macOS/Windows 直接复制，Linux 保留主选区读取。
 * 这样可跳过可能耗时 1.5 秒以上的 AX/UIA 直读，尽量在源应用选区失效前发送复制快捷键。
 * @param signal 用于在请求失效后中止取词和恢复剪贴板的取消信号。
 * @param timeoutMs 等待前台应用写入剪贴板的最长时间。
 * @returns 结构化取词结果，包含文本、图片标志或失败原因。
 * @author zhenghq
 */
export async function captureSelectionAfterButtonClick(
  signal?: AbortSignal,
  timeoutMs = 800
): Promise<SelectionCaptureOutcome> {
  if (signal?.aborted) return { text: '' }

  const plan = getSelectionCapturePlan(process.platform)
  console.log(
    `[capture] button-capture-start platform=${process.platform} copyFallback=${plan.copyFallback}`
  )
  if (plan.copyFallback) {
    return captureByCopy(signal, timeoutMs)
  }

  if (plan.supportsNativeRead) {
    return captureSelectionByNativeOnly(signal)
  }

  return { text: '', reason: 'unsupported' }
}

/**
 * 捕获当前选中文字：优先原生直读，直读不可用或为空时回退到模拟复制，并按原因返回失败结果。
 * Linux 读取主选区，macOS 使用辅助功能属性，Windows 使用 UI Automation；
 * 直读无法覆盖的应用（如不支持 AX/UIA）自动回退到复制兜底。
 * @param signal 用于在用户粘贴或点击其他位置时中止取词。
 * @param timeoutMs 复制兜底等待前台应用写入剪贴板的最长时间。
 * @returns 结构化取词结果，失败时携带图片标志或失败原因。
 * @author zhenghq
 */
export async function captureSelection(
  signal?: AbortSignal,
  timeoutMs = 800
): Promise<SelectionCaptureOutcome> {
  if (signal?.aborted) return { text: '' }

  const plan = getSelectionCapturePlan(process.platform)

  // 第一级：平台原生直读，不触碰剪贴板。
  if (plan.supportsNativeRead) {
    const native = await readSelectionByNative(signal)
    if (native.status === 'present' && native.text.trim()) {
      return { text: native.text }
    }

    // 第二级：复制兜底（macOS/Windows 注入复制键）。
    if (plan.copyFallback) {
      return captureByCopy(signal, timeoutMs)
    }

    // 无复制兜底（Linux）：直接按直读状态返回。
    return {
      text: '',
      reason: native.status === 'empty' ? 'empty' : 'unsupported'
    }
  }

  // 不支持原生直读的平台：仅尝试复制兜底。
  if (plan.copyFallback) {
    return captureByCopy(signal, timeoutMs)
  }
  return { text: '', reason: 'unsupported' }
}
