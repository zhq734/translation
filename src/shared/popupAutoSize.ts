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

/**
 * 计算叠加工作区溢出补偿后的弹窗自然高度。
 * 测量态的 auto 行高可能低于最终布局中网格行的 min-content 下限，
 * 需要把工作区在落地高度下的滚动溢出量补回窗口高度，否则工作区滚动条
 * 会与文本自身的滚动条同时出现，形成双层滚动条。
 * @param naturalHeight 测量态读取的自然高度。
 * @param workspaceOverflow 工作区在该高度下的 scrollHeight 与 clientHeight 之差，负值按 0 处理。
 * @returns 补偿后的窗口高度，不小于自然高度；非法输入按 0 处理。
 * @author zhenghq
 */
export function resolveNaturalHeightWithWorkspaceOverflow(
  naturalHeight: number,
  workspaceOverflow: number
): number {
  const base = Number.isFinite(naturalHeight) ? Math.max(0, naturalHeight) : 0
  const overflow = Number.isFinite(workspaceOverflow) ? Math.max(0, workspaceOverflow) : 0
  return base + overflow
}

/** 弹窗紧凑布局的高度阈值：窗口不高于该值（逻辑像素）时启用紧凑布局，等价于原 max-height: 400px 媒体查询。 */
export const POPUP_COMPACT_HEIGHT_THRESHOLD = 400

/**
 * 判断指定窗口高度是否应启用紧凑布局。
 * @param height 窗口高度（逻辑像素）。
 * @returns 高度不大于阈值时返回 true；非法数值按普通布局处理。
 * @author zhenghq
 */
export function isCompactPopupHeight(height: number): boolean {
  return Number.isFinite(height) && height <= POPUP_COMPACT_HEIGHT_THRESHOLD
}
