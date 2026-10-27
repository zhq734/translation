import { clipboard, systemPreferences } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { uIOhook, UiohookKey } from './uiohookRuntime'
import {
  hasClipboardCaptureCompleted,
  shouldRestoreClipboardAfterAbort,
  shouldRestoreClipboard,
  resolveCapturedClipboardState,
  type ResolvedClipboardCapture
} from '../shared/copyShortcutBehavior'
import {
  classifyMacosAxHelperStatus,
  parseNativeSelectionReadOutput,
  parseSelectionPresenceOutput,
  type SelectionPresence
} from '../shared/selectionBehavior'
import { copyShortcutGuard } from './copyShortcutState'
import { isAutoTriggerRunning } from './autoTrigger'
import { translateMain } from './messages'
import {
  getSelectionCapturePlan,
  parseMacosAxCopyOutput,
  parseMacosAxReaderWindowDiagnostic,
  resolveSelectionCaptureStrategy,
  type MacosAxCopyStatus,
  type NativeSelectionReadResult
} from '../shared/platformCapture'
import {
  NativeReaderHost,
  resolveMacosAxReaderPath,
  resolveWindowsUiaReaderPath
} from './nativeReaderHost'
import { parseNativeReaderResponseLine, type NativeReaderResult } from '../shared/nativeReaderProtocol'
import {
  resolveCopyRetryPlan,
  shouldReleaseHotkeyModifiersBeforeCopy,
  shouldRetryCopyInjection,
  type HotkeyModifier
} from '../shared/hotkeyCaptureTiming'
import {
  shouldUseWlPasteForLinux,
  resolveWlPasteReadOutcome,
  WL_PASTE_TIMEOUT_MS
} from '../shared/waylandSelection'
import type { SelectionCaptureOutcome, CaptureDiagnosticLevel, SelectionFailureReason } from '../shared/selectionCaptureCoordinator'
import type { SelectionCaptureContext } from '../shared/selectionCaptureCoordinator'
import type { FrontmostWindowSnapshot } from '../shared/macosWindowSnapshot'
import {
  activateMacosApplication,
  activateMacosApplicationAndConfirmWindow,
  activateMacosWindowSnapshot,
  enumerateMacosWindows,
  isFailedWindowActivation,
  type MacosWindowActivationResult
} from './macosWindowActivation'

const execFileP = promisify(execFile)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const CLIPBOARD_STABILITY_DELAY_MS = 120
/** 单次命令（helper 或脚本）允许的最长耗时。 */
export const SELECTION_INSPECTION_TIMEOUT_MS = 1500
/** 原生直读在选区刚建立时的最大尝试次数（含首次）。 */
export const NATIVE_SELECTION_RETRY_COUNT = 2
const NATIVE_SELECTION_RETRY_DELAY_MS = 40
/** macOS 模拟复制脚本的最长执行时间，防止偶发阻塞让取词一直等不到复制键。 */
const MACOS_COPY_SCRIPT_TIMEOUT_MS = 2000
/** macOS 快捷键触发后保留 Command 已按下状态的短窗口，超时后按已释放处理。 */
const MACOS_COMMAND_PRESERVE_WINDOW_MS = 500
/** 释放快捷键修饰键后等待前台应用处理释放事件的时间（毫秒）。 */
const MODIFIER_RELEASE_SETTLE_MS = 24
/** Windows 快捷键路径在 helper 可用时的直读超时上限（毫秒）。 */
const NATIVE_DIRECT_READ_TIMEOUT_MS = 300
/** Windows WM_COPY 向焦点控件发送复制消息的超时（毫秒）。 */
const WM_COPY_TIMEOUT_MS = 500
/** 哨兵回读校验不一致时的重试次数。 */
const SENTINEL_VERIFY_RETRY_COUNT = 1

/**
 * 将取词上下文转换为窗口激活模块可消费的快照。
 * 缺少应用标识或进程号时返回 null，保持旧的应用级复制行为。
 * @param context 当前取词窗口上下文。
 * @returns 窗口快照；上下文不足时返回 null。
 * @author zhenghq
 */
function toWindowSnapshot(context?: SelectionCaptureContext): FrontmostWindowSnapshot | null {
  if (!context?.bundleId || context.pid === undefined) return null
  return {
    bundleId: context.bundleId,
    pid: context.pid,
    windowNumber: context.windowNumber,
    bounds: context.bounds,
    titleFingerprint: context.titleFingerprint,
    capturedAt: Date.now(),
    windowLocate: context.windowLocate
  }
}

/**
 * 在注入复制快捷键前精确激活源窗口。
 * 应用级快照仍由窗口模块执行 open -b；窗口定位明确失败时返回固定 failed，
 * 由复制链路在写入剪贴板哨兵和注入复制键前安全终止。
 * @param context 当前取词窗口上下文。
 * @returns 激活结果；没有可用窗口上下文时返回 null。
 * @author zhenghq
 */
async function activateWindowBeforeCopy(
  context?: SelectionCaptureContext
): Promise<MacosWindowActivationResult | null> {
  if (process.platform !== 'darwin') return null
  // 入口层 handBackKeyWindowToFrontmostApp() 已完成本轮源窗口激活时，
  // 复制链路必须复用该结果，避免对同一微信多窗口再次 raise/open -b。
  if (context?.windowActivationSettled) {
    console.log('[capture] window-activate skipped=entry-settled')
    return null
  }
  const snapshot = toWindowSnapshot(context)
  if (!snapshot) return null
  try {
    let result = await activateMacosWindowSnapshot(snapshot)
    if (isFailedWindowActivation(result)) {
      // Chrome 的 AX focused/raise 可能不可用。精确激活失败后允许按源进程
      // 做一次不提升全部窗口的兜底，但必须重新确认同一目标窗口位于全局最前；
      // 只确认应用在前台仍不足以保证 Cmd+C 不会落到同进程的其它窗口。
      const fallback = await activateMacosApplicationAndConfirmWindow(snapshot, {
        activateApplication: activateMacosApplication,
        enumerateWindows: enumerateMacosWindows,
        now: Date.now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      })
      console.log(
        `[capture] window-activate fallback=${fallback.outcome} ` +
        `windowCount=${fallback.windowCount ?? 'unknown'} windowMatched=${fallback.windowMatched}`
      )
      if (!isFailedWindowActivation(fallback)) result = fallback
    }
    console.log(
      `[capture] window-activate outcome=${result.outcome} ` +
      `windowCount=${result.windowCount ?? 'unknown'} windowMatched=${result.windowMatched}`
    )
    return result
  } catch {
    console.log('[capture] window-activate outcome=failed windowCount=unknown windowMatched=false')
    return {
      activated: false,
      confirmed: false,
      outcome: 'failed',
      windowMatched: false
    }
  }
}

/**
 * Windows 常驻 UIA helper 宿主单例；非 Windows 平台或 helper 不存在时为 null。
 * 惰性初始化，首次调用 readSelectionByNative 时才创建。
 * @author zhenghq
 */
let windowsReaderHost: NativeReaderHost | null = null

/**
 * 获取 Windows 常驻 helper 宿主单例；helper 可执行文件不存在时返回 null。
 * @returns helper 宿主或 null。
 * @author zhenghq
 */
function getWindowsReaderHost(): NativeReaderHost | null {
  if (process.platform !== 'win32') return null
  if (windowsReaderHost) return windowsReaderHost
  const helperPath = resolveWindowsUiaReaderPath(process.resourcesPath as string | undefined)
  if (!helperPath) return null
  windowsReaderHost = new NativeReaderHost()
  return windowsReaderHost
}

/**
 * 将 helper 直读结果转换为 NativeSelectionReadResult。
 * @param result helper 直读结果。
 * @returns 规范化后的直读结果。
 * @author zhenghq
 */
function convertHelperResult(result: NativeReaderResult): NativeSelectionReadResult {
  return {
    status: result.status,
    text: result.text ?? '',
    reason: result.reason
  }
}

/**
 * 为原生直读结果补齐窗口定位诊断。
 *
 * helper 明确返回诊断时直接采用；没有诊断但本次请求携带窗口编号时，
 * 只能保守标记为应用级退化，不能仅凭“请求了窗口”就推断精确命中。
 * @param native 原生直读结果。
 * @param context 本次取词的源窗口上下文。
 * @returns 带窗口诊断字段的原生直读结果。
 * @author zhenghq
 */
function withWindowDiagnostics(
  native: NativeSelectionReadResult,
  context?: SelectionCaptureContext
): NativeSelectionReadResult {
  const hasWindowContext = context?.windowNumber !== undefined || context?.bounds !== undefined
  if (native.windowLocate !== undefined || !hasWindowContext) return native
  return {
    ...native,
    windowLocate: 'app-fallback',
    windowMatched: false
  }
}

/**
 * macOS 常驻 AX helper 直读：调用预编译的 macos-ax-reader 二进制读取选区文本。
 * 传入窗口编号或边界时优先读取该窗口内焦点元素的选区；无效窗口由 helper 回退旧路径。
 * @param signal 用于在请求失效后中止子进程的取消信号。
 * @param windowNumber 可选目标窗口编号。
 * @param pid 可选目标进程号；与窗口编号同时传入时绕过短暂焦点漂移。
 * @param bounds 可选目标窗口边界；窗口编号在 AX 中缺失时用于二级匹配。
 * @param titleFingerprint 可选窗口标题哈希指纹；用于消除同边界窗口歧义。
 * @returns 直读结果；helper 不存在或不可用时返回 null 以触发降级。
 * @author zhenghq
 */
async function readSelectionViaMacosHelper(
  signal?: AbortSignal,
  windowNumber?: number,
  pid?: number,
  bounds?: SelectionCaptureContext['bounds'],
  titleFingerprint?: string
): Promise<NativeSelectionReadResult | null> {
  const helperPath = resolveMacosAxReaderPath({
    resourcesPath: typeof process.resourcesPath === 'string' && process.resourcesPath
      ? process.resourcesPath
      : undefined
  })
  if (!helperPath) {
    console.log('[capture] macos-ax-helper status=UNAVAILABLE elapsedMs=0 fallback=true reason=helper-missing')
    return null
  }
  const startedAt = Date.now()
  try {
    const args = windowNumber === undefined && bounds === undefined
      ? []
      : [
          windowNumber === undefined ? '-' : String(windowNumber),
          pid === undefined ? '-' : String(pid),
          bounds === undefined ? '-' : JSON.stringify(bounds),
          titleFingerprint ?? '-'
        ]
    const { stdout, stderr } = await execFileP(
      helperPath,
      args,
      { timeout: SELECTION_INSPECTION_TIMEOUT_MS, signal }
    )
    const windowDiagnostics = parseMacosAxReaderWindowDiagnostic(stderr)
    console.log(
      `[capture] macos-ax-helper status=${classifyMacosAxHelperStatus(stdout)} ` +
      `elapsedMs=${Date.now() - startedAt} fallback=false ` +
      `windowLocate=${windowDiagnostics.windowLocate ?? 'unknown'} ` +
      `windowCount=${windowDiagnostics.windowCount ?? 'unknown'} ` +
      `windowMatched=${windowDiagnostics.windowMatched ?? 'unknown'}`
    )
    return {
      ...parseNativeSelectionReadOutput(stdout),
      ...windowDiagnostics
    }
  } catch (error) {
    console.log(
      `[capture] macos-ax-helper status=UNKNOWN elapsedMs=${Date.now() - startedAt} ` +
      `fallback=true reason=${signal?.aborted ? 'aborted' : 'helper-error'}`
    )
    return null
  }
}

/**
 * Windows 常驻 helper 直读：通过 nativeReaderHost 向 UIA helper 发送取词请求。
 * @param signal 用于在请求失效后中止的取消信号（当前未直连子进程，仅占位）。
 * @returns 直读结果；helper 不存在或不可用时返回 null 以触发降级。
 * @author zhenghq
 */
async function readSelectionViaWindowsHelper(signal?: AbortSignal): Promise<NativeSelectionReadResult | null> {
  void signal
  const host = getWindowsReaderHost()
  if (!host) return null
  try {
    const result = await host.readSelection()
    return convertHelperResult(result)
  } catch {
    return null
  }
}

/**
 * 各修饰键对应的左右两侧全局钩子键码，注入复制键前需要同时释放两侧。
 * 用户可能按住右侧 Ctrl/Alt/Shift 触发快捷键，只释放左侧会残留修饰状态。
 */
const MODIFIER_KEYCODES: Record<HotkeyModifier, number[]> = {
  control: [UiohookKey.Ctrl, UiohookKey.CtrlRight],
  alt: [UiohookKey.Alt, UiohookKey.AltRight],
  shift: [UiohookKey.Shift, UiohookKey.ShiftRight],
  meta: [UiohookKey.Meta, UiohookKey.MetaRight]
}

/** 下一次模拟复制前需要强制释放的快捷键修饰键，由快捷键入口登记。 */
let pendingCopyModifierRelease: HotkeyModifier[] = []
/** macOS 快捷键触发时 Command 仍按下的短期截止时间。 */
let pendingMacOSCommandWasDownUntil = 0

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

export class PermissionError extends Error {}

/** wl-paste 不可用提示日志是否已输出，避免每次取词重复刷屏。 */
let wlPasteUnavailableLogged = false

/**
 * Linux 下统一的原生选区读取：Wayland 会话优先调用 wl-paste 读取主选区，
 * wl-paste 不可用、超时或输出为空时回退 Electron `readText('selection')`，
 * 保证 XWayland 桥接场景（X11 应用划词）仍能读到内容；X11 会话保持原路径不变。
 * @param signal 用于在请求失效后中止 wl-paste 进程的取消信号。
 * @returns 读取到的选区文本；无选区或读取失败时返回空串。
 * @author zhenghq
 */
async function readLinuxSelectionByNative(signal?: AbortSignal): Promise<string> {
  if (shouldUseWlPasteForLinux(process.platform, process.env)) {
    try {
      const { stdout } = await execFileP(
        'wl-paste',
        ['--primary', '--no-newline'],
        { timeout: WL_PASTE_TIMEOUT_MS, signal }
      )
      const outcome = resolveWlPasteReadOutcome({ ok: true, text: stdout })
      if (outcome.kind === 'text') return outcome.text
    } catch (error) {
      // wl-paste 主选区为空、超时或被取消时静默回退；仅命令缺失时提示一次安装建议。
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' && !wlPasteUnavailableLogged) {
        wlPasteUnavailableLogged = true
        console.warn(
          '[capture] wl-paste 不可用：Wayland 会话建议安装 wl-clipboard 以支持原生应用划词取词'
        )
      }
    }
  }
  return clipboard.readText('selection')
}

/**
 * 在不模拟复制快捷键的前提下检查前台应用当前是否存在选中文字。
 * Linux 读取主选区，macOS 使用辅助功能属性，Windows 使用 UI Automation；无法确认时返回 unknown。
 * @returns 当前系统选区状态。
 * @author zhenghq
 */
export async function inspectSelectedTextPresence(): Promise<SelectionPresence> {
  try {
    if (process.platform === 'linux') {
      const text = await readLinuxSelectionByNative()
      return text.trim() ? 'present' : 'empty'
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
 * 优先调用常驻 helper（macOS AX 二进制 / Windows UIA helper），helper 不可用时降级到现有脚本路径。
 * macOS 使用辅助功能属性，Windows 使用 UI Automation，Linux 读取主选区；均不触碰剪贴板。
 * @param signal 用于在请求失效后中止原生命令的取消信号。
 * @returns 直读结果，包含状态、选中文本与可能的失败原因。
 * @author zhenghq
 */
export async function readSelectionByNative(
  signal?: AbortSignal,
  context?: SelectionCaptureContext
): Promise<NativeSelectionReadResult> {
  try {
    if (signal?.aborted) return { status: 'unknown', text: '', reason: 'unknown' }

    if (process.platform === 'linux') {
      const text = await readLinuxSelectionByNative(signal)
      return text.trim() ? { status: 'present', text } : { status: 'empty', text: '' }
    }

    if (process.platform === 'darwin') {
      // 优先调用常驻 AX helper（毫秒级冷启动），不可用时降级到 osascript 脚本。
      const helperResult = await readSelectionViaMacosHelper(
        signal,
        context?.windowNumber,
        context?.pid,
        context?.bounds,
        context?.titleFingerprint
      )
      if (helperResult) return withWindowDiagnostics(helperResult, context)
      const { stdout } = await execFileP(
        'osascript',
        ['-e', MACOS_SELECTION_PRESENCE],
        { timeout: SELECTION_INSPECTION_TIMEOUT_MS, signal }
      )
      return withWindowDiagnostics(parseNativeSelectionReadOutput(stdout), context)
    }

    if (process.platform === 'win32') {
      // 优先调用常驻 UIA helper，不可用时降级到 PowerShell 脚本。
      const helperResult = await readSelectionViaWindowsHelper(signal)
      if (helperResult) return helperResult
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
  signal?: AbortSignal,
  context?: SelectionCaptureContext
): Promise<NativeSelectionReadResult> {
  let result = await readSelectionByNative(signal, context)
  for (let attempt = 1; attempt < NATIVE_SELECTION_RETRY_COUNT; attempt += 1) {
    if (signal?.aborted || (result.status === 'present' && result.text.trim())) return result
    await sleep(NATIVE_SELECTION_RETRY_DELAY_MS)
    if (signal?.aborted) return result
    result = await readSelectionByNative(signal, context)
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

/**
 * 登记下一次模拟复制前需要强制释放的快捷键修饰键。
 * Windows 的全局快捷键在按键按下阶段回调，用户此时仍按住 Alt、Ctrl 等键，
 * 直接注入 Ctrl+C 会被前台应用识别成 Ctrl+Alt+C 等错误组合，导致取词超时。
 * @param modifiers 触发快捷键时按住的修饰键列表；传空数组表示无需释放。
 * @returns 无返回值。
 * @author zhenghq
 */
export function setPendingCopyModifierRelease(modifiers: HotkeyModifier[]): void {
  pendingCopyModifierRelease = shouldReleaseHotkeyModifiersBeforeCopy(process.platform)
    ? [...modifiers]
    : []
}

/**
 * 登记 macOS 全局快捷键触发时 Command 是否仍处于按下状态。
 * 状态只在短窗口内有效，避免原生直读成功后残留状态影响后续划词按钮取词。
 * @param wasDown 触发快捷键是否包含 Command 修饰键。
 * @returns 无返回值。
 * @author zhenghq
 */
export function setPendingMacOSCommandWasDown(wasDown: boolean): void {
  pendingMacOSCommandWasDownUntil = wasDown
    ? Date.now() + MACOS_COMMAND_PRESERVE_WINDOW_MS
    : 0
}

/**
 * 在注入复制快捷键前释放已登记的快捷键修饰键，并等待前台应用处理释放事件。
 * 同时释放左右两侧修饰键，覆盖用户使用右侧 Ctrl/Alt/Shift 触发快捷键的情况；
 * 释放后清空登记，避免影响后续由划词按钮等入口触发的取词。
 * @returns 释放完成后的 Promise。
 * @author zhenghq
 */
async function releasePendingCopyModifiers(): Promise<void> {
  const modifiers = pendingCopyModifierRelease
  pendingCopyModifierRelease = []
  if (modifiers.length === 0) return

  for (const modifier of modifiers) {
    for (const keycode of MODIFIER_KEYCODES[modifier]) {
      try {
        uIOhook.keyToggle(keycode, 'up')
      } catch {
        // 单个修饰键释放失败不应中断取词，后续复制注入仍会尝试。
      }
    }
  }
  console.log(`[capture] modifier-release keys=${modifiers.join(',')}`)
  await sleep(MODIFIER_RELEASE_SETTLE_MS)
}

// 用 CGEvent 发送 Cmd+C（keycode 55 = Command 键，keycode 8 = C 键）。
// 用户未按住 Command 时显式发送其按下和释放，避免部分前台应用把 C 事件当成普通字符。
// 用户已按住左、右任一 Command 时只发送带修饰键标志的 C，避免误释放物理按键。
// 已按住的修饰键状态由全局快捷键入口短时传递；不再在脚本内查询系统按键状态，
// 该查询 API 在部分 macOS 环境会无限阻塞等待 hiservices XPC 回复，使复制键无法发出而取词超时。
// 事件之间留出短间隔，避免 Electron 自绘编辑器丢弃同一 tick 内连续到达的瞬时 Cmd+C。
const JXA_COPY = [
  "ObjC.import('CoreGraphics');",
  'var s=$.CGEventSourceCreate($.kCGEventSourceStateCombinedSessionState);',
  "var env=$.NSProcessInfo.processInfo.environment;",
  "var commandWasDown=env.objectForKey('commandWasDown')&&env.objectForKey('commandWasDown').js==='1';",
  "var targetPid=Number(env.objectForKey('targetPid')&&env.objectForKey('targetPid').js||0);",
  'var post=function(event){if(targetPid>0){$.CGEventPostToPid(targetPid,event);}else{$.CGEventPost($.kCGHIDEventTap,event);}};',
  'if(!commandWasDown){',
  'var commandDown=$.CGEventCreateKeyboardEvent(s,55,true);',
  '$.CGEventSetFlags(commandDown,$.kCGEventFlagMaskCommand);',
  'post(commandDown);',
  '$.NSThread.sleepForTimeInterval(0.015);',
  '}',
  'var d=$.CGEventCreateKeyboardEvent(s,8,true);',
  '$.CGEventSetFlags(d,$.kCGEventFlagMaskCommand);',
  'post(d);',
  '$.NSThread.sleepForTimeInterval(0.015);',
  'var u=$.CGEventCreateKeyboardEvent(s,8,false);',
  '$.CGEventSetFlags(u,$.kCGEventFlagMaskCommand);',
  'post(u);',
  '$.NSThread.sleepForTimeInterval(0.015);',
  'if(!commandWasDown){',
  'var commandUp=$.CGEventCreateKeyboardEvent(s,55,false);',
  '$.CGEventSetFlags(commandUp,0);',
  'post(commandUp);',
  '}'
].join('')

/**
 * 返回 macOS 全局快捷键触发时 Command 是否仍可能处于按下状态。
 * 短窗口过期后按已释放处理，按钮入口也会显式清空，避免不同取词路径相互污染。
 * @returns Command 仍可能处于按下状态时返回 true。
 * @author zhenghq
 */
function isMacOSCommandKeyDown(): boolean {
  return Date.now() <= pendingMacOSCommandWasDownUntil
}

/**
 * Windows WM_COPY 中间层：向焦点控件发送 WM_COPY 消息并轮询剪贴板。
 * 相比全局 Ctrl+C，WM_COPY 不会干扰用户的按键状态，适合按住鼠标点击按钮时使用。
 * @param signal 用于在请求失效后中止轮询的取消信号。
 * @param timeoutMs 等待剪贴板写入的最长时间。
 * @param sentinel 写入剪贴板用于检测内容变更的哨兵值。
 * @returns 读到的文本；超时或不可用时返回 null。
 * @author zhenghq
 */
async function tryWmCopyPoll(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  sentinel: string
): Promise<string | null> {
  if (process.platform !== 'win32') return null
  try {
    // 通过 PowerShell 向焦点控件发送 WM_COPY。
    const psScript = [
      'Add-Type -AssemblyName UIAutomationClient',
      '$element = [System.Windows.Automation.AutomationElement]::FocusedElement',
      "if ($null -eq $element) { exit 1 }",
      '$hwnd = [IntPtr]::Zero',
      'try { $hwnd = [IntPtr]::new($element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty)) } catch {}',
      'if ($hwnd -eq [IntPtr]::Zero) { exit 1 }',
      '[User32]::SendMessageTimeout($hwnd, 0x0301, [IntPtr]::Zero, [IntPtr]::Zero, 0x0001, 500, [ref]([IntPtr]::Zero)) | Out-Null',
      'Add-Type -Namespace User32 -Name User32 -MemberDefinition "[DllImport(\"user32.dll\")] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, ref IntPtr lpdwResult);"'
    ].join('\n')
    await execFileP('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript
    ], { timeout: WM_COPY_TIMEOUT_MS, windowsHide: true, signal })

    // 轮询剪贴板，等待 WM_COPY 写入内容。
    const start = Date.now()
    while (!signal?.aborted && Date.now() - start < timeoutMs) {
      const current = clipboard.readText()
      if (current !== sentinel && current.trim()) return current
      await sleep(40)
    }
  } catch {
    // WM_COPY 不可用或超时，返回 null 让调用方回退到全局 Ctrl+C。
  }
  return null
}
/**
 * 在 macOS 使用 CGEvent 注入 Cmd+C，在 Windows 使用已加载的 uiohook 原生模块注入 Ctrl+C。
 * Windows 不再为每次取词冷启动 PowerShell 和动态编译 P/Invoke，以缩短快捷键与按钮取词耗时。
 * macOS 需要「辅助功能」权限（Accessibility）。
 * @param targetPid 可选的 macOS 目标进程号；重试时定向投递，首轮保持全局事件注入。
 * @returns 模拟复制完成后的 Promise。
 * @author zhenghq
 */
export async function simulateCopy(targetPid?: number): Promise<void> {
  const strategy = resolveSelectionCaptureStrategy(process.platform)
  if (strategy === 'linux-primary-selection') return
  if (strategy === 'unsupported') {
    throw new Error(translateMain('capture.error.unsupportedPlatform', { platform: process.platform }))
  }

  try {
    if (strategy === 'macos-command-copy') {
      // 已按住的 Command 状态由 Node 侧提供，脚本内禁止再查询系统按键状态，
      // 该查询在部分 macOS 环境会无限阻塞，导致复制键迟迟发不出而取词超时。
      const commandWasDown = isMacOSCommandKeyDown()
      await execFileP(
        'osascript',
        ['-l', 'JavaScript', '-e', JXA_COPY],
        {
          env: {
            ...process.env,
            commandWasDown: commandWasDown ? '1' : '0',
            targetPid: targetPid && targetPid > 0 ? String(targetPid) : '0'
          },
          timeout: MACOS_COPY_SCRIPT_TIMEOUT_MS
        }
      )
    } else {
      await releasePendingCopyModifiers()
      uIOhook.keyTap(UiohookKey.C, [UiohookKey.Ctrl])
    }
  } catch (e) {
    const err = e as Error & { stderr?: string }
    const msg = String(err?.stderr ?? err?.message ?? err)
    if (/assistive|not allowed|-25211|-1719|1002/i.test(msg)) {
      throw new PermissionError(translateMain('capture.error.accessibilityPermissionRequired'))
    }
    throw new Error(translateMain('capture.error.copySimulationFailed', { message: msg }))
  }
}

/**
 * 通过 macOS AX 菜单栏执行目标应用的原生“复制”命令。
 *
 * 部分应用（如 ynote）能观测到注入的 Cmd+C，却不会消费该快捷键。此时直接
 * AXPress 唯一启用的 Command+C 菜单项，可以绕过快捷键消费链路触发复制，
 * 且不会提升同应用的其它窗口。helper 只返回固定状态，日志不包含菜单标题。
 * @param pid 目标应用进程号。
 * @param signal 用于在取词失效后中止 helper 的取消信号。
 * @returns AX 菜单复制动作的固定状态。
 * @author zhenghq
 */
async function performMacosAxCopy(pid: number, signal?: AbortSignal): Promise<MacosAxCopyStatus> {
  if (process.platform !== 'darwin' || !Number.isInteger(pid) || pid <= 0 || signal?.aborted) {
    return 'unavailable'
  }
  const helperPath = resolveMacosAxReaderPath({
    resourcesPath: typeof process.resourcesPath === 'string' && process.resourcesPath
      ? process.resourcesPath
      : undefined
  })
  if (!helperPath) {
    console.log('[capture] ax-copy-menu status=unavailable elapsedMs=0 reason=helper-missing')
    return 'unavailable'
  }

  const startedAt = Date.now()
  try {
    const { stdout } = await execFileP(
      helperPath,
      ["--copy", String(pid)],
      { timeout: SELECTION_INSPECTION_TIMEOUT_MS, signal }
    )
    const status = parseMacosAxCopyOutput(stdout)
    console.log(`[capture] ax-copy-menu status=${status} elapsedMs=${Date.now() - startedAt}`)
    return status
  } catch {
    console.log(
      `[capture] ax-copy-menu status=unknown elapsedMs=${Date.now() - startedAt} ` +
      `reason=${signal?.aborted ? 'aborted' : 'helper-error'}`
    )
    return 'unknown'
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
  timeoutMs = 800,
  context?: SelectionCaptureContext
): Promise<SelectionCaptureOutcome> {
  const captureStartedAt = Date.now()
  const windowActivation = await activateWindowBeforeCopy(context)
  if (signal?.aborted) return { text: '' }
  // 无法再次确认源窗口时不得继续写哨兵或注入 Cmd+C：同进程的微信/Chrome
  // 窗口可能已经切换，复制键会落到错误窗口。此处安全失败，不修改剪贴板，
  // 也不触发复制重试。
  if (isFailedWindowActivation(windowActivation)) {
    console.log(
      `[capture] copy-finish status=window-activation-failed ` +
      `windowLocate=${windowActivation?.outcome ?? 'failed'} ` +
      `windowCount=${windowActivation?.windowCount ?? 'unknown'} ` +
      `windowMatched=${windowActivation?.windowMatched ?? false} ` +
      `elapsedMs=${Date.now() - captureStartedAt}`
    )
    return {
      text: '',
      reason: 'unknown',
      diagnostics: {
        level: 'failed',
        reason: 'unknown',
        windowLocate: windowActivation?.outcome,
        windowCount: windowActivation?.windowCount,
        windowMatched: windowActivation?.windowMatched
      }
    }
  }
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
    return text.trim()
      ? { text, diagnostics: { level: 'native-read' } }
      : { text: '', reason: 'empty', diagnostics: { level: 'failed', reason: 'empty' } }
  }
  console.log(`[capture] copy-start platform=${process.platform} timeoutMs=${timeoutMs}`)
  signal?.addEventListener('abort', handleAbort, { once: true })

  const sentinel = `__SELECTION_TRANSLATOR_SENTINEL_${Date.now()}__`
  clipboard.clear()
  clipboard.writeText(sentinel)

  /**
   * 哨兵回读校验：写入哨兵后立即回读，不一致时重试一次，仍失败表示剪贴板被其他程序占用。
   * @returns 校验通过返回 null；校验失败返回 clipboard-locked 失败结果。
   * @author zhenghq
   */
  const verifySentinelWrite = (): SelectionCaptureOutcome | null => {
    for (let attempt = 0; attempt <= SENTINEL_VERIFY_RETRY_COUNT; attempt += 1) {
      const readback = clipboard.readText()
      if (readback === sentinel) return null
      // 回读不一致，重试写入并再次校验。
      if (attempt < SENTINEL_VERIFY_RETRY_COUNT) {
        clipboard.clear()
        clipboard.writeText(sentinel)
      }
    }
    // 哨兵写入后回读仍不一致，剪贴板被其他程序占用。
    console.log(`[capture] clipboard-locked sentinel-readback-mismatch elapsedMs=${Date.now() - captureStartedAt}`)
    restoreOriginalClipboard()
    return {
      text: '',
      reason: 'clipboard-locked' as SelectionFailureReason,
      diagnostics: { level: 'failed', reason: 'clipboard-locked' as SelectionFailureReason }
    }
  }

  // 哨兵写入后回读校验：剪贴板被其他程序占用时直接返回 clipboard-locked。
  const sentinelFailure = verifySentinelWrite()
  if (sentinelFailure) return sentinelFailure

  let text = ''
  let hasImage = false
  // 最终捕获来源：轮询命中、剪贴板稳定期内晚到命中或真实超时，用于诊断日志与失败原因。
  let captureStatus: ResolvedClipboardCapture['status'] = 'timeout'
  // 已发送的复制快捷键次数，用于在首次注入无响应时限次重投。
  let copyAttempts = 0
  // 已完成的独立重试轮次数，用于诊断日志与重试上限判定。
  let copyRetries = 0
  // 本轮模拟复制事件是否被全局事件钩子观测到。
  // undefined 表示未启用事件观测，不能等同于“已观测但未收到事件”。
  let syntheticCopyObserved: boolean | undefined

  /**
   * 发送一次复制快捷键，并在观测窗口内区分内部模拟复制与用户主动复制。
   * @param retryTargetPid 重试时用于定向注入的源进程号；首轮省略以保持全局注入。
   * @returns 注入完成后的 Promise。
   * @author zhenghq
   */
  const injectCopyShortcut = async (retryTargetPid?: number): Promise<void> => {
    /**
     * 实际注入一次复制快捷键并记录诊断日志。
     * @param observed 本次注入是否登记了内部模拟复制观测。
     * @returns 注入完成后的 Promise。
     * @author zhenghq
     */
    const sendCopyShortcut = async (observed: boolean): Promise<void> => {
      try {
        await simulateCopy(retryTargetPid)
        copyAttempts += 1
        console.log(
          `[capture] copy-shortcut-sent attempt=${copyAttempts} observed=${observed} ` +
          `elapsedMs=${Date.now() - captureStartedAt}`
        )
      } catch (error) {
        console.warn(
          `[capture] copy-shortcut-failed error=${error instanceof Error ? error.name : 'unknown'} ` +
          `elapsedMs=${Date.now() - captureStartedAt}`
        )
        throw error
      }
    }

    // 纯快捷键模式不启动全局钩子，观测窗口内不可能收到复制事件，
    // 此时登记观测只会白等超时，直接注入即可。
    const shouldObserveSyntheticCopy = isAutoTriggerRunning()
    if (!shouldObserveSyntheticCopy) {
      await sendCopyShortcut(false)
      return
    }

    // 只有登记观测窗口后才能把状态视为已知；先置 false 可避免首次未收到事件时
    // 仍保留 undefined，从而丢失真实的 event tap 故障信号。
    syntheticCopyObserved = false
    const expectation = copyShortcutGuard.expectSyntheticCopyShortcut()
    try {
      await sendCopyShortcut(true)
    } finally {
      syntheticCopyObserved = (await expectation.finish()) || syntheticCopyObserved
    }
  }

  try {
    // Windows 先尝试 WM_COPY 中间层（不干扰按键状态），无响应再回退到全局 Ctrl+C。
    if (process.platform === 'win32') {
      const wmCopyText = await tryWmCopyPoll(signal, WM_COPY_TIMEOUT_MS, sentinel)
      if (wmCopyText && wmCopyText.trim()) {
        console.log(`[capture] wm-copy-hit textLength=${wmCopyText.length} elapsedMs=${Date.now() - captureStartedAt}`)
        text = wmCopyText
      }
    }

    if (!text) {
      /**
       * 在给定时限内轮询剪贴板，直到捕获到有效内容、超时或被中止。
       * @param pollTimeoutMs 本轮的轮询时限（毫秒）。
       * @returns 轮询结束后的 Promise。
       * @author zhenghq
       */
      const pollForCapture = async (pollTimeoutMs: number): Promise<void> => {
        const start = Date.now()
        while (!signal?.aborted && Date.now() - start < pollTimeoutMs) {
          text = clipboard.readText()
          hasImage = !clipboard.readImage().isEmpty()
          if (hasClipboardCaptureCompleted(text, hasImage, sentinel)) return
          // 首次注入可能因修饰键仍被按住或前台应用尚未就绪而丢失，等待间隔后补发一次。
          if (shouldRetryCopyInjection(Date.now() - start, copyAttempts)) {
            console.log(`[capture] copy-retry elapsedMs=${Date.now() - captureStartedAt}`)
            await injectCopyShortcut(context?.pid)
            continue
          }
          await sleep(40)
        }
      }

      await injectCopyShortcut()
      await pollForCapture(timeoutMs)

      // 首次轮询超时后优先尝试 AX 菜单复制。ynote 等应用能观测到注入事件，
      // 却不消费瞬时 Cmd+C；AXPress 可直接触发目标应用自己的复制命令。
      let axCopyPerformed = false
      if (!hasClipboardCaptureCompleted(text, hasImage, sentinel)) {
        if (
          !signal?.aborted &&
          !copyShortcutGuard.hasExternalCopySince(externalCopyVersion) &&
          context?.pid !== undefined
        ) {
          axCopyPerformed = (await performMacosAxCopy(context.pid, signal)) === 'performed'
        }
      }

      // 首次轮询超时后追加一次独立、有界的重试轮次：重写哨兵、重新注入复制键。
      // 仅在未中止、未观测到用户主动复制且重试次数未耗尽时才进入，避免无限重试。
      if (!hasClipboardCaptureCompleted(text, hasImage, sentinel)) {
        const plan = resolveCopyRetryPlan({
          attempts: copyAttempts,
          retries: copyRetries,
          elapsedMs: Date.now() - captureStartedAt,
          timeoutMs,
          aborted: Boolean(signal?.aborted),
          externalCopyObserved: copyShortcutGuard.hasExternalCopySince(externalCopyVersion)
        })
        if (plan.retry) {
          copyRetries += 1
          console.log(
            `[capture] copy-fallback-retry retry=${copyRetries} ` +
            `timeoutMs=${plan.retryTimeoutMs} elapsedMs=${Date.now() - captureStartedAt}`
          )
          if (!axCopyPerformed) {
            // 盲重试前重写哨兵，确保上一轮残留内容不会让重试误判为已捕获。
            // AX 已执行时不得重写，否则可能覆盖应用刚异步写入的复制结果。
            clipboard.clear()
            clipboard.writeText(sentinel)
            const retrySentinelFailure = verifySentinelWrite()
            if (retrySentinelFailure) return retrySentinelFailure
            await injectCopyShortcut(context?.pid)
          }
          await pollForCapture(plan.retryTimeoutMs)
        }
      }
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
    const level: CaptureDiagnosticLevel = captureStatus === 'late' ? 'copy-late' : 'copy-polled'
    return {
      text: '',
      hasImage: true,
      diagnostics: {
        level,
        windowLocate: windowActivation?.outcome,
        windowCount: windowActivation?.windowCount,
        windowMatched: windowActivation?.windowMatched
      }
    }
  }
  if (!text) {
    console.log(
      `[capture] copy-finish status=timeout attempts=${copyAttempts} retries=${copyRetries} ` +
      `${syntheticCopyObserved === undefined ? '' : `copyObserved=${syntheticCopyObserved} `}` +
      `elapsedMs=${Date.now() - captureStartedAt}`
    )
  return {
    text: '',
    reason: 'timeout',
    diagnostics: {
      level: 'failed',
      reason: 'timeout',
      ...(syntheticCopyObserved === undefined ? {} : { copyObserved: syntheticCopyObserved }),
      windowLocate: windowActivation?.outcome,
      windowCount: windowActivation?.windowCount,
      windowMatched: windowActivation?.windowMatched
    }
  }
  }
  console.log(
    `[capture] copy-finish status=${captureStatus === 'late' ? 'text-late' : 'text'} ` +
    `textLength=${text.length} ` +
    `elapsedMs=${Date.now() - captureStartedAt}`
  )
  const level: CaptureDiagnosticLevel = captureStatus === 'late' ? 'copy-late' : 'copy-polled'
  return {
    text,
    diagnostics: {
      level,
      windowLocate: windowActivation?.outcome,
      windowCount: windowActivation?.windowCount,
      windowMatched: windowActivation?.windowMatched
    }
  }
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
  signal?: AbortSignal,
  context?: SelectionCaptureContext
): Promise<SelectionCaptureOutcome> {
  if (signal?.aborted) return { text: '' }

  // “译”按钮显示期间的后台预取：只做原生直读，不注入复制键、不写剪贴板，
  // 避免在用户尚未点击按钮时干扰前台应用或占用剪贴板。
  const native = await readSelectionByNativeWithRetry(signal, context)
  if (native.status === 'present' && native.text.trim()) {
    return {
      text: native.text,
      diagnostics: {
        level: 'native-read',
        windowLocate: native.windowLocate,
        windowCount: native.windowCount,
        windowMatched: native.windowMatched
      }
    }
  }
  const reason = native.status === 'empty' ? 'empty' : 'unsupported'
  return {
    text: '',
    reason,
      diagnostics: {
        level: 'failed',
        reason,
        windowLocate: native.windowLocate ??
          (context?.windowNumber === undefined ? 'app-fallback' : 'failed'),
      windowCount: native.windowCount,
      windowMatched: native.windowMatched ?? false
    }
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
  timeoutMs: number | SelectionCaptureContext = 800,
  context?: SelectionCaptureContext
): Promise<SelectionCaptureOutcome> {
  if (signal?.aborted) return { text: '' }

  const resolvedContext = typeof timeoutMs === 'number' ? context : timeoutMs
  const resolvedTimeoutMs = typeof timeoutMs === 'number' ? timeoutMs : timeoutMs.timeoutMs ?? 800

  const plan = getSelectionCapturePlan(process.platform)
  console.log(
    `[capture] button-capture-start platform=${process.platform} copyFallback=${plan.copyFallback}`
  )
  if (plan.copyFallback) {
    return captureByCopy(signal, resolvedTimeoutMs, resolvedContext)
  }

  if (plan.supportsNativeRead) {
    return captureSelectionByNativeOnly(signal, resolvedContext)
  }

  return { text: '', reason: 'unsupported', diagnostics: { level: 'failed', reason: 'unsupported' } }
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
  timeoutMs: number | SelectionCaptureContext = 800,
  context?: SelectionCaptureContext
): Promise<SelectionCaptureOutcome> {
  if (signal?.aborted) return { text: '' }

  const resolvedContext = typeof timeoutMs === 'number' ? context : timeoutMs
  const resolvedTimeoutMs = typeof timeoutMs === 'number' ? timeoutMs : timeoutMs.timeoutMs ?? 800

  const plan = getSelectionCapturePlan(process.platform)

  // 第一级：平台原生直读，不触碰剪贴板。
  if (plan.supportsNativeRead) {
    const native = await readSelectionByNative(signal, resolvedContext)
    if (native.status === 'present' && native.text.trim()) {
      return {
        text: native.text,
        diagnostics: {
          level: 'native-read',
          windowLocate: native.windowLocate,
          windowCount: native.windowCount,
          windowMatched: native.windowMatched
        }
      }
    }

    // 第二级：复制兜底（macOS/Windows 注入复制键）。
    if (plan.copyFallback) {
      return captureByCopy(signal, resolvedTimeoutMs, resolvedContext)
    }

    // 无复制兜底（Linux）：直接按直读状态返回。
    const reason = native.status === 'empty' ? 'empty' : 'unsupported'
    return {
      text: '',
      reason,
      diagnostics: {
        level: 'failed',
        reason,
        windowLocate: native.windowLocate ??
          (resolvedContext?.windowNumber === undefined ? 'app-fallback' : 'failed'),
        windowCount: native.windowCount,
        windowMatched: native.windowMatched ?? false
      }
    }
  }

  // 不支持原生直读的平台：仅尝试复制兜底。
  if (plan.copyFallback) {
    return captureByCopy(signal, resolvedTimeoutMs, resolvedContext)
  }
  return { text: '', reason: 'unsupported', diagnostics: { level: 'failed', reason: 'unsupported' } }
}

/**
 * 检测当前应用是否已获得 macOS「屏幕录制」权限。
 *
 * 未授权时系统 screencapture 会被授权弹窗阻塞，直到 OCR 预览采集超时兜底，
 * 用户只能看到「屏幕采集超时」而拿不到真正的授权引导；因此采集前必须先判断状态。
 * @returns 非 macOS 平台或已授权时返回 true。
 * @author zhenghq
 */
export function hasScreenRecordingPermission(): boolean {
  if (process.platform !== 'darwin') return true
  return systemPreferences.getMediaAccessStatus('screen') === 'granted'
}
