import type { DocumentCompletionReport } from './documentCompletion.ts'
import type {
  DocumentBlock,
  DocumentModel,
  DocumentTextBlock,
  DocumentTextRun,
  DocumentTextStyle
} from './documentTypes.ts'

/** 部分导出中的目标路径；表格单元格使用 row/cell 描述符继续定位嵌套区块。 */
type PartialExportBlockPath = Array<number | { row: number; cell: number }>

/** 部分导出目标类型。 */
type PartialExportTargetKind = 'text' | 'ocr' | 'table-row'

/** 从源模型重建的单个可翻译目标。 */
interface PartialExportTarget {
  /** 与流水线一致的目标标识。 */
  targetId: string
  /** 目标类型。 */
  kind: PartialExportTargetKind
  /** 页面索引。 */
  pageIndex: number
  /** 目标区块路径。 */
  path: PartialExportBlockPath
  /** 文本目标覆盖的 run 标识。 */
  runIds?: string[]
  /** OCR 区域索引。 */
  regionIndex?: number
  /** 表格行索引。 */
  rowIndex?: number
  /** 表格行内每个单元格覆盖的文本区块与 run 标识。 */
  cellRuns?: Array<{
    /** 单元格在行内的索引。 */
    cellIndex: number
    /** 单元格内的文本区块路径与 run 标识。 */
    blocks: Array<{ path: PartialExportBlockPath; runIds: string[] }>
  }>
}

/** 部分导出摘要，用于文件名、可见标记和调用方提示。 */
export interface DocumentPartialExportSummary {
  /** 全部可翻译目标数。 */
  total: number
  /** 成功使用译文的目标数。 */
  translated: number
  /** 原文已满足目标语言、无需翻译的目标数。 */
  unchanged: number
  /** 回退原文的目标总数。 */
  reverted: number
  /** 失败目标数。 */
  failed: number
  /** 未完成目标数。 */
  pending: number
  /** 疑似未翻译目标数。 */
  suspectUntranslated: number
}

/** 部分导出结果。 */
export interface DocumentPartialExportResult {
  /** 已按目标状态回退的译文模型副本。 */
  model: DocumentModel
  /** 导出摘要。 */
  summary: DocumentPartialExportSummary
}

/** 部分导出校验错误。 */
export class DocumentPartialExportError extends Error {
  /** 稳定错误分类。 */
  readonly code = 'completion-mismatch'

  /**
   * 创建部分导出校验错误。
   * @param reason 不含正文的内部原因。
   * @author zhenghq
   */
  constructor(reason: string) {
    super(`completion-mismatch: ${reason}`)
    this.name = 'DocumentPartialExportError'
  }
}

/**
 * 比较两个文本 run 样式是否可合并翻译。
 * @param left 前一个样式。
 * @param right 后一个样式。
 * @returns 样式完全一致时返回 true。
 * @author zhenghq
 */
function sameTextStyle(left: DocumentTextStyle | undefined, right: DocumentTextStyle | undefined): boolean {
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
 * 按与流水线一致的连续 run 规则收集文本目标。
 * @param block 文本区块。
 * @returns 每个目标覆盖的 run 标识；空文本或受保护 run 会切断区间。
 * @author zhenghq
 */
function collectTextRunGroups(block: DocumentTextBlock): string[][] {
  const groups: string[][] = []
  let current: DocumentTextRun[] = []
  for (const run of block.runs) {
    if (run.protected || !run.text.trim()) {
      if (current.length > 0) groups.push(current.map((item) => item.runId))
      current = []
      continue
    }
    if (current.length > 0 && !sameTextStyle(current[0]!.style, run.style)) {
      groups.push(current.map((item) => item.runId))
      current = []
    }
    current.push(run)
  }
  if (current.length > 0) groups.push(current.map((item) => item.runId))
  return groups
}

/**
 * 收集表格单元格内可翻译文本区块的 run 区间。
 * @param blocks 单元格子区块。
 * @param path 当前子区块路径。
 * @returns 文本区块路径及其 run 标识。
 * @author zhenghq
 */
function collectCellTextRuns(
  blocks: DocumentBlock[],
  path: PartialExportBlockPath = []
): Array<{ path: PartialExportBlockPath; runIds: string[] }> {
  const output: Array<{ path: PartialExportBlockPath; runIds: string[] }> = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!
    const blockPath = [...path, index]
    if (block.kind === 'text' && block.translatable) {
      for (const runIds of collectTextRunGroups(block)) output.push({ path: blockPath, runIds })
      continue
    }
    if (block.kind === 'table') {
      for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
        const row = block.rows[rowIndex]!
        for (let cellIndex = 0; cellIndex < row.cells.length; cellIndex += 1) {
          output.push(...collectCellTextRuns(row.cells[cellIndex]!.blocks, [
            ...blockPath,
            { row: rowIndex, cell: cellIndex }
          ]))
        }
      }
    }
  }
  return output
}

/**
 * 从源模型递归收集全部可翻译目标，规则必须与翻译流水线保持一致。
 * @param blocks 当前区块树。
 * @param pageIndex 页面索引。
 * @param path 当前区块路径。
 * @param targets 目标收集数组。
 * @returns 无返回值。
 * @author zhenghq
 */
function collectBlockTargets(
  blocks: DocumentBlock[],
  pageIndex: number,
  path: PartialExportBlockPath,
  targets: PartialExportTarget[]
): void {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!
    const blockPath = [...path, index]
    if (block.kind === 'text' && block.translatable) {
      for (const runIds of collectTextRunGroups(block)) {
        targets.push({
          targetId: `${pageIndex}:${blockPath.join('.')}:text:${runIds[0]}`,
          kind: 'text',
          pageIndex,
          path: blockPath,
          runIds
        })
      }
      continue
    }
    if (block.kind === 'image' && block.ocrRegions) {
      for (let regionIndex = 0; regionIndex < block.ocrRegions.length; regionIndex += 1) {
        const region = block.ocrRegions[regionIndex]!
        if (region.status !== 'recognized' || !region.text.trim()) continue
        targets.push({
          targetId: `${pageIndex}:${blockPath.join('.')}:ocr:${region.regionId}`,
          kind: 'ocr',
          pageIndex,
          path: blockPath,
          regionIndex
        })
      }
      continue
    }
    if (block.kind === 'table') {
      for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
        const row = block.rows[rowIndex]!
        const cellRuns: NonNullable<PartialExportTarget['cellRuns']> = []
        for (let cellIndex = 0; cellIndex < row.cells.length; cellIndex += 1) {
          const cellPath = [...blockPath, { row: rowIndex, cell: cellIndex }]
          const cellBlocks = collectCellTextRuns(row.cells[cellIndex]!.blocks)
          if (cellBlocks.length > 0) cellRuns.push({ cellIndex, blocks: cellBlocks })
        }
        if (cellRuns.length > 0) {
          targets.push({
            targetId: `${pageIndex}:${blockPath.join('.')}:row:${row.rowId}`,
            kind: 'table-row',
            pageIndex,
            path: blockPath,
            rowIndex,
            cellRuns
          })
        }
      }
    }
  }
}

/**
 * 收集文档全部可翻译目标。
 * @param model 源文档模型。
 * @returns 按阅读顺序排列的目标目录。
 * @author zhenghq
 */
function collectTargets(model: DocumentModel): PartialExportTarget[] {
  const targets: PartialExportTarget[] = []
  for (let pageIndex = 0; pageIndex < model.pages.length; pageIndex += 1) {
    collectBlockTargets(model.pages[pageIndex]!.blocks, pageIndex, [], targets)
  }
  return targets
}

/**
 * 按路径定位区块，支持表格单元格中的嵌套区块。
 * @param blocks 当前区块树。
 * @param path 区块路径。
 * @returns 定位到的区块；路径无效时返回 undefined。
 * @author zhenghq
 */
function resolveBlock(blocks: DocumentBlock[], path: PartialExportBlockPath): DocumentBlock | undefined {
  const [head, ...rest] = path
  if (head === undefined) return undefined
  if (typeof head === 'number') {
    const block = blocks[head]
    if (!block) return undefined
    if (rest.length === 0) return block
    const [cellRef, ...cellRest] = rest
    if (!cellRef || typeof cellRef === 'number' || block.kind !== 'table') return undefined
    const cell = block.rows[cellRef.row]?.cells[cellRef.cell]
    return cell ? resolveBlock(cell.blocks, cellRest) : undefined
  }
  return undefined
}

/**
 * 判断目标在译文模型中是否有可读的非空成功译文。
 * @param translation 译文模型。
 * @param target 目标目录项。
 * @returns 成功译文可读时返回 true。
 * @author zhenghq
 */
function hasSuccessfulTranslation(translation: DocumentModel, target: PartialExportTarget): boolean {
  const page = translation.pages[target.pageIndex]
  if (!page) return false
  const block = resolveBlock(page.blocks, target.path)
  if (!block) return false
  if (target.kind === 'text' && block.kind === 'text') {
    const runIds = new Set(target.runIds ?? [])
    const text = block.runs.filter((run) => runIds.has(run.runId)).map((run) => run.text).join('')
    return Boolean(text.trim())
  }
  if (target.kind === 'ocr' && block.kind === 'image') {
    const region = block.ocrRegions?.[target.regionIndex ?? -1]
    return Boolean(region?.translatedText?.trim())
  }
  if (target.kind === 'table-row' && block.kind === 'table') {
    const row = block.rows[target.rowIndex ?? -1]
    if (!row || !target.cellRuns || target.cellRuns.length === 0) return false
    return target.cellRuns.every((cellRange) => {
      const cell = row.cells[cellRange.cellIndex]
      if (!cell) return false
      return cellRange.blocks.every((range) => {
        const textBlock = resolveBlock(cell.blocks, range.path)
        if (!textBlock || textBlock.kind !== 'text') return false
        const runIds = new Set(range.runIds)
        return textBlock.runs
          .filter((run) => runIds.has(run.runId))
          .some((run) => Boolean(run.text.trim()))
      })
    })
  }
  return false
}

/**
 * 用源模型中的原文恢复文本目标覆盖的全部 run。
 * @param targetModel 待修改的译文模型。
 * @param sourceModel 源文档模型。
 * @param target 文本目标。
 * @returns 无返回值。
 * @author zhenghq
 */
function restoreTextTarget(
  targetModel: DocumentModel,
  sourceModel: DocumentModel,
  target: PartialExportTarget
): void {
  const sourceBlock = resolveBlock(sourceModel.pages[target.pageIndex]?.blocks ?? [], target.path)
  const targetBlock = resolveBlock(targetModel.pages[target.pageIndex]?.blocks ?? [], target.path)
  if (sourceBlock?.kind !== 'text' || targetBlock?.kind !== 'text') {
    throw new DocumentPartialExportError('text-target-missing')
  }
  const sourceRuns = new Map(sourceBlock.runs.map((run) => [run.runId, run]))
  const runIds = new Set(target.runIds ?? [])
  let restored = false
  targetBlock.runs = targetBlock.runs.map((run) => {
    if (!runIds.has(run.runId)) return run
    const sourceRun = sourceRuns.get(run.runId)
    if (!sourceRun) throw new DocumentPartialExportError('text-run-missing')
    restored = true
    return { ...run, text: sourceRun.text }
  })
  if (!restored) throw new DocumentPartialExportError('text-run-missing')
}

/**
 * 清除 OCR 目标译文，让预览按现有规则回退到识别原文。
 * @param targetModel 待修改的译文模型。
 * @param target OCR 目标。
 * @returns 无返回值。
 * @author zhenghq
 */
function restoreOcrTarget(targetModel: DocumentModel, target: PartialExportTarget): void {
  const block = resolveBlock(targetModel.pages[target.pageIndex]?.blocks ?? [], target.path)
  if (block?.kind !== 'image') throw new DocumentPartialExportError('ocr-target-missing')
  const region = block.ocrRegions?.[target.regionIndex ?? -1]
  if (!region) throw new DocumentPartialExportError('ocr-region-missing')
  delete region.translatedText
}

/**
 * 逐单元格、逐 run 恢复未完成表格行。
 * @param targetModel 待修改的译文模型。
 * @param sourceModel 源文档模型。
 * @param target 表格行目标。
 * @returns 无返回值。
 * @author zhenghq
 */
function restoreTableRowTarget(
  targetModel: DocumentModel,
  sourceModel: DocumentModel,
  target: PartialExportTarget
): void {
  const sourceBlock = resolveBlock(sourceModel.pages[target.pageIndex]?.blocks ?? [], target.path)
  const targetBlock = resolveBlock(targetModel.pages[target.pageIndex]?.blocks ?? [], target.path)
  if (sourceBlock?.kind !== 'table' || targetBlock?.kind !== 'table') {
    throw new DocumentPartialExportError('table-target-missing')
  }
  const sourceRow = sourceBlock.rows[target.rowIndex ?? -1]
  const targetRow = targetBlock.rows[target.rowIndex ?? -1]
  if (!sourceRow || !targetRow) throw new DocumentPartialExportError('table-row-missing')
  for (const cellRange of target.cellRuns ?? []) {
    const sourceCell = sourceRow.cells[cellRange.cellIndex]
    const targetCell = targetRow.cells[cellRange.cellIndex]
    if (!sourceCell || !targetCell) throw new DocumentPartialExportError('table-cell-missing')
    for (const range of cellRange.blocks) {
      const sourceText = resolveBlock(sourceCell.blocks, range.path)
      const targetText = resolveBlock(targetCell.blocks, range.path)
      if (sourceText?.kind !== 'text' || targetText?.kind !== 'text') {
        throw new DocumentPartialExportError('table-text-target-missing')
      }
      const sourceRuns = new Map(sourceText.runs.map((run) => [run.runId, run]))
      const runIds = new Set(range.runIds)
      targetText.runs = targetText.runs.map((run) => {
        if (!runIds.has(run.runId)) return run
        const sourceRun = sourceRuns.get(run.runId)
        if (!sourceRun) throw new DocumentPartialExportError('table-run-missing')
        return { ...run, text: sourceRun.text }
      })
    }
  }
}

/**
 * 校验报告数组长度、目标存在性、重复和计数不变量。
 * @param report 完成报告。
 * @param targets 从源模型重建的目标目录。
 * @returns 无返回值。
 * @throws {DocumentPartialExportError} 任一目标或计数不一致时抛出。
 * @author zhenghq
 */
function validateReport(report: DocumentCompletionReport, targets: PartialExportTarget[]): void {
  // completed 报告必须没有任何回退目标，否则调用方可能把部分结果误当成完整导出。
  if (report.status === 'completed' &&
    (report.failed !== 0 || report.pending !== 0 || report.suspectUntranslated !== 0)) {
    throw new DocumentPartialExportError('completed-with-unresolved-targets')
  }
  if (report.total !== targets.length) throw new DocumentPartialExportError('target-count-mismatch')
  if (report.total !== report.translated + report.unchanged + report.failed +
    report.pending + report.suspectUntranslated) {
    throw new DocumentPartialExportError('count-invariant-mismatch')
  }
  const groups: Array<{ ids: string[]; count: number; name: string }> = [
    { ids: report.failedTargetIds, count: report.failed, name: 'failed' },
    { ids: report.pendingTargetIds, count: report.pending, name: 'pending' },
    { ids: report.suspectUntranslatedTargetIds, count: report.suspectUntranslated, name: 'suspect' }
  ]
  const known = new Set(targets.map((target) => target.targetId))
  const seen = new Set<string>()
  for (const group of groups) {
    if (group.ids.length !== group.count) {
      throw new DocumentPartialExportError(`${group.name}-count-mismatch`)
    }
    for (const id of group.ids) {
      if (!known.has(id) || seen.has(id)) throw new DocumentPartialExportError(`${group.name}-target-invalid`)
      seen.add(id)
    }
  }
}

/**
 * 构建保留全部页面、仅回退未通过目标的部分导出模型。
 * @param source 已完成 OCR 的源文档模型。
 * @param translation 当前译文模型。
 * @param report 当前代际完成报告。
 * @returns 不可变输入对应的部分导出模型与摘要。
 * @throws {DocumentPartialExportError} 报告、目标或成功译文不一致时抛出 completion-mismatch。
 * @author zhenghq
 */
export function buildPartialExportDocument(
  source: DocumentModel,
  translation: DocumentModel,
  report: DocumentCompletionReport
): DocumentPartialExportResult {
  if (!source || !translation || !report || source.documentId !== report.documentId ||
    translation.documentId !== source.documentId) {
    throw new DocumentPartialExportError('document-identity-mismatch')
  }
  const targets = collectTargets(source)
  validateReport(report, targets)
  const revertedIds = new Set([
    ...report.failedTargetIds,
    ...report.pendingTargetIds,
    ...report.suspectUntranslatedTargetIds
  ])
  const model = structuredClone(translation)
  const targetById = new Map(targets.map((target) => [target.targetId, target]))
  for (const target of targets) {
    if (revertedIds.has(target.targetId)) continue
    if (!hasSuccessfulTranslation(model, target)) {
      throw new DocumentPartialExportError('successful-translation-missing')
    }
  }
  for (const targetId of revertedIds) {
    const target = targetById.get(targetId)
    if (!target) throw new DocumentPartialExportError('target-missing')
    if (target.kind === 'text') restoreTextTarget(model, source, target)
    else if (target.kind === 'ocr') restoreOcrTarget(model, target)
    else restoreTableRowTarget(model, source, target)
  }
  return {
    model,
    summary: {
      total: report.total,
      translated: report.translated,
      unchanged: report.unchanged,
      reverted: report.failed + report.pending + report.suspectUntranslated,
      failed: report.failed,
      pending: report.pending,
      suspectUntranslated: report.suspectUntranslated
    }
  }
}
