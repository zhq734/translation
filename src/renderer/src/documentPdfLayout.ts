import type { DocumentBlock, DocumentContentArea } from '../../shared/documentTypes'

/** 译文水印横向留白校准的基准容器宽度，单位为 CSS 像素。 */
export const TRANSLATION_WATERMARK_REFERENCE_WIDTH = 1000

/** 同行分组横向排版参数。 */
export interface DocumentFlowGroupGeometry {
  /** 分组相对页面左边缘的起点。 */
  left: number
  /** 分组可用宽度。 */
  width: number
  /** 分组覆盖的原始纵向高度。 */
  height: number
  /** 图片与文字之间需要保留的原始横向间距。 */
  textGap: number
  /** 组内文字相对分组顶部的原始纵向偏移。 */
  textTop: number
}

/** 译文普通流中可供绝对定位装饰线锚定的原始与实际纵向范围。 */
export interface DocumentFlowDecorationAnchor {
  /** 锚点区块在原始 PDF 页面中的顶部坐标。 */
  sourceTop: number
  /** 锚点区块在原始 PDF 页面中的底部坐标。 */
  sourceBottom: number
  /** 锚点区块在当前 DOM 中的实际顶部坐标。 */
  actualTop: number
  /** 锚点区块在当前 DOM 中的实际底部坐标。 */
  actualBottom: number
}

/** 译文普通流中的横向范围，坐标相对当前页面内容盒。 */
export interface DocumentFlowHorizontalRange {
  /** 范围左边界。 */
  left: number
  /** 范围右边界。 */
  right: number
}

/** 已排版流式区块的二维占位范围，用于判断图片能否回填原文锚点。 */
export interface DocumentFlowObstacle extends DocumentFlowHorizontalRange {
  /** 区块在页面内容盒中的实际顶部坐标。 */
  top: number
  /** 区块在页面内容盒中的实际底部坐标。 */
  bottom: number
}

/** 同一原文行中首个图片覆盖组的原始锚点与实际落位。 */
export interface DocumentTranslationImageFlowRow {
  /** 首个覆盖组按原文坐标换算后的目标顶部位置。 */
  sourceTop: number
  /** 首个覆盖组经过前序内容避让后的实际顶部位置，必须与锚点、前序底边和障碍物使用同一坐标系。 */
  actualTop: number
}

/** 计算图片段前间距所需的二维排版信息。 */
export interface DocumentTranslationImageFlowGapInput {
  /** 图片按原文坐标换算后的目标顶部位置。 */
  anchoredTop: number
  /** 当前普通流已到达的实际底部位置。 */
  previousBottom: number
  /** 当前图片未应用自身段前距离时的自然顶部；省略时回退到 previousBottom。 */
  baseTop?: number
  /** 页面内容盒的顶部位置。 */
  flowOrigin: number
  /** 图片相对页面内容盒的横向范围。 */
  imageRange: DocumentFlowHorizontalRange
  /** 图片相对页面内容盒的原始高度。 */
  imageHeight: number
  /** 紧邻前序图片覆盖组的同行锚点；不属于同一原文行时省略。 */
  alignedImageRow?: DocumentTranslationImageFlowRow
  /** 阅读顺序中此前已排版且占用普通流的区块范围。 */
  obstacles: readonly DocumentFlowObstacle[]
}

/** 计算普通流式区块段前间距所需的二维排版信息。 */
export interface DocumentTranslationFlowBlockGapInput {
  /** 当前区块相对前序内容的原始段前距离。 */
  sourceGap: number
  /** 当前区块在未应用自身段前间距时的自然顶部坐标。 */
  baseTop: number
  /** 当前区块的实际高度。 */
  blockHeight: number
  /** 页面内容盒的顶部位置。 */
  flowOrigin: number
  /** 当前区块相对页面内容盒的横向范围。 */
  blockRange: DocumentFlowHorizontalRange
  /** 阅读顺序中此前已排版且占用普通流的区块范围。 */
  obstacles: readonly DocumentFlowObstacle[]
}

/** 译文窄表列宽可读性阈值，单位为原始 PDF 点。 */
export const DOCUMENT_TABLE_MIN_READABLE_COLUMN_WIDTH = 36

/**
 * 在保持表格总宽的前提下为过窄列重新分配列宽。
 * PDF 的合并单元格常被识别成 20pt 左右的首列，逐字竖排会严重破坏译文；
 * 这里只提升低于可读阈值的列，并从同表宽列按比例回收空间。
 * @param columnWidths 原始列宽。
 * @param tableWidth 表格总宽度；缺失或非法时保留原始列宽。
 * @returns 总和不超过表格总宽的新列宽。
 * @author zhenghq
 */
export function resolveTranslationTableColumnWidths(
  columnWidths: readonly number[],
  tableWidth: number | undefined
): number[] {
  const widths = columnWidths.map((value) => Number.isFinite(value) && value > 0 ? value : 0)
  const total = widths.reduce((sum, width) => sum + width, 0)
  if (total <= 0 || !tableWidth || !Number.isFinite(tableWidth) || tableWidth <= 0) {
    return widths
  }
  const normalized = widths.map((width) => width / total * tableWidth)
  const narrowIndexes = normalized
    .map((width, index) => ({ width, index }))
    .filter(({ width }) => width > 0 && width < DOCUMENT_TABLE_MIN_READABLE_COLUMN_WIDTH)
    .map(({ index }) => index)
  if (narrowIndexes.length === 0) return normalized
  const requiredExtra = narrowIndexes.reduce((sum, index) =>
    sum + DOCUMENT_TABLE_MIN_READABLE_COLUMN_WIDTH - normalized[index]!, 0)
  const donorIndexes = normalized
    .map((width, index) => ({ width, index }))
    .filter(({ width, index }) => width > DOCUMENT_TABLE_MIN_READABLE_COLUMN_WIDTH && !narrowIndexes.includes(index))
    .map(({ index }) => index)
  const donorCapacity = donorIndexes.reduce((sum, index) =>
    sum + normalized[index]! - DOCUMENT_TABLE_MIN_READABLE_COLUMN_WIDTH, 0)
  if (donorIndexes.length === 0 || donorCapacity <= 0) return normalized
  const distributable = Math.min(requiredExtra, donorCapacity)
  const result = [...normalized]
  // 窄列先按缺口比例获得空间；若宽列容量不足，所有窄列同比缩小增益，总宽仍保持不变。
  for (const index of narrowIndexes) {
    const deficit = DOCUMENT_TABLE_MIN_READABLE_COLUMN_WIDTH - normalized[index]!
    result[index] = normalized[index]! + distributable * deficit / requiredExtra
  }
  const donorTotal = donorIndexes.reduce((sum, index) => sum + normalized[index]!, 0)
  for (const index of donorIndexes) {
    result[index] = normalized[index]! - distributable * normalized[index]! / donorTotal
  }
  return result
}

/**
 * 归一化表格列宽，防止解析误差导致列宽总和超过表格边界。
 * @param columnWidths 原始列宽。
 * @param tableWidth 表格边界宽度；缺失时保留原始比例。
 * @returns 归一化后的列宽。
 * @author zhenghq
 */
export function normalizeDocumentTableColumnWidths(
  columnWidths: readonly number[],
  tableWidth: number | undefined
): number[] {
  const validWidths = columnWidths.map((value) => Number.isFinite(value) && value > 0 ? value : 0)
  const total = validWidths.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return Array.from({ length: columnWidths.length }, () => 1)
  if (!tableWidth || !Number.isFinite(tableWidth) || tableWidth <= 0) return validWidths
  return resolveTranslationTableColumnWidths(validWidths, tableWidth)
}

/**
 * 判断两个横向范围是否存在实际重叠。
 * 边界刚好相接视为不重叠，避免相邻列被误判为碰撞。
 * @param left 左侧范围。
 * @param right 右侧范围。
 * @returns 两个范围是否相交。
 * @author zhenghq
 */
export function rangesOverlapHorizontally(
  left: DocumentFlowHorizontalRange,
  right: DocumentFlowHorizontalRange
): boolean {
  return Math.min(left.right, right.right) > Math.max(left.left, right.left)
}

/**
 * 计算图片相对当前普通流底边需要追加的段前距离。
 * 前序内容只有与图片横向相交且纵向延伸到锚点下方时才构成障碍；没有碰撞时允许负间距，
 * 让图片回到原文锚点。存在碰撞时从实际底边继续下推，且不得把图片推到页面内容盒上方。
 * @param input 图片锚点、实际底边、页面起点与已排版障碍范围。
 * @returns 图片段前距离，可为负数。
 * @author zhenghq
 */
export function resolveTranslationImageFlowGap(
  input: DocumentTranslationImageFlowGapInput
): number {
  const {
    anchoredTop,
    previousBottom,
    baseTop,
    flowOrigin,
    imageRange,
    imageHeight,
    alignedImageRow,
    obstacles
  } = input
  if (!Number.isFinite(anchoredTop) || !Number.isFinite(previousBottom)) return 0
  const safeFlowOrigin = Number.isFinite(flowOrigin) ? flowOrigin : anchoredTop
  // previousBottom 是整行高水位，而 CSS 负边距必须相对当前元素的自然顶部计算；
  // 同行前序覆盖组变矮后，两者会不同，混用会把后续覆盖组拉得过高或过低。
  const safeBaseTop = Number.isFinite(baseTop) ? baseTop! : previousBottom
  const safeImageHeight = Number.isFinite(imageHeight) && imageHeight > 0 ? imageHeight : 0
  const safeRange = {
    left: Number.isFinite(imageRange.left) ? imageRange.left : 0,
    right: Number.isFinite(imageRange.right) ? imageRange.right : 0
  }
  const alignsWithImageRow = alignedImageRow !== undefined &&
    Number.isFinite(alignedImageRow.sourceTop) &&
    Number.isFinite(alignedImageRow.actualTop) &&
    Math.abs(anchoredTop - alignedImageRow.sourceTop) <= 0.5
  // 同一原文行的覆盖组应回到首个组的实际顶部；首个组可能已为页眉等前序内容避让。
  const desiredTop = alignsWithImageRow
    ? Math.max(anchoredTop, alignedImageRow.actualTop)
    : anchoredTop
  const imageBottom = desiredTop + safeImageHeight
  const hasCollision = obstacles.some((obstacle) =>
    Number.isFinite(obstacle.top) &&
    Number.isFinite(obstacle.bottom) &&
    // 同一原文行的覆盖组共享顶部锚点，不能再次把当前组向下推。
    // previousBottom 是整行最高底边，较高覆盖组会让后续同顶组件的底边不再等于该高水位，
    // 因此这里按顶部锚点识别整行成员，而不能要求障碍物底边与 previousBottom 相等。
    !(alignsWithImageRow &&
      Math.abs(obstacle.top - alignedImageRow.actualTop) <= 0.5) &&
    obstacle.bottom > desiredTop &&
    obstacle.top < imageBottom &&
    // 图片与译文边界相接时也必须避让：字号行盒和抗锯齿可能越出测量边界，
    // 若按“严格横向相交”放行，窄图标会回填到前序增高内容内部并产生视觉重叠。
    obstacle.left <= safeRange.right &&
    obstacle.right >= safeRange.left
  )
  const gap = desiredTop - safeBaseTop
  // 横向错开时允许回填；但图片顶部仍不能越过页面内容起点。
  return hasCollision
    ? Math.max(0, Math.max(desiredTop, previousBottom) - safeBaseTop)
    : Math.max(safeFlowOrigin - safeBaseTop, gap)
}

/**
 * 计算普通流式区块需要追加的段前距离，避免后续内容回填到已下推图片或其他区块内部。
 * 只避让与当前区块横向相交的障碍；左右并排或双栏错开的内容仍按原文段距回填。
 * @param input 当前区块的自然位置、实际尺寸、横向范围与已排版障碍。
 * @returns 普通流式区块的段前距离，不会小于原始段距。
 * @author zhenghq
 */
export function resolveTranslationFlowBlockGap(
  input: DocumentTranslationFlowBlockGapInput
): number {
  const { sourceGap, baseTop, blockHeight, flowOrigin, blockRange, obstacles } = input
  const safeSourceGap = Number.isFinite(sourceGap) ? Math.max(0, sourceGap) : 0
  if (!Number.isFinite(baseTop)) return safeSourceGap
  const safeFlowOrigin = Number.isFinite(flowOrigin) ? flowOrigin : baseTop
  const safeBaseTop = Math.max(safeFlowOrigin, baseTop)
  const safeBlockHeight = Number.isFinite(blockHeight) ? Math.max(0, blockHeight) : 0
  const safeRange = {
    left: Number.isFinite(blockRange.left) ? blockRange.left : 0,
    right: Number.isFinite(blockRange.right) ? blockRange.right : 0
  }
  let gap = safeSourceGap
  // 下推后可能进入后续障碍，因此循环到当前横向范围内不再产生新的纵向碰撞为止。
  for (let attempt = 0; attempt <= obstacles.length; attempt += 1) {
    const candidateTop = safeBaseTop + gap
    const candidateBottom = candidateTop + safeBlockHeight
    let nextGap = gap
    for (const obstacle of obstacles) {
      if (
        !Number.isFinite(obstacle.top) ||
        !Number.isFinite(obstacle.bottom) ||
        !rangesOverlapHorizontally(safeRange, obstacle) ||
        candidateTop >= obstacle.bottom ||
        candidateBottom <= obstacle.top
      ) continue
      nextGap = Math.max(nextGap, obstacle.bottom + safeSourceGap - safeBaseTop)
    }
    if (nextGap <= gap + 0.01) break
    gap = nextGap
  }
  return gap
}

/**
 * 计算译文水印图案相对容器左边缘的横向偏移。
 * 320px 宽的斜向瓦片在旋转后存在固定视觉留白；容器越窄，向左平移越多，
 * 从而让一行保持约三个水印并让左右留白接近。容器达到 1000px 后不再平移。
 * @param containerWidth 水印容器当前宽度，单位为 CSS 像素。
 * @returns 应用于 SVG pattern x 属性的非正横向偏移。
 * @author zhenghq
 */
export function resolveTranslationWatermarkHorizontalOffset(containerWidth: number): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 0
  const width = containerWidth
  const offset = -Math.max(0, TRANSLATION_WATERMARK_REFERENCE_WIDTH - width) / 2
  // 宽度达到阈值时除法会产生 -0，统一归一化为 0，便于调用方和测试稳定比较。
  return offset === 0 ? 0 : offset
}

/**
 * 计算绝对定位装饰线应移动到的实际顶部坐标。
 * 装饰线跟随阅读顺序中最近的前序流式区块：与区块重叠时保留原始相对顶部偏移，
 * 位于区块下方时保留原始底边间距。这样表格或图片译文增高后，边框不会被留在旧位置。
 * @param shapeSourceTop 装饰线在原始 PDF 页面中的顶部坐标。
 * @param anchors 当前页面中此前已排版的流式锚点，按阅读顺序排列。
 * @param scale 当前译文页面相对原始 PDF 页面的缩放比例。
 * @returns 装饰线目标实际顶部坐标；没有前序锚点时返回 undefined。
 * @author zhenghq
 */
export function resolveTranslationFlowDecorationTop(
  shapeSourceTop: number,
  anchors: readonly DocumentFlowDecorationAnchor[],
  scale: number
): number | undefined {
  if (!Number.isFinite(shapeSourceTop) || anchors.length === 0) return undefined
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1
  const previousAnchors = anchors.filter((anchor) =>
    Number.isFinite(anchor.sourceTop) &&
    Number.isFinite(anchor.sourceBottom) &&
    Number.isFinite(anchor.actualTop) &&
    Number.isFinite(anchor.actualBottom) &&
    anchor.sourceTop <= shapeSourceTop
  )
  if (previousAnchors.length === 0) return undefined
  const anchor = previousAnchors.reduce((nearest, candidate) =>
    candidate.sourceTop > nearest.sourceTop ? candidate : nearest)
  if (shapeSourceTop <= anchor.sourceBottom) {
    return anchor.actualTop + (shapeSourceTop - anchor.sourceTop) * safeScale
  }
  return anchor.actualBottom + (shapeSourceTop - anchor.sourceBottom) * safeScale
}

/**
 * 判断 PDF 区块是否占用译文普通流高度。
 * 带方向的直线已按原文坐标绝对定位，只负责绘制装饰；若仍推进流式底边，会把页眉与正文错误下推。
 * @param block 当前文档区块。
 * @returns 是否需要在普通流中推进底边。
 * @author zhenghq
 */
export function occupiesDocumentTranslationFlow(block: DocumentBlock): boolean {
  return !(block.kind === 'shape' && block.line !== undefined)
}

/**
 * 查找与同行分组纵向重叠、且位于文字右侧的最近形状边界。
 * 页眉内框线通常只比文字宽约 1pt，而整页外框线可能同样与分组重叠；选择最近边界可避免文字被错误扩展到纸张边缘。
 * @param blocks 同组区块，按阅读顺序排列。
 * @param pageBlocks 当前页面的全部区块。
 * @param pageWidth 原始页面宽度。
 * @returns 可用的形状右边界；没有相邻右侧形状时返回 undefined。
 * @author zhenghq
 */
export function resolveOverlappingShapeRight(
  blocks: readonly DocumentBlock[],
  pageBlocks: readonly DocumentBlock[],
  pageWidth: number
): number | undefined {
  const groupBounds = blocks.filter((block) => block.bbox)
  if (groupBounds.length === 0) return undefined
  const top = Math.min(...groupBounds.map((block) => block.bbox!.y))
  const bottom = Math.max(...groupBounds.map((block) => block.bbox!.y + block.bbox!.height))
  const textRight = Math.max(...groupBounds.map((block) => block.bbox!.x + block.bbox!.width))
  const shapeRights = pageBlocks
    .filter((block) => block.kind === 'shape' && block.line?.orientation === 'vertical' && block.bbox)
    .filter((block) => {
      const bbox = block.bbox!
      const shapeBottom = bbox.y + bbox.height
      return bbox.x + bbox.width > textRight &&
        bbox.y < bottom &&
        shapeBottom > top
    })
    .map((block) => block.bbox!.x + block.bbox!.width)
    .filter((right) => right <= pageWidth)
  return shapeRights.length > 0 ? Math.min(...shapeRights) : undefined
}

/**
 * 计算同行图片与文字的横向锚点、可用宽度、原始间距和纵向偏移。
 * 优先使用相邻页眉内框线，其次使用正文区右边界；没有可用信息时保留组内文字原始右边界。
 * @param blocks 同组区块，按阅读顺序排列。
 * @param pageBlocks 当前页面的全部区块。
 * @param pageWidth 原始页面宽度。
 * @param contentArea 原文正文内容区。
 * @returns 分组相对页面的左边界、宽度、高度、图片后文字间距和文字顶部偏移。
 * @author zhenghq
 */
export function resolveTranslationFlowGroupGeometry(
  blocks: readonly DocumentBlock[],
  pageBlocks: readonly DocumentBlock[],
  pageWidth: number,
  contentArea?: DocumentContentArea
): DocumentFlowGroupGeometry {
  const groupBlocks = blocks.filter((block) => block.bbox)
  const first = groupBlocks[0]
  if (!first?.bbox) {
    return { left: 0, width: Math.max(1, pageWidth), height: 1, textGap: 0, textTop: 0 }
  }
  const left = Math.max(0, Math.min(pageWidth, first.bbox.x))
  const groupTextBlocks = groupBlocks.filter((block) => block.kind === 'text')
  const imageBlocks = groupBlocks.filter((block) => block.kind === 'image')
  const textRight = groupTextBlocks.length > 0
    ? Math.max(...groupTextBlocks.map((block) => block.bbox!.x + block.bbox!.width))
    : left
  const overlappingShapeRight = resolveOverlappingShapeRight(groupBlocks, pageBlocks, pageWidth)
  // 页眉内框线比推断出的正文区更贴近实际单元格；正文普通同行图片仍回退到正文区右边界。
  const right = Math.max(left, Math.min(
    pageWidth,
    overlappingShapeRight ?? contentArea?.right ?? textRight
  ))
  const top = Math.min(...groupBlocks.map((block) => block.bbox!.y))
  const bottom = Math.max(...groupBlocks.map((block) => block.bbox!.y + block.bbox!.height))
  const width = Math.max(1, right - left)
  const height = Math.max(1, bottom - top)
  const firstImage = imageBlocks[0]
  const firstText = groupTextBlocks[0]
  const textGap = firstImage?.bbox && firstText?.bbox
    ? Math.max(0, firstText.bbox.x - firstImage.bbox.x - firstImage.bbox.width)
    : 0
  const textTop = firstText?.bbox ? Math.max(0, firstText.bbox.y - top) : 0
  return { left, width, height, textGap, textTop }
}
