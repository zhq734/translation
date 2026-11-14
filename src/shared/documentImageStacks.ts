import type {
  DocumentBoundingBox,
  DocumentBlock,
  DocumentImageBlock,
  DocumentTextBlock
} from './documentTypes.ts'

/** 图片边界交集占较小图片面积的最低比例；低于该值视为普通相邻图片。 */
export const DOCUMENT_IMAGE_STACK_MIN_OVERLAP_RATIO = 0.3

/** 文档图片叠放组；历史快照可能没有显式 stackGroupId，此时由几何重叠推断。 */
export interface DocumentImageStackGroup {
  /** 解析阶段写入的显式叠放组标识；历史快照的几何组没有该标识。 */
  stackGroupId?: string
  /** 按原始绘制顺序或 stackOrder 排列的图片区块。 */
  blocks: DocumentImageBlock[]
}

/**
 * 计算两个图片边界的交集面积占较小图片面积的比例。
 * @param left 左侧图片边界。
 * @param right 右侧图片边界。
 * @returns 0 到 1 的重叠比例；任一边界无有效面积时返回 0。
 * @author zhenghq
 */
export function resolveDocumentImageOverlapRatio(
  left: DocumentBoundingBox,
  right: DocumentBoundingBox
): number {
  const overlapWidth = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  )
  const overlapHeight = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  )
  const smallerArea = Math.min(left.width * left.height, right.width * right.height)
  return smallerArea > 0 ? overlapWidth * overlapHeight / smallerArea : 0
}

/**
 * 解析同一页面或单元格中的图片叠放组。
 * 显式 stackGroupId 优先；历史快照没有该字段时，再按显著几何重叠和传递关系兜底，
 * 使旧的译文快照无需重新解析也能恢复叠图关系。
 * @param blocks 同一容器内的区块，数组顺序保持原始绘制顺序。
 * @returns 至少包含两张图片的叠放组，按各组第一张图片的原始顺序返回。
 * @author zhenghq
 */
export function resolveDocumentImageStackGroups(
  blocks: readonly DocumentBlock[]
): DocumentImageStackGroup[] {
  const candidates = blocks.flatMap((block, sourceIndex) =>
    block.kind === 'image' ? [{ block, sourceIndex }] : [])
  const explicitGroups = new Map<string, typeof candidates>()
  const ungrouped: typeof candidates = []
  for (const candidate of candidates) {
    const stackGroupId = candidate.block.stackGroupId
    if (!stackGroupId) {
      ungrouped.push(candidate)
      continue
    }
    const group = explicitGroups.get(stackGroupId) ?? []
    group.push(candidate)
    explicitGroups.set(stackGroupId, group)
  }

  const groups: Array<DocumentImageStackGroup & { firstIndex: number }> = []
  for (const [stackGroupId, members] of explicitGroups) {
    if (members.length < 2) continue
    const ordered = [...members].sort(compareImageStackCandidates)
    groups.push({
      stackGroupId,
      blocks: ordered.map((candidate) => candidate.block),
      firstIndex: Math.min(...members.map((candidate) => candidate.sourceIndex))
    })
  }

  const parents = ungrouped.map((_, index) => index)
  /** 查找并压缩并查集根节点。 */
  const findRoot = (index: number): number => {
    let root = index
    while (parents[root] !== root) root = parents[root]!
    let current = index
    while (parents[current] !== current) {
      const next = parents[current]!
      parents[current] = root
      current = next
    }
    return root
  }
  /** 合并两个显著重叠的候选图片。 */
  const union = (left: number, right: number): void => {
    const leftRoot = findRoot(left)
    const rightRoot = findRoot(right)
    if (leftRoot !== rightRoot) parents[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot)
  }
  for (let left = 0; left < ungrouped.length; left += 1) {
    for (let right = left + 1; right < ungrouped.length; right += 1) {
      const leftBbox = ungrouped[left]!.block.bbox
      const rightBbox = ungrouped[right]!.block.bbox
      if (!leftBbox || !rightBbox) continue
      if (resolveDocumentImageOverlapRatio(leftBbox, rightBbox) <
        DOCUMENT_IMAGE_STACK_MIN_OVERLAP_RATIO) continue
      union(left, right)
    }
  }
  const geometricGroups = new Map<number, typeof ungrouped>()
  ungrouped.forEach((candidate, index) => {
    const root = findRoot(index)
    const group = geometricGroups.get(root) ?? []
    group.push(candidate)
    geometricGroups.set(root, group)
  })
  for (const members of geometricGroups.values()) {
    if (members.length < 2) continue
    const ordered = [...members].sort(compareImageStackCandidates)
    groups.push({
      blocks: ordered.map((candidate) => candidate.block),
      firstIndex: Math.min(...members.map((candidate) => candidate.sourceIndex))
    })
  }

  return groups
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .map(({ firstIndex: _firstIndex, ...group }) => group)
}

/**
 * 判断文本边界是否完全落在图片叠放组的并集边界内。
 * @param text 文本边界。
 * @param bounds 图片叠放组并集边界。
 * @returns 文本完全位于边界内时返回 true；边界缺失或无效时返回 false。
 * @author zhenghq
 */
function isTextInsideImageStackBounds(
  text: DocumentBoundingBox | undefined,
  bounds: DocumentBoundingBox | undefined
): boolean {
  if (!text || !bounds || text.width <= 0 || text.height <= 0 ||
    bounds.width <= 0 || bounds.height <= 0) return false
  // PDF 坐标经过多次换算后可能带有极小浮点误差，边界比较保留亚像素容差。
  const tolerance = 0.01
  return text.x >= bounds.x - tolerance &&
    text.y >= bounds.y - tolerance &&
    text.x + text.width <= bounds.x + bounds.width + tolerance &&
    text.y + text.height <= bounds.y + bounds.height + tolerance
}

/**
 * 找出完全位于图片叠放组并集范围内、需要随底图一起原位覆盖的文本区块。
 * 这些文本通常已包含在图片像素中；若继续走普通流会重复出现并把后续内容下推。
 * @param blocks 同一单元格内的全部区块，数组顺序保持原始阅读顺序。
 * @param images 当前图片叠放组的成员。
 * @returns 按原始数组顺序排列的范围内文本区块。
 * @author zhenghq
 */
export function resolveDocumentImageStackContainedTexts(
  blocks: readonly DocumentBlock[],
  images: readonly DocumentImageBlock[]
): DocumentTextBlock[] {
  if (images.length === 0) return []
  const imageBounds = images
    .map((block) => block.bbox)
    .filter((bbox): bbox is DocumentBoundingBox => bbox !== undefined)
  if (imageBounds.length === 0) return []
  const left = Math.min(...imageBounds.map((bbox) => bbox.x))
  const top = Math.min(...imageBounds.map((bbox) => bbox.y))
  const right = Math.max(...imageBounds.map((bbox) => bbox.x + bbox.width))
  const bottom = Math.max(...imageBounds.map((bbox) => bbox.y + bbox.height))
  const bounds = {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  }
  return blocks.filter((block): block is DocumentTextBlock =>
    block.kind === 'text' && isTextInsideImageStackBounds(block.bbox, bounds))
}

/**
 * 按显式叠放顺序排列图片候选；没有显式顺序时保持 PDF 原始绘制顺序。
 * @param left 左侧候选图片。
 * @param right 右侧候选图片。
 * @returns 供 Array.sort 使用的稳定比较结果。
 * @author zhenghq
 */
function compareImageStackCandidates(
  left: { block: DocumentImageBlock; sourceIndex: number },
  right: { block: DocumentImageBlock; sourceIndex: number }
): number {
  const leftOrder = left.block.stackOrder ?? left.sourceIndex
  const rightOrder = right.block.stackOrder ?? right.sourceIndex
  return leftOrder - rightOrder || left.sourceIndex - right.sourceIndex
}
