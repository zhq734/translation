/** OCR 结果侧栏自动尺寸允许的区间，单位均为逻辑像素。 */
export const SCREENSHOT_OCR_PANEL_SIZE_LIMITS = {
  minWidth: 180,
  minHeight: 84,
  maxWidth: 520,
  maxHeight: 420,
  edgeGap: 8
} as const

/** OCR 结果侧栏自动尺寸测量结果。 */
export interface ScreenshotOcrPanelAutoSizeInput {
  /** 文本内容的自然宽度。 */
  contentWidth: number
  /** 文本内容的自然高度。 */
  contentHeight: number
  /** 除文本内容外的水平装饰尺寸。 */
  chromeWidth: number
  /** 除文本内容外的垂直装饰尺寸。 */
  chromeHeight: number
  /** 截图覆盖层可用宽度。 */
  viewportWidth: number
  /** 截图覆盖层可用高度。 */
  viewportHeight: number
}

/** OCR 结果侧栏尺寸。 */
export interface ScreenshotOcrPanelSize {
  width: number
  height: number
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
 * 根据内容自然尺寸计算 OCR 结果侧栏尺寸，并确保不超出截图覆盖层。
 * @param input 内容测量值与视口尺寸。
 * @returns 取整后的侧栏宽高。
 * @author zhenghq
 */
export function resolveScreenshotOcrPanelAutoSize(
  input: ScreenshotOcrPanelAutoSizeInput
): ScreenshotOcrPanelSize {
  const availableWidth = Math.max(0, input.viewportWidth - SCREENSHOT_OCR_PANEL_SIZE_LIMITS.edgeGap * 2)
  const availableHeight = Math.max(0, input.viewportHeight - SCREENSHOT_OCR_PANEL_SIZE_LIMITS.edgeGap * 2)
  const maxWidth = Math.min(SCREENSHOT_OCR_PANEL_SIZE_LIMITS.maxWidth, availableWidth)
  const maxHeight = Math.min(SCREENSHOT_OCR_PANEL_SIZE_LIMITS.maxHeight, availableHeight)
  const naturalWidth = Math.max(0, input.contentWidth) + Math.max(0, input.chromeWidth)
  const naturalHeight = Math.max(0, input.contentHeight) + Math.max(0, input.chromeHeight)

  return {
    width: Math.round(clampToRange(naturalWidth, SCREENSHOT_OCR_PANEL_SIZE_LIMITS.minWidth, maxWidth)),
    height: Math.round(clampToRange(naturalHeight, SCREENSHOT_OCR_PANEL_SIZE_LIMITS.minHeight, maxHeight))
  }
}
