import {
  DOCUMENT_MAX_FILE_BYTES,
  DOCUMENT_ZIP_TAIL_BYTES,
  getDocumentZipCentralDirectoryRange,
  validateDocumentFile
} from '../../shared/documentFormat'
import type {
  DocumentBlock,
  DocumentContentArea,
  DocumentAsset,
  DocumentFormulaBlock,
  DocumentImageBlock,
  DocumentModel,
  DocumentOcrRegion,
  DocumentPage,
  DocumentTableBlock,
  DocumentTableCell,
  DocumentTextBlock,
  DocumentTextRun,
  DocumentTextStyle,
  DocumentWarning
} from '../../shared/documentTypes'
import {
  normalizeDocumentOcrRegionBox,
  resolveDocumentImageContentBox,
  resolveDocumentOcrRegionFlowTop,
  resolveDocumentOcrOverlayBox,
  resolveDocumentOcrTranslationHorizontalBounds,
  resolveOcrRegionFontSize,
  resolveOcrRegionGapBefore,
  resolveOcrRegionLineHeight,
  resolveOcrRegionPadding,
  shouldRenderDocumentOcrTranslationRegion,
  type DocumentOcrFlowRect
} from '../../shared/documentOcrLayout'
import type {
  DocumentAssetResult,
  DocumentFileSelectionResult,
  DocumentPlatformCapability,
  DocumentRunResult,
  DocumentSourceResult,
  DocumentWorkspaceSnapshot,
  DocumentWorkspaceTranslationUpdate
} from '../../shared/types'
import type { DocumentPartialExportSummary } from '../../shared/documentPartialExport'
import type { Settings } from '../../shared/types'
import { LANGUAGES, langLabel } from '../../shared/langs'
import { TRANSLATION_WATERMARK_LOGO_PATH } from '../../shared/translationWatermark'
import { canApplyDocumentTaskEvent } from '../../shared/documentTask'
import { applyDocumentWorkspaceTranslationUpdate } from '../../shared/documentWorkspace'
import {
  findDocumentTarget,
  parseDocumentTargetId,
  serializeDocumentBlockPath,
  type DocumentBlockPath
} from '../../shared/documentTargetLocator'
import {
  countVisibleDocumentWarnings,
  filterVisibleDocumentWarnings
} from '../../shared/documentWarnings'
import {
  collectRetryableDocumentTargetIds,
  resolveDocumentRetryActionState
} from '../../shared/documentCompletion'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.js?url'
import { startThemeRuntime } from './theme'
import { startLocaleRuntime } from './locale'
import { createDocumentHistoryController } from './documentHistoryController'
import { createDocumentNavigationController } from './documentNavigationController'
import { createDocumentExportController } from './documentExportController'
import { createDocumentManualEditController } from './documentManualEditController'
import { createDocumentSearchController } from './documentSearchController'
import { createDocumentBlockActionController } from './documentBlockActionController'
import {
  createDocumentDeferredTranslationRenderController,
  runAfterNextPaint
} from './documentDeferredTranslationRender'
import { hasUsableExportResult } from './documentExportAvailability'
import { createDocumentPdfDocumentCache } from './documentPdfDocumentCache'
import { createDocumentTranslationDomCache } from './documentTranslationDomCache'
import { preserveDocumentManualTranslationEdits } from '../../shared/documentManualTranslationEdits'
import {
  occupiesDocumentTranslationFlow,
  normalizeDocumentTableColumnWidths,
  resolveTranslationFlowBlockGap,
  resolveTranslationImageFlowGap,
  resolveTranslationFlowDecorationTop,
  type DocumentFlowDecorationAnchor,
  type DocumentFlowObstacle,
  resolveTranslationFlowGroupGeometry,
  resolveTranslationTableColumnWidths,
  resolveTranslationWatermarkHorizontalOffset
} from './documentPdfLayout'
import {
  shouldSyncDocumentScroll,
  type DocumentScrollSide
} from './documentScrollSync'
import {
  normalizeImageStackLayout,
  renderDocumentTableCellBlocks,
  resolveDocumentImageStackBounds,
  resolveDocumentImageStackMemberOffset,
  setCssPixelPropertyIfChanged,
  setInlinePixelPropertyIfChanged
} from './documentImageStackLayout'
import {
  createDocumentImageOverlayGroup,
  normalizeImageOverlayLayout,
  resolveDocumentImageOverlayBounds
} from './documentImageOverlayLayout'
import {
  calculateDocumentRemainingMilliseconds,
  formatDocumentDuration,
  formatFileSize
} from './documentFormatting'
import { resolvePreviewKind } from './documentPreviewKind'
import {
  applyScalableTextStyle,
  effectiveTextStyle,
  pdfPreviewFontFamily,
  styleProperties
} from './documentTextStyle'
import { resolveDocumentPdfImageAssetLocation } from './documentAssetRequest'
import {
  approvedDocumentSourceRequest,
  hasReusablePdfSourcePreview,
  isReadOnlyDocumentTab,
  isRestoredDocumentTab,
  resolveAuthorizedDocumentSourceRequest
} from './documentSourceAccess'
import {
  resolveDocumentTabScrollState,
  resolveDocumentTabScrollTarget,
  shouldRevealActiveDocumentTab
} from './documentTabScroll'
import {
  clampDocumentZoom,
  createRestoredDocumentWorkspaceSnapshot,
  DOCUMENT_VIEWER_STATE_STORAGE_KEY,
  DOCUMENT_VIEWER_STATE_VERSION,
  migrateRestoredPdfDocumentWorkspaceSnapshot,
  parseDocumentViewerState,
  resolveDocumentBlockHighlight,
  resolveFitDocumentZoom,
  serializeDocumentViewerState,
  validateRestoredDocumentViewerFile,
  type DocumentViewerFileState,
  type DocumentViewerMode,
  type DocumentViewerState,
  type DocumentViewerTabState
} from './documentViewer'

startThemeRuntime(window.api)
const localeRuntime = startLocaleRuntime(window.api)
pdfjsModule.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

import {
  actualLanguage,
  cancelButton,
  documentColumns,
  documentFileInput,
  documentFileTabsNextButton,
  documentFileTabsPreviousButton,
  documentPageInput,
  documentSearchInput,
  documentSearchNextButton,
  documentSearchPreviousButton,
  documentSearchStatus,
  documentSyncScrollButton,
  documentViewModeControl,
  documentWorkbenchReplaceButton,
  documentWorkspaceTabs,
  documentZoomValue,
  dropZone,
  editRedoButton,
  editUndoButton,
  exportButton,
  fileDetail,
  fileName,
  fileReplaceButton,
  fileSummary,
  historyButton,
  partialExportCancelButton,
  partialExportConfirmButton,
  partialExportDialog,
  partialExportRetryButton,
  partialExportSummary,
  partialStatus,
  progressBlocks,
  progressCount,
  progressPages,
  progressRemaining,
  progressStage,
  progressWarnings,
  progressbar,
  rerunButton,
  retryButton,
  sourceContent,
  sourceLanguageSelect,
  sourceOcrMode,
  sourcePageCount,
  startButton,
  targetLanguageSelect,
  titlebar,
  translationContent,
  translationHeading,
  translationPageCount,
  uploadPanel,
  uploadStatus,
  windowCloseButton,
  windowMaximizeButton,
  windowMinimizeButton,
  workbench,
  workbenchMeta,
  workbenchName
} from './documentElements'
import {
  DOCUMENT_GENERATION_STORAGE_KEY,
  DOCUMENT_VIEW_MODE_STORAGE_KEY,
  EMPTY_SELECTION,
  type DocumentPreviewKind,
  type DocumentRenderSide,
  type DocumentScrollPositions,
  type DocumentSelectionState,
  type DocumentTabStatus,
  type DocumentViewMode,
  type DocumentWorkspaceTab
} from './documentUiModel'


let selectionState: DocumentSelectionState = { ...EMPTY_SELECTION }
let platformCapability: DocumentPlatformCapability | null = null
let dragDepth = 0
/** 各任务首次观察到运行进度的本地时间，用于在不改变 IPC 快照协议的前提下估算剩余时间。 */
const documentTaskStartedAt = new Map<string, number>()
/** 当前 Renderer 任务代际；每次开始翻译递增。 */
let generation = readPersistedGeneration()
/** 当前主进程任务标识；未启动时为 null。 */
let activeJobId: string | null = null
/** 当前代际下已确认的主进程任务标识；首条进度事件到达前为 null。 */
let expectedJobId: string | null = null
/** 最近一次收到且属于当前任务的进度快照。 */
let latestSnapshot: DocumentWorkspaceSnapshot | null = null
/** 原文栏图片文字的展示方式；默认显示译文覆盖层，切换后显示 OCR 原文透明文字层。 */
let ocrDisplayMode: 'ocr-text' | 'translation' = 'translation'
/** 当前活动 Tab 是否仍有启动请求未返回；仅作为活动 Tab 的界面投影。 */
let documentStartInFlight = false
/** 当前活动 Tab 是否等待启动请求结束后按最新语言重译。 */
let pendingLanguageRetranslation = false
/** 当前活动 Tab 等待切换到的 OCR 展示模式；null 表示无待切换请求。 */
let pendingOcrModeTarget: 'ocr-text' | 'translation' | null = null
/** 当前活动 Tab 是否已发出模式切换请求且尚未收到主进程响应。 */
let ocrModeSwitchInFlight = false
/** 已发出但尚未确认的模式切换新代际；用于缓存早到的任务事件。 */
let pendingModeSwitchGeneration: number | null = null
/** 当前文档预览方式；默认保留现有的原文与译文双面布局。 */
let documentViewMode: DocumentViewMode = readDocumentViewMode()
/** 双栏滚动同步是否由用户开启。 */
let documentScrollSyncEnabled = true
/** 本轮联动中允许主动驱动另一侧的栏；直接操作另一侧时自动清空。 */
let documentScrollSyncedSide: DocumentScrollSide | null = null
/** 当前文档缩放比例，范围由查看器纯函数限制在 50% 到 200%。 */
let documentZoom = 1
/** 当前页面序号，从 1 开始；尚未渲染文档时为 1。 */
let currentDocumentPageNumber = 1
/** 当前高亮的区块标识；用于避免重复 DOM 查询。 */
let activeDocumentBlockId: string | null = null
/** 查看器状态保存节流计时器；短时间内的滚动和重排只写入一次。 */
let documentViewerStatePersistTimer: number | null = null
/** 恢复期间尚未完成重新授权的持久化 Tab；保存时必须合并，避免覆盖尚未恢复的文件。 */
let pendingRestoredDocumentViewerTabs: DocumentViewerTabState[] = []
/** 当前恢复会话代际；关闭全部 Tab 后递增，使旧后台恢复任务失效。 */
let documentViewerRestoreEpoch = 0
/** 已恢复 Tab 的原始状态位置；后台逐个补入时用于保持用户原来的 Tab 顺序。 */
const restoredDocumentTabIndexes = new Map<string, number>()
/** 部分导出确认对话框的待决结果；关闭对话框时统一解析为取消。 */
let resolvePartialExportConfirmation: ((confirmed: boolean) => void) | null = null
/** 等待下一帧合并执行的渲染回调。 */
let pendingRenderFrame: number | null = null
/** 当前文档图片 Blob URL，重绘或关闭时统一释放。 */
const assetUrls = new Map<string, string>()
/** 图片资源请求缓存；同一资源的并发渲染必须共享同一次读取，避免重复 IPC 与竞争。 */
const assetRequests = new Map<string, Promise<string | null>>()
/** 图片资源代际；切换文件或释放缓存后，迟到请求不得重新写回旧文档资源。 */
let assetUrlEpoch = 0

/** 已解析 PDF 文档缓存；Tab 切换重渲染原文时按文件指纹复用，避免重复读取与解析。 */
const documentPdfDocumentCache =
  createDocumentPdfDocumentCache<Awaited<ReturnType<typeof pdfjsModule.getDocument>['promise']>>()
/** 译文 DOM 缓存；Tab 切换时按签名复用已构建 DOM，避免整棵同步重建。 */
const translationDomCache = createDocumentTranslationDomCache()
// 缓存淘汰时同步释放对应 Tab 的图片资源，避免大文档多 Tab 长期占用内存。
translationDomCache.onEvict(revokeAssetUrlsForTab)

/** 当前 HTML 源文预览 Blob URL；同一时间只允许存在一个。 */
let htmlPreviewUrl: string | null = null

/** 当前 HTML 源文预览请求身份，用于阻止旧异步响应覆盖新文档。 */
let htmlPreviewRequestIdentity = ''
/** 最近一次真实用户滚动意图所属的栏；程序性滚动不会更新该值。 */
let userScrollSide: DocumentScrollSide | null = null
/** 用户滚动意图的有效期；滚轮和键盘停止后仍允许一次比例联动。 */
let userScrollIntentTimer: number | null = null
/** 译文页面正在执行流式重排；期间禁止译文侧反向驱动原文。 */
let translationLayoutUpdating = false
/** 本轮流式更新开始前捕获的双栏位置；同一轮多次增量复用首帧快照。 */
let pendingTranslationLayoutScrollPositions: DocumentScrollPositions | null = null
/** 程序性写入目标栏时记录预期 scrollTop，供后续 scroll 事件消费。 */
const pendingProgrammaticScrollTops = new WeakMap<HTMLElement, number>()
/** 文件预检读取的头部字节数。 */
const DOCUMENT_HEAD_BYTES = 8192
/** 已渲染的源预览身份；PDF 只按文件指纹复用，避免流式事件重载 Canvas。 */
let renderedSourcePreviewIdentity = ''
/** 已渲染源预览所属的 Tab；切换文件后禁止复用上一 Tab 的原文身份。 */
let renderedSourcePreviewTabId: string | null = null
/** 已渲染源预览对应的文件 SHA-256；同一 Tab 内容变化时也必须重绘。 */
let renderedSourcePreviewSha256 = ''
/** 已渲染的源告警签名；告警变化时只更新告警层。 */
let renderedSourceWarningSignature = ''
/** 已渲染的译文内容签名。 */
let renderedTranslationSignature = ''
/** 已渲染译文所属的 Tab；切换文件后禁止复用上一 Tab 的译文 DOM。 */
let renderedTranslationTabId: string | null = null
/** 已渲染译文对应的文件 SHA-256；同一 Tab 内容变化时也必须重绘。 */
let renderedTranslationSha256 = ''
/** 当前译文预览的渲染方式；结构变化时才允许回退整页重绘。 */
let renderedTranslationPreviewKind: DocumentPreviewKind | null = null
/** 是否已完成过译文栏首次渲染；空模型与空签名不能省略初始等待态。 */
let hasRenderedTranslation = false
/** 已渲染的译文告警签名；告警变化时只更新告警层。 */
let renderedTranslationWarningSignature = ''
/** 每个 PDF 预览容器当前有效的异步渲染令牌，避免旧渲染覆盖新文件。 */
const pdfRenderTokens = new WeakMap<HTMLElement, symbol>()
/** 每个 PDF 预览容器的资源清理函数；切换文件或重绘时取消观察与未完成绘制。 */
const pdfPreviewCleanups = new WeakMap<HTMLElement, () => void>()
/** 当前译文 PDF 页面的缩放观察器；重绘前统一断开，避免旧页面泄漏。 */
let pageScaleObserver: ResizeObserver | null = null
/** 当前待执行的译文页面重排帧；同一帧内合并缩放、字体与图片尺寸变化。 */
let pageLayoutFrame: number | null = null
/** 当前译文页面重排调度器；参数表示是否重新计算页面宽度缩放。 */
let activePageLayoutScheduler: ((recalculateScale?: boolean) => void) | null = null
/** 当前译文水印的尺寸观察器；容器宽度变化时重新计算图案横向起点。 */
let watermarkResizeObserver: ResizeObserver | null = null
/** 最近一次读取到的完整设置，供界面语言变化时重建语言下拉。 */
let currentSettings: Settings | null = null
/** 最近一次已提交的语言组合，用于忽略程序化回填触发的 change 事件。 */
let appliedLanguagePair = ''
/** 所有已打开文件 Tab，按顶栏展示顺序保存。 */
let documentTabs: DocumentWorkspaceTab[] = []
/** 当前激活 Tab 标识；没有打开文件时为 null。 */
let activeDocumentTabId: string | null = null
/** 上一次已自动滚动到可视区的激活 Tab；用于区分切换与普通状态刷新。 */
let lastRevealedActiveDocumentTabId: string | null = null
/** 下一个 Tab 序号，用于生成稳定且不重复的标识。 */
let nextDocumentTabSequence = 1
/**
 * 使用当前界面语言翻译词条。
 * @param key 语义化词条 key。
 * @param params 可选插值参数。
 * @returns 当前语言下的词条文本。
 * @author zhenghq
 */
function t(key: string, params?: Record<string, string | number>): string {
  return localeRuntime.translator.t(key, params)
}

const documentHistory = createDocumentHistoryController({
  t,
  getLocale: () => localeRuntime.locale,
  formatFileSize,
  validationMessage,
  isPlatformSupported: () => Boolean(platformCapability?.supported),
  getDocumentTabs: () => documentTabs,
  findDocumentTabByPath,
  addDocumentTab: (tab) => documentTabs.push(tab),
  allocateDocumentTabId: () => `document-tab-${nextDocumentTabSequence++}`,
  activateDocumentTab,
  createDocumentTab: (result, options) => createDocumentTab(result, options),
  startDocumentTabTranslation: (tab) => startDocumentTabTranslation(tab),
  getViewerDefaults: () => ({
    zoom: documentZoom,
    viewMode: documentViewMode,
    scrollSyncEnabled: documentScrollSyncEnabled
  }),
  resolveDocumentTabStatus
})

const documentNavigation = createDocumentNavigationController({
  t,
  getSnapshot: () => latestSnapshot,
  getActiveDocumentTab,
  getCurrentPageNumber: () => currentDocumentPageNumber,
  setCurrentPageNumber: (pageNumber) => {
    currentDocumentPageNumber = pageNumber
    const tab = getActiveDocumentTab()
    if (tab) tab.pageNumber = pageNumber
  },
  setActiveBlockId: (blockId) => {
    activeDocumentBlockId = blockId
  },
  getViewMode: () => documentViewMode,
  getZoom: () => documentZoom,
  setZoom: setDocumentZoom,
  setFitZoom: setDocumentFitZoom,
  stepZoom: stepDocumentZoom,
  scheduleStatePersist: scheduleDocumentViewerStatePersist,
  getSourceContent: () => sourceContent,
  getTranslationContent: () => translationContent,
  getPageContentWidth: documentPageContentWidth,
  getPageAvailableHeight: documentPageAvailableHeight
})

const documentExport = createDocumentExportController({
  t,
  getActiveDocumentTab,
  getActiveDocumentTabId: () => activeDocumentTabId,
  isDocumentTabOpen: (tab) => documentTabs.includes(tab),
  activateDocumentTab,
  flushSnapshotRenderForTab,
  isReadOnlyDocumentTab,
  approvedDocumentSourceRequest,
  revealFirstIncompleteTarget,
  confirmPartialExport,
  localizeDocumentWarning,
  hasUsableExportResult,
  retryFailedDocumentTranslation,
  getApi: () => window.api,
  commitActiveManualEdit: () => documentManualEdit.commitActiveEdit()
})

const documentManualEdit = createDocumentManualEditController({
  getActiveDocumentTab,
  getTranslationContent: () => translationContent,
  onCommit: (tab) => {
    // 手改直接改写译文模型，必须让内容签名失配以触发下一次按需重绘，并恢复样式与检索高亮。
    if (tab.id === activeDocumentTabId) renderedTranslationSignature = ''
    documentManualEdit.refresh()
    documentSearch.refresh()
    if (tab.snapshot) renderTaskState(tab.snapshot, tab)
    scheduleDocumentViewerStatePersist()
  },
  onHistoryChange: refreshDocumentEditHistoryButtons
})

/**
 * 同步译文手改回退与前进按钮的可用状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function refreshDocumentEditHistoryButtons(): void {
  editUndoButton.disabled = !documentManualEdit.canUndo()
  editRedoButton.disabled = !documentManualEdit.canRedo()
}

const documentSearch = createDocumentSearchController({
  t,
  getInput: () => documentSearchInput,
  getStatus: () => documentSearchStatus,
  getPreviousButton: () => documentSearchPreviousButton,
  getNextButton: () => documentSearchNextButton,
  getSourceContent: () => sourceContent,
  getTranslationContent: () => translationContent
})

const documentBlockActions = createDocumentBlockActionController({
  t,
  getTranslationContent: () => translationContent,
  getActiveDocumentTab,
  isEditing: () => documentManualEdit.isEditing(),
  commitActiveEdit: () => documentManualEdit.commitActiveEdit(),
  startEdit: (element) => documentManualEdit.startEdit(element),
  retranslateTarget: (targetId) => retranslateDocumentTarget(targetId),
  undo: () => documentManualEdit.undo(),
  redo: () => documentManualEdit.redo(),
  onHistoryChange: refreshDocumentEditHistoryButtons
})

const deferredTranslationRender = createDocumentDeferredTranslationRenderController({
  isTranslationRendered: (tab) => hasRenderedTranslation &&
    renderedTranslationTabId === tab.id &&
    renderedTranslationSha256 === tab.selection.sha256,
  canRender: (snapshot, tab) => tab.id === activeDocumentTabId && tab.snapshot === snapshot,
  render: (snapshot, tab) => renderSnapshot(snapshot, tab),
  onError: (error) => console.error(
    'document-restored-translation-render-failed',
    error instanceof Error ? error.name : 'unknown'
  )
})

/** 快照首屏渲染选项；恢复态可先完成原文首帧，再在独立任务中构建译文。 */
interface DocumentSnapshotRenderOptions {
  /** 是否延迟译文 DOM 构建，直到原文预览完成首次绘制。 */
  deferTranslationUntilSourceReady?: boolean
}

/** 文档模型渲染选项；仅原文侧使用预览就绪回调。 */
interface DocumentModelRenderOptions {
  /** 原文首帧完成后通知调用方；PDF 由首张 Canvas 绘制触发。 */
  onSourcePreviewReady?: () => void
}

/**
 * 读取上次保存的文档预览方式。
 * @returns 有效偏好值；存储不可用或内容无效时返回双面显示。
 * @author zhenghq
 */
function readDocumentViewMode(): DocumentViewMode {
  try {
    const storedMode = localStorage.getItem(DOCUMENT_VIEW_MODE_STORAGE_KEY)
    return storedMode === 'source' || storedMode === 'translation' ? storedMode : 'spread'
  } catch {
    return 'spread'
  }
}

/**
 * 保存文档预览方式，供下次打开文件翻译窗口时恢复。
 * @param mode 用户选择的预览方式。
 * @returns 无返回值。
 * @author zhenghq
 */
function persistDocumentViewMode(mode: DocumentViewMode): void {
  try {
    localStorage.setItem(DOCUMENT_VIEW_MODE_STORAGE_KEY, mode)
  } catch {
    // 存储不可用时只影响下次启动的偏好恢复，当前窗口仍可正常切换。
  }
}

/**
 * 从 sessionStorage 恢复上次任务代际；存储不可用时从零开始。
 * @returns 可继续递增的非负整数。
 * @author zhenghq
 */
function readPersistedGeneration(): number {
  try {
    const value = Number(sessionStorage.getItem(DOCUMENT_GENERATION_STORAGE_KEY))
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  } catch {
    return 0
  }
}

/**
 * 生成并持久化下一次任务代际，确保 Renderer 重载后仍严格递增。
 * @returns 新的任务代际。
 * @author zhenghq
 */
function nextGeneration(): number {
  generation = Math.max(generation, readPersistedGeneration()) + 1
  try {
    sessionStorage.setItem(DOCUMENT_GENERATION_STORAGE_KEY, String(generation))
  } catch {
    // 存储不可用时仍使用内存代际，当前窗口内的事件隔离不受影响。
  }
  return generation
}

/**
 * 采用主进程建议的代际，并同步到当前 Renderer 的内存与会话存储。
 * 仅当建议值严格大于本地值时生效，避免异常响应让代际回退。
 * @param suggestedGeneration 主进程返回的下一可用代际。
 * @returns 是否成功采用。
 * @author zhenghq
 */
function adoptSuggestedGeneration(suggestedGeneration: number | undefined): boolean {
  const currentGeneration = Math.max(generation, readPersistedGeneration())
  if (!Number.isSafeInteger(suggestedGeneration) || (suggestedGeneration ?? 0) <= currentGeneration) {
    return false
  }
  generation = suggestedGeneration as number
  try {
    sessionStorage.setItem(DOCUMENT_GENERATION_STORAGE_KEY, String(generation))
  } catch {
    // 存储不可用时仍可在当前页面内完成本次重试。
  }
  return true
}

/**
 * 将解析告警按稳定 code 转为当前界面语言；未知 code 使用解析器兜底说明。
 * @param warning 文档告警。
 * @returns 当前语言下的告警说明。
 * @author zhenghq
 */
function localizeDocumentWarning(warning: DocumentWarning): string {
  const key = `document.warning.${warning.code}`
  return localeRuntime.translator.has(key)
    ? t(key)
    : warning.message || t('document.warning.unknown')
}

/**
 * 填充文档翻译顶部栏的源语言和目标语言选项。
 * @param settings 当前应用设置。
 * @param sourceValue 可选源语言回填值；省略时读取设置默认值。
 * @param targetValue 可选目标语言回填值；省略时读取设置默认值。
 * @returns 无返回值。
 * @author zhenghq
 */
function populateDocumentLanguages(
  settings: Settings,
  sourceValue?: string,
  targetValue?: string
): void {
  const selectedSource = sourceValue?.trim() || sourceLanguageSelect.value || settings.sourceLang || 'auto'
  const selectedTarget = targetValue?.trim() || targetLanguageSelect.value || settings.targetLang || 'auto'
  sourceLanguageSelect.replaceChildren()
  targetLanguageSelect.replaceChildren()
  sourceLanguageSelect.add(new Option(t('popup.autoDetect'), 'auto'))
  targetLanguageSelect.add(new Option(t('popup.autoBilingual'), 'auto'))
  for (const language of LANGUAGES) {
    const label = langLabel(language.code, localeRuntime.locale)
    sourceLanguageSelect.add(new Option(label, language.code))
    targetLanguageSelect.add(new Option(label, language.code))
  }
  sourceLanguageSelect.value = selectedSource || 'auto'
  if (!sourceLanguageSelect.value) sourceLanguageSelect.value = 'auto'
  targetLanguageSelect.value = selectedTarget || 'auto'
  if (!targetLanguageSelect.value) targetLanguageSelect.value = 'auto'
  appliedLanguagePair = `${sourceLanguageSelect.value}\u0000${targetLanguageSelect.value}`
}

/**
 * 使用任务快照中的实际语言对更新语言提示；未解析时隐藏提示。
 * @param languagePair 文档级解析后的实际语言对。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderActualLanguage(languagePair?: DocumentWorkspaceSnapshot['languagePair']): void {
  if (!languagePair) {
    actualLanguage.textContent = ''
    actualLanguage.hidden = true
    return
  }
  const direction = `${langLabel(languagePair.sourceLang, localeRuntime.locale)} → ${langLabel(languagePair.targetLang, localeRuntime.locale)}`
  actualLanguage.textContent = t('document.actualLanguage', { direction })
  actualLanguage.hidden = false
}

/**
 * 读取设置并初始化文档翻译语言下拉。
 * @returns 初始化完成后的 Promise。
 * @author zhenghq
 */
async function initializeDocumentLanguages(): Promise<void> {
  try {
    currentSettings = await window.api.getSettings()
    populateDocumentLanguages(currentSettings)
  } catch {
    // 设置读取失败时仍提供自动检测与自动中英互译，保证文档翻译可启动。
    currentSettings = null
    populateDocumentLanguages({ sourceLang: 'auto', targetLang: 'auto' } as Settings)
  }
}

/**
 * 从本地缓存恢复上次完成的文档译文工作台。
 * 首个阶段只等待上次活动 Tab 的文件重新授权、指纹校验和原文渲染；其他 Tab 随后在后台按原顺序补入。
 * 这样历史中保留的大文件不会阻塞用户重新打开工作台，同时所有恢复文件仍必须通过内容指纹校验。
 * @returns 活动 Tab 恢复完成后的 Promise；没有缓存或所有候选都失效时保持上传态。
 * @author zhenghq
 */
async function restoreDocumentViewerState(): Promise<void> {
  const state = readDocumentViewerState()
  if (state.tabs.length === 0 || !platformCapability?.supported) return
  const restoreEpoch = ++documentViewerRestoreEpoch
  const activeSavedIndex = Math.max(
    0,
    state.tabs.findIndex((savedTab) => savedTab.id === state.activeTabId)
  )
  const activeSavedTab = state.tabs[activeSavedIndex]!
  pendingRestoredDocumentViewerTabs = [...state.tabs]
  restoredDocumentTabIndexes.clear()

  let activeTab: DocumentWorkspaceTab | null = null
  let activeTabIndex = activeSavedIndex
  try {
    activeTab = await restoreDocumentViewerTab(activeSavedTab)
  } finally {
    removePendingRestoredDocumentViewerTab(activeSavedTab.selection.path)
  }
  // 上次活动文件已移动、删除或内容变化时，只在首屏阶段继续寻找首个有效文件作为回退。
  if (!activeTab) {
    for (let index = 0; index < state.tabs.length; index += 1) {
      if (index === activeSavedIndex) continue
      const savedTab = state.tabs[index]!
      try {
        activeTab = await restoreDocumentViewerTab(savedTab)
      } finally {
        removePendingRestoredDocumentViewerTab(savedTab.selection.path)
      }
      if (activeTab) {
        activeTabIndex = index
        break
      }
    }
  }
  if (!activeTab || restoreEpoch !== documentViewerRestoreEpoch) {
    if (restoreEpoch === documentViewerRestoreEpoch) pendingRestoredDocumentViewerTabs = []
    return
  }

  documentTabs = [activeTab]
  restoredDocumentTabIndexes.set(activeTab.id, activeTabIndex)
  activeDocumentTabId = activeTab.id
  syncActiveTabMirror(activeTab)
  syncDocumentViewModeControls()
  renderDocumentTabs()
  renderActiveDocumentTab(getActiveDocumentTab()!, { deferTranslationUntilSourceReady: true })
  // 模型 DOM 挂载后才能恢复持久化高亮，不能在渲染前操作旧节点。
  const activeBlockId = getActiveDocumentTab()?.activeBlockId
  if (activeBlockId) requestAnimationFrame(() => documentNavigation.highlightBlock(activeBlockId))
  // 首屏原文已经可见，剩余文件在后台逐个重新授权并补入顶栏，不阻塞设置页返回工作台。
  void restoreRemainingDocumentViewerTabs(state, restoreEpoch)
}

/**
 * 重新授权并恢复单个持久化 Tab。
 * @param savedTab 待恢复的持久化 Tab。
 * @returns 通过文件指纹校验的只读工作台 Tab；文件失效或校验异常时返回 null。
 * @author zhenghq
 */
async function restoreDocumentViewerTab(savedTab: DocumentViewerTabState): Promise<DocumentWorkspaceTab | null> {
  try {
    const authorized = await window.api.approveDocumentFile(savedTab.selection.path)
    if (!validateRestoredDocumentViewerFile(savedTab.selection, authorized).ok) return null
    return createRestoredDocumentWorkspaceTab(savedTab)
  } catch {
    // 单个文件移动、删除或内容变化时只丢弃该 Tab，不能阻断其他历史文件恢复。
    return null
  }
}

/**
 * 在活动 Tab 首屏完成后逐个恢复其余持久化 Tab。
 * 后台恢复只增量更新顶栏，不修改活动 Tab；用户期间手动打开同一路径时直接跳过，避免重复 Tab。
 * @param state 本次读取的完整查看器状态。
 * @param restoreEpoch 启动后台任务时的恢复会话代际。
 * @returns 全部剩余 Tab 处理完成后的 Promise。
 * @author zhenghq
 */
async function restoreRemainingDocumentViewerTabs(
  state: DocumentViewerState,
  restoreEpoch: number
): Promise<void> {
  for (let index = 0; index < state.tabs.length; index += 1) {
    if (restoreEpoch !== documentViewerRestoreEpoch) return
    const savedTab = state.tabs[index]!
    if (findDocumentTabByPath(savedTab.selection.path)) {
      removePendingRestoredDocumentViewerTab(savedTab.selection.path)
      continue
    }
    let tab: DocumentWorkspaceTab | null = null
    try {
      tab = await restoreDocumentViewerTab(savedTab)
    } finally {
      removePendingRestoredDocumentViewerTab(savedTab.selection.path)
    }
    if (restoreEpoch !== documentViewerRestoreEpoch) return
    if (!tab || findDocumentTabByPath(savedTab.selection.path)) continue
    insertRestoredDocumentTabAtOriginalPosition(tab, index)
    renderDocumentTabs()
  }
}

/**
 * 将后台恢复完成的 Tab 放回持久化时的原始相对位置。
 * @param tab 已完成授权和模型恢复的 Tab。
 * @param originalIndex 该 Tab 在持久化状态中的原始下标。
 * @returns 无返回值。
 * @author zhenghq
 */
function insertRestoredDocumentTabAtOriginalPosition(
  tab: DocumentWorkspaceTab,
  originalIndex: number
): void {
  restoredDocumentTabIndexes.set(tab.id, originalIndex)
  const nextTabIndex = documentTabs.findIndex((candidate) => {
    const candidateIndex = restoredDocumentTabIndexes.get(candidate.id)
    return candidateIndex !== undefined && candidateIndex > originalIndex
  })
  if (nextTabIndex >= 0) documentTabs.splice(nextTabIndex, 0, tab)
  else documentTabs.push(tab)
}

/**
 * 从待恢复集合中移除已经处理过的文件。
 * @param path 已尝试重新授权或已经手动打开的文件路径。
 * @returns 无返回值。
 * @author zhenghq
 */
function removePendingRestoredDocumentViewerTab(path: string): void {
  pendingRestoredDocumentViewerTabs = pendingRestoredDocumentViewerTabs.filter((tab) =>
    tab.selection.path !== path
  )
}

/**
 * 将已重新授权的持久化 Tab 转换为只读工作台 Tab。
 * @param savedTab 已通过文件内容指纹校验的持久化 Tab。
 * @returns 使用固定恢复任务身份、保留独立阅读状态的工作台 Tab。
 * @author zhenghq
 */
function createRestoredDocumentWorkspaceTab(savedTab: DocumentViewerTabState): DocumentWorkspaceTab {
  const snapshot = migrateRestoredPdfDocumentWorkspaceSnapshot(
    createRestoredDocumentWorkspaceSnapshot(savedTab)
  )
  const restoredModel = snapshot.source ?? snapshot.translation
  const restoredPageIndex = restoredModel && savedTab.activePageId
    ? restoredModel.pages.findIndex((page) => page.pageId === savedTab.activePageId)
    : -1
  return {
    id: `document-tab-${nextDocumentTabSequence++}`,
    sourceKind: 'restored',
    selection: {
      path: savedTab.selection.path,
      name: savedTab.selection.name,
      size: savedTab.selection.size,
      format: savedTab.selection.format,
      sha256: savedTab.selection.sha256,
      error: null
    },
    snapshot,
    activeJobId: null,
    expectedJobId: null,
    generation: 0,
    startInFlight: false,
    status: 'completed',
    scrollPositions: { ...savedTab.scroll },
    zoom: savedTab.zoom,
    viewMode: savedTab.viewMode,
    pageNumber: restoredPageIndex >= 0 ? restoredPageIndex + 1 : savedTab.pageNumber,
    scrollSyncEnabled: savedTab.scrollSyncEnabled,
    sourceLang: savedTab.sourceLang,
    targetLang: savedTab.targetLang,
    ocrDisplayMode: savedTab.ocrDisplayMode,
    activeBlockId: savedTab.activeBlockId,
    pendingLanguageRetranslation: false,
    pendingOcrModeTarget: null,
    ocrModeSwitchInFlight: false,
    pendingModeSwitchGeneration: null,
    pendingModeSwitchSnapshot: null,
    pendingModeSwitchSnapshotTerminal: false,
    languageRevision: 0,
    sourceAuthorized: true
  }
}

/**
 * 在语言切换后取消旧任务，并使用新语言重新翻译当前文档。
 * 上传态只记录选择；工作台已有任务时立即重译。
 * @returns 无返回值。
 * @author zhenghq
 */
async function retranslateDocumentAfterLanguageChange(): Promise<void> {
  const tab = getActiveDocumentTab()
  if (!tab?.selection.path || workbench.hidden) return
  scheduleDocumentViewerStatePersist()
  const nextPair = `${sourceLanguageSelect.value}\u0000${targetLanguageSelect.value}`
  if (nextPair === `${tab.sourceLang}\u0000${tab.targetLang}`) return
  const readOnly = isReadOnlyDocumentTab(tab)
  if (readOnly && !prepareDocumentTabForLanguageRetranslation(tab)) {
    // 未重新授权的历史/恢复文档只能继续回放旧译文，必须明确提示而不是静默忽略。
    partialStatus.textContent = t('document.error.unreadable')
    partialStatus.hidden = false
    refreshActiveTabMirror(tab)
    return
  }
  if (tab.startInFlight) {
    tab.pendingLanguageRetranslation = true
    tab.sourceLang = sourceLanguageSelect.value || tab.sourceLang
    tab.targetLang = targetLanguageSelect.value || tab.targetLang
    refreshActiveTabMirror(tab)
    return
  }
  tab.sourceLang = sourceLanguageSelect.value || tab.sourceLang
  tab.targetLang = targetLanguageSelect.value || tab.targetLang
  appliedLanguagePair = nextPair
  scheduleDocumentViewerStatePersist()
  const revision = ++tab.languageRevision
  const jobId = tab.activeJobId ?? tab.expectedJobId
  const jobGeneration = tab.generation
  await cancelDocumentJob(jobId, jobGeneration)
  if (!documentTabs.includes(tab) || revision !== tab.languageRevision) return
  if (jobId) await releaseDocumentJob(jobId)
  await startDocumentTabTranslation(tab)
}

/**
 * 将已重新授权的只读历史或恢复文档提升为可执行任务。
 * 旧快照仅用于阅读回放，不能复用其中的任务标识；提升时清除快照与任务身份，
 * 后续由 startDocumentTabTranslation 使用当前文件指纹和语言选择创建新任务。
 * @param tab 用户主动切换语言的历史或恢复文档 Tab。
 * @returns 源文件已授权且 Tab 成功提升时返回 true；否则返回 false。
 * @author zhenghq
 */
function prepareDocumentTabForLanguageRetranslation(tab: DocumentWorkspaceTab): boolean {
  if (!isReadOnlyDocumentTab(tab) || !tab.sourceAuthorized || !tab.selection.path ||
    !tab.selection.sha256) {
    return false
  }
  tab.sourceKind = 'task'
  tab.snapshot = null
  tab.activeJobId = null
  tab.expectedJobId = null
  tab.generation = nextGeneration()
  tab.status = 'idle'
  tab.pendingLanguageRetranslation = false
  resetDocumentModeSwitchState(tab)
  tab.languageRevision += 1
  return true
}

/**
 * 判断当前文档是否具备从源文件重新执行翻译的条件。
 * 普通任务始终可重跑；恢复态与历史态只有在源文件已重新授权且文件指纹完整时才可提升。
 * @param tab 待检查的文档 Tab。
 * @returns 可执行重新翻译时返回 true。
 * @author zhenghq
 */
function canRetranslateDocumentTab(
  tab: DocumentWorkspaceTab | null | undefined
): tab is DocumentWorkspaceTab {
  if (!tab || !tab.selection.path) return false
  if (!isReadOnlyDocumentTab(tab)) return true
  return tab.sourceAuthorized && Boolean(tab.selection.sha256)
}

/**
 * 将校验拒绝码转换为可本地化的用户提示。
 * @param code 稳定拒绝分类。
 * @returns 当前语言下的提示文本。
 * @author zhenghq
 */
function validationMessage(code: string): string {
  const keys: Record<string, string> = {
    'unsupported-format': 'document.error.invalidFile',
    'invalid-header': 'document.error.invalidFile',
    'empty-file': 'document.error.invalidFile',
    'too-large': 'document.error.tooLarge',
    unreadable: 'document.error.unreadable'
  }
  return t(keys[code] ?? 'document.error.invalidFile', {
    maxSize: formatFileSize(DOCUMENT_MAX_FILE_BYTES)
  })
}

/**
 * 根据当前选择状态刷新上传卡片、开始按钮与状态提示。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderSelectionState(): void {
  const hasFile = Boolean(selectionState.path)
  fileSummary.hidden = !hasFile
  startButton.disabled = !hasFile || !platformCapability?.supported
  // 文件通过预检后立即提供模式选择，不等待解析或 OCR 完成。
  sourceOcrMode.hidden = !(
    hasFile &&
    !selectionState.error &&
    (selectionState.format === 'pdf' || selectionState.format === 'image')
  )
  syncOcrDisplayModeControls()
  if (hasFile) {
    fileName.textContent = selectionState.name
    fileDetail.textContent = `${selectionState.format.toUpperCase()} · ${formatFileSize(selectionState.size)}`
  }
  uploadStatus.textContent = selectionState.error ? validationMessage(selectionState.error) : ''
  uploadStatus.dataset.state = selectionState.error ? 'error' : 'normal'
  dropZone.setAttribute('aria-invalid', String(Boolean(selectionState.error)))
  if (!platformCapability?.supported && platformCapability) {
    uploadStatus.textContent = platformCapability.reason === 'windows-7-unsupported'
      ? t('document.error.windows7Unsupported')
      : t('document.error.unsupportedPlatform')
    uploadStatus.dataset.state = 'error'
  }
}

/**
 * 按绝对路径查找已打开的文件 Tab。
 * @param path 文件绝对路径。
 * @returns 已打开的 Tab；不存在时返回 null。
 * @author zhenghq
 */
function findDocumentTabByPath(path: string): DocumentWorkspaceTab | null {
  return documentTabs.find((tab) => tab.selection.path === path) ?? null
}

/**
 * 从快照源模型或译文模型中查找资源元数据。
 * @param tab 资源所属文档 Tab。
 * @param assetId 稳定资源标识。
 * @returns 匹配的资源元数据；不存在时返回 undefined。
 * @author zhenghq
 */
function findDocumentAssetMetadata(
  tab: DocumentWorkspaceTab,
  assetId: string
): DocumentAsset | undefined {
  return tab.snapshot?.source?.assets.find((asset) => asset.assetId === assetId) ??
    tab.snapshot?.translation?.assets.find((asset) => asset.assetId === assetId)
}

/**
 * 读取本地保存的文档查看器状态；存储缺失或损坏时安全回退为空状态。
 * @returns 可安全恢复的查看器状态。
 * @author zhenghq
 */
function readDocumentViewerState(): DocumentViewerState {
  try {
    return parseDocumentViewerState(localStorage.getItem(DOCUMENT_VIEWER_STATE_STORAGE_KEY) ?? '')
  } catch {
    return parseDocumentViewerState('')
  }
}

/**
 * 将查看器状态写入本地存储；存储不可用时只影响下次恢复。
 * @param state 待保存的查看器状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function writeDocumentViewerState(state: DocumentViewerState): void {
  try {
    localStorage.setItem(DOCUMENT_VIEWER_STATE_STORAGE_KEY, serializeDocumentViewerState(state))
  } catch {
    // 隐私模式或配额不足时仍保持当前窗口可用，不把存储错误暴露给用户。
  }
}

/**
 * 删除本地保存的文档查看器状态。
 * 关闭全部文件 Tab 后必须移除旧快照，避免下次打开页面恢复已经关闭的文件。
 * @returns 无返回值。
 * @author zhenghq
 */
function removeDocumentViewerState(): void {
  try {
    localStorage.removeItem(DOCUMENT_VIEWER_STATE_STORAGE_KEY)
  } catch {
    // 存储不可用时没有可恢复的旧状态，保持当前窗口正常关闭即可。
  }
}

/**
 * 将所有已完成的文件 Tab、阅读位置和模型保存到本地存储。
 * 未完成翻译或没有源/译文模型的 Tab 不写入，避免下次恢复出不完整任务。
 * @returns 无返回值。
 * @author zhenghq
 */
function persistActiveDocumentViewerState(): void {
  if (documentViewerStatePersistTimer !== null) {
    window.clearTimeout(documentViewerStatePersistTimer)
    documentViewerStatePersistTimer = null
  }
  const activeTab = getActiveDocumentTab()
  if (activeTab) {
    saveDocumentTabScroll(activeTab)
    saveDocumentTabViewerState(activeTab)
  }
  const persistedTabs = documentTabs.flatMap((tab) => {
    const savedTab = createPersistedDocumentViewerTab(tab)
    return savedTab ? [savedTab] : []
  })
  // 后台恢复尚未完成时，当前 Tab 集合不包含全部旧文件；必须把待恢复快照合并写入，避免覆盖丢失。
  const persistedPaths = new Set(persistedTabs.map((tab) => tab.selection.path))
  const pendingTabs = pendingRestoredDocumentViewerTabs.filter((tab) =>
    !persistedPaths.has(tab.selection.path)
  )
  const tabs = [...persistedTabs, ...pendingTabs]
  if (tabs.length === 0) {
    removeDocumentViewerState()
    return
  }
  const activeTabId = tabs.find((tab) => tab.id === activeTab?.id)?.id ?? tabs[0]!.id
  writeDocumentViewerState({
    version: DOCUMENT_VIEWER_STATE_VERSION,
    activeTabId,
    tabs
  })
}

/**
 * 将单个已完成 Tab 转换为可持久化状态。
 * @param tab 待保存的工作台 Tab。
 * @returns 具备完整双模型和文件指纹的持久化 Tab；不完整时返回 null。
 * @author zhenghq
 */
function createPersistedDocumentViewerTab(tab: DocumentWorkspaceTab): DocumentViewerTabState | null {
  const snapshot = tab.snapshot
  if (!tab.selection.path || !tab.selection.sha256 || !snapshot?.source || !snapshot.translation) {
    return null
  }
  const file: DocumentViewerFileState = {
    path: tab.selection.path,
    name: tab.selection.name,
    size: tab.selection.size,
    format: tab.selection.format,
    sha256: tab.selection.sha256
  }
  return {
    id: tab.id,
    selection: file,
    sourceLang: tab.sourceLang,
    targetLang: tab.targetLang,
    viewMode: tab.viewMode,
    zoom: tab.zoom,
    scroll: { ...tab.scrollPositions },
    scrollSyncEnabled: tab.scrollSyncEnabled,
    pageNumber: tab.pageNumber,
    ocrDisplayMode: tab.ocrDisplayMode,
    activePageId: findActiveDocumentPageId(tab),
    activeBlockId: tab.activeBlockId,
    source: snapshot.source,
    translation: snapshot.translation
  }
}

/**
 * 节流保存当前工作台状态，合并滚动、缩放和流式译文产生的高频变更。
 * @returns 无返回值。
 * @author zhenghq
 */
function scheduleDocumentViewerStatePersist(): void {
  if (documentViewerStatePersistTimer !== null) window.clearTimeout(documentViewerStatePersistTimer)
  documentViewerStatePersistTimer = window.setTimeout(() => {
    documentViewerStatePersistTimer = null
    persistActiveDocumentViewerState()
  }, 250)
}

/**
 * 解析当前激活 Tab 的页面锚点；优先使用高亮区块，其次使用页码。
 * @param tab 当前激活的文档 Tab。
 * @returns 可恢复的页面标识；没有模型时返回 null。
 * @author zhenghq
 */
function findActiveDocumentPageId(tab: DocumentWorkspaceTab): string | null {
  const model = tab.snapshot?.source ?? tab.snapshot?.translation
  if (!model) return null
  if (tab.activeBlockId) {
    // 后台 Tab 不得读取当前可见 Tab 的全局高亮，否则保存时会串用其他文件的页面锚点。
    const activePage = model.pages.find((page) =>
      resolveDocumentBlockHighlight(model, page.pageId, tab.activeBlockId as string) !== null
    )
    if (activePage) return activePage.pageId
  }
  return model.pages[Math.max(0, tab.pageNumber - 1)]?.pageId ?? model.pages[0]?.pageId ?? null
}

/**
 * 获取当前激活的文档 Tab。
 * @returns 当前 Tab；没有打开文件时返回 null。
 * @author zhenghq
 */
function getActiveDocumentTab(): DocumentWorkspaceTab | null {
  return documentTabs.find((tab) => tab.id === activeDocumentTabId) ?? null
}

/**
 * 将任务快照状态映射为顶栏 Tab 状态。
 * @param snapshot 任务快照。
 * @returns 对应的 Tab 状态。
 * @author zhenghq
 */
function resolveDocumentTabStatus(snapshot: DocumentWorkspaceSnapshot): DocumentTabStatus {
  switch (snapshot.task.status) {
    case 'completed':
    case 'partial':
    case 'failed':
    case 'cancelled':
      return snapshot.task.status
    case 'validating':
    case 'parsing':
    case 'ocr':
    case 'translating':
    case 'rendering':
    case 'exporting':
      return 'running'
    default:
      return 'starting'
  }
}

/**
 * 将激活 Tab 的字段同步到现有渲染函数使用的镜像变量。
 * 镜像只服务当前可见页面，后台 Tab 的任务字段始终保存在自身对象中。
 * @param tab 要激活的 Tab；null 表示清空镜像。
 * @returns 无返回值。
 * @author zhenghq
 */
function syncActiveTabMirror(tab: DocumentWorkspaceTab | null): void {
  selectionState = tab ? { ...tab.selection } : { ...EMPTY_SELECTION }
  activeJobId = tab?.activeJobId ?? null
  expectedJobId = tab?.expectedJobId ?? null
  latestSnapshot = tab?.snapshot ?? null
  ocrDisplayMode = tab?.ocrDisplayMode ?? 'translation'
  documentViewMode = tab?.viewMode ?? readDocumentViewMode()
  activeDocumentBlockId = tab?.activeBlockId ?? null
  documentStartInFlight = tab?.startInFlight ?? false
  pendingLanguageRetranslation = tab?.pendingLanguageRetranslation ?? false
  pendingOcrModeTarget = tab?.pendingOcrModeTarget ?? null
  ocrModeSwitchInFlight = tab?.ocrModeSwitchInFlight ?? false
  pendingModeSwitchGeneration = tab?.pendingModeSwitchGeneration ?? null
  if (tab) {
    // 多个 Tab 共用会话级单调代际；切回旧 Tab 时不能把全局代际退回旧值。
    generation = Math.max(generation, tab.generation)
    sourceLanguageSelect.value = tab.sourceLang
    targetLanguageSelect.value = tab.targetLang
    appliedLanguagePair = `${tab.sourceLang}\u0000${tab.targetLang}`
  }
}

/**
 * 把当前激活 Tab 的运行时字段回写到镜像变量。
 * @param tab 当前激活 Tab。
 * @returns 无返回值。
 * @author zhenghq
 */
function refreshActiveTabMirror(tab: DocumentWorkspaceTab): void {
  if (tab.id !== activeDocumentTabId) return
  selectionState = { ...tab.selection }
  activeJobId = tab.activeJobId
  expectedJobId = tab.expectedJobId
  latestSnapshot = tab.snapshot
  ocrDisplayMode = tab.ocrDisplayMode
  documentViewMode = tab.viewMode
  activeDocumentBlockId = tab.activeBlockId
  documentStartInFlight = tab.startInFlight
  pendingLanguageRetranslation = tab.pendingLanguageRetranslation
  pendingOcrModeTarget = tab.pendingOcrModeTarget
  ocrModeSwitchInFlight = tab.ocrModeSwitchInFlight
  pendingModeSwitchGeneration = tab.pendingModeSwitchGeneration
  generation = Math.max(generation, tab.generation)
}

/**
 * 按任务标识查找所属 Tab，用于把后台进度路由到正确文件。
 * @param jobId 主进程任务标识。
 * @returns 匹配的 Tab；不存在时返回 null。
 * @author zhenghq
 */
function findDocumentTabByJob(jobId: string): DocumentWorkspaceTab | null {
  return documentTabs.find((tab) => tab.activeJobId === jobId || tab.expectedJobId === jobId) ?? null
}

/**
 * 根据任务快照的标识与代际定位所属 Tab。
 * @param snapshot 收到的任务快照。
 * @returns 匹配的 Tab；不属于任何已打开文件时返回 null。
 * @author zhenghq
 */
function findDocumentTabForSnapshot(snapshot: DocumentWorkspaceSnapshot): DocumentWorkspaceTab | null {
  return documentTabs.find((tab) =>
    (tab.generation === snapshot.generation ||
      tab.pendingModeSwitchGeneration === snapshot.generation) &&
    (tab.activeJobId === snapshot.jobId || tab.expectedJobId === snapshot.jobId)
  ) ?? null
}

/**
 * 将首条进度快照绑定到仍在等待 runDocument 结果的 Tab。
 * @param snapshot 首条任务快照。
 * @returns 可绑定的 Tab；没有唯一候选时返回 null。
 * @author zhenghq
 */
function bindPendingDocumentTabSnapshot(snapshot: DocumentWorkspaceSnapshot): DocumentWorkspaceTab | null {
  const candidates = documentTabs.filter((tab) =>
    tab.generation === snapshot.generation &&
    tab.startInFlight &&
    tab.activeJobId === null &&
    tab.expectedJobId === null
  )
  if (candidates.length !== 1) return null
  const tab = candidates[0]!
  tab.expectedJobId = snapshot.jobId
  return tab
}

/**
 * 将任务快照保存到所属 Tab，并仅在活动 Tab 时刷新可见界面。
 * 自动生成快照必须叠加此前的译文手改，否则流式增量或模式切换会覆盖用户修改。
 * @param tab 目标 Tab。
 * @param snapshot 最新任务快照。
 * @returns 实际写入 Tab 并可用于渲染的合并快照。
 * @author zhenghq
 */
function updateDocumentTabSnapshot(
  tab: DocumentWorkspaceTab,
  snapshot: DocumentWorkspaceSnapshot
): DocumentWorkspaceSnapshot {
  const previousTranslation = tab.snapshot?.translation
  const mergedSnapshot = previousTranslation
    ? {
        ...snapshot,
        translation: preserveDocumentManualTranslationEdits(previousTranslation, snapshot.translation)
      }
    : snapshot
  tab.snapshot = mergedSnapshot
  tab.activeJobId = snapshot.jobId
  tab.expectedJobId = snapshot.jobId
  tab.generation = Math.max(tab.generation, snapshot.generation)
  tab.status = resolveDocumentTabStatus(snapshot)
  if (tab.id !== activeDocumentTabId) {
    renderDocumentTabs()
    return mergedSnapshot
  }
  refreshActiveTabMirror(tab)
  renderDocumentTabs()
  return mergedSnapshot
}

/**
 * 判断任务快照是否仍可覆盖指定 Tab 的可见界面。
 * 这里只读取 Tab 自身状态，避免后台任务受到当前激活 Tab 的干扰。
 * @param tab 目标任务所属 Tab。
 * @param snapshot 待渲染的任务快照。
 * @returns 是否可以安全渲染该快照。
 * @author zhenghq
 */
function canRenderDocumentTabSnapshot(
  tab: DocumentWorkspaceTab,
  snapshot: DocumentWorkspaceSnapshot
): boolean {
  return documentTabs.includes(tab) &&
    tab.id === activeDocumentTabId &&
    tab.generation === snapshot.generation &&
    (tab.activeJobId === snapshot.jobId || tab.expectedJobId === snapshot.jobId)
}

/**
 * 判断任务快照是否可以覆盖指定 Tab 的当前快照。
 * @param tab 目标任务所属 Tab。
 * @param snapshot 收到的任务快照。
 * @returns 是否可以应用该快照。
 * @author zhenghq
 */
function canApplyDocumentTabProgressSnapshot(
  tab: DocumentWorkspaceTab,
  snapshot: DocumentWorkspaceSnapshot
): boolean {
  if (snapshot.generation !== tab.generation) return false
  if (tab.expectedJobId !== null && snapshot.jobId !== tab.expectedJobId) return false
  if (tab.activeJobId !== null && snapshot.jobId !== tab.activeJobId) return false
  if (!tab.snapshot) return true
  if (tab.snapshot.jobId !== snapshot.jobId) return true
  if (tab.snapshot.generation !== snapshot.generation) {
    return snapshot.generation > tab.snapshot.generation
  }
  return canApplyDocumentTaskEvent(tab.snapshot.task, snapshot.jobId, snapshot.generation)
}

/**
 * 将后台任务事件写入其所属 Tab，并只在激活 Tab 上触发界面渲染。
 * @param snapshot 收到的进度或终态快照。
 * @param terminal 是否为终态事件。
 * @returns 是否成功路由到已打开 Tab。
 * @author zhenghq
 */
function routeDocumentSnapshot(snapshot: DocumentWorkspaceSnapshot, terminal: boolean): boolean {
  const tab = findDocumentTabForSnapshot(snapshot) ?? bindPendingDocumentTabSnapshot(snapshot)
  if (!tab) return false
  // 模式切换响应返回前，新代际事件可能先于 IPC 到达；先按代际缓冲，确认后再消费。
  if (tab.pendingModeSwitchGeneration !== null &&
    snapshot.generation === tab.pendingModeSwitchGeneration) {
    tab.pendingModeSwitchSnapshot = snapshot
    tab.pendingModeSwitchSnapshotTerminal = terminal
    return true
  }
  if (!terminal && !canApplyDocumentTabProgressSnapshot(tab, snapshot)) return false
  // 在首次有效运行进度到达时固定 ETA 起点；后续进度必须基于同一时间计算，
  // 否则每次重算都会把已耗时清零，剩余时间会被严重低估。
  const taskKey = `${snapshot.jobId}:${snapshot.generation}`
  if (!terminal && !documentTaskStartedAt.has(taskKey)) {
    documentTaskStartedAt.set(taskKey, Date.now())
  }
  const appliedSnapshot = updateDocumentTabSnapshot(tab, snapshot)
  if (tab.id !== activeDocumentTabId) return true
  refreshActiveTabMirror(tab)
  if (terminal) flushSnapshotRenderForTab(tab, appliedSnapshot)
  else scheduleSnapshotRenderForTab(tab, appliedSnapshot)
  if (terminal) scheduleDocumentViewerStatePersist()
  startButton.disabled = false
  // 旧任务进入终态后才能由主进程复用源模型切换；运行中只保留待切换目标继续等待。
  if (terminal && tab.pendingOcrModeTarget && !tab.ocrModeSwitchInFlight) {
    void maybeSwitchDocumentOcrMode(tab)
  }
  return true
}

/**
 * 根据块级翻译增量定位所属文件 Tab。
 * @param update 收到的块级翻译增量。
 * @returns 匹配的 Tab；任务标识、代际不匹配或正在重启时返回 null。
 * @author zhenghq
 */
function findDocumentTabByTranslationUpdate(
  update: DocumentWorkspaceTranslationUpdate
): DocumentWorkspaceTab | null {
  return documentTabs.find((tab) =>
    (tab.generation === update.generation ||
      tab.pendingModeSwitchGeneration === update.generation) &&
    (tab.activeJobId === update.jobId || tab.expectedJobId === update.jobId)
  ) ?? null
}

/**
 * 根据文件 Tab 栏当前尺寸同步左右滚动按钮的禁用状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function updateDocumentTabScrollButtons(): void {
  const state = resolveDocumentTabScrollState(
    documentWorkspaceTabs.scrollLeft,
    documentWorkspaceTabs.clientWidth,
    documentWorkspaceTabs.scrollWidth
  )
  documentFileTabsPreviousButton.disabled = !state.canScrollBackward
  documentFileTabsNextButton.disabled = !state.canScrollForward
}

/**
 * 按可视宽度滚动文件 Tab 栏。
 * @param direction -1 表示向左，1 表示向右。
 * @returns 无返回值。
 * @author zhenghq
 */
function scrollDocumentTabs(direction: -1 | 1): void {
  const target = resolveDocumentTabScrollTarget(
    documentWorkspaceTabs.scrollLeft,
    documentWorkspaceTabs.clientWidth,
    documentWorkspaceTabs.scrollWidth,
    direction
  )
  documentWorkspaceTabs.scrollTo({ left: target, behavior: 'smooth' })
  // 平滑滚动期间先按目标位置更新禁用态，避免连续点击仍落到已经越界的方向。
  const nextState = resolveDocumentTabScrollState(
    target,
    documentWorkspaceTabs.clientWidth,
    documentWorkspaceTabs.scrollWidth
  )
  documentFileTabsPreviousButton.disabled = !nextState.canScrollBackward
  documentFileTabsNextButton.disabled = !nextState.canScrollForward
}

/**
 * 渲染顶栏文件 Tab，并同步选中态、状态点和逐个关闭入口。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderDocumentTabs(): void {
  const previousScrollLeft = documentWorkspaceTabs.scrollLeft
  documentWorkspaceTabs.replaceChildren()
  for (const tab of documentTabs) {
    const item = document.createElement('div')
    const label = document.createElement('span')
    const status = document.createElement('span')
    const close = document.createElement('button')
    item.className = 'document-file-tab'
    item.dataset.tabId = tab.id
    item.dataset.status = tab.status
    item.setAttribute('role', 'tab')
    item.setAttribute('aria-selected', String(tab.id === activeDocumentTabId))
    item.tabIndex = tab.id === activeDocumentTabId ? 0 : -1
    item.title = tab.selection.path ?? tab.selection.name
    label.className = 'document-file-tab-label'
    label.textContent = tab.selection.name
    status.className = 'document-file-tab-status'
    status.setAttribute('aria-hidden', 'true')
    close.type = 'button'
    close.className = 'document-file-tab-close'
    close.textContent = '×'
    close.setAttribute('aria-label', t('document.tab.close', { name: tab.selection.name }))
    item.append(label, status, close)
    item.addEventListener('click', () => void activateDocumentTab(tab.id))
    item.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      void activateDocumentTab(tab.id)
    })
    close.addEventListener('click', (event) => {
      event.stopPropagation()
      void closeDocumentTab(tab.id)
    })
    documentWorkspaceTabs.append(item)
  }
  documentWorkspaceTabs.scrollLeft = previousScrollLeft
  updateDocumentTabScrollButtons()
  if (!shouldRevealActiveDocumentTab(activeDocumentTabId, lastRevealedActiveDocumentTabId)) return
  const activeElement = documentWorkspaceTabs.querySelector<HTMLElement>('[aria-selected="true"]')
  activeElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  lastRevealedActiveDocumentTabId = activeDocumentTabId
}

/**
 * 保存当前 Tab 的双栏滚动位置，供切回时恢复。
 * @param tab 当前激活 Tab。
 * @returns 无返回值。
 * @author zhenghq
 */
function saveDocumentTabScroll(tab: DocumentWorkspaceTab): void {
  tab.scrollPositions = {
    source: sourceContent.scrollTop,
    translation: translationContent.scrollTop
  }
}

/**
 * 将当前可见阅读控件状态保存到指定 Tab。
 * @param tab 需要保存阅读状态的 Tab。
 * @returns 无返回值。
 * @author zhenghq
 */
function saveDocumentTabViewerState(tab: DocumentWorkspaceTab): void {
  tab.zoom = documentZoom
  tab.viewMode = documentViewMode
  tab.pageNumber = currentDocumentPageNumber
  tab.scrollSyncEnabled = documentScrollSyncEnabled
  tab.activeBlockId = activeDocumentBlockId
}

/**
 * 将指定 Tab 的阅读控件状态恢复到当前可见页面。
 * @param tab 即将激活的 Tab。
 * @returns 无返回值。
 * @author zhenghq
 */
function restoreDocumentTabViewerState(tab: DocumentWorkspaceTab): void {
  documentZoom = clampDocumentZoom(tab.zoom)
  documentViewMode = tab.viewMode
  activeDocumentBlockId = tab.activeBlockId
  currentDocumentPageNumber = tab.pageNumber
  documentScrollSyncEnabled = tab.scrollSyncEnabled
  documentPageInput.value = String(currentDocumentPageNumber)
  syncDocumentViewModeControls()
  syncDocumentScrollSyncControl()
}

/**
 * 恢复指定 Tab 的双栏滚动位置。
 * @param tab 要恢复的 Tab。
 * @returns 无返回值。
 * @author zhenghq
 */
function restoreDocumentTabScroll(tab: DocumentWorkspaceTab): void {
  requestAnimationFrame(() => {
    if (tab.id !== activeDocumentTabId) return
    sourceContent.scrollTop = tab.scrollPositions.source
    translationContent.scrollTop = tab.scrollPositions.translation
  })
}

/**
 * 清理 Tab 切换或关闭后遗留的区块高亮、用户滚动意图和双栏联动方向。
 * @returns 无返回值。
 * @author zhenghq
 */
function resetDocumentTabInteractionState(): void {
  documentNavigation.clearBlockHighlight()
  const activeTab = getActiveDocumentTab()
  if (activeTab) activeTab.activeBlockId = null
  if (userScrollIntentTimer !== null) {
    window.clearTimeout(userScrollIntentTimer)
    userScrollIntentTimer = null
  }
  userScrollSide = null
  documentScrollSyncedSide = null
}

/**
 * 释放滚动容器及其内层预览宿主登记的 PDF.js 文档、渲染任务和观察器。
 * PDF 渲染清理函数登记在内层宿主，切换 Tab 时必须同时检查外层容器与现有子宿主。
 * @param container 原文或译文的滚动容器。
 * @returns 无返回值。
 * @author zhenghq
 */
function cleanupPdfPreview(container: HTMLElement): void {
  pdfPreviewCleanups.get(container)?.()
  for (const previewHost of container.querySelectorAll<HTMLElement>('.document-preview-host')) {
    pdfPreviewCleanups.get(previewHost)?.()
  }
}

/**
 * 清空当前可见预览与异步渲染资源，但不修改任何 Tab 的任务状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function clearActiveTabPreview(): void {
  deferredTranslationRender.cancel()
  if (pendingRenderFrame !== null) {
    cancelAnimationFrame(pendingRenderFrame)
    pendingRenderFrame = null
  }
  pageScaleObserver?.disconnect()
  pageScaleObserver = null
  cancelTranslationPageLayout()
  watermarkResizeObserver?.disconnect()
  watermarkResizeObserver = null
  renderedSourcePreviewIdentity = ''
  renderedSourcePreviewTabId = null
  renderedSourcePreviewSha256 = ''
  renderedSourceWarningSignature = ''
  renderedTranslationSignature = ''
  renderedTranslationTabId = null
  renderedTranslationSha256 = ''
  renderedTranslationPreviewKind = null
  hasRenderedTranslation = false
  renderedTranslationWarningSignature = ''
  revokeAssetUrls()
  releaseHtmlPreviewUrl()
  cleanupPdfPreview(sourceContent)
  cleanupPdfPreview(translationContent)
  sourceContent.replaceChildren()
  translationContent.replaceChildren()
  sourceContent.dataset.previewKind = ''
  translationContent.dataset.previewKind = ''
  sourcePageCount.textContent = ''
  translationPageCount.textContent = ''
  actualLanguage.textContent = ''
  actualLanguage.hidden = true
}

/**
 * 仅清空当前译文预览及其异步渲染资源，保留左侧原文 DOM。
 * 用于 OCR 原文与译文模式切换，避免同一源文档的左侧预览重复加载。
 * @returns 无返回值。
 * @author zhenghq
 */
function clearActiveTabTranslationPreview(): void {
  if (pendingRenderFrame !== null) {
    cancelAnimationFrame(pendingRenderFrame)
    pendingRenderFrame = null
  }
  pageScaleObserver?.disconnect()
  pageScaleObserver = null
  cancelTranslationPageLayout()
  watermarkResizeObserver?.disconnect()
  watermarkResizeObserver = null
  renderedTranslationSignature = ''
  renderedTranslationTabId = null
  renderedTranslationSha256 = ''
  renderedTranslationPreviewKind = null
  hasRenderedTranslation = false
  renderedTranslationWarningSignature = ''
  cleanupPdfPreview(translationContent)
  translationContent.replaceChildren()
  translationContent.dataset.previewKind = ''
  translationPageCount.textContent = ''
}

/**
 * 渲染激活 Tab 的文件信息、语言、OCR 模式、快照与任务状态。
 * @param tab 要展示的 Tab。
 * @param options 快照首屏渲染选项；工作台自动恢复时可延迟构建译文。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderActiveDocumentTab(
  tab: DocumentWorkspaceTab,
  options: DocumentSnapshotRenderOptions = {}
): void {
  syncActiveTabMirror(tab)
  restoreDocumentTabViewerState(tab)
  uploadPanel.hidden = true
  workbench.hidden = false
  workbenchName.textContent = tab.selection.name
  workbenchMeta.textContent = `${tab.selection.format.toUpperCase()} · ${formatFileSize(tab.selection.size)}`
  sourceLanguageSelect.value = tab.sourceLang
  targetLanguageSelect.value = tab.targetLang
  appliedLanguagePair = `${tab.sourceLang}\u0000${tab.targetLang}`
  ocrDisplayMode = tab.ocrDisplayMode
  syncOcrDisplayModeControls()
  sourceOcrMode.hidden = !(tab.selection.format === 'pdf' || tab.selection.format === 'image' || Boolean(tab.snapshot?.source && hasOcrSourceText(tab.snapshot.source)))
  if (tab.snapshot) {
    renderSnapshot(tab.snapshot, tab, options)
    renderTaskState(tab.snapshot, tab)
  } else {
    progressStage.textContent = tab.status === 'starting'
      ? t('document.progress.preparing')
      : t('document.progress.ready')
    progressCount.textContent = tab.status === 'starting' ? t('document.progress.pending') : ''
    progressbar.setAttribute('aria-valuenow', '0')
    progressbar.style.width = '0%'
    cancelButton.hidden = tab.status !== 'starting' && tab.status !== 'running'
    exportButton.disabled = true
    retryButton.disabled = true
    rerunButton.disabled = true
    partialStatus.hidden = true
    workbench.dataset.state = tab.status
    // 文件选择完成后立即使用受控源字节渲染 PDF，不能等待任务接受或首条进度快照。
    if (tab.selection.format === 'pdf' && !hasReusablePdfSourcePreview(
      tab,
      renderedSourcePreviewIdentity,
      renderedSourcePreviewTabId,
      renderedSourcePreviewSha256
    )) {
      renderPendingPdfSourcePreview(sourceContent, '', tab)
    }
  }
  restoreDocumentTabScroll(tab)
  // 切换 Tab 后 DOM 属于新文件，必须按新快照重建手改标识与检索高亮。
  documentManualEdit.refresh()
  documentSearch.refresh()
}

/**
 * 激活指定文件 Tab，保存旧 Tab 滚动位置并恢复目标任务视图。
 * @param tabId 目标 Tab 标识。
 * @returns 激活完成后的 Promise。
 * @author zhenghq
 */
async function activateDocumentTab(tabId: string): Promise<void> {
  if (tabId === activeDocumentTabId) return
  documentBlockActions.close()
  const currentTab = getActiveDocumentTab()
  if (currentTab) {
    saveDocumentTabScroll(currentTab)
    saveDocumentTabViewerState(currentTab)
  }
  const tab = documentTabs.find((candidate) => candidate.id === tabId)
  if (!tab) return
  // 阅读联动状态属于上一 Tab，切换后必须清空，避免旧栏位继续驱动新文档滚动。
  resetDocumentTabInteractionState()
  clearActiveTabPreview()
  activeDocumentTabId = tab.id
  syncActiveTabMirror(tab)
  restoreDocumentTabViewerState(tab)
  renderDocumentTabs()
  renderActiveDocumentTab(tab)
  if (tab.activeBlockId) documentNavigation.highlightBlock(tab.activeBlockId)
  else documentNavigation.clearBlockHighlight()
}

/**
 * 创建独立文件 Tab；重复路径只激活已有 Tab，不重复启动任务。
 * @param result 已通过主进程校验的文件选择结果。
 * @param options 是否激活以及是否立即开始翻译。
 * @returns 创建或复用的 Tab。
 * @author zhenghq
 */
async function createDocumentTab(
  result: DocumentFileSelectionResult,
  options: { activate?: boolean; start?: boolean } = {}
): Promise<DocumentWorkspaceTab | null> {
  if (result.status !== 'selected') return null
  const existing = findDocumentTabByPath(result.path)
  if (existing) {
    const selectionChanged = existing.selection.sha256 !== result.sha256 ||
      existing.selection.size !== result.size ||
      existing.selection.format !== result.format
    // 同一路径内容变化时必须使用新的哈希与模型，不能继续复用旧文件的任务快照。
    const previousJobId = existing.activeJobId ?? existing.expectedJobId
    const previousGeneration = existing.generation
    existing.selection = {
      path: result.path,
      name: result.fileName,
      size: result.size,
      format: result.format,
      sha256: result.sha256,
      error: null
    }
    if (selectionChanged) {
      // 先推进代际，再异步取消旧任务；旧启动请求和旧进度事件都不能写入新文件身份。
      existing.generation = nextGeneration()
      existing.snapshot = null
      existing.activeJobId = null
      existing.expectedJobId = null
      existing.startInFlight = false
      existing.status = 'idle'
      existing.scrollPositions = { source: 0, translation: 0 }
      existing.zoom = 1
      existing.viewMode = readDocumentViewMode()
      existing.pageNumber = 1
      existing.scrollSyncEnabled = true
      existing.activeBlockId = null
      existing.pendingLanguageRetranslation = false
      resetDocumentModeSwitchState(existing)
      existing.languageRevision += 1
      if (existing.id === activeDocumentTabId) {
        clearActiveTabPreview()
        refreshActiveTabMirror(existing)
        renderActiveDocumentTab(existing)
      }
      if (previousJobId) {
        void cancelDocumentJob(previousJobId, previousGeneration)
          .then(() => releaseDocumentJob(previousJobId))
      }
    }
    if (options.activate !== false) await activateDocumentTab(existing.id)
    else renderDocumentTabs()
    if (selectionChanged && options.start !== false) await startDocumentTabTranslation(existing)
    return existing
  }
  const tab: DocumentWorkspaceTab = {
    id: `document-tab-${nextDocumentTabSequence++}`,
    sourceKind: 'task',
    selection: {
      path: result.path,
      name: result.fileName,
      size: result.size,
      format: result.format,
      sha256: result.sha256,
      error: null
    },
    snapshot: null,
    activeJobId: null,
    expectedJobId: null,
    generation: 0,
    startInFlight: false,
    status: 'idle',
    scrollPositions: { source: 0, translation: 0 },
    zoom: 1,
    viewMode: documentViewMode,
    pageNumber: 1,
    scrollSyncEnabled: true,
    sourceLang: sourceLanguageSelect.value || 'auto',
    targetLang: targetLanguageSelect.value || 'auto',
    ocrDisplayMode,
    activeBlockId: null,
    pendingLanguageRetranslation: false,
    pendingOcrModeTarget: null,
    ocrModeSwitchInFlight: false,
    pendingModeSwitchGeneration: null,
    pendingModeSwitchSnapshot: null,
    pendingModeSwitchSnapshotTerminal: false,
    languageRevision: 0,
    sourceAuthorized: true
  }
  documentTabs.push(tab)
  if (tab.selection.path) {
    documentHistory.rememberSelectedDocument({
      path: tab.selection.path,
      name: tab.selection.name,
      size: tab.selection.size,
      format: tab.selection.format
    })
  }
  if (options.activate !== false) await activateDocumentTab(tab.id)
  else renderDocumentTabs()
  if (options.start !== false) await startDocumentTabTranslation(tab)
  return tab
}

/**
 * 关闭指定文件 Tab；运行中的任务先取消并释放主进程资源。
 * @param tabId 要关闭的 Tab 标识。
 * @returns 关闭流程完成后的 Promise。
 * @author zhenghq
 */
async function closeDocumentTab(tabId: string): Promise<void> {
  const index = documentTabs.findIndex((tab) => tab.id === tabId)
  if (index < 0) return
  const tab = documentTabs[index]!
  const wasActive = tab.id === activeDocumentTabId
  if (wasActive) {
    saveDocumentTabScroll(tab)
  }
  documentTabs = documentTabs.filter((candidate) => candidate.id !== tab.id)
  tab.status = 'cancelled'
  // 关闭 Tab 后立即丢弃其译文 DOM 缓存并释放图片资源。
  translationDomCache.remove(tab.id)
  if (wasActive) {
    activeDocumentTabId = null
    const nextTab = documentTabs[Math.min(index, documentTabs.length - 1)]
    resetDocumentTabInteractionState()
    clearActiveTabPreview()
    if (nextTab) {
      activeDocumentTabId = nextTab.id
      syncActiveTabMirror(nextTab)
      renderActiveDocumentTab(nextTab)
    } else {
      syncActiveTabMirror(null)
      workbench.hidden = true
      uploadPanel.hidden = false
      renderSelectionState()
    }
  }
  restoredDocumentTabIndexes.delete(tab.id)
  if (documentTabs.length === 0) {
    // 用户明确关闭了最后一个 Tab 时，取消尚未完成的后台恢复，避免旧文件稍后重新出现。
    documentViewerRestoreEpoch += 1
    pendingRestoredDocumentViewerTabs = []
    restoredDocumentTabIndexes.clear()
  }
  renderDocumentTabs()
  // 删除 Tab 后再写入剩余集合；删除前持久化会把刚关闭的文件重新带回下次恢复。
  persistActiveDocumentViewerState()
  // 历史与恢复快照是只读回放，没有可取消或释放的活动任务，不能误伤同标识的任务。
  if (isRestoredDocumentTab(tab)) return
  if (isReadOnlyDocumentTab(tab)) return
  const jobId = tab.activeJobId ?? tab.expectedJobId
  if (jobId) {
    await cancelDocumentJob(jobId, tab.generation)
    await releaseDocumentJob(jobId)
  }
}

/**
 * 释放主进程中的文档任务资源；任务已结束时静默忽略。
 * @param jobId 任务标识。
 * @returns 释放完成后的 Promise。
 * @author zhenghq
 */
async function releaseDocumentJob(jobId: string): Promise<void> {
  try {
    await window.api.releaseDocumentJob(jobId)
  } catch {
    // 资源可能已由主进程回收，关闭 Tab 不应因此失败。
  }
}

/**
 * 统一添加一组已审批文件，只启动本次新建的 Tab。
 * 已打开的相同路径只激活，不重复启动任务，避免多文件选择时重复解析。
 * @param results 主进程返回的文件选择结果。
 * @returns 本次选择数量与未通过数量。
 * @author zhenghq
 */
async function addDocumentSelectionResults(
  results: readonly DocumentFileSelectionResult[]
): Promise<{ selectedCount: number; rejectedCount: number }> {
  let selectedCount = 0
  let rejectedCount = 0
  const newTabs: DocumentWorkspaceTab[] = []
  let lastActivatedTab: DocumentWorkspaceTab | null = null
  for (const result of results) {
    if (result.status !== 'selected') {
      // 用户取消文件选择是正常操作，不能与格式或可读性校验失败混为一谈。
      if (result.status === 'rejected') rejectedCount += 1
      continue
    }
    selectedCount += 1
    const existingTab = findDocumentTabByPath(result.path)
    const existed = existingTab !== null
    const previousSelection = existingTab?.selection
    const tab = await createDocumentTab(result, { activate: false, start: false })
    if (!tab) {
      rejectedCount += 1
      continue
    }
    const selectionChanged = Boolean(previousSelection && (
      previousSelection.sha256 !== tab.selection.sha256 ||
      previousSelection.size !== tab.selection.size ||
      previousSelection.format !== tab.selection.format
    ))
    if (existed) lastActivatedTab = tab
    if (!existed || selectionChanged) newTabs.push(tab)
  }
  const activeTab = newTabs.at(-1) ?? lastActivatedTab
  if (activeTab) await activateDocumentTab(activeTab.id)
  await Promise.all(newTabs.map((tab) => startDocumentTabTranslation(tab)))
  return { selectedCount, rejectedCount }
}

/**
 * 通过主进程多选对话框一次添加多个文件，每个文件创建独立 Tab。
 * @returns 添加完成后的 Promise。
 * @author zhenghq
 */
async function addDocumentFilesFromWorkbench(): Promise<void> {
  if (!platformCapability?.supported) return
  documentWorkbenchReplaceButton.disabled = true
  uploadStatus.hidden = false
  try {
    const results = await window.api.selectDocumentFiles()
    const { rejectedCount: rejected } = await addDocumentSelectionResults(results)
    if (rejected > 0) {
      uploadStatus.textContent = t('document.files.invalid', { count: rejected })
      uploadStatus.dataset.state = 'error'
    }
  } catch {
    uploadStatus.textContent = t('document.error.unreadable')
    uploadStatus.dataset.state = 'error'
  } finally {
    documentWorkbenchReplaceButton.disabled = false
  }
}

/**
 * 读取浏览器 File 对象有限头尾片段和 ZIP 中央目录并执行本地预检。
 * @param file 用户拖放或选择的文件。
 * @returns 无返回值。
 * @author zhenghq
 */
async function inspectBrowserFiles(files: readonly File[]): Promise<void> {
  if (files.length === 0) return
  uploadStatus.hidden = false
  try {
    const validatedPaths = (await Promise.all(files.map(async (file): Promise<string | null> => {
      try {
        const head = new Uint8Array(await file.slice(0, DOCUMENT_HEAD_BYTES).arrayBuffer())
        const tailStart = Math.max(0, file.size - DOCUMENT_ZIP_TAIL_BYTES)
        const tail = new Uint8Array(await file.slice(tailStart, file.size).arrayBuffer())
        const zipRange = getDocumentZipCentralDirectoryRange(tail, file.size)
        const zipDirectory = zipRange
          ? new Uint8Array(await file.slice(zipRange.start, zipRange.end).arrayBuffer())
          : undefined
        const path = window.api.getDocumentDroppedFilePath(file)
        if (!path) return null
        const validation = validateDocumentFile({
          fileName: file.name,
          size: file.size,
          head,
          tail,
          ...(zipDirectory ? { zipDirectory } : {})
        })
        if (!validation.ok) return null
        return path
      } catch {
        return null
      }
    }))).filter((path): path is string => path !== null)
    if (validatedPaths.length === 0) {
      selectionState = { ...EMPTY_SELECTION, error: 'invalid-header' }
      renderSelectionState()
      return
    }
    // Renderer 预检只用于即时反馈，真正可运行资格仍由主进程重新读取文件头并登记。
    const approved = await window.api.approveDocumentFiles(validatedPaths)
    const { selectedCount } = await addDocumentSelectionResults(approved)
    const rejected = files.length - selectedCount
    if (rejected > 0) {
      uploadStatus.textContent = t('document.files.invalid', { count: rejected })
      uploadStatus.dataset.state = 'error'
    }
  } catch {
    selectionState = { ...EMPTY_SELECTION, error: 'unreadable' }
    renderSelectionState()
  }
}

/**
 * 通过主进程受信任文件选择器选择文档。
 * @returns 无返回值。
 * @author zhenghq
 */
async function chooseDocumentFiles(): Promise<void> {
  if (!platformCapability?.supported) {
    renderSelectionState()
    return
  }
  try {
    const results = await window.api.selectDocumentFiles()
    const { rejectedCount: rejected } = await addDocumentSelectionResults(results)
    if (rejected > 0) {
      uploadStatus.textContent = t('document.files.invalid', { count: rejected })
      uploadStatus.dataset.state = 'error'
    }
  } catch {
    selectionState = { ...EMPTY_SELECTION, error: 'unreadable' }
    renderSelectionState()
  }
}

/**
 * 释放当前所有文档图片 Blob URL，避免切换文件或重绘后泄漏内存。
 * @returns 无返回值。
 * @author zhenghq
 */
function revokeAssetUrls(): void {
  assetRequests.clear()
  // 仍被译文 DOM 缓存引用的 Blob URL 必须保留，否则 Tab 切回时缓存图片全部失效。
  const keepTabIds = new Set(translationDomCache.cachedTabIds())
  for (const [key, url] of assetUrls) {
    if (keepTabIds.has(key.split(':')[0] ?? '')) continue
    URL.revokeObjectURL(url)
    assetUrls.delete(key)
  }
}

/**
 * 释放指定 Tab 的全部图片 Blob URL；译文 DOM 缓存淘汰或关闭 Tab 时调用。
 * @param tabId 待释放的 Tab 标识。
 * @returns 无返回值。
 * @author zhenghq
 */
function revokeAssetUrlsForTab(tabId: string): void {
  for (const [key, url] of assetUrls) {
    if (!key.startsWith(`${tabId}:`)) continue
    URL.revokeObjectURL(url)
    assetUrls.delete(key)
  }
}

/**
 * 释放当前 HTML 源文预览 Blob URL，并清空请求身份。
 * @returns 无返回值。
 * @author zhenghq
 */
function releaseHtmlPreviewUrl(): void {
  if (htmlPreviewUrl) URL.revokeObjectURL(htmlPreviewUrl)
  htmlPreviewUrl = null
  htmlPreviewRequestIdentity = ''
}

/**
 * 读取图片资源并缓存 Blob URL；同一资源在单次任务内只读取一次。
 * @param block 待加载的图片区块。
 * @param tab 资源所属的文档 Tab。
 * @param pageIndex 图片所在页面索引。
 * @returns 可用于 img.src 的 Blob URL；资源不可用时返回 null。
 * @author zhenghq
 */
async function resolveAssetUrl(
  jobId: string,
  block: DocumentImageBlock,
  tab: DocumentWorkspaceTab,
  pageIndex: number
): Promise<string | null> {
  const assetId = block.assetId
  // 恢复态共用固定 jobId；缓存键同时包含 Tab、源文件 SHA 与页面，避免多 Tab 或跨页串图。
  const sourceSha256 = tab.selection.sha256
  const cacheKey = `${tab.id}:${sourceSha256}:${assetId}:${pageIndex}`
  const cached = assetUrls.get(cacheKey)
  if (cached) return cached
  const pending = assetRequests.get(cacheKey)
  if (pending) return pending
  const requestEpoch = assetUrlEpoch
  const request = (async (): Promise<string | null> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const approvedSource = isReadOnlyDocumentTab(tab)
          ? approvedDocumentSourceRequest(tab)
          : null
        const asset: DocumentAssetResult = isReadOnlyDocumentTab(tab)
          ? approvedSource
            ? await (async (): Promise<DocumentAssetResult> => {
                const metadata = findDocumentAssetMetadata(tab, assetId)
                const pdfLocation = resolveDocumentPdfImageAssetLocation(
                  tab.snapshot?.source ?? tab.snapshot?.translation,
                  block,
                  pageIndex
                )
                return window.api.getApprovedDocumentAsset({
                  ...approvedSource,
                  assetId,
                  assetSha256: metadata?.sha256 ?? '',
                  assetByteLength: metadata?.byteLength ?? 0,
                  ...(metadata?.storageKey ? { storageKey: metadata.storageKey } : {}),
                  ...(metadata?.mimeType ? { mimeType: metadata.mimeType } : {}),
                  ...(pdfLocation
                    ? { pageIndex: pdfLocation.pageIndex, bbox: pdfLocation.bbox }
                    : block.bbox && approvedSource.format === 'pdf'
                      ? { bbox: block.bbox }
                      : {})
                })
              })()
            : { ok: false, code: 'asset-not-found' }
          : await window.api.getDocumentAsset(jobId, assetId)
        if (requestEpoch !== assetUrlEpoch) return null
        if (!asset.ok || !asset.bytes) return null
        const bytes = new Uint8Array(asset.bytes)
        const url = URL.createObjectURL(new Blob([bytes], {
          type: asset.mimeType ?? 'application/octet-stream'
        }))
        if (requestEpoch !== assetUrlEpoch) {
          URL.revokeObjectURL(url)
          return null
        }
        assetUrls.set(cacheKey, url)
        return url
      } catch {
        if (requestEpoch !== assetUrlEpoch) return null
        if (attempt < 2) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 80 * (attempt + 1)))
        }
      }
    }
    return null
  })()
  assetRequests.set(cacheKey, request)
  try {
    return await request
  } finally {
    if (assetRequests.get(cacheKey) === request) assetRequests.delete(cacheKey)
  }
}

/**
 * 在图片区块内追加独立占位提示，避免资源异步失败时覆盖已经挂载的 OCR 文字层。
 * @param wrapper 图片区块容器。
 * @param block 图片区块。
 * @param state 占位状态；pending 表示等待 OCR，error 表示原图不可用。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderDocumentImagePlaceholder(
  wrapper: HTMLElement,
  block: DocumentImageBlock,
  state: 'pending' | 'error' = 'pending'
): void {
  wrapper.querySelector<HTMLElement>(':scope > .document-image-placeholder')?.remove()
  const placeholder = document.createElement('span')
  placeholder.className = 'document-image-placeholder'
  placeholder.dataset.state = state
  placeholder.textContent = state === 'error'
    ? t('document.imageUnavailable')
    : block.alt || t('document.ocr.pendingRender')
  wrapper.append(placeholder)
}

/**
 * 加载图片资源并同步占位状态；失败时移除空图片节点并显示可读占位。
 * @param wrapper 图片区块容器。
 * @param image 待加载的图片元素。
 * @param block 图片区块。
 * @param jobId 图片所属任务标识。
 * @param tab 图片所属文档 Tab。
 * @param pageIndex 图片所在页面索引。
 * @returns 无返回值。
 * @author zhenghq
 */
function loadDocumentImageAsset(
  wrapper: HTMLElement,
  image: HTMLImageElement,
  block: DocumentImageBlock,
  jobId: string,
  tab: DocumentWorkspaceTab,
  pageIndex: number
): void {
  // 异步资源返回时旧页面可能已被新快照替换；只有仍挂载的当前图片才允许更新状态。
  const isCurrentImage = (): boolean =>
    wrapper.isConnected &&
    image.parentElement === wrapper &&
    wrapper.querySelector(':scope > img.document-page-image') === image
  wrapper.dataset.assetState = 'loading'
  void resolveAssetUrl(jobId, block, tab, pageIndex).then((url) => {
    if (!url) {
      if (!isCurrentImage()) return
      wrapper.dataset.assetState = 'error'
      delete wrapper.dataset.pending
      image.remove()
      renderDocumentImagePlaceholder(wrapper, block, 'error')
      scheduleTranslationPageLayout()
      return
    }
    image.addEventListener('load', () => {
      if (!isCurrentImage()) return
      wrapper.dataset.assetState = 'loaded'
      delete wrapper.dataset.pending
      // 图片加载完成后按自然尺寸计算居中内容框。
      applyTranslationImageContentGeometry(wrapper, image, block)
      scheduleTranslationPageLayout()
    }, { once: true })
    image.addEventListener('error', () => {
      if (!isCurrentImage()) return
      wrapper.dataset.assetState = 'error'
      delete wrapper.dataset.pending
      image.remove()
      renderDocumentImagePlaceholder(wrapper, block, 'error')
      scheduleTranslationPageLayout()
    }, { once: true })
    image.src = url
  })
}

/**
 * 计算文档预览栏扣除页面留白后的统一可用宽度。
 * 源文 PDF Canvas 与译文流式页面必须共用该值，避免两栏缩放比例不一致。
 * @param container 当前预览滚动容器。
 * @returns 可用于页面布局的 CSS 像素宽度。
 * @author zhenghq
 */
function documentPageAvailableWidth(container: HTMLElement): number {
  const style = getComputedStyle(container)
  const padding = Number.parseFloat(style.paddingLeft || '0') + Number.parseFloat(style.paddingRight || '0')
  const borderWidth = Number.parseFloat(style.getPropertyValue('--border-width')) || 0
  // Canvas 与译文内容都位于页面边框内部，必须扣除左右边框后再计算缩放比例。
  return Math.max(1, container.clientWidth - padding - borderWidth * 2)
}

/**
 * 计算 PDF 页面实际可绘制内容宽度。
 * 原文 Canvas 与译文页面统一使用该值，避免双栏因边框或滚动区留白产生比例偏差。
 * @param container 当前预览滚动容器。
 * @returns 页面边框内部的 CSS 像素宽度。
 * @author zhenghq
 */
function documentPageContentWidth(container: HTMLElement): number {
  // 内容宽度与可用宽度必须来自同一公式，避免两侧各自扣除留白后出现比例漂移。
  return documentPageAvailableWidth(container)
}

/**
 * 计算文档预览栏扣除上下留白与边框后的可用高度。
 * @param container 当前预览滚动容器。
 * @returns 可用于单页高度适配的 CSS 像素高度。
 * @author zhenghq
 */
function documentPageAvailableHeight(container: HTMLElement): number {
  const style = getComputedStyle(container)
  const padding = Number.parseFloat(style.paddingTop || '0') + Number.parseFloat(style.paddingBottom || '0')
  const borderWidth = Number.parseFloat(style.getPropertyValue('--border-width')) || 0
  return Math.max(1, container.clientHeight - padding - borderWidth * 2)
}

/**
 * 计算译文页面首次挂载时的缩放比例，避免先以 1 倍尺寸排版再跳到真实宽度。
 * @param container 译文滚动容器。
 * @param sourceWidth PDF 原始页面宽度。
 * @returns 与页面宽度观察器一致的缩放比例；无法测量时回退为 1。
 * @author zhenghq
 */
function initialTranslationPageScale(container: HTMLElement, sourceWidth: number): number {
  if (!Number.isFinite(sourceWidth) || sourceWidth <= 0) return 1
  const availableWidth = documentPageContentWidth(container)
  return clampDocumentZoom(availableWidth / sourceWidth) * documentZoom
}

/**
 * 将用户缩放比例应用到已渲染页面。
 * @param nextZoom 待应用的缩放比例；会自动限制在 50% 到 200%。
 * @returns 无返回值。
 * @author zhenghq
 */
function applyDocumentZoom(nextZoom: number): void {
  documentZoom = nextZoom
  documentColumns.style.setProperty('--document-user-zoom', String(documentZoom))
  documentZoomValue.textContent = `${Math.round(documentZoom * 100)}%`
  for (const page of sourceContent.querySelectorAll<HTMLElement>('.document-page, .document-pdf-page')) {
    page.style.setProperty('--document-user-zoom', String(documentZoom))
  }
  for (const page of translationContent.querySelectorAll<HTMLElement>('.document-page, .document-pdf-page')) {
    page.style.setProperty('--document-user-zoom', String(documentZoom))
  }
  // 流式译文的页面缩放变量由布局观察器维护，显式缩放变化后必须重新排版。
  scheduleTranslationPageLayout(true)
}

/**
 * 计算 PDF 译文文本块相对上一条已排版区块的段前距离。
 * PDF 文本层已按段落合并；同字号、同左边线的相邻段落使用原始基线推进，
 * 其余情况才使用 bbox 间距，避免行盒高度与坐标距离重复叠加。
 * @param block 当前区块；仅文本区块参与基线推进计算。
 * @param previousBlock 上一条已排版区块。
 * @param previousBottom 上一条区块的原始底边。
 * @returns 以页面点为单位的段前距离。
 * @author zhenghq
 */
function pdfFlowGapBefore(
  block: DocumentBlock,
  previousBlock: DocumentBlock | undefined,
  previousBottom: number
): number {
  if (!block.bbox) return 0
  if (block.kind !== 'text') return Math.max(0, block.bbox.y - previousBottom)
  const previousText = previousBlock?.kind === 'text' ? previousBlock : undefined
  const currentStyle = block.runs[0] ? effectiveTextStyle(block, block.runs[0]) : block.style
  const previousStyle = previousText?.runs[0]
    ? effectiveTextStyle(previousText, previousText.runs[0])
    : previousText?.style
  const currentSize = currentStyle?.fontSize ?? 0
  const previousSize = previousStyle?.fontSize ?? 0
  const currentLineHeight = currentStyle?.lineHeight
  const previousLineHeight = previousStyle?.lineHeight
  const sameLineStyle = previousText !== undefined &&
    Math.abs(currentSize - previousSize) <= Math.max(0.5, currentSize * 0.05) &&
    Math.abs((currentLineHeight ?? 0) - (previousLineHeight ?? 0)) <= 0.5 &&
    Math.abs(block.bbox.x - previousText.bbox!.x) <= Math.max(2, currentSize * 0.25)
  if (sameLineStyle && currentLineHeight !== undefined) {
    const baselineAdvance = block.bbox.y - previousText.bbox!.y
    if (baselineAdvance >= currentSize * 1.02 && baselineAdvance <= currentSize * 3) {
      return Math.max(0, baselineAdvance - currentLineHeight)
    }
  }
  return Math.max(0, block.bbox.y - previousBottom)
}

/**
 * 测量译文流式区块在页面中的真实底边，供图片纵向锚定与后续内容避让使用。
 * @param element 已挂载的译文区块。
 * @returns 区块相对视口的底边坐标；尚未布局时返回 0。
 * @author zhenghq
 */
function measureTranslationFlowBottom(element: HTMLElement): number {
  return element.getBoundingClientRect().bottom
}

/**
 * 测量流式区块在当前页面内容盒中的横向与纵向范围。
 * 同行分组可能包含弹性空白，因此优先合并组内实际子区块的可见边界，避免整组宽度误判图片碰撞。
 * @param element 已挂载的译文区块或同行分组。
 * @param pageRect 译文页面边界。
 * @returns 相对页面左边缘和视口顶部的二维范围。
 * @author zhenghq
 */
function measureTranslationFlowObstacle(
  element: HTMLElement,
  pageRect: DOMRect
): DocumentFlowObstacle {
  const measuredElements = element.classList.contains('document-flow-group')
    ? Array.from(element.querySelectorAll<HTMLElement>(':scope > [data-block-id]'))
    : [element]
  const rects = (measuredElements.length > 0 ? measuredElements : [element])
    .map((item) => item.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0)
  if (rects.length === 0) {
    const rect = element.getBoundingClientRect()
    return {
      left: rect.left - pageRect.left,
      right: rect.right - pageRect.left,
      top: rect.top,
      bottom: rect.bottom
    }
  }
  return {
    left: Math.min(...rects.map((rect) => rect.left)) - pageRect.left,
    right: Math.max(...rects.map((rect) => rect.right)) - pageRect.left,
    top: Math.min(...rects.map((rect) => rect.top)),
    bottom: Math.max(...rects.map((rect) => rect.bottom))
  }
}

/**
 * 按 OCR 原始坐标绝对定位图片译文，并在横向相交时避让实际增高的前序译文。
 * 覆盖层自身同时承担流式占位高度，确保后续页面区块不会压到扩展后的 OCR 译文。
 * @param page 已挂载的译文页面。
 * @returns 无返回值。
 * @author zhenghq
 */
function normalizeOcrTranslationLayout(page: HTMLElement): void {
  if (!page.isConnected) return
  const scale = Number.parseFloat(page.style.getPropertyValue('--document-page-scale')) || 1
  const layers = page.querySelectorAll<HTMLElement>('.document-ocr-translation-layer')
  for (const layer of layers) {
    const imageBlock = layer.closest<HTMLElement>('.document-image-block')
    if (!imageBlock) continue
    const imageHeight = Math.max(1, Number.parseFloat(
      imageBlock.style.getPropertyValue('--document-image-content-height')
    ) || 1)
    const sourceImageHeight = Math.max(1, Number.parseFloat(
      imageBlock.style.getPropertyValue('--document-image-height')
    ) || 1)
    const contentScale = imageHeight / sourceImageHeight
    const layerRect = layer.getBoundingClientRect()
    const placedRegions: DocumentOcrFlowRect[] = []
    let layerBottom = imageHeight * scale
    for (const region of layer.querySelectorAll<HTMLElement>(':scope > .document-ocr-region')) {
      const sourceTop = Number(region.dataset.sourceTop)
      const sourceHeight = Number(region.dataset.sourceHeight)
      const sourceGap = Number(region.dataset.sourceGapBefore)
      const sourceTopPx = (Number.isFinite(sourceTop) ? Math.max(0, sourceTop) : 0) * imageHeight * scale
      const sourceHeightPx = (Number.isFinite(sourceHeight) ? Math.max(0, sourceHeight) : 0) *
        imageHeight * scale
      const gapPx = (Number.isFinite(sourceGap) ? Math.max(0, sourceGap) : 0) *
        contentScale * scale
      setInlinePixelPropertyIfChanged(region, 'minHeight', sourceHeightPx)
      const regionRect = region.getBoundingClientRect()
      const left = regionRect.left - layerRect.left
      const right = regionRect.right - layerRect.left
      const top = resolveDocumentOcrRegionFlowTop(
        sourceTopPx,
        { left, right },
        placedRegions,
        gapPx
      )
      const height = Math.max(0, regionRect.height)
      setInlinePixelPropertyIfChanged(region, 'top', top)
      placedRegions.push({ left, right, top, bottom: top + height })
      layerBottom = Math.max(layerBottom, top + height)
    }
    setInlinePixelPropertyIfChanged(layer, 'height', layerBottom)
  }
}

/**
 * 依据真实 DOM 高度修正 PDF 译文流式排版。
 * 图片优先锚定原文纵向坐标；只有横向相交的前序译文变高并越过该坐标时才继续下推，
 * 横向错开的内容不会把图片错误挤到页面下方。后续文本再从图片实际底边继续排列。
 * 文本与其他区块仍按原文段前距离跟随实际底边，避免使用原始 bbox 底边造成图片被重复下推。
 * @param page 已挂载的译文页面。
 * @returns 无返回值。
 * @author zhenghq
 */
function normalizeTranslationFlowLayout(page: HTMLElement): void {
  if (!page.isConnected || page.dataset.layout !== 'translation-flow') return
  // OCR 覆盖层必须先完成自身锚定，图片区块的实际高度才能参与后续流式避让。
  normalizeOcrTranslationLayout(page)
  normalizeImageStackLayout(page)
  normalizeImageOverlayLayout(page)
  const scale = Number.parseFloat(page.style.getPropertyValue('--document-page-scale')) || 1
  const pageMarginTop = Number.parseFloat(page.style.getPropertyValue('--document-page-margin-top')) || 0
  const computed = getComputedStyle(page)
  const borderTop = Number.parseFloat(computed.borderTopWidth) || 0
  const paddingTop = Number.parseFloat(computed.paddingTop) || 0
  const pageRect = page.getBoundingClientRect()
  // 页面 padding 已承载首个区块之前的原文留白，子元素坐标从这里开始计算，避免重复叠加。
  const flowOrigin = pageRect.top + borderTop + paddingTop
  let previousBottom = flowOrigin
  const flowDecorationAnchors: DocumentFlowDecorationAnchor[] = []
  const flowObstacles: DocumentFlowObstacle[] = []
  let alignedImageRow: { sourceTop: number; actualTop: number } | undefined

  for (const directChild of page.children) {
    if (!(directChild instanceof HTMLElement)) continue
    // 同行分组作为一个整体参与纵向排版，组内子区块不能再次叠加段前距离。
    const child = directChild
    // 绝对定位装饰线不占据普通流，不能参与实际底边测量，否则后续正文会被重复下推。
    if (child.dataset.flowOccupiesSpace === 'false') {
      const shapeSourceTop = Number(child.dataset.sourceTop)
      const desiredTop = resolveTranslationFlowDecorationTop(
        shapeSourceTop,
        flowDecorationAnchors,
        scale
      )
      if (desiredTop !== undefined) {
        const oldOffset = Number.parseFloat(
          child.style.getPropertyValue('--document-shape-flow-offset')
        ) || 0
        // 装饰线使用绝对定位，其 top 基准是页面内边距盒；先扣除上一次偏移，才能得到稳定基准。
        const baseTop = child.getBoundingClientRect().top - oldOffset
        setCssPixelPropertyIfChanged(child, '--document-shape-flow-offset', desiredTop - baseTop)
      } else {
        child.style.removeProperty('--document-shape-flow-offset')
      }
      continue
    }
    const sourceY = Number(child.dataset.sourceY)
    const sourceGap = Math.max(0, Number(child.dataset.sourceGapBefore) || 0)
    let gapPx = sourceGap * scale
    // 先记录调整前的二维范围；应用段前后重新测量，避免后续区块读到本轮布局之前的旧坐标。
    const currentObstacle = measureTranslationFlowObstacle(child, pageRect)
    const imageContainer = child.classList.contains('document-image-overlay') ||
      child.classList.contains('document-image-stack')
      ? child
      : child.classList.contains('document-image-block')
        ? child
        : child.querySelector<HTMLElement>(
          ':scope > .document-image-overlay, :scope > .document-image-stack, :scope > .document-image-block'
        )
    if (imageContainer && Number.isFinite(sourceY)) {
      const anchoredTop = flowOrigin + Math.max(0, sourceY - pageMarginTop) * scale
      const imageRect = imageContainer.getBoundingClientRect()
      const imageHeight = Number.parseFloat(
        imageContainer.style.getPropertyValue('--document-image-overlay-height')
      ) || Number.parseFloat(
        imageContainer.style.getPropertyValue('--document-image-stack-height')
      ) || imageRect.height / scale
      // 只有横向相交的前序内容才阻挡图片回填；同行分组使用子元素并集，避免弹性空白误判。
      gapPx = resolveTranslationImageFlowGap({
        anchoredTop,
        previousBottom,
        baseTop: child.getBoundingClientRect().top - (Number.parseFloat(child.style.getPropertyValue('--document-image-flow-gap-before')) || 0) * scale, // 扣除已应用负边距，得到稳定自然顶部。
        flowOrigin,
        imageRange: {
          left: imageRect.left - pageRect.left,
          right: imageRect.right - pageRect.left
        },
        imageHeight: imageHeight * scale,
        alignedImageRow,
        obstacles: flowObstacles
      })
      setCssPixelPropertyIfChanged(child, '--document-image-flow-gap-before', gapPx / scale)
      alignedImageRow = { sourceTop: anchoredTop, actualTop: imageContainer.getBoundingClientRect().top }
    } else {
      const currentGapPx = (Number.parseFloat(
        child.style.getPropertyValue('--document-flow-gap-before')
      ) || 0) * scale
      // 从当前顶部扣除已应用的段前距离，得到稳定的前序内容底边，避免重复叠加历次布局结果。
      const baseTop = child.getBoundingClientRect().top - currentGapPx
      gapPx = resolveTranslationFlowBlockGap({
        sourceGap: sourceGap * scale,
        baseTop,
        blockHeight: currentObstacle.bottom - currentObstacle.top,
        flowOrigin,
        blockRange: currentObstacle,
        obstacles: flowObstacles
      })
      setCssPixelPropertyIfChanged(child, '--document-flow-gap-before', gapPx / scale)
    }
    previousBottom = Math.max(previousBottom, measureTranslationFlowBottom(child))
    // 段前距离写入后再登记当前二维占位，供后续区块和图片判断是否需要避让。
    flowObstacles.push(measureTranslationFlowObstacle(child, pageRect))
    const sourceTop = Number(child.dataset.sourceTop)
    const sourceBottom = Number(child.dataset.sourceBottom)
    if (Number.isFinite(sourceTop) && Number.isFinite(sourceBottom)) {
      const childRect = child.getBoundingClientRect()
      flowDecorationAnchors.push({
        sourceTop,
        sourceBottom,
        actualTop: childRect.top,
        actualBottom: childRect.bottom
      })
    }
  }
}

/**
 * 将同行区块追加到页面；连续相同 flowGroupId 的区块共享一个横向 flex 容器。
 * 组容器承载首块的原点、段前距离与测量信息，组内区块只负责自身横向几何。
 * @param page 译文页面容器。
 * @param block 当前区块模型。
 * @param rendered 已渲染的区块元素。
 * @param groupClassName 分组容器使用的样式类名。
 * @param flowGroup 当前仍在延续的同组容器。
 * @returns 当前区块所属的同组容器；不属于分组时返回 undefined。
 * @author zhenghq
 */
function appendTranslationFlowBlock(
  page: HTMLElement,
  block: DocumentBlock,
  rendered: HTMLElement,
  groupClassName: string,
  flowGroup?: HTMLElement
): HTMLElement | undefined {
  if (!block.flowGroupId) {
    page.append(rendered)
    return undefined
  }
  if (flowGroup) {
    flowGroup.append(rendered)
    return flowGroup
  }
  const group = document.createElement('div')
  group.className = groupClassName
  group.dataset.flowGroupId = block.flowGroupId
  group.append(rendered)
  page.append(group)
  return group
}

/**
 * 为译文文本块写入独立的对齐锚点和可用宽度，避免所有段落共用整页边界。
 * 左对齐固定原左边界；居中固定原中心线；右对齐固定原右边界。
 * @param element 译文文本块。
 * @param block 文本区块。
 * @param pageWidth 原始页面宽度。
 * @param contentArea 原文正文内容区；用于保留左右页边距并扩展短标题译文。
 * @returns 无返回值。
 * @author zhenghq
 */
function applyTranslationBlockGeometry(
  element: HTMLElement,
  block: DocumentTextBlock,
  pageWidth: number,
  contentArea?: DocumentContentArea
): void {
  if (!block.bbox) return
  const left = Math.max(0, Math.min(pageWidth, block.bbox.x))
  const right = Math.max(left, Math.min(pageWidth, block.bbox.x + block.bbox.width))
  const blockWidth = Math.max(1, right - left)
  // 左对齐正文使用页面正文区右边界，既避免缩在原文短行内，也保留原文右侧页边距。
  // 居中标题围绕原中心线向正文区两侧扩展，避免中文短标题的 bbox 把英文译文过早折行。
  // 右对齐仍沿用原 bbox 宽度，防止扩大宽度后改变其右边缘。
  // 旧模型没有正文区信息时沿用原 bbox 宽度，不能退回物理页宽而重新铺满页面。
  const contentRight = Math.max(
    right,
    Math.min(pageWidth, contentArea?.right ?? right)
  )
  const contentLeft = Math.min(
    left,
    Math.max(0, contentArea?.left ?? left)
  )
  const blockCenter = block.bbox.x + block.bbox.width / 2
  const centeredWidth = Math.max(blockWidth, Math.min(
    contentRight - contentLeft,
    Math.min(blockCenter - contentLeft, contentRight - blockCenter) * 2
  ))
  const flowWidth = block.textAlign === 'center'
    ? centeredWidth
    : block.textAlign === 'right'
      ? blockWidth
      : block.role === 'code'
        ? blockWidth
        : Math.max(blockWidth, contentRight - left)
  const flowLeft = block.textAlign === 'center'
    ? blockCenter - flowWidth / 2
    : block.textAlign === 'right' ? right - flowWidth : left
  element.style.setProperty('--document-block-left', `${flowLeft}px`)
  element.style.setProperty('--document-block-width', `${flowWidth}px`)
  element.style.setProperty('--document-block-right', `${Math.max(0, pageWidth - right)}px`)
  element.dataset.blockWidth = String(blockWidth)
  if (block.textAlign) element.dataset.align = block.textAlign
}

/**
 * 为译文图片写入原文中的横向位置与尺寸，确保图片不被流式布局拉伸。
 * @param element 译文图片区块。
 * @param block 图片区块。
 * @param pageWidth 原始页面宽度。
 * @returns 无返回值。
 * @author zhenghq
 */
function applyTranslationImageGeometry(
  element: HTMLElement,
  block: DocumentImageBlock,
  pageWidth: number
): void {
  if (!block.bbox) return
  const left = Math.max(0, Math.min(pageWidth, block.bbox.x))
  const right = Math.max(left, Math.min(pageWidth, block.bbox.x + block.bbox.width))
  element.style.setProperty('--document-image-left', `${left}px`)
  element.style.setProperty('--document-image-width', `${Math.max(1, right - left)}px`)
  element.style.setProperty('--document-image-height', `${Math.max(1, block.bbox.height)}px`)
  element.style.setProperty('--document-image-content-left', '0px')
  element.style.setProperty('--document-image-content-top', '0px')
  element.style.setProperty('--document-image-content-width', `${Math.max(1, right - left)}px`)
  element.style.setProperty('--document-image-content-height', `${Math.max(1, block.bbox.height)}px`)
  element.dataset.geometry = 'source'
}

/**
 * 按图片自然宽高比计算 bbox 内的居中内容框，并写入底图和 OCR 层共享的 CSS 变量。
 * @param element 译文图片区块。
 * @param image 已加载的图片元素。
 * @param block 图片区块。
 * @returns 无返回值。
 * @author zhenghq
 */
function applyTranslationImageContentGeometry(
  element: HTMLElement,
  image: HTMLImageElement,
  block: DocumentImageBlock
): void {
  if (!block.bbox || element.dataset.geometry !== 'source') return
  const targetWidth = Math.max(1, Number.parseFloat(
    element.style.getPropertyValue('--document-image-width')
  ) || block.bbox.width)
  const targetHeight = Math.max(1, Number.parseFloat(
    element.style.getPropertyValue('--document-image-height')
  ) || block.bbox.height)
  const contentBox = resolveDocumentImageContentBox(
    image.naturalWidth,
    image.naturalHeight,
    targetWidth,
    targetHeight
  )
  element.style.setProperty('--document-image-content-left', `${contentBox.x}px`)
  element.style.setProperty('--document-image-content-top', `${contentBox.y}px`)
  element.style.setProperty('--document-image-content-width', `${contentBox.width}px`)
  element.style.setProperty('--document-image-content-height', `${contentBox.height}px`)
}

/**
 * 应用模型中的通用区块位置和样式。
 * @param element 目标元素。
 * @param block 文档区块。
 * @returns 无返回值。
 * @author zhenghq
 */
function applyBlockGeometry(element: HTMLElement, block: DocumentBlock): void {
  if (block.bbox) {
    element.style.left = `${block.bbox.x}px`
    element.style.top = `${block.bbox.y}px`
    element.style.width = `${Math.max(1, block.bbox.width)}px`
    element.style.minHeight = `${Math.max(1, block.bbox.height)}px`
  }
  Object.assign(element.style, styleProperties(block.style))
}

/**
 * 判断文本区块是否需要绝对页面定位；流式格式由 CSS 自动排版。
 * @param block 文本区块。
 * @returns 是否具有版面坐标。
 * @author zhenghq
 */
function hasPageGeometry(block: DocumentBlock): boolean {
  return Boolean(block.bbox)
}

/**
 * 判断文本区块是否至少包含一个非空可见片段。
 * @param block 文本区块。
 * @returns 是否存在可渲染文本。
 * @author zhenghq
 */
function hasVisibleText(block: DocumentTextBlock): boolean {
  // 用户清空整块译文后仍要保留占位 DOM，否则双击命中区域会消失且无法再次输入。
  return block.runs.some((run) => run.text.trim().length > 0 || run.manuallyEdited === true)
}

/**
 * 判断区块是否会在流式预览中产生可见内容。
 * 表格需要递归检查单元格，避免只有空结构时误判为可渲染。
 * @param block 文档区块。
 * @param side 当前渲染侧。
 * @returns 是否存在可渲染内容。
 * @author zhenghq
 */
function hasVisibleBlockContent(block: DocumentBlock, side: DocumentRenderSide): boolean {
  switch (block.kind) {
    case 'text':
      return hasVisibleText(block)
    case 'table':
      return block.rows.some((row) => row.cells.some((cell) =>
        cell.blocks.some((child) => hasVisibleBlockContent(child, side))))
    case 'image':
      return !block.renderPending || Boolean(block.alt?.trim()) ||
        (side === 'translation' && (block.ocrRegions ?? []).some((region) =>
          Boolean(region.translatedText?.trim())))
    case 'formula':
      return Boolean(block.latex?.trim() || block.mathml?.trim() || block.sourceText?.trim())
    case 'shape':
      return Boolean(block.label?.trim() || block.assetId || block.vectorPath)
    case 'break':
      return false
  }
}

/**
 * 判断文档模型是否至少包含一个可渲染区块。
 * @param model 当前文档模型。
 * @param side 当前渲染侧。
 * @returns 是否存在可见内容。
 * @author zhenghq
 */
function hasVisibleFlowContent(model: DocumentModel, side: DocumentRenderSide): boolean {
  return model.pages.some((page) =>
    page.blocks.some((block) => hasVisibleBlockContent(block, side)))
}

/**
 * 创建文本区块 DOM；正文只通过 textContent 写入，避免把译文当 HTML 执行。
 * @param block 文本区块。
 * @param side 当前渲染侧。
 * @param pageWidth 原始页面宽度。
 * @param contentArea 原文正文内容区。
 * @returns 文本区块元素。
 * @author zhenghq
 */
function renderTextBlock(
  block: DocumentTextBlock,
  side: DocumentRenderSide,
  pageWidth: number,
  contentArea?: DocumentContentArea
): HTMLElement {
  const element = document.createElement('div')
  element.className = `document-text-block document-text-${block.role}`
  element.dataset.blockId = block.blockId
  if (block.role === 'code') {
    // 代码块即使只恢复出横向外框，也必须显式标记为代码框，确保译文侧始终有
    // 主题边框和独立滚动区域；不能依赖 codeFrame 是否完整识别。
    element.dataset.codeFrame = 'true'
  }
  applyBlockGeometry(element, block)
  if (block.textAlign) {
    element.style.textAlign = block.textAlign
    element.dataset.align = block.textAlign
  }
  if (block.codeFrame) {
    // 代码框使用解析器识别的原始外框，不依赖已经移出模型的独立形状线。
    element.style.setProperty('--document-code-frame-left', `${block.codeFrame.x}px`)
    element.style.setProperty('--document-code-frame-width', `${block.codeFrame.width}px`)
  }
  if (side === 'translation') {
    applyTranslationBlockGeometry(element, block, pageWidth, contentArea)
  }
  if (block.toc) {
    // 目录项必须把标题、引导线和页码拆开排版；整段按普通 run 排列会把页码挤到下一行。
    element.classList.add('document-text-toc')
    const titleRun = block.runs.find((run) => run.protected !== true)
    const title = document.createElement('span')
    title.className = 'document-toc-title'
    title.dataset.runId = titleRun?.runId ?? `${block.blockId}-toc-title`
    title.textContent = block.runs
      .filter((run) => run.protected !== true)
      .map((run) => run.text)
      .join('')
    // 只有译文侧的目录标题允许就地手改，原文侧保持只读。
    if (side === 'translation') title.dataset.manuallyEditable = 'true'
    applyScalableTextStyle(title, titleRun ? effectiveTextStyle(block, titleRun) : block.style)
    const leader = document.createElement('span')
    leader.className = 'document-toc-leader'
    leader.setAttribute('aria-hidden', 'true')
    const pageNumber = document.createElement('span')
    pageNumber.className = 'document-toc-page'
    pageNumber.textContent = block.toc.pageNumber
    element.append(title, leader, pageNumber)
    return element
  }
  if (side === 'translation' && block.runs.some((run) => run.protected !== true)) {
    // 不含受保护片段的普通文本块作为整体编辑，避免用户只能逐 run 删除和输入。
    // 混合块仍按 run 编辑，防止在一次整块提交中覆盖 URL、公式等受保护内容。
    if (block.runs.every((run) => run.protected !== true)) element.dataset.manuallyEditable = 'true'
  }
  for (const run of block.runs) {
    const span = document.createElement('span')
    span.className = 'document-text-run'
    span.dataset.runId = run.runId
    span.textContent = run.text
    // 纯普通文本块由外层承载整块编辑；混合块才逐 run 编辑，受保护片段始终保持只读。
    if (side === 'translation' && run.protected !== true && !element.dataset.manuallyEditable) {
      span.dataset.manuallyEditable = 'true'
    }
    applyScalableTextStyle(span, effectiveTextStyle(block, run))
    element.append(span)
  }
  return element
}

/**
 * 按阅读顺序排列 OCR 区域；缺少坐标时保持引擎返回顺序。
 * @param regions OCR 区域列表。
 * @returns 已按从上到下、从左到右排列的区域副本。
 * @author zhenghq
 */
function orderedOcrRegions(regions: readonly DocumentOcrRegion[]): DocumentOcrRegion[] {
  return regions
    .map((region, index) => ({ region, index }))
    .sort((left, right) => {
      const topDifference = left.region.bbox.y - right.region.bbox.y
      if (Math.abs(topDifference) > 0.002) return topDifference
      const leftDifference = left.region.bbox.x - right.region.bbox.x
      return Math.abs(leftDifference) > 0.002 ? leftDifference : left.index - right.index
    })
    .map((entry) => entry.region)
}

/**
 * 计算 OCR 覆盖层的可见内容签名，用于跳过未变化图片的覆盖层替换。
 * @param block 图片区块。
 * @returns 覆盖层签名；没有可见译文时返回空字符串。
 * @author zhenghq
 */
function ocrTranslationLayerSignature(block: DocumentImageBlock): string {
  const regions = orderedOcrRegions(block.ocrRegions ?? [])
    .filter(shouldRenderDocumentOcrTranslationRegion)
  if (regions.length === 0) return ''
  return JSON.stringify(regions.map((region) => ({
    regionId: region.regionId,
    bbox: region.bbox,
    translatedText: region.translatedText,
    style: region.style,
    textAlign: region.textAlign,
    status: region.status,
    manuallyEdited: region.manuallyEdited
  })))
}

/**
 * 创建 OCR 译文覆盖层；源文侧不叠加识别文本，译文侧为每个已识别区域保留交互槽位。
 * 缺少译文时槽位保持透明，但仍可悬停、右键手改或触发单目标重译。
 * 覆盖层高度随译文实际换行增长，相邻区域由流式布局避让，避免文字被裁切或重叠。
 * @param imageBlock 图片区块。
 * @param region OCR 区域。
 * @param previousRegion 上一条可见 OCR 区域。
 * @param side 当前渲染侧。
 * @returns OCR 覆盖元素；无需显示时返回 null。
 * @author zhenghq
 */
function renderOcrRegion(
  imageBlock: DocumentImageBlock,
  region: DocumentOcrRegion,
  previousRegion: DocumentOcrRegion | undefined,
  side: DocumentRenderSide
): HTMLElement | null {
  void side
  const translatedText = region.translatedText?.trim()
  if (!shouldRenderDocumentOcrTranslationRegion(region)) return null
  const element = document.createElement('div')
  element.className = 'document-ocr-region'
  element.dataset.status = region.status
  element.dataset.translationState = translatedText ? 'translated' : 'untranslated'
  element.dataset.regionId = region.regionId
  // 纵向沿用 OCR 安全框；左对齐译文可扩展到同行右侧区域前，避免中文在窄框内逐字换行。
  const box = resolveDocumentOcrOverlayBox(region.bbox)
  const horizontalBounds = resolveDocumentOcrTranslationHorizontalBounds(
    region,
    imageBlock.ocrRegions ?? []
  )
  const imageHeight = Math.max(1, imageBlock.bbox?.height ?? 1)
  const imageWidth = Math.max(1, imageBlock.bbox?.width ?? 1)
  const fontSize = resolveOcrRegionFontSize(region, imageHeight)
  const lineHeight = resolveOcrRegionLineHeight(fontSize)
  const padding = resolveOcrRegionPadding(imageWidth, imageHeight, region)
  element.style.left = `${horizontalBounds.x * 100}%`
  element.style.width = `${horizontalBounds.width * 100}%`
  element.dataset.sourceTop = String(box.y)
  element.dataset.sourceHeight = String(box.height)
  const sourceGapBefore = resolveOcrRegionGapBefore(region, previousRegion, imageHeight)
  element.dataset.sourceGapBefore = String(sourceGapBefore)
  // CSS 变量使用原图像素坐标，再由页面缩放比例统一换算到预览尺寸。
  element.style.setProperty('--document-ocr-source-top', `${box.y * imageHeight}px`)
  element.style.setProperty('--document-ocr-source-height', `${box.height * imageHeight}px`)
  // 独立图片会随预览栏缩放，百分比坐标可与底图保持同一纵向基准。
  element.style.setProperty('--document-ocr-source-top-percent', `${box.y * 100}%`)
  element.style.setProperty('--document-ocr-source-height-percent', `${box.height * 100}%`)
  element.style.setProperty('--document-ocr-gap-before', `${sourceGapBefore}px`)
  element.style.setProperty(
    '--document-ocr-padding-x',
    `${padding.x}px`
  )
  element.style.setProperty('--document-ocr-padding-y', `${padding.y}px`)
  element.style.setProperty('--document-ocr-font-size-pt', String(fontSize))
  element.style.setProperty('--document-ocr-line-height', String(lineHeight / fontSize))
  if (region.style?.color) element.style.color = region.style.color
  if (region.style?.fontWeight !== undefined) element.style.fontWeight = String(region.style.fontWeight)
  element.style.fontFamily = pdfPreviewFontFamily(region.style?.fontFamily ?? 'Noto Sans SC')
  if (region.style?.italic) element.style.fontStyle = 'italic'
  if (region.textAlign) element.style.textAlign = region.textAlign
  // 白底由译文文字本身绘制，换行后每一行只覆盖实际内容宽度，避免继续沿用原文识别框。
  const textElement = document.createElement('span')
  textElement.className = 'document-ocr-region-text'
  textElement.textContent = translatedText ?? ''
  // OCR 译文覆盖层只在译文侧渲染，双击即可块级手改。
  textElement.dataset.manuallyEditable = 'true'
  element.append(textElement)
  return element
}

/**
 * 创建图片的 OCR 译文覆盖层；只要存在已识别原文就返回可交互覆盖层。
 * @param block 图片区块。
 * @returns 可直接挂载到图片区块的 OCR 覆盖层。
 * @author zhenghq
 */
function createOcrTranslationLayer(block: DocumentImageBlock): HTMLElement | null {
  const regions = orderedOcrRegions(block.ocrRegions ?? [])
    .filter(shouldRenderDocumentOcrTranslationRegion)
  if (regions.length === 0) return null
  const layer = document.createElement('div')
  layer.className = 'document-ocr-translation-layer'
  layer.dataset.ocrTranslationSignature = ocrTranslationLayerSignature(block)
  let previousRegion: DocumentOcrRegion | undefined
  for (const region of regions) {
    const overlay = renderOcrRegion(block, region, previousRegion, 'translation')
    if (overlay) layer.append(overlay)
    previousRegion = region
  }
  return layer
}

/**
 * 判断 OCR 区域是否具有可展示的识别原文。
 * @param region OCR 区域。
 * @returns 是否存在非空识别原文。
 * @author zhenghq
 */
function hasOcrRegionText(region: DocumentOcrRegion): boolean {
  return Boolean(region.text?.trim())
}

/**
 * 创建图片的 OCR 原文透明覆盖层；文字与底图坐标一致，便于对照阅读和复制。
 * 覆盖层不使用纸张底或遮罩，只承载透明文字，因此切换显示方式时原文图片不受遮挡。
 * @param block 图片区块。
 * @returns 可挂载到图片区块的 OCR 原文覆盖层；没有原文时返回 null。
 * @author zhenghq
 */
function createOcrTextLayer(block: DocumentImageBlock): HTMLElement | null {
  const regions = orderedOcrRegions(block.ocrRegions ?? []).filter(hasOcrRegionText)
  if (regions.length === 0) return null
  const layer = document.createElement('div')
  layer.className = 'document-ocr-text-layer document-ocr-print-text-layer'
  const imageHeight = Math.max(1, block.bbox?.height ?? 1)
  for (const region of regions) {
    const box = normalizeDocumentOcrRegionBox(region.bbox)
    const regionElement = document.createElement('span')
    regionElement.className = 'document-ocr-text-region'
    regionElement.dataset.regionId = region.regionId
    regionElement.dataset.status = region.status
    regionElement.style.left = `${box.x * 100}%`
    regionElement.style.top = `${box.y * 100}%`
    regionElement.style.width = `${box.width * 100}%`
    regionElement.style.height = `${box.height * 100}%`
    const fontSize = resolveOcrRegionFontSize(region, imageHeight)
    const lineHeight = resolveOcrRegionLineHeight(fontSize)
    regionElement.style.setProperty('--document-ocr-font-size-pt', String(fontSize))
    regionElement.style.setProperty('--document-ocr-line-height', String(lineHeight / fontSize))
    if (region.style?.fontWeight !== undefined) regionElement.style.fontWeight = String(region.style.fontWeight)
    regionElement.style.fontFamily = pdfPreviewFontFamily(region.style?.fontFamily ?? 'Noto Sans SC')
    if (region.style?.italic) regionElement.style.fontStyle = 'italic'
    if (region.textAlign) regionElement.style.textAlign = region.textAlign
    regionElement.textContent = region.text
    layer.append(regionElement)
  }
  return layer
}

/**
 * 按当前栏位和 OCR 展示模式挂载图片的透明文字层与译文覆盖层。
 * 原文栏只允许显示原图，必要时叠加透明可选文字；译文栏始终保留打印文字层，
 * 并在译文模式下额外挂载可见译文覆盖层。
 * @param wrapper 图片区块容器。
 * @param block 图片区块。
 * @param side 当前渲染侧。
 * @param tab 快照所属的文档 Tab。
 * @returns 无返回值。
 * @author zhenghq
 */
function appendImageOcrLayers(
  wrapper: HTMLElement,
  block: DocumentImageBlock,
  side: DocumentRenderSide,
  tab: DocumentWorkspaceTab
): void {
  if (side === 'source') {
    if (tab.ocrDisplayMode !== 'ocr-text') return
    const textLayer = createOcrTextLayer(block)
    if (!textLayer) return
    wrapper.dataset.ocrText = 'true'
    wrapper.append(textLayer)
    return
  }

  // 译文栏的打印文字层在译文模式下仅屏幕隐藏，仍须挂载供双层 PDF 导出。
  const textLayer = createOcrTextLayer(block)
  if (textLayer) {
    wrapper.dataset.ocrText = 'true'
    wrapper.append(textLayer)
  }
  if (tab.ocrDisplayMode === 'ocr-text') return
  const translationLayer = createOcrTranslationLayer(block)
  if (!translationLayer) return
  wrapper.dataset.ocrTranslation = 'true'
  wrapper.append(translationLayer)
}

/**
 * 递归收集页面中所有带 OCR 原文的图片区块；表格单元格内的图片也必须进入双层 PDF 文字层。
 * @param blocks 待遍历区块。
 * @param output 收集结果。
 * @returns 无返回值。
 * @author zhenghq
 */
function collectOcrImageBlocks(blocks: readonly DocumentBlock[], output: DocumentImageBlock[] = []): DocumentImageBlock[] {
  for (const block of blocks) {
    if (block.kind === 'image') {
      if ((block.ocrRegions ?? []).some(hasOcrRegionText)) output.push(block)
      continue
    }
    if (block.kind !== 'table') continue
    for (const row of block.rows) {
      for (const cell of row.cells) collectOcrImageBlocks(cell.blocks, output)
    }
  }
  return output
}

/**
 * 递归收集页面中的原生文本、表格文本和公式原文。
 * PDF.js 已能从原生 PDF 提取文本，但页面仍以 Canvas 展示；这些区块必须补入透明文字层，
 * 才能在“OCR 原文”中选中文字，并让导出的双层 PDF 保留可检索文本。
 * @param blocks 待遍历区块。
 * @param output 收集结果。
 * @returns 按原阅读顺序收集到的文本区块。
 * @author zhenghq
 */
function collectPdfTextBlocks(
  blocks: readonly DocumentBlock[],
  output: DocumentTextBlock[] = []
): DocumentTextBlock[] {
  for (const block of blocks) {
    if (block.kind === 'text') {
      if (hasVisibleText(block)) output.push(block)
      continue
    }
    if (block.kind === 'formula') continue
    if (block.kind !== 'table') continue
    for (const row of block.rows) {
      for (const cell of row.cells) collectPdfTextBlocks(cell.blocks, output)
    }
  }
  return output
}

/**
 * 递归收集页面中的公式原文；公式可能位于表格单元格内。
 * @param blocks 待遍历区块。
 * @param output 收集结果。
 * @returns 带可展示原文的公式区块。
 * @author zhenghq
 */
function collectPdfFormulaBlocks(
  blocks: readonly DocumentBlock[],
  output: DocumentFormulaBlock[] = []
): DocumentFormulaBlock[] {
  for (const block of blocks) {
    if (block.kind === 'formula') {
      if (block.sourceText?.trim()) output.push(block)
      continue
    }
    if (block.kind !== 'table') continue
    for (const row of block.rows) {
      for (const cell of row.cells) collectPdfFormulaBlocks(cell.blocks, output)
    }
  }
  return output
}

/**
 * 将区块坐标转换为整页百分比，并限制在页面范围内。
 * @param value 原始坐标。
 * @param total 页面宽度或高度。
 * @returns 0 到 100 的百分比值。
 * @author zhenghq
 */
function pdfPagePercent(value: number, total: number): number {
  return Math.max(0, Math.min(100, value / Math.max(1, total) * 100))
}

/**
 * 创建覆盖整张 PDF 页面的透明文字层。
 * 原生文本和公式使用整页坐标，图片 OCR 区域使用图片内归一化坐标；
 * 两类坐标都换算到同一页面矩形后，才能随 Canvas 等比缩放并正确导出双层 PDF。
 * @param page 当前文档页面。
 * @returns 透明文字层；页面没有可检索文字时返回 null。
 * @author zhenghq
 */
function createPdfOcrTextLayer(page: DocumentPage): HTMLElement | null {
  const textBlocks = collectPdfTextBlocks(page.blocks)
  const formulaBlocks = collectPdfFormulaBlocks(page.blocks)
  const imageBlocks = collectOcrImageBlocks(page.blocks)
  if (textBlocks.length === 0 && formulaBlocks.length === 0 && imageBlocks.length === 0) return null
  const layer = document.createElement('div')
  layer.className = 'document-ocr-text-layer document-ocr-print-text-layer'
  for (const block of textBlocks) {
    const box = block.bbox
    if (!box || box.width <= 0 || box.height <= 0) continue
    const regionElement = document.createElement('span')
    regionElement.className = 'document-ocr-text-region'
    regionElement.dataset.blockId = block.blockId
    regionElement.style.left = `${pdfPagePercent(box.x, page.width)}%`
    regionElement.style.top = `${pdfPagePercent(box.y, page.height)}%`
    regionElement.style.width = `${pdfPagePercent(box.width, page.width)}%`
    regionElement.style.height = `${pdfPagePercent(box.height, page.height)}%`
    const style = effectiveTextStyle(block, block.runs[0] ?? {
      runId: `${block.blockId}-text-layer`,
      text: ''
    })
    const fontSize = style.fontSize ?? Math.max(1, box.height)
    const lineHeight = style.lineHeight ?? fontSize * 1.15
    regionElement.style.setProperty('--document-ocr-font-size-pt', String(fontSize))
    regionElement.style.setProperty('--document-ocr-line-height', String(lineHeight / fontSize))
    if (style.fontWeight !== undefined) regionElement.style.fontWeight = String(style.fontWeight)
    if (style.fontFamily) regionElement.style.fontFamily = pdfPreviewFontFamily(style.fontFamily)
    if (style.italic) regionElement.style.fontStyle = 'italic'
    if (block.textAlign) regionElement.style.textAlign = block.textAlign
    regionElement.textContent = block.runs.map((run) => run.text).join('')
    layer.append(regionElement)
  }
  for (const block of formulaBlocks) {
    const box = block.bbox
    const text = block.sourceText?.trim()
    if (!box || !text || box.width <= 0 || box.height <= 0) continue
    const regionElement = document.createElement('span')
    regionElement.className = 'document-ocr-text-region'
    regionElement.dataset.blockId = block.blockId
    regionElement.style.left = `${pdfPagePercent(box.x, page.width)}%`
    regionElement.style.top = `${pdfPagePercent(box.y, page.height)}%`
    regionElement.style.width = `${pdfPagePercent(box.width, page.width)}%`
    regionElement.style.height = `${pdfPagePercent(box.height, page.height)}%`
    regionElement.style.setProperty('--document-ocr-font-size-pt', String(Math.max(1, box.height)))
    regionElement.style.setProperty('--document-ocr-line-height', '1.15')
    regionElement.textContent = text
    layer.append(regionElement)
  }
  for (const block of imageBlocks) {
    const imageBox = block.bbox
    if (!imageBox || imageBox.width <= 0 || imageBox.height <= 0) continue
    for (const region of orderedOcrRegions(block.ocrRegions ?? []).filter(hasOcrRegionText)) {
      const normalizedRegion = normalizeDocumentOcrRegionBox(region.bbox)
      const regionElement = document.createElement('span')
      regionElement.className = 'document-ocr-text-region'
      regionElement.dataset.regionId = region.regionId
      regionElement.dataset.status = region.status
      const left = Math.max(0, Math.min(1,
        (imageBox.x + normalizedRegion.x * imageBox.width) / page.width))
      const top = Math.max(0, Math.min(1,
        (imageBox.y + normalizedRegion.y * imageBox.height) / page.height))
      const width = Math.max(0, Math.min(1 - left,
        normalizedRegion.width * imageBox.width / page.width))
      const height = Math.max(0, Math.min(1 - top,
        normalizedRegion.height * imageBox.height / page.height))
      regionElement.style.left = `${left * 100}%`
      regionElement.style.top = `${top * 100}%`
      regionElement.style.width = `${width * 100}%`
      regionElement.style.height = `${height * 100}%`
      const fontSize = resolveOcrRegionFontSize(region, imageBox.height)
      const lineHeight = resolveOcrRegionLineHeight(fontSize)
      regionElement.style.setProperty('--document-ocr-font-size-pt', String(fontSize))
      regionElement.style.setProperty('--document-ocr-line-height', String(lineHeight / fontSize))
      if (region.style?.fontWeight !== undefined) {
        regionElement.style.fontWeight = String(region.style.fontWeight)
      }
      regionElement.style.fontFamily = pdfPreviewFontFamily(region.style?.fontFamily ?? 'Noto Sans SC')
      if (region.style?.italic) regionElement.style.fontStyle = 'italic'
      if (region.textAlign) regionElement.style.textAlign = region.textAlign
      regionElement.textContent = region.text
      layer.append(regionElement)
    }
  }
  return layer.childElementCount > 0 ? layer : null
}

/**
 * 解析图片当前是否仍处于运行期 OCR 占位状态。
 * 只读恢复/历史快照中的 renderPending 已过时，必须忽略并立即尝试受控资源加载。
 * @param block 图片区块模型。
 * @param tab 图片所属的文档 Tab。
 * @returns 仅活动任务确实等待图片生成时返回 true。
 * @author zhenghq
 */
function resolveDocumentImageRenderPending(
  block: DocumentImageBlock,
  tab: DocumentWorkspaceTab
): boolean {
  return block.renderPending === true && !isReadOnlyDocumentTab(tab)
}

/**
 * 创建图片区块；资源加载成功前使用占位区域，加载完成后填入图片。
 * @param block 图片区块。
 * @param side 当前渲染侧。
 * @param pageWidth 原始页面宽度。
 * @param jobId 图片所属任务标识。
 * @param tab 快照所属的文档 Tab。
 * @param pageIndex 图片所在页面索引。
 * @returns 图片区块元素。
 * @author zhenghq
 */
function renderImageBlock(
  block: DocumentImageBlock,
  side: DocumentRenderSide,
  pageWidth: number,
  jobId: string,
  tab: DocumentWorkspaceTab,
  pageIndex: number
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'document-image-block'
  wrapper.dataset.blockId = block.blockId
  applyBlockGeometry(wrapper, block)
  if (side === 'translation') applyTranslationImageGeometry(wrapper, block, pageWidth)
  const renderPending = resolveDocumentImageRenderPending(block, tab)
  if (renderPending) {
    wrapper.dataset.pending = 'true'
    renderDocumentImagePlaceholder(wrapper, block)
  } else {
    const image = document.createElement('img')
    image.className = 'document-page-image'
    image.alt = block.alt ?? ''
    image.decoding = 'async'
    wrapper.append(image)
    loadDocumentImageAsset(wrapper, image, block, jobId, tab, pageIndex)
  }
  appendImageOcrLayers(wrapper, block, side, tab)
  return wrapper
}

/**
 * 创建译文侧的图片叠放组；外层只占一次普通流空间，成员按原始坐标绝对覆盖。
 * @param blocks 同一 stackGroupId 下的图片区块。
 * @param side 当前渲染侧。
 * @param pageWidth 原始页面宽度。
 * @param jobId 图片所属任务标识。
 * @param tab 快照所属的文档 Tab。
 * @param pageIndex 图片所在页面索引。
 * @returns 叠放组容器。
 * @author zhenghq
 */
function renderImageStackBlock(
  blocks: readonly DocumentImageBlock[],
  side: DocumentRenderSide,
  pageWidth: number,
  jobId: string,
  tab: DocumentWorkspaceTab,
  pageIndex: number
): HTMLElement {
  const stack = document.createElement('div')
  stack.className = 'document-image-stack'
  stack.dataset.stackGroupId = blocks[0]?.stackGroupId ?? ''
  const bounds = resolveDocumentImageStackBounds(blocks)
  if (bounds) {
    stack.style.setProperty('--document-image-left', `${Math.max(0, Math.min(pageWidth, bounds.x))}px`)
    stack.style.setProperty('--document-image-width', `${Math.max(1, bounds.width)}px`)
    stack.style.setProperty('--document-image-height', `${Math.max(1, bounds.height)}px`)
    stack.style.setProperty('--document-image-stack-height', `${Math.max(1, bounds.height)}px`)
    stack.style.setProperty('--document-image-stack-base-height', `${Math.max(1, bounds.height)}px`)
  }
  const orderedBlocks = [...blocks].sort((left, right) =>
    (left.stackOrder ?? 0) - (right.stackOrder ?? 0))
  for (const block of orderedBlocks) {
    const member = renderImageBlock(block, side, pageWidth, jobId, tab, pageIndex)
    member.dataset.imageStackMember = 'true'
    member.dataset.stackOrder = String(block.stackOrder ?? 0)
    if (bounds && block.bbox) {
      const offset = resolveDocumentImageStackMemberOffset(block.bbox, bounds)
      member.style.setProperty(
        '--document-image-stack-member-left',
        `${offset.left}px`
      )
      member.style.setProperty(
        '--document-image-stack-member-top',
        `${offset.top}px`
      )
      // 成员本身不能建立堆叠上下文，否则底层图片的 OCR 译文永远无法盖过上层底图。
      // 只给底图分层；OCR 层在 CSS 中统一提升到全部底图之上。
      member.style.setProperty('--document-image-stack-layer', String((block.stackOrder ?? 0) + 1))
    }
    stack.append(member)
  }
  return stack
}

/**
 * 创建表格区块并递归渲染单元格中的受支持内容。
 * @param block 表格区块。
 * @param side 当前渲染侧。
 * @param pageWidth 原始页面宽度，用于约束表格横向范围。
 * @param jobId 表格所属任务标识。
 * @param tab 快照所属的文档 Tab。
 * @param pageIndex 表格所在页面索引。
 * @returns 表格区块元素。
 * @author zhenghq
 */
function renderTableBlock(
  block: DocumentTableBlock,
  side: DocumentRenderSide,
  pageWidth: number,
  jobId: string,
  tab: DocumentWorkspaceTab,
  pageIndex: number
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'document-table-block'
  wrapper.dataset.blockId = block.blockId
  applyBlockGeometry(wrapper, block)
  if (block.bbox) {
    const left = Math.max(0, Math.min(pageWidth, block.bbox.x))
    const width = Math.max(1, Math.min(block.bbox.width, pageWidth - left))
    wrapper.style.setProperty('--document-table-left', `${left}px`)
    wrapper.style.setProperty('--document-table-width', `${width}px`)
  }
  const table = document.createElement('table')
  const renderCellBlocks = (cell: DocumentTableCell): HTMLElement[] =>
    renderDocumentTableCellBlocks(
      cell.blocks,
      (child) => renderTableCellBlock(child, side, jobId, tab, pageIndex),
      (image) => renderTableCellImageBlock(image, side, jobId, tab, pageIndex),
      (text) => renderTableCellBlock(text, side, jobId, tab, pageIndex)
    )
  // 两侧都沿用原文列宽，保证译文表格与源 PDF 的列边界一致。
  table.style.tableLayout = 'fixed'
  if (block.columnWidths?.length) {
    const columns = document.createElement('colgroup')
    for (const width of normalizeDocumentTableColumnWidths(block.columnWidths, block.bbox?.width)) {
      const column = document.createElement('col')
      column.style.width = `${width}px`
      columns.append(column)
    }
    table.append(columns)
  }
  const headerRowCount = Math.max(0, Math.min(block.headerRows ?? 0, block.rows.length))
  if (headerRowCount > 0) {
    const head = document.createElement('thead')
    for (const row of block.rows.slice(0, headerRowCount)) {
      const tableRow = document.createElement('tr')
      tableRow.dataset.rowId = row.rowId
      for (const cell of row.cells) {
        const tableCell = document.createElement('th')
        tableCell.scope = 'col'
        tableCell.colSpan = Math.max(1, cell.colSpan)
        tableCell.rowSpan = Math.max(1, cell.rowSpan)
        for (const child of renderCellBlocks(cell)) {
          tableCell.append(child)
        }
        tableRow.append(tableCell)
      }
      head.append(tableRow)
    }
    table.append(head)
  }
  const body = document.createElement('tbody')
  for (const row of block.rows.slice(headerRowCount)) {
    const tableRow = document.createElement('tr')
    tableRow.dataset.rowId = row.rowId
    for (const cell of row.cells) {
      const tableCell = document.createElement('td')
      tableCell.colSpan = Math.max(1, cell.colSpan)
      tableCell.rowSpan = Math.max(1, cell.rowSpan)
      for (const child of renderCellBlocks(cell)) {
        tableCell.append(child)
      }
      tableRow.append(tableCell)
    }
    body.append(tableRow)
  }
  table.append(body)
  wrapper.append(table)
  return wrapper
}

/**
 * 渲染表格单元格内容；译文单元格是独立流式区域，不能沿用 PDF 页面的绝对坐标。
 * @param block 单元格子区块。
 * @param side 当前渲染侧。
 * @param jobId 单元格内容所属任务标识。
 * @param tab 快照所属的文档 Tab。
 * @param pageIndex 单元格所在页面索引。
 * @returns 单元格子区块元素。
 * @author zhenghq
 */
function renderTableCellBlock(
  block: DocumentBlock,
  side: DocumentRenderSide,
  jobId: string,
  tab: DocumentWorkspaceTab,
  pageIndex: number
): HTMLElement {
  const pageWidth = 1
  const element = block.kind === 'image'
    ? renderTableCellImageBlock(block, side, jobId, tab, pageIndex)
    : renderBlock(block, side, pageWidth, undefined, jobId, tab, pageIndex)
  // 单元格内子区块的 bbox 是整页坐标，标记后由 CSS 清除页面级偏移并限制在单元格内。
  element.dataset.tableCellContent = 'true'
  return element
}

/**
 * 创建表格单元格图片；图片进入单元格普通流并按列宽等比缩放。
 * @param block 表格单元格内的图片区块。
 * @param side 当前渲染侧。
 * @param jobId 图片所属任务标识。
 * @param tab 快照所属的文档 Tab。
 * @param pageIndex 图片所在页面索引。
 * @returns 不继承页面绝对坐标的图片区块元素。
 * @author zhenghq
 */
function renderTableCellImageBlock(
  block: DocumentImageBlock,
  side: DocumentRenderSide,
  jobId: string,
  tab: DocumentWorkspaceTab,
  pageIndex: number
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'document-image-block'
  wrapper.dataset.blockId = block.blockId
  wrapper.dataset.tableCellImage = 'true'
  wrapper.dataset.tableCellContent = 'true'
  if (side === 'translation') wrapper.dataset.renderSide = side
  const renderPending = resolveDocumentImageRenderPending(block, tab)
  if (renderPending) {
    wrapper.dataset.pending = 'true'
    renderDocumentImagePlaceholder(wrapper, block)
  } else {
    const image = document.createElement('img')
    image.className = 'document-page-image'
    image.alt = block.alt ?? ''
    image.decoding = 'async'
    wrapper.append(image)
    loadDocumentImageAsset(wrapper, image, block, jobId, tab, pageIndex)
  }
  appendImageOcrLayers(wrapper, block, side, tab)
  return wrapper
}

/**
 * 判断 PDF 形状区块是否为需要与表格外边界统一的结构框线。
 * 原生表格外框通常为 1pt 以上，而原文下划线多为 0.5–0.75pt；仅统一前者，
 * 避免把正文中的细下划线误画成表格边界。
 * @param block 形状区块。
 * @returns 是否为结构框线。
 * @author zhenghq
 */
function isPdfStructuralLine(block: Extract<DocumentBlock, { kind: 'shape' }>): boolean {
  return Boolean(block.line && (block.line.thickness ?? 1) >= 1)
}

/**
 * 创建可随页面缩放的直线装饰区块；结构框线复用表格边界样式，细线保留原始 PDF 信息。
 * @param block 形状区块。
 * @returns 形状区块元素。
 * @author zhenghq
 */
function renderShapeBlock(block: Extract<DocumentBlock, { kind: 'shape' }>): HTMLElement {
  const element = document.createElement('div')
  element.className = 'document-shape-block'
  element.dataset.blockId = block.blockId
  element.textContent = block.line ? '' : block.label ?? ''
  applyBlockGeometry(element, block)
  if (block.line) {
    element.dataset.lineOrientation = block.line.orientation
    if (isPdfStructuralLine(block)) {
      element.dataset.structuralLine = 'true'
      element.style.setProperty('--document-line-color', 'var(--document-table-boundary)')
      element.style.setProperty('--document-line-thickness', '2px')
    } else {
      element.style.setProperty('--document-line-color', block.line.color ?? 'var(--document-paper-text)')
      element.style.setProperty('--document-line-thickness', `${Math.max(0.5, block.line.thickness ?? 1)}px`)
    }
    if (block.bbox) {
      element.style.setProperty('--document-shape-left', `${Math.max(0, block.bbox.x)}px`)
      element.style.setProperty('--document-shape-top', `${Math.max(0, block.bbox.y)}px`)
      element.style.setProperty('--document-shape-width', `${Math.max(1, block.bbox.width)}px`)
      element.style.setProperty('--document-shape-height', `${Math.max(1, block.bbox.height)}px`)
    }
  }
  return element
}

/**
 * 创建公式区块；首版保留 LaTeX/MathML 原始表达，不执行任意标记。
 * @param block 公式区块。
 * @returns 公式区块元素。
 * @author zhenghq
 */
function renderFormulaBlock(block: Extract<DocumentBlock, { kind: 'formula' }>): HTMLElement {
  const element = document.createElement('div')
  element.className = 'document-formula-block'
  element.dataset.blockId = block.blockId
  element.textContent = block.latex ?? block.sourceText ?? block.mathml ?? t('document.formulaPreserved')
  applyBlockGeometry(element, block)
  return element
}

/**
 * 根据区块类型创建安全 DOM。
 * @param block 文档区块。
 * @param side 当前渲染侧。
 * @param pageWidth 原始页面宽度。
 * @param contentArea 原文正文内容区。
 * @param jobId 区块所属任务标识。
 * @param tab 快照所属的文档 Tab。
 * @param pageIndex 区块所在页面索引。
 * @returns 区块元素。
 * @author zhenghq
 */
function renderBlock(
  block: DocumentBlock,
  side: DocumentRenderSide,
  pageWidth: number,
  contentArea: DocumentContentArea | undefined,
  jobId: string,
  tab: DocumentWorkspaceTab,
  pageIndex: number
): HTMLElement {
  switch (block.kind) {
    case 'text': return renderTextBlock(block, side, pageWidth, contentArea)
    case 'image': return renderImageBlock(block, side, pageWidth, jobId, tab, pageIndex)
    case 'table': return renderTableBlock(block, side, pageWidth, jobId, tab, pageIndex)
    case 'formula': return renderFormulaBlock(block)
    case 'shape': return renderShapeBlock(block)
    case 'break': {
      const element = document.createElement('div')
      element.className = 'document-break-block'
      element.dataset.breakType = block.breakType
      return element
    }
  }
}

/**
 * 创建单页容器并渲染全部区块。
 * @param page 文档页面。
 * @param side 当前渲染侧。
 * @param translationInitialScale 译文页初始缩放比例。
 * @param jobId 页面所属任务标识。
 * @param tab 快照所属的文档 Tab。
 * @param layoutOverride 可选的页面布局覆盖；独立图片必须让原文和译文共用绝对布局。
 * @returns 页面元素。
 * @author zhenghq
 */
function renderPage(
  page: DocumentPage,
  side: DocumentRenderSide,
  translationInitialScale: number,
  jobId: string,
  tab: DocumentWorkspaceTab,
  layoutOverride?: 'absolute' | 'translation-flow' | 'flow'
): HTMLElement {
  const element = document.createElement('article')
  element.className = 'document-page'
  element.dataset.pageId = page.pageId
  element.dataset.sourceWidth = String(Math.max(1, page.width))
  element.style.width = `${Math.max(1, page.width)}px`
  element.style.height = `${Math.max(1, page.height)}px`
  element.style.setProperty('--document-page-width', `${Math.max(1, page.width)}px`)
  element.style.setProperty('--document-page-height', `${Math.max(1, page.height)}px`)
  // aspect-ratio 只接受无单位数字，单独写入比例变量，避免页面宽高带 px 后整条规则失效。
  element.style.setProperty(
    '--document-page-aspect-ratio',
    `${Math.max(1, page.width)} / ${Math.max(1, page.height)}`
  )
  if (page.background?.kind === 'solid') {
    element.style.backgroundColor = page.background.color
  }
  const hasGeometry = page.blocks.some(hasPageGeometry)
  if (side === 'translation' && hasGeometry) {
    // PDF 译文页统一使用纸张主题兜底；显式页面底色已在前面覆盖，空白页也不能露出深色容器。
    element.style.backgroundColor = 'var(--document-paper-bg)'
  }
  // 独立图片的原文和译文都使用绝对布局与统一 zoom，避免两侧适配按钮采用不同缩放路径。
  const layout = layoutOverride ?? (side === 'translation' && hasGeometry
    ? 'translation-flow'
    : hasGeometry ? 'absolute' : 'flow')
  element.dataset.layout = layout
  let previousBottom = 0
  let previousBlock: DocumentBlock | undefined
  let activeFlowGroup: HTMLElement | undefined
  let activeFlowGroupId: string | undefined
  const flowGroupBlocks = new Map<string, DocumentBlock[]>()
  for (const block of page.blocks) {
    if (!block.flowGroupId) continue
    const groupBlocks = flowGroupBlocks.get(block.flowGroupId) ?? []
    groupBlocks.push(block)
    flowGroupBlocks.set(block.flowGroupId, groupBlocks)
  }
  const imageStackBlocks = new Map<string, DocumentImageBlock[]>()
  const imageOverlayImages = new Map<string, DocumentImageBlock[]>()
  const imageOverlayTexts = new Map<string, DocumentTextBlock[]>()
  // stackGroupId 会在译文侧聚合为 .document-image-stack，外层只占一次普通流空间。
  for (const block of page.blocks) {
    if (block.kind === 'image') {
      if (block.stackGroupId) {
        const stackBlocks = imageStackBlocks.get(block.stackGroupId) ?? []
        stackBlocks.push(block)
        imageStackBlocks.set(block.stackGroupId, stackBlocks)
      }
      if (block.overlayGroupId) {
        const overlayImages = imageOverlayImages.get(block.overlayGroupId) ?? []
        overlayImages.push(block)
        imageOverlayImages.set(block.overlayGroupId, overlayImages)
      }
      continue
    }
    if (block.kind === 'text' && block.overlayGroupId) {
      const overlayTexts = imageOverlayTexts.get(block.overlayGroupId) ?? []
      overlayTexts.push(block)
      imageOverlayTexts.set(block.overlayGroupId, overlayTexts)
    }
  }
  const renderedImageStackIds = new Set<string>()
  const renderedImageOverlayIds = new Set<string>()
  if (element.dataset.layout === 'translation-flow') {
    // 译文页面用原始 PDF 页面宽度作为缩放基准，字号、间距和页边距随双栏宽度等比变化。
    const geometryBlocks = page.blocks.filter((block) => block.bbox)
    const minY = geometryBlocks.length > 0
      ? Math.max(0, Math.min(...geometryBlocks.map((block) => block.bbox!.y)))
      : 0
    element.style.setProperty('--document-page-margin-top', `${minY}px`)
    element.style.setProperty('--document-page-width', `${Math.max(1, page.width)}px`)
    element.style.setProperty('--document-page-scale', String(translationInitialScale))
    previousBottom = minY
  }
  for (const block of page.blocks) {
    const imageBlock = block.kind === 'image' ? block : undefined
    const overlayGroupId = element.dataset.layout === 'translation-flow'
      ? block.overlayGroupId
      : undefined
    const overlayImages = overlayGroupId ? imageOverlayImages.get(overlayGroupId) ?? [] : []
    const overlayTexts = overlayGroupId ? imageOverlayTexts.get(overlayGroupId) ?? [] : []
    const hasOverlay = overlayGroupId !== undefined && overlayImages.length > 0
    if (hasOverlay) {
      if (renderedImageOverlayIds.has(overlayGroupId)) continue
      renderedImageOverlayIds.add(overlayGroupId)
    }
    const stackGroupId = hasOverlay ? undefined : imageBlock?.stackGroupId
    const stackBlocks = element.dataset.layout === 'translation-flow' && imageBlock && stackGroupId
      ? imageStackBlocks.get(stackGroupId) ?? [imageBlock]
      : undefined
    if (stackBlocks && stackGroupId) {
      if (renderedImageStackIds.has(stackGroupId)) continue
      renderedImageStackIds.add(stackGroupId)
    }
    const stackBounds = stackBlocks ? resolveDocumentImageStackBounds(stackBlocks) : undefined
    const overlayBounds = hasOverlay
      ? resolveDocumentImageOverlayBounds(overlayImages, overlayTexts)
      : undefined
    const flowBlock: DocumentBlock = overlayBounds
      ? { ...block, bbox: overlayBounds }
      : stackBounds && block.kind === 'image' ? { ...block, bbox: stackBounds } : block
    const rendered = hasOverlay
      ? createDocumentImageOverlayGroup(
          overlayImages,
          overlayTexts,
          page.width,
          (imageBlock) => renderImageBlock(imageBlock, side, page.width, jobId, tab, page.index),
          (textBlock) => renderTextBlock(textBlock, side, page.width)
        )
      : stackBlocks
      ? renderImageStackBlock(stackBlocks, side, page.width, jobId, tab, page.index)
      : renderBlock(block, side, page.width, page.contentArea, jobId, tab, page.index)
    const occupiesFlow = hasOverlay || occupiesDocumentTranslationFlow(block)
    rendered.dataset.flowOccupiesSpace = String(occupiesFlow)
    const continuesFlowGroup = element.dataset.layout === 'translation-flow' &&
      block.flowGroupId !== undefined &&
      block.flowGroupId === activeFlowGroupId
    const blockGapBefore = element.dataset.layout === 'translation-flow' && flowBlock.bbox
      ? pdfFlowGapBefore(block, previousBlock, previousBottom)
      : 0
    if (element.dataset.layout === 'translation-flow' && flowBlock.bbox) {
      // 译文仍按阅读顺序流式换行，但段前距离来自原文坐标，避免统一 gap 破坏标题和正文节奏。
      rendered.style.setProperty('--document-flow-gap-before', `${blockGapBefore}px`)
      // 图片需要优先回到原文纵向锚点；保留原始 y 与段前距离供挂载后的真实 DOM 测量使用。
      rendered.dataset.sourceY = String(flowBlock.bbox.y)
      rendered.dataset.sourceTop = String(flowBlock.bbox.y)
      rendered.dataset.sourceBottom = String(flowBlock.bbox.y + flowBlock.bbox.height)
      rendered.dataset.sourceGapBefore = String(blockGapBefore)
      // 装饰线虽然保留原文底边信息，但不占普通流高度；后续文本应继续以最后一个流式区块为基准。
      if (occupiesFlow) {
        previousBottom = Math.max(previousBottom, flowBlock.bbox.y + flowBlock.bbox.height)
      }
    }
    previousBlock = hasOverlay
      ? overlayTexts[overlayTexts.length - 1] ?? overlayImages[overlayImages.length - 1] ?? block
      : stackBlocks?.[stackBlocks.length - 1] ?? block
    if (element.dataset.layout !== 'translation-flow') {
      element.append(rendered)
      continue
    }
    if (!continuesFlowGroup && activeFlowGroup) {
      activeFlowGroup = undefined
      activeFlowGroupId = undefined
    }
    const nextGroup = appendTranslationFlowBlock(
      element,
      block,
      rendered,
      'document-flow-group',
      activeFlowGroup
    )
    if (nextGroup && block.flowGroupId) {
      if (!activeFlowGroup) {
        // 分组容器继承首块的原文坐标与段前距离，供挂载后的真实 DOM 测量使用。
        const groupGeometry = resolveTranslationFlowGroupGeometry(
          flowGroupBlocks.get(block.flowGroupId) ?? [block],
          page.blocks,
          page.width,
          page.contentArea
        )
        nextGroup.style.setProperty('--document-flow-group-left', `${groupGeometry.left}px`)
        nextGroup.style.setProperty('--document-flow-group-width', `${groupGeometry.width}px`)
        nextGroup.style.setProperty('--document-flow-group-height', `${groupGeometry.height}px`)
        nextGroup.style.setProperty('--document-flow-group-gap', `${groupGeometry.textGap}px`)
        nextGroup.style.setProperty('--document-flow-group-text-top', `${groupGeometry.textTop}px`)
        nextGroup.style.setProperty('--document-flow-gap-before', `${blockGapBefore}px`)
        nextGroup.dataset.flowOccupiesSpace = String(
          (flowGroupBlocks.get(block.flowGroupId) ?? [block]).some(occupiesDocumentTranslationFlow)
        )
        if (block.bbox) {
          nextGroup.dataset.sourceY = String(block.bbox.y)
          nextGroup.dataset.sourceGapBefore = String(blockGapBefore)
          const groupBlocks = flowGroupBlocks.get(block.flowGroupId) ?? [block]
          const groupBounds = groupBlocks.filter((groupBlock) => groupBlock.bbox)
          if (groupBounds.length > 0) {
            nextGroup.dataset.sourceTop = String(Math.min(
              ...groupBounds.map((groupBlock) => groupBlock.bbox!.y)
            ))
            nextGroup.dataset.sourceBottom = String(Math.max(
              ...groupBounds.map((groupBlock) => groupBlock.bbox!.y + groupBlock.bbox!.height)
            ))
          }
        }
        rendered.style.setProperty('--document-flow-gap-before', '0px')
        rendered.dataset.sourceGapBefore = '0'
      }
      activeFlowGroup = nextGroup
      activeFlowGroupId = block.flowGroupId
    } else {
      activeFlowGroup = undefined
      activeFlowGroupId = undefined
    }
  }
  return element
}

/**
 * 创建译文水印中的真实品牌图标；直接复用托盘模板的“译”字轮廓，并强制使用当前文字颜色。
 * @returns 无交互的品牌图标元素。
 * @author zhenghq
 */
function createTranslationWatermarkLogo(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg'
  const logo = document.createElementNS(namespace, 'svg')
  logo.classList.add('document-translation-watermark-logo')
  logo.setAttribute('viewBox', '0 0 36 36')
  logo.setAttribute('aria-hidden', 'true')
  const glyph = document.createElementNS(namespace, 'path')
  glyph.setAttribute('id', 'rounded-yi-glyph')
  glyph.setAttribute('data-font-family', 'Wawati SC')
  glyph.setAttribute('fill', 'currentColor')
  glyph.setAttribute('stroke', 'currentColor')
  glyph.setAttribute('stroke-width', '5')
  glyph.setAttribute('stroke-linecap', 'round')
  glyph.setAttribute('stroke-linejoin', 'round')
  glyph.setAttribute('paint-order', 'stroke fill')
  glyph.setAttribute('transform', 'translate(3.2 25.9) scale(0.113)')
  glyph.setAttribute('d', TRANSLATION_WATERMARK_LOGO_PATH)
  logo.append(glyph)
  return logo
}

/**
 * 创建译文水印中的产品名文本，并统一应用当前文字颜色。
 * @param value 水印展示的产品名。
 * @param className 文本节点附加的样式类名。
 * @returns 无交互的 SVG 文本元素。
 * @author zhenghq
 */
function createTranslationWatermarkText(value: string, className?: string): SVGTextElement {
  const namespace = 'http://www.w3.org/2000/svg'
  const text = document.createElementNS(namespace, 'text')
  text.classList.add('document-translation-watermark-text')
  if (className) text.classList.add(className)
  text.setAttribute('fill', 'currentColor')
  text.textContent = value
  return text
}

/**
 * 创建铺满译文预览区域的 SVG 水印图案；图案随内容高度平铺，打印分页时每页都会重复。
 * @returns 包含斜向品牌文字的 SVG 图案元素。
 * @author zhenghq
 */
function createTranslationWatermarkPattern(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg'
  const pattern = document.createElementNS(namespace, 'svg')
  pattern.classList.add('document-translation-watermark-pattern')
  pattern.setAttribute('aria-hidden', 'true')
  pattern.setAttribute('preserveAspectRatio', 'none')
  const definitions = document.createElementNS(namespace, 'defs')
  const tile = document.createElementNS(namespace, 'pattern')
  tile.setAttribute('id', 'document-translation-watermark-tile-pattern')
  // 平移图案原点而不是旋转后的内容组，才能保持屏幕与 PDF 中的平铺周期不变。
  tile.setAttribute('x', '0')
  // 中英文上下两行沿用原始瓦片间距，保持与既有译文水印的疏密一致。
  tile.setAttribute('width', '320')
  tile.setAttribute('height', '180')
  tile.setAttribute('patternUnits', 'userSpaceOnUse')
  const content = document.createElementNS(namespace, 'g')
  content.classList.add('document-translation-watermark-tile')
  // Chromium 打印链路会忽略 patternTransform，直接旋转内容组可确保屏幕和 PDF 都是 45 度斜水印。
  content.setAttribute('transform', 'rotate(-45 160 90)')
  const logo = createTranslationWatermarkLogo()
  logo.setAttribute('x', '74')
  logo.setAttribute('y', '96')
  logo.setAttribute('width', '24')
  logo.setAttribute('height', '24')
  const chineseText = createTranslationWatermarkText('划词翻译')
  chineseText.setAttribute('x', '106')
  chineseText.setAttribute('y', '107')
  const englishText = createTranslationWatermarkText(
    'Selection Translator',
    'document-translation-watermark-text--english'
  )
  englishText.setAttribute('x', '108')
  englishText.setAttribute('y', '127')
  content.append(logo, chineseText, englishText)
  tile.append(content)
  definitions.append(tile)
  const surface = document.createElementNS(namespace, 'rect')
  surface.setAttribute('width', '100%')
  surface.setAttribute('height', '100%')
  surface.setAttribute('fill', 'url(#document-translation-watermark-tile-pattern)')
  pattern.append(definitions, surface)
  return pattern
}

/**
 * 在译文容器内创建覆盖全部内容的水印层，屏幕预览与打印 PDF 共用同一 DOM。
 * @param container 译文预览宿主；原文侧传入时不创建水印。
 * @param side 当前渲染侧。
 * @param tab 快照所属的文档 Tab。
 * @returns 无返回值。
 * @author zhenghq
 */
function appendTranslationWatermark(
  container: HTMLElement,
  side: DocumentRenderSide,
  tab: DocumentWorkspaceTab
): void {
  if (side !== 'translation' || tab.ocrDisplayMode === 'ocr-text') return
  watermarkResizeObserver?.disconnect()
  watermarkResizeObserver = null
  const watermark = document.createElement('div')
  watermark.className = 'document-translation-watermark'
  watermark.setAttribute('aria-hidden', 'true')
  const pattern = createTranslationWatermarkPattern()
  watermark.append(pattern)
  container.append(watermark)
  const tile = pattern.querySelector<SVGPatternElement>('pattern')
  const updateOffset = (): void => {
    if (!tile) return
    tile.setAttribute('x', String(resolveTranslationWatermarkHorizontalOffset(watermark.clientWidth)))
  }
  updateOffset()
  // 首次挂载时容器可能尚未连接 DOM；ResizeObserver 会在布局完成后再次回调。
  const observer = new ResizeObserver(updateOffset)
  watermarkResizeObserver = observer
  observer.observe(watermark)
}

/**
 * 使用隔离 webview 加载主进程净化后的 HTML Blob，避免暴露本地文件路径或远程资源。
 * 异步请求通过文件指纹令牌隔离，旧请求不能覆盖新文档；切换文件和窗口关闭时释放 Blob URL。
 * @param container 源文滚动容器。
 * @param model 当前 HTML 文档模型。
 * @param jobId 当前任务标识；历史/恢复态仍用于请求身份日志。
 * @param tab 快照所属的文档 Tab。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderHtmlSourcePreview(
  container: HTMLElement,
  model: DocumentModel,
  jobId: string,
  tab: DocumentWorkspaceTab
): void {
  const requestIdentity = `html:${model.source.sha256}`
  releaseHtmlPreviewUrl()
  // 释放旧 Blob 时会清空请求身份，新身份必须在释放之后登记。
  htmlPreviewRequestIdentity = requestIdentity
  const webview = document.createElement('webview')
  webview.className = 'document-html-preview'
  webview.setAttribute('partition', 'document-html-preview')
  webview.setAttribute('aria-label', t('document.source'))
  container.append(webview)
  const approvedSource = isReadOnlyDocumentTab(tab)
    ? approvedDocumentSourceRequest(tab)
    : null
  const sourceRequest: Promise<DocumentSourceResult> = isReadOnlyDocumentTab(tab)
    ? approvedSource
      ? window.api.getApprovedDocumentSource(approvedSource)
      : Promise.resolve<DocumentSourceResult>({ ok: false, code: 'source-not-approved' })
    : window.api.getDocumentSource(jobId)
  void sourceRequest.then((source) => {
    if (htmlPreviewRequestIdentity !== requestIdentity || !webview.isConnected) return
    if (!source.ok || !source.bytes) {
      webview.remove()
      return
    }
    const previewUrl = URL.createObjectURL(new Blob([new Uint8Array(source.bytes)], {
      type: source.mimeType ?? 'text/html; charset=utf-8'
    }))
    htmlPreviewUrl = previewUrl
    webview.src = previewUrl
  }).catch(() => {
    if (htmlPreviewRequestIdentity === requestIdentity) webview.remove()
  })
}

/**
 * 渲染文本 run，保持受保护片段原样并通过 textContent 安全写入。
 * @param block 文本区块。
 * @param side 当前渲染侧；译文侧的非受保护 run 会标记为可手改。
 * @returns 包含全部 run 的文档片段。
 * @author zhenghq
 */
function renderTextRuns(block: DocumentTextBlock, side: DocumentRenderSide): DocumentFragment {
  const fragment = document.createDocumentFragment()
  for (const run of block.runs) {
    const span = document.createElement('span')
    span.className = 'document-text-run'
    span.dataset.runId = run.runId
    span.textContent = run.text
    // Markdown 等语义块没有外层 document-text-block，run 必须继续独立承载手改入口。
    if (side === 'translation' && run.protected !== true) {
      span.dataset.manuallyEditable = 'true'
    }
    applyScalableTextStyle(span, effectiveTextStyle(block, run))
    fragment.append(span)
  }
  return fragment
}

/**
 * 按 Markdown 语义创建单个区块元素。
 * @param block 文档区块。
 * @param side 当前渲染侧。
 * @param jobId 区块所属任务标识。
 * @param tab 快照所属的文档 Tab。
 * @param pageIndex 区块所在页面索引。
 * @returns 语义化区块元素。
 * @author zhenghq
 */
function renderMarkdownBlock(
  block: DocumentBlock,
  side: DocumentRenderSide,
  jobId: string,
  tab: DocumentWorkspaceTab,
  pageIndex: number
): HTMLElement {
  if (block.kind === 'text') {
    if (block.role === 'code') {
      const pre = document.createElement('pre')
      pre.dataset.blockId = block.blockId
      const code = document.createElement('code')
      code.append(renderTextRuns(block, side))
      pre.append(code)
      return pre
    }
    if (block.role === 'heading') {
      const level = Math.max(1, Math.min(6, 7 - Math.round(((block.style?.fontSize ?? 30) - 14) / 3)))
      const heading = document.createElement(`h${level}`)
      heading.dataset.blockId = block.blockId
      heading.append(renderTextRuns(block, side))
      return heading
    }
    if (block.role === 'quote') {
      const quote = document.createElement('blockquote')
      quote.dataset.blockId = block.blockId
      quote.append(renderTextRuns(block, side))
      return quote
    }
    if (block.role === 'list-item') {
      const list = document.createElement('ul')
      const item = document.createElement('li')
      item.dataset.blockId = block.blockId
      item.append(renderTextRuns(block, side))
      list.append(item)
      return list
    }
  }
  return renderBlock(block, side, 1, undefined, jobId, tab, pageIndex)
}

/**
 * 渲染 Markdown 文档为连续语义内容。
 * @param container 目标滚动容器。
 * @param model 当前文档模型。
 * @param side 当前渲染侧。
 * @param jobId 文档所属任务标识。
 * @param tab 快照所属的文档 Tab。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderMarkdownDocument(
  container: HTMLElement,
  model: DocumentModel,
  side: DocumentRenderSide,
  jobId: string,
  tab: DocumentWorkspaceTab
): void {
  const article = document.createElement('article')
  article.className = 'document-markdown-preview'
  for (const page of model.pages) {
    for (const block of page.blocks) {
      article.append(renderMarkdownBlock(block, side, jobId, tab, page.index))
    }
  }
  container.append(article)
}

/**
 * 渲染 CSV 表格文档，并保留单元格中的递归内容。
 * @param container 目标滚动容器。
 * @param model 当前文档模型。
 * @param side 当前渲染侧。
 * @param jobId 文档所属任务标识。
 * @param tab 快照所属的文档 Tab。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderTableDocument(
  container: HTMLElement,
  model: DocumentModel,
  side: DocumentRenderSide,
  jobId: string,
  tab: DocumentWorkspaceTab
): void {
  const article = document.createElement('article')
  article.className = 'document-table-preview'
  for (const page of model.pages) {
    for (const block of page.blocks) {
      article.append(renderBlock(block, side, page.width, undefined, jobId, tab, page.index))
    }
  }
  container.append(article)
}

/**
 * 渲染字幕文档，并显示原始时间轴但不把时间轴送入翻译。
 * @param container 目标滚动容器。
 * @param model 当前文档模型。
 * @param side 当前渲染侧。
 * @param jobId 文档所属任务标识。
 * @param tab 快照所属的文档 Tab。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderSubtitleDocument(
  container: HTMLElement,
  model: DocumentModel,
  side: DocumentRenderSide,
  jobId: string,
  tab: DocumentWorkspaceTab
): void {
  const article = document.createElement('article')
  article.className = 'document-subtitle-preview'
  for (const page of model.pages) {
    for (const block of page.blocks) {
      const item = document.createElement('section')
      item.className = 'document-subtitle-item'
      if (block.kind === 'text' && block.timing) {
        const timing = document.createElement('span')
        timing.className = 'document-subtitle-timing'
        timing.textContent = block.timing
        item.append(timing)
      }
      item.append(renderBlock(block, side, page.width, undefined, jobId, tab, page.index))
      article.append(item)
    }
  }
  container.append(article)
}

/**
 * 渲染 TXT、DOCX、EPUB、HTML 与 JSON 等流式格式。
 * @param container 目标滚动容器。
 * @param model 当前文档模型。
 * @param side 当前渲染侧。
 * @param jobId 文档所属任务标识。
 * @param tab 快照所属的文档 Tab。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderFlowDocument(
  container: HTMLElement,
  model: DocumentModel,
  side: DocumentRenderSide,
  jobId: string,
  tab: DocumentWorkspaceTab
): void {
  if (!hasVisibleFlowContent(model, side)) {
    const empty = document.createElement('p')
    empty.className = 'document-empty-state'
    empty.textContent = t(side === 'translation'
      ? 'document.translationEmpty'
      : 'document.waitingSource')
    container.append(empty)
    return
  }
  const article = document.createElement('article')
  article.className = 'document-flow-preview'
  for (const page of model.pages) {
    // HTML 译文同样使用流式页面：保留原页宽和段落间距，但让译文高度参与后续排版。
    article.append(renderPage(page, side, 1, jobId, tab))
  }
  container.append(article)
}

/**
 * 使用 PDF.js 将 PDF 逐页绘制到 Canvas，保留原始字体、公式与版面。
 * 只有原文侧使用该渲染器；译文侧始终由结构化流式 DOM 承载。
 * @param container 源文预览滚动容器。
 * @param model 当前文档模型，用于同步页面占位尺寸。
 * @param jobId 文档所属任务标识。
 * @param tab 快照所属的文档 Tab。
 * @param onFirstPageReady 首张 Canvas 完成绘制后的可选回调。
 * @returns 无返回值。
 * @author zhenghq
 */
async function renderPdfPages(
  container: HTMLElement,
  model: DocumentModel | undefined,
  jobId: string,
  tab: DocumentWorkspaceTab,
  onFirstPageReady?: () => void
): Promise<void> {
  cleanupPdfPreview(container)
  const renderToken = Symbol('pdf-preview')
  pdfRenderTokens.set(container, renderToken)
  container.replaceChildren()
  container.dataset.previewKind = 'paged'
  const loading = document.createElement('p')
  loading.className = 'document-empty-state'
  loading.textContent = t('document.waitingSource')
  container.append(loading)

  const sha256 = tab.selection.sha256
  // Tab 切换重渲染时按文件指纹复用已解析文档，避免重新读取 44MB 源字节并重新解析。
  let pdfDocument: Awaited<ReturnType<typeof pdfjsModule.getDocument>['promise']> | null =
    documentPdfDocumentCache.get(sha256)
  // 缓存命中的文档归缓存所有；渲染器只销毁自己新解析、尚未写入缓存的文档。
  let ownsPdfDocument = pdfDocument === null
  let firstPageReadyNotified = false
  let firstPageReadyFallbackTimer: number | null = null
  // 清理首屏兜底计时器，避免已绘制页面后再次触发译文构建。
  const clearFirstPageReadyFallback = (): void => {
    if (firstPageReadyFallbackTimer === null) return
    window.clearTimeout(firstPageReadyFallbackTimer)
    firstPageReadyFallbackTimer = null
  }
  // IntersectionObserver 的 root 必须是真正的滚动容器；previewHost 自身随内容增长，
  // 以它为 root 会让所有页面永远相交，Tab 切换时几十页并发绘制会挤占当前页首帧。
  const pdfScrollRoot = container.closest<HTMLElement>('#document-source-content, #document-translation-content')
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const article = entry.target as HTMLElement
      observer.unobserve(article)
      void renderVisiblePage(article)
    }
  }, { root: pdfScrollRoot ?? container, rootMargin: '600px 0px' })
  const renderTasks = new Set<{ cancel(): void; promise: Promise<void> }>()
  let disposed = false
  const cleanup = (): void => {
    if (disposed) return
    disposed = true
    clearFirstPageReadyFallback()
    observer.disconnect()
    for (const renderTask of renderTasks) renderTask.cancel()
    renderTasks.clear()
    if (pdfRenderTokens.get(container) === renderToken) pdfRenderTokens.delete(container)
    if (pdfPreviewCleanups.get(container) === cleanup) pdfPreviewCleanups.delete(container)
    if (pdfDocument && ownsPdfDocument) void pdfDocument.destroy().catch(() => undefined)
    pdfDocument = null
  }
  pdfPreviewCleanups.set(container, cleanup)
  const isCurrentRender = (): boolean => !disposed &&
    container.isConnected &&
    pdfRenderTokens.get(container) === renderToken
  // 在首张可见 PDF 页面完成后放行译文构建；隐藏或加载失败时由兜底计时器放行。
  const notifyFirstPageReady = (): void => {
    if (firstPageReadyNotified || !onFirstPageReady || !isCurrentRender()) return
    firstPageReadyNotified = true
    clearFirstPageReadyFallback()
    runAfterNextPaint(() => {
      if (!isCurrentRender()) return
      try {
        onFirstPageReady()
      } catch (error) {
        console.error('document-pdf-first-page-ready-failed', error instanceof Error ? error.name : 'unknown')
      }
    })
  }
  const renderVisiblePage = async (article: HTMLElement): Promise<void> => {
    if (!pdfDocument || !isCurrentRender() || article.dataset.pdfRendered === 'true') return
    article.dataset.pdfRendered = 'true'
    const pageNumber = Number(article.dataset.pageNumber)
    const canvas = article.querySelector<HTMLCanvasElement>('.document-pdf-canvas')
    if (!Number.isSafeInteger(pageNumber) || pageNumber <= 0 || !canvas) return
    try {
      const page = await pdfDocument.getPage(pageNumber)
      if (!isCurrentRender()) return
      const baseViewport = page.getViewport({ scale: 1 })
      const width = documentPageContentWidth(container)
      const scale = Math.max(0.25, width / baseViewport.width)
      const viewport = page.getViewport({ scale })
      const maxDeviceScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
      canvas.width = Math.max(1, Math.floor(viewport.width * maxDeviceScale))
      canvas.height = Math.max(1, Math.floor(viewport.height * maxDeviceScale))
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      const canvasContext = canvas.getContext('2d', { alpha: false })
      if (!canvasContext) throw new Error('canvas-context-unavailable')
      // PDF.js 的透明页面必须显式铺白底，否则深色主题下空白区域会被合成成黑色。
      canvasContext.fillStyle = '#ffffff'
      canvasContext.fillRect(0, 0, canvas.width, canvas.height)
      const renderTask = page.render({
        canvasContext,
        viewport,
        background: '#ffffff',
        transform: maxDeviceScale === 1 ? undefined : [maxDeviceScale, 0, 0, maxDeviceScale, 0, 0]
      })
      renderTasks.add(renderTask)
      await renderTask.promise
      renderTasks.delete(renderTask)
      if (!isCurrentRender()) return
    } catch (error) {
      article.dataset.pdfRendered = 'false'
      if (!isCurrentRender()) return
      console.error('document-pdf-page-render-failed', error instanceof Error ? error.name : 'unknown')
    } finally {
      notifyFirstPageReady()
    }
  }
  try {
    if (!pdfDocument) {
      // 文件选择阶段已经授权路径与文件指纹，任务接受前也能安全读取原始 PDF。
      const approvedSource = resolveAuthorizedDocumentSourceRequest(
        tab,
        isReadOnlyDocumentTab,
        approvedDocumentSourceRequest
      )
      let source: DocumentSourceResult
      if (approvedSource) {
        source = await window.api.getApprovedDocumentSource(approvedSource)
        // 授权读取失败时，活动任务仍可回退到主进程内存中的受控源字节。
        if (!source.ok && !isReadOnlyDocumentTab(tab) && jobId) {
          source = await window.api.getDocumentSource(jobId)
        }
      } else if (!isReadOnlyDocumentTab(tab) && jobId) {
        source = await window.api.getDocumentSource(jobId)
      } else {
        source = { ok: false, code: 'source-not-approved' }
      }
      if (!source.ok || !source.bytes) throw new Error(source.code ?? 'source-not-found')
      if (!isCurrentRender()) return
      const loadingTask = pdfjsModule.getDocument({
        data: new Uint8Array(source.bytes),
        isEvalSupported: false,
        useSystemFonts: true
      })
      pdfDocument = await loadingTask.promise
      // 内容只与文件指纹相关；即便渲染已过期，解析结果仍可服务同文件的下一次渲染。
      documentPdfDocumentCache.set(sha256, pdfDocument)
      ownsPdfDocument = false
    }
    if (!isCurrentRender()) return
    container.replaceChildren()
    const contentWidth = documentPageContentWidth(container)
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      // 先使用解析模型中的原始页面尺寸同步建立占位，避免 83 页 PDF 在首屏前
      // 逐页等待 PDF.js getPage。真实页面只在进入视口后加载和绘制。
      const modelPage = model?.pages[pageNumber - 1]
      // 解析模型尚未到达时先按标准 PDF 页面尺寸建立同步占位，保证原始 PDF 可以
      // 在 OCR/翻译完成前显示；可见页加载后再用 PDF.js 的真实 viewport 纠正尺寸。
      const sourceWidth = modelPage?.width ?? 612
      const sourceHeight = modelPage?.height ?? 792
      if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) ||
        !sourceWidth || !sourceHeight || sourceWidth <= 0 || sourceHeight <= 0) {
        continue
      }
      const scale = Math.max(0.25, contentWidth / sourceWidth)
      const viewportWidth = sourceWidth * scale
      const viewportHeight = sourceHeight * scale
      const article = document.createElement('article')
      article.className = 'document-pdf-page'
      article.dataset.pageNumber = String(pageNumber)
      article.style.setProperty('--document-pdf-page-width', `${viewportWidth}px`)
      article.style.setProperty('--document-pdf-page-height', `${viewportHeight}px`)
      article.style.setProperty('--document-pdf-source-width', String(sourceWidth))
      article.style.setProperty('--document-pdf-source-height', String(sourceHeight))
      const canvas = document.createElement('canvas')
      canvas.className = 'document-pdf-canvas'
      canvas.style.width = `${viewportWidth}px`
      canvas.style.height = `${viewportHeight}px`
      article.append(canvas)
      // 扫描页的可见文字由 PDF.js Canvas 绘制，透明 DOM 文字层只负责检索和选择。
      if (modelPage) {
        const textLayer = createPdfOcrTextLayer(modelPage)
        if (textLayer) article.append(textLayer)
      }
      container.append(article)
      observer.observe(article)
    }
    // PDF.js 首屏占位完成后重新应用目标状态，避免异步替换 DOM 丢失失败与缓存标记。
    if (tab.id === activeDocumentTabId && tab.snapshot) markDocumentTargetStatuses(tab.snapshot)
    sourcePageCount.textContent = t('document.pageCount', { count: pdfDocument.numPages })
    // 原文栏可能因单栏阅读模式暂时隐藏，或首屏页绘制异常；不能因此永久阻塞译文构建。
    if (onFirstPageReady && !firstPageReadyNotified) {
      firstPageReadyFallbackTimer = window.setTimeout(notifyFirstPageReady, 1200)
    }
  } catch (error) {
    if (!isCurrentRender()) return
    console.error('document-pdf-preview-failed', error instanceof Error ? error.name : 'unknown')
    container.replaceChildren()
    const failed = document.createElement('p')
    failed.className = 'document-empty-state'
    failed.textContent = t('document.run.failed')
    container.append(failed)
    notifyFirstPageReady()
  }
}

/**
 * 在解析模型到达前直接挂载原始 PDF 预览宿主。
 * @param container 源文预览滚动容器。
 * @param jobId 文档所属任务标识。
 * @param tab 快照所属的文档 Tab。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderPendingPdfSourcePreview(
  container: HTMLElement,
  jobId: string,
  tab: DocumentWorkspaceTab
): void {
  cleanupPdfPreview(container)
  const previewHost = document.createElement('div')
  previewHost.className = 'document-preview-host'
  previewHost.dataset.previewKind = 'paged'
  previewHost.dataset.documentFormat = 'pdf'
  container.dataset.previewKind = 'paged'
  container.replaceChildren(previewHost)
  renderedSourcePreviewIdentity = `pdf-pending:${tab.selection.sha256}`
  renderedSourcePreviewTabId = tab.id
  renderedSourcePreviewSha256 = tab.selection.sha256
  void renderPdfPages(previewHost, undefined, jobId, tab)
}

/**
 * 让译文 PDF 页面跟随双栏可用宽度缩放，并保持与左侧 Canvas 相同的页面基准。
 * 宽度只从真正发生横向滚动的译文容器读取；页面高度增长仅触发流式锚点重排。
 * @param scrollContainer 译文滚动容器，也是唯一的页面缩放宽度来源。
 * @param previewHost 译文页面宿主，仅用于观察页面高度和异步内容变化。
 * @returns 无返回值。
 * @author zhenghq
 */
function observeTranslationPageScale(scrollContainer: HTMLElement, previewHost: HTMLElement): void {
  pageScaleObserver?.disconnect()
  pageScaleObserver = null
  if (pageLayoutFrame !== null) {
    cancelAnimationFrame(pageLayoutFrame)
    pageLayoutFrame = null
  }
  translationLayoutUpdating = false
  pendingTranslationLayoutScrollPositions = null
  // 调度器归属于创建时的 Tab；切换后旧 RAF 不得继续读取或恢复新 Tab 的滚动位置。
  const layoutTabId = activeDocumentTabId
  const pages = Array.from(previewHost.querySelectorAll<HTMLElement>(".document-page[data-layout='translation-flow']"))
  if (pages.length === 0 || typeof ResizeObserver === 'undefined') return
  // 最近一次实际写入页面缩放时使用的容器宽度；高度变化不得改变该基准。
  let lastScaleWidth: number | null = null
  // 最近一次观察到的滚动容器内容宽度；ResizeObserver 同时上报高度变化，必须按数值区分。
  let lastObservedScrollWidth: number | null = null
  // 当前帧是否需要重新计算页面缩放；多个观察回调合并时保留更严格的请求。
  let recalculateScalePending = false
  // 显式缩放只由用户控件修改；容器宽度变化必须保持用户比例，不能静默重置为适合宽度。
  let lastUserZoom = documentZoom
  // 观察器可能因自身样式变化再次触发；统一在下一帧批量重排，避免同步测量循环造成卡顿。
  const scheduleLayout = (recalculateScale = false): void => {
    recalculateScalePending ||= recalculateScale
    if (pageLayoutFrame !== null) cancelAnimationFrame(pageLayoutFrame)
    pageLayoutFrame = requestAnimationFrame(() => {
      pageLayoutFrame = null
      if (layoutTabId === null || layoutTabId !== activeDocumentTabId) return
      const scrollPositions = pendingTranslationLayoutScrollPositions ?? captureDocumentScrollPositions()
      translationLayoutUpdating = true
      try {
        const availableWidth = documentPageContentWidth(scrollContainer)
        // 首次布局只记录宽度基准；页面在挂载前已按各自宽度完成初始缩放，不能再次改写。
        const userZoomChanged = Math.abs(documentZoom - lastUserZoom) >= 0.001
        const shouldRecalculateScale = userZoomChanged || (recalculateScalePending &&
          (lastScaleWidth === null || Math.abs(availableWidth - lastScaleWidth) >= 0.5))
        for (const page of pages) {
          if (!page.isConnected) continue
          if (shouldRecalculateScale) {
            const sourceWidth = Number(page.dataset.sourceWidth)
            if (Number.isFinite(sourceWidth) && sourceWidth > 0) {
              // 原文 Canvas 与译文页面使用同一内容宽度，确保左右两侧缩放比例一致。
              const nextScale = String(clampDocumentZoom(availableWidth / sourceWidth) * documentZoom)
              if (page.style.getPropertyValue('--document-page-scale') !== nextScale) {
                page.style.setProperty('--document-page-scale', nextScale)
              }
            }
          }
          // 页面高度只影响流式锚点；仅容器宽度变化时才同步重算缩放，避免流式过程中反复缩放。
          normalizeTranslationFlowLayout(page)
        }
        if (lastScaleWidth === null || shouldRecalculateScale) {
          lastScaleWidth = availableWidth
        }
        lastUserZoom = documentZoom
      } finally {
        recalculateScalePending = false
        restoreDocumentScrollPositions(scrollPositions)
        pendingTranslationLayoutScrollPositions = null
        translationLayoutUpdating = false
      }
    })
  }
  activePageLayoutScheduler = scheduleLayout
  const observer = new ResizeObserver((entries) => {
    // 只有滚动容器自身宽度变化才允许重算缩放。previewHost 的宽度会随页面内容联动，
    // 不能把它作为宽度基准，否则页面高度增长也会被误判为缩放变化。
    const scrollContainerWidthChanged = entries.some((entry) => {
      if (entry.target !== scrollContainer) return false
      const nextWidth = entry.contentRect.width
      const changed = lastObservedScrollWidth !== null &&
        Math.abs(nextWidth - lastObservedScrollWidth) >= 0.5
      lastObservedScrollWidth = nextWidth
      return changed
    })
    if (scrollContainerWidthChanged) scheduleLayout(true)
    else scheduleLayout(false)
  })
  pageScaleObserver = observer
  observer.observe(scrollContainer)
  // 字体或图片异步加载会改变页面自身高度，只观察外层容器无法触发装饰线重新锚定。
  observer.observe(previewHost)
  for (const page of pages) observer.observe(page)
  // 初次观察只建立宽度基准；只有后续滚动容器宽度真正变化时才允许重算页面缩放。
  scheduleLayout(false)
}

/**
 * 请求合并执行当前译文页面的缩放与流式重排。
 * @returns 无返回值。
 * @author zhenghq
 */
function scheduleTranslationPageLayout(recalculateScale = false): void {
  if (activePageLayoutScheduler) {
    activePageLayoutScheduler(recalculateScale)
    return
  }
  // Markdown、表格、字幕和普通流没有页面缩放帧；当前 DOM 写入完成后必须立即恢复视口，
  // 否则流式保护会一直残留并阻断后续用户滚动联动。
  const positions = pendingTranslationLayoutScrollPositions
  if (positions) restoreDocumentScrollPositions(positions)
  pendingTranslationLayoutScrollPositions = null
  translationLayoutUpdating = false
}

/**
 * 在流式译文写入 DOM 前开启滚动保护，并保存本轮首次更新前的双栏视口。
 * @returns 无返回值。
 * @author zhenghq
 */
function beginTranslationLayoutUpdate(): void {
  pendingTranslationLayoutScrollPositions ??= captureDocumentScrollPositions()
  translationLayoutUpdating = true
}

/**
 * 捕获双栏当前滚动位置；布局更新前后只恢复用户原本的视口，不能改变其阅读进度。
 * @returns 原文栏与译文栏的滚动位置。
 * @author zhenghq
 */
function captureDocumentScrollPositions(): DocumentScrollPositions {
  return {
    source: sourceContent.scrollTop,
    translation: translationContent.scrollTop
  }
}

/**
 * 恢复双栏滚动位置；若用户在重排期间产生了新滚动意图，则保留用户当前位置。
 * @param positions 重排开始前捕获的滚动位置。
 * @returns 无返回值。
 * @author zhenghq
 */
function restoreDocumentScrollPositions(positions: DocumentScrollPositions): void {
  if (userScrollSide !== 'source' && sourceContent.scrollTop !== positions.source) {
    pendingProgrammaticScrollTops.set(sourceContent, positions.source)
    sourceContent.scrollTop = positions.source
  }
  if (userScrollSide !== 'translation' && translationContent.scrollTop !== positions.translation) {
    pendingProgrammaticScrollTops.set(translationContent, positions.translation)
    translationContent.scrollTop = positions.translation
  }
}

/**
 * 清理待执行的译文页面重排帧。
 * @returns 无返回值。
 * @author zhenghq
 */
function cancelTranslationPageLayout(): void {
  activePageLayoutScheduler = null
  if (pageLayoutFrame !== null) {
    cancelAnimationFrame(pageLayoutFrame)
    pageLayoutFrame = null
  }
  pendingTranslationLayoutScrollPositions = null
  translationLayoutUpdating = false
}

/**
 * 创建独立告警层；告警更新不会替换 PDF Canvas 或正文页面。
    for (const page of pages) {
      if (page.isConnected) update(page)
    }
  })
  pageScaleObserver = observer
  observer.observe(container)
  // 字体或图片异步加载会改变页面自身高度，只观察外层容器无法触发装饰线重新锚定。
  for (const page of pages) observer.observe(page)
  for (const page of pages) update(page)
}

/**
 * 创建独立告警层；告警更新不会替换 PDF Canvas 或正文页面。
 * @param container 目标滚动容器。
 * @param warnings 当前解析或翻译告警。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderDocumentWarnings(container: HTMLElement, warnings: readonly DocumentWarning[] = []): void {
  container.querySelector(':scope > .document-warning-list')?.remove()
  const visibleWarnings = filterVisibleDocumentWarnings(warnings)
  if (visibleWarnings.length === 0) return
  const notice = document.createElement('aside')
  notice.className = 'document-warning-list'
  notice.setAttribute('role', 'status')
  notice.setAttribute('aria-live', 'polite')
  for (const warning of visibleWarnings) {
    const item = document.createElement('p')
    item.className = 'document-warning-item'
    item.dataset.severity = warning.severity
    item.textContent = localizeDocumentWarning(warning)
    notice.append(item)
  }
  const previewHost = container.querySelector<HTMLElement>(':scope > .document-preview-host')
  if (previewHost) previewHost.after(notice)
  else container.append(notice)
}

/**
 * 原位更新文本区块中的 run；run 结构不兼容时返回失败并交由上层整块或整页回退。
 * @param element 已渲染的文本区块。
 * @param block 最新文本区块模型。
 * @param side 当前渲染侧。
 * @param pageWidth 区块所属页面宽度。
 * @param contentArea 区块所属页面的正文内容区。
 * @returns 是否已原位更新成功。
 * @author zhenghq
 */
function patchTranslationTextBlock(
  element: HTMLElement,
  block: DocumentTextBlock,
  side: DocumentRenderSide,
  pageWidth: number,
  contentArea?: DocumentContentArea
): boolean {
  if (side !== 'translation') return false
  // 正在手改的区块不能被流式补丁覆盖，避免用户输入被自动译文覆盖或选中范围失效。
  if (documentManualEdit.isEditingBlock(block.blockId)) return true
  if (block.toc) {
    const title = element.querySelector<HTMLElement>(':scope > .document-toc-title')
    const pageNumber = element.querySelector<HTMLElement>(':scope > .document-toc-page')
    if (!title || !pageNumber) return false
    const titleRun = block.runs.find((run) => run.protected !== true)
    title.dataset.runId = titleRun?.runId ?? `${block.blockId}-toc-title`
    const titleText = block.runs
      .filter((run) => run.protected !== true)
      .map((run) => run.text)
      .join('')
    if (title.textContent !== titleText) title.textContent = titleText
    applyScalableTextStyle(title, titleRun ? effectiveTextStyle(block, titleRun) : block.style)
    if (pageNumber.textContent !== block.toc.pageNumber) {
      pageNumber.textContent = block.toc.pageNumber
    }
    if (element.dataset.tableCellContent !== 'true') {
      applyTranslationBlockGeometry(element, block, pageWidth, contentArea)
    }
    return true
  }
  const existingRuns = Array.from(element.querySelectorAll<HTMLElement>('.document-text-run'))
  if (existingRuns.length !== block.runs.length) return false
  for (let index = 0; index < block.runs.length; index += 1) {
    const run = block.runs[index]!
    const existingRun = existingRuns[index]!
    // 正在编辑的 run 保留用户输入，不被自动译文覆盖。
    if (documentManualEdit.isEditingRun(run.runId)) continue
    if (existingRun.dataset.runId !== run.runId) return false
    if (existingRun.textContent !== run.text) existingRun.textContent = run.text
    applyScalableTextStyle(existingRun, effectiveTextStyle(block, run))
  }
  // 流式更新只替换文本节点时仍须按最新页面正文区重算宽度，否则会沿用首次较窄的 bbox。
  if (element.dataset.tableCellContent !== 'true') {
    applyTranslationBlockGeometry(element, block, pageWidth, contentArea)
  }
  return true
}

/**
 * 原位更新图片 OCR 覆盖层；底图节点与资源 URL 保持不变，只替换覆盖层内容。
 * @param element 已渲染的图片区块。
 * @param block 最新图片区块模型。
 * @param tab 图片所属的文档 Tab。
 * @returns 是否已原位更新成功。
 * @author zhenghq
 */
function patchTranslationOcrLayer(
  element: HTMLElement,
  block: DocumentImageBlock,
  tab: DocumentWorkspaceTab
): boolean {
  if (!element.classList.contains('document-image-block')) return false
  // 图片区块内存在活动 OCR 手改时跳过覆盖层替换，保留用户正在编辑的节点。
  if (documentManualEdit.hasActiveOcrEditInBlock(block.blockId)) return true
  const renderPending = element.dataset.pending === 'true'
  const nextRenderPending = resolveDocumentImageRenderPending(block, tab)
  const assetFailed = element.dataset.assetState === 'error'
  if (!assetFailed && renderPending !== nextRenderPending) return false
  const image = element.querySelector<HTMLImageElement>(':scope > img.document-page-image')
  if (!nextRenderPending && !image && !assetFailed) return false
  if (image) image.alt = block.alt ?? ''
  const existingTextLayer = element.querySelector<HTMLElement>(':scope > .document-ocr-text-layer')
  const nextTextLayer = createOcrTextLayer(block)
  if (nextTextLayer) {
    if (existingTextLayer) existingTextLayer.replaceWith(nextTextLayer)
    else element.append(nextTextLayer)
    element.dataset.ocrText = 'true'
  } else {
    existingTextLayer?.remove()
    delete element.dataset.ocrText
  }
  const existingLayer = element.querySelector<HTMLElement>(':scope > .document-ocr-translation-layer')
  const signature = ocrTranslationLayerSignature(block)
  if (!signature) {
    existingLayer?.remove()
    delete element.dataset.ocrTranslation
    return true
  }
  if (existingLayer?.dataset.ocrTranslationSignature === signature) return true
  const nextLayer = createOcrTranslationLayer(block)
  if (nextLayer) {
    if (existingLayer) existingLayer.replaceWith(nextLayer)
    else element.append(nextLayer)
    element.dataset.ocrTranslation = 'true'
  } else {
    existingLayer?.remove()
    delete element.dataset.ocrTranslation
  }
  return true
}

/**
 * 校验并原位更新表格内的单元格文本，避免流式译文触发整表重绘。
 * @param element 已渲染的表格区块。
 * @param block 最新表格区块模型。
 * @param takeBlockElement 按 DOM 顺序取得区块元素。
 * @param tab 表格所属的文档 Tab。
 * @returns 是否已原位更新成功。
 * @author zhenghq
 */
function patchTranslationTableBlock(
  element: HTMLElement,
  block: DocumentTableBlock,
  takeBlockElement: (blockId: string) => HTMLElement | undefined,
  tab: DocumentWorkspaceTab
): boolean {
  if (!element.classList.contains('document-table-block')) return false
  const table = element.querySelector<HTMLTableElement>(':scope > table')
  if (!table || table.rows.length !== block.rows.length) return false
  const headerRowCount = Math.max(0, Math.min(block.headerRows ?? 0, block.rows.length))
  for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
    const row = block.rows[rowIndex]!
    const tableRow = table.rows[rowIndex]!
    if (tableRow.cells.length !== row.cells.length) return false
    for (let cellIndex = 0; cellIndex < row.cells.length; cellIndex += 1) {
      const cell = row.cells[cellIndex]!
      const tableCell = tableRow.cells[cellIndex]!
      if (tableCell.colSpan !== Math.max(1, cell.colSpan) ||
        tableCell.rowSpan !== Math.max(1, cell.rowSpan) ||
        (rowIndex < headerRowCount ? tableCell.tagName !== 'TH' : tableCell.tagName !== 'TD')) {
        return false
      }
      const renderedBlocks = Array.from(tableCell.children)
      if (renderedBlocks.length !== cell.blocks.length) return false
      for (let blockIndex = 0; blockIndex < cell.blocks.length; blockIndex += 1) {
        const child = cell.blocks[blockIndex]!
        const renderedBlock = child.kind === 'break'
          ? renderedBlocks[blockIndex]
          : takeBlockElement(child.blockId)
        if (!(renderedBlock instanceof HTMLElement) ||
          !patchTranslationBlock(child, renderedBlock, takeBlockElement, tab, 1)) {
          return false
        }
      }
    }
  }
  return true
}

/**
 * 按区块类型原位更新译文；结构不兼容时返回失败。
 * @param block 最新区块模型。
 * @param element 已渲染区块元素；分隔符没有稳定 DOM 标识时为 undefined。
 * @param takeBlockElement 按 DOM 顺序取得区块元素。
 * @param tab 区块所属的文档 Tab。
 * @param pageWidth 区块所属页面宽度。
 * @param contentArea 区块所属页面的正文内容区。
 * @returns 是否已原位更新成功。
 * @author zhenghq
 */
function patchTranslationBlock(
  block: DocumentBlock,
  element: HTMLElement | undefined,
  takeBlockElement: (blockId: string) => HTMLElement | undefined,
  tab: DocumentWorkspaceTab,
  pageWidth: number,
  contentArea?: DocumentContentArea
): boolean {
  if (block.kind === 'break') return true
  if (!element) return false
  switch (block.kind) {
    case 'text':
      return patchTranslationTextBlock(element, block, 'translation', pageWidth, contentArea)
    case 'image':
      return patchTranslationOcrLayer(element, block, tab)
    case 'table':
      return patchTranslationTableBlock(element, block, takeBlockElement, tab)
    case 'formula':
      return element.classList.contains('document-formula-block')
    case 'shape':
      return element.classList.contains('document-shape-block')
  }
}

/**
 * 收集模型中会生成 data-block-id 的区块标识；显式分页标记没有对应标识。
 * @param block 当前区块模型。
 * @param blockIds 收集结果。
 * @returns 无返回值。
 * @author zhenghq
 */
function collectDocumentBlockIds(block: DocumentBlock, blockIds: string[]): void {
  if (block.kind === 'break') return
  blockIds.push(block.blockId)
  if (block.kind !== 'table') return
  for (const row of block.rows) {
    for (const cell of row.cells) {
      for (const child of cell.blocks) collectDocumentBlockIds(child, blockIds)
    }
  }
}

/**
 * 在现有译文 DOM 上原位更新流式内容；只有结构变化时才返回失败并允许整页重绘。
 * @param container 译文滚动容器。
 * @param model 最新译文模型。
 * @param tab 译文所属的文档 Tab。
 * @returns 是否已原位更新成功。
 * @author zhenghq
 */
function patchTranslationPreview(
  container: HTMLElement,
  model: DocumentModel | undefined,
  tab: DocumentWorkspaceTab
): boolean {
  if (!model || renderedTranslationPreviewKind === null) return false
  const previewHost = container.querySelector<HTMLElement>(':scope > .document-preview-host')
  if (!previewHost) return false
  const kind = resolvePreviewKind(model, 'translation')
  if (kind !== renderedTranslationPreviewKind || previewHost.dataset.previewKind !== kind) return false
  // 存在活动手改时暂缓原位补丁；直接返回成功可避免触发整页重绘破坏编辑节点。
  if (documentManualEdit.isEditing()) return true
  beginTranslationLayoutUpdate()
  let layoutScheduled = false
  try {
    let patched = true
    const existingElements = Array.from(
      previewHost.querySelectorAll<HTMLElement>('[data-block-id]')
    )
    const elementsById = new Map<string, HTMLElement[]>()
    for (const element of existingElements) {
      const blockId = element.dataset.blockId
      if (!blockId) continue
      const matches = elementsById.get(blockId) ?? []
      matches.push(element)
      elementsById.set(blockId, matches)
    }
    let consumedElementCount = 0
    const takeBlockElement = (blockId: string): HTMLElement | undefined => {
      const element = elementsById.get(blockId)?.shift()
      if (element) consumedElementCount += 1
      return element
    }
    const expectedBlockIds: string[] = []
    for (const page of model.pages) {
      for (const block of page.blocks) {
        collectDocumentBlockIds(block, expectedBlockIds)
        if (!patchTranslationBlock(
          block,
          block.kind === 'break' ? undefined : takeBlockElement(block.blockId),
          takeBlockElement,
          tab,
          page.width,
          page.contentArea
        )) {
          patched = false
          break
        }
      }
      if (!patched) break
    }
    if (consumedElementCount !== existingElements.length ||
      expectedBlockIds.length !== existingElements.length) {
      patched = false
    }
    if (!patched) return false
    scheduleTranslationPageLayout()
    layoutScheduled = true
    return true
  } finally {
    // 成功时由布局调度器负责恢复并释放；失败或异常时必须在回退整页重绘前清理保护状态。
    if (!layoutScheduled) cancelTranslationPageLayout()
  }
}

/**
 * 渲染一个文档模型到指定栏；没有模型时展示等待提示。
 * @param container 目标滚动容器。
 * @param model 文档模型。
 * @param emptyKey 空状态词条。
 * @param side 当前渲染侧。
 * @param jobId 文档所属任务标识。
 * @param warnings 当前文档解析与翻译告警。
 * @param tab 快照所属的文档 Tab。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderDocumentModel(
  container: HTMLElement,
  model: DocumentModel | undefined,
  emptyKey: string,
  side: DocumentRenderSide,
  jobId: string,
  warnings: readonly DocumentWarning[] | undefined,
  tab: DocumentWorkspaceTab,
  options: DocumentModelRenderOptions = {}
): void {
  // 非 PDF 原文挂载一帧后发出就绪通知；PDF 由首张 Canvas 绘制后通知。
  const notifySourcePreviewReady = (): void => {
    if (side !== 'source' || !options.onSourcePreviewReady || model?.source.format === 'pdf') return
    runAfterNextPaint(options.onSourcePreviewReady)
  }
  if (container === translationContent) {
    // 页面缩放、流式重排与水印观察器只属于译文容器；重绘左侧不能断开右侧布局观察器。
    pageScaleObserver?.disconnect()
    pageScaleObserver = null
    activePageLayoutScheduler = null
    if (pageLayoutFrame !== null) {
      cancelAnimationFrame(pageLayoutFrame)
      pageLayoutFrame = null
    }
    pendingTranslationLayoutScrollPositions = null
    translationLayoutUpdating = false
  }
  cleanupPdfPreview(container)
  // 仅替换译文侧时清理旧水印观察器；原文重绘不能中断仍然保留的译文水印。
  if (container === translationContent) {
    watermarkResizeObserver?.disconnect()
    watermarkResizeObserver = null
  }
  const previousContent = document.createDocumentFragment()
  previousContent.append(...container.childNodes)
  if (!model) {
    const empty = document.createElement('p')
    empty.className = 'document-empty-state'
    empty.textContent = t(emptyKey)
    container.replaceChildren(empty)
    if (container === translationContent) renderedTranslationPreviewKind = null
    renderDocumentWarnings(container, warnings)
    notifySourcePreviewReady()
    return
  }
  try {
    const kind = resolvePreviewKind(model, side)
    const nextContent = document.createDocumentFragment()
    const previewHost = document.createElement('div')
    previewHost.className = 'document-preview-host'
    previewHost.dataset.previewKind = kind
    // 独立图片沿用原始像素尺寸；宿主格式标记用于启用 contain，避免窄栏把图片压扁。
    previewHost.dataset.documentFormat = model.source.format
    nextContent.append(previewHost)
    if (side === 'source' && model.source.format === 'html') {
      renderHtmlSourcePreview(previewHost, model, jobId, tab)
    } else if (kind === 'paged') {
      const usePdfCanvas = model.source.format === 'pdf' && side === 'source'
      if (model.source.format === 'pdf' && side === 'source') {
        container.dataset.previewKind = kind
        // PDF.js 异步渲染要求宿主已连接；此时只挂载空宿主，PDF 数据仍由旧内容保留到加载完成。
        container.replaceChildren(previewHost)
        void renderPdfPages(previewHost, model, jobId, tab, options.onSourcePreviewReady)
      } else if (model.source.format === 'pdf' && tab.ocrDisplayMode === 'ocr-text') {
        // OCR 原文模式在右侧复用 PDF 原文 Canvas，并叠加可检索文字层。
        container.dataset.previewKind = kind
        container.replaceChildren(previewHost)
        void renderPdfPages(previewHost, model, jobId, tab)
      } else {
        const isImageDocument = model.source.format === 'image'
        for (const page of model.pages) {
          // 横竖混排 PDF 的每页宽度不同，必须在首次挂载前按自身宽度计算比例，
          // 不能先沿用第一页比例再等待观察器纠正，否则会造成可见缩放。
          const pageScale = side === 'translation' && !isImageDocument
            ? initialTranslationPageScale(container, page.width)
            : 1
          // 图片保留实际渲染侧以挂载译文 OCR 覆盖层，只通过布局覆盖统一为绝对定位。
          previewHost.append(renderPage(
            page,
            side,
            pageScale,
            jobId,
            tab,
            isImageDocument ? 'absolute' : undefined
          ))
        }
      }
    } else if (kind === 'markdown') {
      renderMarkdownDocument(previewHost, model, side, jobId, tab)
    } else if (kind === 'table') {
      renderTableDocument(previewHost, model, side, jobId, tab)
    } else if (kind === 'subtitle') {
      renderSubtitleDocument(previewHost, model, side, jobId, tab)
    } else {
      renderFlowDocument(previewHost, model, side, jobId, tab)
    }
    appendTranslationWatermark(previewHost, side, tab)
    container.dataset.previewKind = kind
    if (previewHost.parentNode !== container) container.replaceChildren(nextContent)
    if (side === 'translation') renderedTranslationPreviewKind = kind
    if (side === 'translation' && (kind === 'paged' || model.source.format === 'html')) {
      observeTranslationPageScale(container, previewHost)
    }
    renderDocumentWarnings(container, warnings)
    notifySourcePreviewReady()
  } catch (error) {
    console.error('document-model-render-failed', error instanceof Error ? error.name : 'unknown')
    if (side === 'translation') renderedTranslationPreviewKind = null
    container.replaceChildren(previousContent)
    const failedContent = document.createDocumentFragment()
    const failed = document.createElement('p')
    failed.className = 'document-empty-state'
    failed.textContent = t('document.renderFailed')
    failedContent.append(failed)
    container.replaceChildren(failedContent)
    notifySourcePreviewReady()
  }
}

/**
 * 消费一次程序性写入产生的 scrollTop 值；值匹配时不再把它当作用户滚动联动。
 * @param element 收到 scroll 事件的容器。
 * @returns 是否属于程序性滚动。
 * @author zhenghq
 */
function consumeProgrammaticScroll(element: HTMLElement): boolean {
  const expected = pendingProgrammaticScrollTops.get(element)
  if (expected === undefined) return false
  pendingProgrammaticScrollTops.delete(element)
  return Math.abs(element.scrollTop - expected) < 1
}

/**
 * 记录用户滚动意图，并让程序性重排在这段时间内不覆盖用户视口。
 * @param side 用户正在操作的栏。
 * @returns 无返回值。
 * @author zhenghq
 */
function markUserScrollIntent(side: DocumentScrollSide): void {
  if (documentScrollSyncEnabled && documentScrollSyncedSide !== null && documentScrollSyncedSide !== side) {
    // 用户直接操作非联动侧即视为接管阅读位置；必须等用户重新开启同步后才能恢复联动。
    documentScrollSyncEnabled = false
    documentScrollSyncedSide = null
    documentSyncScrollButton.setAttribute('aria-checked', 'false')
  }
  userScrollSide = side
  if (userScrollIntentTimer !== null) window.clearTimeout(userScrollIntentTimer)
  // 键盘与滚动条拖动不会持续触发 wheel；保留一小段时间以覆盖其后续 scroll 事件。
  userScrollIntentTimer = window.setTimeout(() => {
    userScrollIntentTimer = null
    userScrollSide = null
  }, 180)
}

/**
 * 处理文档双栏 scroll 事件；只有真实用户意图才允许驱动另一栏。
 * @param side 产生事件的栏。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleDocumentScroll(side: DocumentScrollSide): void {
  const source = side === 'source' ? sourceContent : translationContent
  const target = side === 'source' ? translationContent : sourceContent
  const programmatic = consumeProgrammaticScroll(source)
  // 页码必须跟随当前阅读栏更新，即使同步开关关闭也不能停留在旧页。
  documentNavigation.updateCurrentPage(side)
  if (!shouldSyncDocumentScroll(side, {
    userScrollSide,
    programmatic,
    translationLayoutUpdating,
    enabled: documentScrollSyncEnabled,
    ...(documentScrollSyncedSide ? { syncedSide: documentScrollSyncedSide } : {})
  })) return
  documentScrollSyncedSide = side
  documentSyncScrollButton.setAttribute('aria-checked', 'true')
  syncScroll(source, target)
}

/**
 * 同步左右两栏滚动比例；调用方必须先确认这是真实用户滚动。
 * @param source 主动滚动的容器。
 * @param target 需要跟随的容器。
 * @returns 无返回值。
 * @author zhenghq
 */
function syncScroll(source: HTMLElement, target: HTMLElement): void {
  const sourceAnchor = findVisibleDocumentBlockAnchor(source)
  const targetAnchor = sourceAnchor
    ? target.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(sourceAnchor.dataset.blockId ?? '')}"]`)
    : null
  if (sourceAnchor && targetAnchor) {
    const sourceRect = sourceAnchor.getBoundingClientRect()
    const targetRect = targetAnchor.getBoundingClientRect()
    const nextScrollTop = target.scrollTop + targetRect.top - sourceRect.top
    pendingProgrammaticScrollTops.set(target, nextScrollTop)
    target.scrollTop = nextScrollTop
    return
  }
  const sourceRange = source.scrollHeight - source.clientHeight
  const targetRange = target.scrollHeight - target.clientHeight
  if (sourceRange <= 0 || targetRange <= 0) return
  const nextScrollTop = (source.scrollTop / sourceRange) * targetRange
  pendingProgrammaticScrollTops.set(target, nextScrollTop)
  target.scrollTop = nextScrollTop
}

/**
 * 查找滚动容器视口顶部附近第一个可见区块，作为双栏同步的稳定锚点。
 * @param container 当前滚动容器。
 * @returns 可见区块元素；没有区块或区块不在视口内时返回 null。
 * @author zhenghq
 */
function findVisibleDocumentBlockAnchor(container: HTMLElement): HTMLElement | null {
  const containerRect = container.getBoundingClientRect()
  let best: HTMLElement | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const block of container.querySelectorAll<HTMLElement>('[data-block-id]')) {
    const rect = block.getBoundingClientRect()
    if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) continue
    const distance = Math.abs(rect.top - containerRect.top)
    if (distance >= bestDistance) continue
    best = block
    bestDistance = distance
  }
  return best
}

/**
 * 计算文档模型的内容签名，用于区分仅进度变化与正文实际变化。
 * @param model 文档模型。
 * @returns 稳定内容签名；模型不存在时返回空字符串。
 * @author zhenghq
 */
function documentContentSignature(model: DocumentModel | undefined): string {
  if (!model) return ''
  return JSON.stringify({
    documentId: model.documentId,
    pages: model.pages.map((page) => ({
      pageId: page.pageId,
      width: page.width,
      height: page.height,
      background: page.background,
      contentArea: page.contentArea,
      blocks: page.blocks.map((block) => {
        if (block.kind === 'text') {
          return {
            kind: block.kind,
            blockId: block.blockId,
            bbox: block.bbox,
            style: block.style,
            textAlign: block.textAlign,
            role: block.role,
            toc: block.toc,
            runs: block.runs.map((run) => ({
              runId: run.runId,
              text: run.text,
              style: run.style,
              protected: run.protected,
              manuallyEdited: run.manuallyEdited
            }))
          }
        }
        if (block.kind === 'image') {
          return {
            kind: block.kind,
            blockId: block.blockId,
            bbox: block.bbox,
            assetId: block.assetId,
            renderPending: block.renderPending,
            ocrRegions: block.ocrRegions?.map((region) => ({
              regionId: region.regionId,
              bbox: region.bbox,
              text: region.text,
              translatedText: region.translatedText,
              style: region.style,
              textAlign: region.textAlign,
              status: region.status,
              reason: region.reason,
              manuallyEdited: region.manuallyEdited
            }))
          }
        }
        return block
      })
    }))
  })
}

/**
 * 计算源预览身份；PDF、图片与 HTML 使用文件指纹，OCR 或译文流式更新时不会触发原生预览重载。
 * @param model 当前源文档模型。
 * @returns 稳定的预览身份。
 * @author zhenghq
 */
function documentPreviewIdentity(model: DocumentModel | undefined): string {
  if (!model) return ''
  if (model.source.format === 'pdf' || model.source.format === 'image') {
    return `${model.source.format}:${model.source.sha256}`
  }
  if (model.source.format === 'html') {
    return `html:${model.source.sha256}`
  }
  return documentContentSignature(model)
}

/**
 * 计算告警签名；仅告警内容变化时更新独立告警层。
 * @param warnings 当前告警列表。
 * @returns 稳定告警签名。
 * @author zhenghq
 */
function documentWarningSignature(warnings: readonly DocumentWarning[] = []): string {
  return JSON.stringify(filterVisibleDocumentWarnings(warnings).map((warning) => ({
    code: warning.code,
    severity: warning.severity,
    message: warning.message,
    pageId: warning.pageId,
    blockId: warning.blockId
  })))
}

/**
 * 在恢复态译文尚未构建时显示轻量等待态，避免右栏沿用其他文件内容。
 * @param snapshot 当前恢复快照。
 * @param tab 快照所属的文档 Tab。
 * @param displayMode 当前 OCR 展示模式。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderDeferredRestoredTranslationWaitingState(
  snapshot: DocumentWorkspaceSnapshot,
  tab: DocumentWorkspaceTab,
  displayMode: DocumentWorkspaceTab['ocrDisplayMode']
): void {
  renderedTranslationSignature = ''
  renderedTranslationTabId = null
  renderedTranslationSha256 = ''
  renderedTranslationPreviewKind = null
  hasRenderedTranslation = false
  renderedTranslationWarningSignature = ''
  renderDocumentModel(
    translationContent,
    undefined,
    displayMode === 'ocr-text' ? 'document.waitingSource' : 'document.waitingTranslation',
    'translation',
    snapshot.jobId,
    undefined,
    tab
  )
}

/**
 * 仅在正文模型实际变化时释放并重建当前文档页面 DOM。
 * @param snapshot 当前任务快照。
 * @param tab 快照所属的文档 Tab。
 * @param options 首屏渲染选项；工作台自动恢复时可先完成原文首帧。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderSnapshot(
  snapshot: DocumentWorkspaceSnapshot,
  tab: DocumentWorkspaceTab,
  options: DocumentSnapshotRenderOptions = {}
): void {
  // 快照渲染与 Tab 切换共享同一套界面节点，过期回调不得覆盖当前文件。
  if (tab.id !== activeDocumentTabId) return
  if (!options.deferTranslationUntilSourceReady) deferredTranslationRender.cancel()
  renderActualLanguage(snapshot.languagePair)
  // 新模式准备中的快照可能暂时缺少源模型；只有同一 Tab 与同一文件指纹才可复用已渲染原文。
  const canReuseRenderedSourcePreview = renderedSourcePreviewTabId === tab.id &&
    renderedSourcePreviewSha256 === tab.selection.sha256
  const sourcePreviewIdentity = snapshot.source
    ? documentPreviewIdentity(snapshot.source)
    : canReuseRenderedSourcePreview
      ? renderedSourcePreviewIdentity
      : tab.selection.format === 'pdf' && !isReadOnlyDocumentTab(tab)
        ? `pdf-pending:${tab.selection.sha256}`
        : ''
  const displayMode = tab.ocrDisplayMode
  const translationPaneModel = displayMode === 'ocr-text' ? snapshot.source : snapshot.translation
  const translationSignature = documentContentSignature(translationPaneModel)
  const sourceWarningSignature = documentWarningSignature(snapshot.source?.warnings)
  const translationWarningSignature = documentWarningSignature(translationPaneModel?.warnings)
  const sourceChanged = renderedSourcePreviewIdentity !== sourcePreviewIdentity
  const sourceWarningsChanged = renderedSourceWarningSignature !== sourceWarningSignature
  const canReuseRenderedTranslation = renderedTranslationTabId === tab.id &&
    renderedTranslationSha256 === tab.selection.sha256
  const shouldDeferTranslation = options.deferTranslationUntilSourceReady === true &&
    !(hasRenderedTranslation && canReuseRenderedTranslation)
  const translationChanged = !hasRenderedTranslation ||
    !canReuseRenderedTranslation ||
    renderedTranslationSignature !== translationSignature
  const translationWarningsChanged = renderedTranslationWarningSignature !== translationWarningSignature
  const onSourcePreviewReady = shouldDeferTranslation
    ? (): void => deferredTranslationRender.schedule(snapshot, tab)
    : undefined
  let sourcePreviewNotificationExpected = false
  // 只有源文件身份变化才释放图片资源；译文流式增量不能破坏仍在使用的源预览。
  if (sourceChanged) revokeAssetUrls()
  if (sourceChanged) releaseHtmlPreviewUrl()
  if (sourceChanged) {
    if (!snapshot.source && tab.selection.format === 'pdf' && !isReadOnlyDocumentTab(tab)) {
      renderPendingPdfSourcePreview(sourceContent, snapshot.jobId, tab)
      renderDocumentWarnings(sourceContent)
    } else {
      renderDocumentModel(
        sourceContent,
        snapshot.source,
        'document.waitingSource',
        'source',
        snapshot.jobId,
        snapshot.source?.warnings,
        tab,
        { onSourcePreviewReady }
      )
      sourcePreviewNotificationExpected = Boolean(snapshot.source && onSourcePreviewReady)
    }
    renderedSourcePreviewIdentity = sourcePreviewIdentity
    renderedSourcePreviewTabId = tab.id
    renderedSourcePreviewSha256 = tab.selection.sha256
    renderedSourceWarningSignature = sourceWarningSignature
  } else if (sourceWarningsChanged) {
    renderDocumentWarnings(sourceContent, snapshot.source?.warnings)
    renderedSourceWarningSignature = sourceWarningSignature
  }
  if (shouldDeferTranslation) {
    // 恢复首屏只保留原文渲染；完整译文 DOM 是同步重活，必须等左侧首帧实际绘制后再构建。
    renderDeferredRestoredTranslationWaitingState(snapshot, tab, displayMode)
  } else if (translationChanged) {
    // OCR 原文模式展示源模型和透明文字层，不能走针对流式译文的原位补丁路径。
    let patched = displayMode === 'translation' && hasRenderedTranslation &&
      patchTranslationPreview(translationContent, snapshot.translation, tab)
    let effectiveTranslationSignature = translationSignature
    let effectiveTranslationWarningSignature = translationWarningSignature
    if (!patched && documentManualEdit.isEditing()) {
      // 结构变化会整页替换译文 DOM；先提交正在编辑的文本，避免用户输入随节点一起丢失。
      documentManualEdit.commitActiveEdit()
      const committedTranslation = tab.snapshot?.translation
      if (committedTranslation) {
        renderDocumentModel(
          translationContent,
          committedTranslation,
          'document.waitingTranslation',
          'translation',
          snapshot.jobId,
          committedTranslation.warnings,
          tab
        )
        effectiveTranslationSignature = documentContentSignature(committedTranslation)
        effectiveTranslationWarningSignature = documentWarningSignature(committedTranslation.warnings)
        patched = true
      }
    }
    const cachedTranslationDom = !patched && displayMode === 'translation'
      ? translationDomCache.take({
          tabId: tab.id,
          sha256: tab.selection.sha256,
          jobId: snapshot.jobId,
          signature: translationSignature,
          warningSignature: translationWarningSignature
        })
      : null
    if (cachedTranslationDom) {
      // Tab 切换复用缓存 DOM：跳过整棵译文重建，只恢复容器标记并重建页面缩放观察器。
      cleanupPdfPreview(translationContent)
      translationContent.replaceChildren(...cachedTranslationDom.content)
      translationContent.dataset.previewKind = cachedTranslationDom.previewKind
      renderedTranslationPreviewKind = cachedTranslationDom.previewKind as DocumentPreviewKind
      const cachedPreviewHost = translationContent
        .querySelector<HTMLElement>(':scope > .document-preview-host')
      if (cachedPreviewHost) observeTranslationPageScale(translationContent, cachedPreviewHost)
      scheduleTranslationPageLayout()
    } else if (!patched) {
      renderDocumentModel(
        translationContent,
        translationPaneModel,
        'document.waitingTranslation',
        'translation',
        snapshot.jobId,
        translationPaneModel?.warnings,
        tab
      )
      if (displayMode === 'translation') {
        // 新构建的译文 DOM 必须写入缓存；后续 Tab 切换按签名复用，避免重复同步重建。
        translationDomCache.remember({
          tabId: tab.id,
          sha256: tab.selection.sha256,
          jobId: snapshot.jobId,
          signature: effectiveTranslationSignature,
          warningSignature: effectiveTranslationWarningSignature,
          previewKind: renderedTranslationPreviewKind ?? translationContent.dataset.previewKind ?? '',
          content: Array.from(translationContent.children).filter(
            (node): node is HTMLElement => node instanceof HTMLElement
          )
        })
      }
    }
    renderedTranslationSignature = effectiveTranslationSignature
    renderedTranslationTabId = tab.id
    renderedTranslationSha256 = tab.selection.sha256
    hasRenderedTranslation = true
    renderedTranslationWarningSignature = effectiveTranslationWarningSignature
  } else if (translationWarningsChanged) {
    renderDocumentWarnings(translationContent, translationPaneModel?.warnings)
    renderedTranslationWarningSignature = translationWarningSignature
  }
  // 正文未变化时也必须在每次快照后刷新状态，否则缓存命中和失败目标会在流式事件中丢失。
  markDocumentTargetStatuses(snapshot)
  sourcePageCount.textContent = snapshot.source
    ? t('document.pageCount', { count: snapshot.source.pages.length })
    : tab.selection.format === 'pdf'
      ? sourcePageCount.textContent
      : ''
  translationPageCount.textContent = translationPaneModel
    ? t('document.pageCount', { count: translationPaneModel.pages.length })
    : ''
  translationContent.dataset.ocrDisplayMode = displayMode
  translationHeading.textContent = t(
    displayMode === 'ocr-text' ? 'document.ocr.source' : 'document.translation'
  )
  renderOcrDisplayModeControls(snapshot, tab)
  // 模型重绘会替换页面 DOM，旧高亮节点已失效；统一清理后再恢复当前缩放和导航状态。
  documentNavigation.clearBlockDomHighlight()
  applyDocumentZoom(documentZoom)
  documentNavigation.renderToc()
  markDocumentTargetStatuses(snapshot)
  // DOM 重绘不能抹掉 Tab 的持久化区块锚点，必须在挂载新节点后按锚点恢复高亮。
  if (tab.activeBlockId) documentNavigation.highlightBlock(tab.activeBlockId)
  documentNavigation.schedulePageUpdate()
  // 重绘会替换译文节点，必须重新绑定手改样式与正文检索高亮。
  documentManualEdit.refresh()
  documentSearch.refresh()
  // 原文已经复用或尚未具备模型时不会收到渲染器回调；仍需在首帧后补一次译文构建。
  if (onSourcePreviewReady && !sourcePreviewNotificationExpected) {
    runAfterNextPaint(onSourcePreviewReady)
  }
}

/**
 * 在指定栏中定位完成报告目标对应的可见 DOM。
 * 文本优先定位 run，表格行定位到 tr，OCR 优先定位可见覆盖层并回退到图片区块。
 * @param container 原文或译文栏容器。
 * @param target 已解析的目标。
 * @returns 可标记的 DOM 元素；目标未渲染时返回 null。
 * @author zhenghq
 */
function findRenderedDocumentTarget(
  container: HTMLElement,
  target: NonNullable<ReturnType<typeof findDocumentTarget>>
): HTMLElement | null {
  const pages = container.querySelectorAll<HTMLElement>(
    '.document-page, .document-pdf-page[data-page-number]'
  )
  const page = pages[target.page.index]
  if (!page) return null
  const block = page.querySelector<HTMLElement>(
    `[data-block-id="${CSS.escape(target.block.blockId)}"]`
  )
  if (!block) return null
  if (target.kind === 'text' && target.runId) {
    return block.querySelector<HTMLElement>(
      `[data-run-id="${CSS.escape(target.runId)}"]`
    ) ?? block
  }
  if (target.kind === 'row' && target.rowId) {
    return page.querySelector<HTMLElement>(
      `[data-row-id="${CSS.escape(target.rowId)}"]`
    ) ?? block
  }
  if (target.kind === 'ocr' && target.regionId) {
    return block.querySelector<HTMLElement>(
      `.document-ocr-region[data-region-id="${CSS.escape(target.regionId)}"]`
    ) ?? block
  }
  return block
}

/**
 * 清理双栏上一次动态状态，避免流式重绘后遗留失败、未完成或疑似未翻译边框。
 * @returns 无返回值。
 * @author zhenghq
 */
function clearDocumentTargetStatuses(): void {
  for (const container of [sourceContent, translationContent]) {
    container.querySelectorAll<HTMLElement>('[data-translation-status]').forEach((element) => {
      element.classList.remove(
        'document-translation-failed',
        'document-translation-pending',
        'document-translation-suspect-untranslated'
      )
      delete element.dataset.translationStatus
      delete element.dataset.translationCache
    })
  }
}

/**
 * 根据完成报告标记失败、未完成、疑似未翻译和缓存命中目标。
 * 区块内不显示状态角标或操作按钮，避免遮挡译文；重试统一使用工具栏入口。
 * @param snapshot 当前任务快照。
 * @returns 无返回值。
 * @author zhenghq
 */
function markDocumentTargetStatuses(snapshot: DocumentWorkspaceSnapshot): void {
  clearDocumentTargetStatuses()
  const model = snapshot.source ?? snapshot.translation
  const report = snapshot.completionReport
  if (!model || (!report && !(snapshot.cacheHitTargetIds?.length))) return
  const cacheHitIds = new Set(snapshot.cacheHitTargetIds ?? [])
  const statusGroups = [
    ['failed', report?.failedTargetIds ?? []],
    ['pending', report?.pendingTargetIds ?? []],
    ['suspect-untranslated', report?.suspectUntranslatedTargetIds ?? []]
  ] as const
  for (const [status, targetIds] of statusGroups) {
    for (const targetId of targetIds) {
      const target = findDocumentTarget(model, targetId)
      if (!target) continue
      for (const container of [sourceContent, translationContent]) {
        const element = findRenderedDocumentTarget(container, target)
        if (!element) continue
        element.dataset.translationStatus = status
        element.classList.add(`document-translation-${status}`)
      }
    }
  }
  for (const targetId of cacheHitIds) {
    const target = findDocumentTarget(model, targetId)
    if (!target) continue
    const element = findRenderedDocumentTarget(translationContent, target)
    if (!element) continue
    element.dataset.translationCache = 'hit'
  }
}

/**
 * 从完成报告的目标标识中解析页面索引与目标类型。
 * 目标格式为 `pageIndex:blockPath:kind:identifier`，只读取稳定定位所需字段。
 * @param targetId 完成报告中的目标标识。
 * @returns 页面索引、目标类型和可选表格行标识。
 * @author zhenghq
 */
function parseFailedTargetId(targetId: string): {
  pageIndex: number
  kind: string
  rowId?: string
} | null {
  const match = /^(\d+):(.+):(text|ocr|row):(.+)$/u.exec(targetId)
  if (!match) return null
  const pageIndex = Number(match[1])
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) return null
  return {
    pageIndex,
    kind: match[3]!,
    ...(match[3] === 'row' ? { rowId: match[4]! } : {})
  }
}

/**
 * 滚动到完成报告中第一个失败、未完成或疑似未翻译目标。
 * 优先使用稳定目标标识；表格行使用 data-row-id，其余目标回退到页面级定位。
 * @param snapshot 当前任务快照。
 * @returns 是否找到并定位了目标。
 * @author zhenghq
 */
function revealFirstIncompleteTarget(snapshot: DocumentWorkspaceSnapshot): boolean {
  const report = snapshot.completionReport
  if (!report) return false
  const targetIds = [
    ...report.failedTargetIds,
    ...report.pendingTargetIds,
    ...report.suspectUntranslatedTargetIds
  ]
  for (const targetId of targetIds) {
    const target = parseFailedTargetId(targetId)
    if (!target) continue
    const pages = translationContent.querySelectorAll<HTMLElement>('.document-page')
    const page = pages[target.pageIndex]
    let element: HTMLElement | null = null
    if (target.rowId) {
      element = translationContent.querySelector<HTMLElement>(
        `[data-row-id="${CSS.escape(target.rowId)}"]`
      )
    }
    element ??= page ?? null
    if (!element) continue
    element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    element.dataset.incompleteTarget = 'true'
    return true
  }
  return false
}

/**
 * 等待字体、图片和两帧布局稳定后插入部分导出可见标记。
 * 该函数由主进程打印脚本调用，不能读取未序列化的任务对象。
 * @param summary 部分导出目标统计。
 * @param label 可见标记标题。
 * @returns 打印准备完成状态。
 * @author zhenghq
 */
async function preparePartialExport(
  summary: DocumentPartialExportSummary,
  label: string
): Promise<{ ready: true; summary: DocumentPartialExportSummary }> {
  const host = translationContent
  host.querySelector('.document-partial-export-notice')?.remove()
  const notice = document.createElement('aside')
  notice.className = 'document-partial-export-notice'
  notice.setAttribute('role', 'note')
  notice.textContent = `${label} · ${t('document.partialExport.notice', {
    reverted: summary.reverted,
    failed: summary.failed,
    pending: summary.pending,
    suspectUntranslated: summary.suspectUntranslated
  })}`
  host.insertBefore(notice, host.firstChild)
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  return { ready: true, summary }
}

/**
 * 恢复部分导出前的实时译文预览，清除仅用于打印的标记并强制重绘最新快照。
 * @returns 恢复完成状态。
 * @author zhenghq
 */
function restorePrintPreview(): { restored: true } {
  translationContent.querySelectorAll('.document-partial-export-notice').forEach((notice) => notice.remove())
  const tab = getActiveDocumentTab()
  if (latestSnapshot && tab?.snapshot === latestSnapshot) {
    renderedTranslationSignature = ''
    hasRenderedTranslation = false
    renderSnapshot(latestSnapshot, tab)
  }
  return { restored: true }
}

/**
 * 等待用户在部分导出确认对话框中选择继续或返回。
 * @param snapshot 当前任务快照。
 * @returns 用户是否确认导出部分结果。
 * @author zhenghq
 */
function confirmPartialExport(snapshot: DocumentWorkspaceSnapshot): Promise<boolean> {
  const completionReport = snapshot.completionReport
  const failed = completionReport ? completionReport.failed : snapshot.task.failedBlocks
  const pending = completionReport ? completionReport.pending : 0
  const suspectUntranslated = completionReport ? completionReport.suspectUntranslated : 0
  partialExportSummary.textContent = t('document.partialExport.summary', {
    failed,
    pending,
    suspectUntranslated,
    reverted: failed + pending + suspectUntranslated
  })
  if (typeof partialExportDialog.showModal === 'function') partialExportDialog.showModal()
  else partialExportDialog.setAttribute('open', '')
  return new Promise((resolve) => {
    resolvePartialExportConfirmation = resolve
  })
}

/**
 * 关闭部分导出确认对话框并解析等待中的导出请求。
 * @param confirmed 是否由“导出部分结果”按钮确认。
 * @returns 无返回值。
 * @author zhenghq
 */
function closePartialExportDialog(confirmed: boolean): void {
  const resolve = resolvePartialExportConfirmation
  resolvePartialExportConfirmation = null
  if (partialExportDialog.open) partialExportDialog.close()
  else partialExportDialog.removeAttribute('open')
  resolve?.(confirmed)
}

/**
 * 将打印所需的受控预览能力暴露给主进程，限制为准备和恢复两个动作。
 * @returns 无返回值。
 * @author zhenghq
 */
function exposeDocumentPrintPreview(): void {
  window.__documentPrintPreview = {
    preparePartialExport,
    restorePrintPreview
  }
}

/**
 * 更新进度、任务状态和操作按钮。
 * @param snapshot 当前任务快照。
 * @param tab 快照所属的文档 Tab。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderTaskState(snapshot: DocumentWorkspaceSnapshot, tab: DocumentWorkspaceTab): void {
  // 异步任务状态可能晚于 Tab 切换到达，只有仍处于活动状态时才允许覆盖共享界面。
  if (tab.id !== activeDocumentTabId) return
  const status = snapshot.task.status
  const restored = isRestoredDocumentTab(tab) || isReadOnlyDocumentTab(tab)
  const report = snapshot.completionReport
  const retryAction = resolveDocumentRetryActionState(snapshot)
  const warningCount = countVisibleDocumentWarnings(
    snapshot.source?.warnings ?? [],
    snapshot.translation?.warnings ?? []
  )
  const { failed, pending, suspectUntranslated, reverted } = retryAction
  const hasUsableTranslation = snapshot.runMode === 'ocr'
    ? status === 'completed'
    : report
    ? report.translated + report.unchanged > 0
    : status === 'completed' || status === 'partial'
  const stageKeys: Record<string, string> = {
    validating: 'document.progress.preparing',
    parsing: 'document.progress.parsing',
    ocr: 'document.progress.ocr',
    translating: 'document.progress.translating',
    rendering: 'document.progress.composing',
    exporting: 'document.progress.exporting',
    completed: 'document.progress.completed',
    partial: 'document.partial',
    cancelled: 'document.progress.cancelled',
    failed: 'document.progress.failed'
  }
  progressStage.textContent = t(stageKeys[status] ?? 'document.progress.preparing')
  const percent = Math.max(0, Math.min(100, Math.round(snapshot.percent)))
  progressbar.setAttribute('aria-valuenow', String(percent))
  progressbar.style.width = `${percent}%`
  const progressCompleted = report
    ? report.translated + report.unchanged
    : snapshot.task.progress.completed
  const progressTotal = report ? report.total : snapshot.task.progress.total
  progressCount.textContent = progressTotal > 0
    ? `${progressCompleted} / ${progressTotal} · ${percent}%`
    : `${percent}%`
  const pageTotal = snapshot.source?.pages.length ?? snapshot.translation?.pages.length ?? 0
  const currentPage = pageTotal > 0
    ? Math.max(1, Math.min(pageTotal, tab.pageNumber))
    : 0
  progressPages.textContent = pageTotal > 0
    ? t('document.progress.pages', { current: currentPage, total: pageTotal })
    : ''
  const completedTargets = report
    ? report.translated + report.unchanged
    : snapshot.task.progress.completed
  const totalTargets = report ? report.total : snapshot.task.progress.total
  progressBlocks.textContent = totalTargets > 0
    ? t('document.progress.blocks', { completed: completedTargets, total: totalTargets })
    : ''
  progressWarnings.textContent = t('document.progress.warnings', {
    count: warningCount
  })
  const remaining = resolveDocumentRemainingTime(snapshot)
  progressRemaining.textContent = remaining === null
    ? ''
    : t('document.progress.remaining', { time: formatDocumentDuration(remaining) })
  const terminal = ['completed', 'partial', 'cancelled', 'failed'].includes(status)
  cancelButton.hidden = terminal
  exportButton.disabled = restored
    ? !hasUsableExportResult(snapshot) || !approvedDocumentSourceRequest(tab)
    : status === 'completed'
      ? false
      : status === 'partial' || status === 'failed'
        ? !hasUsableTranslation
        : true
  // phaseCompleted 只表示阶段流程结束，不代表没有可重试目标；partial 终态
  // 仍需与摘要共用同一动作状态，按失败、未完成和疑似未翻译目标决定按钮状态。
  retryButton.disabled = retryAction.retryDisabled
  rerunButton.disabled = !canRetranslateDocumentTab(tab) ||
    tab.startInFlight ||
    snapshot.task.status === 'validating' || snapshot.task.status === 'parsing' ||
    snapshot.task.status === 'ocr' || snapshot.task.status === 'translating' ||
    snapshot.task.status === 'rendering' || snapshot.task.status === 'exporting'
  if (restored) {
    // 恢复态没有活动主进程任务，但已有译文仍可走受控历史导出通道。
    retryButton.disabled = true
    cancelButton.hidden = true
  }
  partialStatus.hidden = status !== 'partial' && status !== 'failed' && status !== 'cancelled'
  if (status === 'partial') {
    partialStatus.textContent = t('document.partialSummary', { failed, pending, suspectUntranslated, reverted, warnings: warningCount })
  } else if (status === 'failed') {
    partialStatus.textContent = hasUsableTranslation
      ? t('document.partialSummary', { failed, pending, suspectUntranslated, reverted, warnings: warningCount })
      : t('document.run.failed')
  } else if (status === 'cancelled') {
    partialStatus.textContent = t('document.cancelled')
  }
  if (restored) {
    // 恢复态是已完成内容的只读回放，进度语义应显示完成而不是可重试的部分结果。
    partialStatus.hidden = true
  }
  workbench.dataset.state = status
  // 切 Tab 或提交手改后，回退/前进栈随 Tab 变化，需要同步按钮可用状态。
  refreshDocumentEditHistoryButtons()
}

/**
 * 根据当前阶段进度和已用时间估算剩余时间。
 * @param snapshot 当前任务快照。
 * @returns 预计剩余毫秒数；尚无足够进度信息时返回 null。
 * @author zhenghq
 */
function resolveDocumentRemainingTime(snapshot: DocumentWorkspaceSnapshot): number | null {
  const progress = snapshot.task.progress
  if (progress.completed <= 0 || progress.total <= 0) {
    return null
  }
  const taskKey = `${snapshot.jobId}:${snapshot.generation}`
  const startedAt = documentTaskStartedAt.get(taskKey) ?? Date.now()
  if (!documentTaskStartedAt.has(taskKey)) documentTaskStartedAt.set(taskKey, startedAt)
  return calculateDocumentRemainingMilliseconds(snapshot.percent, startedAt)
}

/**
 * 同步刷新正文快照与任务状态；正文重绘异常不能阻断终态进度和操作按钮更新。
 * @param snapshot 当前任务快照。
 * @param tab 快照所属的文档 Tab。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderSnapshotAndTaskState(
  snapshot: DocumentWorkspaceSnapshot,
  tab: DocumentWorkspaceTab
): void {
  try {
    renderSnapshot(snapshot, tab)
  } catch (error) {
    console.error('document-snapshot-render-failed', error instanceof Error ? error.name : 'unknown')
  } finally {
    renderTaskState(snapshot, tab)
  }
}

/**
 * 在下一帧合并快照重绘，避免高频进度事件反复重建大文档 DOM。
 * @param tab 快照所属的 Tab。
 * @param snapshot 最新任务快照。
 * @returns 无返回值。
 * @author zhenghq
 */
function scheduleSnapshotRenderForTab(tab: DocumentWorkspaceTab, snapshot: DocumentWorkspaceSnapshot): void {
  // 模式切换重启期间禁止旧任务快照进入合并队列，避免取消终态在新流程启动前回写界面。
  if (!canRenderDocumentTabSnapshot(tab, snapshot)) return
  latestSnapshot = snapshot
  if (pendingRenderFrame !== null) return
  pendingRenderFrame = requestAnimationFrame(() => {
    pendingRenderFrame = null
    if (!canRenderDocumentTabSnapshot(tab, snapshot)) return
    latestSnapshot = snapshot
    renderSnapshotAndTaskState(snapshot, tab)
  })
}

/**
 * 立即渲染指定快照，并取消尚未执行的合并帧，避免终态或导出时沿用旧的流式部分译文。
 * @param tab 快照所属的 Tab。
 * @param snapshot 需要立即落到界面的最新任务快照。
 * @returns 无返回值。
 * @author zhenghq
 */
function flushSnapshotRenderForTab(tab: DocumentWorkspaceTab, snapshot: DocumentWorkspaceSnapshot): void {
  // 模式切换重启期间终态也必须丢弃，新任务只接受其自身代际的完成事件。
  if (!canRenderDocumentTabSnapshot(tab, snapshot)) return
  if (pendingRenderFrame !== null) {
    cancelAnimationFrame(pendingRenderFrame)
    pendingRenderFrame = null
  }
  latestSnapshot = snapshot
  renderSnapshotAndTaskState(snapshot, tab)
}

/**
 * 取消指定任务；任务已结束时静默忽略，避免阻断后续新模式启动。
 * @param jobId 可选的当前任务标识。
 * @param jobGeneration 发起取消时对应的任务代际。
 * @returns 取消请求完成后的 Promise。
 * @author zhenghq
 */
async function cancelDocumentJob(jobId: string | null, jobGeneration: number): Promise<void> {
  if (!jobId) return
  try {
    await window.api.cancelDocument(jobId, jobGeneration)
  } catch {
    // 任务可能已经结束，后续代际仍会隔离迟到事件。
  }
}

/**
 * 取消启动请求在代际失效后才返回的旧任务。
 * @param result 启动请求返回结果。
 * @param jobGeneration 发起该启动请求时使用的任务代际。
 * @returns 取消请求完成后的 Promise。
 * @author zhenghq
 */
async function cancelLateDocumentRunResult(
  result: DocumentRunResult,
  jobGeneration: number
): Promise<void> {
  if (!result.accepted || !result.jobId) return
  await cancelDocumentJob(result.jobId, jobGeneration)
  // 启动请求迟到时对应 Tab 可能已经关闭，取消后必须立即释放主进程任务资源。
  await releaseDocumentJob(result.jobId)
}

/** 模式切换 not-ready 时已延迟重试过的 Tab；每个 Tab 最多自动重试一次。 */
const documentModeSwitchRetriedTabs = new Set<string>()

/**
 * 清空指定 Tab 的 OCR 模式切换状态。
 * @param tab 目标 Tab。
 * @returns 无返回值。
 * @author zhenghq
 */
function resetDocumentModeSwitchState(tab: DocumentWorkspaceTab): void {
  tab.pendingOcrModeTarget = null
  tab.ocrModeSwitchInFlight = false
  tab.pendingModeSwitchGeneration = null
  tab.pendingModeSwitchSnapshot = null
  tab.pendingModeSwitchSnapshotTerminal = false
  documentModeSwitchRetriedTabs.delete(tab.id)
}

/**
 * 判断任务快照是否已经进入终态；主进程仅允许在这种状态下复用源模型切换模式。
 * @param snapshot 待检查的任务快照。
 * @returns 是否已结算。
 * @author zhenghq
 */
function isDocumentSnapshotSettled(snapshot: DocumentWorkspaceSnapshot | null): boolean {
  if (!snapshot) return false
  return snapshot.task.status === 'completed' ||
    snapshot.task.status === 'partial' ||
    snapshot.task.status === 'failed' ||
    snapshot.task.status === 'cancelled'
}

/**
 * 在旧任务终态后请求主进程复用已解析与已识别的源模型切换 OCR 模式。
 * 运行中的任务不会被取消或清空；事件先到而响应未到时按新代际缓冲。
 * @param tab 目标文件 Tab。
 * @returns 切换请求处理完成后的 Promise。
 * @author zhenghq
 */
async function maybeSwitchDocumentOcrMode(tab: DocumentWorkspaceTab): Promise<void> {
  const target = tab.pendingOcrModeTarget
  if (!target || tab.ocrModeSwitchInFlight || !documentTabs.includes(tab) ||
    isReadOnlyDocumentTab(tab)) {
    return
  }
  const jobId = tab.activeJobId ?? tab.expectedJobId
  if (!jobId || !isDocumentSnapshotSettled(tab.snapshot)) return
  const targetMode = target === 'ocr-text' ? 'ocr' as const : 'translation' as const
  // 主进程与新快照都已处于目标模式时无需再切换，只清理本地待切换标记。
  if ((tab.snapshot?.runMode ?? 'translation') === targetMode) {
    tab.pendingOcrModeTarget = null
    if (tab.id === activeDocumentTabId) refreshActiveTabMirror(tab)
    return
  }
  const settledGeneration = tab.generation
  let nextModeGeneration = nextGeneration()
  tab.ocrModeSwitchInFlight = true
  tab.pendingModeSwitchGeneration = nextModeGeneration
  tab.pendingModeSwitchSnapshot = null
  tab.pendingModeSwitchSnapshotTerminal = false
  if (tab.id === activeDocumentTabId) refreshActiveTabMirror(tab)
  const requestModeSwitch = (generationValue: number): Promise<DocumentRunResult> =>
    window.api.switchDocumentMode({
      jobId,
      generation: settledGeneration,
      nextGeneration: generationValue,
      mode: targetMode
    })
  let response = await requestModeSwitch(nextModeGeneration)
  if (!documentTabs.includes(tab)) return
  // 本地存储可能落后于主进程；只在主进程给出更高代际时安全重试一次。
  if (!response.accepted && response.code === 'generation-conflict' &&
    adoptSuggestedGeneration(response.suggestedGeneration)) {
    nextModeGeneration = generation
    tab.pendingModeSwitchGeneration = nextModeGeneration
    response = await requestModeSwitch(nextModeGeneration)
  }
  if (!documentTabs.includes(tab)) return
  if (!response.accepted) {
    tab.ocrModeSwitchInFlight = false
    tab.pendingModeSwitchGeneration = null
    tab.pendingModeSwitchSnapshot = null
    tab.pendingModeSwitchSnapshotTerminal = false
    if (tab.id === activeDocumentTabId) refreshActiveTabMirror(tab)
    // not-ready 表示主进程尚在结算；每个 Tab 延迟重试一次，其余拒绝留待后续终态事件。
    if (response.code === 'not-ready' && !documentModeSwitchRetriedTabs.has(tab.id)) {
      documentModeSwitchRetriedTabs.add(tab.id)
      window.setTimeout(() => {
        if (documentTabs.includes(tab)) void maybeSwitchDocumentOcrMode(tab)
      }, 250)
    }
    return
  }
  const bufferedSnapshot = tab.pendingModeSwitchSnapshot
  const bufferedTerminal = tab.pendingModeSwitchSnapshotTerminal
  tab.generation = nextModeGeneration
  tab.expectedJobId = response.jobId ?? jobId
  tab.activeJobId = response.jobId ?? jobId
  tab.ocrModeSwitchInFlight = false
  tab.pendingModeSwitchGeneration = null
  tab.pendingModeSwitchSnapshot = null
  tab.pendingModeSwitchSnapshotTerminal = false
  if (tab.pendingOcrModeTarget === target) tab.pendingOcrModeTarget = null
  documentModeSwitchRetriedTabs.delete(tab.id)
  if (bufferedSnapshot) {
    // 主进程新代际事件可能早于 IPC 响应到达，确认后再按终态或流式方式消费。
    const applied = updateDocumentTabSnapshot(tab, bufferedSnapshot)
    if (tab.id === activeDocumentTabId) {
      if (bufferedTerminal) flushSnapshotRenderForTab(tab, applied)
      else scheduleSnapshotRenderForTab(tab, applied)
    }
  } else {
    if (tab.id === activeDocumentTabId) refreshActiveTabMirror(tab)
    renderDocumentTabs()
  }
  // 请求在途期间用户可能又选择了其他目标，确认后必须继续处理最新选择。
  if (tab.pendingOcrModeTarget) void maybeSwitchDocumentOcrMode(tab)
}

/**
 * 启动指定文件 Tab 的翻译或 OCR 任务。
 * 所有请求参数均从目标 Tab 捕获，后台 Tab 的启动结果不会覆盖当前可见 Tab。
 * @param tab 要启动的文件 Tab。
 * @param options 启动选项；重新翻译时跳过两层缓存。
 * @returns 启动请求完成后的 Promise。
 * @author zhenghq
 */
async function startDocumentTabTranslation(
  tab: DocumentWorkspaceTab,
  options: { bypassCache?: boolean } = {}
): Promise<void> {
  if (!tab.selection.path || !platformCapability?.supported) return
  // 历史与恢复态只读；需要新任务时应重新选择文件，不能复用旧任务身份发起请求。
  if (isReadOnlyDocumentTab(tab)) return
  if (tab.startInFlight) {
    // 同一 Tab 的模式或语言变更必须等当前启动请求返回后再执行，避免主进程拒绝并发任务。
    tab.pendingLanguageRetranslation = true
    return
  }
  if (!documentTabs.includes(tab)) return

  tab.pendingLanguageRetranslation = false
  resetDocumentModeSwitchState(tab)
  tab.startInFlight = true
  tab.status = 'starting'
  let jobGeneration = nextGeneration()
  tab.generation = jobGeneration
  const selectedPath = tab.selection.path
  const sourceLang = tab.sourceLang
  const targetLang = tab.targetLang
  const mode = tab.ocrDisplayMode === 'ocr-text' ? 'ocr' as const : 'translation' as const
  tab.activeJobId = null
  tab.expectedJobId = null
  tab.snapshot = null
  const isActive = tab.id === activeDocumentTabId
  if (isActive) {
    refreshActiveTabMirror(tab)
    uploadPanel.hidden = true
    workbench.hidden = false
    workbenchName.textContent = tab.selection.name
    workbenchMeta.textContent = `${tab.selection.format.toUpperCase()} · ${formatFileSize(tab.selection.size)}`
    // 模式切换重启时只清空右侧，左侧原文由同一文件继续复用。
    clearActiveTabTranslationPreview()
    if (tab.selection.format === 'pdf' && !hasReusablePdfSourcePreview(
      tab,
      renderedSourcePreviewIdentity,
      renderedSourcePreviewTabId,
      renderedSourcePreviewSha256
    )) {
      renderPendingPdfSourcePreview(sourceContent, '', tab)
    }
    progressStage.textContent = t('document.progress.preparing')
    progressCount.textContent = t('document.progress.pending')
    progressbar.setAttribute('aria-valuenow', '0')
    progressbar.style.width = '0%'
    actualLanguage.textContent = ''
    actualLanguage.hidden = true
    cancelButton.hidden = false
    exportButton.disabled = true
    retryButton.disabled = true
    rerunButton.disabled = false
    partialStatus.hidden = true
    closePartialExportDialog(false)
    startButton.disabled = true
  }
  renderDocumentTabs()

  try {
    let result: DocumentRunResult = await window.api.runDocument({
      path: selectedPath,
      generation: jobGeneration,
      sourceLang,
      targetLang,
      mode,
      bypassCache: options.bypassCache === true
    })
    if (!documentTabs.includes(tab) || tab.generation !== jobGeneration) {
      await cancelLateDocumentRunResult(result, jobGeneration)
      return
    }
    // 首个任务可能因 Renderer 重载或旧窗口留下更高代际而冲突，仅在尚无任何事件时安全重试一次。
    if (!result.accepted && result.code === 'generation-conflict' &&
      tab.expectedJobId === null && tab.snapshot === null &&
      adoptSuggestedGeneration(result.suggestedGeneration)) {
      tab.generation = generation
      jobGeneration = generation
      tab.startInFlight = true
      result = await window.api.runDocument({
        path: selectedPath,
        generation: jobGeneration,
        sourceLang,
        targetLang,
        mode,
        bypassCache: options.bypassCache === true
      })
    }
    if (!documentTabs.includes(tab) || tab.generation !== jobGeneration) {
      await cancelLateDocumentRunResult(result, jobGeneration)
      return
    }
    if (!result.accepted || !result.jobId) {
      tab.status = 'failed'
      if (tab.id === activeDocumentTabId) {
        refreshActiveTabMirror(tab)
        progressStage.textContent = t('document.run.failed')
        progressCount.textContent = t('document.run.failedCode', { code: result.code ?? 'run-failed' })
        cancelButton.hidden = true
        startButton.disabled = false
      }
      renderDocumentTabs()
      return
    }
    tab.expectedJobId = result.jobId
    tab.activeJobId = result.jobId
    // 首条进度可能早于 runDocument 返回；此处读取异步事件写入后的最新值，而非启动前清空的快照。
    const pendingSnapshot = tab.snapshot as DocumentWorkspaceSnapshot | null
    if (pendingSnapshot?.jobId === result.jobId && tab.id === activeDocumentTabId) {
      refreshActiveTabMirror(tab)
      scheduleSnapshotRenderForTab(tab, pendingSnapshot)
    }
  } catch {
    if (!documentTabs.includes(tab) || tab.generation !== jobGeneration) return
    tab.status = 'failed'
    if (tab.id === activeDocumentTabId) {
      refreshActiveTabMirror(tab)
      progressStage.textContent = t('document.run.failed')
      cancelButton.hidden = true
      startButton.disabled = false
    }
    renderDocumentTabs()
  } finally {
    if (documentTabs.includes(tab)) {
      tab.startInFlight = false
      if (tab.id === activeDocumentTabId) {
        documentStartInFlight = false
        startButton.disabled = false
      }
      if (tab.pendingLanguageRetranslation) {
        tab.pendingLanguageRetranslation = false
        await startDocumentTabTranslation(tab)
      }
      // 完成快照可能早于 runDocument 请求返回；忙碌标记清除后必须重绘任务状态，
      // 否则重新翻译按钮会保留快照渲染时的禁用状态，直到下一次无关事件才恢复。
      if (tab.id === activeDocumentTabId && tab.snapshot) {
        renderTaskState(tab.snapshot, tab)
      }
      renderDocumentTabs()
    }
  }
}

/**
 * 取消当前任务并从源文件完整重新翻译，跳过文档缓存与通用翻译缓存。
 * @returns 重新翻译启动完成后的 Promise。
 * @author zhenghq
 */
async function rerunDocumentTranslation(): Promise<void> {
  const tab = getActiveDocumentTab()
  if (!canRetranslateDocumentTab(tab)) return
  if (tab.startInFlight) return
  if (isReadOnlyDocumentTab(tab) && !prepareDocumentTabForLanguageRetranslation(tab)) {
    partialStatus.textContent = t('document.error.unreadable')
    partialStatus.hidden = false
    refreshActiveTabMirror(tab)
    return
  }
  const jobId = tab.activeJobId ?? tab.expectedJobId
  const jobGeneration = tab.generation
  rerunButton.disabled = true
  progressStage.textContent = t('document.rerunStarted')
  progressCount.textContent = t('document.progress.pending')
  progressbar.setAttribute('aria-valuenow', '0')
  progressbar.style.width = '0%'
  partialStatus.hidden = false
  partialStatus.textContent = t('document.rerunStarted')
  await cancelDocumentJob(jobId, jobGeneration)
  if (!documentTabs.includes(tab)) return
  if (jobId) await releaseDocumentJob(jobId)
  if (!documentTabs.includes(tab)) return
  // 清空旧任务身份和快照，避免取消终态或迟到事件混入新任务。
  tab.snapshot = null
  tab.activeJobId = null
  tab.expectedJobId = null
  if (tab.id === activeDocumentTabId) {
    latestSnapshot = null
    activeJobId = null
    expectedJobId = null
    clearActiveTabTranslationPreview()
  }
  await startDocumentTabTranslation(tab, { bypassCache: true })
}

/**
 * 启动当前激活 Tab 的翻译任务。
 * @returns 启动流程完成后的 Promise。
 * @author zhenghq
 */
async function startDocumentTranslation(): Promise<void> {
  const tab = getActiveDocumentTab()
  if (!tab) return
  if (isReadOnlyDocumentTab(tab)) {
    // 只读回放不可继续使用旧任务身份，显式重新选择同一文件即可开始新的翻译任务。
    await chooseDocumentFiles()
    return
  }
  await startDocumentTabTranslation(tab)
}

/**
 * 请求取消当前任务并立即禁用重复取消。
 * @returns 无返回值。
 * @author zhenghq
 */
async function cancelDocumentTranslation(): Promise<void> {
  const tab = getActiveDocumentTab()
  const jobId = tab?.activeJobId ?? tab?.expectedJobId
  if (!tab || !jobId) return
  cancelButton.disabled = true
  try {
    await cancelDocumentJob(jobId, tab.generation)
  } finally {
    cancelButton.disabled = false
  }
}

/**
 * 仅重新翻译当前文档中失败的目标，不清空已有译文或重新解析源文件。
 * @returns 无返回值。
 * @author zhenghq
 */
async function retryFailedDocumentTranslation(): Promise<void> {
  const tab = getActiveDocumentTab()
  const snapshot = tab?.snapshot
  if (!tab || !snapshot?.translation) return
  if (isRestoredDocumentTab(tab) || isReadOnlyDocumentTab(tab)) return
  if (resolveDocumentRetryActionState(snapshot).retryDisabled) return
  const previousGeneration = tab.generation
  let jobGeneration = nextGeneration()
  tab.generation = jobGeneration
  tab.status = 'running'
  refreshActiveTabMirror(tab)
  retryButton.disabled = true
  cancelButton.hidden = false
  exportButton.disabled = true
  partialStatus.hidden = false
  partialStatus.textContent = t('document.retryStarted')
  progressStage.textContent = t('document.progress.translating')
  progressCount.textContent = t('document.progress.pending')
  try {
    let result = await window.api.retryFailedDocument(snapshot.jobId, jobGeneration)
    // 重试同样可能遇到 Renderer 重载后遗留的更高代际；采用建议值后只安全重试一次。
    if (!result.accepted && result.code === 'generation-conflict' &&
      adoptSuggestedGeneration(result.suggestedGeneration)) {
      jobGeneration = generation
      tab.generation = jobGeneration
      refreshActiveTabMirror(tab)
      result = await window.api.retryFailedDocument(snapshot.jobId, jobGeneration)
    }
    if (!documentTabs.includes(tab) || tab.generation !== jobGeneration) return
    if (!result.accepted) {
      tab.generation = previousGeneration
      tab.status = resolveDocumentTabStatus(snapshot)
      refreshActiveTabMirror(tab)
      partialStatus.textContent = result.code === 'no-retryable-failures'
        ? t('document.progress.completed')
        : t('document.run.failedCode', { code: result.code ?? 'retry-failed' })
      retryButton.disabled = true
      cancelButton.hidden = true
      // 重试请求被拒绝时仍停留在原来的部分完成快照，应恢复已有译文的导出能力。
      exportButton.disabled = !hasUsableExportResult(snapshot)
      renderDocumentTabs()
    }
  } catch {
    if (!documentTabs.includes(tab) || tab.generation !== jobGeneration) return
    tab.generation = previousGeneration
    tab.status = resolveDocumentTabStatus(snapshot)
    refreshActiveTabMirror(tab)
    partialStatus.textContent = t('document.run.failed')
    retryButton.disabled = false
    cancelButton.hidden = true
    exportButton.disabled = !hasUsableExportResult(snapshot)
    renderDocumentTabs()
  }
}

/**
 * 仅重试当前任务中指定的失败目标，不清空其他译文、重新解析文档或重跑 OCR。
 * @param targetId 完成报告中的稳定目标标识。
 * @returns 重试请求完成后的 Promise。
 * @author zhenghq
 */
async function retryFailedDocumentTarget(targetId: string): Promise<void> {
  const tab = getActiveDocumentTab()
  const snapshot = tab?.snapshot
  if (!tab || !snapshot?.translation) return
  if (!collectRetryableDocumentTargetIds(snapshot.completionReport).includes(targetId)) return
  const previousGeneration = tab.generation
  const previousStatus = tab.status
  let jobGeneration = nextGeneration()
  tab.generation = jobGeneration
  tab.status = 'running'
  refreshActiveTabMirror(tab)
  retryButton.disabled = true
  exportButton.disabled = true
  cancelButton.hidden = false
  partialStatus.hidden = false
  partialStatus.textContent = t('document.retryStarted')
  progressStage.textContent = t('document.progress.translating')
  progressCount.textContent = t('document.progress.pending')
  const restoreRetryUi = (): void => {
    if (!documentTabs.includes(tab) || tab.generation !== jobGeneration) return
    tab.generation = previousGeneration
    tab.status = previousStatus
    refreshActiveTabMirror(tab)
    cancelButton.hidden = true
    exportButton.disabled = !hasUsableExportResult(snapshot)
    renderTaskState(snapshot, tab)
    renderDocumentTabs()
  }
  try {
    let result = await window.api.retryFailedDocumentTarget(
      snapshot.jobId,
      jobGeneration,
      targetId
    )
    if (!result.accepted && result.code === 'generation-conflict' &&
      adoptSuggestedGeneration(result.suggestedGeneration)) {
      jobGeneration = generation
      tab.generation = jobGeneration
      refreshActiveTabMirror(tab)
      result = await window.api.retryFailedDocumentTarget(
        snapshot.jobId,
        jobGeneration,
        targetId
      )
    }
    if (!documentTabs.includes(tab) || tab.generation !== jobGeneration) return
    if (result.accepted) return
    restoreRetryUi()
    partialStatus.textContent = result.code === 'not-retryable-target'
      ? t('document.progress.completed')
      : t('document.run.failedCode', { code: result.code ?? 'retry-failed' })
    partialStatus.hidden = false
  } catch {
    restoreRetryUi()
    partialStatus.textContent = t('document.run.failed')
    partialStatus.hidden = false
  }
}

/**
 * 强制重新翻译当前文档中的指定译文目标，绕过缓存并在失败时保留旧译文。
 * @param targetId 当前快照中的稳定目标标识。
 * @returns 重译请求完成后的 Promise。
 * @author zhenghq
 */
async function retranslateDocumentTarget(targetId: string): Promise<void> {
  const tab = getActiveDocumentTab()
  const snapshot = tab?.snapshot
  if (!tab || !snapshot?.translation || !snapshot.source) return
  if (isReadOnlyDocumentTab(tab)) return
  if (!findDocumentTarget(snapshot.source, targetId)) return
  const previousGeneration = tab.generation
  const previousStatus = tab.status
  let jobGeneration = nextGeneration()
  tab.generation = jobGeneration
  tab.status = 'running'
  refreshActiveTabMirror(tab)
  retryButton.disabled = true
  rerunButton.disabled = true
  exportButton.disabled = true
  cancelButton.hidden = false
  partialStatus.hidden = false
  partialStatus.textContent = t('document.rerunStarted')
  progressStage.textContent = t('document.progress.translating')
  progressCount.textContent = t('document.progress.pending')
  const restoreRetranslateUi = (): void => {
    if (!documentTabs.includes(tab) || tab.generation !== jobGeneration) return
    tab.generation = previousGeneration
    tab.status = previousStatus
    refreshActiveTabMirror(tab)
    cancelButton.hidden = true
    exportButton.disabled = !hasUsableExportResult(snapshot)
    renderTaskState(snapshot, tab)
    renderDocumentTabs()
  }
  try {
    let result = await window.api.retranslateDocumentTarget(
      snapshot.jobId,
      jobGeneration,
      targetId
    )
    if (!result.accepted && result.code === 'generation-conflict' &&
      adoptSuggestedGeneration(result.suggestedGeneration)) {
      jobGeneration = generation
      tab.generation = jobGeneration
      refreshActiveTabMirror(tab)
      result = await window.api.retranslateDocumentTarget(
        snapshot.jobId,
        jobGeneration,
        targetId
      )
    }
    if (!documentTabs.includes(tab) || tab.generation !== jobGeneration) return
    if (result.accepted) return
    restoreRetranslateUi()
    partialStatus.textContent = t('document.run.failedCode', { code: result.code ?? 'retranslate-failed' })
    partialStatus.hidden = false
  } catch {
    restoreRetranslateUi()
    partialStatus.textContent = t('document.run.failed')
    partialStatus.hidden = false
  }
}

/**
 * 判断模型是否包含至少一个带识别原文的图片区块。
 * @param model 文档模型。
 * @returns 是否存在可切换的 OCR 原文。
 * @author zhenghq
 */
function hasOcrSourceText(model: DocumentModel | undefined): boolean {
  if (!model) return false
  // 图片可能嵌套在表格单元格内，必须递归检查整棵区块树，不能只遍历页面顶层区块。
  const hasVisibleOcrText = (block: DocumentBlock): boolean => {
    if (block.kind === 'image') {
      return (block.ocrRegions ?? []).some((region) => Boolean(region.text?.trim()))
    }
    if (block.kind === 'table') {
      return block.rows.some((row) => row.cells.some((cell) => cell.blocks.some(hasVisibleOcrText)))
    }
    return false
  }
  return model.pages.some((page) => page.blocks.some(hasVisibleOcrText))
}

/**
 * 根据原文栏 OCR 展示方式更新分段控件的选中态。
 * @returns 无返回值。
 * @author zhenghq
 */
function syncOcrDisplayModeControls(): void {
  for (const button of Array.from(sourceOcrMode.querySelectorAll<HTMLButtonElement>('[data-ocr-mode]'))) {
    button.setAttribute('aria-pressed', String(button.dataset.ocrMode === ocrDisplayMode))
  }
}

/**
 * 根据当前预览方式同步顶栏开关选中态和工作台布局标记。
 * @returns 无返回值。
 * @author zhenghq
 */
function syncDocumentViewModeControls(): void {
  documentColumns.dataset.viewMode = documentViewMode
  for (const button of documentViewModeControl.querySelectorAll<HTMLButtonElement>('[data-document-view-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.documentViewMode === documentViewMode))
  }
}

/**
 * 根据当前开关状态同步滚动同步控件的无障碍状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function syncDocumentScrollSyncControl(): void {
  documentSyncScrollButton.setAttribute('aria-checked', String(documentScrollSyncEnabled))
  documentSyncScrollButton.dataset.enabled = String(documentScrollSyncEnabled)
}

/**
 * 设置双栏滚动同步开关；重新开启时允许任一侧重新成为主动栏。
 * @param enabled 是否启用同步。
 * @returns 无返回值。
 * @author zhenghq
 */
function setDocumentScrollSync(enabled: boolean): void {
  documentScrollSyncEnabled = enabled
  documentScrollSyncedSide = null
  const tab = getActiveDocumentTab()
  if (tab) tab.scrollSyncEnabled = enabled
  syncDocumentScrollSyncControl()
}

/**
 * 设置文档缩放比例并刷新百分比显示。
 * @param nextZoom 用户选择的比例，最终限制在 50% 到 200%。
 * @returns 无返回值。
 * @author zhenghq
 */
function setDocumentZoom(nextZoom: number): void {
  const normalized = clampDocumentZoom(nextZoom)
  if (Math.abs(normalized - documentZoom) < 0.001) return
  applyDocumentZoom(normalized)
  const tab = getActiveDocumentTab()
  if (tab) tab.zoom = normalized
  scheduleDocumentViewerStatePersist()
}

/**
 * 应用适合宽度或适合高度的精确缩放比例。
 * 适配结果允许超出手动缩放的 50% 到 200% 范围，以确保页面真正铺满容器。
 * @param nextZoom 已按页面与容器尺寸计算出的适配比例。
 * @returns 无返回值。
 * @author zhenghq
 */
function setDocumentFitZoom(nextZoom: number): void {
  const normalized = Number.isFinite(nextZoom) && nextZoom > 0 ? nextZoom : 1
  applyDocumentZoom(normalized)
  const tab = getActiveDocumentTab()
  if (tab) tab.zoom = normalized
  scheduleDocumentViewerStatePersist()
}

/**
 * 按固定步长调整文档缩放，并保持 50% 到 200% 的边界。
 * @param delta 相对当前缩放比例的增量。
 * @returns 无返回值。
 * @author zhenghq
 */
function stepDocumentZoom(delta: number): void {
  setDocumentZoom(Math.round((documentZoom + delta) * 10) / 10)
}

/**
 * 切换原文与译文双面显示或仅译文单面显示；不中断正在执行的翻译任务。
 * @param nextMode 用户选择的预览方式。
 * @returns 无返回值。
 * @author zhenghq
 */
function setDocumentViewMode(nextMode: DocumentViewMode): void {
  if (documentViewMode === nextMode) return
  documentBlockActions.close()
  const layoutTabId = activeDocumentTabId
  const tab = getActiveDocumentTab()
  if (tab) tab.viewMode = nextMode
  documentViewMode = nextMode
  persistDocumentViewMode(documentViewMode)
  syncDocumentViewModeControls()
  scheduleDocumentViewerStatePersist()
  // 单面切换后译文栏宽度改变，只为已渲染的 PDF 页面重新计算缩放。
  const hasPdfPages = Boolean(translationContent.querySelector(".document-page[data-layout='translation-flow']"))
  if (nextMode === 'translation' && hasPdfPages) {
    requestAnimationFrame(() => {
      // 延迟布局属于发起切换的 Tab；用户快速切换文件后不得重排并恢复新 Tab 的滚动位置。
      if (layoutTabId === null || layoutTabId !== activeDocumentTabId) return
      scheduleTranslationPageLayout(true)
    })
  }
  scheduleDocumentViewerStatePersist()
  // 单面/双面切换不会重绘正文，但会隐藏或显示译文栏，检索高亮需要按新布局重算。
  documentSearch.refresh()
}

/**
 * 根据当前快照决定原文栏 OCR 切换控件是否可见。
 * 仅当源模型存在带识别原文的图片时显示控件，避免普通文档出现无意义的分段开关。
 * 准备中的快照可能尚未包含源模型，此时回退到快照所属 Tab 已识别的文件格式，避免控件闪烁隐藏。
 * @param snapshot 当前任务快照。
 * @param tab 快照所属的文档 Tab。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderOcrDisplayModeControls(
  snapshot: DocumentWorkspaceSnapshot,
  tab: DocumentWorkspaceTab
): void {
  // PDF 扫描件可能整体被判定为低置信度或暂无译文；只要 OCR 任务已尝试，就保留顶部切换入口。
  const format = snapshot.source?.source.format ?? tab.selection.format
  sourceOcrMode.hidden = !(format === 'pdf' || format === 'image' || hasOcrSourceText(snapshot.source))
}

/**
 * 根据窗口最大化状态更新标题栏按钮。
 * @param maximized 当前窗口是否已最大化。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderWindowMaximizedState(maximized: boolean): void {
  const label = maximized ? t('document.restoreWindow') : t('document.maximizeWindow')
  windowMaximizeButton.ariaLabel = label
  windowMaximizeButton.title = label
  windowMaximizeButton.dataset.maximized = String(maximized)
  windowMaximizeButton.innerHTML = maximized
    ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 5h7v7H5z" /><path d="M3 11V3h8" /></svg>'
    : '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" /></svg>'
}

/**
 * 初始化自绘标题栏窗口控制。
 * @returns 无返回值。
 * @author zhenghq
 */
async function initializeWindowTitlebar(): Promise<void> {
  windowMinimizeButton.addEventListener('click', () => window.api.windowMinimize())
  windowMaximizeButton.addEventListener('click', () => window.api.windowToggleMaximize())
  windowCloseButton.addEventListener('click', () => window.api.windowClose())
  titlebar.addEventListener('dblclick', (event) => {
    if ((event.target as HTMLElement).closest('.window-controls')) return
    window.api.windowToggleMaximize()
  })
  window.api.onWindowMaximizedChanged(renderWindowMaximizedState)
  renderWindowMaximizedState(await window.api.windowIsMaximized())
}

/**
 * 根据平台能力禁用文档入口并显示原因。
 * @returns 无返回值。
 * @author zhenghq
 */
async function initializePlatformCapability(): Promise<void> {
  try {
    platformCapability = await window.api.getDocumentPlatformCapability()
  } catch {
    platformCapability = { supported: false, reason: 'unsupported-platform' }
  }
  dropZone.tabIndex = platformCapability.supported ? 0 : -1
  dropZone.setAttribute('aria-disabled', String(!platformCapability.supported))
  historyButton.disabled = !platformCapability.supported
  renderSelectionState()
}

/**
 * 初始化顶部设置菜单，同一时间只展开一个菜单，并支持点击空白处或按 Esc 关闭。
 * @returns 无返回值。
 * @author zhenghq
 */
function initializeDocumentToolbarMenus(): void {
  const menus = Array.from(document.querySelectorAll<HTMLDetailsElement>('.document-toolbar-menu'))
  if (menus.length === 0) return

  for (const menu of menus) {
    menu.addEventListener('toggle', () => {
      if (!menu.open) return
      for (const otherMenu of menus) {
        if (otherMenu !== menu) otherMenu.open = false
      }
    })
  }

  document.addEventListener('pointerdown', (event) => {
    const target = event.target
    if (!(target instanceof Node)) return
    if (menus.some((menu) => menu.contains(target))) return
    for (const menu of menus) menu.open = false
  })

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    const openMenu = menus.find((menu) => menu.open)
    if (!openMenu) return
    openMenu.open = false
    openMenu.querySelector<HTMLElement>('summary')?.focus()
  })
}

/**
 * 初始化上传交互、拖放、键盘操作与窗口控制。
 * @returns 无返回值。
 * @author zhenghq
 */
async function initializeDocumentWorkspace(): Promise<void> {
  exposeDocumentPrintPreview()
  await initializeWindowTitlebar()
  await initializePlatformCapability()
  await initializeDocumentLanguages()
  initializeDocumentToolbarMenus()
  await restoreDocumentViewerState()
  await documentHistory.loadTaskHistory()
  documentFileTabsPreviousButton.addEventListener('click', () => scrollDocumentTabs(-1))
  documentFileTabsNextButton.addEventListener('click', () => scrollDocumentTabs(1))
  documentWorkspaceTabs.addEventListener('scroll', updateDocumentTabScrollButtons)
  window.addEventListener('resize', updateDocumentTabScrollButtons)
  updateDocumentTabScrollButtons()

  dropZone.addEventListener('click', () => void chooseDocumentFiles())
  dropZone.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    void chooseDocumentFiles()
  })
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    dropZone.dataset.dragging = 'true'
  })
  dropZone.addEventListener('dragleave', (event) => {
    if (event.relatedTarget && dropZone.contains(event.relatedTarget as Node)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) dropZone.dataset.dragging = 'false'
  })
  dropZone.addEventListener('dragenter', (event) => {
    event.preventDefault()
    dragDepth += 1
    dropZone.dataset.dragging = 'true'
  })
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault()
    dragDepth = 0
    dropZone.dataset.dragging = 'false'
    void inspectBrowserFiles(Array.from(event.dataTransfer?.files ?? []))
  })
  documentFileInput.addEventListener('change', (event) => {
    const input = event.currentTarget as HTMLInputElement
    void inspectBrowserFiles(Array.from(input.files ?? []))
    input.value = ''
  })
  fileReplaceButton.addEventListener('click', () => documentFileInput.click())
  documentWorkbenchReplaceButton.addEventListener('click', () => void addDocumentFilesFromWorkbench())
  startButton.addEventListener('click', () => void startDocumentTranslation())
  cancelButton.addEventListener('click', () => void cancelDocumentTranslation())
  documentExport.bindEvents()
  documentManualEdit.bindEvents()
  documentBlockActions.bindEvents()
  documentSearch.bindEvents()
  retryButton.addEventListener('click', () => void retryFailedDocumentTranslation())
  rerunButton.addEventListener('click', () => void rerunDocumentTranslation())
  editUndoButton.addEventListener('click', () => {
    documentManualEdit.undo()
    refreshDocumentEditHistoryButtons()
  })
  editRedoButton.addEventListener('click', () => {
    documentManualEdit.redo()
    refreshDocumentEditHistoryButtons()
  })
  partialExportRetryButton.addEventListener('click', () => {
    closePartialExportDialog(false)
    void retryFailedDocumentTranslation()
  })
  partialExportConfirmButton.addEventListener('click', () => closePartialExportDialog(true))
  partialExportCancelButton.addEventListener('click', () => closePartialExportDialog(false))
  partialExportDialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    closePartialExportDialog(false)
  })
  partialExportDialog.addEventListener('close', () => {
    // 点击遮罩等原生关闭路径不会经过按钮；统一按取消处理，避免导出 Promise 悬挂。
    if (resolvePartialExportConfirmation) closePartialExportDialog(false)
  })
  sourceLanguageSelect.addEventListener('change', () => void retranslateDocumentAfterLanguageChange())
  targetLanguageSelect.addEventListener('change', () => void retranslateDocumentAfterLanguageChange())
  for (const button of Array.from(sourceOcrMode.querySelectorAll<HTMLButtonElement>('[data-ocr-mode]'))) {
    button.addEventListener('click', async () => {
      const nextMode = button.dataset.ocrMode === 'ocr-text' ? 'ocr-text' : 'translation'
      const tab = getActiveDocumentTab()
      if (!tab || tab.ocrDisplayMode === nextMode) return
      // 历史任务没有活动主进程任务，只允许切换本地展示，不得取消或重启旧任务。
      if (isReadOnlyDocumentTab(tab)) {
        tab.ocrDisplayMode = nextMode
        ocrDisplayMode = nextMode
        syncOcrDisplayModeControls()
        renderActiveDocumentTab(tab)
        return
      }
      tab.ocrDisplayMode = nextMode
      ocrDisplayMode = nextMode
      syncOcrDisplayModeControls()
      // 本地展示立即切换；主进程只在旧任务终态后复用已解析源模型，不再取消或整篇重跑。
      tab.pendingOcrModeTarget = nextMode
      if (tab.id === activeDocumentTabId) refreshActiveTabMirror(tab)
      renderDocumentTabs()
      if (!(tab.activeJobId ?? tab.expectedJobId)) {
        // 尚未创建任务的文件没有可复用源模型，按目标模式正常启动首次任务。
        tab.pendingOcrModeTarget = null
        if (tab.id === activeDocumentTabId) refreshActiveTabMirror(tab)
        await startDocumentTabTranslation(tab)
        return
      }
      void maybeSwitchDocumentOcrMode(tab)
    })
  }
  syncOcrDisplayModeControls()
  for (const button of Array.from(documentViewModeControl.querySelectorAll<HTMLButtonElement>('[data-document-view-mode]'))) {
    button.addEventListener('click', () => {
      const mode = button.dataset.documentViewMode
      const nextMode: DocumentViewMode =
        mode === 'source' || mode === 'translation' || mode === 'spread'
          ? mode
          : 'spread'
      setDocumentViewMode(nextMode)
    })
  }
  syncDocumentViewModeControls()
  syncDocumentScrollSyncControl()
  applyDocumentZoom(documentZoom)
  documentNavigation.bindEvents()
  documentSyncScrollButton.addEventListener('click', () => {
    setDocumentScrollSync(!documentScrollSyncEnabled)
  })
  documentHistory.initialize()
  // 订阅任务进度前先同步当前 OCR 展示模式，确保启动期间切换模式时旧事件不会污染新状态。
  syncOcrDisplayModeControls()
  window.api.onDocumentProgress((snapshot) => { routeDocumentSnapshot(snapshot, false) })
  window.api.onDocumentExportProgress((progress) => {
    documentExport.updateProgress(progress)
  })
  window.api.onDocumentBlockTranslated((update: DocumentWorkspaceTranslationUpdate) => {
    const tab = findDocumentTabByTranslationUpdate(update)
    if (!tab) return
    if (tab.pendingModeSwitchGeneration === update.generation) {
      // 模式切换确认前的新代际增量先并入缓冲快照，避免污染旧代际模型。
      const buffered = tab.pendingModeSwitchSnapshot
      if (!buffered || buffered.jobId !== update.jobId || buffered.generation !== update.generation) return
      const nextBuffered = applyDocumentWorkspaceTranslationUpdate(buffered, update)
      if (nextBuffered !== buffered) tab.pendingModeSwitchSnapshot = nextBuffered
      return
    }
    const snapshot = tab.snapshot
    if (!snapshot || snapshot.jobId !== update.jobId || snapshot.generation !== update.generation) return
    const next = applyDocumentWorkspaceTranslationUpdate(snapshot, update)
    if (next === snapshot) return
    const applied = updateDocumentTabSnapshot(tab, next)
    if (tab.id !== activeDocumentTabId) return
    refreshActiveTabMirror(tab)
    scheduleSnapshotRenderForTab(tab, applied)
    scheduleDocumentViewerStatePersist()
  })
  // 重试按钮会随增量重绘被替换，使用文档级事件委托保证始终响应最新按钮。
  document.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest<HTMLButtonElement>('[data-retry-target-id]')
    if (!button) return
    event.preventDefault()
    const targetId = button.dataset.retryTargetId
    if (targetId) void retryFailedDocumentTarget(targetId)
  })
  window.api.onDocumentCompleted((snapshot) => {
    routeDocumentSnapshot(snapshot, true)
  })
  /**
   * 标记双栏内的真实滚动输入；滚动事件本身无法区分用户操作和布局引起的位移。
   * @param side 当前操作的栏。
   * @returns 无返回值。
   * @author zhenghq
   */
  const registerUserScrollIntent = (side: DocumentScrollSide): void => {
    markUserScrollIntent(side)
  }
  sourceContent.addEventListener('wheel', () => registerUserScrollIntent('source'), { passive: true })
  translationContent.addEventListener('wheel', () => registerUserScrollIntent('translation'), { passive: true })
  sourceContent.addEventListener('touchstart', () => registerUserScrollIntent('source'), { passive: true })
  translationContent.addEventListener('touchstart', () => registerUserScrollIntent('translation'), { passive: true })
  sourceContent.addEventListener('keydown', () => registerUserScrollIntent('source'))
  translationContent.addEventListener('keydown', () => registerUserScrollIntent('translation'))
  sourceContent.addEventListener('scroll', () => {
    handleDocumentScroll('source')
    scheduleDocumentViewerStatePersist()
  })
  translationContent.addEventListener('scroll', () => {
    handleDocumentScroll('translation')
    scheduleDocumentViewerStatePersist()
  })
  window.addEventListener('beforeunload', () => {
    persistActiveDocumentViewerState()
    revokeAssetUrls()
    releaseHtmlPreviewUrl()
  })
  documentHistory.bindEvents()
  localeRuntime.onLocaleChanged(() => {
    renderSelectionState()
    documentHistory.render()
    if (currentSettings) {
      populateDocumentLanguages(currentSettings, sourceLanguageSelect.value, targetLanguageSelect.value)
    }
    renderWindowMaximizedState(windowMaximizeButton.dataset.maximized === 'true')
    const tab = getActiveDocumentTab()
    if (latestSnapshot && tab?.snapshot === latestSnapshot) {
      renderedSourcePreviewIdentity = ''
      renderedSourceWarningSignature = ''
      renderedTranslationSignature = ''
      renderedTranslationPreviewKind = null
      hasRenderedTranslation = false
      renderedTranslationWarningSignature = ''
      renderSnapshot(latestSnapshot, tab)
      renderTaskState(latestSnapshot, tab)
    }
  })
}

void initializeDocumentWorkspace()
