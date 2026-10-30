import type {
  DocumentBlock,
  DocumentModel,
  DocumentOcrRegion,
  DocumentPage,
  DocumentTableBlock,
  DocumentTableRow,
  DocumentTextBlock
} from './documentTypes.ts'

/** 文本目标在页面区块树中的定位路径；表格描述符定位到单元格后继续使用区块索引。 */
export type DocumentBlockPath = Array<number | { row: number; cell: number }>

/** 完成报告目标类型。 */
export type DocumentTargetKind = 'text' | 'ocr' | 'row'

/** 解析后的完成报告目标标识。 */
export interface ParsedDocumentTargetId {
  /** 目标所属页面索引。 */
  pageIndex: number
  /** 页面区块树中的定位路径。 */
  blockPath: DocumentBlockPath
  /** 目标类型。 */
  kind: DocumentTargetKind
  /** run、表格行或 OCR 区域的稳定标识。 */
  identifier: string
}

/** 在文档模型中定位到的目标。 */
export interface LocatedDocumentTarget {
  /** 目标所属页面。 */
  page: DocumentPage
  /** 目标最终定位到的区块；表格行目标定位到表格区块。 */
  block: DocumentBlock
  /** 目标类型。 */
  kind: DocumentTargetKind
  /** 文本目标的 run 标识。 */
  runId?: string
  /** 表格行目标的行标识。 */
  rowId?: string
  /** OCR 目标所属的表格行。 */
  row?: DocumentTableRow
  /** OCR 目标区域。 */
  region?: DocumentOcrRegion
  /** OCR 区域标识。 */
  regionId?: string
  /** 目标是否位于表格单元格等嵌套区块中。 */
  isNested: boolean
}

/**
 * 将区块路径序列化为稳定、可读且不碰撞的字符串键。
 * @param path 区块路径。
 * @returns 可安全用作 targetId 与映射键的字符串。
 * @author zhenghq
 */
export function serializeDocumentBlockPath(path: readonly DocumentBlockPath[number][]): string {
  return path.map((segment) =>
    typeof segment === 'number' ? String(segment) : `r${segment.row}c${segment.cell}`
  ).join('.')
}

/**
 * 解析完成报告中的稳定目标标识。
 * @param targetId 格式为 `pageIndex:blockPath:kind:identifier` 的目标标识。
 * @returns 解析结果；格式或数值非法时返回 null。
 * @author zhenghq
 */
export function parseDocumentTargetId(targetId: string): ParsedDocumentTargetId | null {
  const match = /^(\d+):([^:]+):(text|ocr|row):(.+)$/u.exec(targetId)
  if (!match) return null
  const pageIndex = Number(match[1])
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) return null
  const pathSegments = match[2]!.split('.')
  const blockPath: DocumentBlockPath = []
  for (const [segmentIndex, segment] of pathSegments.entries()) {
    if (/^\d+$/u.test(segment)) {
      const index = Number(segment)
      if (!Number.isSafeInteger(index) || index < 0) return null
      blockPath.push(index)
      continue
    }
    // 单元格描述符只能出现在表格区块索引之后，不能作为页面根路径。
    if (segmentIndex === 0) return null
    const cell = /^r(\d+)c(\d+)$/u.exec(segment)
    if (!cell) return null
    const row = Number(cell[1])
    const column = Number(cell[2])
    if (!Number.isSafeInteger(row) || row < 0 ||
      !Number.isSafeInteger(column) || column < 0) {
      return null
    }
    blockPath.push({ row, cell: column })
  }
  if (blockPath.length === 0) return null
  return {
    pageIndex,
    blockPath,
    kind: match[3] as DocumentTargetKind,
    identifier: match[4]!
  }
}

/**
 * 沿稳定路径解析区块树中的目标区块。
 * @param blocks 当前层区块列表。
 * @param path 待解析路径。
 * @returns 定位到的区块与是否进入过表格单元格；路径非法时返回 null。
 * @author zhenghq
 */
function resolvePath(
  blocks: readonly DocumentBlock[],
  path: readonly DocumentBlockPath[number][]
): { block: DocumentBlock; isNested: boolean } | null {
  let currentBlocks: readonly DocumentBlock[] = blocks
  let current: DocumentBlock | undefined
  let isNested = false
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Number.isSafeInteger(segment) || segment < 0) return null
      current = currentBlocks[segment]
      if (!current) return null
      continue
    }
    if (!current || current.kind !== 'table') return null
    const row = current.rows[segment.row]
    const cell = row?.cells[segment.cell]
    if (!row || !cell) return null
    currentBlocks = cell.blocks
    current = undefined
    isNested = true
  }
  return current ? { block: current, isNested } : null
}

/**
 * 根据稳定目标标识在文档模型中定位页面、区块、run、表格行或 OCR 区域。
 * @param model 当前文档模型。
 * @param targetId 完成报告中的稳定目标标识。
 * @returns 定位结果；目标不存在、越界或类型不匹配时返回 null。
 * @author zhenghq
 */
export function findDocumentTarget(
  model: DocumentModel,
  targetId: string
): LocatedDocumentTarget | null {
  const parsed = parseDocumentTargetId(targetId)
  if (!parsed) return null
  const page = model.pages[parsed.pageIndex]
  if (!page) return null
  const resolved = resolvePath(page.blocks, parsed.blockPath)
  if (!resolved) return null
  const { block, isNested } = resolved

  if (parsed.kind === 'text') {
    if (block.kind !== 'text' || !(block as DocumentTextBlock).runs.some(
      (run) => run.runId === parsed.identifier
    )) {
      return null
    }
    return {
      page,
      block,
      kind: 'text',
      runId: parsed.identifier,
      isNested
    }
  }

  if (parsed.kind === 'row') {
    if (block.kind !== 'table') return null
    const row = (block as DocumentTableBlock).rows.find((candidate) => candidate.rowId === parsed.identifier)
    if (!row) return null
    return {
      page,
      block,
      kind: 'row',
      rowId: parsed.identifier,
      row,
      isNested
    }
  }

  if (block.kind !== 'image') return null
  const region = (block.ocrRegions ?? []).find((candidate) => candidate.regionId === parsed.identifier)
  if (!region || region.blockId !== block.blockId) return null
  return {
    page,
    block,
    kind: 'ocr',
    region,
    regionId: parsed.identifier,
    isNested
  }
}
