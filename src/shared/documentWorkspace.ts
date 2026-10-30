import type { DocumentModel, DocumentWarning } from './documentTypes.ts'
import type { DocumentTaskState } from './documentTask.ts'
import type { DocumentLanguagePair } from './documentLanguageDirection.ts'
import type { DocumentCompletionReport } from './documentCompletion.ts'

/** 文档工作台任务请求；路径必须来自当前窗口已批准的文件选择结果。 */
export interface DocumentRunRequest {
  /** 已由主进程校验并批准的本机文件路径。 */
  path: string
  /** Renderer 生成的任务代际，用于隔离迟到事件。 */
  generation: number
  /** 可选源语言。 */
  sourceLang?: string
  /** 可选目标语言。 */
  targetLang?: string
}

/** 主进程推送给文档工作台的任务快照。 */
export interface DocumentWorkspaceSnapshot {
  /** 任务标识。 */
  jobId: string
  /** 任务代际。 */
  generation: number
  /** 当前任务状态。 */
  task: DocumentTaskState
  /** 聚合后的总进度百分比。 */
  percent: number
  /** 源文档模型；校验或解析完成前可以省略。 */
  source?: DocumentModel
  /** 翻译后的文档模型；翻译完成前可以省略。 */
  translation?: DocumentModel
  /** 用户选择的原始源语言偏好；完成方向解析后返回。 */
  sourcePreference?: string
  /** 用户选择的原始目标语言偏好；完成方向解析后返回。 */
  targetPreference?: string
  /** 本任务冻结并在所有批次、回退与重试中复用的实际语言对。 */
  languagePair?: DocumentLanguagePair
  /** 当前任务代际对应的完整完成报告。 */
  completionReport?: DocumentCompletionReport
  /** 翻译阶段失败且可安全重试的块数量。 */
  retryableFailedBlocks?: number
  /** 脱敏错误分类。 */
  errorCode?: string
}

/** 当前任务完成报告的只读历史快照，用于恢复审阅与后续历史列表接入。 */
export interface DocumentHistoryEntry {
  /** 任务标识。 */
  jobId: string
  /** 快照对应的任务代际。 */
  generation: number
  /** 该代际生成的完整完成报告。 */
  completionReport?: DocumentCompletionReport
}

/** 文档任务启动结果。 */
export interface DocumentRunResult {
  /** 是否已接受任务。 */
  accepted: boolean
  /** 接受时返回任务标识。 */
  jobId?: string
  /** 拒绝时返回稳定错误分类。 */
  code?: string
  /** 代际冲突时返回主进程可安全采用的下一个任务代际。 */
  suggestedGeneration?: number
}

/** PDF 导出请求；任务标识、代际和显式模式共同构成导出授权。 */
export interface DocumentExportRequest {
  /** 发起导出的任务标识。 */
  jobId: string
  /** 发起导出的任务代际。 */
  generation: number
  /** 完整导出或用户明确确认的部分导出。 */
  mode: 'complete' | 'partial'
}

/** PDF 导出结果。 */
export interface DocumentExportResult {
  /** 导出结果分类。 */
  status: 'saved' | 'cancelled' | 'rejected'
  /** 失败或拒绝时的稳定错误分类。 */
  code?: string
  /** 导出成功但存在可降级问题时返回的告警。 */
  warnings?: DocumentWarning[]
}

/** 文档图片资源读取结果；失败时不携带原始路径。 */
export interface DocumentAssetResult {
  /** 是否读取成功。 */
  ok: boolean
  /** 成功时返回资源 MIME。 */
  mimeType?: string
  /** 成功时返回资源字节。 */
  bytes?: Uint8Array
  /** 失败时的稳定错误分类。 */
  code?: string
}

/** 文档源文件读取结果；仅用于当前任务的原生预览，不暴露本地路径。 */
export interface DocumentSourceResult {
  /** 是否读取成功。 */
  ok: boolean
  /** 成功时返回源文件 MIME。 */
  mimeType?: string
  /** 成功时返回源文件字节。 */
  bytes?: Uint8Array
  /** 失败时的稳定错误分类。 */
  code?: string
}

/** 文档工作台 IPC 通道名称。 */
export const DOCUMENT_WORKSPACE_CHANNELS = {
  run: 'document:run',
  cancel: 'document:cancel',
  retryFailed: 'document:retry-failed',
  exportPdf: 'document:export-pdf',
  getAsset: 'document:get-asset',
  getSource: 'document:get-source',
  progress: 'document:progress',
  completed: 'document:completed'
} as const
