import type { SelectionFailureReason } from '../shared/selectionCaptureCoordinator'

/**
 * macOS 划词取词连续超时追踪器。
 * hiservices 系统服务故障时所有模拟按键注入都会失效，表现为复制兜底反复超时；
 * 连续多次超时极可能是该故障而非单次应用问题，此时自动重启 hiservices。
 * @author zhenghq
 */

/** 触发自动修复所需的连续超时次数。 */
const CONSECUTIVE_TIMEOUT_THRESHOLD = 2
/** 重置连续计数的成功间隔：超过该时长未再超时则清零重新计数。 */
const TIMEOUT_RESET_WINDOW_MS = 60_000

/** 超时追踪所需的最小取词结果。 */
export interface TrackableCaptureOutcome {
  /** 取到的选中文字，未取到时为空字符串。 */
  text: string
  /** 未取到文字时的失败原因。 */
  reason?: SelectionFailureReason
}

let consecutiveTimeouts = 0
let lastTimeoutAt = 0

/**
 * 记录一次取词结果，返回是否应自动修复 hiservices 服务。
 * @param outcome 本次取词结果；仅真实 timeout 会增加故障计数，成功文本会重置计数。
 * @param platform 当前操作系统平台标识。
 * @param now 当前时间戳（毫秒），可注入便于测试。
 * @returns 连续超时达到阈值时返回 true，调用方应自动执行修复。
 * @author zhenghq
 */
export function recordCaptureOutcome(
  outcome: TrackableCaptureOutcome,
  platform: NodeJS.Platform = process.platform,
  now = Date.now()
): boolean {
  if (platform !== 'darwin') return false

  if (outcome.text.trim()) {
    consecutiveTimeouts = 0
    lastTimeoutAt = 0
    return false
  }

  if (outcome.reason !== 'timeout') return false

  if (now - lastTimeoutAt > TIMEOUT_RESET_WINDOW_MS) consecutiveTimeouts = 0
  lastTimeoutAt = now
  consecutiveTimeouts += 1
  return consecutiveTimeouts >= CONSECUTIVE_TIMEOUT_THRESHOLD
}

/**
 * 自动修复开始后重置追踪状态，避免同一次故障反复触发。
 * @returns 无返回值。
 * @author zhenghq
 */
export function resetCopyTimeoutTracker(): void {
  consecutiveTimeouts = 0
  lastTimeoutAt = 0
}
