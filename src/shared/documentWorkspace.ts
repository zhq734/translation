import type {
  DocumentBoundingBox,
  DocumentModel,
  DocumentWarning
} from './documentTypes.ts'
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

/** 文档任务身份请求；取消、释放与历史操作只允许携带稳定任务标识和代际。 */
export interface DocumentTaskIdentityRequest {
  /** 当前任务标识。 */
  jobId: string
  /** 当前任务代际；重试和导出必须使用同一代际。 */
  generation: number
}

/**
 * 校验并规范化文档任务身份请求。
 *
 * 任务标识只接受有界、非控制字符的稳定字符串，避免 Renderer 将路径、URL
 * 或命令内容伪装为任务标识。代际必须是安全正整数。
 * @param value 未信任的任务身份请求。
 * @returns 规范化任务身份；字段非法时返回 null。
 * @author zhenghq
 */
export function normalizeDocumentTaskIdentityRequest(
  value: unknown
): DocumentTaskIdentityRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.jobId !== 'string' || !candidate.jobId.trim() ||
    candidate.jobId.length > 256 || /[\u0000-\u001f\u007f]/u.test(candidate.jobId)) {
    return null
  }
  if (!Number.isSafeInteger(candidate.generation) || (candidate.generation as number) < 1) {
    return null
  }
  return { jobId: candidate.jobId, generation: candidate.generation as number }
}

/**
 * 校验并规范化文档目标标识。
 *
 * 目标标识必须是非空、有界且不含控制字符的稳定键；具体是否存在于当前文档
 * 由任务服务结合完成报告与文档模型再次确认。
 * @param value 未信任的目标标识。
 * @returns 规范化目标标识；非法时返回 null。
 * @author zhenghq
 */
export function normalizeDocumentTargetId(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)) return null
  return value
}

/**
 * 判断字符串中是否包含不可用于本机文件路径的控制字符或命令注入片段。
 * @param value 待检查路径。
 * @returns 含有空字节、换行或命令替换片段时返回 true。
 * @author zhenghq
 */
function hasUnsafeDocumentPathCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value) || value.includes('$(') || value.includes('`')
}

/**
 * 校验并规范化来自 Renderer 的文档运行请求。
 *
 * 只保留路径、代际、语言和运行模式白名单字段；URL、额外路径字段与命令内容
 * 均不会进入任务服务。绝对路径仍由主进程使用平台 path 模块再次确认。
 * @param value 未信任的运行请求。
 * @returns 规范化请求；字段非法时返回 null。
 * @author zhenghq
 */
export function normalizeDocumentRunRequest(value: unknown): DocumentRunRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.path !== 'string' || !candidate.path.trim() ||
    candidate.path.length > 32_768 || hasUnsafeDocumentPathCharacters(candidate.path)) {
    return null
  }
  if (candidate.path.startsWith('file:') || candidate.path.includes('://')) return null
  // 共享层只做跨平台的基础形态检查；Windows 盘符、UNC 与 POSIX 绝对路径均交给
  // 主进程 isAbsolute 做最终平台判定，避免把命令名或普通相对路径送入任务服务。
  if (!candidate.path.startsWith('/') && !candidate.path.startsWith('\\\\') &&
    !/^[A-Za-z]:[\\/]/u.test(candidate.path)) return null
  if (!Number.isSafeInteger(candidate.generation) || (candidate.generation as number) < 1) return null
  if (candidate.mode !== undefined && candidate.mode !== 'translation' && candidate.mode !== 'ocr') {
    return null
  }
  const normalizeLanguage = (field: unknown): string | undefined | null => {
    if (field === undefined) return undefined
    if (typeof field !== 'string' || !field.trim() || field.length > 32 ||
      /[\u0000-\u001f\u007f]/u.test(field)) return null
    return field.trim()
  }
  const sourceLang = normalizeLanguage(candidate.sourceLang)
  const targetLang = normalizeLanguage(candidate.targetLang)
  if (sourceLang === null || targetLang === null) return null
  return {
    path: candidate.path,
    generation: candidate.generation as number,
    ...(sourceLang !== undefined ? { sourceLang } : {}),
    ...(targetLang !== undefined ? { targetLang } : {}),
    ...(candidate.mode !== undefined ? { mode: candidate.mode } : {})
  }
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

/** PDF 导出布局；译文模式仅输出译文，双语模式按原页与译文页并排输出。 */
export type DocumentExportLayout = 'translation' | 'bilingual'

/** PDF 导出进度阶段。 */
export type DocumentExportPhase = 'preparing' | 'composing' | 'writing' | 'completed'

/** PDF 导出进度事件；仅携带任务身份与聚合计数，不包含路径或正文。 */
export interface DocumentExportProgress {
  /** 所属任务标识。 */
  jobId: string
  /** 所属任务代际。 */
  generation: number
  /** 当前导出阶段。 */
  phase: DocumentExportPhase
  /** 导出总进度百分比，必须单调不减。 */
  percent: number
  /** 已完成页面数。 */
  completedPages?: number
  /** 总页面数。 */
  totalPages?: number
  /** 当前已收集的告警数量。 */
  warningCount?: number
}

/** 文档导出取消请求；只允许携带当前任务身份。 */
export interface DocumentExportCancelRequest {
  /** 所属任务标识。 */
  jobId: string
  /** 所属任务代际。 */
  generation: number
}

/** 打开导出文件所在目录的请求；路径由主进程白名单决定。 */
export type DocumentOpenExportFolderRequest = DocumentExportCancelRequest

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
  /** 导出布局；省略时保持仅译文 PDF。 */
  layout?: DocumentExportLayout
}

/** PDF 导出结果。 */
export interface DocumentExportResult {
  /** 导出结果分类。 */
  status: 'saved' | 'cancelled' | 'rejected'
  /** 失败或拒绝时的稳定错误分类。 */
  code?: string
  /** 导出成功但存在可降级问题时返回的告警。 */
  warnings?: DocumentWarning[]
  /** 导出成功时主进程记录的最终文件路径。 */
  filePath?: string
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

/** 只读历史/恢复 Tab 的受控源文件请求；路径必须已在当前文档窗口重新授权。 */
export interface DocumentApprovedSourceRequest {
  /** 已由主进程批准的本机绝对路径。 */
  path: string
  /** 快照记录的源文件 SHA-256，用于阻止读取已被替换的文件。 */
  sourceSha256: string
  /** 快照记录的源文件字节数。 */
  sourceSize: number
  /** 快照记录的文档格式；主进程仍会按实际文件内容重新识别。 */
  format: import('./documentTypes.ts').DocumentFormat
}

/** 只读历史/恢复 Tab 的受控资源请求；资源元数据必须与快照完全一致。 */
export interface DocumentApprovedAssetRequest extends DocumentApprovedSourceRequest {
  /** 解析阶段生成的稳定资源标识。 */
  assetId: string
  /** 资源内容 SHA-256。 */
  assetSha256: string
  /** 资源字节数。 */
  assetByteLength: number
  /** DOCX/EPUB 包内相对路径；独立图片文档可省略。 */
  storageKey?: string
  /** 快照记录的资源 MIME 类型。 */
  mimeType?: string
  /** PDF 图片所在页面索引；PDF 资源恢复必须提供。 */
  pageIndex?: number
  /** PDF 图片在页面中的原始边界；用于重新解析后定位同一资源。 */
  bbox?: DocumentBoundingBox
}

/** 文档工作台 IPC 通道名称。 */
export const DOCUMENT_WORKSPACE_CHANNELS = {
  run: 'document:run',
  cancel: 'document:cancel',
  release: 'document:release',
  retryFailed: 'document:retry-failed',
  retryFailedTarget: 'document:retry-failed-target',
  exportPdf: 'document:export-pdf',
  exportProgress: 'document:export-progress',
  cancelExport: 'document:cancel-export',
  openExportFolder: 'document:open-export-folder',
  listHistory: 'document:list-history',
  openHistory: 'document:open-history',
  deleteHistory: 'document:delete-history',
  clearCache: 'document:clear-cache',
  getAsset: 'document:get-asset',
  getSource: 'document:get-source',
  getApprovedAsset: 'document:get-approved-asset',
  getApprovedSource: 'document:get-approved-source',
  progress: 'document:progress',
  blockTranslated: 'document:block-translated',
  completed: 'document:completed'
} as const

/**
 * 校验并规范化来自 Renderer 的 PDF 导出请求。
 * 只保留任务身份、模式和布局等白名单字段，忽略任何路径、URL 或命令。
 * @param value 未信任的导出请求。
 * @returns 规范化请求；字段非法时返回 null。
 * @author zhenghq
 */
export function normalizeDocumentExportRequest(value: unknown): DocumentExportRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const identity = normalizeDocumentTaskIdentityRequest(candidate)
  if (!identity) return null
  if (candidate.mode !== 'complete' && candidate.mode !== 'partial') return null
  if (candidate.layout !== undefined &&
    candidate.layout !== 'translation' && candidate.layout !== 'bilingual') return null
  if (candidate.textLayer !== undefined && typeof candidate.textLayer !== 'boolean') return null
  return {
    jobId: identity.jobId,
    generation: identity.generation,
    mode: candidate.mode,
    layout: candidate.layout === 'bilingual' ? 'bilingual' : 'translation',
    ...(candidate.textLayer !== undefined ? { textLayer: candidate.textLayer } : {})
  }
}

/**
 * 创建经过边界校验的导出进度事件。
 * @param jobId 所属任务标识。
 * @param generation 所属任务代际。
 * @param progress 导出阶段与计数。
 * @returns 可安全发送给 Renderer 的进度事件。
 * @throws RangeError 当阶段、百分比或计数超出允许范围时抛出。
 * @author zhenghq
 */
export function createDocumentExportProgress(
  jobId: string,
  generation: number,
  progress: Omit<DocumentExportProgress, 'jobId' | 'generation'>
): DocumentExportProgress {
  const value = { jobId, generation, ...progress }
  const normalized = parseDocumentExportProgress(value)
  if (!normalized) throw new RangeError('invalid-document-export-progress')
  return normalized
}

/**
 * 严格解析来自 worker 或 IPC 的导出进度事件。
 * @param value 未信任的进度值。
 * @returns 只含白名单字段的进度事件；字段非法时返回 null。
 * @author zhenghq
 */
export function parseDocumentExportProgress(value: unknown): DocumentExportProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const identity = normalizeDocumentTaskIdentityRequest(candidate)
  if (!identity) return null
  if (candidate.phase !== 'preparing' && candidate.phase !== 'composing' &&
    candidate.phase !== 'writing' && candidate.phase !== 'completed') return null
  if (typeof candidate.percent !== 'number' || !Number.isFinite(candidate.percent) ||
    candidate.percent < 0 || candidate.percent > 100) return null
  const optionalCount = (field: unknown): field is number | undefined => (
    field === undefined || (typeof field === 'number' && Number.isInteger(field) && field >= 0)
  )
  if (!optionalCount(candidate.completedPages) || !optionalCount(candidate.totalPages) ||
    !optionalCount(candidate.warningCount)) return null
  if (candidate.completedPages !== undefined && candidate.totalPages !== undefined &&
    candidate.completedPages > candidate.totalPages) return null
  return {
    jobId: identity.jobId,
    generation: identity.generation,
    phase: candidate.phase,
    percent: candidate.percent,
    ...(candidate.completedPages !== undefined ? { completedPages: candidate.completedPages } : {}),
    ...(candidate.totalPages !== undefined ? { totalPages: candidate.totalPages } : {}),
    ...(candidate.warningCount !== undefined ? { warningCount: candidate.warningCount } : {})
  }
}

/**
 * 校验取消导出请求并丢弃 Renderer 注入的任何额外字段。
 * @param value 未信任的取消请求。
 * @returns 规范化任务身份；字段非法时返回 null。
 * @author zhenghq
 */
export function normalizeDocumentExportCancelRequest(value: unknown): DocumentExportCancelRequest | null {
  return normalizeDocumentTaskIdentityRequest(value)
}

/**
 * 校验打开导出目录请求；实际路径始终由主进程成功导出记录提供。
 * @param value 未信任的打开目录请求。
 * @returns 规范化任务身份；字段非法时返回 null。
 * @author zhenghq
 */
export function normalizeDocumentOpenExportFolderRequest(
  value: unknown
): DocumentOpenExportFolderRequest | null {
  return normalizeDocumentExportCancelRequest(value)
}

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
