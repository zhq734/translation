import type { RealtimeSubtitleErrorCode } from './subtitleSession'

/** 会话自动恢复的基础退避时间（毫秒）。 */
export const SUBTITLE_RECONNECT_BASE_DELAY_MS = 1_000

/** 会话自动恢复退避时间的上限（毫秒）。 */
export const SUBTITLE_RECONNECT_MAX_DELAY_MS = 30_000

/** 默认允许的会话自动恢复次数。 */
export const SUBTITLE_MAX_NETWORK_RECONNECTS = 3

/**
 * 计算第 N 次会话自动恢复前的指数退避时间。
 * @param attempt 已执行的恢复次数，从 0 开始。
 * @returns 本次重连应等待的毫秒数。
 * @author zhenghq
 */
export function resolveSubtitleReconnectDelay(attempt: number): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0
  return Math.min(
    SUBTITLE_RECONNECT_BASE_DELAY_MS * 2 ** Math.min(safeAttempt, 10),
    SUBTITLE_RECONNECT_MAX_DELAY_MS
  )
}

/**
 * 判断当前错误是否允许继续自动重连。
 * @param code 结构化错误分类。
 * @param attempt 已执行的重连次数，从 0 开始。
 * @param maxAttempts 允许的最大重连次数。
 * @returns 网络或音频设备错误且未达到上限时返回 true。
 * @author zhenghq
 */
export function shouldReconnectSubtitle(
  code: RealtimeSubtitleErrorCode,
  attempt: number,
  maxAttempts: number
): boolean {
  return (
    (code === 'network' || code === 'device-unavailable') &&
    attempt < Math.max(0, Math.floor(maxAttempts))
  )
}
