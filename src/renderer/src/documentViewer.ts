import {
  parseDocumentModel,
  type DocumentBlock,
  type DocumentModel,
  type DocumentPage,
  type DocumentTableBlock,
  type DocumentTableCell,
  type DocumentTextBlock
} from '../../shared/documentTypes.ts'
import type { DocumentWorkspaceSnapshot } from '../../shared/documentWorkspace.ts'
import { countVisibleDocumentWarnings } from '../../shared/documentWarnings.ts'

/** 文档查看器状态在本地存储中的键名。 */
export const DOCUMENT_VIEWER_STATE_STORAGE_KEY = 'selection-translator.document-viewer-state'

/** 文档查看器状态结构版本；不兼容变更时递增。 */
export const DOCUMENT_VIEWER_STATE_VERSION = 3

/** 从本地缓存恢复的工作台快照使用固定任务身份，避免复用旧任务的 IPC 授权。 */
export const RESTORED_DOCUMENT_JOB_ID = 'restored-viewer-state'

/** 文档查看器支持的显示模式。 */
export type DocumentViewerMode = 'source' | 'translation' | 'spread'

/** 文档查看器可恢复的滚动位置。 */
export interface DocumentViewerScrollState {
  /** 原文栏滚动位置。 */
  source: number
  /** 译文栏滚动位置。 */
  translation: number
}

/** 文档查看器可恢复的文件元数据；不包含原始文件内容。 */
export interface DocumentViewerFileState {
  /** 主进程批准过的文件路径。 */
  path: string
  /** 面向界面的文件名。 */
  name: string
  /** 文件字节数。 */
  size: number
  /** 已识别格式。 */
  format: string
  /** 文件内容哈希，用于确认恢复状态仍对应同一文件。 */
  sha256: string
}

/** 单个文件 Tab 的完整可恢复状态。 */
export interface DocumentViewerTabState {
  /** 窗口内稳定的 Tab 标识。 */
  id: string
  /** 文件元数据；仅保存主进程批准过的路径。 */
  selection: DocumentViewerFileState
  /** 用户选择的源语言。 */
  sourceLang: string
  /** 用户选择的目标语言。 */
  targetLang: string
  /** 该 Tab 的原文与译文显示模式。 */
  viewMode: DocumentViewerMode
  /** 该 Tab 的缩放比例。 */
  zoom: number
  /** 该 Tab 的双栏滚动位置。 */
  scroll: DocumentViewerScrollState
  /** 该 Tab 是否启用双栏滚动同步。 */
  scrollSyncEnabled: boolean
  /** 该 Tab 当前阅读页，从 1 开始。 */
  pageNumber: number
  /** 该 Tab 的 OCR 原文与译文展示方式。 */
  ocrDisplayMode: 'ocr-text' | 'translation'
  /** 当前阅读页面标识。 */
  activePageId: string | null
  /** 当前高亮区块标识。 */
  activeBlockId: string | null
  /** 已完成的原文模型。 */
  source: DocumentModel
  /** 已完成的译文模型。 */
  translation: DocumentModel
}

/** 文档查看器完整可恢复状态；版本 3 起保存完整 Tab 集合。 */
export interface DocumentViewerState {
  /** 状态结构版本。 */
  version: typeof DOCUMENT_VIEWER_STATE_VERSION
  /** 当前激活 Tab；没有可恢复 Tab 时为 null。 */
  activeTabId: string | null
  /** 按顶栏顺序保存的完整文件 Tab。 */
  tabs: DocumentViewerTabState[]
}

/** 恢复文件授权校验的稳定失败分类。 */
export type RestoredDocumentFileValidationCode =
  | 'not-authorized'
  | 'path-mismatch'
  | 'format-mismatch'
  | 'size-mismatch'
  | 'sha256-mismatch'

/** 恢复文件授权校验结果。 */
export type RestoredDocumentFileValidationResult =
  | { ok: true }
  | { ok: false; code: RestoredDocumentFileValidationCode }

/** 页码或目录跳转结果。 */
export interface DocumentNavigationTarget {
  /** 目标页面稳定标识。 */
  pageId: string
  /** 从零开始的页面索引。 */
  pageIndex: number
  /** 从一开始显示的页码。 */
  pageNumber: number
  /** 可选的区块稳定标识。 */
  blockId: string | null
}

/** 区块高亮定位结果。 */
export interface DocumentBlockHighlight {
  /** 区块所属页面标识。 */
  pageId: string
  /** 区块所属页面索引。 */
  pageIndex: number
  /** 区块稳定标识。 */
  blockId: string
  /** 区块是否位于表格单元格等嵌套容器内。 */
  isNested: boolean
}

/**
 * 创建空的查看器状态。
 * @returns 不恢复任何文件或译文的默认状态。
 * @author zhenghq
 */
export function createEmptyDocumentViewerState(): DocumentViewerState {
  return {
    version: DOCUMENT_VIEWER_STATE_VERSION,
    activeTabId: null,
    tabs: []
  }
}

/**
 * 将缩放比例限制在文档查看器支持的范围。
 * @param value 待规范化缩放比例。
 * @returns 0.5 到 2 之间的有效比例；非法值回退为 1。
 * @author zhenghq
 */
export function clampDocumentZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(2, Math.max(0.5, value))
}

/**
 * 计算页面适合可用宽度的缩放比例。
 * @param pageWidth 页面原始宽度。
 * @param availableWidth 可用内容宽度。
 * @returns 限制在 0.5 到 2 之间的缩放比例；输入无效时返回 1。
 * @author zhenghq
 */
export function resolveFitDocumentZoom(pageWidth: number, availableWidth: number): number {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0 ||
    !Number.isFinite(availableWidth) || availableWidth <= 0) return 1
  return clampDocumentZoom(availableWidth / pageWidth)
}

/**
 * 解析用户输入的从一起始页码。
 * @param value 页码输入值。
 * @param pageCount 当前文档总页数。
 * @returns 合法页码；空值、非整数或越界时返回 null。
 * @author zhenghq
 */
export function parseDocumentPageNumber(value: string, pageCount: number): number | null {
  const normalized = value.trim()
  if (!/^\d+$/u.test(normalized) || !Number.isSafeInteger(pageCount) || pageCount < 1) return null
  const pageNumber = Number(normalized)
  return pageNumber >= 1 && pageNumber <= pageCount ? pageNumber : null
}

/**
 * 将页码输入解析为可滚动定位的页面。
 * @param model 当前文档模型。
 * @param value 用户输入页码。
 * @returns 目标页面；输入无效时返回 null。
 * @author zhenghq
 */
export function resolveDocumentPageJump(
  model: DocumentModel,
  value: string
): DocumentNavigationTarget | null {
  const pageNumber = parseDocumentPageNumber(value, model.pages.length)
  if (pageNumber === null) return null
  const page = model.pages[pageNumber - 1]
  if (!page) return null
  return {
    pageId: page.pageId,
    pageIndex: pageNumber - 1,
    pageNumber,
    blockId: null
  }
}

/**
 * 递归查找区块是否位于给定页面中。
 * @param blocks 待遍历区块列表。
 * @param blockId 目标区块标识。
 * @returns 找到时返回是否为嵌套区块；否则返回 null。
 * @author zhenghq
 */
function findDocumentBlock(blocks: readonly DocumentBlock[], blockId: string): boolean | null {
  for (const block of blocks) {
    if (block.blockId === blockId) return false
    if (block.kind !== 'table') continue
    for (const row of block.rows) {
      for (const cell of row.cells) {
        const nested = findDocumentBlock(cell.blocks, blockId)
        if (nested !== null) return true
      }
    }
  }
  return null
}

/**
 * 解析块级高亮定位，支持表格单元格中的嵌套区块。
 * @param model 当前文档模型。
 * @param pageId 目标页面标识。
 * @param blockId 目标区块标识。
 * @returns 高亮定位；页面或区块不存在时返回 null。
 * @author zhenghq
 */
export function resolveDocumentBlockHighlight(
  model: DocumentModel,
  pageId: string,
  blockId: string
): DocumentBlockHighlight | null {
  const pageIndex = model.pages.findIndex((page) => page.pageId === pageId)
  const page = model.pages[pageIndex]
  if (!page) return null
  const nested = findDocumentBlock(page.blocks, blockId)
  if (nested === null) return null
  return { pageId, pageIndex, blockId, isNested: nested }
}

/**
 * 查找页面标题或标题区块对应的目录目标。
 * @param model 当前文档模型。
 * @param title 目录标题。
 * @param pageNumber 目录中记录的页码文本。
 * @returns 目录目标；无法定位时返回 null。
 * @author zhenghq
 */
export function resolveDocumentTocTarget(
  model: DocumentModel,
  title: string,
  pageNumber?: string
): DocumentNavigationTarget | null {
  const normalizedTitle = title.trim().toLocaleLowerCase()
  if (!normalizedTitle) return null
  if (pageNumber !== undefined) {
    const pageTarget = resolveDocumentPageJump(model, pageNumber)
    if (pageTarget) {
      const heading = findHeadingOnPage(model.pages[pageTarget.pageIndex], normalizedTitle)
      return heading ? { ...pageTarget, blockId: heading } : pageTarget
    }
  }
  for (const page of model.pages) {
    const heading = findHeadingOnPage(page, normalizedTitle)
    if (heading) {
      return {
        pageId: page.pageId,
        pageIndex: page.index,
        pageNumber: page.index + 1,
        blockId: heading
      }
    }
  }
  for (const page of model.pages) {
    if (page.title?.trim().toLocaleLowerCase() === normalizedTitle) {
      return {
        pageId: page.pageId,
        pageIndex: page.index,
        pageNumber: page.index + 1,
        blockId: null
      }
    }
  }
  return null
}

/**
 * 在单页中查找匹配标题的文本区块，优先使用标题角色。
 * @param page 待检查页面。
 * @param normalizedTitle 已转小写并去空白的标题。
 * @returns 匹配的区块标识；不存在时返回 null。
 * @author zhenghq
 */
function findHeadingOnPage(page: DocumentPage, normalizedTitle: string): string | null {
  let fallback: string | null = null
  for (const block of page.blocks) {
    if (block.kind !== 'text' || block.toc) continue
    const text = block.runs.map((run) => run.text).join('').trim().toLocaleLowerCase()
    if (text !== normalizedTitle) continue
    if (block.role === 'heading' || block.role === 'subtitle') return block.blockId
    fallback ??= block.blockId
  }
  return fallback
}

/**
 * 判断未知值是否为有效文件状态。
 * @param value 待检查值。
 * @returns 字段完整且类型有效时返回 true。
 * @author zhenghq
 */
function isDocumentViewerFileState(value: unknown): value is DocumentViewerFileState {
  if (!value || typeof value !== 'object') return false
  const file = value as Partial<DocumentViewerFileState>
  return typeof file.path === 'string' && file.path.trim().length > 0 &&
    typeof file.name === 'string' && file.name.trim().length > 0 &&
    typeof file.size === 'number' && Number.isFinite(file.size) && file.size >= 0 &&
    typeof file.format === 'string' && file.format.trim().length > 0 &&
    typeof file.sha256 === 'string' && file.sha256.trim().length > 0
}

/**
 * 判断未知值是否为可安全恢复的文档模型。
 * @param value 待检查值。
 * @returns 结构具备页面、资源与源文件描述时返回 true。
 * @author zhenghq
 */
function isDocumentViewerModel(value: unknown): value is DocumentModel {
  if (!value || typeof value !== 'object') return false
  const model = value as Partial<DocumentModel>
  return model.schemaVersion === 1 && typeof model.documentId === 'string' &&
    Boolean(model.source) && Array.isArray(model.pages) && Array.isArray(model.assets) &&
    Array.isArray(model.warnings)
}

/**
 * 规范化文件元数据，移除首尾空白并统一格式大小写。
 * @param value 待规范化的文件元数据。
 * @returns 可持久化的文件元数据；字段不完整时返回 null。
 * @author zhenghq
 */
function normalizeDocumentViewerFile(value: unknown): DocumentViewerFileState | null {
  if (!isDocumentViewerFileState(value)) return null
  return {
    path: value.path,
    name: value.name.trim(),
    size: value.size,
    format: value.format.trim().toLowerCase(),
    sha256: value.sha256.trim()
  }
}

/**
 * 将任意滚动位置收敛为非负有限数值。
 * @param position 待规范化的滚动位置。
 * @returns 非负滚动位置；非法值回退为 0。
 * @author zhenghq
 */
function normalizeDocumentViewerScrollPosition(position: unknown): number {
  return typeof position === 'number' && Number.isFinite(position) ? Math.max(0, position) : 0
}

/**
 * 规范化显示模式，并兼容旧版独立显示模式键。
 * @param value 待检查的显示模式。
 * @param legacyViewMode 旧版独立显示模式键中的兼容值。
 * @returns 支持的显示模式；未知值回退为双面显示。
 * @author zhenghq
 */
function normalizeDocumentViewerMode(
  value: unknown,
  legacyViewMode?: DocumentViewerMode
): DocumentViewerMode {
  if (value === 'source' || value === 'translation' || value === 'spread') return value
  return legacyViewMode ?? 'spread'
}

/**
 * 规范化单个完整 Tab，并校验其源与译文模型以及阅读锚点。
 * @param value 待检查的 Tab 数据。
 * @param fallbackId 旧版单文件状态迁移时使用的稳定 Tab 标识。
 * @param legacyViewMode 旧版独立显示模式键中的兼容值。
 * @returns 可安全恢复的 Tab；任何关键字段损坏时返回 null。
 * @author zhenghq
 */
function normalizeDocumentViewerTab(
  value: unknown,
  fallbackId: string,
  legacyViewMode?: DocumentViewerMode
): DocumentViewerTabState | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<DocumentViewerTabState> & {
    file?: unknown
    scroll?: Partial<DocumentViewerScrollState>
  }
  const id = typeof candidate.id === 'string' && candidate.id.trim()
    ? candidate.id.trim()
    : fallbackId
  const file = normalizeDocumentViewerFile(candidate.selection ?? candidate.file)
  const source = parseDocumentViewerModel(candidate.source)
  const translation = parseDocumentViewerModel(candidate.translation)
  if (!file || !source || !translation) return null
  const migrated = migrateRestoredPdfTableCellSnapshots(file.format, source, translation)
  const models = migrated.models
  const activePageId = resolveRestoredPageId(candidate.activePageId, models)
  const anchorModel = models.find((model) => model.pages.some((page) => page.pageId === activePageId))
  const migratedBlockId = typeof candidate.activeBlockId === 'string'
    ? migrated.resolveBlockId(candidate.activeBlockId)
    : null
  const activeBlockId = migratedBlockId && activePageId && anchorModel &&
    resolveDocumentBlockHighlight(anchorModel, activePageId, migratedBlockId)
    ? migratedBlockId
    : null
  const pageNumber = typeof candidate.pageNumber === 'number' &&
    Number.isSafeInteger(candidate.pageNumber) && candidate.pageNumber >= 1
    ? candidate.pageNumber
    : 1
  return {
    id,
    selection: file,
    sourceLang: typeof candidate.sourceLang === 'string' && candidate.sourceLang.trim()
      ? candidate.sourceLang.trim()
      : 'auto',
    targetLang: typeof candidate.targetLang === 'string' && candidate.targetLang.trim()
      ? candidate.targetLang.trim()
      : 'auto',
    viewMode: normalizeDocumentViewerMode(candidate.viewMode, legacyViewMode),
    zoom: clampDocumentZoom(typeof candidate.zoom === 'number' ? candidate.zoom : 1),
    scroll: {
      source: normalizeDocumentViewerScrollPosition(candidate.scroll?.source),
      translation: normalizeDocumentViewerScrollPosition(candidate.scroll?.translation)
    },
    scrollSyncEnabled: candidate.scrollSyncEnabled !== false,
    pageNumber,
    ocrDisplayMode: candidate.ocrDisplayMode === 'ocr-text' ? 'ocr-text' : 'translation',
    activePageId,
    activeBlockId,
    source: models[0]!,
    translation: models[1]!
  }
}

/** PDF 单元格文本合并后，旧区块标识到新标识的映射。 */
type RestoredPdfBlockIdMap = Map<string, string>

/** PDF 快照迁移结果。 */
interface RestoredPdfSnapshotMigration {
  /** 按源模型、译文模型顺序排列的迁移结果。 */
  models: [DocumentModel, DocumentModel]
  /** 将旧活动区块标识解析为迁移后的标识。 */
  resolveBlockId(blockId: string): string
}

/**
 * 将旧版 PDF 表格快照中的逐视觉行区块迁移为整格翻译区块。
 * 源模型与译文模型必须按相同单元格结构同步迁移；结构不一致时保持原样，
 * 避免把不同语义内容错误拼接。迁移只针对 PDF，其他格式完全不受影响。
 * @param format 恢复 Tab 的源文件格式。
 * @param source 已校验的源模型。
 * @param translation 已校验的译文模型。
 * @returns 迁移后的模型及旧区块标识解析函数。
 * @author zhenghq
 */
function migrateRestoredPdfTableCellSnapshots(
  format: string,
  source: DocumentModel,
  translation: DocumentModel
): RestoredPdfSnapshotMigration {
  const unchanged = (): RestoredPdfSnapshotMigration => ({
    models: [source, translation],
    resolveBlockId: (blockId) => blockId
  })
  if (format.toLowerCase() !== 'pdf') return unchanged()

  const sourcePages = collectRestoredPdfTableCellGroups(source)
  const translationPages = collectRestoredPdfTableCellGroups(translation)
  if (sourcePages.length === 0 || sourcePages.length !== translationPages.length) return unchanged()
  const sourceGroups = sourcePages.flat()
  const translationGroups = translationPages.flat()
  if (sourceGroups.length !== translationGroups.length) return unchanged()

  const blockIdMap: RestoredPdfBlockIdMap = new Map()
  let migratedSource = source
  let migratedTranslation = translation
  for (let index = 0; index < sourceGroups.length; index += 1) {
    const sourceGroup = sourceGroups[index]!
    const translationGroup = translationGroups[index]!
    const migratedGroup = mergeRestoredPdfTableCellGroup(sourceGroup, translationGroup)
    if (!migratedGroup) continue
    for (const [oldBlockId, newBlockId] of migratedGroup.blockIdMap) blockIdMap.set(oldBlockId, newBlockId)
    migratedSource = replaceRestoredPdfTableCellBlocks(migratedSource, sourceGroup, migratedGroup.sourceBlocks)
    migratedTranslation = replaceRestoredPdfTableCellBlocks(
      migratedTranslation,
      translationGroup,
      migratedGroup.translationBlocks
    )
  }
  return {
    models: [migratedSource, migratedTranslation],
    resolveBlockId: (blockId) => blockIdMap.get(blockId) ?? blockId
  }
}

/** PDF 表格单元格在模型中的稳定定位信息。 */
interface RestoredPdfTableCellGroup {
  /** 所属页面标识。 */
  pageId: string
  /** 表格在页面中的区块标识。 */
  tableBlockId: string
  /** 表格行标识。 */
  rowId: string
  /** 单元格标识。 */
  cellId: string
  /** 单元格当前内容。 */
  blocks: DocumentBlock[]
}

/**
 * 收集模型中所有 PDF 表格单元格内容。
 * @param model 待检查文档模型。
 * @returns 按页面和表格顺序排列的单元格引用。
 * @author zhenghq
 */
function collectRestoredPdfTableCellGroups(model: DocumentModel): RestoredPdfTableCellGroup[][] {
  return model.pages.map((page) => {
    const groups: RestoredPdfTableCellGroup[] = []
    for (const block of page.blocks) {
      if (block.kind !== 'table') continue
      for (const row of block.rows) {
        for (const cell of row.cells) {
          groups.push({
            pageId: page.pageId,
            tableBlockId: block.blockId,
            rowId: row.rowId,
            cellId: cell.cellId,
            blocks: cell.blocks
          })
        }
      }
    }
    return groups
  })
}

/** 单元格迁移结果。 */
interface RestoredPdfTableCellMigration {
  /** 迁移后的源单元格区块。 */
  sourceBlocks: DocumentBlock[]
  /** 迁移后的译文单元格区块。 */
  translationBlocks: DocumentBlock[]
  /** 旧区块标识到新标识的映射。 */
  blockIdMap: RestoredPdfBlockIdMap
}

/**
 * 按源模型的几何视觉行合并源、译文单元格，同时保持非文本区块顺序。
 * @param source 源单元格。
 * @param translation 结构匹配的译文单元格。
 * @returns 迁移结果；无需或无法安全迁移时返回 null。
 * @author zhenghq
 */
function mergeRestoredPdfTableCellGroup(
  source: RestoredPdfTableCellGroup,
  translation: RestoredPdfTableCellGroup
): RestoredPdfTableCellMigration | null {
  const sourceGroups = groupRestoredPdfCellTextBlocks(source.blocks)
  const translationGroups = groupRestoredPdfCellTextBlocks(translation.blocks)
  if (sourceGroups.length === 0 || sourceGroups.length !== translationGroups.length) return null
  const structurallyMatched = sourceGroups.every((sourceGroup, index) => {
    const translationGroup = translationGroups[index]!
    if (sourceGroup.kind !== translationGroup.kind) return false
    return sourceGroup.kind !== 'text' || sourceGroup.texts.length === translationGroup.texts.length
  })
  // 源译文同一视觉组的片段数量不一致时无法可靠建立对应关系，整格保持旧快照。
  if (!structurallyMatched) return null
  const merges = sourceGroups.map((sourceGroup, index) => ({
    source: sourceGroup,
    translation: translationGroups[index]!
  })).filter(({ source: group }) => group.texts.length > 1)
  if (merges.length === 0) return null

  const blockIdMap: RestoredPdfBlockIdMap = new Map()
  for (const merge of merges) {
    const firstBlockId = merge.source.texts[0]!.blockId
    for (const text of merge.source.texts) blockIdMap.set(text.blockId, firstBlockId)
    for (const text of merge.translation.texts) blockIdMap.set(text.blockId, firstBlockId)
  }
  const sourceBlocks = rebuildRestoredPdfCellBlocks(source.blocks, sourceGroups)
  const translationBlocks = rebuildRestoredPdfCellBlocks(translation.blocks, translationGroups)
  if (!sourceBlocks || !translationBlocks) return null
  return { sourceBlocks, translationBlocks, blockIdMap }
}

/** 单元格内容分组；文本组可合并，其他区块单独保留。 */
type RestoredPdfCellGroup =
  | { kind: 'text'; blocks: DocumentBlock[]; texts: DocumentTextBlock[] }
  | { kind: 'other'; blocks: DocumentBlock[]; texts: [] }

/**
 * 将单元格内容按视觉行和阅读顺序切分为文本组与非文本组。
 * 非文本区块必须切断文本组，确保图片、公式和形状保持在原阅读位置。
 * @param blocks 单元格内区块。
 * @returns 保持原顺序的内容分组。
 * @author zhenghq
 */
function groupRestoredPdfCellTextBlocks(blocks: readonly DocumentBlock[]): RestoredPdfCellGroup[] {
  const groups: RestoredPdfCellGroup[] = []
  let current: Extract<RestoredPdfCellGroup, { kind: 'text' }> | null = null
  for (const block of blocks) {
    if (block.kind !== 'text') {
      current = null
      groups.push({ kind: 'other', blocks: [block], texts: [] })
      continue
    }
    if (!current) {
      current = { kind: 'text', blocks: [], texts: [] }
      groups.push(current)
    }
    current.blocks.push(block)
    current.texts.push(block)
  }
  return groups
}

/**
 * 将分组的单元格内容重建为区块数组；同组文本按视觉行合并。
 * @param originalBlocks 原单元格区块，用于判断是否需要改动。
 * @param groups 已计算的内容分组。
 * @returns 重建后的区块；缺少坐标等必要信息时返回 null。
 * @author zhenghq
 */
function rebuildRestoredPdfCellBlocks(
  originalBlocks: readonly DocumentBlock[],
  groups: readonly RestoredPdfCellGroup[]
): DocumentBlock[] | null {
  const rebuilt: DocumentBlock[] = []
  for (const group of groups) {
    if (group.kind === 'other') {
      rebuilt.push(...group.blocks)
      continue
    }
    const merged = mergeRestoredPdfTextBlocks(group.texts)
    if (!merged) return null
    rebuilt.push(merged)
  }
  return rebuilt.map((block, readingOrder) => {
    const original = originalBlocks.find((candidate) => candidate.blockId === block.blockId)
    return original?.readingOrder === readingOrder ? block : { ...block, readingOrder }
  })
}

/**
 * 将同一视觉行组内的文本块合并为一个文本块。
 * @param texts 连续文本区块。
 * @returns 合并后的文本块；缺少有效坐标时返回 null。
 * @author zhenghq
 */
function mergeRestoredPdfTextBlocks(texts: readonly DocumentTextBlock[]): DocumentTextBlock | null {
  if (texts.length === 0) return null
  if (texts.length === 1) return texts[0]!
  const boxes = texts.map((block) => block.bbox)
  if (boxes.some((box) => !box)) return null
  const lines = groupRestoredPdfTextLines(texts)
  const first = texts[0]!
  const runs = texts.flatMap((block) => block.runs)
  const mergedRuns = runs.map((run) => ({ ...run, style: run.style ? { ...run.style } : undefined }))
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const previousLine = lines[lineIndex - 1]!
    const currentLine = lines[lineIndex]!
    const previousText = previousLine.map((block) => block.runs.map((run) => run.text).join('')).join('')
    const currentText = currentLine.map((block) => block.runs.map((run) => run.text).join('')).join('')
    if (!needsRestoredPdfLineSeparator(previousText, currentText)) continue
    const firstRunIndex = runs.findIndex((run) => currentLine.some((block) => block.runs.includes(run)))
    if (firstRunIndex > 0) mergedRuns[firstRunIndex - 1]!.text += ' '
  }
  const validBoxes = boxes as NonNullable<typeof boxes[number]>[]
  const left = Math.min(...validBoxes.map((box) => box.x))
  const top = Math.min(...validBoxes.map((box) => box.y))
  const right = Math.max(...validBoxes.map((box) => box.x + box.width))
  const bottom = Math.max(...validBoxes.map((box) => box.y + box.height))
  const alignments = new Set(texts.map((block) => block.textAlign).filter(Boolean))
  const roles = new Set(texts.map((block) => block.role))
  const merged: DocumentTextBlock = {
    ...first,
    blockId: first.blockId,
    readingOrder: first.readingOrder,
    translatable: texts.some((block) => block.translatable),
    bbox: { x: left, y: top, width: right - left, height: bottom - top },
    role: roles.size === 1 ? first.role : 'paragraph',
    runs: mergedRuns
  }
  // 混合对齐的视觉行不能继承首行对齐，否则恢复后会错误影响整格排版。
  if (alignments.size === 1) merged.textAlign = [...alignments][0]
  else delete merged.textAlign
  return merged
}

/**
 * 按纵坐标把单元格文本块划分为视觉行，并在行内按横坐标排序。
 * @param texts 单元格文本块。
 * @returns 从上到下、从左到右排列的视觉行。
 * @author zhenghq
 */
function groupRestoredPdfTextLines(texts: readonly DocumentTextBlock[]): DocumentTextBlock[][] {
  const sorted = [...texts].sort((left, right) =>
    (left.bbox?.y ?? 0) - (right.bbox?.y ?? 0) || (left.bbox?.x ?? 0) - (right.bbox?.x ?? 0))
  const lines: DocumentTextBlock[][] = []
  for (const block of sorted) {
    const line = lines.at(-1)
    const reference = line?.[0]?.bbox
    const box = block.bbox
    if (line && reference && box) {
      const tolerance = Math.max(1, Math.min(reference.height, box.height) * 0.35)
      if (Math.abs(reference.y - box.y) <= tolerance) {
        line.push(block)
        line.sort((left, right) => (left.bbox?.x ?? 0) - (right.bbox?.x ?? 0))
        continue
      }
    }
    lines.push([block])
  }
  return lines
}

/**
 * 判断旧 PDF 单元格的相邻视觉行之间是否需要补空格。
 * @param previousText 上一视觉行文本。
 * @param currentText 下一视觉行文本。
 * @returns 需要插入一个空格时返回 true。
 * @author zhenghq
 */
function needsRestoredPdfLineSeparator(previousText: string, currentText: string): boolean {
  const previous = previousText.trimEnd()
  const current = currentText.trimStart()
  if (!previous || !current) return false
  const previousCharacter = previous.at(-1) ?? ''
  const currentCharacter = current[0] ?? ''
  if (/\s/u.test(previousCharacter) || /\s/u.test(currentCharacter)) return false
  if (/[\u3400-\u9fff]/u.test(previousCharacter) || /[\u3400-\u9fff]/u.test(currentCharacter)) return false
  if (/[.,;:!?%)\]}]/u.test(currentCharacter)) return false
  return !/[(\[{/-]$/u.test(previousCharacter)
}

/**
 * 用迁移后的区块替换模型中指定单元格内容。
 * @param model 原文档模型。
 * @param target 单元格定位信息。
 * @param blocks 迁移后的单元格区块。
 * @returns 更新后的文档模型；定位失效时返回原模型。
 * @author zhenghq
 */
function replaceRestoredPdfTableCellBlocks(
  model: DocumentModel,
  target: RestoredPdfTableCellGroup,
  blocks: DocumentBlock[]
): DocumentModel {
  let changed = false
  const pages = model.pages.map((page) => {
    if (page.pageId !== target.pageId) return page
    const pageBlocks = page.blocks.map((block) => {
      if (block.kind !== 'table' || block.blockId !== target.tableBlockId) return block
      const table = replaceRestoredPdfTableCells(block, target, blocks)
      if (table !== block) changed = true
      return table
    })
    return changed ? { ...page, blocks: pageBlocks } : page
  })
  return changed ? { ...model, pages } : model
}

/**
 * 在表格中替换目标单元格内容。
 * @param table 表格区块。
 * @param target 单元格定位信息。
 * @param blocks 迁移后的单元格区块。
 * @returns 更新后的表格；未命中时返回原表格。
 * @author zhenghq
 */
function replaceRestoredPdfTableCells(
  table: DocumentTableBlock,
  target: RestoredPdfTableCellGroup,
  blocks: DocumentBlock[]
): DocumentTableBlock {
  let changed = false
  const rows = table.rows.map((row) => {
    if (row.rowId !== target.rowId) return row
    const cells = row.cells.map((cell) => {
      if (cell.cellId !== target.cellId) return cell
      changed = true
      return { ...cell, blocks }
    })
    return { ...row, cells }
  })
  return changed ? { ...table, rows } : table
}

/**
 * 规范化本地存储中的查看器状态；损坏 Tab 单独丢弃，越界字段单独收敛。
 * 版本 1 和 2 的单文件状态会迁移成完整 Tab；版本 1 没有完整双模型时只保留空状态。
 * @param value 从本地存储读取的未知数据。
 * @param legacyViewMode 旧版独立显示模式键中的兼容值。
 * @returns 可安全恢复的查看器状态。
 * @author zhenghq
 */
export function normalizeDocumentViewerState(
  value: unknown,
  legacyViewMode?: DocumentViewerMode
): DocumentViewerState {
  const empty = createEmptyDocumentViewerState()
  if (!value || typeof value !== 'object') return empty
  const candidateVersion = (value as { version?: unknown }).version
  if (candidateVersion !== 1 && candidateVersion !== 2 && candidateVersion !== 3) return empty
  const candidate = value as Record<string, unknown>
  const tabCandidates = candidateVersion === 3
    ? Array.isArray(candidate.tabs) ? candidate.tabs : null
    : [candidate]
  if (!tabCandidates) return empty
  const tabs: DocumentViewerTabState[] = []
  const seenIds = new Set<string>()
  for (let index = 0; index < tabCandidates.length; index += 1) {
    const tab = normalizeDocumentViewerTab(
      tabCandidates[index],
      `restored-document-tab-${index + 1}`,
      legacyViewMode
    )
    if (!tab || seenIds.has(tab.id)) continue
    seenIds.add(tab.id)
    tabs.push(tab)
  }
  if (tabs.length === 0) return empty
  const requestedActiveTabId = candidateVersion === 3 && typeof candidate.activeTabId === 'string'
    ? candidate.activeTabId
    : null
  const activeTabId = tabs.some((tab) => tab.id === requestedActiveTabId)
    ? requestedActiveTabId
    : tabs[0]!.id
  return {
    version: DOCUMENT_VIEWER_STATE_VERSION,
    activeTabId,
    tabs
  }
}

/**
 * 校验未知值是否为可安全恢复的文档模型。
 * @param value 从本地存储读取的未知模型。
 * @returns 通过完整结构校验的模型；非法值返回 null。
 * @author zhenghq
 */
function parseDocumentViewerModel(value: unknown): DocumentModel | null {
  try {
    return parseDocumentModel(value)
  } catch {
    return null
  }
}

/**
 * 优先按源模型、其次按译文模型校验恢复页面锚点。
 * @param value 本地存储中的页面标识。
 * @param models 按源模型、译文模型顺序排列的可用模型。
 * @returns 有效页面标识；缺失或未知时回退到首个源页面或译文页面。
 * @author zhenghq
 */
function resolveRestoredPageId(
  value: unknown,
  models: readonly DocumentModel[]
): string | null {
  if (typeof value === 'string') {
    for (const model of models) {
      if (model.pages.some((page) => page.pageId === value)) return value
    }
  }
  return models[0]?.pages[0]?.pageId ?? null
}

/**
 * 将查看器状态安全序列化为本地存储字符串。
 * @param state 当前工作台状态。
 * @returns 经过结构规范化的 JSON；无效状态回退为空状态。
 * @author zhenghq
 */
export function serializeDocumentViewerState(state: DocumentViewerState): string {
  return JSON.stringify(normalizeDocumentViewerState(state))
}

/**
 * 解析本地存储中的查看器状态，损坏 JSON 不得抛出到界面。
 * @param serialized 本地存储字符串。
 * @returns 可安全恢复的查看器状态；解析失败时返回空状态。
 * @author zhenghq
 */
export function parseDocumentViewerState(serialized: string): DocumentViewerState {
  try {
    return normalizeDocumentViewerState(JSON.parse(serialized))
  } catch {
    return createEmptyDocumentViewerState()
  }
}

/**
 * 校验重新授权后的文件是否与保存状态指向同一内容和版本。
 * @param expected 本地状态中保存的文件元数据。
 * @param authorized 主进程重新校验并计算 SHA-256 后的文件选择结果。
 * @returns 授权通过或稳定失败分类。
 * @author zhenghq
 */
export function validateRestoredDocumentViewerFile(
  expected: DocumentViewerFileState,
  authorized: import('../../shared/types.ts').DocumentFileSelectionResult
): RestoredDocumentFileValidationResult {
  if (authorized.status !== 'selected') return { ok: false, code: 'not-authorized' }
  if (authorized.path !== expected.path) return { ok: false, code: 'path-mismatch' }
  if (authorized.format.toLowerCase() !== expected.format.toLowerCase()) {
    return { ok: false, code: 'format-mismatch' }
  }
  if (authorized.size !== expected.size) return { ok: false, code: 'size-mismatch' }
  if (authorized.sha256.toLowerCase() !== expected.sha256.toLowerCase()) {
    return { ok: false, code: 'sha256-mismatch' }
  }
  return { ok: true }
}

/**
 * 将已保存的源与译文模型包装成只读恢复快照。
 * @param tab 已通过文件授权和内容指纹校验的完整 Tab 状态。
 * @returns 使用固定任务身份、不会触发旧任务 IPC 的完成态快照。
 * @author zhenghq
 */
export function createRestoredDocumentWorkspaceSnapshot(
  tab: DocumentViewerTabState
): DocumentWorkspaceSnapshot {
  const warningCount = countVisibleDocumentWarnings(tab.source.warnings, tab.translation.warnings)
  const translatedTargetCount = countTranslatableBlocks(tab.translation)
  return {
    jobId: RESTORED_DOCUMENT_JOB_ID,
    generation: 0,
    task: {
      jobId: RESTORED_DOCUMENT_JOB_ID,
      generation: 0,
      phase: 'layout',
      status: 'completed',
      progress: { completed: translatedTargetCount, total: translatedTargetCount },
      cancellationRequested: false,
      failedBlocks: 0,
      warningCount,
      phaseCompleted: true
    },
    percent: 100,
    source: tab.source,
    translation: tab.translation,
    sourcePreference: tab.sourceLang,
    targetPreference: tab.targetLang,
    languagePair: {
      sourceLang: tab.sourceLang,
      targetLang: tab.targetLang
    }
  }
}

/**
 * 统计模型中可翻译的顶层文本目标数量，用于恢复快照的完成进度。
 * @param model 已完成译文模型。
 * @returns 可翻译文本区块数量。
 * @author zhenghq
 */
function countTranslatableBlocks(model: DocumentModel): number {
  return model.pages.reduce((count, page) => count + page.blocks.filter((block) =>
    block.kind === 'text' && block.translatable
  ).length, 0)
}
