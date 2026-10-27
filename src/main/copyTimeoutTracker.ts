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
  /** 诊断元数据；copyObserved 用于区分系统事件注入故障与目标应用忽略复制。 */
  diagnostics?: {
    /** macOS 模拟复制事件是否至少被全局事件钩子观测到一次。 */
    copyObserved?: boolean
  }
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

  // 合成复制事件已进入系统事件钩子，说明 hiservices 与 CGEvent 注入链路正常。
  // 此时剪贴板仍不变通常是目标应用忽略瞬时快捷键，属于应用级兼容问题；
  // 必须清零历史系统故障计数，不能重启系统服务并触发新的内部窗口激活。
  if (outcome.diagnostics?.copyObserved === true) {
    consecutiveTimeouts = 0
    lastTimeoutAt = 0
    return false
  }

  // 未启用事件观测时 copyObserved 为 undefined，既不能证明注入链路正常，
  // 也不能证明事件没有进入 event tap。该状态保持中性，不累计、不清零，
  // 避免把纯快捷键模式的普通应用级超时误判为 hiservices 系统故障。
  if (outcome.diagnostics?.copyObserved === undefined) return false

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
