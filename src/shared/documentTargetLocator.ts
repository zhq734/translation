import type {
  DocumentBlock,
  DocumentModel,
  DocumentOcrRegion,
  DocumentPage,
  DocumentTableBlock,
  DocumentTableRow,
  DocumentTextBlock,
  DocumentTextStyle
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

/** 译文 DOM 元素携带的定位标识。 */
export interface DocumentElementTargetLocator {
  /** 元素所属页面标识。 */
  pageId: string
  /** 元素所属稳定区块标识。 */
  blockId: string
  /** 文本 run 标识。 */
  runId?: string
  /** 表格行标识。 */
  rowId?: string
  /** OCR 区域标识。 */
  regionId?: string
}

/** 在页面区块树中递归定位区块时保留的路径与表格行上下文。 */
interface ResolvedElementBlock {
  /** 区块在页面中的稳定路径。 */
  path: DocumentBlockPath
  /** 命中的区块。 */
  block: DocumentBlock
  /** 表格单元格正文所属的行；顶层区块为空。 */
  tableRow?: {
    /** 表格区块稳定路径。 */
    tablePath: DocumentBlockPath
    /** 表格行标识。 */
    rowId: string
  }
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
 * 比较两个文本 run 的有效样式是否可直接归并翻译。
 * @param left 前一个 run 样式。
 * @param right 后一个 run 样式。
 * @returns 样式字段完全一致时返回 true。
 * @author zhenghq
 */
function sameDocumentElementTextStyle(
  left: DocumentTextStyle | undefined,
  right: DocumentTextStyle | undefined
): boolean {
  if (!left || !right) return left === right
  const keys: Array<keyof DocumentTextStyle> = [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'color',
    'backgroundColor',
    'italic',
    'underline',
    'strikethrough',
    'letterSpacing',
    'lineHeight'
  ]
  return keys.every((key) => left[key] === right[key])
}

/**
 * 判断文本 run 是否参与流水线翻译；受保护或纯空白 run 会切断目标区间。
 * @param run 待判断的文本 run。
 * @returns 可参与翻译时返回 true。
 * @author zhenghq
 */
function isTranslatableTextRun(run: DocumentTextBlock['runs'][number]): boolean {
  return run.protected !== true && Boolean(run.text.trim())
}

/**
 * 找到指定 run 在流水线中实际归属的翻译区间首 run。
 * @param block 文本区块。
 * @param runId DOM 中命中的 run 标识。
 * @returns 区间首 run 标识；该 run 不参与翻译时返回 null。
 * @author zhenghq
 */
function resolveTranslatedRunId(block: DocumentTextBlock, runId: string): string | null {
  let currentRunId: string | null = null
  let currentStyle: DocumentTextStyle | undefined
  for (const run of block.runs) {
    if (!isTranslatableTextRun(run)) {
      currentRunId = null
      currentStyle = undefined
      continue
    }
    if (currentRunId && !sameDocumentElementTextStyle(currentStyle, run.style)) {
      currentRunId = null
      currentStyle = undefined
    }
    if (!currentRunId) {
      currentRunId = run.runId
      currentStyle = run.style
    }
    if (run.runId === runId) return currentRunId
  }
  return null
}

/**
 * 递归定位页面内的稳定区块并保留表格行上下文。
 * @param blocks 当前层级区块。
 * @param blockId 目标区块标识。
 * @param path 当前层级路径。
 * @param tableRow 所属表格行上下文。
 * @returns 命中结果；不存在时返回 null。
 * @author zhenghq
 */
function findElementBlock(
  blocks: readonly DocumentBlock[],
  blockId: string,
  path: DocumentBlockPath = [],
  tableRow?: ResolvedElementBlock['tableRow']
): ResolvedElementBlock | null {
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex]!
    const blockPath = [...path, blockIndex]
    if (block.blockId === blockId) return { path: blockPath, block, ...(tableRow ? { tableRow } : {}) }
    if (block.kind !== 'table') continue
    for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
      const row = block.rows[rowIndex]!
      for (let cellIndex = 0; cellIndex < row.cells.length; cellIndex += 1) {
        const nested = findElementBlock(
          row.cells[cellIndex]!.blocks,
          blockId,
          [...blockPath, { row: rowIndex, cell: cellIndex }],
          { tablePath: blockPath, rowId: row.rowId }
        )
        if (nested) return nested
      }
    }
  }
  return null
}

/**
 * 将译文 DOM 元素标识解析为翻译流水线使用的稳定目标标识。
 * 表格单元格正文与顶层正文使用同一套 run 目标；只有显式请求整行时才返回表格行目标。
 * @param model 当前文档模型。
 * @param input 页面、区块以及可选的 run、表格行或 OCR 区域标识。
 * @returns 可由单目标重试或重译接口消费的 targetId；结构不匹配时返回 null。
 * @author zhenghq
 */
export function resolveDocumentElementTargetId(
  model: DocumentModel,
  input: DocumentElementTargetLocator
): string | null {
  const pageIndex = model.pages.findIndex((page) => page.pageId === input.pageId)
  if (pageIndex < 0) return null
  const page = model.pages[pageIndex]!
  const resolved = findElementBlock(page.blocks, input.blockId)
  if (!resolved) return null
  const { block, path } = resolved

  if (input.regionId !== undefined) {
    if (block.kind !== 'image') return null
    const region = block.ocrRegions?.find((candidate) => candidate.regionId === input.regionId)
    return region ? `${pageIndex}:${serializeDocumentBlockPath(path)}:ocr:${region.regionId}` : null
  }

  if (input.runId !== undefined && block.kind === 'text') {
    const translatedRunId = resolveTranslatedRunId(block, input.runId)
    if (!translatedRunId) return null
    return `${pageIndex}:${serializeDocumentBlockPath(path)}:text:${translatedRunId}`
  }

  if (input.rowId !== undefined) {
    if (block.kind !== 'table') return null
    const row = block.rows.find((candidate) => candidate.rowId === input.rowId)
    return row ? `${pageIndex}:${serializeDocumentBlockPath(path)}:row:${row.rowId}` : null
  }

  return null
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
