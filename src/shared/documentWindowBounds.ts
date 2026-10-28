/**
 * 文档工作台窗口边界恢复。
 *
 * 该模块只包含纯函数，避免窗口状态测试依赖 Electron。恢复策略优先保留用户
 * 上一次选择的显示器与位置；当显示器已断开或历史值非法时，回退到主工作区。
 *
 * @author zhenghq
 */

/** 窗口或显示器工作区的矩形。 */
export interface DocumentWindowBounds {
  /** 横坐标。 */
  x: number
  /** 纵坐标。 */
  y: number
  /** 宽度。 */
  width: number
  /** 高度。 */
  height: number
}

/** 可恢复窗口的显示器信息。 */
export interface DocumentWindowDisplay {
  /** 显示器可用工作区，不含系统任务栏或 Dock。 */
  workArea: DocumentWindowBounds
}

/** 窗口尺寸约束。 */
export interface DocumentWindowSize {
  /** 宽度。 */
  width: number
  /** 高度。 */
  height: number
}

/** 可恢复的窗口位置；缺少坐标时由系统居中放置。 */
export interface DocumentWindowRestoredBounds extends DocumentWindowSize {
  /** 横坐标；仅保留历史位置时提供。 */
  x?: number
  /** 纵坐标；仅保留历史位置时提供。 */
  y?: number
}

/**
 * 判断数值是否为有限数。
 * @param value 待判断的数值。
 * @returns 是有限数时返回 true。
 * @author zhenghq
 */
function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value)
}

/**
 * 判断窗口边界结构是否有效。
 * @param value 待判断的边界。
 * @returns 四个维度均为有限数且宽高为正数时返回 true。
 * @author zhenghq
 */
function isValidBounds(value: DocumentWindowBounds | null | undefined): value is DocumentWindowBounds {
  return Boolean(
    value &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    value.width > 0 &&
    value.height > 0
  )
}

/**
 * 计算两个矩形的交集面积。
 * @param left 第一个矩形。
 * @param right 第二个矩形。
 * @returns 交集面积，无交集时返回 0。
 * @author zhenghq
 */
function intersectionArea(left: DocumentWindowBounds, right: DocumentWindowBounds): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
  return width * height
}

/**
 * 找出与目标窗口重叠面积最大的显示器。
 * @param bounds 目标窗口边界。
 * @param displays 当前显示器工作区列表。
 * @returns 最匹配的显示器；没有可见交集时返回 null。
 * @author zhenghq
 */
function findBestDisplay(
  bounds: DocumentWindowBounds,
  displays: readonly DocumentWindowDisplay[]
): DocumentWindowDisplay | null {
  let bestDisplay: DocumentWindowDisplay | null = null
  let bestArea = 0
  for (const display of displays) {
    if (!isValidBounds(display.workArea)) continue
    const area = intersectionArea(bounds, display.workArea)
    if (area > bestArea) {
      bestArea = area
      bestDisplay = display
    }
  }
  // 只要仍有可见交集就保留历史位置并夹紧；完全无交集才说明显示器已断开。
  return bestArea > 0 ? bestDisplay : null
}

/**
 * 将窗口边界夹紧到显示器工作区，并遵守最小尺寸。
 * @param bounds 原始窗口边界。
 * @param display 目标显示器工作区。
 * @param minimumSize 最小窗口尺寸。
 * @returns 完全位于工作区内且不小于最小尺寸的边界。
 * @author zhenghq
 */
export function clampDocumentWindowBounds(
  bounds: DocumentWindowBounds,
  display: DocumentWindowDisplay,
  minimumSize: DocumentWindowSize
): DocumentWindowBounds {
  const area = display.workArea
  const minimumWidth = Math.min(Math.max(1, minimumSize.width), area.width)
  const minimumHeight = Math.min(Math.max(1, minimumSize.height), area.height)
  const width = Math.min(area.width, Math.max(minimumWidth, bounds.width))
  const height = Math.min(area.height, Math.max(minimumHeight, bounds.height))
  return {
    x: Math.min(area.x + area.width - width, Math.max(area.x, bounds.x)),
    y: Math.min(area.y + area.height - height, Math.max(area.y, bounds.y)),
    width,
    height
  }
}

/**
 * 解析窗口恢复位置。
 *
 * 优先保留仍与显示器有足够重叠的历史边界；显示器断开、历史边界非法或没有
 * 可用显示器时，返回默认尺寸并让 Electron 按主显示器居中显示。
 *
 * @param saved 上一次保存的窗口边界。
 * @param displays 当前显示器工作区。
 * @param minimumSize 最小窗口尺寸。
 * @param defaultSize 默认窗口尺寸。
 * @returns 可安全用于 BrowserWindow 的初始边界。
 * @author zhenghq
 */
export function resolveRestoredDocumentWindowBounds(
  saved: DocumentWindowBounds | null | undefined,
  displays: readonly DocumentWindowDisplay[],
  minimumSize: DocumentWindowSize,
  defaultSize: DocumentWindowSize
): DocumentWindowRestoredBounds {
  const usableDisplays = displays.filter((display) => isValidBounds(display.workArea))
  if (!isValidBounds(saved) || usableDisplays.length === 0) {
    return { width: defaultSize.width, height: defaultSize.height }
  }
  const matchedDisplay = findBestDisplay(saved, usableDisplays)
  if (!matchedDisplay) {
    // 显示器断开后不能沿用旧屏幕坐标，否则窗口会在主屏之外不可见。
    const primary = usableDisplays[0]!.workArea
    const width = Math.min(primary.width, Math.max(minimumSize.width, saved.width))
    const height = Math.min(primary.height, Math.max(minimumSize.height, saved.height))
    return {
      x: Math.round(primary.x + (primary.width - width) / 2),
      y: Math.round(primary.y + (primary.height - height) / 2),
      width,
      height
    }
  }
  return clampDocumentWindowBounds(saved, matchedDisplay, minimumSize)
}
