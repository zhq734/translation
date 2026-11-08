import type {
  OcrEngineId,
  TranslationHistoryEntry,
  TranslationOrigin,
  TranslationProviderId
} from './types'

export type { TranslationHistoryEntry } from './types'

/** 非收藏翻译历史最多保留的条数。 */
export const TRANSLATION_HISTORY_LIMIT = 200

/** 创建历史记录时允许调用方提供的安全字段。 */
export interface TranslationHistoryInput {
  /** 成功翻译的原文。 */
  sourceText: string
  /** 成功翻译的译文。 */
  translatedText: string
  /** 源语言。 */
  sourceLang: string
  /** 目标语言。 */
  targetLang: string
  /** 完成翻译的 API。 */
  provider?: TranslationProviderId
  /** 翻译入口来源。 */
  origin: TranslationOrigin
  /** 可选的记录时间；缺省时使用当前时间。 */
  createdAt?: number
  /** 是否收藏；缺省为 false。 */
  favorite?: boolean
  /** OCR 识别引擎。 */
  ocrEngine?: OcrEngineId
}

const TRANSLATION_ORIGINS: ReadonlySet<TranslationOrigin> = new Set([
  'selection',
  'manual',
  'ocr'
])

const TRANSLATION_PROVIDERS: ReadonlySet<TranslationProviderId> = new Set([
  'dingtalk',
  'microsoft',
  'ai',
  'bili-index',
  'deeplx-self',
  'deeplx-public',
  'google',
  'mymemory'
])

const OCR_ENGINES: ReadonlySet<OcrEngineId> = new Set(['system', 'paddle', 'tesseract'])

/**
 * 判断未知值是否为受支持的翻译来源。
 * @param value 待校验值。
 * @returns 是否为合法翻译来源。
 * @author zhenghq
 */
function isTranslationOrigin(value: unknown): value is TranslationOrigin {
  return typeof value === 'string' && TRANSLATION_ORIGINS.has(value as TranslationOrigin)
}

/**
 * 判断未知值是否为受支持的翻译 API。
 * @param value 待校验值。
 * @returns 是否为合法翻译 API 标识。
 * @author zhenghq
 */
function isTranslationProvider(value: unknown): value is TranslationProviderId {
  return typeof value === 'string' && TRANSLATION_PROVIDERS.has(value as TranslationProviderId)
}

/**
 * 判断未知值是否为受支持的 OCR 引擎。
 * @param value 待校验值。
 * @returns 是否为合法 OCR 引擎标识。
 * @author zhenghq
 */
function isOcrEngine(value: unknown): value is OcrEngineId {
  return typeof value === 'string' && OCR_ENGINES.has(value as OcrEngineId)
}

/**
 * 生成一个无需暴露业务内容的稳定格式记录标识。
 * @returns 新的历史记录标识。
 * @author zhenghq
 */
function createHistoryId(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }
  return `history-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/**
 * 生成历史记录的去重键，来源与语言对不同则视为不同记录。
 * @param entry 历史记录的安全字段。
 * @returns 用于去重的稳定字符串。
 * @author zhenghq
 */
function historyIdentity(entry: Pick<TranslationHistoryEntry, 'origin' | 'sourceText' | 'sourceLang' | 'targetLang'>): string {
  return [entry.origin, entry.sourceText, entry.sourceLang, entry.targetLang].join('\u0000')
}

/**
 * 根据成功翻译结果创建一条统一历史记录。
 * @param input 翻译原文、译文、语言和来源等安全字段。
 * @returns 合法时返回新记录；原文或译文为空时返回 null。
 * @author zhenghq
 */
export function createTranslationHistoryEntry(input: TranslationHistoryInput): TranslationHistoryEntry | null {
  const sourceText = String(input.sourceText ?? '').trim()
  const translatedText = String(input.translatedText ?? '').trim()
  if (!sourceText || !translatedText || !isTranslationOrigin(input.origin)) return null
  const createdAt = Number(input.createdAt ?? Date.now())
  if (!Number.isFinite(createdAt)) return null

  const entry: TranslationHistoryEntry = {
    id: createHistoryId(),
    sourceText,
    translatedText,
    sourceLang: String(input.sourceLang || 'auto').trim(),
    targetLang: String(input.targetLang || 'auto').trim(),
    origin: input.origin,
    createdAt,
    favorite: input.favorite === true
  }
  if (isTranslationProvider(input.provider)) entry.provider = input.provider
  if (isOcrEngine(input.ocrEngine)) entry.ocrEngine = input.ocrEngine
  return entry
}

/**
 * 将磁盘或 IPC 中的未知条目规范化为安全历史记录。
 * @param value 待校验的候选条目。
 * @returns 合法条目；字段缺失或非法时返回 null。
 * @author zhenghq
 */
function normalizeEntry(value: unknown): TranslationHistoryEntry | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.id !== 'string' ||
    !candidate.id.trim() ||
    typeof candidate.sourceText !== 'string' ||
    !candidate.sourceText.trim() ||
    typeof candidate.translatedText !== 'string' ||
    !candidate.translatedText.trim() ||
    typeof candidate.sourceLang !== 'string' ||
    typeof candidate.targetLang !== 'string' ||
    !isTranslationOrigin(candidate.origin) ||
    typeof candidate.createdAt !== 'number' ||
    !Number.isFinite(candidate.createdAt)
  ) return null

  const entry: TranslationHistoryEntry = {
    id: candidate.id,
    sourceText: candidate.sourceText.trim(),
    translatedText: candidate.translatedText.trim(),
    sourceLang: candidate.sourceLang.trim() || 'auto',
    targetLang: candidate.targetLang.trim() || 'auto',
    origin: candidate.origin,
    createdAt: candidate.createdAt,
    favorite: candidate.favorite === true
  }
  if (isTranslationProvider(candidate.provider)) entry.provider = candidate.provider
  if (isOcrEngine(candidate.ocrEngine)) entry.ocrEngine = candidate.ocrEngine
  return entry
}

/**
 * 过滤损坏记录、按身份去重，并将收藏项置顶后按时间倒序排列。
 * @param values 磁盘或调用方提供的未知历史数组。
 * @returns 规范化且排序后的安全历史记录。
 * @author zhenghq
 */
export function normalizeTranslationHistory(values: unknown): TranslationHistoryEntry[] {
  if (!Array.isArray(values)) return []
  const unique = new Map<string, TranslationHistoryEntry>()
  for (const value of values) {
    const entry = normalizeEntry(value)
    if (!entry) continue
    const key = historyIdentity(entry)
    const previous = unique.get(key)
    if (!previous) {
      unique.set(key, entry)
      continue
    }
    const preferred = entry.createdAt >= previous.createdAt ? entry : previous
    unique.set(key, {
      ...preferred,
      favorite: previous.favorite || entry.favorite
    })
  }
  return [...unique.values()].sort((left, right) => {
    if (left.favorite !== right.favorite) return left.favorite ? -1 : 1
    return right.createdAt - left.createdAt
  })
}

/**
 * 限制非收藏记录数量，同时保留全部收藏记录。
 * @param entries 已规范化的历史记录。
 * @returns 应用数量上限后的历史记录。
 * @author zhenghq
 */
function limitNonFavorites(entries: TranslationHistoryEntry[]): TranslationHistoryEntry[] {
  let remaining = TRANSLATION_HISTORY_LIMIT
  return entries.filter((entry) => {
    if (entry.favorite) return true
    if (remaining <= 0) return false
    remaining -= 1
    return true
  })
}

/**
 * 记录一次成功翻译；相同来源、原文和语言对会更新旧记录并保留收藏状态。
 * @param previous 当前历史记录。
 * @param input 本次成功翻译的安全字段。
 * @returns 更新并排序后的历史记录。
 * @author zhenghq
 */
export function recordTranslationHistory(
  previous: TranslationHistoryEntry[],
  input: TranslationHistoryInput
): TranslationHistoryEntry[] {
  const created = createTranslationHistoryEntry(input)
  if (!created) return normalizeTranslationHistory(previous)
  const normalized = normalizeTranslationHistory(previous)
  const existing = normalized.find((entry) => historyIdentity(entry) === historyIdentity(created))
  const next = normalized.filter((entry) => historyIdentity(entry) !== historyIdentity(created))
  next.push({
    ...created,
    id: existing?.id ?? created.id,
    favorite: existing?.favorite ?? created.favorite
  })
  return limitNonFavorites(normalizeTranslationHistory(next))
}

/**
 * 按原文、译文、语言方向或来源过滤翻译历史。
 * @param entries 当前历史记录。
 * @param query 用户输入的搜索词。
 * @returns 匹配的历史记录，保持原顺序。
 * @author zhenghq
 */
export function filterTranslationHistory(
  entries: TranslationHistoryEntry[],
  query: string
): TranslationHistoryEntry[] {
  const keyword = query.trim().toLocaleLowerCase()
  if (!keyword) return entries
  return entries.filter((entry) => {
    const direction = `${entry.sourceLang.toLocaleLowerCase()} → ${entry.targetLang.toLocaleLowerCase()}`
    return entry.sourceText.toLocaleLowerCase().includes(keyword) ||
      entry.translatedText.toLocaleLowerCase().includes(keyword) ||
      direction.includes(keyword) ||
      entry.origin.toLocaleLowerCase().includes(keyword)
  })
}

/**
 * 切换指定记录的收藏状态，不改变列表顺序。
 * @param entries 当前历史记录。
 * @param id 要切换的记录标识。
 * @returns 新数组；未找到记录时返回原数组。
 * @author zhenghq
 */
export function toggleTranslationHistoryFavorite(
  entries: TranslationHistoryEntry[],
  id: string
): TranslationHistoryEntry[] {
  const index = entries.findIndex((entry) => entry.id === id)
  if (index < 0) return entries
  return entries.map((entry, entryIndex) =>
    entryIndex === index ? { ...entry, favorite: !entry.favorite } : entry
  )
}
