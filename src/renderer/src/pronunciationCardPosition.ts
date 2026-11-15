/** 音标卡浮层定位算法的输入，坐标均相对于弹窗内边距盒。 */
export interface PronunciationCardPlacementInput {
  /** 触发词在弹窗内的矩形。 */
  anchorRect: { left: number; top: number; right: number; bottom: number }
  /** 音标卡浮层的尺寸。 */
  cardSize: { width: number; height: number }
  /** 弹窗可视区尺寸。 */
  popupSize: { width: number; height: number }
  /** 浮层与触发词的间距。 */
  gap?: number
  /** 浮层与弹窗边缘保留的最小间距。 */
  edgePadding?: number
}

/** 音标卡浮层的最终偏移与展示方位。 */
export interface PronunciationCardPlacement {
  /** 浮层左缘相对弹窗内边距盒的偏移。 */
  left: number
  /** 浮层上缘相对弹窗内边距盒的偏移。 */
  top: number
  /** 展示方位：触发词下方或上方。 */
  placement: 'below' | 'above'
}

/**
 * 计算音标卡浮层相对弹窗的偏移：优先展示在触发词下方，下方空间不足时翻转到上方，
 * 两侧都放不下时回退下方并夹进弹窗可视区；横向始终夹在边界内，卡片超宽时按最小边距对齐。
 * @param input 触发词矩形、浮层尺寸与弹窗尺寸。
 * @returns 浮层左上角偏移与展示方位。
 * @author zhenghq
 */
export function computePronunciationCardPlacement(
  input: PronunciationCardPlacementInput
): PronunciationCardPlacement {
  const gap = input.gap ?? 8
  const padding = input.edgePadding ?? 12
  const { anchorRect, cardSize, popupSize } = input
  const maxLeft = Math.max(padding, popupSize.width - padding - cardSize.width)
  const left = Math.min(maxLeft, Math.max(padding, anchorRect.left))
  const belowTop = anchorRect.bottom + gap
  const fitsBelow = belowTop + cardSize.height <= popupSize.height - padding
  const aboveTop = anchorRect.top - gap - cardSize.height
  if (!fitsBelow && aboveTop >= padding) {
    return { left, top: aboveTop, placement: 'above' }
  }
  const maxTop = Math.max(padding, popupSize.height - padding - cardSize.height)
  return { left, top: Math.min(maxTop, Math.max(padding, belowTop)), placement: 'below' }
}
