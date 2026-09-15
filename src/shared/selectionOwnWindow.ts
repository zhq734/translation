import { isPointInsideBounds, type ScreenBounds } from './selectionBehavior'

/** 参与全局划词排除判定的自有窗口。 */
export interface OwnWindowCandidate {
  /** 窗口标识，用于诊断日志区分设置页与网页阅读器。 */
  name: string
  /** 窗口当前是否持有键盘焦点。 */
  focused: boolean
  /** 窗口可见时的屏幕边界；不可见时为 null。 */
  bounds: ScreenBounds | null
}

/**
 * 过滤出真正可能接收当前鼠标事件的自有窗口。
 *
 * 应用不在最前时自有窗口不可能收到这次点击：macOS 在应用失活后仍可能让
 * key window 保持 `isFocused() === true`，若不做应用级门禁，后台设置页或
 * 网页阅读器的整块矩形会吞掉用户在其他应用里的划词起点，表现为划词完全无响应。
 * @param appFrontmost 系统激活事件是否表明本应用处于最前。
 * @param candidates 待判定的自有窗口。
 * @returns 允许按矩形排除划词的自有窗口列表。
 * @author zhenghq
 */
export function resolveOwnWindowExclusion(
  appFrontmost: boolean,
  candidates: readonly OwnWindowCandidate[]
): readonly OwnWindowCandidate[] {
  if (!appFrontmost) return []
  return candidates.filter((candidate) => candidate.focused && candidate.bounds !== null)
}

/**
 * 解析自有窗口排除所依据的应用最前状态。
 *
 * 只有 macOS 存在「应用已失活、key window 仍报告 isFocused()===true」的歧义，
 * 因此仅 macOS 采用应用激活事件跟踪结果；Windows 与 Linux 上窗口持有焦点
 * 即代表应用处于前台，保持既有判定，避免应用内点击被误判为跨应用划词。
 * @param platform 当前运行平台。
 * @param macAppActiveByEvents macOS 应用激活事件跟踪到的最前状态。
 * @returns 允许按自有窗口矩形排除划词时返回 true。
 * @author zhenghq
 */
export function resolveAppFrontmostForExclusion(
  platform: NodeJS.Platform,
  macAppActiveByEvents: boolean
): boolean {
  if (platform !== 'darwin') return true
  return macAppActiveByEvents
}

/**
 * 查找吞掉指定屏幕坐标的自有窗口。
 * @param point 屏幕坐标。
 * @param windows 已通过应用级门禁的自有窗口列表。
 * @returns 命中的自有窗口；未命中时返回 null。
 * @author zhenghq
 */
export function findOwnWindowHit(
  point: { x: number; y: number },
  windows: readonly OwnWindowCandidate[]
): OwnWindowCandidate | null {
  return windows.find((candidate) => isPointInsideBounds(point, candidate.bounds)) ?? null
}
