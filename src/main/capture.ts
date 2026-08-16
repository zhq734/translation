import { clipboard, systemPreferences } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  hasClipboardCaptureCompleted,
  shouldRestoreClipboard
} from '../shared/copyShortcutBehavior'
import { copyShortcutGuard } from './copyShortcutState'

const execFileP = promisify(execFile)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const CLIPBOARD_STABILITY_DELAY_MS = 120

export class PermissionError extends Error {}

/**
 * 检测当前应用是否已获得「辅助功能」权限，并在 macOS 未授权时触发系统授权提示。
 * @returns 是否已获得辅助功能权限。
 * @author zhenghq
 */
export async function checkAccessibilityPermission(): Promise<boolean> {
  if (process.platform === 'darwin') {
    return systemPreferences.isTrustedAccessibilityClient(true)
  }
  try {
    await execFileP('osascript', ['-l', 'JavaScript', '-e', JXA_PROBE])
    return true
  } catch {
    return false
  }
}

// 用 CGEvent 发送 Cmd+C（keycode 8 = C 键，Command 修饰键）
const JXA_COPY = [
  "ObjC.import('CoreGraphics');",
  'var s=$.CGEventSourceCreate($.kCGEventSourceStateCombinedSessionState);',
  'var d=$.CGEventCreateKeyboardEvent(s,8,true);',
  '$.CGEventSetFlags(d,$.kCGEventFlagMaskCommand);',
  '$.CGEventPost($.kCGHIDEventTap,d);',
  'var u=$.CGEventCreateKeyboardEvent(s,8,false);',
  '$.CGEventSetFlags(u,$.kCGEventFlagMaskCommand);',
  '$.CGEventPost($.kCGHIDEventTap,u);'
].join('')

// 无副作用的探测：发送一个空按键的 down+up（不会输入任何字符）
const JXA_PROBE = [
  "ObjC.import('CoreGraphics');",
  'var s=$.CGEventSourceCreate($.kCGEventSourceStateCombinedSessionState);',
  'var d=$.CGEventCreateKeyboardEvent(s,0,true);',
  '$.CGEventPost($.kCGHIDEventTap,d);',
  'var u=$.CGEventCreateKeyboardEvent(s,0,false);',
  '$.CGEventPost($.kCGHIDEventTap,u);'
].join('')

/**
 * 通过 CGEvent 注入系统级 Cmd+C，复制当前前台应用的选中文字。
 * 需要「辅助功能」权限（Accessibility）。
 * @returns 模拟复制完成后的 Promise。
 * @author zhenghq
 */
export async function simulateCopy(): Promise<void> {
  try {
    await execFileP('osascript', ['-l', 'JavaScript', '-e', JXA_COPY])
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
 * 捕获当前选中文字，并在用户未主动复制时恢复取词前的剪贴板内容。
 * @param signal 用于在用户粘贴或点击其他位置时中止取词。
 * @param timeoutMs 等待前台应用写入剪贴板的最长时间。
 * @returns 当前前台应用的选中文字，没有有效选区时返回空字符串。
 * @author zhenghq
 */
export async function captureSelection(
  signal?: AbortSignal,
  timeoutMs = 800
): Promise<string> {
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
   * 在取词被取消时立即恢复剪贴板，确保紧接着的粘贴读取原内容。
   * @returns 无返回值。
   * @author zhenghq
   */
  const handleAbort = (): void => {
    restoreOriginalClipboard()
  }

  if (signal?.aborted) return ''
  signal?.addEventListener('abort', handleAbort, { once: true })

  const sentinel = `__SELECTION_TRANSLATOR_SENTINEL_${Date.now()}__`
  clipboard.clear()
  clipboard.writeText(sentinel)

  let text = ''
  try {
    const expectation = copyShortcutGuard.expectSyntheticCopyShortcut()
    try {
      await simulateCopy()
    } finally {
      await expectation.finish()
    }

    const start = Date.now()
    while (!signal?.aborted && Date.now() - start < timeoutMs) {
      text = clipboard.readText()
      const hasImage = !clipboard.readImage().isEmpty()
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
        restoreOriginalClipboard()
      } else {
        const externalCopyObserved = copyShortcutGuard.hasExternalCopySince(externalCopyVersion)
        const currentText = clipboard.readText()
        const currentHasImage = !clipboard.readImage().isEmpty()
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

  if (signal?.aborted || !text || text === sentinel) return ''
  return text
}
