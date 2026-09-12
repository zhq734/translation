import type { RgbaImage } from '../shared/imagePreprocess'
import type { OcrBoundingBox } from '../shared/types'

/** 判定墨迹时相对背景所需的最小对比度（0-255）。 */
const MIN_INK_CONTRAST = 48

/** 判定字符列所需的墨迹高度相对最高列的阈值比例。 */
const INK_COLUMN_THRESHOLD_RATIO = 0.25

/** 下划线扫描带的起始位置，位于字形主体下方以避开连字符。 */
const UNDERLINE_SCAN_TOP_RATIO = 0.62

/** 下划线扫描带相对行底的延伸比例，兼容包围盒未覆盖线尾的情况。 */
const UNDERLINE_SCAN_BOTTOM_RATIO = 0.2

/**
 * 行盒未覆盖下划线时向下兜底搜索的窗口比例。
 *
 * 窗口要足够大，使相邻行的字形能连成厚墨迹带而触发厚度判据被拒绝，
 * 避免把截断的字形误当成细下划线；同时要求下划线带下方仍有空白。
 */
const UNDERLINE_BAND_SEARCH_BOTTOM_RATIO = 1.2

/**
 * 判定下划线时单行墨迹列需占一个字符格宽度的最小覆盖比例。
 *
 * 下划线只占一个字符格，而相邻的真实空格会让 OCR 的连续间隙宽度翻倍，
 * 因此不能用间隙宽度做基准，否则贴近字形的短下划线会被误判为普通空格。
 */
const UNDERLINE_COVERAGE_RATIO = 0.5

/** 判定间隙被字形（连字符等）填充时，单行墨迹列需占间隙宽度的最小比例。 */
const GLYPH_GAP_FILL_RATIO = 0.5

/**
 * 计算 RGBA 像素在给定背景亮度上的实际亮度，透明像素按背景合成。
 * @param image 源图像。
 * @param offset 像素在数据中的偏移。
 * @param backgroundLuma 背景亮度。
 * @returns 合成后的亮度（0-255）。
 * @author zhenghq
 */
function compositedLuma(image: RgbaImage, offset: number, backgroundLuma: number): number {
  const alpha = image.data[offset + 3]! / 255
  const luma = image.data[offset]! * 0.299 +
    image.data[offset + 1]! * 0.587 +
    image.data[offset + 2]! * 0.114
  return luma * alpha + backgroundLuma * (1 - alpha)
}

/**
 * 估计文本行内的背景亮度，取行盒像素亮度直方图的中位数。
 * 文字通常只占行盒的一小部分，因此中位数可稳定代表背景。
 * @param image 源图像。
 * @param left 行盒左边界。
 * @param top 行盒上边界。
 * @param right 行盒右边界。
 * @param bottom 行盒下边界。
 * @returns 背景亮度（0-255）。
 * @author zhenghq
 */
function estimateBackgroundLuma(
  image: RgbaImage,
  left: number,
  top: number,
  right: number,
  bottom: number
): number {
  const histogram = new Uint32Array(256)
  let samples = 0
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const offset = (y * image.width + x) * 4
      const alpha = image.data[offset + 3]! / 255
      // 透明像素直接按白色统计，避免把透明区域误判成深色背景。
      const luma = image.data[offset]! * 0.299 +
        image.data[offset + 1]! * 0.587 +
        image.data[offset + 2]! * 0.114
      const composited = Math.round(luma * alpha + 255 * (1 - alpha))
      histogram[Math.max(0, Math.min(255, composited))]! += 1
      samples += 1
    }
  }
  if (samples === 0) return 255
  let cumulative = 0
  for (let luma = 0; luma < histogram.length; luma += 1) {
    cumulative += histogram[luma]!
    if (cumulative * 2 >= samples) return luma
  }
  return 255
}

/**
 * 判断像素相对背景是否属于前景墨迹。
 * 通过对比度判定，兼容深色文字浅色背景与浅色文字深色背景两种主题。
 * @param image 源图像。
 * @param offset 像素在数据中的偏移。
 * @param backgroundLuma 背景亮度。
 * @returns 是否属于前景墨迹。
 * @author zhenghq
 */
function isInkPixel(image: RgbaImage, offset: number, backgroundLuma: number): boolean {
  return Math.abs(compositedLuma(image, offset, backgroundLuma) - backgroundLuma) >= MIN_INK_CONTRAST
}

/** 图像中由连续空白列构成的横向区间。 */
interface BlankGap {
  /** 起始横坐标（含）。 */
  start: number
  /** 结束横坐标（含）。 */
  end: number
  /** 间隙宽度（像素）。 */
  width: number
}

/**
 * 计算指定横向范围内每一列的墨迹命中数。
 * @param image 源图像。
 * @param left 起始横坐标。
 * @param right 结束横坐标。
 * @param top 起始纵坐标。
 * @param bottom 结束纵坐标。
 * @param backgroundLuma 背景亮度。
 * @returns 长度等于范围的列墨迹计数数组。
 * @author zhenghq
 */
function columnInkCounts(
  image: RgbaImage,
  left: number,
  right: number,
  top: number,
  bottom: number,
  backgroundLuma: number
): number[] {
  const counts: number[] = []
  for (let x = left; x <= right; x += 1) {
    let ink = 0
    for (let y = top; y <= bottom; y += 1) {
      const offset = (y * image.width + x) * 4
      if (isInkPixel(image, offset, backgroundLuma)) ink += 1
    }
    counts.push(ink)
  }
  return counts
}

/**
 * 按墨迹高度阈值提取非字符列构成的间隙。
 *
 * 下划线的墨迹高度明显低于字形笔画，因此只按纵向墨迹高度过滤即可把下划线列
 * 视为空隙，从而在字形带上正确还原词与词的边界。
 * @param counts 列墨迹计数数组。
 * @param left 数组首列对应的横坐标。
 * @param threshold 判定字符列的最小墨迹高度。
 * @returns 空白间隙列表。
 * @author zhenghq
 */
function extractBlankGaps(counts: number[], left: number, threshold: number): BlankGap[] {
  const gaps: BlankGap[] = []
  let gapStart = -1
  for (let index = 0; index <= counts.length; index += 1) {
    const isBlank = index < counts.length && counts[index]! < threshold
    if (isBlank) {
      if (gapStart < 0) gapStart = index
      continue
    }
    if (gapStart >= 0) {
      gaps.push({
        start: left + gapStart,
        end: left + index - 1,
        width: index - gapStart
      })
      gapStart = -1
    }
  }
  return gaps
}

/** 行盒内由连续墨迹行构成的纵向区间。 */
interface InkBand {
  /** 起始纵坐标（含）。 */
  top: number
  /** 结束纵坐标（含）。 */
  bottom: number
}

/**
 * 在行盒底部寻找与字形主体分离的薄墨迹带（下划线带）。
 *
 * 小字号下划线只有 1-2 像素高，若把它计入列墨迹高度，下划线列会被误判为
 * 字形列，导致无法形成可供识别的间隙。这里先按行的墨迹量找出底部独立墨迹带：
 * 它与上方的字形主体之间至少隔着一行空白，且自身足够薄，符合下划线的形态。
 * @param image 源图像。
 * @param range 约束到图像范围内的行盒。
 * @param backgroundLuma 背景亮度。
 * @returns 下划线带区间；未找到时返回 null。
 * @author zhenghq
 */
function findUnderlineBand(
  image: RgbaImage,
  range: { left: number; right: number; top: number; bottom: number; height: number },
  backgroundLuma: number
): InkBand | null {
  const rowInk: number[] = []
  for (let y = range.top; y <= range.bottom; y += 1) {
    let ink = 0
    for (let x = range.left; x <= range.right; x += 1) {
      if (isInkPixel(image, (y * image.width + x) * 4, backgroundLuma)) ink += 1
    }
    rowInk.push(ink)
  }
  const maxRowInk = rowInk.reduce((max, value) => Math.max(max, value), 0)
  if (maxRowInk <= 0) return null

  // 行墨迹量低于峰值 3% 时视为空白行，用于把底部墨迹带与字形主体分开。
  const blankThreshold = Math.max(1, Math.floor(maxRowInk * 0.03))
  let cursor = rowInk.length - 1
  while (cursor >= 0 && rowInk[cursor]! < blankThreshold) cursor -= 1
  if (cursor < 0) return null

  const bandBottom = range.top + cursor
  while (cursor >= 0 && rowInk[cursor]! >= blankThreshold) cursor -= 1
  const bandTop = range.top + cursor + 1
  const bandHeight = bandBottom - bandTop + 1
  // 下划线带必须足够薄，避免把正常字形笔画误当成下划线。
  if (bandHeight > Math.max(3, Math.ceil(range.height * 0.25))) return null

  // 该带上方必须存在被空白隔开的字形主体，否则整行只是一条独立横线。
  let hasGlyphBand = false
  for (let index = cursor; index >= 0; index -= 1) {
    if (rowInk[index]! >= blankThreshold) {
      hasGlyphBand = true
      break
    }
  }
  if (!hasGlyphBand) return null
  return { top: bandTop, bottom: bandBottom }
}

/**
 * 判断间隙是否被字形笔画的墨迹填满（如英文连字符 `-`）。
 *
 * 连字符、部分标点会让相邻字符之间出现较宽的空隙，但它们自身在字形带内
 * 有连续墨迹。真正的词间空白不会出现这种贯穿整行的横向笔画，
 * 因此可在对齐文本分隔符之前把这类“假间隙”剔除。
 * @param image 源图像。
 * @param gap 待检查的间隙。
 * @param top 行盒上边界。
 * @param scanTop 下划线扫描带起始纵坐标，字形带为该坐标之上的区域。
 * @param backgroundLuma 背景亮度。
 * @returns 间隙是否被字形墨迹填充。
 * @author zhenghq
 */
function isGlyphFilledGap(
  image: RgbaImage,
  gap: BlankGap,
  top: number,
  scanTop: number,
  backgroundLuma: number
): boolean {
  const requiredInk = Math.max(2, Math.ceil(gap.width * GLYPH_GAP_FILL_RATIO))
  for (let y = top; y < scanTop; y += 1) {
    let inkColumns = 0
    for (let x = gap.start; x <= gap.end; x += 1) {
      const offset = (y * image.width + x) * 4
      if (isInkPixel(image, offset, backgroundLuma)) inkColumns += 1
    }
    if (inkColumns >= requiredInk) return true
  }
  return false
}

/**
 * 计算间隙在下划线扫描带内最长的单行连续墨迹游程。
 *
 * 下划线横线会连续跨越整个间隙，因此游程长度接近间隙宽度；普通空格中
 * 偶尔出现的下降笔画只形成短游程，可据此区分两者。
 * @param image 源图像。
 * @param gap 待检查的间隙。
 * @param scanTop 扫描带起始纵坐标。
 * @param scanBottom 扫描带结束纵坐标。
 * @param backgroundLuma 背景亮度。
 * @returns 最长的连续墨迹列数。
 * @author zhenghq
 */
function longestUnderlineRun(
  image: RgbaImage,
  gap: BlankGap,
  scanTop: number,
  scanBottom: number,
  backgroundLuma: number
): number {
  let longest = 0
  for (let y = scanTop; y <= scanBottom; y += 1) {
    let current = 0
    for (let x = gap.start; x <= gap.end; x += 1) {
      const offset = (y * image.width + x) * 4
      if (isInkPixel(image, offset, backgroundLuma)) {
        current += 1
        longest = Math.max(longest, current)
      } else {
        current = 0
      }
    }
  }
  return longest
}

/**
 * 将行盒约束到图像范围内。
 * @param box 原始行盒。
 * @param image 源图像。
 * @returns 约束后的行列范围；行盒无效时返回 null。
 * @author zhenghq
 */
function clampBoxToImage(
  box: OcrBoundingBox | undefined,
  image: RgbaImage
): { left: number; right: number; top: number; bottom: number; height: number } | null {
  if (!box) return null
  const x = Number(box.x)
  const y = Number(box.y)
  const width = Number(box.width)
  const height = Number(box.height)
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null

  const left = Math.max(0, Math.floor(x))
  const top = Math.max(0, Math.floor(y))
  const right = Math.min(image.width - 1, Math.ceil(x + width) - 1)
  const bottom = Math.min(image.height - 1, Math.ceil(y + height) - 1)
  if (right <= left || bottom <= top) return null
  return { left, right, top, bottom, height: bottom - top + 1 }
}

/**
 * 恢复 PaddleOCR 在识别下划线时丢失为空格的下划线。
 *
 * PaddleOCR 的识别结果不含词框，因此这里先按整行的列墨迹高度区分字形列与
 * 间隙列（下划线的墨迹高度明显低于字形笔画，会被归入间隙列），再剔除被连字符
 * 等字形笔画填充的假间隙，并以字符间隙中位宽度的倍数筛出词与词之间的大间隙；
 * 最后检查该间隙在下划线扫描带中是否存在真实横线。
 * 文本按空白与已识别出的 `_` 统一切分，因此既能补全全部丢失的下划线，
 * 也能在部分下划线已被正确识别时保留原有结果。只有像素证据成立时才把对应
 * 空白替换为 `_`，
 * 避免把普通英文短语误改成下划线。行盒无效、图像尺寸不匹配或
 * 空白区间数量与文本分隔符数量不一致时，保守返回原文。
 * @param text 单行 OCR 文本。
 * @param box 该行在图像中的包围盒。
 * @param image 原始图片解码后的 RGBA 图像。
 * @returns 恢复下划线后的文本行。
 * @author zhenghq
 */
export function restorePaddleOcrUnderlines(
  text: string,
  box: OcrBoundingBox | undefined,
  image: RgbaImage
): string {
  const original = String(text ?? '')
  if (!original || !/\s/u.test(original)) return original
  if (!image || image.width <= 0 || image.height <= 0) return original

  const range = clampBoxToImage(box, image)
  if (!range) return original

  // 按空白与已识别的下划线统一切分文本，保留分隔符以便原位替换。
  const parts = original.trim().split(/([\s_]+)/u)
  const words = parts.filter((_, index) => index % 2 === 0)
  const separators = parts.filter((_, index) => index % 2 === 1)
  if (words.length < 2 || separators.length !== words.length - 1) return original

  const backgroundLuma = estimateBackgroundLuma(image, range.left, range.top, range.right, range.bottom)

  // 先识别与字形主体分离的底部薄墨迹带（下划线带）。存在时，列墨迹高度只统计
  // 该带上方，避免薄的 `_` 抬高下划线列的墨迹高度而被误判成字形列。
  // 行盒未覆盖下划线时再向下兜底搜索，但要求搜到的墨迹带下方仍有空白，
  // 否则该墨迹带很可能是下一行的字形，而非本行下划线。
  let underlineBand = findUnderlineBand(image, range, backgroundLuma)
  if (!underlineBand) {
    const extendedBottom = Math.min(
      image.height - 1,
      range.bottom + Math.ceil(range.height * UNDERLINE_BAND_SEARCH_BOTTOM_RATIO)
    )
    if (extendedBottom > range.bottom) {
      const extendedBand = findUnderlineBand(
        image,
        { ...range, bottom: extendedBottom },
        backgroundLuma
      )
      if (extendedBand && extendedBand.bottom < extendedBottom) underlineBand = extendedBand
    }
  }
  const countsBottom = underlineBand ? underlineBand.top - 1 : range.bottom
  const counts = columnInkCounts(
    image,
    range.left,
    range.right,
    range.top,
    countsBottom,
    backgroundLuma
  )
  const maxInk = counts.reduce((max, value) => Math.max(max, value), 0)
  if (maxInk <= 0) return original
  const inkThreshold = Math.max(2, Math.ceil(maxInk * INK_COLUMN_THRESHOLD_RATIO))

  // 行盒左右两侧常常包含页边空白，它们并不是词与词之间的分隔符。
  // 先定位首末字形墨迹列，再只保留其内部的间隙，避免把页边空白误当成词边界。
  let firstGlyph = -1
  let lastGlyph = -1
  for (let index = 0; index < counts.length; index += 1) {
    if (counts[index]! >= inkThreshold) {
      if (firstGlyph < 0) firstGlyph = index
      lastGlyph = index
    }
  }
  if (firstGlyph < 0 || lastGlyph <= firstGlyph) return original
  const glyphLeft = range.left + firstGlyph
  const glyphRight = range.left + lastGlyph

  // 一个字符格的平均横向宽度，用于估算下划线应有的墨迹长度。
  // 下划线在 OCR 结果中已变成空白，因此按非空白字符数估计格数更贴近实际。
  const charCount = Math.max(1, original.replace(/\s/gu, '').length)
  const charCellWidth = (glyphRight - glyphLeft + 1) / charCount

  const gaps = extractBlankGaps(counts, range.left, inkThreshold).filter(
    (gap) => gap.start > glyphLeft && gap.end < glyphRight
  )

  const scanTop = underlineBand
    ? underlineBand.top
    : Math.max(0, Math.min(
      image.height - 1,
      Math.floor(range.top + range.height * UNDERLINE_SCAN_TOP_RATIO)
    ))
  const scanBottom = underlineBand
    ? underlineBand.bottom
    : Math.max(scanTop, Math.min(
      image.height - 1,
      Math.ceil(range.bottom + range.height * UNDERLINE_SCAN_BOTTOM_RATIO)
    ))

  // 连字符、部分标点会在字形带内形成较宽间隙，但它们自身带有笔画墨迹，
  // 并非词边界，需要先剔除，避免与文本分隔符对不齐。
  const wordCandidateGaps = gaps.filter(
    (gap) => !isGlyphFilledGap(image, gap, range.top, scanTop, backgroundLuma)
  )

  // 文本字符数并不等于墨迹列数，无法把每个分隔符可靠地映射到唯一间隙。
  // 因此改为在全部候选间隙中寻找能由底部横线串联起来的分隔符组合：
  // 下划线的横线会跨越相邻字形下沿，形成较长的连续游程，而普通空格中
  // 只有零星下降笔画。按从左到右的顺序枚举即可同时支持纯下划线和混合文本。
  const underlineGaps = wordCandidateGaps.filter((gap) => {
    // 下划线间隙通常至少接近一个字符宽；过窄的间隙往往是字形内部空隙，
    // 其中的下降笔画容易形成连续游程，必须先排除。
    if (gap.width < Math.max(3, range.height * 0.25)) return false
    const run = longestUnderlineRun(image, gap, scanTop, scanBottom, backgroundLuma)
    // 下划线只占一个字符格：间隙未合并空格时按间隙宽度取比例保持保守；
    // 间隙合并了相邻真实空格时，以字符格宽度为上限，避免短下划线被误判为空格。
    const referenceWidth = Math.min(gap.width, charCellWidth)
    return run >= Math.max(2, Math.ceil(referenceWidth * UNDERLINE_COVERAGE_RATIO))
  })
  if (underlineGaps.length === 0) return original

  // 用已确认的下划线间隙作为锚点，按它们在行内的相对位置分配到各分隔符。
  // 当数量一致时一一对应；数量不一致时按归一化中心位置就近分配，未被分配到的
  // 分隔符保留原空白，避免把真实空格误替换。
  const textLength = original.trim().length
  const separatorCenters: number[] = []
  let cursor = 0
  for (let index = 0; index < words.length; index += 1) {
    cursor += words[index]!.length
    const separator = separators[index]
    if (separator === undefined) break
    separatorCenters.push((cursor + separator.length / 2) / textLength)
    cursor += separator.length
  }
  const lineSpan = Math.max(1, glyphRight - glyphLeft)
  const assignments = new Array<boolean>(separators.length).fill(false)
  const anchorCenters = underlineGaps
    .map((gap) => ((gap.start + gap.end) / 2 - glyphLeft) / lineSpan)
    .sort((a, b) => a - b)
  // 文本字符位置与像素位置会因字形宽度不同而有偏差，允许的最大归一化偏移
  // 取行高的相对值与行宽的固定比例中的较大者，既覆盖大字号也避免跨词误配。
  const tolerance = Math.max(range.height / lineSpan, 0.035)
  let anchorIndex = 0
  for (let separatorIndex = 0; separatorIndex < separators.length; separatorIndex += 1) {
    const separatorCenter = separatorCenters[separatorIndex]!
    // OCR 有时会多出伪间隙或把两处下划线合并，先跳过明显位于分隔符左侧的锚点。
    while (
      anchorIndex < anchorCenters.length &&
      anchorCenters[anchorIndex]! < separatorCenter - tolerance
    ) {
      anchorIndex += 1
    }
    if (anchorIndex >= anchorCenters.length) break
    if (Math.abs(anchorCenters[anchorIndex]! - separatorCenter) <= tolerance) {
      assignments[separatorIndex] = true
      anchorIndex += 1
    }
  }

  let changed = false
  const merged: string[] = []
  for (let index = 0; index < words.length; index += 1) {
    merged.push(words[index]!)
    const separator = separators[index]
    if (separator === undefined) break
    if (assignments[index] || separator.includes('_')) {
      merged.push('_')
      if (!separator.includes('_')) changed = true
    } else {
      merged.push(separator)
    }
  }
  return changed ? merged.join('') : original
}
