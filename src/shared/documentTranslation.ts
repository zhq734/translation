import type {
  DocumentBlock,
  DocumentModel,
  DocumentTableBlock,
  DocumentTextBlock
} from './documentTypes.ts'
import type { DocumentLanguagePair } from './documentLanguageDirection.ts'

/** 文档翻译单元的内容类型。 */
export type DocumentTranslationUnitKind =
  | 'paragraph'
  | 'heading'
  | 'list-item'
  | 'table-cell'
  | 'caption'
  | 'ocr-region'

/** 受保护片段在翻译请求中的唯一占位符。 */
export interface DocumentProtectedSpan {
  /** 在请求文本中出现的稳定占位符。 */
  placeholder: string
  /** 必须原样恢复的原文。 */
  text: string
  /** 保护原因，便于诊断且不包含用户正文。 */
  reason: string
}

/** 翻译单元携带的相邻文本摘要。 */
export interface DocumentTranslationUnitContext {
  /** 前一个语义单元的文本摘要。 */
  previous?: string
  /** 后一个语义单元的文本摘要。 */
  next?: string
}

/** 文档翻译的最小语义单元。 */
export interface TranslationUnit {
  /** 稳定单元标识；长文本分段使用 `:part-N` 后缀。 */
  unitId: string
  /** 所属页面标识。 */
  pageId: string
  /** 所属区块标识。 */
  blockId: string
  /** 待翻译原文。 */
  text: string
  /** 必须原样恢复的受保护片段。 */
  protectedSpans: DocumentProtectedSpan[]
  /** 相邻语义上下文。 */
  context: DocumentTranslationUnitContext
  /** 内容语义类型。 */
  kind: DocumentTranslationUnitKind
}

/** 已替换受保护片段的请求文本。 */
export type DocumentProtectedText =
  | {
    /** 是否已安全生成请求文本。 */
    ok: true
    /** 是否已完成占位符替换。 */
    safe: true
    /** 发送给翻译服务的文本。 */
    text: string
    /** 可用于恢复原文的占位片段。 */
    spans: DocumentProtectedSpan[]
  }
  | {
    /** 是否已安全生成请求文本。 */
    ok: false
    /** 是否已完成占位符替换。 */
    safe: false
    /** 源文本与保留协议冲突时使用的稳定错误码。 */
    code: 'reserved-placeholder'
    /** 不包含正文的脱敏原因。 */
    reason: string
  }

/** 受保护文本校验错误分类。 */
export type DocumentProtectedTextErrorCode =
  | 'missing'
  | 'duplicate'
  | 'out-of-order'
  | 'corrupt'

/** 受保护文本校验结果。 */
export type DocumentProtectedTextValidation =
  | { ok: true }
  | {
    ok: false
    code: DocumentProtectedTextErrorCode
    placeholder?: string
    reason: string
  }

/** 受保护文本恢复结果。 */
export type DocumentProtectedTextRestoreResult =
  | { ok: true; text: string }
  | { ok: false; code: DocumentProtectedTextErrorCode; reason: string }

/** 术语表条目。 */
export interface DocumentGlossaryEntry {
  /** 源术语。 */
  source: string
  /** 指定译法。 */
  target: string
  /** 源语言；为空时表示适用于全部源语言。 */
  sourceLang?: string
  /** 目标语言；为空时表示适用于全部目标语言。 */
  targetLang?: string
}

/** 带版本的文档术语表。 */
export interface DocumentGlossary {
  /** 术语表版本，用于缓存隔离。 */
  version: string
  /** 全部术语条目。 */
  entries: DocumentGlossaryEntry[]
}

/** 术语表匹配结果。 */
export interface DocumentGlossaryApplication {
  /** 命中的术语条目。 */
  matches: DocumentGlossaryEntry[]
  /** 仅包含命中术语的受控上下文。 */
  context: string
  /** 本次匹配使用的术语表版本。 */
  glossaryVersion: string
}

/** 文档翻译缓存键上下文。 */
export interface DocumentTranslationCacheContext {
  /** 源文件内容 SHA-256。 */
  fileSha256: string
  /** 解析器版本。 */
  parserVersion: string
  /** 任务冻结的实际语言方向。 */
  languagePair: DocumentLanguagePair
  /** 提供方与模型稳定指纹。 */
  modelFingerprint: string
  /** 术语表版本。 */
  glossaryVersion: string
  /** 保护规则版本。 */
  protectionRulesVersion: string
}

/** 可写入成功缓存的翻译结果。 */
export interface DocumentTranslationCacheEntry {
  /** 源文件内容哈希。 */
  sourceSha256: string
  /** 实际语言方向。 */
  languagePair: DocumentLanguagePair
  /** 术语表版本。 */
  glossaryVersion: string
  /** 保护规则版本。 */
  protectionRulesVersion: string
  /** 仅 completed 可写入成功缓存。 */
  status: 'completed' | 'partial' | 'failed' | 'cancelled'
  /** 完整译文。 */
  translation: string
  /** 是否被判定为疑似未翻译。 */
  suspectUntranslated?: boolean
  /** 是否存在未完成目标。 */
  incomplete?: boolean
}

/** 流水线传给翻译提供方的受控文档上下文；不包含文件路径、正文以外的凭据或图片字节。 */
export interface DocumentTranslationRequestContext {
  /** 当前文档任务标识。 */
  jobId?: string
  /** 当前文档任务代际。 */
  generation?: number
  /** 本次请求使用的术语表版本；无术语表时固定为 none。 */
  glossaryVersion: string
  /** 仅包含当前目标命中术语的受控约束。 */
  glossaryContext: string
  /** 当前目标相邻语义单元的受限摘要。 */
  contextSummary?: string
}

/** 缓存读取结果。 */
export type DocumentTranslationCacheParseResult =
  | { ok: true; translation: string }
  | {
    ok: false
    code:
      | 'source-mismatch'
      | 'language-mismatch'
      | 'glossary-mismatch'
      | 'protection-mismatch'
      | 'not-completed'
      | 'suspect-untranslated'
      | 'incomplete'
      | 'empty-translation'
      | 'invalid-entry'
    reason: string
  }

/** 当前保护协议版本；规则语义变化时必须递增。 */
export const DOCUMENT_PROTECTION_RULES_VERSION = 'protection-v1'

/** 内部占位符前缀；源文本中出现时必须拒绝。 */
const DOCUMENT_PROTECTED_PLACEHOLDER_PREFIX = '[[[ST-DOC-PROTECTED-'

/** 内部占位符匹配规则。 */
const DOCUMENT_PROTECTED_PLACEHOLDER_PATTERN = /\[\[\[ST-DOC-PROTECTED-[^\]]+\]\]\]/gu

/** 上下文字符数上限，避免把整份文档泄露给翻译提供方。 */
const DOCUMENT_UNIT_CONTEXT_MAX_CHARS = 240

/** 保护规则定义。 */
interface ProtectionRule {
  /** 匹配不可翻译片段的全局正则。 */
  pattern: RegExp
  /** 保护原因。 */
  reason: string
}

/** 保护规则按“更具体规则优先”的顺序排列。 */
const PROTECTION_RULES: readonly ProtectionRule[] = [
  { pattern: /`[^`\n]+`/gu, reason: 'inline-code' },
  { pattern: /\$\$[\s\S]+?\$\$/gu, reason: 'formula' },
  { pattern: /\$[^$\n]+?\$/gu, reason: 'formula' },
  { pattern: /https?:\/\/[^\s<>"'，。；！？）】]+/gu, reason: 'url' },
  { pattern: /mailto:[^\s<>"'，。；！？）】]+/gu, reason: 'email' },
  { pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, reason: 'email' },
  {
    pattern: /(?:[A-Za-z]:\\|\.{0,2}\/)(?:[^\s<>"'，。；！？）】]+)/gu,
    reason: 'file-path'
  },
  { pattern: /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\([^()\n]*\)/gu, reason: 'code' },
  { pattern: /(?<![\w.])\d+(?:\.\d+)?(?!\w|\.\d)/gu, reason: 'number' }
]

/** 术语匹配时的 ASCII 单词边界字符。 */
const GLOSSARY_WORD_CHARACTER = /[A-Za-z0-9_]/u

/**
 * 规范化语言代码，用于术语表方向比较。
 * @param language 语言代码或偏好。
 * @returns 大写且去空白的语言代码；auto 保持 AUTO。
 * @author zhenghq
 */
function normalizeLanguage(language: string | undefined): string {
  return (language ?? '').trim().toUpperCase()
}

/**
 * 判断术语条目是否适用于当前语言方向。
 * @param entry 术语条目。
 * @param languagePair 实际语言方向。
 * @returns 是否命中语言方向。
 * @author zhenghq
 */
function glossaryEntryMatchesLanguage(
  entry: DocumentGlossaryEntry,
  languagePair: DocumentLanguagePair
): boolean {
  const sourceLang = normalizeLanguage(entry.sourceLang)
  const targetLang = normalizeLanguage(entry.targetLang)
  const actualSource = normalizeLanguage(languagePair.sourceLang)
  const actualTarget = normalizeLanguage(languagePair.targetLang)
  return (!sourceLang || sourceLang === actualSource) &&
    (!targetLang || targetLang === actualTarget)
}

/**
 * 判断术语是否在文本中以独立词出现，避免 cache 命中 caching 等误匹配。
 * @param text 待检查文本。
 * @param term 术语。
 * @returns 是否出现独立术语。
 * @author zhenghq
 */
function containsGlossaryTerm(text: string, term: string): boolean {
  if (!term) return false
  const lowerText = text.toLowerCase()
  const lowerTerm = term.toLowerCase()
  let offset = lowerText.indexOf(lowerTerm)
  while (offset >= 0) {
    const before = lowerText[offset - 1]
    const after = lowerText[offset + lowerTerm.length]
    const asciiTerm = /^[A-Za-z0-9_]/u.test(lowerTerm)
    if (!asciiTerm ||
      (!before || !GLOSSARY_WORD_CHARACTER.test(before)) &&
      (!after || !GLOSSARY_WORD_CHARACTER.test(after))) {
      return true
    }
    offset = lowerText.indexOf(lowerTerm, offset + 1)
  }
  return false
}

/**
 * 按阅读顺序收集文本区块的单元，并递归处理表格单元格。
 * @param blocks 区块列表。
 * @param pageId 页面标识。
 * @param output 累积的翻译单元。
 * @param parentBlockId 嵌套区块的父标识。
 * @returns 无返回值。
 * @author zhenghq
 */
function collectBlockUnits(
  blocks: DocumentBlock[],
  pageId: string,
  output: TranslationUnit[],
  parentBlockId?: string
): void {
  for (const block of blocks) {
    if (block.kind === 'text') {
      const unit = createTextUnit(block, pageId, parentBlockId)
      if (unit) output.push(unit)
      continue
    }
    if (block.kind === 'table') {
      collectTableUnits(block, pageId, output)
      continue
    }
    if (block.kind === 'image' && block.ocrRegions) {
      for (const region of block.ocrRegions) {
        if (region.status !== 'recognized' || !region.text.trim()) continue
        output.push({
          unitId: `${pageId}:${block.blockId}:${region.regionId}`,
          pageId,
          blockId: block.blockId,
          text: region.text,
          protectedSpans: [],
          context: {},
          kind: 'ocr-region'
        })
      }
    }
  }
}

/**
 * 将文本区块转换为一个语义单元；多个 run 合并为一个请求。
 * @param block 文本区块。
 * @param pageId 页面标识。
 * @param parentBlockId 表格单元格等嵌套场景的父标识。
 * @returns 翻译单元；不可翻译或空白时返回 undefined。
 * @author zhenghq
 */
function createTextUnit(
  block: DocumentTextBlock,
  pageId: string,
  parentBlockId?: string
): TranslationUnit | undefined {
  if (!block.translatable) return undefined
  const text = block.runs
    .filter((run) => !run.protected)
    .map((run) => run.text)
    .join('')
  if (!text.trim()) return undefined
  const firstRun = block.runs.find((run) => !run.protected)?.runId ?? 'text'
  const kind = resolveTextUnitKind(block)
  const blockId = parentBlockId ?? block.blockId
  return {
    unitId: parentBlockId
      ? `${pageId}:${parentBlockId}:${block.blockId}:${firstRun}`
      : `${pageId}:${block.blockId}:${firstRun}`,
    pageId,
    blockId,
    text,
    protectedSpans: collectProtectedSpans(text),
    context: {},
    kind
  }
}

/**
 * 根据文本角色和字幕元数据判定翻译单元类型。
 * @param block 文本区块。
 * @returns 语义类型。
 * @author zhenghq
 */
function resolveTextUnitKind(block: DocumentTextBlock): DocumentTranslationUnitKind {
  if (block.timing || block.role === 'caption') return 'caption'
  if (block.role === 'heading' || block.role === 'subtitle') return 'heading'
  if (block.role === 'list-item') return 'list-item'
  return 'paragraph'
}

/**
 * 将表格的每个单元格转换为独立语义单元。
 * @param table 表格区块。
 * @param pageId 页面标识。
 * @param output 累积的翻译单元。
 * @returns 无返回值。
 * @author zhenghq
 */
function collectTableUnits(
  table: DocumentTableBlock,
  pageId: string,
  output: TranslationUnit[]
): void {
  for (const row of table.rows) {
    for (const cell of row.cells) {
      for (const block of cell.blocks) {
        if (block.kind !== 'text') continue
        const unit = createTextUnit(block, pageId, table.blockId)
        if (!unit) continue
        output.push({
          ...unit,
          unitId: `${pageId}:${table.blockId}:${cell.cellId}:${block.blockId}:${block.runs[0]?.runId ?? 'text'}`,
          kind: 'table-cell'
        })
      }
    }
  }
}

/**
 * 从文本中提取不可翻译片段并生成唯一占位符。
 * @param text 原文。
 * @returns 按出现顺序排列的受保护片段。
 * @author zhenghq
 */
function collectProtectedSpans(text: string): DocumentProtectedSpan[] {
  const candidates: Array<{ start: number; end: number; text: string; reason: string }> = []
  for (const rule of PROTECTION_RULES) {
    rule.pattern.lastIndex = 0
    const matches = Array.from(text.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags)))
    for (const match of matches) {
      const value = trimProtectedMatch(match[0], rule.reason)
      const start = match.index ?? 0
      if (!value || start < 0) continue
      const end = start + value.length
      if (candidates.some((candidate) => start < candidate.end && end > candidate.start)) continue
      candidates.push({ start, end, text: value, reason: rule.reason })
    }
  }
  candidates.sort((left, right) => left.start - right.start)
  return candidates.map((candidate, index) => ({
    placeholder: `${DOCUMENT_PROTECTED_PLACEHOLDER_PREFIX}${String(index + 1).padStart(4, '0')}]]]`,
    text: candidate.text,
    reason: candidate.reason
  }))
}

/**
 * 去除 URL、邮箱和文件路径末尾的句读符号，避免把正文标点锁进受保护片段。
 * @param value 正则命中的原始片段。
 * @param reason 保护原因。
 * @returns 去除尾随标点后的片段。
 * @author zhenghq
 */
function trimProtectedMatch(value: string, reason: string): string {
  if (reason !== 'url' && reason !== 'email' && reason !== 'file-path') return value
  return value.replace(/[.,;:!?)\]}>]+$/u, '')
}

/**
 * 将受保护片段替换为稳定占位符，并拒绝源文本中的保留协议冲突。
 * @param unit 翻译单元。
 * @returns 可发送的受保护文本或稳定冲突结果。
 * @author zhenghq
 */
export function createDocumentProtectedText(unit: TranslationUnit): DocumentProtectedText {
  const reserved = Array.from(unit.text.matchAll(DOCUMENT_PROTECTED_PLACEHOLDER_PATTERN))
  if (reserved.length > 0) {
    return {
      ok: false,
      safe: false,
      code: 'reserved-placeholder',
      reason: 'Source text contains a reserved document translation placeholder.'
    }
  }
  const spans = [...unit.protectedSpans].sort((left, right) => {
    const leftOffset = unit.text.indexOf(left.text)
    const rightOffset = unit.text.indexOf(right.text)
    return leftOffset - rightOffset
  })
  let text = unit.text
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index]!
    const offset = text.indexOf(span.text)
    if (offset < 0) continue
    text = `${text.slice(0, offset)}${span.placeholder}${text.slice(offset + span.text.length)}`
  }
  return { ok: true, safe: true, text, spans }
}

/**
 * 校验译文中的占位符数量、唯一性和顺序。
 * @param text 翻译服务返回的文本。
 * @param spans 请求时使用的受保护片段。
 * @returns 校验结果。
 * @author zhenghq
 */
export function validateDocumentProtectedText(
  text: string,
  spans: readonly DocumentProtectedSpan[]
): DocumentProtectedTextValidation {
  const expected = spans.map((span) => span.placeholder)
  const expectedSet = new Set(expected)
  const found = Array.from(text.matchAll(DOCUMENT_PROTECTED_PLACEHOLDER_PATTERN), (match) => match[0])
  for (const placeholder of found) {
    if (!expectedSet.has(placeholder)) {
      return { ok: false, code: 'corrupt', placeholder, reason: 'Unknown protected placeholder.' }
    }
  }
  const counts = new Map<string, number>()
  for (const placeholder of found) counts.set(placeholder, (counts.get(placeholder) ?? 0) + 1)
  for (const placeholder of expected) {
    const count = counts.get(placeholder) ?? 0
    if (count === 0) return { ok: false, code: 'missing', placeholder, reason: 'Protected placeholder is missing.' }
    if (count > 1) return { ok: false, code: 'duplicate', placeholder, reason: 'Protected placeholder is duplicated.' }
  }
  if (found.length !== expected.length) {
    return { ok: false, code: 'corrupt', reason: 'Protected placeholder count is invalid.' }
  }
  if (found.some((placeholder, index) => placeholder !== expected[index])) {
    return { ok: false, code: 'out-of-order', reason: 'Protected placeholders are out of order.' }
  }
  return { ok: true }
}

/**
 * 校验并恢复受保护片段；任何协议损坏都不返回残缺译文。
 * @param text 翻译服务返回的文本。
 * @param spans 请求时使用的受保护片段。
 * @returns 恢复后的文本或稳定错误。
 * @author zhenghq
 */
export function restoreDocumentProtectedText(
  text: string,
  spans: readonly DocumentProtectedSpan[]
): DocumentProtectedTextRestoreResult {
  const validation = validateDocumentProtectedText(text, spans)
  if (!validation.ok) return validation
  let restored = text
  for (const span of spans) restored = restored.replace(span.placeholder, span.text)
  return { ok: true, text: restored }
}

/**
 * 收集整份文档的可翻译语义单元，并为相邻单元补充受限上下文。
 * @param model 文档模型。
 * @returns 按阅读顺序排列的翻译单元。
 * @author zhenghq
 */
export function collectDocumentTranslationUnits(model: DocumentModel): TranslationUnit[] {
  const units: TranslationUnit[] = []
  for (const page of model.pages) collectBlockUnits(page.blocks, page.pageId, units)
  return units.map((unit, index) => ({
    ...unit,
    context: {
      ...(units[index - 1] ? { previous: summarizeContext(units[index - 1]!.text) } : {}),
      ...(units[index + 1] ? { next: summarizeContext(units[index + 1]!.text) } : {})
    }
  }))
}

/**
 * 截取单元上下文摘要，避免上下文无限增长。
 * @param text 相邻单元文本。
 * @returns 最长 240 字符的摘要。
 * @author zhenghq
 */
function summarizeContext(text: string): string {
  const normalized = text.trim().replace(/\s+/gu, ' ')
  return normalized.length <= DOCUMENT_UNIT_CONTEXT_MAX_CHARS
    ? normalized
    : `${normalized.slice(0, DOCUMENT_UNIT_CONTEXT_MAX_CHARS - 1)}…`
}

/**
 * 将长文本按句子边界拆分为稳定分段，不切断单词或受保护协议。
 * @param units 语义单元。
 * @param maxChars 单段最大字符数。
 * @returns 分段后的单元；未超限时保持原单元。
 * @author zhenghq
 */
export function splitDocumentTranslationUnits(
  units: readonly TranslationUnit[],
  maxChars: number
): TranslationUnit[] {
  const limit = Math.max(1, Math.floor(maxChars))
  const output: TranslationUnit[] = []
  for (const unit of units) {
    const texts = splitTextAtSentenceBoundary(unit.text, limit)
    if (texts.length <= 1) {
      output.push(unit)
      continue
    }
    texts.forEach((text, index) => {
      output.push({
        ...unit,
        unitId: `${unit.unitId}:part-${index + 1}`,
        text,
        context: {
          ...(index > 0 ? { previous: summarizeContext(texts[index - 1]!) } : {}),
          ...(index < texts.length - 1 ? { next: summarizeContext(texts[index + 1]!) } : {})
        }
      })
    })
  }
  return output
}

/**
 * 在句子边界合并文本，并保证单个片段不超过上限。
 * @param text 原文。
 * @param limit 单段最大字符数。
 * @returns 句子边界分段。
 * @author zhenghq
 */
function splitTextAtSentenceBoundary(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const sentences = splitSentences(text)
  const output: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (sentence.length > limit) {
      if (current.trim()) output.push(current.trim())
      output.push(...splitLongSentence(sentence, limit))
      current = ''
      continue
    }
    if (current && current.length + sentence.length > limit) {
      output.push(current.trim())
      current = ''
    }
    current += sentence
  }
  if (current.trim()) output.push(current.trim())
  return output.length > 0 ? output : [text]
}

/**
 * 按中英文句末标点拆分句子，并保留标点。
 * @param text 原文。
 * @returns 句子列表。
 * @author zhenghq
 */
function splitSentences(text: string): string[] {
  return text.match(/[^。！？.!?]+[。！？.!?]+(?:\s+|$)|[^。！？.!?]+$/gu) ?? [text]
}

/**
 * 对无句界的超长片段做安全切分，优先保留受保护协议完整。
 * @param sentence 超长句子。
 * @param limit 单段最大字符数。
 * @returns 安全片段。
 * @author zhenghq
 */
function splitLongSentence(sentence: string, limit: number): string[] {
  const tokens = sentence.match(
    /\[\[\[ST-DOC-PROTECTED-[^\]]+\]\]\]|[^\s]+|\s+/gu
  ) ?? [sentence]
  const output: string[] = []
  let current = ''
  for (const token of tokens) {
    if (token.length > limit) {
      if (current) output.push(current)
      current = ''
      // 超长占位符本身也不能拆开；保留完整协议，交给后续校验判定请求是否仍可发送。
      output.push(token)
      continue
    }
    if (current && current.length + token.length > limit) {
      output.push(current)
      current = ''
    }
    current += token
  }
  if (current) output.push(current)
  return output
}

/**
 * 按实际语言方向匹配术语表，并生成只包含命中条目的受控上下文。
 * @param unit 翻译单元。
 * @param glossary 术语表。
 * @param languagePair 实际语言方向。
 * @returns 命中术语、上下文与术语版本。
 * @author zhenghq
 */
export function applyDocumentGlossary(
  unit: TranslationUnit,
  glossary: DocumentGlossary,
  languagePair: DocumentLanguagePair
): DocumentGlossaryApplication {
  const matches = glossary.entries.filter((entry) =>
    glossaryEntryMatchesLanguage(entry, languagePair) && containsGlossaryTerm(unit.text, entry.source)
  )
  return {
    matches,
    context: matches.map((entry) => `${entry.source} => ${entry.target}`).join('\n'),
    glossaryVersion: glossary.version
  }
}

/**
 * 构造完整文档翻译缓存键；键中保留可诊断字段并追加稳定短哈希。
 * @param context 缓存键上下文。
 * @returns 可持久化的缓存键。
 * @author zhenghq
 */
export function buildDocumentTranslationCacheKey(context: DocumentTranslationCacheContext): string {
  const fields = [
    context.fileSha256,
    context.parserVersion,
    context.languagePair.sourceLang,
    context.languagePair.targetLang,
    context.modelFingerprint,
    context.glossaryVersion,
    context.protectionRulesVersion
  ]
  return `${fields.join('|')}#${stableShortHash(fields.join('\u0000'))}`
}

/**
 * 复验缓存条目；仅完整成功且上下文一致的译文可复用。
 * @param context 当前任务缓存上下文。
 * @param value 从持久化缓存读取的未知值。
 * @returns 可复用译文或稳定失效原因。
 * @author zhenghq
 */
export function parseDocumentTranslationCacheEntry(
  context: DocumentTranslationCacheContext,
  value: unknown
): DocumentTranslationCacheParseResult {
  if (!isRecord(value)) {
    return { ok: false, code: 'invalid-entry', reason: 'Cache entry is not an object.' }
  }
  if (value.sourceSha256 !== context.fileSha256) {
    return { ok: false, code: 'source-mismatch', reason: 'Source fingerprint changed.' }
  }
  if (!isLanguagePair(value.languagePair) ||
    value.languagePair.sourceLang !== context.languagePair.sourceLang ||
    value.languagePair.targetLang !== context.languagePair.targetLang) {
    return { ok: false, code: 'language-mismatch', reason: 'Language direction changed.' }
  }
  if (value.glossaryVersion !== context.glossaryVersion) {
    return { ok: false, code: 'glossary-mismatch', reason: 'Glossary version changed.' }
  }
  if (value.protectionRulesVersion !== context.protectionRulesVersion) {
    return { ok: false, code: 'protection-mismatch', reason: 'Protection rules changed.' }
  }
  if (value.status !== 'completed') {
    return { ok: false, code: 'not-completed', reason: 'Cache entry is not a completed result.' }
  }
  if (value.suspectUntranslated === true) {
    return { ok: false, code: 'suspect-untranslated', reason: 'Suspect translation is not cacheable.' }
  }
  if (value.incomplete === true) {
    return { ok: false, code: 'incomplete', reason: 'Incomplete result is not cacheable.' }
  }
  if (typeof value.translation !== 'string' || !value.translation.trim()) {
    return { ok: false, code: 'empty-translation', reason: 'Empty translation is not cacheable.' }
  }
  return { ok: true, translation: value.translation }
}

/**
 * 判断未知值是否为对象。
 * @param value 未知值。
 * @returns 是否为普通对象。
 * @author zhenghq
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 判断未知值是否包含语言对字段。
 * @param value 未知值。
 * @returns 是否为语言对。
 * @author zhenghq
 */
function isLanguagePair(value: unknown): value is DocumentLanguagePair {
  return isRecord(value) && typeof value.sourceLang === 'string' && typeof value.targetLang === 'string'
}

/**
 * 计算稳定短哈希，避免共享层依赖 Node.js crypto。
 * @param value 参与哈希的稳定字符串。
 * @returns 16 位十六进制哈希。
 * @author zhenghq
 */
function stableShortHash(value: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first ^= code
    first = Math.imul(first, 0x01000193)
    second ^= code + index
    second = Math.imul(second, 0x85ebca6b)
  }
  return (first >>> 0).toString(16).padStart(8, '0') +
    (second >>> 0).toString(16).padStart(8, '0')
}
