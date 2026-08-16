/** 弹窗在屏幕中的矩形边界。 */
export interface PopupBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 屏幕坐标点。 */
export interface ScreenPoint {
  x: number
  y: number
}

const POPUP_DRAG_REGION_HEIGHT = 32

/**
 * 判断屏幕坐标是否位于弹窗顶部的原生拖拽区域。
 * @param point 待判断的鼠标屏幕坐标。
 * @param bounds 弹窗当前的屏幕边界。
 * @returns 坐标是否位于弹窗顶部拖拽区域。
 * @author zhenghq
 */
export function isPointInPopupDragRegion(point: ScreenPoint, bounds: PopupBounds): boolean {
  const right = bounds.x + bounds.width
  const dragRegionBottom = Math.min(
    bounds.y + bounds.height,
    bounds.y + POPUP_DRAG_REGION_HEIGHT
  )
  return point.x >= bounds.x &&
    point.x <= right &&
    point.y >= bounds.y &&
    point.y <= dragRegionBottom
}
