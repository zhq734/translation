import type { DocumentModel, DocumentWarning } from './documentTypes.ts'
import type { DocumentTaskState } from './documentTask.ts'
import type { DocumentLanguagePair } from './documentLanguageDirection.ts'
import type { DocumentCompletionReport } from './documentCompletion.ts'

/** 文档工作台运行模式；OCR 原文模式只解析和识别，不进入翻译阶段。 */
export type DocumentRunMode = 'translation' | 'ocr'

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
  /** 运行模式；省略时保持现有译文流程。 */
  mode?: DocumentRunMode
}

/** 主进程推送给文档工作台的任务快照。 */
export interface DocumentWorkspaceSnapshot {
  /** 任务标识。 */
  jobId: string
  /** 任务代际。 */
  generation: number
  /** 当前任务状态。 */
  task: DocumentTaskState
  /** 当前任务实际运行模式；旧快照省略时视为译文模式。 */
  runMode?: DocumentRunMode
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
  /** 当前代际由翻译缓存直接恢复的目标标识。 */
  cacheHitTargetIds?: string[]
  /** 翻译阶段失败且可安全重试的块数量。 */
  retryableFailedBlocks?: number
  /** 脱敏错误分类。 */
  errorCode?: string
}

/** worker 推送的单个顶层译文区块及其阶段完成计数。 */
export interface DocumentWorkspaceTranslationUpdate {
  /** 所属任务标识。 */
  jobId: string
  /** 所属任务代际。 */
  generation: number
  /** 区块所属页面标识。 */
  pageId: string
  /** 更新后的稳定区块标识。 */
  blockId: string
  /** 已完成翻译的顶层区块快照。 */
  block: import('./documentTypes.ts').DocumentBlock
  /** 当前翻译阶段已完成的目标数。 */
  completed: number
  /** 当前翻译阶段目标总数。 */
  total: number
}

/** 历史列表中的安全任务摘要；不包含正文、源路径或资源字节。 */
export interface DocumentHistoryEntry {
  /** 任务标识。 */
  jobId: string
  /** 快照对应的任务代际。 */
  generation: number
  /** 面向界面的源文件名。 */
  fileName: string
  /** 源文档格式。 */
  format: import('./documentTypes.ts').DocumentFormat
  /** 用户选择的原始源语言偏好。 */
  sourcePreference: string
  /** 用户选择的原始目标语言偏好。 */
  targetPreference: string
  /** 文档级解析后的实际语言对。 */
  languagePair: DocumentLanguagePair
  /** 最近一次终态。 */
  status: DocumentTaskState['status']
  /** 最近一次终态进度百分比。 */
  percent: number
  /** 最近更新时间，用于倒序排列。 */
  updatedAt: number
  /** 当前代际是否已成功导出 PDF。 */
  exportStatus: 'not-exported' | 'saved'
  /** 该代际生成的完整完成报告；旧兼容调用可省略。 */
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
  /** 是否在图片上追加透明 OCR 原文文字层，生成可检索的双层 PDF。 */
  textLayer?: boolean
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
  release: 'document:release',
  retryFailed: 'document:retry-failed',
  retryFailedTarget: 'document:retry-failed-target',
  exportPdf: 'document:export-pdf',
  getAsset: 'document:get-asset',
  getSource: 'document:get-source',
  progress: 'document:progress',
  blockTranslated: 'document:block-translated',
  completed: 'document:completed'
} as const

/**
 * 将块级译文原位合并到当前工作台快照。
 * 仅接受当前任务、非终态且匹配顶层区块的增量；输入快照不会被修改。
 * @param snapshot 当前工作台快照。
 * @param update 已通过 worker 协议校验的块级增量。
 * @returns 合并后的新快照；不可应用时返回原快照。
 * @author zhenghq
 */
export function applyDocumentWorkspaceTranslationUpdate(
  snapshot: DocumentWorkspaceSnapshot,
  update: DocumentWorkspaceTranslationUpdate
): DocumentWorkspaceSnapshot {
  if (!snapshot || !update || snapshot.jobId !== update.jobId ||
    snapshot.generation !== update.generation || !snapshot.translation ||
    snapshot.task.status === 'completed' || snapshot.task.status === 'partial' ||
    snapshot.task.status === 'failed' || snapshot.task.status === 'cancelled') {
    return snapshot
  }
  if (update.block.blockId !== update.blockId ||
    !Number.isInteger(update.completed) || update.completed < 0 ||
    !Number.isInteger(update.total) || update.total < 1 || update.completed > update.total) {
    return snapshot
  }
  const pageIndex = snapshot.translation.pages.findIndex((page) => page.pageId === update.pageId)
  if (pageIndex < 0) return snapshot
  const page = snapshot.translation.pages[pageIndex]!
  const blockIndex = page.blocks.findIndex((block) => block.blockId === update.blockId)
  if (blockIndex < 0) return snapshot
  const pages = snapshot.translation.pages.slice()
  pages[pageIndex] = {
    ...page,
    blocks: page.blocks.map((block, index) => index === blockIndex ? update.block : block)
  }
  return {
    ...snapshot,
    translation: {
      ...snapshot.translation,
      pages
    },
    task: {
      ...snapshot.task,
      progress: {
        completed: update.completed,
        total: update.total
      }
    }
  }
}
