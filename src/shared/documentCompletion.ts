import type { DocumentLanguagePair } from './documentLanguageDirection.ts'
import type { DocumentTaskStatus } from './documentTypes.ts'
import type { DocumentWorkspaceSnapshot } from './documentWorkspace.ts'

/** 文档任务的不可逆终态。 */
const DOCUMENT_WORKSPACE_TERMINAL_STATUSES: ReadonlySet<DocumentTaskStatus> = new Set([
  'completed',
  'partial',
  'cancelled',
  'failed'
])

/** 单个可翻译目标进入完成报告前的终态。 */
export type DocumentCompletionTargetState =
  | 'translated'
  | 'unchanged'
  | 'failed'
  | 'pending'
  | 'suspect-untranslated'

/** 单个目标完成校验所需的最小信息。 */
export interface DocumentCompletionTarget {
  /** 任务内稳定目标标识。 */
  targetId: string
  /** 目标原文。 */
  sourceText: string
  /** 目标译文；失败或未完成时可以省略。 */
  translatedText?: string
  /** 目标级运行终态。 */
  state: DocumentCompletionTargetState
  /** 失败原因；来自流水线的稳定错误分类。 */
  failureReason?: string
  /** 必须原样保留在译文中的占位符或保护片段。 */
  protectedSpans?: string[]
  /** 表格行能否可靠拆回单元格；未提供时视为有效。 */
  tableMappingValid?: boolean
}

/** 构造完成报告所需的输入。 */
export interface EvaluateDocumentCompletionInput {
  /** 当前任务标识。 */
  jobId: string
  /** 当前任务代际。 */
  generation: number
  /** 当前文档模型标识。 */
  documentId: string
  /** 翻译提供方与模型的稳定指纹。 */
  modelFingerprint: string
  /** 用户选择的源语言偏好。 */
  sourcePreference: string
  /** 用户选择的目标语言偏好。 */
  targetPreference: string
  /** 本任务冻结的实际语言对。 */
  languagePair: DocumentLanguagePair
  /** 全部可翻译目标。 */
  targets: DocumentCompletionTarget[]
  /** 任务是否已被取消；取消优先于目标计数。 */
  cancelled?: boolean
}

/** 文档完成报告状态。 */
export type DocumentCompletionStatus = 'completed' | 'partial' | 'failed' | 'cancelled'

/** 目标级完成报告，用于任务终态和导出前复验。 */
export interface DocumentCompletionReport {
  /** 当前任务标识。 */
  jobId: string
  /** 当前任务代际。 */
  generation: number
  /** 当前文档模型标识。 */
  documentId: string
  /** 翻译提供方与模型的稳定指纹。 */
  modelFingerprint: string
  /** 完成报告状态。 */
  status: DocumentCompletionStatus
  /** 全部可翻译目标数。 */
  total: number
  /** 成功产生译文的目标数。 */
  translated: number
  /** 原文已满足目标语言、无需翻译的目标数。 */
  unchanged: number
  /** 失败目标数。 */
  failed: number
  /** 尚未完成的目标数。 */
  pending: number
  /** 疑似未翻译目标数。 */
  suspectUntranslated: number
  /** 失败目标标识，按输入顺序排列。 */
  failedTargetIds: string[]
  /** 未完成目标标识，按输入顺序排列。 */
  pendingTargetIds: string[]
  /** 疑似未翻译目标标识，按输入顺序排列。 */
  suspectUntranslatedTargetIds: string[]
  /** 目标级失败或疑似未翻译原因。 */
  failureReasons: Record<string, string>
  /** 用户选择的源语言偏好。 */
  sourcePreference: string
  /** 用户选择的目标语言偏好。 */
  targetPreference: string
  /** 本任务冻结的实际语言对。 */
  languagePair: DocumentLanguagePair
}

/** 导出前复验所需的当前模型身份与计数。 */
export interface DocumentCompletionExpectation {
  /** 当前任务标识。 */
  jobId: string
  /** 当前任务代际。 */
  generation: number
  /** 当前文档模型标识。 */
  documentId: string
  /** 当前翻译提供方与模型指纹。 */
  modelFingerprint: string
  /** 当前模型的可翻译目标总数。 */
  total: number
  /** 当前模型中的成功译文数。 */
  translated: number
  /** 当前模型中的无需翻译数。 */
  unchanged: number
  /** 当前模型中的失败数。 */
  failed: number
  /** 当前模型中的未完成数。 */
  pending: number
  /** 当前模型中的疑似未翻译数。 */
  suspectUntranslated: number
}

/** 完成报告复验结果。 */
export type DocumentCompletionValidationResult =
  | { ok: true }
  | { ok: false; code: 'completion-mismatch'; reason: string }

/** 判定疑似未翻译所需的最小拉丁字母数。 */
const SCRIPT_CHECK_MIN_LATIN_LETTERS = 40

/** 判定疑似未翻译所需的最小中文字符数。 */
const SCRIPT_CHECK_MIN_CHINESE_CHARACTERS = 20

/** 译文仍以源语言脚本为主时允许的最大源脚本占比。 */
const SOURCE_SCRIPT_DOMINANCE_RATIO = 0.75

/** 中文目标至少需要出现的 CJK 占比，低于该值视为未完成目标语言转换。 */
const CHINESE_TARGET_MIN_CJK_RATIO = 0.25

/** 常见占位符与受保护协议标记。 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\{\{[^{}\n]+\}\}/gu,
  /\$\{[^{}\n]+\}/gu,
  /\[\[\[[^\]\n]+\]\]\]/gu,
  /%\{[^{}\n]+\}/gu,
  /%[sdif]/gu
]

/**
 * 统计文本中指定正则表达式的匹配数量。
 * @param text 待统计文本。
 * @param pattern 全局正则表达式。
 * @returns 匹配数量。
 * @author zhenghq
 */
function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length
}

/**
 * 提取目标原文和显式保护片段中必须保留的占位符。
 * @param target 目标级完成信息。
 * @returns 按出现次数累计的占位符计数表。
 * @author zhenghq
 */
function collectRequiredPlaceholders(target: DocumentCompletionTarget): Map<string, number> {
  const required = new Map<string, number>()
  const collect = (text: string): void => {
    for (const pattern of PLACEHOLDER_PATTERNS) {
      pattern.lastIndex = 0
      for (const match of text.matchAll(pattern)) {
        const token = match[0]
        required.set(token, (required.get(token) ?? 0) + 1)
      }
    }
  }
  collect(target.sourceText)
  for (const span of target.protectedSpans ?? []) collect(span)
  return required
}

/**
 * 校验译文中要求保留的占位符没有丢失或重复。
 * @param target 目标级完成信息。
 * @param translation 目标译文。
 * @returns 占位符完整时返回 true。
 * @author zhenghq
 */
function hasValidPlaceholders(target: DocumentCompletionTarget, translation: string): boolean {
  const required = collectRequiredPlaceholders(target)
  for (const [token, expectedCount] of required) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const actualCount = countMatches(translation, new RegExp(escaped, 'gu'))
    if (actualCount !== expectedCount) return false
  }
  return true
}

/**
 * 去掉不应参与语言脚本比例判断的 URL、邮箱、行内代码和受保护标记。
 * @param text 待归一化文本。
 * @returns 仅保留自然语言正文的文本。
 * @author zhenghq
 */
function stripNonLanguageText(text: string): string {
  return text
    .replace(/https?:\/\/[^\s<>"']+/giu, ' ')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gu, ' ')
    .replace(/`[^`\n]+`/gu, ' ')
    .replace(/\[\[\[[^\]\n]+\]\]\]/gu, ' ')
    .replace(/\{\{[^{}\n]+\}\}/gu, ' ')
    .replace(/\$\{[^{}\n]+\}/gu, ' ')
    .replace(/\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z]+_[A-Za-z0-9_]+|[A-Za-z]+\d+[A-Za-z0-9]*)\b/gu, ' ')
}

/**
 * 判断正文是否具有足够上下文，避免把短标题和专有名词误判为未翻译。
 * @param text 原文或译文。
 * @returns 文本是否达到段落级判断条件。
 * @author zhenghq
 */
function hasParagraphContext(text: string): boolean {
  const words = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)?/gu) ?? []
  const chineseCharacters = countMatches(text, /[\u3400-\u9fff]/gu)
  if (chineseCharacters >= SCRIPT_CHECK_MIN_CHINESE_CHARACTERS) return true
  if (words.length >= 7) return true
  return words.length >= 4 && /[.!?;:。！？；：]/u.test(text)
}

/**
 * 判断目标语言是否已经出现在译文中，避免把混合技术术语误判为未翻译。
 * @param translation 目标译文。
 * @param targetLang 实际目标语言。
 * @returns 译文是否至少包含目标语言主体。
 * @author zhenghq
 */
function containsTargetLanguage(translation: string, targetLang: string): boolean {
  const chineseCharacters = countMatches(translation, /[\u3400-\u9fff]/gu)
  const latinLetters = countMatches(translation, /[A-Za-z]/gu)
  const meaningfulCharacters = chineseCharacters + latinLetters
  if (meaningfulCharacters === 0) return true
  if (targetLang === 'ZH') return chineseCharacters / meaningfulCharacters >= CHINESE_TARGET_MIN_CJK_RATIO
  if (targetLang === 'EN') return chineseCharacters / meaningfulCharacters < (1 - SOURCE_SCRIPT_DOMINANCE_RATIO)
  return true
}

/**
 * 判断原文本身是否已经以目标语言为主，用于把模型原样返回的内容归为无需翻译。
 * @param sourceText 目标原文。
 * @param targetLang 实际目标语言。
 * @returns 原文已达到目标语言主体条件时返回 true。
 * @author zhenghq
 */
function sourceAlreadyUsesTargetLanguage(sourceText: string, targetLang: string): boolean {
  const text = stripNonLanguageText(sourceText)
  if (!text.trim()) return false
  return containsTargetLanguage(text, targetLang)
}

/**
 * 判断翻译结果是否仍明显以源语言脚本为主。
 * @param sourceText 目标原文。
 * @param translatedText 模型返回的译文。
 * @param languagePair 本任务冻结的实际语言对。
 * @returns 仅在保守阈值内确认疑似未翻译时返回 true。
 * @author zhenghq
 */
export function isLikelyUntranslatedTranslation(
  sourceText: string,
  translatedText: string,
  languagePair: DocumentLanguagePair
): boolean {
  const sourceLang = languagePair.sourceLang.toUpperCase()
  const targetLang = languagePair.targetLang.toUpperCase()
  const englishToChinese = (sourceLang === 'EN' || sourceLang === 'AUTO') && targetLang === 'ZH'
  const chineseToEnglish = (sourceLang === 'ZH' || sourceLang === 'AUTO') && targetLang === 'EN'
  if (!englishToChinese && !chineseToEnglish) return false

  const source = stripNonLanguageText(sourceText)
  const translation = stripNonLanguageText(translatedText)
  if (!translation.trim() || !hasParagraphContext(source)) return false

  if (englishToChinese) {
    const chineseCharacters = countMatches(translation, /[\u3400-\u9fff]/gu)
    const latinLetters = countMatches(translation, /[A-Za-z]/gu)
    const meaningfulCharacters = chineseCharacters + latinLetters
    if (latinLetters < SCRIPT_CHECK_MIN_LATIN_LETTERS || meaningfulCharacters === 0) return false
    return latinLetters / meaningfulCharacters >= SOURCE_SCRIPT_DOMINANCE_RATIO &&
      !containsTargetLanguage(translation, targetLang)
  }

  const chineseCharacters = countMatches(translation, /[\u3400-\u9fff]/gu)
  const latinLetters = countMatches(translation, /[A-Za-z]/gu)
  const meaningfulCharacters = chineseCharacters + latinLetters
  if (chineseCharacters < SCRIPT_CHECK_MIN_CHINESE_CHARACTERS || meaningfulCharacters === 0) return false
  return chineseCharacters / meaningfulCharacters >= SOURCE_SCRIPT_DOMINANCE_RATIO &&
    !containsTargetLanguage(translation, targetLang)
}

/**
 * 对单个目标执行空译文、占位符、表格映射和疑似未翻译校验。
 * @param target 目标级完成信息。
 * @param languagePair 本任务冻结的实际语言对。
 * @returns 最终分类与稳定原因。
 * @author zhenghq
 */
function classifyTarget(
  target: DocumentCompletionTarget,
  languagePair: DocumentLanguagePair
): { state: DocumentCompletionTargetState; reason?: string } {
  if (target.state === 'failed') {
    return { state: 'failed', reason: target.failureReason ?? 'translation-failed' }
  }
  if (target.state === 'pending') return { state: 'pending', reason: 'translation-pending' }
  if (target.state === 'suspect-untranslated') {
    return { state: 'suspect-untranslated', reason: target.failureReason ?? 'suspect-untranslated' }
  }
  if (target.state === 'unchanged') return { state: 'unchanged' }

  const translation = target.translatedText ?? ''
  if (!translation.trim()) return { state: 'failed', reason: 'empty-translation' }
  const targetLang = languagePair.targetLang.toUpperCase()
  if ((targetLang === 'ZH' || targetLang === 'EN') &&
    sourceAlreadyUsesTargetLanguage(target.sourceText, targetLang) &&
    translation.trim() === target.sourceText.trim()) {
    return { state: 'unchanged' }
  }
  if (target.tableMappingValid === false) {
    return { state: 'failed', reason: 'table-mapping-failed' }
  }
  if (!hasValidPlaceholders(target, translation)) {
    return { state: 'failed', reason: 'placeholder-mismatch' }
  }
  if (isLikelyUntranslatedTranslation(target.sourceText, translation, languagePair)) {
    return { state: 'suspect-untranslated', reason: 'suspect-untranslated' }
  }
  return { state: 'translated' }
}

/**
 * 汇总全部目标状态并生成完成报告。
 * @param input 当前任务身份、语言对和目标状态。
 * @returns 可用于任务终态与导出复验的完成报告。
 * @author zhenghq
 */
export function evaluateDocumentCompletion(
  input: EvaluateDocumentCompletionInput
): DocumentCompletionReport {
  const failedTargetIds: string[] = []
  const pendingTargetIds: string[] = []
  const suspectUntranslatedTargetIds: string[] = []
  const failureReasons: Record<string, string> = {}
  let translated = 0
  let unchanged = 0

  for (const target of input.targets) {
    const classified = classifyTarget(target, input.languagePair)
    if (classified.reason) failureReasons[target.targetId] = classified.reason
    if (classified.state === 'translated') translated += 1
    else if (classified.state === 'unchanged') unchanged += 1
    else if (classified.state === 'pending') pendingTargetIds.push(target.targetId)
    else if (classified.state === 'suspect-untranslated') {
      suspectUntranslatedTargetIds.push(target.targetId)
    } else {
      failedTargetIds.push(target.targetId)
    }
  }

  const failed = failedTargetIds.length
  const pending = pendingTargetIds.length
  const suspectUntranslated = suspectUntranslatedTargetIds.length
  const hasUnfinished = failed + pending + suspectUntranslated > 0
  const status: DocumentCompletionStatus = input.cancelled
    ? 'cancelled'
    : !hasUnfinished
      ? 'completed'
      : translated + unchanged > 0
        ? 'partial'
        : 'failed'

  return {
    jobId: input.jobId,
    generation: input.generation,
    documentId: input.documentId,
    modelFingerprint: input.modelFingerprint,
    status,
    total: input.targets.length,
    translated,
    unchanged,
    failed,
    pending,
    suspectUntranslated,
    failedTargetIds,
    pendingTargetIds,
    suspectUntranslatedTargetIds,
    failureReasons,
    sourcePreference: input.sourcePreference,
    targetPreference: input.targetPreference,
    languagePair: { ...input.languagePair }
  }
}

/**
 * 在导出前复验完成报告与当前任务、代际、文档模型、模型指纹及计数一致。
 * @param report 待复验的完成报告。
 * @param expected 当前模型身份与计数。
 * @returns 通过时返回 ok，否则返回稳定 completion-mismatch 分类。
 * @author zhenghq
 */
export function validateDocumentCompletionReport(
  report: DocumentCompletionReport,
  expected: DocumentCompletionExpectation
): DocumentCompletionValidationResult {
  if (report.jobId !== expected.jobId) {
    return { ok: false, code: 'completion-mismatch', reason: 'job-id-mismatch' }
  }
  if (report.generation !== expected.generation) {
    return { ok: false, code: 'completion-mismatch', reason: 'generation-mismatch' }
  }
  if (report.documentId !== expected.documentId) {
    return { ok: false, code: 'completion-mismatch', reason: 'document-id-mismatch' }
  }
  if (report.modelFingerprint !== expected.modelFingerprint) {
    return { ok: false, code: 'completion-mismatch', reason: 'model-fingerprint-mismatch' }
  }
  const countFields: Array<keyof Pick<DocumentCompletionExpectation,
    'total' | 'translated' | 'unchanged' | 'failed' | 'pending' | 'suspectUntranslated'>> = [
    'total',
    'translated',
    'unchanged',
    'failed',
    'pending',
    'suspectUntranslated'
  ]
  for (const field of countFields) {
    if (report[field] !== expected[field]) {
      return { ok: false, code: 'completion-mismatch', reason: `${field}-mismatch` }
    }
  }
  if (report.total !== report.translated + report.unchanged + report.failed +
    report.pending + report.suspectUntranslated) {
    return { ok: false, code: 'completion-mismatch', reason: 'count-invariant-mismatch' }
  }
  return { ok: true }
}

/**
 * 判断工作台快照是否已进入不可回退的终态。
 * @param snapshot 待判断的快照。
 * @returns 是否为 completed、partial、cancelled 或 failed。
 * @author zhenghq
 */
function isTerminalWorkspaceSnapshot(snapshot: DocumentWorkspaceSnapshot): boolean {
  return DOCUMENT_WORKSPACE_TERMINAL_STATUSES.has(snapshot.task.status)
}

/**
 * 选择应保留的工作台快照；终态一旦出现，迟到快照不得覆盖状态、进度或译文。
 * @param current 当前已接受的快照。
 * @param incoming 新到达的进度或完成快照。
 * @returns 应保留的快照；拒绝迟到或跨代际事件时返回当前快照。
 * @author zhenghq
 */
export function selectDocumentWorkspaceSnapshot(
  current: DocumentWorkspaceSnapshot,
  incoming: DocumentWorkspaceSnapshot
): DocumentWorkspaceSnapshot {
  if (incoming.jobId !== current.jobId) return current
  if (incoming.generation < current.generation) return current
  if (incoming.task.generation !== incoming.generation) return current
  // 同一终态再次发送时只允许补全缺失元数据；任务、进度和译文已由先到达的
  // 终态冻结，不能被迟到流式快照整体替换。
  if (isTerminalWorkspaceSnapshot(current)) {
    if (incoming.task.status !== current.task.status) return current
    const completed: Partial<DocumentWorkspaceSnapshot> = {}
    if (current.source === undefined && incoming.source !== undefined) completed.source = incoming.source
    if (current.translation === undefined && incoming.translation !== undefined) {
      completed.translation = incoming.translation
    }
    if (current.sourcePreference === undefined && incoming.sourcePreference !== undefined) {
      completed.sourcePreference = incoming.sourcePreference
    }
    if (current.targetPreference === undefined && incoming.targetPreference !== undefined) {
      completed.targetPreference = incoming.targetPreference
    }
    if (current.languagePair === undefined && incoming.languagePair !== undefined) {
      completed.languagePair = incoming.languagePair
    }
    if (current.completionReport === undefined && incoming.completionReport !== undefined) {
      completed.completionReport = incoming.completionReport
    }
    if (current.retryableFailedBlocks === undefined && incoming.retryableFailedBlocks !== undefined) {
      completed.retryableFailedBlocks = incoming.retryableFailedBlocks
    }
    if (current.errorCode === undefined && incoming.errorCode !== undefined) {
      completed.errorCode = incoming.errorCode
    }
    return Object.keys(completed).length > 0 ? { ...current, ...completed } : current
  }
  return incoming
}
