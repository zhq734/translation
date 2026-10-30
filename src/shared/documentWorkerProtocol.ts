import type {
  DocumentBlock,
  DocumentTaskPhase,
  DocumentModel,
  DocumentWarning
} from './documentTypes.ts'
import { parseDocumentBlock, parseDocumentModel } from './documentTypes.ts'
import { DOCUMENT_TASK_PHASES } from './documentTask.ts'
import type { DocumentRunMode, DocumentRunRequest } from './documentWorkspace.ts'
import type { DocumentCompletionReport } from './documentCompletion.ts'
import type { DocumentLanguageResolution } from './documentLanguageDirection.ts'
import type { DocumentPartialExportSummary } from './documentPartialExport.ts'

/** 文档 worker 消息协议版本；不兼容变更必须递增。 */
export const DOCUMENT_WORKER_PROTOCOL_VERSION = 1

/** worker 可接收的请求类型。 */
export type DocumentWorkerRequestType = 'run' | 'retry' | 'cancel' | 'export' | 'asset-request'

/** worker 请求消息的公共代际字段。 */
export interface DocumentWorkerRequestEnvelope {
  /** 协议版本。 */
  version: typeof DOCUMENT_WORKER_PROTOCOL_VERSION
  /** 任务标识。 */
  jobId: string
  /** 任务代际。 */
  generation: number
}

/** 启动文档任务的 worker 请求。 */
export interface DocumentWorkerRunRequestMessage extends DocumentWorkerRequestEnvelope {
  /** 请求类型。 */
  type: 'run'
  /** 主进程已校验的运行请求。 */
  request: DocumentRunRequest
}

/** 重试文档任务的 worker 请求。 */
export interface DocumentWorkerRetryRequestMessage extends DocumentWorkerRequestEnvelope {
  /** 请求类型。 */
  type: 'retry'
  /** 主进程已校验的运行请求。 */
  request: DocumentRunRequest
}

/** 取消当前文档任务的 worker 请求。 */
export interface DocumentWorkerCancelRequestMessage extends DocumentWorkerRequestEnvelope {
  /** 请求类型。 */
  type: 'cancel'
}

/** 请求 worker 导出当前任务结果的命令；实际文件写入仍由主进程执行。 */
export interface DocumentWorkerExportRequestMessage extends DocumentWorkerRequestEnvelope {
  /** 请求类型。 */
  type: 'export'
  /** 导出模式与可检索文字层选项。 */
  request: {
    /** 完整导出或用户确认的部分导出。 */
    mode: 'complete' | 'partial'
    /** 是否追加 OCR 原文文字层。 */
    textLayer?: boolean
    /** 导出前复验使用的当前代际完成报告。 */
    completionReport?: DocumentCompletionReport
    /** 用户是否已明确确认保留原文的部分导出。 */
    confirmPartialExport?: boolean
  }
}

/** worker 向主进程请求当前任务已声明的资源字节。 */
export interface DocumentWorkerAssetRequestMessage extends DocumentWorkerRequestEnvelope {
  /** 请求类型。 */
  type: 'asset-request'
  /** 本次资源请求标识，用于关联响应。 */
  requestId: string
  /** 当前任务模型声明的资源标识。 */
  assetId: string
}

/** 文档 worker 请求联合类型。 */
export type DocumentWorkerRequestMessage =
  | DocumentWorkerRunRequestMessage
  | DocumentWorkerRetryRequestMessage
  | DocumentWorkerCancelRequestMessage
  | DocumentWorkerExportRequestMessage
  | DocumentWorkerAssetRequestMessage

/** worker 进度载荷；不携带路径、正文或 OCR 文本。 */
export interface DocumentWorkerProgressPayload {
  /** 聚合后的总进度百分比。 */
  percent: number
  /** 当前任务阶段。 */
  phase: DocumentTaskPhase
  /** 当前阶段已完成单位数。 */
  completed: number
  /** 当前阶段总单位数；未知时为 0。 */
  total: number
  /** 当前页索引。 */
  pageIndex?: number
  /** 当前区块标识。 */
  blockId?: string
  /** 告警数量。 */
  warningCount?: number
}

/** worker 推送的单个已更新区块及其翻译完成计数。 */
export interface DocumentWorkerTranslationUpdatePayload {
  /** 区块所属页面标识。 */
  pageId: string
  /** 更新后的稳定区块标识。 */
  blockId: string
  /** 已完成翻译、可原位替换的区块快照。 */
  block: DocumentBlock
  /** 当前阶段已完成的目标数。 */
  completed: number
  /** 当前阶段可翻译目标总数。 */
  total: number
}

/** worker 推送的首次翻译骨架；后续只发送变化区块，避免重复传输整份模型。 */
export interface DocumentWorkerTranslationSnapshotPayload {
  /** 解析后的源文档模型。 */
  source: DocumentModel
  /** 翻译开始时的完整译文骨架，通常与源文一致。 */
  translation: DocumentModel
  /** 已冻结的语言方向元数据。 */
  languageResolution?: DocumentLanguageResolution
  /** 当前翻译阶段已完成目标数。 */
  completed?: number
  /** 当前翻译阶段目标总数。 */
  total?: number
}

/** worker 导出结果；PDF 字节由主进程负责原子写入。 */
export interface DocumentWorkerExportPayload {
  /** 生成的 PDF 字节。 */
  bytes: Uint8Array
  /** 导出期间产生的可降级告警。 */
  warnings: DocumentWarning[]
  /** 部分导出回退摘要；完整导出时省略。 */
  partial?: DocumentPartialExportSummary
}

/** worker 成功终态载荷；复杂模型由后续增量消息承载。 */
export interface DocumentWorkerResultPayload {
  /** 任务终态。 */
  status: 'completed' | 'partial' | 'failed'
  /** 聚合后的总进度百分比。 */
  percent: number
  /** 稳定错误分类，仅失败时提供。 */
  errorCode?: string
  /** 解析后的源文档模型。 */
  source?: DocumentModel
  /** 当前代际的译文模型。 */
  translation?: DocumentModel
  /** 用户语言偏好与冻结的实际语言方向。 */
  languageResolution?: DocumentLanguageResolution
  /** 当前代际的完整完成报告。 */
  completionReport?: DocumentCompletionReport
  /** 失败、未完成与疑似未翻译目标组成的可重试集合。 */
  retryableTargetIds?: string[]
  /** 本次任务运行模式；OCR 原文模式不会执行翻译。 */
  runMode?: DocumentRunMode
  /** 导出成功时返回的 PDF 结果。 */
  export?: DocumentWorkerExportPayload
}

/** worker 失败终态载荷。 */
export interface DocumentWorkerFailurePayload {
  /** 稳定错误分类。 */
  code: string
  /** 已脱敏、可安全记录的说明。 */
  message: string
}

/** worker 进度消息。 */
export interface DocumentWorkerProgressMessage extends DocumentWorkerRequestEnvelope {
  /** 消息类型。 */
  type: 'progress'
  /** 进度载荷。 */
  payload: DocumentWorkerProgressPayload
}

/** worker 块级增量译文消息；成功区块无需等待整份文档完成即可展示。 */
export interface DocumentWorkerTranslationUpdateMessage extends DocumentWorkerRequestEnvelope {
  /** 消息类型。 */
  type: 'translation-update'
  /** 更新区块与目标完成计数。 */
  payload: DocumentWorkerTranslationUpdatePayload
}

/** worker 首次发送的完整翻译骨架消息；属于非终态增量事件。 */
export interface DocumentWorkerTranslationSnapshotMessage extends DocumentWorkerRequestEnvelope {
  /** 消息类型。 */
  type: 'translation-snapshot'
  /** 完整源文、译文骨架与可选语言方向。 */
  payload: DocumentWorkerTranslationSnapshotPayload
}

/** worker 成功终态消息。 */
export interface DocumentWorkerResultMessage extends DocumentWorkerRequestEnvelope {
  /** 消息类型。 */
  type: 'result'
  /** 成功终态载荷。 */
  payload: DocumentWorkerResultPayload
}

/** worker 失败终态消息。 */
export interface DocumentWorkerFailureMessage extends DocumentWorkerRequestEnvelope {
  /** 消息类型。 */
  type: 'failure'
  /** 失败载荷。 */
  payload: DocumentWorkerFailurePayload
}

/** worker 取消终态消息。 */
export interface DocumentWorkerCancelledMessage extends DocumentWorkerRequestEnvelope {
  /** 消息类型。 */
  type: 'cancelled'
  /** 取消载荷。 */
  payload: {
    /** 取消原因分类。 */
    code: 'cancelled'
  }
}

/** 主进程返回给 worker 的资源读取结果；失败时只携带稳定分类。 */
export interface DocumentWorkerAssetResultMessage extends DocumentWorkerRequestEnvelope {
  /** 消息类型。 */
  type: 'asset-result'
  /** 对应资源请求标识。 */
  requestId: string
  /** 对应资源标识。 */
  assetId: string
  /** 成功时的资源 MIME。 */
  mimeType?: string
  /** 成功时的资源字节。 */
  bytes?: Uint8Array
  /** 失败时的稳定错误分类。 */
  code?: string
}

/** 文档 worker 响应联合类型。 */
export type DocumentWorkerResponseMessage =
  | DocumentWorkerProgressMessage
  | DocumentWorkerTranslationSnapshotMessage
  | DocumentWorkerTranslationUpdateMessage
  | DocumentWorkerResultMessage
  | DocumentWorkerFailureMessage
  | DocumentWorkerCancelledMessage
  | DocumentWorkerAssetResultMessage

/** worker 响应类型白名单。 */
const DOCUMENT_WORKER_RESPONSE_TYPES = new Set([
  'progress',
  'translation-snapshot',
  'translation-update',
  'result',
  'failure',
  'cancelled',
  'asset-result'
])

/** 资源读取失败时允许返回的稳定错误分类。 */
const DOCUMENT_WORKER_ASSET_RESULT_CODES = new Set([
  'asset-not-found',
  'asset-unavailable'
])

/**
 * 判断值是否为非空对象。
 * @param value 待检查值。
 * @returns 是否为对象。
 * @author zhenghq
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 判断请求是否携带合法公共代际字段。
 * @param value 待检查值。
 * @returns 是否通过基础校验。
 * @author zhenghq
 */
function hasRequestEnvelope(value: unknown): value is Record<string, unknown> & {
  version: typeof DOCUMENT_WORKER_PROTOCOL_VERSION
  jobId: string
  generation: number
  type: DocumentWorkerRequestType
} {
  return isRecord(value) &&
    value.version === DOCUMENT_WORKER_PROTOCOL_VERSION &&
    typeof value.jobId === 'string' &&
    value.jobId.trim().length > 0 &&
    Number.isInteger(value.generation) &&
    Number(value.generation) >= 1 &&
    (value.type === 'run' || value.type === 'retry' || value.type === 'cancel' ||
      value.type === 'export' || value.type === 'asset-request')
}

/**
 * 判断值是否为不含路径片段的受控标识。
 * @param value 待检查值。
 * @returns 是否为合法标识。
 * @author zhenghq
 */
function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    !value.includes('/') && !value.includes('\\') && !value.includes('..') &&
    !value.includes('\u0000')
}

/**
 * 判断响应是否携带合法公共代际字段。
 * @param value 待检查值。
 * @returns 是否通过基础校验。
 * @author zhenghq
 */
function hasResponseEnvelope(value: unknown): value is Record<string, unknown> & {
  version: typeof DOCUMENT_WORKER_PROTOCOL_VERSION
  jobId: string
  generation: number
  type: DocumentWorkerResponseMessage['type']
} {
  return isRecord(value) &&
    value.version === DOCUMENT_WORKER_PROTOCOL_VERSION &&
    typeof value.jobId === 'string' &&
    value.jobId.trim().length > 0 &&
    Number.isInteger(value.generation) &&
    Number(value.generation) >= 1 &&
    typeof value.type === 'string' &&
    DOCUMENT_WORKER_RESPONSE_TYPES.has(value.type)
}

/**
 * 判断值是否为有限进度数字。
 * @param value 待检查值。
 * @param minimum 允许的最小值。
 * @param maximum 允许的最大值。
 * @returns 是否为范围内有限数字。
 * @author zhenghq
 */
function isBoundedNumber(value: unknown, minimum: number, maximum = Number.POSITIVE_INFINITY): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

/**
 * 校验并解析 worker 进度载荷。
 * @param value 未信任载荷。
 * @returns 合法进度载荷或 null。
 * @author zhenghq
 */
function parseProgressPayload(value: unknown): DocumentWorkerProgressPayload | null {
  if (!isRecord(value) ||
    !isBoundedNumber(value.percent, 0, 100) ||
    typeof value.phase !== 'string' ||
    !DOCUMENT_TASK_PHASES.includes(value.phase as DocumentTaskPhase) ||
    !Number.isInteger(value.completed) || Number(value.completed) < 0 ||
    !Number.isInteger(value.total) || Number(value.total) < 0) return null
  if (Number(value.total) > 0 && Number(value.completed) > Number(value.total)) return null
  if (value.pageIndex !== undefined && (!Number.isInteger(value.pageIndex) || Number(value.pageIndex) < 0)) return null
  if (value.blockId !== undefined && (typeof value.blockId !== 'string' || !value.blockId.trim())) return null
  if (value.warningCount !== undefined && (!Number.isInteger(value.warningCount) || Number(value.warningCount) < 0)) return null
  return {
    percent: Number(value.percent),
    phase: value.phase as DocumentTaskPhase,
    completed: Number(value.completed),
    total: Number(value.total),
    ...(value.pageIndex !== undefined ? { pageIndex: Number(value.pageIndex) } : {}),
    ...(value.blockId !== undefined ? { blockId: String(value.blockId) } : {}),
    ...(value.warningCount !== undefined ? { warningCount: Number(value.warningCount) } : {})
  }
}

/**
 * 校验并解析块级增量译文载荷。
 * @param value 未信任载荷。
 * @returns 合法增量载荷或 null。
 * @author zhenghq
 */
function parseTranslationUpdatePayload(value: unknown): DocumentWorkerTranslationUpdatePayload | null {
  if (!isRecord(value) ||
    !isSafeIdentifier(value.pageId) ||
    !isSafeIdentifier(value.blockId) ||
    !Number.isInteger(value.completed) || Number(value.completed) < 0 ||
    !Number.isInteger(value.total) || Number(value.total) < 1 ||
    Number(value.completed) > Number(value.total)) return null
  let block: DocumentBlock
  try {
    block = parseDocumentBlock(value.block)
  } catch {
    return null
  }
  if (block.blockId !== value.blockId) return null
  return {
    pageId: value.pageId,
    blockId: value.blockId,
    block,
    completed: Number(value.completed),
    total: Number(value.total)
  }
}

/**
 * 校验并解析首次翻译骨架载荷。
 * @param value 未信任载荷。
 * @returns 合法骨架载荷或 null。
 * @author zhenghq
 */
function parseTranslationSnapshotPayload(value: unknown): DocumentWorkerTranslationSnapshotPayload | null {
  if (!isRecord(value)) return null
  let source: DocumentModel
  let translation: DocumentModel
  try {
    source = parseDocumentModel(value.source)
    translation = parseDocumentModel(value.translation)
  } catch {
    return null
  }
  if (value.completed !== undefined && (!Number.isInteger(value.completed) || Number(value.completed) < 0)) {
    return null
  }
  if (value.total !== undefined && (!Number.isInteger(value.total) || Number(value.total) < 0)) {
    return null
  }
  if (value.completed !== undefined && value.total !== undefined &&
    Number(value.total) > 0 && Number(value.completed) > Number(value.total)) return null
  if (value.languageResolution !== undefined && !isRecord(value.languageResolution)) return null
  return {
    source,
    translation,
    ...(value.languageResolution !== undefined
      ? { languageResolution: value.languageResolution as unknown as DocumentLanguageResolution }
      : {}),
    ...(value.completed !== undefined ? { completed: Number(value.completed) } : {}),
    ...(value.total !== undefined ? { total: Number(value.total) } : {})
  }
}

/**
 * 校验并解析 worker 导出载荷。
 * @param value 未信任载荷。
 * @returns 合法导出载荷或 null。
 * @author zhenghq
 */
function parseExportPayload(value: unknown): DocumentWorkerExportPayload | null {
  if (!isRecord(value) || !(value.bytes instanceof Uint8Array) || !Array.isArray(value.warnings)) return null
  if (value.partial !== undefined && !isRecord(value.partial)) return null
  return value as unknown as DocumentWorkerExportPayload
}

/**
 * 校验并解析 worker 成功终态载荷。
 * @param value 未信任载荷。
 * @returns 合法终态载荷或 null。
 * @author zhenghq
 */
function parseResultPayload(value: unknown): DocumentWorkerResultPayload | null {
  if (!isRecord(value) ||
    (value.status !== 'completed' && value.status !== 'partial' && value.status !== 'failed') ||
    !isBoundedNumber(value.percent, 0, 100)) return null
  if (value.errorCode !== undefined && (typeof value.errorCode !== 'string' || !value.errorCode.trim())) return null
  let source: DocumentModel | undefined
  let translation: DocumentModel | undefined
  if (value.source !== undefined) {
    try {
      source = parseDocumentModel(value.source)
    } catch {
      return null
    }
  }
  if (value.translation !== undefined) {
    try {
      translation = parseDocumentModel(value.translation)
    } catch {
      return null
    }
  }
  if (value.languageResolution !== undefined && !isRecord(value.languageResolution)) return null
  if (value.completionReport !== undefined && !isRecord(value.completionReport)) return null
  if (value.retryableTargetIds !== undefined &&
    (!Array.isArray(value.retryableTargetIds) || value.retryableTargetIds.some((item) => typeof item !== 'string'))) {
    return null
  }
  if (value.runMode !== undefined && value.runMode !== 'translation' && value.runMode !== 'ocr') return null
  const exportPayload = value.export === undefined ? undefined : parseExportPayload(value.export)
  if (value.export !== undefined && !exportPayload) return null
  return {
    status: value.status,
    percent: Number(value.percent),
    ...(value.errorCode !== undefined ? { errorCode: String(value.errorCode) } : {}),
    ...(source ? { source } : {}),
    ...(translation ? { translation } : {}),
    ...(value.languageResolution !== undefined
      ? { languageResolution: value.languageResolution as unknown as DocumentLanguageResolution }
      : {}),
    ...(value.completionReport !== undefined
      ? { completionReport: value.completionReport as unknown as DocumentCompletionReport }
      : {}),
    ...(value.retryableTargetIds !== undefined
      ? { retryableTargetIds: (value.retryableTargetIds as unknown[]).map(String) }
      : {}),
    ...(value.runMode !== undefined ? { runMode: value.runMode } : {}),
    ...(exportPayload ? { export: exportPayload } : {})
  }
}

/**
 * 校验并解析父进程收到的 worker 响应。
 * @param value 未信任的消息值。
 * @returns 合法响应或 null。
 * @author zhenghq
 */
export function parseDocumentWorkerResponse(value: unknown): DocumentWorkerResponseMessage | null {
  if (!hasResponseEnvelope(value) || !isRecord(value.payload)) return null
  if (value.type === 'progress') {
    const payload = parseProgressPayload(value.payload)
    return payload ? {
      version: DOCUMENT_WORKER_PROTOCOL_VERSION,
      type: 'progress',
      jobId: value.jobId,
      generation: value.generation,
      payload
    } : null
  }
  if (value.type === 'translation-snapshot') {
    const payload = parseTranslationSnapshotPayload(value.payload)
    return payload ? {
      version: DOCUMENT_WORKER_PROTOCOL_VERSION,
      type: 'translation-snapshot',
      jobId: value.jobId,
      generation: value.generation,
      payload
    } : null
  }
  if (value.type === 'translation-update') {
    const payload = parseTranslationUpdatePayload(value.payload)
    return payload ? {
      version: DOCUMENT_WORKER_PROTOCOL_VERSION,
      type: 'translation-update',
      jobId: value.jobId,
      generation: value.generation,
      payload
    } : null
  }
  if (value.type === 'result') {
    const payload = parseResultPayload(value.payload)
    return payload ? {
      version: DOCUMENT_WORKER_PROTOCOL_VERSION,
      type: 'result',
      jobId: value.jobId,
      generation: value.generation,
      payload
    } : null
  }
  if (value.type === 'failure') {
    if (typeof value.payload.code !== 'string' || !value.payload.code.trim() ||
      typeof value.payload.message !== 'string' || !value.payload.message.trim()) return null
    return {
      version: DOCUMENT_WORKER_PROTOCOL_VERSION,
      type: 'failure',
      jobId: value.jobId,
      generation: value.generation,
      payload: {
        code: value.payload.code,
        message: value.payload.message
      }
    }
  }
  if (value.payload.code !== 'cancelled') return null
  return {
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'cancelled',
    jobId: value.jobId,
    generation: value.generation,
    payload: { code: 'cancelled' }
  }
}

/**
 * 判断值是否为合法 worker 响应。
 * @param value 待检查值。
 * @returns 是否合法。
 * @author zhenghq
 */
export function isDocumentWorkerResponseMessage(value: unknown): value is DocumentWorkerResponseMessage {
  return parseDocumentWorkerResponse(value) !== null
}

/**
 * 校验并解析主进程返回的资源结果。
 * @param value 未信任消息。
 * @returns 合法资源结果或 null。
 * @author zhenghq
 */
export function parseDocumentWorkerAssetResult(value: unknown): DocumentWorkerAssetResultMessage | null {
  if (!isRecord(value) || value.version !== DOCUMENT_WORKER_PROTOCOL_VERSION ||
    value.type !== 'asset-result' || typeof value.jobId !== 'string' || !value.jobId.trim() ||
    !Number.isInteger(value.generation) || Number(value.generation) < 1 ||
    !isSafeIdentifier(value.requestId) || !isSafeIdentifier(value.assetId)) {
    return null
  }
  if (value.mimeType !== undefined && (typeof value.mimeType !== 'string' || !value.mimeType.trim())) {
    return null
  }
  if (value.bytes !== undefined && !(value.bytes instanceof Uint8Array)) return null
  if (value.code !== undefined &&
    (typeof value.code !== 'string' || !DOCUMENT_WORKER_ASSET_RESULT_CODES.has(value.code))) {
    return null
  }
  if ((value.bytes === undefined) === (value.code === undefined)) return null
  return {
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'asset-result',
    jobId: value.jobId,
    generation: Number(value.generation),
    requestId: value.requestId,
    assetId: value.assetId,
    ...(value.mimeType !== undefined ? { mimeType: String(value.mimeType) } : {}),
    ...(value.bytes !== undefined ? { bytes: value.bytes as Uint8Array } : {}),
    ...(value.code !== undefined ? { code: String(value.code) } : {})
  }
}

/**
 * 判断值是否为合法资源结果消息。
 * @param value 待检查值。
 * @returns 是否合法。
 * @author zhenghq
 */
export function isDocumentWorkerAssetResultMessage(value: unknown): value is DocumentWorkerAssetResultMessage {
  return parseDocumentWorkerAssetResult(value) !== null
}

/**
 * 校验并解析 worker 请求；非法消息返回 null，由宿主统一回送脱敏错误。
 * @param value 未信任的消息值。
 * @returns 合法请求或 null。
 * @author zhenghq
 */
export function parseDocumentWorkerRequest(value: unknown): DocumentWorkerRequestMessage | null {
  if (!hasRequestEnvelope(value)) return null
  if (value.type === 'asset-request') {
    if (!isSafeIdentifier(value.requestId) || !isSafeIdentifier(value.assetId)) return null
    return {
      version: DOCUMENT_WORKER_PROTOCOL_VERSION,
      type: 'asset-request',
      jobId: value.jobId,
      generation: value.generation,
      requestId: value.requestId,
      assetId: value.assetId
    }
  }
  if (value.type === 'cancel') {
    return {
      version: DOCUMENT_WORKER_PROTOCOL_VERSION,
      type: 'cancel',
      jobId: value.jobId,
      generation: value.generation
    }
  }
  if (!isRecord(value.request)) return null
  if (value.type === 'export') {
    if (value.request.mode !== 'complete' && value.request.mode !== 'partial') return null
    if (value.request.completionReport !== undefined && !isRecord(value.request.completionReport)) return null
    return {
      version: DOCUMENT_WORKER_PROTOCOL_VERSION,
      type: 'export',
      jobId: value.jobId,
      generation: value.generation,
      request: {
        mode: value.request.mode,
        ...(typeof value.request.textLayer === 'boolean'
          ? { textLayer: value.request.textLayer }
          : {}),
        ...(isRecord(value.request.completionReport)
          ? { completionReport: value.request.completionReport as unknown as DocumentCompletionReport }
          : {}),
        ...(typeof value.request.confirmPartialExport === 'boolean'
          ? { confirmPartialExport: value.request.confirmPartialExport }
          : {})
      }
    }
  }
  const request = value.request
  if (typeof request.path !== 'string' || !request.path.trim() ||
    !Number.isInteger(request.generation) || Number(request.generation) < 1) return null
  if (request.mode !== undefined && request.mode !== 'ocr' && request.mode !== 'translation') {
    return null
  }
  return {
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: value.type,
    jobId: value.jobId,
    generation: value.generation,
    request: {
      path: request.path,
      generation: Number(request.generation),
      ...(typeof request.sourceLang === 'string' ? { sourceLang: request.sourceLang } : {}),
      ...(typeof request.targetLang === 'string' ? { targetLang: request.targetLang } : {}),
      ...(request.mode === 'ocr' || request.mode === 'translation' ? { mode: request.mode } : {})
    }
  }
}

/**
 * 判断值是否为合法 worker 请求。
 * @param value 待检查值。
 * @returns 是否合法。
 * @author zhenghq
 */
export function isDocumentWorkerRequestMessage(value: unknown): value is DocumentWorkerRequestMessage {
  return parseDocumentWorkerRequest(value) !== null
}

/**
 * 将错误映射为稳定 worker 错误分类。
 * @param error 捕获的异常。
 * @returns 稳定错误码。
 * @author zhenghq
 */
export function resolveDocumentWorkerErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') {
    return 'cancelled'
  }
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code) {
    return error.code
  }
  return 'worker-failed'
}

/**
 * 生成不含路径、正文和原始异常信息的脱敏错误说明。
 * @param error 捕获的异常。
 * @returns 可安全传输和记录的说明。
 * @author zhenghq
 */
export function sanitizeDocumentWorkerError(error: unknown): string {
  const code = resolveDocumentWorkerErrorCode(error)
  if (code === 'cancelled') return 'worker operation cancelled'
  if (code === 'worker-failed') return 'worker operation failed'
  const category = code.replace(/[^a-z0-9-]+/giu, '-').replace(/^-+|-+$/gu, '') || 'worker'
  return `${category.replace(/-failed$/u, '').replace(/-+$/u, '') || 'worker'} failed`
}

/**
 * 创建 worker 进度消息。
 * @param jobId 任务标识。
 * @param generation 任务代际。
 * @param payload 进度载荷。
 * @returns 进度消息。
 * @author zhenghq
 */
export function createDocumentWorkerProgressMessage(
  jobId: string,
  generation: number,
  payload: DocumentWorkerProgressPayload
): DocumentWorkerProgressMessage {
  return {
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'progress',
    jobId,
    generation,
    payload
  }
}

/**
 * 创建 worker 块级增量译文消息。
 * @param jobId 任务标识。
 * @param generation 任务代际。
 * @param payload 区块快照与目标完成计数。
 * @returns 块级增量译文消息。
 * @author zhenghq
 */
export function createDocumentWorkerTranslationUpdateMessage(
  jobId: string,
  generation: number,
  payload: DocumentWorkerTranslationUpdatePayload
): DocumentWorkerTranslationUpdateMessage {
  return {
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'translation-update',
    jobId,
    generation,
    payload
  }
}

/**
 * 创建 worker 首次翻译骨架消息。
 * @param jobId 任务标识。
 * @param generation 任务代际。
 * @param payload 完整源文、译文骨架与可选语言方向。
 * @returns 翻译骨架消息。
 * @author zhenghq
 */
export function createDocumentWorkerTranslationSnapshotMessage(
  jobId: string,
  generation: number,
  payload: DocumentWorkerTranslationSnapshotPayload
): DocumentWorkerTranslationSnapshotMessage {
  return {
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'translation-snapshot',
    jobId,
    generation,
    payload
  }
}

/**
 * 创建 worker 成功终态消息。
 * @param jobId 任务标识。
 * @param generation 任务代际。
 * @param payload 终态载荷。
 * @returns 成功终态消息。
 * @author zhenghq
 */
export function createDocumentWorkerResultMessage(
  jobId: string,
  generation: number,
  payload: DocumentWorkerResultPayload
): DocumentWorkerResultMessage {
  return {
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'result',
    jobId,
    generation,
    payload
  }
}

/**
 * 创建 worker 失败终态消息。
 * @param jobId 任务标识。
 * @param generation 任务代际。
 * @param code 稳定错误分类。
 * @returns 失败终态消息。
 * @author zhenghq
 */
export function createDocumentWorkerFailureMessage(
  jobId: string,
  generation: number,
  code: string
): DocumentWorkerFailureMessage {
  return {
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'failure',
    jobId,
    generation,
    payload: {
      code,
      message: sanitizeDocumentWorkerError({ code })
    }
  }
}

/**
 * 创建 worker 取消终态消息。
 * @param jobId 任务标识。
 * @param generation 任务代际。
 * @returns 取消终态消息。
 * @author zhenghq
 */
export function createDocumentWorkerCancelledMessage(
  jobId: string,
  generation: number
): DocumentWorkerCancelledMessage {
  return {
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'cancelled',
    jobId,
    generation,
    payload: { code: 'cancelled' }
  }
}

/**
 * 创建 worker 向主进程发起的资源请求。
 * @param jobId 任务标识。
 * @param generation 任务代际。
 * @param requestId 资源请求标识。
 * @param assetId 已声明资源标识。
 * @returns 资源请求消息。
 * @author zhenghq
 */
export function createDocumentWorkerAssetRequestMessage(
  jobId: string,
  generation: number,
  requestId: string,
  assetId: string
): DocumentWorkerAssetRequestMessage {
  return {
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'asset-request',
    jobId,
    generation,
    requestId,
    assetId
  }
}

/**
 * 创建主进程返回的资源结果。
 * @param jobId 任务标识。
 * @param generation 任务代际。
 * @param requestId 对应资源请求标识。
 * @param assetId 对应资源标识。
 * @param payload 成功字节与 MIME，或失败分类。
 * @returns 资源结果消息。
 * @author zhenghq
 */
export function createDocumentWorkerAssetResultMessage(
  jobId: string,
  generation: number,
  requestId: string,
  assetId: string,
  payload: { mimeType?: string; bytes?: Uint8Array; code?: string }
): DocumentWorkerAssetResultMessage {
  return {
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'asset-result',
    jobId,
    generation,
    requestId,
    assetId,
    ...(payload.mimeType !== undefined ? { mimeType: payload.mimeType } : {}),
    ...(payload.bytes !== undefined ? { bytes: payload.bytes } : {}),
    ...(payload.code !== undefined ? { code: payload.code } : {})
  }
}
