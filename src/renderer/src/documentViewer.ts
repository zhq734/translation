import { parseDocumentModel, type DocumentBlock, type DocumentModel, type DocumentPage } from '../../shared/documentTypes.ts'
import type { DocumentWorkspaceSnapshot } from '../../shared/documentWorkspace.ts'

/** 文档查看器状态在本地存储中的键名。 */
export const DOCUMENT_VIEWER_STATE_STORAGE_KEY = 'selection-translator.document-viewer-state'

/** 文档查看器状态结构版本；不兼容变更时递增。 */
export const DOCUMENT_VIEWER_STATE_VERSION = 2

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

/** 文档查看器完整可恢复状态。 */
export interface DocumentViewerState {
  /** 状态结构版本。 */
  version: typeof DOCUMENT_VIEWER_STATE_VERSION
  /** 当前文件元数据；没有打开文件时为 null。 */
  file: DocumentViewerFileState | null
  /** 用户选择的源语言偏好。 */
  sourceLang: string
  /** 用户选择的目标语言偏好。 */
  targetLang: string
  /** 原文与译文显示模式。 */
  viewMode: DocumentViewerMode
  /** 用户缩放比例，范围为 0.5 到 2。 */
  zoom: number
  /** 双栏滚动位置。 */
  scroll: DocumentViewerScrollState
  /** 当前阅读页面标识。 */
  activePageId: string | null
  /** 当前高亮区块标识。 */
  activeBlockId: string | null
  /** 已完成的原文模型；恢复时只用于本地展示。 */
  source: DocumentModel | null
  /** 已完成的译文模型；用于避免重新翻译已完成内容。 */
  translation: DocumentModel | null
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
    file: null,
    sourceLang: 'auto',
    targetLang: 'auto',
    viewMode: 'spread',
    zoom: 1,
    scroll: { source: 0, translation: 0 },
    activePageId: null,
    activeBlockId: null,
    source: null,
    translation: null
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
 * 规范化本地存储中的查看器状态；损坏数据整体回退，越界字段单独收敛。
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
  const candidate = value as Partial<DocumentViewerState>
  const candidateVersion = (value as { version?: unknown }).version
  const isLegacy = candidateVersion === 1
  if (!isLegacy && candidate.version !== DOCUMENT_VIEWER_STATE_VERSION) return empty
  if (candidate.file !== null && !isDocumentViewerFileState(candidate.file)) return empty
  const source = isLegacy ? null : parseDocumentViewerModel(candidate.source)
  const translation = isLegacy ? null : parseDocumentViewerModel(candidate.translation)
  if (!isLegacy && (!source || !translation)) return empty
  const sourceLang = typeof candidate.sourceLang === 'string' && candidate.sourceLang.trim()
    ? candidate.sourceLang.trim()
    : 'auto'
  const targetLang = typeof candidate.targetLang === 'string' && candidate.targetLang.trim()
    ? candidate.targetLang.trim()
    : 'auto'
  const viewMode: DocumentViewerMode = candidate.viewMode === 'source' || candidate.viewMode === 'translation'
    ? candidate.viewMode
    : candidate.viewMode === 'spread'
      ? 'spread'
      : legacyViewMode ?? 'spread'
  const scrollCandidate = candidate.scroll && typeof candidate.scroll === 'object'
    ? candidate.scroll as Partial<DocumentViewerScrollState>
    : {}
  const normalizeScroll = (position: unknown): number =>
    typeof position === 'number' && Number.isFinite(position) ? Math.max(0, position) : 0
  const models = [source, translation].filter((model): model is DocumentModel => model !== null)
  const activePageId = resolveRestoredPageId(candidate.activePageId, models)
  const anchorModel = models.find((model) => model.pages.some((page) => page.pageId === activePageId))
  const activeBlockId = typeof candidate.activeBlockId === 'string' && activePageId && anchorModel &&
    resolveDocumentBlockHighlight(anchorModel, activePageId, candidate.activeBlockId)
    ? candidate.activeBlockId
    : null
  return {
    version: DOCUMENT_VIEWER_STATE_VERSION,
    file: candidate.file ? {
      path: candidate.file.path,
      name: candidate.file.name.trim(),
      size: candidate.file.size,
      format: candidate.file.format.trim().toLowerCase(),
      sha256: candidate.file.sha256.trim()
    } : null,
    sourceLang,
    targetLang,
    viewMode,
    zoom: clampDocumentZoom(typeof candidate.zoom === 'number' ? candidate.zoom : 1),
    scroll: {
      source: normalizeScroll(scrollCandidate.source),
      translation: normalizeScroll(scrollCandidate.translation)
    },
    activePageId,
    activeBlockId,
    source,
    translation
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
 * @param state 已通过文件授权和内容指纹校验的工作台状态。
 * @returns 使用固定任务身份、不会触发旧任务 IPC 的完成态快照。
 * @author zhenghq
 */
export function createRestoredDocumentWorkspaceSnapshot(
  state: DocumentViewerState
): DocumentWorkspaceSnapshot {
  if (!state.source || !state.translation) {
    throw new Error('restored document state requires source and translation models')
  }
  const warningCount = state.source.warnings.length + state.translation.warnings.length
  const translatedTargetCount = countTranslatableBlocks(state.translation)
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
    source: state.source,
    translation: state.translation,
    sourcePreference: state.sourceLang,
    targetPreference: state.targetLang,
    languagePair: {
      sourceLang: state.sourceLang,
      targetLang: state.targetLang
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
