import {
  DOCUMENT_MAX_FILE_BYTES,
  DOCUMENT_ZIP_TAIL_BYTES,
  getDocumentZipCentralDirectoryRange,
  validateDocumentFile
} from '../../shared/documentFormat'
import type {
  DocumentBlock,
  DocumentBoundingBox,
  DocumentContentArea,
  DocumentAsset,
  DocumentFormulaBlock,
  DocumentImageBlock,
  DocumentModel,
  DocumentOcrRegion,
  DocumentPage,
  DocumentTableBlock,
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
  resolveDocumentOcrSourceWidthRatio,
  resolveDocumentOcrTranslationHorizontalBounds,
  resolveOcrRegionFontSize,
  resolveOcrRegionGapBefore,
  resolveOcrRegionLineHeight,
  resolveOcrRegionPadding,
  type DocumentOcrFlowRect
} from '../../shared/documentOcrLayout'
import type {
  DocumentAssetResult,
  DocumentExportProgress,
  DocumentExportRequest,
  DocumentExportResult,
  DocumentFileSelectionResult,
  DocumentPlatformCapability,
  DocumentRunResult,
  DocumentSourceResult,
  DocumentWorkspaceSnapshot,
  DocumentWorkspaceTranslationUpdate
} from '../../shared/types'
import type { DocumentPartialExportSummary } from '../../shared/documentPartialExport'
import type { DocumentHistoryEntry, Settings } from '../../shared/types'
import { LANGUAGES, langLabel } from '../../shared/langs'
import { TRANSLATION_WATERMARK_LOGO_PATH } from '../../shared/translationWatermark'
import { canApplyDocumentTaskEvent } from '../../shared/documentTask'
import { applyDocumentWorkspaceTranslationUpdate } from '../../shared/documentWorkspace'
import { findDocumentTarget } from '../../shared/documentTargetLocator'
import {
  countVisibleDocumentWarnings,
  filterVisibleDocumentWarnings
} from '../../shared/documentWarnings'
import {
  resolveDocumentRetryActionState
} from '../../shared/documentCompletion'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.js?url'
import { startThemeRuntime } from './theme'
import { startLocaleRuntime } from './locale'
import {
  DOCUMENT_FILE_HISTORY_STORAGE_KEY,
  filterDocumentFileHistory,
  filterDocumentTaskHistory,
  mergeDocumentHistoryEntries,
  normalizeDocumentFileHistory,
  recordDocumentFileHistory,
  type DocumentFileHistoryEntry,
  type DocumentHistoryListItem
} from './documentHistory'
import {
  occupiesDocumentTranslationFlow,
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
  clampDocumentZoom,
  createRestoredDocumentWorkspaceSnapshot,
  DOCUMENT_VIEWER_STATE_STORAGE_KEY,
  DOCUMENT_VIEWER_STATE_VERSION,
  parseDocumentViewerState,
  parseDocumentPageNumber,
  resolveDocumentBlockHighlight,
  resolveDocumentPageJump,
  resolveDocumentTocTarget,
  resolveFitDocumentZoom,
  serializeDocumentViewerState,
  validateRestoredDocumentViewerFile,
  type DocumentViewerFileState,
  type DocumentViewerMode,
  type DocumentViewerState,
  type DocumentViewerTabState,
  type DocumentNavigationTarget
} from './documentViewer'

startThemeRuntime(window.api)
const localeRuntime = startLocaleRuntime(window.api)
pdfjsModule.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

/** 从本地缓存恢复的工作台固定任务身份。 */
const RESTORED_DOCUMENT_JOB_ID = 'restored-viewer-state'

/** 任务代际在 Renderer 重载后继续递增，避免主进程拒绝复用旧值。 */
const DOCUMENT_GENERATION_STORAGE_KEY = 'selection-translator.document-generation'
/** 文档预览方式在窗口重载后保留；损坏或未知值回退为双面显示。 */
const DOCUMENT_VIEW_MODE_STORAGE_KEY = 'selection-translator.document-view-mode'

/** 文档双栏的渲染侧；译文栏与 OCR 原文展示层分别在各自侧渲染。 */
type DocumentRenderSide = 'source' | 'translation'

/** 文档双栏滚动位置快照，用于流式重排后恢复用户视口。 */
interface DocumentScrollPositions {
  /** 原文栏当前滚动位置。 */
  source: number
  /** 译文栏当前滚动位置。 */
  translation: number
}

/** 文档预览按格式采用的渲染方式；HTML 原文使用独立 webview，译文仍采用流式布局。 */
type DocumentPreviewKind = 'paged' | 'markdown' | 'table' | 'subtitle' | 'flow' | 'html-source'

/** 文档工作台预览方式；双面保留原文与译文对照，单面只显示原文或译文。 */
type DocumentViewMode = 'source' | 'translation' | 'spread'

/** 目录中的一个可跳转章节项。 */
interface DocumentTocEntry {
  /** 面向用户的章节标题。 */
  title: string
  /** 跳转目标页面与可选区块。 */
  target: DocumentNavigationTarget
}

/** 文档工作台当前上传状态。 */
interface DocumentSelectionState {
  /** 已通过校验的本地文件绝对路径；未选择时为 null。 */
  path: string | null
  /** 用于界面展示的文件名。 */
  name: string
  /** 文件字节数。 */
  size: number
  /** 已识别格式；未选择时为空。 */
  format: string
  /** 文件内容 SHA-256 指纹，用于恢复时确认译文仍对应当前文件。 */
  sha256: string
  /** 当前应展示的错误分类；无错误时为 null。 */
  error: string | null
}

/** 单个文件 Tab 的任务状态；只用于顶栏状态点，不参与任务协议。 */
type DocumentTabStatus = 'idle' | 'starting' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'

/** 文档工作台中的独立文件 Tab；每个 Tab 拥有自己的任务、快照与交互状态。 */
interface DocumentWorkspaceTab {
  /** 当前窗口内稳定的 Tab 标识。 */
  id: string
  /** Tab 的来源；历史任务为只读回放，不得取消或释放原任务。 */
  sourceKind: 'task' | 'restored' | 'history'
  /** 已通过主进程批准的文件元数据。 */
  selection: DocumentSelectionState
  /** 最近一次属于该 Tab 的任务快照。 */
  snapshot: DocumentWorkspaceSnapshot | null
  /** 已确认的主进程任务标识。 */
  activeJobId: string | null
  /** 启动请求返回前由首条进度事件推导出的任务标识。 */
  expectedJobId: string | null
  /** 最近一次为该 Tab 申请的任务代际。 */
  generation: number
  /** runDocument 请求是否尚未返回。 */
  startInFlight: boolean
  /** 当前任务的界面状态。 */
  status: DocumentTabStatus
  /** 原文栏和译文栏的滚动位置。 */
  scrollPositions: DocumentScrollPositions
  /** 该 Tab 自己的用户缩放比例。 */
  zoom: number
  /** 该 Tab 自己的原文、译文或双栏显示模式。 */
  viewMode: DocumentViewerMode
  /** 该 Tab 当前阅读页，从 1 开始。 */
  pageNumber: number
  /** 该 Tab 的双栏滚动同步开关。 */
  scrollSyncEnabled: boolean
  /** 该 Tab 提交给任务的源语言。 */
  sourceLang: string
  /** 该 Tab 提交给任务的目标语言。 */
  targetLang: string
  /** 图片 OCR 原文与译文的展示方式。 */
  ocrDisplayMode: 'ocr-text' | 'translation'
  /** 该 Tab 当前高亮的稳定区块标识。 */
  activeBlockId: string | null
  /** 启动完成后仍需按最新语言重译。 */
  pendingLanguageRetranslation: boolean
  /** 启动完成后仍需按最新 OCR 模式重启。 */
  pendingOcrModeRestart: boolean
  /** 当前 Tab 的语言切换序号，用于丢弃过期重译请求。 */
  languageRevision: number
  /** 只读历史/恢复 Tab 的源文件是否已重新授权且通过快照校验。 */
  sourceAuthorized: boolean
}

/** 初始空选择状态。 */
const EMPTY_SELECTION: DocumentSelectionState = {
  path: null,
  name: '',
  size: 0,
  format: '',
  sha256: '',
  error: null
}

const dropZone = document.getElementById('document-drop-zone') as HTMLElement
const documentFileInput = document.getElementById('document-file-input') as HTMLInputElement
const fileSummary = document.getElementById('document-file-summary') as HTMLElement
const fileName = document.getElementById('document-file-name') as HTMLElement
const fileDetail = document.getElementById('document-file-detail') as HTMLElement
const fileReplaceButton = document.getElementById('document-file-replace') as HTMLButtonElement
const uploadStatus = document.getElementById('document-upload-status') as HTMLElement
const startButton = document.getElementById('document-start-button') as HTMLButtonElement
const historyButton = document.getElementById('document-history-button') as HTMLButtonElement
const historyPopover = document.getElementById('document-history-popover') as HTMLElement
const documentHistorySearch = document.getElementById('document-history-search') as HTMLInputElement
const documentHistoryList = document.getElementById('document-history-list') as HTMLUListElement
const documentHistoryEmpty = document.getElementById('document-history-empty') as HTMLElement
const documentHistoryStatus = document.getElementById('document-history-status') as HTMLElement
const documentHistoryClearButton = document.getElementById('document-history-clear') as HTMLButtonElement
const documentHistoryConfirmDialog = document.getElementById('document-history-confirm-dialog') as HTMLDialogElement
const documentHistoryConfirmTitle = document.getElementById('document-history-confirm-title') as HTMLElement
const documentHistoryConfirmDescription = document.getElementById('document-history-confirm-description') as HTMLElement
const documentHistoryConfirmCancel = document.getElementById('document-history-confirm-cancel') as HTMLButtonElement
const documentHistoryConfirmDelete = document.getElementById('document-history-confirm-delete') as HTMLButtonElement
const sourceLanguageSelect = document.getElementById('document-source-lang') as HTMLSelectElement
const targetLanguageSelect = document.getElementById('document-target-lang') as HTMLSelectElement
const actualLanguage = document.getElementById('document-actual-language') as HTMLElement
const uploadPanel = document.getElementById('document-upload-panel') as HTMLElement
const workbench = document.getElementById('document-workbench') as HTMLElement
const documentWorkspaceTabs = document.getElementById('document-file-tabs') as HTMLElement
const workbenchName = document.getElementById('document-workbench-name') as HTMLElement
const workbenchMeta = document.getElementById('document-workbench-meta') as HTMLElement
const progressStage = document.getElementById('document-progress-stage') as HTMLElement
const progressCount = document.getElementById('document-progress-count') as HTMLElement
const progressPages = document.getElementById('document-progress-pages') as HTMLElement
const progressBlocks = document.getElementById('document-progress-blocks') as HTMLElement
const progressWarnings = document.getElementById('document-progress-warnings') as HTMLElement
const progressRemaining = document.getElementById('document-progress-remaining') as HTMLElement
const progressbar = document.getElementById('document-progressbar') as HTMLElement
const sourceContent = document.getElementById('document-source-content') as HTMLElement
const sourceOcrMode = document.getElementById('document-source-ocr-mode') as HTMLElement
const documentViewModeControl = document.getElementById('document-view-mode') as HTMLElement
const documentSyncScrollButton = document.getElementById('document-sync-scroll') as HTMLButtonElement
const documentPageInput = document.getElementById('document-page-input') as HTMLInputElement
const documentPagePreviousButton = document.getElementById('document-page-previous') as HTMLButtonElement
const documentPageNextButton = document.getElementById('document-page-next') as HTMLButtonElement
const documentTocButton = document.getElementById('document-toc-button') as HTMLButtonElement
const documentTocList = document.getElementById('document-toc-list') as HTMLElement
const documentZoomOutButton = document.getElementById('document-zoom-out') as HTMLButtonElement
const documentZoomValue = document.getElementById('document-zoom-value') as HTMLElement
const documentZoomInButton = document.getElementById('document-zoom-in') as HTMLButtonElement
const documentZoomResetButton = document.getElementById('document-zoom-reset') as HTMLButtonElement
const documentZoomFitButton = document.getElementById('document-zoom-fit') as HTMLButtonElement
const documentColumns = document.querySelector<HTMLElement>('.document-columns') as HTMLElement
const translationContent = document.getElementById('document-translation-content') as HTMLElement
const translationHeading = document.getElementById('document-translation-heading') as HTMLElement
const sourcePageCount = document.getElementById('document-source-page-count') as HTMLElement
const translationPageCount = document.getElementById('document-translation-page-count') as HTMLElement
const cancelButton = document.getElementById('document-cancel-button') as HTMLButtonElement
const exportButton = document.getElementById('document-export-button') as HTMLButtonElement
const retryButton = document.getElementById('document-retry-button') as HTMLButtonElement
const documentWorkbenchReplaceButton = document.getElementById('document-workbench-replace') as HTMLButtonElement
const partialStatus = document.getElementById('document-partial-status') as HTMLElement
const exportDialog = document.getElementById('document-export-dialog') as HTMLDialogElement
const exportLayoutTranslation = document.getElementById('document-export-layout-translation') as HTMLInputElement
const exportLayoutBilingual = document.getElementById('document-export-layout-bilingual') as HTMLInputElement
const exportIncomplete = document.getElementById('document-export-incomplete') as HTMLElement
const exportWarningCount = document.getElementById('document-export-warning-count') as HTMLElement
const exportIncompleteNotice = document.getElementById('document-export-incomplete-notice') as HTMLElement
const exportRetryButton = document.getElementById('document-export-retry') as HTMLButtonElement
const exportConfirmButton = document.getElementById('document-export-confirm') as HTMLButtonElement
const exportCancelButton = document.getElementById('document-export-cancel') as HTMLButtonElement
const exportProgress = document.getElementById('document-export-progress') as HTMLElement
const exportProgressStage = document.getElementById('document-export-progress-stage') as HTMLElement
const exportProgressPage = document.getElementById('document-export-progress-page') as HTMLElement
const exportProgressPercent = document.getElementById('document-export-progress-percent') as HTMLElement
const exportProgressTrack = exportProgress.querySelector<HTMLElement>('[role="progressbar"]') as HTMLElement
const exportProgressbar = document.getElementById('document-export-progressbar') as HTMLElement
const exportOpenFolderButton = document.getElementById('document-export-open-folder') as HTMLButtonElement
const partialExportDialog = document.getElementById('document-partial-export-dialog') as HTMLDialogElement
const partialExportSummary = document.getElementById('document-partial-export-summary') as HTMLElement
const partialExportRetryButton = document.getElementById('document-partial-export-retry') as HTMLButtonElement
const partialExportConfirmButton = document.getElementById('document-partial-export-confirm') as HTMLButtonElement
const partialExportCancelButton = document.getElementById('document-partial-export-cancel') as HTMLButtonElement
const titlebar = document.getElementById('document-titlebar') as HTMLElement
const windowMinimizeButton = document.getElementById('window-minimize') as HTMLButtonElement
const windowMaximizeButton = document.getElementById('window-maximize') as HTMLButtonElement
const windowCloseButton = document.getElementById('window-close') as HTMLButtonElement

let selectionState: DocumentSelectionState = { ...EMPTY_SELECTION }
/** 当前本地文件翻译历史；按最近选择时间倒序排列。 */
let documentFileHistory: DocumentFileHistoryEntry[] = []
/** 当前搜索条件下实际展示的历史记录，用于把列表项索引映射回完整记录。 */
let visibleDocumentFileHistory: DocumentFileHistoryEntry[] = []
/** 主进程持久化的文档任务历史摘要。 */
let documentTaskHistory: DocumentHistoryEntry[] = []
/** 当前搜索条件下实际展示的任务历史，用于把列表项索引映射回完整记录。 */
let visibleDocumentTaskHistory: DocumentHistoryEntry[] = []
/** 当前搜索条件下合并展示的任务与文件历史，用于统一键盘和指针导航。 */
let visibleDocumentHistory: DocumentHistoryListItem[] = []
let platformCapability: DocumentPlatformCapability | null = null
let dragDepth = 0
/** 导出对话框当前对应的任务身份；为空表示尚未打开或已结束。 */
let documentExportTarget: { jobId: string; generation: number } | null = null
/** 导出对话框当前布局；用户切换单选后立即同步。 */
let selectedDocumentExportLayout: 'translation' | 'bilingual' = 'translation'
/** 当前是否正在等待 PDF 导出结束。 */
let documentExportInFlight = false
/** 当前导出是否已成功保存，用于显示打开目录入口。 */
let documentExportSaved = false
/** 当前导出进度百分比，避免迟到事件造成回退。 */
let documentExportPercent = 0
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
/** 当前活动 Tab 是否等待启动请求结束后按最新 OCR 模式重启。 */
let pendingOcrModeRestart = false
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
/** 下一个 Tab 序号，用于生成稳定且不重复的标识。 */
let nextDocumentTabSequence = 1
/** 是否正在执行历史文件切换，阻止快速重复点击创建并发切换。 */
let documentHistorySwitchInFlight = false
/** 当前等待用户确认的历史操作；null 表示没有待确认操作。 */
let pendingDocumentHistoryAction:
  | { kind: 'delete'; entry: DocumentHistoryEntry }
  | { kind: 'clear' }
  | null = null
/** 历史确认对话框关闭后应恢复焦点的触发按钮。 */
let documentHistoryFocusTarget: HTMLElement | null = null

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
 * 把文件字节数格式化为便于阅读的大小。
 * @param bytes 文件字节数。
 * @returns 带单位的大小文本。
 * @author zhenghq
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
 * 恢复前必须由主进程重新授权文件，并校验格式、大小与 SHA-256；任何不一致都丢弃缓存。
 * @returns 恢复完成后的 Promise；没有缓存或校验失败时保持上传态。
 * @author zhenghq
 */
async function restoreDocumentViewerState(): Promise<void> {
  const state = readDocumentViewerState()
  if (state.tabs.length === 0 || !platformCapability?.supported) return
  const restoredTabs: DocumentWorkspaceTab[] = []
  let restoredActiveTabId: string | null = null
  for (const savedTab of state.tabs) {
    try {
      const authorized = await window.api.approveDocumentFile(savedTab.selection.path)
      if (!validateRestoredDocumentViewerFile(savedTab.selection, authorized).ok) continue
      const tab = createRestoredDocumentWorkspaceTab(savedTab)
      restoredTabs.push(tab)
      if (savedTab.id === state.activeTabId) restoredActiveTabId = tab.id
    } catch {
      // 单个文件移动、删除或内容变化时只丢弃该 Tab，不能阻断其他历史文件恢复。
    }
  }
  if (restoredTabs.length === 0) return
  documentTabs = restoredTabs
  activeDocumentTabId = restoredActiveTabId ?? restoredTabs[0]!.id
  syncActiveTabMirror(getActiveDocumentTab())
  syncDocumentViewModeControls()
  renderDocumentTabs()
  renderActiveDocumentTab(getActiveDocumentTab()!)
  // 模型 DOM 挂载后才能恢复持久化高亮，不能在渲染前操作旧节点。
  const activeBlockId = getActiveDocumentTab()?.activeBlockId
  if (activeBlockId) requestAnimationFrame(() => highlightDocumentBlock(activeBlockId))
}

/**
 * 将已重新授权的持久化 Tab 转换为只读工作台 Tab。
 * @param savedTab 已通过文件内容指纹校验的持久化 Tab。
 * @returns 使用固定恢复任务身份、保留独立阅读状态的工作台 Tab。
 * @author zhenghq
 */
function createRestoredDocumentWorkspaceTab(savedTab: DocumentViewerTabState): DocumentWorkspaceTab {
  const snapshot = createRestoredDocumentWorkspaceSnapshot(savedTab)
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
    pendingOcrModeRestart: false,
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
  // 恢复态没有活动任务；语言切换只更新本地阅读偏好，不尝试重译已保存的只读译文。
  if (isRestoredDocumentTab(tab)) {
    tab.sourceLang = sourceLanguageSelect.value || tab.sourceLang
    tab.targetLang = targetLanguageSelect.value || tab.targetLang
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
  const nextPair = `${sourceLanguageSelect.value}\u0000${targetLanguageSelect.value}`
  if (nextPair === `${tab.sourceLang}\u0000${tab.targetLang}`) return
  tab.sourceLang = sourceLanguageSelect.value || tab.sourceLang
  tab.targetLang = targetLanguageSelect.value || tab.targetLang
  appliedLanguagePair = nextPair
  scheduleDocumentViewerStatePersist()
  const revision = ++tab.languageRevision
  // 只读回放中的历史任务标识属于持久化快照，不是当前主进程可取消的活动任务。
  if (isRestoredDocumentTab(tab) || isReadOnlyDocumentTab(tab)) return
  const jobId = tab.activeJobId ?? tab.expectedJobId
  const jobGeneration = tab.generation
  await cancelDocumentJob(jobId, jobGeneration)
  if (!documentTabs.includes(tab) || revision !== tab.languageRevision) return
  if (jobId) await releaseDocumentJob(jobId)
  await startDocumentTabTranslation(tab)
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
 * 从本地存储读取并规范化文件翻译历史。
 * @returns 可安全渲染的历史记录；存储不可用或内容损坏时返回空列表。
 * @author zhenghq
 */
function readDocumentFileHistory(): DocumentFileHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(DOCUMENT_FILE_HISTORY_STORAGE_KEY)
    return raw ? normalizeDocumentFileHistory(JSON.parse(raw)) : []
  } catch {
    return []
  }
}

/**
 * 将文件翻译历史持久化到本地存储。
 * @param entries 待保存的历史记录。
 * @returns 无返回值。
 * @author zhenghq
 */
function writeDocumentFileHistory(entries: readonly DocumentFileHistoryEntry[]): void {
  try {
    window.localStorage.setItem(DOCUMENT_FILE_HISTORY_STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // 本地存储受限时仍保留当前窗口内可用的历史记录。
  }
}

/**
 * 记录一次成功文件选择，并同步刷新下拉列表。
 * @param selection 已通过校验的文件元数据。
 * @returns 无返回值。
 * @author zhenghq
 */
function rememberSelectedDocument(selection: Pick<DocumentFileHistoryEntry, 'path' | 'name' | 'size' | 'format'>): void {
  documentFileHistory = recordDocumentFileHistory(documentFileHistory, selection, Date.now())
  writeDocumentFileHistory(documentFileHistory)
  renderDocumentHistory()
}

/**
 * 从主进程读取持久化的文档任务历史并刷新下拉列表。
 * @returns 读取完成后的 Promise；失败时保留当前列表并显示脱敏提示。
 * @author zhenghq
 */
async function loadDocumentTaskHistory(): Promise<void> {
  try {
    documentTaskHistory = await window.api.listDocumentHistory()
    renderDocumentHistory()
  } catch {
    documentHistoryStatus.textContent = t('document.historyLoadFailed')
    documentHistoryStatus.hidden = false
  }
}

/**
 * 将任务状态转换为当前语言下的简短标签。
 * @param status 历史任务的终态。
 * @returns 可展示的状态文本。
 * @author zhenghq
 */
function historyStatusLabel(status: DocumentHistoryEntry['status']): string {
  const keys: Partial<Record<DocumentHistoryEntry['status'], string>> = {
    completed: 'document.progress.completed',
    partial: 'document.partial',
    failed: 'document.progress.failed',
    cancelled: 'document.progress.cancelled'
  }
  return t(keys[status] ?? 'document.progress.preparing')
}

/**
 * 格式化历史条目的最近更新时间。
 * @param timestamp 毫秒时间戳。
 * @returns 当前界面语言下的日期和时间。
 * @author zhenghq
 */
function formatDocumentHistoryTime(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat(localeRuntime.locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(timestamp))
  } catch {
    return new Date(timestamp).toLocaleString()
  }
}

/**
 * 创建历史列表中的操作按钮。
 * @param label 按钮的可访问文本。
 * @param className 附加样式类。
 * @param action 按钮动作类型。
 * @param id 任务标识或文件路径。
 * @returns 已完成事件数据绑定的按钮。
 * @author zhenghq
 */
function createDocumentHistoryActionButton(
  label: string,
  className: string,
  action: 'open' | 'delete',
  id: string
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.textContent = label
  button.dataset.historyAction = action
  button.dataset.historyTargetId = id
  return button
}

/**
 * 根据当前搜索词渲染任务与文件历史下拉列表。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderDocumentHistory(): void {
  const query = documentHistorySearch.value
  visibleDocumentTaskHistory = filterDocumentTaskHistory(documentTaskHistory, query)
  visibleDocumentFileHistory = filterDocumentFileHistory(documentFileHistory, query)
  visibleDocumentHistory = mergeDocumentHistoryEntries(
    visibleDocumentTaskHistory,
    visibleDocumentFileHistory
  )
  documentHistoryList.replaceChildren()
  documentHistoryEmpty.hidden = visibleDocumentHistory.length > 0
  documentHistoryEmpty.textContent = documentTaskHistory.length === 0 && documentFileHistory.length === 0
    ? t('document.historyEmpty')
    : t('document.historyNoResults')
  documentHistoryClearButton.disabled =
    documentTaskHistory.length === 0 && documentFileHistory.length === 0

  visibleDocumentHistory.forEach((entry, index) => {
    const item = document.createElement('li')
    item.className = 'document-history-row'
    const openButton = document.createElement('button')
    const copy = document.createElement('span')
    const name = document.createElement('strong')
    const meta = document.createElement('span')
    const check = document.createElement('span')
    const actions = document.createElement('span')
    const isCurrent = entry.kind === 'task'
      ? documentTabs.some((tab) => tab.sourceKind === 'history' && tab.snapshot?.jobId === entry.jobId)
      : findDocumentTabByPath(entry.path) !== null
    openButton.type = 'button'
    openButton.className = 'document-history-item'
    openButton.dataset.historyIndex = String(index)
    openButton.dataset.historyAction = 'open'
    openButton.dataset.historyTargetId = entry.kind === 'task' ? entry.jobId : entry.path
    openButton.setAttribute('role', 'option')
    openButton.setAttribute('aria-selected', String(isCurrent))
    openButton.title = entry.kind === 'task' ? entry.task.fileName : entry.path
    copy.className = 'document-history-item-copy'
    name.textContent = entry.kind === 'task' ? entry.task.fileName : entry.file.name
    if (entry.kind === 'task') {
      const direction = `${langLabel(entry.task.languagePair.sourceLang, localeRuntime.locale)} → ${langLabel(entry.task.languagePair.targetLang, localeRuntime.locale)}`
      const exportLabel = entry.task.exportStatus === 'saved'
        ? t('document.historyExported')
        : t('document.historyNotExported')
      meta.textContent = `${entry.task.format.toUpperCase()} · ${direction} · ${historyStatusLabel(entry.task.status)} · ${Math.round(entry.task.percent)}% · ${formatDocumentHistoryTime(entry.task.updatedAt)} · ${exportLabel}`
    } else {
      meta.textContent = `${entry.file.format.toUpperCase()} · ${formatFileSize(entry.file.size)} · ${formatDocumentHistoryTime(entry.file.lastUsedAt)}`
    }
    check.className = 'document-history-item-check'
    check.setAttribute('aria-hidden', 'true')
    check.textContent = isCurrent ? '✓' : ''
    copy.append(name, meta)
    openButton.append(copy, check)
    actions.className = 'document-history-item-actions'
    actions.append(createDocumentHistoryActionButton(
      t('document.historyOpen'),
      'document-history-action',
      'open',
      entry.kind === 'task' ? entry.jobId : entry.path
    ))
    if (entry.kind === 'task') {
      actions.append(createDocumentHistoryActionButton(
        t('document.historyDelete'),
        'document-history-action document-history-action-danger',
        'delete',
        entry.jobId
      ))
    }
    item.append(openButton, actions)
    documentHistoryList.append(item)
  })
}

/**
 * 打开或关闭历史文件下拉，并在打开时聚焦搜索框。
 * @param open 是否打开下拉。
 * @param restoreFocus 关闭时是否把焦点还给历史按钮。
 * @returns 无返回值。
 * @author zhenghq
 */
function setDocumentHistoryOpen(open: boolean, restoreFocus = false): void {
  if (historyPopover.hidden === !open) return
  historyPopover.hidden = !open
  historyButton.setAttribute('aria-expanded', String(open))
  if (open) {
    documentHistoryStatus.hidden = true
    documentHistorySearch.value = ''
    renderDocumentHistory()
    requestAnimationFrame(() => documentHistorySearch.focus())
  } else if (restoreFocus) {
    historyButton.focus()
  }
}

/**
 * 关闭历史操作确认框并恢复触发按钮焦点。
 * @param restoreFocus 是否把焦点恢复到打开确认框前的元素。
 * @returns 无返回值。
 * @author zhenghq
 */
function closeDocumentHistoryConfirmation(restoreFocus = true): void {
  pendingDocumentHistoryAction = null
  const target = documentHistoryFocusTarget
  documentHistoryFocusTarget = null
  if (documentHistoryConfirmDialog.open) documentHistoryConfirmDialog.close()
  else documentHistoryConfirmDialog.removeAttribute('open')
  if (restoreFocus && target?.isConnected) target.focus()
}

/**
 * 使用历史记录快速切换到已选择过的文件。
 * @param entry 待切换的历史记录。
 * @returns 无返回值。
 * @author zhenghq
 */
async function switchToDocumentHistoryEntry(entry: DocumentFileHistoryEntry): Promise<void> {
  if (!platformCapability?.supported || documentHistorySwitchInFlight) return
  const existingTab = findDocumentTabByPath(entry.path)
  if (existingTab) {
    await activateDocumentTab(existingTab.id)
    setDocumentHistoryOpen(false, true)
    return
  }
  documentHistorySwitchInFlight = true
  historyButton.disabled = true
  documentHistoryStatus.hidden = true
  try {
    // 历史路径只作为候选值，切换前仍由主进程重新读取文件并登记授权。
    const result = await window.api.approveDocumentFile(entry.path)
    if (result.status === 'cancelled') return
    if (result.status === 'rejected') {
      documentHistoryStatus.textContent = validationMessage(result.code)
      documentHistoryStatus.hidden = false
      return
    }
    // 历史文件与顶栏文件共用同一 Tab 入口；新文件创建后立即启动自己的任务。
    const tab = await createDocumentTab(result, { activate: true, start: false })
    if (tab) await startDocumentTabTranslation(tab)
    setDocumentHistoryOpen(false, true)
  } catch {
    documentHistoryStatus.textContent = t('document.error.unreadable')
    documentHistoryStatus.hidden = false
  } finally {
    documentHistorySwitchInFlight = false
    historyButton.disabled = !platformCapability?.supported
  }
}

/**
 * 以只读方式打开持久化的历史任务快照，不创建、取消或释放主进程活动任务。
 * @param entry 待打开的任务历史摘要。
 * @returns 打开完成后的 Promise。
 * @author zhenghq
 */
async function openDocumentHistoryTask(entry: DocumentHistoryEntry): Promise<void> {
  if (documentHistorySwitchInFlight) return
  const existingTab = documentTabs.find((tab) =>
    tab.sourceKind === 'history' && tab.snapshot?.jobId === entry.jobId
  )
  if (existingTab) {
    await activateDocumentTab(existingTab.id)
    setDocumentHistoryOpen(false, true)
    return
  }
  documentHistorySwitchInFlight = true
  documentHistoryStatus.hidden = true
  try {
    const result = await window.api.openDocumentHistory(entry.jobId)
    if (!result) {
      documentHistoryStatus.textContent = t('document.historyLoadFailed')
      documentHistoryStatus.hidden = false
      return
    }
    const snapshot = result.snapshot
    const source = snapshot.source?.source
    let sourceAuthorized = false
    if (source?.path && source.sha256 && Number.isSafeInteger(source.size) && source.size > 0) {
      try {
        const authorized = await window.api.approveDocumentFile(source.path)
        sourceAuthorized = authorized.status === 'selected' &&
          authorized.path === source.path &&
          authorized.format === source.format &&
          authorized.size === source.size &&
          authorized.sha256 === source.sha256
      } catch {
        // 源文件已移动、删除或不可读时仍允许回放已保存译文，但不能读取源资源。
        sourceAuthorized = false
      }
    }
    const tab: DocumentWorkspaceTab = {
      id: `document-tab-${nextDocumentTabSequence++}`,
      sourceKind: 'history',
      selection: {
        path: source?.path ?? '',
        name: entry.fileName,
        size: source?.size ?? 0,
        format: entry.format,
        sha256: source?.sha256 ?? '',
        error: null
      },
      snapshot: result.snapshot,
      activeJobId: null,
      expectedJobId: null,
      generation: snapshot.generation,
      startInFlight: false,
      status: resolveDocumentTabStatus(snapshot),
      scrollPositions: { source: 0, translation: 0 },
      zoom: documentZoom,
      viewMode: documentViewMode,
      pageNumber: 1,
      scrollSyncEnabled: documentScrollSyncEnabled,
      sourceLang: snapshot.sourcePreference ?? entry.sourcePreference,
      targetLang: snapshot.targetPreference ?? entry.targetPreference,
      ocrDisplayMode: snapshot.runMode === 'ocr' ? 'ocr-text' : 'translation',
      activeBlockId: null,
      pendingLanguageRetranslation: false,
      pendingOcrModeRestart: false,
      languageRevision: 0,
      sourceAuthorized
    }
    documentTabs.push(tab)
    await activateDocumentTab(tab.id)
    setDocumentHistoryOpen(false, true)
  } catch {
    documentHistoryStatus.textContent = t('document.historyLoadFailed')
    documentHistoryStatus.hidden = false
  } finally {
    documentHistorySwitchInFlight = false
  }
}

/**
 * 从历史列表中打开任务摘要或重新授权本地文件。
 * @param entry 统一历史条目。
 * @returns 打开完成后的 Promise。
 * @author zhenghq
 */
async function openDocumentHistoryEntry(entry: DocumentHistoryListItem): Promise<void> {
  if (entry.kind === 'task') {
    await openDocumentHistoryTask(entry.task)
    return
  }
  await switchToDocumentHistoryEntry(entry.file)
}

/**
 * 打开历史删除或清空确认对话框。
 * @param action 待确认操作；null 表示关闭对话框。
 * @param focusTarget 对话框关闭后恢复焦点的元素。
 * @returns 无返回值。
 * @author zhenghq
 */
function setDocumentHistoryConfirmation(
  action: NonNullable<typeof pendingDocumentHistoryAction> | null,
  focusTarget?: HTMLElement | null
): void {
  if (!action) {
    if (focusTarget) documentHistoryFocusTarget = focusTarget
    closeDocumentHistoryConfirmation()
    return
  }
  pendingDocumentHistoryAction = action
  documentHistoryFocusTarget = focusTarget ?? (document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null)
  const isClear = action.kind === 'clear'
  documentHistoryConfirmDialog.setAttribute('aria-modal', 'true')
  documentHistoryConfirmTitle.textContent = t(isClear
    ? 'document.historyClearTitle'
    : 'document.historyDeleteTitle')
  documentHistoryConfirmDescription.textContent = t(isClear
    ? 'document.historyClearDescription'
    : 'document.historyDeleteDescription')
  documentHistoryConfirmDelete.textContent = t(isClear
    ? 'document.historyConfirmClear'
    : 'document.historyConfirmDelete')
  documentHistoryConfirmDelete.dataset.action = action.kind
  documentHistoryConfirmDialog.dataset.action = action.kind
  if (typeof documentHistoryConfirmDialog.showModal === 'function') {
    documentHistoryConfirmDialog.showModal()
  } else {
    documentHistoryConfirmDialog.setAttribute('open', '')
  }
  requestAnimationFrame(() => documentHistoryConfirmCancel.focus())
}

/**
 * 执行已确认的历史删除或清空操作，并同步本地文件历史与缓存状态。
 * @returns 操作完成后的 Promise。
 * @author zhenghq
 */
async function confirmDocumentHistoryAction(): Promise<void> {
  const action = pendingDocumentHistoryAction
  if (!action) return
  const focusTarget = documentHistoryFocusTarget
  documentHistoryConfirmDelete.disabled = true
  try {
    if (action.kind === 'delete') {
      const jobId = action.entry.jobId
      const removed = await window.api.deleteDocumentHistory(jobId)
      documentTaskHistory = documentTaskHistory.filter((entry) => entry.jobId !== action.entry.jobId)
      // 同名本地文件入口可能只是该任务的重新授权记录，删除任务时一并移除避免残留重复项。
      documentFileHistory = documentFileHistory.filter((entry) => entry.name !== action.entry.fileName)
      writeDocumentFileHistory(documentFileHistory)
      renderDocumentHistory()
      documentHistoryStatus.textContent = removed
        ? t('document.historyDeleted')
        : t('document.historyLoadFailed')
      documentHistoryStatus.hidden = false
    } else {
      await window.api.clearDocumentCache()
      documentTaskHistory = []
      documentFileHistory = []
      writeDocumentFileHistory(documentFileHistory)
      renderDocumentHistory()
      documentHistoryStatus.textContent = t('document.historyCleared')
      documentHistoryStatus.hidden = false
    }
    setDocumentHistoryConfirmation(null, focusTarget ?? undefined)
  } catch {
    documentHistoryStatus.textContent = t('document.historyLoadFailed')
    documentHistoryStatus.hidden = false
  } finally {
    documentHistoryConfirmDelete.disabled = false
  }
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
 * 判断 Tab 是否是从本地缓存恢复的只读工作台，而不是当前主进程中的活动任务。
 * @param tab 待检查的文档 Tab。
 * @returns 使用固定恢复任务身份时返回 true。
 * @author zhenghq
 */
function isRestoredDocumentTab(tab: DocumentWorkspaceTab | null | undefined): boolean {
  return tab?.snapshot?.jobId === RESTORED_DOCUMENT_JOB_ID
}

/**
 * 判断 Tab 是否只能只读回放，不能重新读取资源或操作主进程任务。
 * @param tab 待检查的文档 Tab。
 * @returns 历史快照或本地恢复快照返回 true。
 * @author zhenghq
 */
function isReadOnlyDocumentTab(tab: DocumentWorkspaceTab | null | undefined): boolean {
  return tab?.sourceKind === 'history' || tab?.sourceKind === 'restored' || isRestoredDocumentTab(tab)
}

/**
 * 构造只读 Tab 的受控源文件请求；快照与 Tab 必须一致且已重新授权。
 * @param tab 只读文档 Tab。
 * @returns 主进程可校验的源文件请求；未授权或元数据不完整时返回 null。
 * @author zhenghq
 */
function approvedDocumentSourceRequest(tab: DocumentWorkspaceTab) {
  const source = tab.snapshot?.source?.source
  if (!isReadOnlyDocumentTab(tab) || !tab.sourceAuthorized || !source ||
    !source.path || !source.sha256 || !Number.isSafeInteger(source.size) || source.size < 1 ||
    source.sha256 !== tab.selection.sha256 || source.size !== tab.selection.size) {
    return null
  }
  return {
    path: source.path,
    sourceSha256: source.sha256,
    sourceSize: source.size,
    format: source.format
  }
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
 * 在页面区块及表格单元格中查找指定图片资源。
 * @param blocks 待遍历区块。
 * @param assetId 图片资源标识。
 * @returns 匹配的图片区块；不存在时返回 undefined。
 * @author zhenghq
 */
function findDocumentImageBlock(
  blocks: readonly DocumentBlock[],
  assetId: string
): DocumentImageBlock | undefined {
  for (const block of blocks) {
    if (block.kind === 'image') {
      if (block.assetId === assetId) return block
      continue
    }
    if (block.kind !== 'table') continue
    for (const row of block.rows) {
      for (const cell of row.cells) {
        const image = findDocumentImageBlock(cell.blocks, assetId)
        if (image) return image
      }
    }
  }
  return undefined
}

/**
 * 定位历史 PDF 图片所属页面及原始 bbox，供主进程重新解析后恢复同一资源。
 * @param tab 图片所属文档 Tab。
 * @param assetId 图片资源标识。
 * @returns 页面索引与 bbox；非 PDF 或无法唯一定位时返回 undefined。
 * @author zhenghq
 */
function findDocumentPdfImageLocation(
  tab: DocumentWorkspaceTab,
  assetId: string
): { pageIndex: number; bbox: DocumentBoundingBox } | undefined {
  const model = tab.snapshot?.source ?? tab.snapshot?.translation
  if (model?.source.format !== 'pdf') return undefined
  const matches: Array<{ pageIndex: number; bbox: DocumentBoundingBox }> = []
  for (const page of model.pages) {
    const block = findDocumentImageBlock(page.blocks, assetId)
    if (!block?.bbox) continue
    matches.push({ pageIndex: page.index, bbox: { ...block.bbox } })
  }
  return matches.length === 1 ? matches[0] : undefined
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
  const tabs = documentTabs.flatMap((tab) => {
    const savedTab = createPersistedDocumentViewerTab(tab)
    return savedTab ? [savedTab] : []
  })
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
  pendingOcrModeRestart = tab?.pendingOcrModeRestart ?? false
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
  pendingOcrModeRestart = tab.pendingOcrModeRestart
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
    tab.generation === snapshot.generation &&
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
    !tab.pendingOcrModeRestart &&
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
 * @param tab 目标 Tab。
 * @param snapshot 最新任务快照。
 * @returns 无返回值。
 * @author zhenghq
 */
function updateDocumentTabSnapshot(tab: DocumentWorkspaceTab, snapshot: DocumentWorkspaceSnapshot): void {
  tab.snapshot = snapshot
  tab.activeJobId = snapshot.jobId
  tab.expectedJobId = snapshot.jobId
  tab.generation = Math.max(tab.generation, snapshot.generation)
  tab.status = resolveDocumentTabStatus(snapshot)
  if (tab.id !== activeDocumentTabId) {
    renderDocumentTabs()
    return
  }
  refreshActiveTabMirror(tab)
  renderDocumentTabs()
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
    !tab.pendingOcrModeRestart &&
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
  // OCR 模式切换期间旧任务的取消终态和迟到进度都必须丢弃，等待新模式重新建立任务身份。
  if (tab.pendingOcrModeRestart) return false
  if (!terminal && !canApplyDocumentTabProgressSnapshot(tab, snapshot)) return false
  // 在首次有效运行进度到达时固定 ETA 起点；后续进度必须基于同一时间计算，
  // 否则每次重算都会把已耗时清零，剩余时间会被严重低估。
  const taskKey = `${snapshot.jobId}:${snapshot.generation}`
  if (!terminal && !documentTaskStartedAt.has(taskKey)) {
    documentTaskStartedAt.set(taskKey, Date.now())
  }
  updateDocumentTabSnapshot(tab, snapshot)
  if (tab.id !== activeDocumentTabId) return true
  refreshActiveTabMirror(tab)
  if (terminal) flushSnapshotRenderForTab(tab, snapshot)
  else scheduleSnapshotRenderForTab(tab, snapshot)
  if (terminal) scheduleDocumentViewerStatePersist()
  startButton.disabled = false
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
    !tab.pendingOcrModeRestart &&
    tab.generation === update.generation &&
    (tab.activeJobId === update.jobId || tab.expectedJobId === update.jobId)
  ) ?? null
}

/**
 * 渲染顶栏文件 Tab，并同步选中态、状态点和逐个关闭入口。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderDocumentTabs(): void {
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
  const activeElement = documentWorkspaceTabs.querySelector<HTMLElement>('[aria-selected="true"]')
  activeElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
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
  clearDocumentBlockHighlight()
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
 * @returns 无返回值。
 * @author zhenghq
 */
function renderActiveDocumentTab(tab: DocumentWorkspaceTab): void {
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
    renderSnapshot(tab.snapshot, tab)
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
    partialStatus.hidden = true
    workbench.dataset.state = tab.status
  }
  restoreDocumentTabScroll(tab)
}

/**
 * 激活指定文件 Tab，保存旧 Tab 滚动位置并恢复目标任务视图。
 * @param tabId 目标 Tab 标识。
 * @returns 激活完成后的 Promise。
 * @author zhenghq
 */
async function activateDocumentTab(tabId: string): Promise<void> {
  if (tabId === activeDocumentTabId) return
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
  if (tab.activeBlockId) highlightDocumentBlock(tab.activeBlockId)
  else clearDocumentBlockHighlight()
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
      existing.pendingOcrModeRestart = false
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
    pendingOcrModeRestart: false,
    languageRevision: 0,
    sourceAuthorized: true
  }
  documentTabs.push(tab)
  if (tab.selection.path) {
    rememberSelectedDocument({
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
  assetUrlEpoch += 1
  assetRequests.clear()
  for (const url of assetUrls.values()) URL.revokeObjectURL(url)
  assetUrls.clear()
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
 * @returns 可用于 img.src 的 Blob URL；资源不可用时返回 null。
 * @author zhenghq
 */
async function resolveAssetUrl(
  jobId: string,
  block: DocumentImageBlock,
  tab: DocumentWorkspaceTab
): Promise<string | null> {
  const assetId = block.assetId
  // 恢复态共用固定 jobId；缓存键必须同时包含 Tab 与源文件 SHA，避免多 Tab 串图。
  const sourceSha256 = tab.selection.sha256
  const cacheKey = `${tab.id}:${sourceSha256}:${assetId}`
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
                const pdfLocation = findDocumentPdfImageLocation(tab, assetId)
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
 * @returns 无返回值。
 * @author zhenghq
 */
function loadDocumentImageAsset(
  wrapper: HTMLElement,
  image: HTMLImageElement,
  block: DocumentImageBlock,
  jobId: string,
  tab: DocumentWorkspaceTab
): void {
  // 异步资源返回时旧页面可能已被新快照替换；只有仍挂载的当前图片才允许更新状态。
  const isCurrentImage = (): boolean =>
    wrapper.isConnected &&
    image.parentElement === wrapper &&
    wrapper.querySelector(':scope > img.document-page-image') === image
  wrapper.dataset.assetState = 'loading'
  void resolveAssetUrl(jobId, block, tab).then((url) => {
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
 * 将文档样式转换为 CSS 属性；只接受模型中的受控样式字段。
 * @param style 文档样式。
 * @returns 可应用到 HTMLElement 的样式映射。
 * @author zhenghq
 */
function styleProperties(style: DocumentTextStyle | undefined): Partial<CSSStyleDeclaration> {
  if (!style) return {}
  const result: Partial<CSSStyleDeclaration> = {}
  if (style.fontFamily) result.fontFamily = style.fontFamily
  if (style.fontSize !== undefined) result.fontSize = `${style.fontSize}pt`
  if (style.fontWeight !== undefined) result.fontWeight = String(style.fontWeight)
  if (style.color) result.color = style.color
  if (style.backgroundColor) result.backgroundColor = style.backgroundColor
  if (style.italic) result.fontStyle = 'italic'
  if (style.underline) result.textDecoration = 'underline'
  if (style.strikethrough) {
    result.textDecoration = result.textDecoration === 'underline'
      ? 'underline line-through'
      : 'line-through'
  }
  if (style.letterSpacing !== undefined) result.letterSpacing = `${style.letterSpacing}pt`
  if (style.lineHeight !== undefined) result.lineHeight = `${style.lineHeight}pt`
  return result
}

/**
 * 将 PDF 原文样式写入可缩放文本元素；字号保留为 CSS 自定义属性供译文页换算。
 * @param element 目标文本元素。
 * @param style 文档文本样式。
 * @returns 无返回值。
 * @author zhenghq
 */
function applyScalableTextStyle(element: HTMLElement, style: DocumentTextStyle | undefined): void {
  if (style?.fontSize !== undefined) {
    // PDF.js 在 scale=1 时页面点与 CSS 像素一一对应；变量显式携带 px，避免 pt 与屏幕像素混算。
    element.style.setProperty('--document-run-font-size-px', `${style.fontSize}px`)
  }
  if (style?.lineHeight !== undefined) {
    element.style.setProperty('--document-run-line-height-px', `${style.lineHeight}px`)
  }
  if (style?.color) element.style.color = style.color
  if (style?.fontWeight !== undefined) element.style.fontWeight = String(style.fontWeight)
  if (style?.fontFamily) {
    element.style.setProperty('--document-run-font-family', pdfPreviewFontFamily(style.fontFamily))
  }
  if (style?.italic) element.style.fontStyle = 'italic'
  if (style?.underline) element.style.textDecoration = 'underline'
  if (style?.strikethrough) {
    element.style.textDecoration = element.style.textDecoration === 'underline'
      ? 'underline line-through'
      : 'line-through'
  }
  if (style?.letterSpacing !== undefined) element.style.letterSpacing = `${style.letterSpacing}px`
}

/**
 * 合并区块与文本片段的样式，片段样式优先。
 * PDF 解析器常把字号、颜色、字重和行高放在区块上，只读取 run 样式会导致译文回退到默认 12px。
 * @param block 文本区块。
 * @param run 文本片段。
 * @returns 用于预览渲染的最终文本样式。
 * @author zhenghq
 */
function effectiveTextStyle(block: DocumentTextBlock, run: DocumentTextRun): DocumentTextStyle {
  return { ...block.style, ...run.style }
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
  documentZoom = clampDocumentZoom(nextZoom)
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
 * 仅在数值实际变化时写入 CSS 自定义属性，避免流式重排触发无意义的样式失效和观察回调。
 * @param element 目标元素。
 * @param property CSS 自定义属性名。
 * @param value 新的像素值。
 * @returns 是否实际写入属性。
 * @author zhenghq
 */
function setCssPixelPropertyIfChanged(
  element: HTMLElement,
  property: string,
  value: number
): boolean {
  if (!Number.isFinite(value)) return false
  const currentValue = Number.parseFloat(element.style.getPropertyValue(property))
  if (Number.isFinite(currentValue) && Math.abs(currentValue - value) < 0.01) return false
  element.style.setProperty(property, `${value}px`)
  return true
}

/**
 * 仅在像素值实际变化时写入元素的内联样式，避免观察器因无意义写入反复触发。
 * @param element 目标元素。
 * @param property 内联样式属性名。
 * @param value 新的像素值。
 * @returns 是否实际写入属性。
 * @author zhenghq
 */
function setInlinePixelPropertyIfChanged(
  element: HTMLElement,
  property: 'top' | 'height' | 'minHeight',
  value: number
): boolean {
  if (!Number.isFinite(value)) return false
  const currentValue = Number.parseFloat(element.style[property])
  if (Number.isFinite(currentValue) && Math.abs(currentValue - value) < 0.01) return false
  element.style[property] = `${value}px`
  return true
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
    if ((child.classList.contains('document-image-block') ||
      child.querySelector(':scope > .document-image-block')) && Number.isFinite(sourceY)) {
      const anchoredTop = flowOrigin + Math.max(0, sourceY - pageMarginTop) * scale
      const imageBlock = child.classList.contains('document-image-block')
        ? child
        : child.querySelector<HTMLElement>(':scope > .document-image-block')
      const imageRect = (imageBlock ?? child).getBoundingClientRect()
      const imageHeight = Number.parseFloat(
        child.style.getPropertyValue('--document-image-height')
      ) || imageRect.height / scale
      // 只有横向相交的前序内容才阻挡图片回填；同行分组使用子元素并集，避免弹性空白误判。
      gapPx = resolveTranslationImageFlowGap({
        anchoredTop,
        previousBottom,
        flowOrigin,
        imageRange: {
          left: imageRect.left - pageRect.left,
          right: imageRect.right - pageRect.left
        },
        imageHeight: imageHeight * scale,
        obstacles: flowObstacles
      })
      setCssPixelPropertyIfChanged(child, '--document-image-flow-gap-before', gapPx / scale)
    } else {
      setCssPixelPropertyIfChanged(child, '--document-flow-gap-before', gapPx / scale)
    }
    previousBottom = Math.max(previousBottom, measureTranslationFlowBottom(child))
    // 每个已排版区块都要登记二维占位，供后续图片判断是否需要避让。
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
 * 为 PDF 内部字体名构造浏览器可用的字体回退链。
 * PDF.js 的 BaseFont 名称通常不是本机字体族，单独使用会回退到默认字体并造成译文观感不一致。
 * @param fontFamily PDF 模型中的字体名称。
 * @returns 带中英文系统字体回退的 CSS font-family 值。
 * @author zhenghq
 */
function pdfPreviewFontFamily(fontFamily: string): string {
  const escaped = fontFamily.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
  const normalized = fontFamily.toLowerCase()
  // PDF.js 对中文 PDF 常把内嵌字体标记为 monospace；优先依据实际字体名选择衬线或无衬线回退。
  if (/song|simsun|serif|times|georgia|garamond|ming|kai|fang|宋|明|楷|仿/iu.test(normalized)) {
    return `"${escaped}", "Times New Roman", "Songti SC", "SimSun", "Noto Serif CJK SC", serif`
  }
  if (/mono|courier|consolas|menlo|monaco|code/iu.test(normalized)) {
    return `"${escaped}", Menlo, Consolas, "Songti SC", "SimSun", monospace`
  }
  return `"${escaped}", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif`
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
  return block.runs.some((run) => run.text.trim().length > 0)
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
  for (const run of block.runs) {
    const span = document.createElement('span')
    span.className = 'document-text-run'
    span.dataset.runId = run.runId
    span.textContent = run.text
    applyScalableTextStyle(span, effectiveTextStyle(block, run))
    element.append(span)
  }
  return element
}

/**
 * 判断 OCR 区域是否会在译文侧生成可见覆盖层。
 * @param region OCR 区域。
 * @returns 是否存在可展示的译文。
 * @author zhenghq
 */
function hasVisibleOcrTranslation(region: DocumentOcrRegion): boolean {
  return Boolean(region.translatedText?.trim())
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
  const regions = orderedOcrRegions(block.ocrRegions ?? []).filter(hasVisibleOcrTranslation)
  if (regions.length === 0) return ''
  return JSON.stringify(regions.map((region) => ({
    regionId: region.regionId,
    bbox: region.bbox,
    translatedText: region.translatedText,
    style: region.style,
    textAlign: region.textAlign,
    status: region.status
  })))
}

/**
 * 创建 OCR 译文覆盖层；源文侧不叠加识别文本，译文侧也只显示已成功翻译的内容。
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
  const translatedText = region.translatedText?.trim()
  // 翻译失败或尚未完成时保留原图，避免把 OCR 原文误当作译文覆盖显示。
  if (!translatedText) return null
  const element = document.createElement('div')
  element.className = 'document-ocr-region'
  element.dataset.status = region.status
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
  // 白底只覆盖原识别框；横向扩展仅用于给译文提供排版空间，不能让遮罩覆盖右侧正文。
  const sourceWidthRatio = resolveDocumentOcrSourceWidthRatio(box, horizontalBounds)
  element.style.setProperty('--document-ocr-source-width', `${sourceWidthRatio * 100}%`)
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
  element.textContent = translatedText
  return element
}

/**
 * 创建图片的 OCR 译文覆盖层；没有可展示译文时返回 null。
 * @param block 图片区块。
 * @returns 可直接挂载到图片区块的 OCR 覆盖层。
 * @author zhenghq
 */
function createOcrTranslationLayer(block: DocumentImageBlock): HTMLElement | null {
  const regions = orderedOcrRegions(block.ocrRegions ?? []).filter(hasVisibleOcrTranslation)
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
 * @returns 图片区块元素。
 * @author zhenghq
 */
function renderImageBlock(
  block: DocumentImageBlock,
  side: DocumentRenderSide,
  pageWidth: number,
  jobId: string,
  tab: DocumentWorkspaceTab
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
    loadDocumentImageAsset(wrapper, image, block, jobId, tab)
  }
  appendImageOcrLayers(wrapper, block, side, tab)
  return wrapper
}

/**
 * 创建表格区块并递归渲染单元格中的受支持内容。
 * @param block 表格区块。
 * @param side 当前渲染侧。
 * @param pageWidth 原始页面宽度，用于约束表格横向范围。
 * @param jobId 表格所属任务标识。
 * @param tab 快照所属的文档 Tab。
 * @returns 表格区块元素。
 * @author zhenghq
 */
function renderTableBlock(
  block: DocumentTableBlock,
  side: DocumentRenderSide,
  pageWidth: number,
  jobId: string,
  tab: DocumentWorkspaceTab
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
  // 两侧都沿用原文列宽，保证译文表格与源 PDF 的列边界一致。
  table.style.tableLayout = 'fixed'
  if (block.columnWidths?.length) {
    const columns = document.createElement('colgroup')
    for (const width of normalizeTableColumnWidths(block.columnWidths, block.bbox?.width)) {
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
        for (const child of cell.blocks) tableCell.append(renderTableCellBlock(child, side, jobId, tab))
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
      for (const child of cell.blocks) tableCell.append(renderTableCellBlock(child, side, jobId, tab))
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
 * @returns 单元格子区块元素。
 * @author zhenghq
 */
function renderTableCellBlock(
  block: DocumentBlock,
  side: DocumentRenderSide,
  jobId: string,
  tab: DocumentWorkspaceTab
): HTMLElement {
  const pageWidth = 1
  const element = block.kind === 'image'
    ? renderTableCellImageBlock(block, side, jobId, tab)
    : renderBlock(block, side, pageWidth, undefined, jobId, tab)
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
 * @returns 不继承页面绝对坐标的图片区块元素。
 * @author zhenghq
 */
function renderTableCellImageBlock(
  block: DocumentImageBlock,
  side: DocumentRenderSide,
  jobId: string,
  tab: DocumentWorkspaceTab
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
    loadDocumentImageAsset(wrapper, image, block, jobId, tab)
  }
  appendImageOcrLayers(wrapper, block, side, tab)
  return wrapper
}

/**
 * 将表格列宽按表格总宽度归一化，防止解析误差导致列宽总和超过页面边界。
 * @param columnWidths 原始列宽。
 * @param tableWidth 表格边界宽度；缺失时保留原始比例。
 * @returns 归一化后的列宽。
 * @author zhenghq
 */
function normalizeTableColumnWidths(
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
 * 创建可随页面缩放的直线装饰区块；线宽与颜色使用原始 PDF 信息。
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
    element.style.setProperty('--document-line-color', block.line.color ?? 'var(--document-paper-text)')
    element.style.setProperty('--document-line-thickness', `${Math.max(0.5, block.line.thickness ?? 1)}px`)
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
 * @returns 区块元素。
 * @author zhenghq
 */
function renderBlock(
  block: DocumentBlock,
  side: DocumentRenderSide,
  pageWidth: number,
  contentArea: DocumentContentArea | undefined,
  jobId: string,
  tab: DocumentWorkspaceTab
): HTMLElement {
  switch (block.kind) {
    case 'text': return renderTextBlock(block, side, pageWidth, contentArea)
    case 'image': return renderImageBlock(block, side, pageWidth, jobId, tab)
    case 'table': return renderTableBlock(block, side, pageWidth, jobId, tab)
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
 * @returns 页面元素。
 * @author zhenghq
 */
function renderPage(
  page: DocumentPage,
  side: DocumentRenderSide,
  translationInitialScale: number,
  jobId: string,
  tab: DocumentWorkspaceTab
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
  element.dataset.layout = side === 'translation' && hasGeometry
    ? 'translation-flow'
    : hasGeometry ? 'absolute' : 'flow'
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
    const rendered = renderBlock(block, side, page.width, page.contentArea, jobId, tab)
    const occupiesFlow = occupiesDocumentTranslationFlow(block)
    rendered.dataset.flowOccupiesSpace = String(occupiesFlow)
    const continuesFlowGroup = element.dataset.layout === 'translation-flow' &&
      block.flowGroupId !== undefined &&
      block.flowGroupId === activeFlowGroupId
    const blockGapBefore = element.dataset.layout === 'translation-flow' && block.bbox
      ? pdfFlowGapBefore(block, previousBlock, previousBottom)
      : 0
    if (element.dataset.layout === 'translation-flow' && block.bbox) {
      // 译文仍按阅读顺序流式换行，但段前距离来自原文坐标，避免统一 gap 破坏标题和正文节奏。
      rendered.style.setProperty('--document-flow-gap-before', `${blockGapBefore}px`)
      // 图片需要优先回到原文纵向锚点；保留原始 y 与段前距离供挂载后的真实 DOM 测量使用。
      rendered.dataset.sourceY = String(block.bbox.y)
      rendered.dataset.sourceTop = String(block.bbox.y)
      rendered.dataset.sourceBottom = String(block.bbox.y + block.bbox.height)
      rendered.dataset.sourceGapBefore = String(blockGapBefore)
      // 装饰线虽然保留原文底边信息，但不占普通流高度；后续文本应继续以最后一个流式区块为基准。
      if (occupiesFlow) {
        previousBottom = Math.max(previousBottom, block.bbox.y + block.bbox.height)
      }
    }
    previousBlock = block
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
 * 根据源文件格式和当前栏位选择预览呈现方式。
 * @param model 当前文档模型。
 * @param side 当前渲染侧。
 * @returns 对应的预览类型。
 * @author zhenghq
 */
function resolvePreviewKind(model: DocumentModel, side: DocumentRenderSide): DocumentPreviewKind {
  const format = model.source.format
  // PDF 与图片文档都按页等比缩放，避免整页图片在窄栏中被压变形。
  if (format === 'pdf' || format === 'image') return 'paged'
  if (format === 'markdown') return 'markdown'
  if (format === 'csv') return 'table'
  if (format === 'srt' || format === 'vtt') return 'subtitle'
  if (side === 'source' && format === 'html') return 'html-source'
  if (format === 'html') return 'flow'
  return 'flow'
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
 * @returns 包含全部 run 的文档片段。
 * @author zhenghq
 */
function renderTextRuns(block: DocumentTextBlock): DocumentFragment {
  const fragment = document.createDocumentFragment()
  for (const run of block.runs) {
    const span = document.createElement('span')
    span.className = 'document-text-run'
    span.dataset.runId = run.runId
    span.textContent = run.text
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
 * @returns 语义化区块元素。
 * @author zhenghq
 */
function renderMarkdownBlock(
  block: DocumentBlock,
  side: DocumentRenderSide,
  jobId: string,
  tab: DocumentWorkspaceTab
): HTMLElement {
  if (block.kind === 'text') {
    if (block.role === 'code') {
      const pre = document.createElement('pre')
      pre.dataset.blockId = block.blockId
      const code = document.createElement('code')
      code.append(renderTextRuns(block))
      pre.append(code)
      return pre
    }
    if (block.role === 'heading') {
      const level = Math.max(1, Math.min(6, 7 - Math.round(((block.style?.fontSize ?? 30) - 14) / 3)))
      const heading = document.createElement(`h${level}`)
      heading.dataset.blockId = block.blockId
      heading.append(renderTextRuns(block))
      return heading
    }
    if (block.role === 'quote') {
      const quote = document.createElement('blockquote')
      quote.dataset.blockId = block.blockId
      quote.append(renderTextRuns(block))
      return quote
    }
    if (block.role === 'list-item') {
      const list = document.createElement('ul')
      const item = document.createElement('li')
      item.dataset.blockId = block.blockId
      item.append(renderTextRuns(block))
      list.append(item)
      return list
    }
  }
  return renderBlock(block, side, 1, undefined, jobId, tab)
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
    for (const block of page.blocks) article.append(renderMarkdownBlock(block, side, jobId, tab))
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
      article.append(renderBlock(block, side, page.width, undefined, jobId, tab))
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
      item.append(renderBlock(block, side, page.width, undefined, jobId, tab))
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
 * @returns 无返回值。
 * @author zhenghq
 */
async function renderPdfPages(
  container: HTMLElement,
  model: DocumentModel,
  jobId: string,
  tab: DocumentWorkspaceTab
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

  let pdfDocument: Awaited<ReturnType<typeof pdfjsModule.getDocument>['promise']> | null = null
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const article = entry.target as HTMLElement
      observer.unobserve(article)
      void renderVisiblePage(article)
    }
  }, { root: container, rootMargin: '600px 0px' })
  const renderTasks = new Set<{ cancel(): void; promise: Promise<void> }>()
  let disposed = false
  const cleanup = (): void => {
    if (disposed) return
    disposed = true
    observer.disconnect()
    for (const renderTask of renderTasks) renderTask.cancel()
    renderTasks.clear()
    if (pdfRenderTokens.get(container) === renderToken) pdfRenderTokens.delete(container)
    if (pdfPreviewCleanups.get(container) === cleanup) pdfPreviewCleanups.delete(container)
    if (pdfDocument) void pdfDocument.destroy().catch(() => undefined)
    pdfDocument = null
  }
  pdfPreviewCleanups.set(container, cleanup)
  const isCurrentRender = (): boolean => !disposed &&
    container.isConnected &&
    pdfRenderTokens.get(container) === renderToken
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
    }
  }
  try {
    const approvedSource = isReadOnlyDocumentTab(tab)
      ? approvedDocumentSourceRequest(tab)
      : null
    const source: DocumentSourceResult = isReadOnlyDocumentTab(tab)
      ? approvedSource
        ? await window.api.getApprovedDocumentSource(approvedSource)
        : { ok: false, code: 'source-not-approved' }
      : await window.api.getDocumentSource(jobId)
    if (!source.ok || !source.bytes) throw new Error(source.code ?? 'source-not-found')
    if (!isCurrentRender()) return
    const loadingTask = pdfjsModule.getDocument({
      data: new Uint8Array(source.bytes),
      isEvalSupported: false,
      useSystemFonts: true
    })
    pdfDocument = await loadingTask.promise
    if (!isCurrentRender()) return
    container.replaceChildren()
    const contentWidth = documentPageContentWidth(container)
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      // 先使用解析模型中的原始页面尺寸同步建立占位，避免 83 页 PDF 在首屏前
      // 逐页等待 PDF.js getPage。真实页面只在进入视口后加载和绘制。
      const modelPage = model.pages[pageNumber - 1]
      const sourceWidth = modelPage?.width
      const sourceHeight = modelPage?.height
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
      const textLayer = createPdfOcrTextLayer(modelPage)
      if (textLayer) article.append(textLayer)
      container.append(article)
      observer.observe(article)
    }
    // PDF.js 首屏占位完成后重新应用目标状态，避免异步替换 DOM 丢失失败与缓存标记。
    if (tab.id === activeDocumentTabId && tab.snapshot) markDocumentTargetStatuses(tab.snapshot)
    sourcePageCount.textContent = t('document.pageCount', { count: pdfDocument.numPages })
  } catch (error) {
    if (!isCurrentRender()) return
    console.error('document-pdf-preview-failed', error instanceof Error ? error.name : 'unknown')
    container.replaceChildren()
    const failed = document.createElement('p')
    failed.className = 'document-empty-state'
    failed.textContent = t('document.run.failed')
    container.append(failed)
  }
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
  tab: DocumentWorkspaceTab
): void {
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
        void renderPdfPages(previewHost, model, jobId, tab)
      } else if (model.source.format === 'pdf' && tab.ocrDisplayMode === 'ocr-text') {
        // OCR 原文模式在右侧复用 PDF 原文 Canvas，并叠加可检索文字层。
        container.dataset.previewKind = kind
        container.replaceChildren(previewHost)
        void renderPdfPages(previewHost, model, jobId, tab)
      } else {
        for (const page of model.pages) {
          // 横竖混排 PDF 的每页宽度不同，必须在首次挂载前按自身宽度计算比例，
          // 不能先沿用第一页比例再等待观察器纠正，否则会造成可见缩放。
          const pageScale = side === 'translation'
            ? initialTranslationPageScale(container, page.width)
            : 1
          // 图片 OCR 原文右侧必须复用源页绝对定位；译文流式布局会拆散底图与透明文字层的坐标。
          const pageRenderSide = tab.ocrDisplayMode === 'ocr-text' && model.source.format === 'image'
            ? 'source'
            : side
          previewHost.append(renderPage(page, pageRenderSide, pageScale, jobId, tab))
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
  updateCurrentDocumentPage(side)
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
              protected: run.protected
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
              reason: region.reason
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
 * 仅在正文模型实际变化时释放并重建当前文档页面 DOM。
 * @param snapshot 当前任务快照。
 * @param tab 快照所属的文档 Tab。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderSnapshot(snapshot: DocumentWorkspaceSnapshot, tab: DocumentWorkspaceTab): void {
  // 快照渲染与 Tab 切换共享同一套界面节点，过期回调不得覆盖当前文件。
  if (tab.id !== activeDocumentTabId) return
  renderActualLanguage(snapshot.languagePair)
  // 新模式准备中的快照可能暂时缺少源模型；只有同一 Tab 与同一文件指纹才可复用已渲染原文。
  const canReuseRenderedSourcePreview = renderedSourcePreviewTabId === tab.id &&
    renderedSourcePreviewSha256 === tab.selection.sha256
  const sourcePreviewIdentity = snapshot.source
    ? documentPreviewIdentity(snapshot.source)
    : canReuseRenderedSourcePreview
      ? renderedSourcePreviewIdentity
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
  const translationChanged = !hasRenderedTranslation ||
    !canReuseRenderedTranslation ||
    renderedTranslationSignature !== translationSignature
  const translationWarningsChanged = renderedTranslationWarningSignature !== translationWarningSignature
  // 只有源文件身份变化才释放图片资源；译文流式增量不能破坏仍在使用的源预览。
  if (sourceChanged) revokeAssetUrls()
  if (sourceChanged) releaseHtmlPreviewUrl()
  if (sourceChanged) {
    renderDocumentModel(
      sourceContent,
      snapshot.source,
      'document.waitingSource',
      'source',
      snapshot.jobId,
      snapshot.source?.warnings,
      tab
    )
    renderedSourcePreviewIdentity = sourcePreviewIdentity
    renderedSourcePreviewTabId = tab.id
    renderedSourcePreviewSha256 = tab.selection.sha256
    renderedSourceWarningSignature = sourceWarningSignature
  } else if (sourceWarningsChanged) {
    renderDocumentWarnings(sourceContent, snapshot.source?.warnings)
    renderedSourceWarningSignature = sourceWarningSignature
  }
  if (translationChanged) {
    // OCR 原文模式展示源模型和透明文字层，不能走针对流式译文的原位补丁路径。
    const patched = displayMode === 'translation' && hasRenderedTranslation &&
      patchTranslationPreview(translationContent, snapshot.translation, tab)
    if (!patched) {
      renderDocumentModel(
        translationContent,
        translationPaneModel,
        'document.waitingTranslation',
        'translation',
        snapshot.jobId,
        translationPaneModel?.warnings,
        tab
      )
    }
    renderedTranslationSignature = translationSignature
    renderedTranslationTabId = tab.id
    renderedTranslationSha256 = tab.selection.sha256
    hasRenderedTranslation = true
    renderedTranslationWarningSignature = translationWarningSignature
  } else if (translationWarningsChanged) {
    renderDocumentWarnings(translationContent, translationPaneModel?.warnings)
    renderedTranslationWarningSignature = translationWarningSignature
  }
  // 正文未变化时也必须在每次快照后刷新状态，否则缓存命中和失败目标会在流式事件中丢失。
  markDocumentTargetStatuses(snapshot)
  sourcePageCount.textContent = snapshot.source
    ? t('document.pageCount', { count: snapshot.source.pages.length })
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
  clearDocumentBlockDomHighlight()
  applyDocumentZoom(documentZoom)
  renderDocumentToc()
  markDocumentTargetStatuses(snapshot)
  // DOM 重绘不能抹掉 Tab 的持久化区块锚点，必须在挂载新节点后按锚点恢复高亮。
  if (tab.activeBlockId) highlightDocumentBlock(tab.activeBlockId)
  scheduleCurrentDocumentPageUpdate()
}

/**
 * 判断当前快照是否包含至少一个可导出的成功译文或无需翻译目标。
 * @param snapshot 当前任务快照。
 * @returns 存在可导出内容时返回 true。
 * @author zhenghq
 */
function hasUsableExportResult(snapshot: DocumentWorkspaceSnapshot | null): boolean {
  // OCR 原文任务没有翻译目标，完成报告计数为 0 时仍应允许导出双层 PDF。
  if (snapshot?.runMode === 'ocr') return snapshot.task.status === 'completed'
  if (!snapshot?.completionReport) return snapshot?.task.status === 'completed'
  return snapshot.completionReport.translated + snapshot.completionReport.unchanged > 0
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
  progressCount.textContent = snapshot.task.progress.total > 0
    ? `${snapshot.task.progress.completed} / ${snapshot.task.progress.total} · ${percent}%`
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
  exportButton.disabled = status === 'completed'
    ? false
    : status === 'partial' || status === 'failed'
      ? !hasUsableTranslation
      : true
  // phaseCompleted 只表示阶段流程结束，不代表没有可重试目标；partial 终态
  // 仍需与摘要共用同一动作状态，按失败、未完成和疑似未翻译目标决定按钮状态。
  retryButton.disabled = retryAction.retryDisabled
  if (restored) {
    // 恢复态没有活动主进程任务；旧任务导出、重试和取消入口必须保持不可用。
    exportButton.disabled = true
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
}

/**
 * 根据当前阶段进度和已用时间估算剩余时间。
 * @param snapshot 当前任务快照。
 * @returns 预计剩余毫秒数；尚无足够进度信息时返回 null。
 * @author zhenghq
 */
function resolveDocumentRemainingTime(snapshot: DocumentWorkspaceSnapshot): number | null {
  const progress = snapshot.task.progress
  if (progress.completed <= 0 || progress.total <= 0 || snapshot.percent <= 0 || snapshot.percent >= 100) {
    return null
  }
  const taskKey = `${snapshot.jobId}:${snapshot.generation}`
  const startedAt = documentTaskStartedAt.get(taskKey) ?? Date.now()
  if (!documentTaskStartedAt.has(taskKey)) documentTaskStartedAt.set(taskKey, startedAt)
  const elapsed = Date.now() - startedAt
  if (elapsed <= 0) return null
  const remainingPercent = 100 - snapshot.percent
  return Math.max(0, Math.round(elapsed / snapshot.percent * remainingPercent))
}

/**
 * 将毫秒时长格式化为紧凑的分钟/秒文本。
 * @param milliseconds 毫秒数。
 * @returns 面向进度栏的时长文本。
 * @author zhenghq
 */
function formatDocumentDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`
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
    renderSnapshot(snapshot, tab)
    renderTaskState(snapshot, tab)
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
  renderSnapshot(snapshot, tab)
  renderTaskState(snapshot, tab)
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

/**
 * 在 OCR 原文与译文模式切换时立即清空目标 Tab 的旧进度和右侧译文预览。
 * 不传参数时重置当前活动页；传入 Tab 时同时清理后台任务状态。
 * 保留 activeJobId 供调用方取消旧任务，避免启动请求尚未返回时丢失取消目标。
 * @param tabs 可选的待重置 Tab。
 * @returns 无返回值。
 * @author zhenghq
 */
function resetDocumentRunForModeSwitch(tab: DocumentWorkspaceTab | null = getActiveDocumentTab()): void {
  if (!tab) return
  tab.snapshot = null
  tab.expectedJobId = null
  tab.status = 'starting'
  if (tab.id !== activeDocumentTabId) {
    renderDocumentTabs()
    return
  }
  if (pendingRenderFrame !== null) {
    cancelAnimationFrame(pendingRenderFrame)
    pendingRenderFrame = null
  }
  latestSnapshot = null
  expectedJobId = null
  refreshActiveTabMirror(tab)
  // 重新启动会推进任务代际；只清理右侧，左侧同一源文档继续复用现有预览。
  clearActiveTabTranslationPreview()
  progressStage.textContent = t('document.progress.preparing')
  progressCount.textContent = t('document.progress.pending')
  progressbar.style.width = '0%'
  progressbar.setAttribute('aria-valuenow', '0')
  exportButton.disabled = true
  retryButton.disabled = true
  partialStatus.hidden = true
  closePartialExportDialog(false)
  syncOcrDisplayModeControls()
}

/**
 * 启动指定文件 Tab 的翻译或 OCR 任务。
 * 所有请求参数均从目标 Tab 捕获，后台 Tab 的启动结果不会覆盖当前可见 Tab。
 * @param tab 要启动的文件 Tab。
 * @returns 启动请求完成后的 Promise。
 * @author zhenghq
 */
async function startDocumentTabTranslation(tab: DocumentWorkspaceTab): Promise<void> {
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
  tab.pendingOcrModeRestart = false
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
    progressStage.textContent = t('document.progress.preparing')
    progressCount.textContent = t('document.progress.pending')
    progressbar.setAttribute('aria-valuenow', '0')
    progressbar.style.width = '0%'
    actualLanguage.textContent = ''
    actualLanguage.hidden = true
    cancelButton.hidden = false
    exportButton.disabled = true
    retryButton.disabled = true
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
      mode
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
        mode
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
      if (tab.pendingOcrModeRestart) {
        const restartJobId = tab.activeJobId ?? tab.expectedJobId
        const restartGeneration = tab.generation
        await cancelDocumentJob(restartJobId, restartGeneration)
        tab.pendingOcrModeRestart = false
        if (restartJobId) await releaseDocumentJob(restartJobId)
        await startDocumentTabTranslation(tab)
      } else if (tab.pendingLanguageRetranslation) {
        tab.pendingLanguageRetranslation = false
        await startDocumentTabTranslation(tab)
      }
      renderDocumentTabs()
    }
  }
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
  if (!snapshot.completionReport?.failedTargetIds.includes(targetId)) return
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
 * 将当前译文导出为 PDF，并把稳定结果映射为界面提示。
 * @returns 无返回值。
 * @author zhenghq
 */
async function exportTranslatedPdf(): Promise<void> {
  const tab = getActiveDocumentTab()
  const snapshot = tab?.snapshot
  if (!tab || !snapshot?.translation) return
  if (isRestoredDocumentTab(tab) || isReadOnlyDocumentTab(tab)) return
  // 导出入口可能在最后一帧译文尚未提交时触发，必须先同步刷新快照，避免导出旧的流式内容。
  flushSnapshotRenderForTab(tab, snapshot)
  await openDocumentExportDialog(snapshot)
}

/**
 * 打开导出对话框，展示布局、未完成项与告警，并保留旧的部分导出二次确认。
 * @param snapshot 当前任务快照。
 * @returns 对话框关闭或导出流程结束后的 Promise。
 * @author zhenghq
 */
async function openDocumentExportDialog(snapshot: DocumentWorkspaceSnapshot): Promise<void> {
  const tab = getActiveDocumentTab()
  if (!tab || tab.snapshot?.jobId !== snapshot.jobId || tab.snapshot.generation !== snapshot.generation) {
    return
  }
  const retryAction = resolveDocumentRetryActionState(snapshot)
  const incomplete = retryAction.reverted
  const complete = snapshot.task.status === 'completed'
  documentExportTarget = { jobId: snapshot.jobId, generation: snapshot.generation }
  documentExportSaved = false
  documentExportPercent = 0
  selectedDocumentExportLayout = exportLayoutBilingual.checked ? 'bilingual' : 'translation'
  exportLayoutTranslation.checked = selectedDocumentExportLayout === 'translation'
  exportLayoutBilingual.checked = selectedDocumentExportLayout === 'bilingual'
  exportIncomplete.textContent = t('document.export.incompleteCount', {
    count: incomplete
  })
  const warningCount = countVisibleDocumentWarnings(
    snapshot.source?.warnings ?? [],
    snapshot.translation?.warnings ?? []
  )
  exportWarningCount.textContent = t('document.export.warningCount', {
    count: warningCount
  })
  exportIncompleteNotice.hidden = complete || incomplete === 0
  exportIncompleteNotice.textContent = t('document.export.partialNotice', {
    count: incomplete
  })
  exportRetryButton.hidden = complete || retryAction.retryDisabled
  exportConfirmButton.disabled = false
  exportConfirmButton.textContent = complete
    ? t('document.export.confirm')
    : t('document.export.confirmPartial')
  exportCancelButton.disabled = false
  exportOpenFolderButton.hidden = true
  exportProgress.hidden = true
  exportProgressStage.textContent = ''
  exportProgressPage.textContent = ''
  exportProgressPercent.textContent = ''
  exportProgressTrack.setAttribute('aria-valuenow', '0')
  exportProgressbar.style.width = '0%'
  if (typeof exportDialog.showModal === 'function') exportDialog.showModal()
  else exportDialog.setAttribute('open', '')
}

/**
 * 更新导出对话框中的阶段、百分比和页级进度。
 * @param progress 主进程推送的受控导出进度。
 * @returns 无返回值。
 * @author zhenghq
 */
function updateDocumentExportProgress(progress: DocumentExportProgress): void {
  if (!documentExportTarget || progress.jobId !== documentExportTarget.jobId ||
    progress.generation !== documentExportTarget.generation) return
  documentExportPercent = Math.max(documentExportPercent, Math.round(progress.percent))
  exportProgress.hidden = false
  exportProgressStage.textContent = t(`document.export.phase.${progress.phase}`)
  exportProgressPage.textContent = progress.completedPages !== undefined && progress.totalPages !== undefined
    ? t('document.export.progressPages', {
      completed: progress.completedPages,
      total: progress.totalPages
    })
    : ''
  exportProgressPercent.textContent = `${documentExportPercent}%`
  exportProgressTrack.setAttribute('aria-valuenow', String(documentExportPercent))
  exportProgressbar.style.width = `${documentExportPercent}%`
  if (progress.warningCount !== undefined) {
    exportWarningCount.textContent = t('document.export.warningCount', {
      count: progress.warningCount
    })
  }
}

/**
 * 关闭导出对话框并清空当前导出身份。
 * @returns 无返回值。
 * @author zhenghq
 */
function closeDocumentExportDialog(): void {
  if (exportDialog.open) exportDialog.close()
  else exportDialog.removeAttribute('open')
  documentExportTarget = null
  documentExportInFlight = false
  documentExportSaved = false
}

/**
 * 提交当前导出对话框选择，完成部分导出确认并等待主进程导出结果。
 * @returns 导出结束后的 Promise。
 * @author zhenghq
 */
async function confirmDocumentExport(): Promise<void> {
  const target = documentExportTarget
  const tab = getActiveDocumentTab()
  const snapshot = tab?.snapshot
  if (!target || !tab || !snapshot || snapshot.jobId !== target.jobId ||
    snapshot.generation !== target.generation || documentExportInFlight) return
  const isComplete = snapshot.task.status === 'completed'
  if (!isComplete) {
    revealFirstIncompleteTarget(snapshot)
    const confirmed = await confirmPartialExport(snapshot)
    if (!confirmed) {
      if (exportDialog.open) exportConfirmButton.focus()
      return
    }
  }
  if (!documentTabs.includes(tab) || tab.generation !== snapshot.generation ||
    documentExportTarget !== target) return
  if (tab.id !== activeDocumentTabId) await activateDocumentTab(tab.id)
  // 打印直接读取当前 DOM；先同步最新终态，避免保存对话框打开前仍显示流式部分译文。
  flushSnapshotRenderForTab(tab, snapshot)
  documentExportInFlight = true
  exportConfirmButton.disabled = true
  exportCancelButton.disabled = false
  exportRetryButton.hidden = true
  exportOpenFolderButton.hidden = true
  try {
    // 使用显式对象分支固定导出语义，避免后续修改把部分结果误标为完整导出。
    const exportMode: Pick<DocumentExportRequest, 'mode'> = isComplete
      ? { mode: 'complete' }
      : { mode: 'partial' }
    const result: DocumentExportResult = await window.api.exportDocumentPdf({
      jobId: snapshot.jobId,
      generation: snapshot.generation,
      mode: exportMode.mode,
      layout: selectedDocumentExportLayout,
      // OCR 原文导出必须保留原图并叠加透明文字层，形成可检索的双层 PDF。
      textLayer: true
    })
    if (!documentTabs.includes(tab) || documentExportTarget !== target) return
    if (result.status === 'saved') {
      documentExportSaved = true
      exportOpenFolderButton.hidden = false
      exportProgressStage.textContent = t('document.export.phase.completed')
      exportProgressPercent.textContent = '100%'
      exportProgressTrack.setAttribute('aria-valuenow', '100')
      exportProgressbar.style.width = '100%'
      partialStatus.textContent = result.warnings && result.warnings.length > 0
        ? `${t('document.export.saved')} ${result.warnings.map(localizeDocumentWarning).join(' ')}`
        : t('document.export.saved')
    } else if (result.status === 'cancelled') {
      partialStatus.textContent = t('document.export.cancelled')
      exportProgressStage.textContent = t('document.export.cancelled')
    } else {
      partialStatus.textContent = result.code === 'font-missing'
        ? t('document.fontMissing')
        : t('document.export.failed')
      exportProgressStage.textContent = t('document.export.failed')
    }
    partialStatus.hidden = false
  } catch {
    partialStatus.textContent = t('document.export.failed')
    partialStatus.hidden = false
    exportProgressStage.textContent = t('document.export.failed')
  } finally {
    documentExportInFlight = false
    if (documentExportTarget === target) {
      exportConfirmButton.disabled = documentExportSaved
      exportConfirmButton.textContent = documentExportSaved
        ? t('document.export.saved')
        : t('document.export.confirm')
      exportCancelButton.disabled = false
      const currentSnapshot = tab.snapshot
      exportButton.disabled = !currentSnapshot || (
        currentSnapshot.task.status !== 'completed' &&
        !hasUsableExportResult(currentSnapshot)
      )
    }
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
 * 按固定步长调整文档缩放，并保持 50% 到 200% 的边界。
 * @param delta 相对当前缩放比例的增量。
 * @returns 无返回值。
 * @author zhenghq
 */
function stepDocumentZoom(delta: number): void {
  setDocumentZoom(Math.round((documentZoom + delta) * 10) / 10)
}

/**
 * 在下一帧按当前可见栏刷新页码控件，等待 DOM 重绘完成后再测量页面位置。
 * @returns 无返回值。
 * @author zhenghq
 */
function scheduleCurrentDocumentPageUpdate(): void {
  const tabId = activeDocumentTabId
  requestAnimationFrame(() => {
    if (tabId === null || tabId !== activeDocumentTabId) return
    const side: DocumentScrollSide = documentViewMode === 'translation' ? 'translation' : 'source'
    updateCurrentDocumentPage(side)
  })
}

/**
 * 计算当前可见文档页，并同步页码输入框与前后页按钮状态。
 * @param side 最近滚动的栏；省略时优先读取原文栏。
 * @returns 当前页面序号，从 1 开始；没有页面时返回 1。
 * @author zhenghq
 */
function updateCurrentDocumentPage(side: DocumentScrollSide = 'source'): number {
  const container = side === 'source' ? sourceContent : translationContent
  const pages = Array.from(container.querySelectorAll<HTMLElement>('[data-page-id], .document-pdf-page[data-page-number]'))
  const total = latestSnapshot?.source?.pages.length ?? pages.length
  if (total < 1) {
    currentDocumentPageNumber = 1
    const tab = getActiveDocumentTab()
    if (tab) tab.pageNumber = currentDocumentPageNumber
    documentPageInput.value = ''
    documentPageInput.max = '1'
    documentPagePreviousButton.disabled = true
    documentPageNextButton.disabled = true
    return currentDocumentPageNumber
  }
  const containerRect = container.getBoundingClientRect()
  let visiblePageIndex = 0
  let visibleDistance = Number.POSITIVE_INFINITY
  pages.forEach((page, index) => {
    const rect = page.getBoundingClientRect()
    if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) return
    const distance = Math.abs(rect.top - containerRect.top)
    if (distance < visibleDistance) {
      visibleDistance = distance
      visiblePageIndex = index
    }
  })
  currentDocumentPageNumber = Math.min(total, Math.max(1, visiblePageIndex + 1))
  const tab = getActiveDocumentTab()
  if (tab) tab.pageNumber = currentDocumentPageNumber
  documentPageInput.value = String(currentDocumentPageNumber)
  documentPageInput.max = String(total)
  documentPagePreviousButton.disabled = currentDocumentPageNumber <= 1
  documentPageNextButton.disabled = currentDocumentPageNumber >= total
  return currentDocumentPageNumber
}

/**
 * 在双栏中定位到页面或区块，并同步双侧高亮。
 * @param target 页码、目录或块级导航目标。
 * @param behavior 滚动动画方式。
 * @returns 是否找到可定位元素。
 * @author zhenghq
 */
function scrollToDocumentTarget(
  target: DocumentNavigationTarget,
  behavior: ScrollBehavior = 'smooth'
): boolean {
  const selectors = [`[data-page-id="${CSS.escape(target.pageId)}"]`, `.document-pdf-page[data-page-number="${target.pageNumber}"]`]
  let found = false
  for (const container of [sourceContent, translationContent]) {
    const page = selectors.map((selector) => container.querySelector<HTMLElement>(selector))
      .find((candidate): candidate is HTMLElement => Boolean(candidate))
    if (!page) continue
    const block = target.blockId
      ? page.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(target.blockId)}"]`) ??
        container.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(target.blockId)}"]`)
      : null
    const destination = block ?? page
    destination.scrollIntoView({ block: 'start', behavior })
    found = true
  }
  currentDocumentPageNumber = target.pageNumber
  const tab = getActiveDocumentTab()
  if (tab) tab.pageNumber = target.pageNumber
  documentPageInput.value = String(target.pageNumber)
  if (target.blockId) highlightDocumentBlock(target.blockId)
  else clearDocumentBlockHighlight()
  const total = latestSnapshot?.source?.pages.length ?? latestSnapshot?.translation?.pages.length ?? 1
  documentPagePreviousButton.disabled = target.pageNumber <= 1
  documentPageNextButton.disabled = target.pageNumber >= total
  if (behavior === 'instant') scheduleCurrentDocumentPageUpdate()
  scheduleDocumentViewerStatePersist()
  return found
}

/**
 * 在双栏中高亮指定稳定区块。
 * @param blockId 待高亮区块标识。
 * @returns 无返回值。
 * @author zhenghq
 */
function highlightDocumentBlock(blockId: string): void {
  // 高亮新区块只替换 DOM 标记，不能先清除随后还要写入 Tab 的持久化锚点。
  clearDocumentBlockDomHighlight()
  activeDocumentBlockId = blockId
  const tab = getActiveDocumentTab()
  if (tab) tab.activeBlockId = blockId
  for (const container of [sourceContent, translationContent]) {
    const blocks = container.querySelectorAll<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`)
    for (const block of blocks) {
      block.classList.add('document-block-active')
      // 双引号属性文本便于调试工具直接搜索活动区块标记。
      block.setAttribute("data-active-block", "true")
    }
  }
  scheduleDocumentViewerStatePersist()
}

/**
 * 清除双栏中的区块高亮及活动区块标记。
 * @returns 无返回值。
 * @author zhenghq
 */
function clearDocumentBlockHighlight(): void {
  const tab = getActiveDocumentTab()
  if (tab) tab.activeBlockId = null
  clearDocumentBlockDomHighlight()
}

/**
 * 仅清除双栏 DOM 中的区块高亮及活动区块标记，保留 Tab 的持久化锚点。
 * @returns 无返回值。
 * @author zhenghq
 */
function clearDocumentBlockDomHighlight(): void {
  for (const container of [sourceContent, translationContent]) {
    for (const block of container.querySelectorAll<HTMLElement>('.document-block-active')) {
      block.classList.remove('document-block-active')
      block.removeAttribute('data-active-block')
    }
  }
  activeDocumentBlockId = null
}

/**
 * 从当前文档模型生成目录项，优先使用显式目录区块，其次使用标题与页面标题。
 * @returns 去重后的目录项。
 * @author zhenghq
 */
function buildDocumentTocEntries(): DocumentTocEntry[] {
  const model = latestSnapshot?.source ?? latestSnapshot?.translation
  if (!model) return []
  const entries: DocumentTocEntry[] = []
  const seen = new Set<string>()
  for (const page of model.pages) {
    for (const block of page.blocks) {
      if (block.kind !== 'text') continue
      const text = block.runs.map((run) => run.text).join('').trim()
      if (!text) continue
      const target = block.toc
        ? resolveDocumentTocTarget(model, text, block.toc.pageNumber)
        : block.role === 'heading' || block.role === 'subtitle'
          ? { pageId: page.pageId, pageIndex: page.index, pageNumber: page.index + 1, blockId: block.blockId }
          : null
      if (!target || seen.has(text)) continue
      seen.add(text)
      entries.push({ title: text, target })
    }
  }
  if (entries.length === 0) {
    for (const page of model.pages) {
      const title = page.title?.trim()
      if (!title || seen.has(title)) continue
      seen.add(title)
      entries.push({
        title,
        target: { pageId: page.pageId, pageIndex: page.index, pageNumber: page.index + 1, blockId: null }
      })
    }
  }
  return entries
}

/**
 * 重新渲染目录列表并同步弹层状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderDocumentToc(): void {
  const entries = buildDocumentTocEntries()
  documentTocList.replaceChildren()
  if (entries.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'document-toc-empty'
    empty.textContent = t('document.toc.empty')
    documentTocList.append(empty)
    return
  }
  for (const entry of entries) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'document-toc-item'
    button.setAttribute('role', 'option')
    button.dataset.tocPage = String(entry.target.pageNumber)
    button.textContent = entry.title
    button.addEventListener('click', () => {
      scrollToDocumentTarget(entry.target)
      setDocumentTocOpen(false)
    })
    documentTocList.append(button)
  }
}

/**
 * 打开或关闭章节目录弹层。
 * @param open 是否展开目录。
 * @param focusButton 关闭时是否把焦点返回目录按钮。
 * @returns 无返回值。
 * @author zhenghq
 */
function setDocumentTocOpen(open: boolean, focusButton = false): void {
  if (open) renderDocumentToc()
  documentTocList.hidden = !open
  documentTocButton.setAttribute('aria-expanded', String(open))
  if (open) documentTocList.querySelector<HTMLButtonElement>('button')?.focus()
  else if (focusButton) documentTocButton.focus()
}

/**
 * 跳转到指定页码；非法或越界输入恢复当前页码。
 * @param value 页码输入文本。
 * @returns 是否成功跳转。
 * @author zhenghq
 */
function jumpToDocumentPage(value: string): boolean {
  const model = latestSnapshot?.source ?? latestSnapshot?.translation
  if (!model) {
    documentPageInput.value = ''
    return false
  }
  const pageNumber = parseDocumentPageNumber(value, model.pages.length)
  const target = resolveDocumentPageJump(model, value)
  if (pageNumber === null || !target) {
    documentPageInput.value = String(currentDocumentPageNumber)
    return false
  }
  return scrollToDocumentTarget(target, 'instant')
}

/**
 * 按当前可见页切换上一页或下一页。
 * @param offset 相对当前页的偏移量。
 * @returns 无返回值。
 * @author zhenghq
 */
function stepDocumentPage(offset: number): void {
  const model = latestSnapshot?.source ?? latestSnapshot?.translation
  if (!model) return
  const nextPage = Math.min(model.pages.length, Math.max(1, currentDocumentPageNumber + offset))
  jumpToDocumentPage(String(nextPage))
}

/**
 * 将当前文档缩放到适合可用宽度。
 * @returns 无返回值。
 * @author zhenghq
 */
function fitDocumentToWidth(): void {
  const model = latestSnapshot?.source ?? latestSnapshot?.translation
  const container = documentViewMode === 'source' ? sourceContent : translationContent
  const renderedPage = container.querySelector<HTMLElement>('[data-page-id], .document-pdf-page[data-page-number]')
  const availableWidth = documentPageContentWidth(container)
  // PDF 源页和流式译文会先按容器宽度排版；使用当前渲染宽度除以用户缩放还原基准宽度，避免重复缩放。
  const renderedWidth = renderedPage?.getBoundingClientRect().width ?? 0
  const baseWidth = renderedWidth > 0 ? renderedWidth / documentZoom : model?.pages[0]?.width
  setDocumentZoom(baseWidth ? resolveFitDocumentZoom(baseWidth, availableWidth) : 1)
}

/**
 * 切换原文与译文双面显示或仅译文单面显示；不中断正在执行的翻译任务。
 * @param nextMode 用户选择的预览方式。
 * @returns 无返回值。
 * @author zhenghq
 */
function setDocumentViewMode(nextMode: DocumentViewMode): void {
  if (documentViewMode === nextMode) return
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
 * 初始化上传交互、拖放、键盘操作与窗口控制。
 * @returns 无返回值。
 * @author zhenghq
 */
async function initializeDocumentWorkspace(): Promise<void> {
  exposeDocumentPrintPreview()
  await initializeWindowTitlebar()
  await initializePlatformCapability()
  await initializeDocumentLanguages()
  await restoreDocumentViewerState()
  await loadDocumentTaskHistory()

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
  exportButton.addEventListener('click', () => void exportTranslatedPdf())
  retryButton.addEventListener('click', () => void retryFailedDocumentTranslation())
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
  exportLayoutTranslation.addEventListener('change', () => {
    if (exportLayoutTranslation.checked) selectedDocumentExportLayout = 'translation'
  })
  exportLayoutBilingual.addEventListener('change', () => {
    if (exportLayoutBilingual.checked) selectedDocumentExportLayout = 'bilingual'
  })
  exportConfirmButton.addEventListener('click', () => void confirmDocumentExport())
  exportRetryButton.addEventListener('click', () => {
    closeDocumentExportDialog()
    void retryFailedDocumentTranslation()
  })
  exportCancelButton.addEventListener('click', () => {
    const target = documentExportTarget
    if (documentExportInFlight && target) {
      void window.api.cancelDocumentExport(target.jobId, target.generation)
      exportCancelButton.disabled = true
      return
    }
    closeDocumentExportDialog()
  })
  exportOpenFolderButton.addEventListener('click', () => {
    const target = documentExportTarget
    if (target) void window.api.openDocumentExportFolder(target.jobId, target.generation)
  })
  exportDialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    if (documentExportInFlight) {
      const target = documentExportTarget
      if (target) void window.api.cancelDocumentExport(target.jobId, target.generation)
      exportCancelButton.disabled = true
      return
    }
    closeDocumentExportDialog()
  })
  exportDialog.addEventListener('close', () => {
    if (!documentExportInFlight) {
      documentExportTarget = null
      documentExportSaved = false
    }
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
      // 展示方式改变即代表新的执行流程：先中断旧任务，再清空旧进度和预览。
      if (tab.startInFlight || tab.pendingOcrModeRestart) {
        // reset 会清空 expectedJobId；必须在重置前捕获旧任务，确保迟到任务仍可取消并释放。
        const jobId = tab.activeJobId ?? tab.expectedJobId
        const jobGeneration = tab.generation
        tab.pendingOcrModeRestart = true
        tab.pendingLanguageRetranslation = false
        refreshActiveTabMirror(tab)
        resetDocumentRunForModeSwitch(tab)
        // 若启动请求已创建任务但尚未返回，这里先尝试取消；finally 会再次按最新 jobId 兜底。
        void cancelDocumentJob(jobId, jobGeneration)
        return
      }
      // reset 会清空 expectedJobId；正常切换也必须先保存旧任务标识，避免资源泄漏。
      const jobId = tab.activeJobId ?? tab.expectedJobId
      const jobGeneration = tab.generation
      await cancelDocumentJob(jobId, jobGeneration)
      if (!documentTabs.includes(tab) || tab.ocrDisplayMode !== nextMode) return
      if (jobId) await releaseDocumentJob(jobId)
      resetDocumentRunForModeSwitch(tab)
      await startDocumentTabTranslation(tab)
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
  setDocumentTocOpen(false)
  documentSyncScrollButton.addEventListener('click', () => {
    setDocumentScrollSync(!documentScrollSyncEnabled)
  })
  documentPageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      jumpToDocumentPage(documentPageInput.value)
      return
    }
    if (event.key !== 'Escape') return
    event.preventDefault()
    documentPageInput.value = String(currentDocumentPageNumber)
    documentPageInput.blur()
  })
  documentPageInput.addEventListener('change', () => jumpToDocumentPage(documentPageInput.value))
  documentPagePreviousButton.addEventListener('click', () => stepDocumentPage(-1))
  documentPageNextButton.addEventListener('click', () => stepDocumentPage(1))
  documentTocButton.addEventListener('click', () => setDocumentTocOpen(documentTocList.hidden))
  documentTocButton.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || documentTocList.hidden) return
    event.preventDefault()
    setDocumentTocOpen(false, true)
  })
  documentTocList.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    setDocumentTocOpen(false, true)
  })
  documentZoomOutButton.addEventListener('click', () => stepDocumentZoom(-0.1))
  documentZoomInButton.addEventListener('click', () => stepDocumentZoom(0.1))
  documentZoomResetButton.addEventListener('click', () => setDocumentZoom(1))
  documentZoomFitButton.addEventListener('click', fitDocumentToWidth)
  documentFileHistory = readDocumentFileHistory()
  renderDocumentHistory()
  // 订阅任务进度前先同步当前 OCR 展示模式，确保启动期间切换模式时旧事件不会污染新状态。
  syncOcrDisplayModeControls()
  window.api.onDocumentProgress((snapshot) => { routeDocumentSnapshot(snapshot, false) })
  window.api.onDocumentExportProgress((progress) => {
    updateDocumentExportProgress(progress)
  })
  window.api.onDocumentBlockTranslated((update: DocumentWorkspaceTranslationUpdate) => {
    const tab = findDocumentTabByTranslationUpdate(update)
    const snapshot = tab?.snapshot
    if (!tab || !snapshot || snapshot.jobId !== update.jobId || snapshot.generation !== update.generation) return
    const next = applyDocumentWorkspaceTranslationUpdate(snapshot, update)
    if (next === snapshot) return
    updateDocumentTabSnapshot(tab, next)
    if (tab.id !== activeDocumentTabId) return
    refreshActiveTabMirror(tab)
    scheduleSnapshotRenderForTab(tab, next)
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
  historyButton.addEventListener('click', () => setDocumentHistoryOpen(historyPopover.hidden))
  documentHistoryClearButton.addEventListener('click', () => {
    setDocumentHistoryConfirmation({ kind: 'clear' }, documentHistoryClearButton)
  })
  documentHistoryConfirmDelete.addEventListener('click', () => void confirmDocumentHistoryAction())
  documentHistoryConfirmCancel.addEventListener('click', () => closeDocumentHistoryConfirmation())
  documentHistoryConfirmDialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    closeDocumentHistoryConfirmation()
  })
  documentHistoryConfirmDialog.addEventListener('close', () => {
    // 原生关闭路径只清理待确认状态；焦点由显式按钮或 cancel 路径恢复，避免重复 focus。
    if (pendingDocumentHistoryAction) closeDocumentHistoryConfirmation(false)
  })
  documentHistorySearch.addEventListener('input', renderDocumentHistory)
  documentHistorySearch.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const firstEntry = visibleDocumentHistory[0]
      if (firstEntry) {
        event.preventDefault()
        void openDocumentHistoryEntry(firstEntry)
      }
      return
    }
    if (event.key !== 'ArrowDown') return
    event.preventDefault()
    documentHistoryList.querySelector<HTMLButtonElement>('[data-history-index]')?.focus()
  })
  documentHistoryList.addEventListener('click', (event) => {
    const actionButton = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-history-action]')
    if (!actionButton) return
    const action = actionButton.dataset.historyAction
    if (action === 'open') {
      const entry = visibleDocumentHistory[Number(actionButton.dataset.historyIndex)]
      if (entry) void openDocumentHistoryEntry(entry)
      return
    }
    if (action !== 'delete') return
    // 先按渲染时写入的 data-history-target-id 查找任务，避免误用文件路径或列表索引。
    const historyTargetId = actionButton.dataset.historyTargetId
    const entry = visibleDocumentHistory.find((candidate) =>
      candidate.kind === 'task' && candidate.jobId === historyTargetId
    )
    if (entry?.kind === 'task') {
      setDocumentHistoryConfirmation({ kind: 'delete', entry: entry.task }, actionButton)
    }
  })
  documentHistoryList.addEventListener('keydown', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-history-action]')
    if (!item) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      item.click()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    // 打开与删除按钮都属于同一键盘导航序列，避免删除操作只能依赖鼠标。
    const buttons = Array.from(documentHistoryList.querySelectorAll<HTMLButtonElement>('[data-history-action]'))
    const currentIndex = buttons.indexOf(item)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (Math.max(0, currentIndex) + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[nextIndex]?.focus()
  })
  document.addEventListener('click', (event) => {
    if (historyPopover.hidden || historyPopover.contains(event.target as Node) || historyButton.contains(event.target as Node)) return
    setDocumentHistoryOpen(false)
  })
  document.addEventListener('click', (event) => {
    if (documentTocList.hidden ||
      documentTocList.contains(event.target as Node) ||
      documentTocButton.contains(event.target as Node)) return
    setDocumentTocOpen(false)
  })
  document.addEventListener('keydown', (event) => {
    // 确认框打开时由原生 cancel 处理 Escape，避免同时关闭其背后的历史面板。
    if (event.key === 'Escape' && !historyPopover.hidden && !documentHistoryConfirmDialog.open) {
      event.preventDefault()
      setDocumentHistoryOpen(false, true)
    }
  })
  localeRuntime.onLocaleChanged(() => {
    renderSelectionState()
    renderDocumentHistory()
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
