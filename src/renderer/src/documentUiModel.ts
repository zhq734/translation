/**
 * 文档工作台界面模型与固定常量。
 */
import type { DocumentWorkspaceSnapshot } from '../../shared/types'
import type { DocumentNavigationTarget, DocumentViewerMode } from './documentViewer'

/** 从本地缓存恢复的工作台固定任务身份。 */
export const RESTORED_DOCUMENT_JOB_ID = 'restored-viewer-state'

/** 任务代际在 Renderer 重载后继续递增，避免主进程拒绝复用旧值。 */
export const DOCUMENT_GENERATION_STORAGE_KEY = 'selection-translator.document-generation'
/** 文档预览方式在窗口重载后保留；损坏或未知值回退为双面显示。 */
export const DOCUMENT_VIEW_MODE_STORAGE_KEY = 'selection-translator.document-view-mode'

/** 文档双栏的渲染侧；译文栏与 OCR 原文展示层分别在各自侧渲染。 */
export type DocumentRenderSide = 'source' | 'translation'

/** 文档双栏滚动位置快照，用于流式重排后恢复用户视口。 */
export interface DocumentScrollPositions {
  /** 原文栏当前滚动位置。 */
  source: number
  /** 译文栏当前滚动位置。 */
  translation: number
}

/** 文档预览按格式采用的渲染方式；HTML 原文使用独立 webview，译文仍采用流式布局。 */
export type DocumentPreviewKind = 'paged' | 'markdown' | 'table' | 'subtitle' | 'flow' | 'html-source'

/** 文档工作台预览方式；双面保留原文与译文对照，单面只显示原文或译文。 */
export type DocumentViewMode = 'source' | 'translation' | 'spread'

/** 目录中的一个可跳转章节项。 */
export interface DocumentTocEntry {
  /** 面向用户的章节标题。 */
  title: string
  /** 跳转目标页面与可选区块。 */
  target: DocumentNavigationTarget
}

/** 文档工作台当前上传状态。 */
export interface DocumentSelectionState {
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
export type DocumentTabStatus = 'idle' | 'starting' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'

/** 文档工作台中的独立文件 Tab；每个 Tab 拥有自己的任务、快照与交互状态。 */
export interface DocumentWorkspaceTab {
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
export const EMPTY_SELECTION: DocumentSelectionState = {
  path: null,
  name: '',
  size: 0,
  format: '',
  sha256: '',
  error: null
}
