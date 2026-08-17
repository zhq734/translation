/**
 * 一次内部模拟复制按键的观测句柄。
 * @author zhenghq
 */
export interface SyntheticCopyExpectation {
  /**
   * 等待内部模拟复制事件到达或观测窗口超时，然后结束本次观测。
   * @returns 观测结束后的 Promise。
   * @author zhenghq
   */
  finish(): Promise<void>
}

/**
 * 内部模拟复制事件到达的最长等待时间。
 * @author zhenghq
 */
const SYNTHETIC_COPY_OBSERVATION_TIMEOUT_MS = 120

/**
 * 一次待观测的内部模拟复制事件状态。
 * @author zhenghq
 */
interface PendingSyntheticCopy {
  observed: boolean
  finishPromise?: Promise<void>
  resolveFinish?: () => void
  timeout?: ReturnType<typeof setTimeout>
}

/**
 * 判断剪贴板是否已经出现内部取词捕获到的有效内容。
 * @param currentText 当前剪贴板文本。
 * @param hasImage 当前剪贴板是否包含图片。
 * @param sentinel 内部取词写入的哨兵文本。
 * @returns 是否已经捕获到文字或图片。
 * @author zhenghq
 */
export function hasClipboardCaptureCompleted(
  currentText: string,
  hasImage: boolean,
  sentinel: string
): boolean {
  return hasImage || Boolean(currentText && currentText !== sentinel)
}

/**
 * 判断快捷键是否为系统标准复制组合，避免翻译快捷键抢占复制功能。
 * @param accelerator Electron 快捷键描述。
 * @returns 是否为 Ctrl+C、Command+C 或其常见别名。
 * @author zhenghq
 */
export function isCopyShortcut(accelerator: string): boolean {
  const normalized = accelerator.replace(/\s+/gu, '').toLowerCase()
  const parts = normalized.split('+')
  if (parts.length !== 2 || !parts.includes('c')) return false

  const modifier = parts.find((part) => part !== 'c') ?? ''
  return new Set([
    'ctrl',
    'control',
    'cmd',
    'command',
    'commandorcontrol',
    'cmdorctrl'
  ]).has(modifier)
}

/**
 * 判断内部取词完成后是否应恢复旧剪贴板，用户主动复制成功时保留用户的新内容。
 * @param externalCopyObserved 取词期间是否观测到用户复制快捷键。
 * @param currentText 当前剪贴板文本。
 * @param sentinel 内部取词写入的哨兵文本。
 * @param currentHasImage 当前剪贴板是否包含图片。
 * @param capturedText 本次内部取词已经捕获到的文本。
 * @returns 是否应恢复取词前的剪贴板内容。
 * @author zhenghq
 */
export function shouldRestoreClipboard(
  externalCopyObserved: boolean,
  currentText: string,
  sentinel: string,
  currentHasImage = false,
  capturedText?: string
): boolean {
  if (!hasClipboardCaptureCompleted(currentText, currentHasImage, sentinel)) return true
  if (externalCopyObserved) return false
  if (capturedText !== undefined && !currentHasImage && currentText !== capturedText) return false
  return true
}

/**
 * 区分内部模拟复制与用户主动复制，避免内部取词覆盖用户刚复制的内容。
 * @author zhenghq
 */
export class CopyShortcutGuard {
  private externalCopyVersion = 0
  private nextExpectationId = 0
  private readonly pendingSyntheticCopies = new Map<number, PendingSyntheticCopy>()

  /**
   * 返回当前用户复制事件版本号。
   * @returns 当前用户复制事件版本号。
   * @author zhenghq
   */
  getExternalCopyVersion(): number {
    return this.externalCopyVersion
  }

  /**
   * 标记即将发送一次内部模拟复制按键，供全局键盘监听排除该事件。
   * @returns 可用于结束本次观测窗口的句柄。
   * @author zhenghq
   */
  expectSyntheticCopyShortcut(): SyntheticCopyExpectation {
    const expectationId = ++this.nextExpectationId
    const pending: PendingSyntheticCopy = { observed: false }
    this.pendingSyntheticCopies.set(expectationId, pending)

    return {
      finish: async () => {
        const active = this.pendingSyntheticCopies.get(expectationId)
        if (!active) return
        if (active.observed) {
          this.pendingSyntheticCopies.delete(expectationId)
          return
        }
        if (!active.finishPromise) {
          active.finishPromise = new Promise<void>((resolve) => {
            active.resolveFinish = resolve
            active.timeout = setTimeout(() => {
              this.pendingSyntheticCopies.delete(expectationId)
              resolve()
            }, SYNTHETIC_COPY_OBSERVATION_TIMEOUT_MS)
          })
        }
        await active.finishPromise
      }
    }
  }

  /**
   * 记录一次全局复制快捷键；优先消费内部模拟事件，否则记为用户主动复制。
   * @returns 用户主动复制返回 true，内部模拟复制返回 false。
   * @author zhenghq
   */
  observeCopyShortcut(): boolean {
    const syntheticEntry = [...this.pendingSyntheticCopies.entries()]
      .find(([, pending]) => !pending.observed)
    if (syntheticEntry) {
      const [expectationId, pending] = syntheticEntry
      pending.observed = true
      if (pending.timeout) clearTimeout(pending.timeout)
      if (pending.resolveFinish) {
        this.pendingSyntheticCopies.delete(expectationId)
        pending.resolveFinish()
      }
      return false
    }
    this.externalCopyVersion += 1
    return true
  }

  /**
   * 判断指定版本之后是否发生过用户主动复制。
   * @param version 取词开始前记录的用户复制事件版本号。
   * @returns 指定版本之后是否发生过用户主动复制。
   * @author zhenghq
   */
  hasExternalCopySince(version: number): boolean {
    return this.externalCopyVersion !== version
  }
}
