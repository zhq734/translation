import type { PopupAutoSizeRequest } from './types'

export type { PopupAutoSizeRequest }

/** 弹窗自适应尺寸允许的区间，单位均为逻辑像素。 */
export const POPUP_AUTO_SIZE_LIMITS = {
  minWidth: 520,
  minHeight: 320,
  maxWidth: 720,
  maxHeight: 640
} as const

/** 弹窗自适应尺寸的可选约束。 */
export interface PopupAutoSizeOptions {
  /** 距工作区边缘保留的间隙。 */
  edgeGap?: number
}

/** 弹窗尺寸。 */
export interface PopupSize {
  width: number
  height: number
}

/** 弹窗在屏幕坐标系中的矩形。 */
export interface PopupRect extends PopupSize {
  x: number
  y: number
}

/**
 * 校验来自 Renderer 的弹窗尺寸负载，拒绝零值与非法数值。
 * @param value 未信任的 IPC 负载。
 * @returns 负载为合法尺寸时返回 true。
 * @author zhenghq
 */
export function isPopupAutoSizeRequest(value: unknown): value is PopupAutoSizeRequest {
  if (!value || typeof value !== 'object') return false
  const size = value as Record<string, unknown>
  return typeof size.width === 'number'
    && typeof size.height === 'number'
    && Number.isFinite(size.width)
    && Number.isFinite(size.height)
    && size.width > 0
    && size.height > 0
}

/**
 * 将数值收敛到指定区间，区间非法时退化为上限。
 * @param value 待收敛数值。
 * @param min 期望下限。
 * @param max 实际可用上限。
 * @returns 收敛后的数值。
 * @author zhenghq
 */
function clampToRange(value: number, min: number, max: number): number {
  const lower = Math.min(min, max)
  return Math.max(lower, Math.min(value, max))
}

/**
 * 把内容测量结果收敛为弹窗允许且不超过工作区的尺寸。
 * @param size Renderer 上报的内容自然尺寸。
 * @param workArea 目标显示器工作区。
 * @param options 可选边缘间隙。
 * @returns 取整并收敛后的弹窗尺寸。
 * @author zhenghq
 */
export function resolvePopupAutoSize(
  size: PopupAutoSizeRequest,
  workArea: PopupRect,
  options?: PopupAutoSizeOptions
): PopupSize {
  const edgeGap = options?.edgeGap ?? 0
  const availableWidth = Math.max(0, workArea.width - edgeGap * 2)
  const availableHeight = Math.max(0, workArea.height - edgeGap * 2)
  const maxWidth = Math.min(POPUP_AUTO_SIZE_LIMITS.maxWidth, availableWidth)
  const maxHeight = Math.min(POPUP_AUTO_SIZE_LIMITS.maxHeight, availableHeight)
  return {
    width: Math.round(clampToRange(size.width, POPUP_AUTO_SIZE_LIMITS.minWidth, maxWidth)),
    height: Math.round(clampToRange(size.height, POPUP_AUTO_SIZE_LIMITS.minHeight, maxHeight))
  }
}

/**
 * 在保持左上锚点的前提下把新尺寸收拢进工作区。
 * @param bounds 弹窗当前矩形。
 * @param size 收敛后的目标尺寸。
 * @param workArea 目标显示器工作区。
 * @returns 可直接用于窗口的新矩形。
 * @author zhenghq
 */
export function resolvePopupResizeBounds(
  bounds: PopupRect,
  size: PopupSize,
  workArea: PopupRect
): PopupRect {
  const width = Math.round(size.width)
  const height = Math.round(size.height)
  const maxX = workArea.x + workArea.width - width
  const maxY = workArea.y + workArea.height - height
  return {
    x: Math.round(Math.max(workArea.x, Math.min(bounds.x, maxX))),
    y: Math.round(Math.max(workArea.y, Math.min(bounds.y, maxY))),
    width,
    height
  }
}
