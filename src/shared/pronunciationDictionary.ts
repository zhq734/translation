import type {
  PronunciationAccent,
  PronunciationDefinition,
  PronunciationResult,
  PronunciationVariant
} from './types'

/** 单次词典响应最多保留的释义数量，避免音标卡被长释义撑开。 */
const MAX_DEFINITIONS = 5

/** 词典响应解析后的内部结果，音频地址只保留在主进程缓存中。 */
export interface ParsedPronunciationDictionaryResponse {
  /** 可安全返回 Renderer 的音标结果。 */
  result: PronunciationResult
  /** 变体 ID 到受信任音频地址的内部映射。 */
  audioUrls: Record<string, string>
}

/**
 * 安全读取对象字段。
 * @param value 未信任值。
 * @param key 字段名。
 * @returns 字段存在且为对象时返回对象，否则返回 null。
 * @author zhenghq
 */
function readRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  const field = (value as Record<string, unknown>)[key]
  return field && typeof field === 'object' ? field as Record<string, unknown> : null
}

/**
 * 安全读取字符串字段。
 * @param value 未信任值。
 * @param key 字段名。
 * @returns 非空字符串或 undefined。
 * @author zhenghq
 */
function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field.trim() ? field.trim() : undefined
}

/**
 * 根据音频 URL 路径中明确的 -us / -uk 标记推断口音。
 * @param audioUrl 词典返回的音频地址。
 * @returns 明确标记对应的口音，否则为 other。
 * @author zhenghq
 */
function inferAccent(audioUrl: string | undefined, ipa?: string): PronunciationAccent {
  if (audioUrl) {
    let pathname = audioUrl
    try {
      pathname = new URL(audioUrl).pathname
    } catch {
      pathname = audioUrl
    }
    if (/(?:^|[-_/])us(?:[-_.]|$)/iu.test(pathname)) return 'US'
    if (/(?:^|[-_/])uk(?:[-_.]|$)/iu.test(pathname)) return 'UK'
    // 音频存在但路径没有明确口音标记时无法证明口音，不能仅凭 IPA 猜测。
    return 'other'
  }
  // 没有音频时只使用少量稳定 IPA 特征兜底，避免误判通用音标。
  if (ipa) {
    if (/əʊ|ɒ/u.test(ipa)) return 'UK'
    if (/oʊ|ɚ/u.test(ipa)) return 'US'
    return 'other'
  }
  return 'other'
}

/**
 * 从词典 meanings 中提取英文释义并按文本去重。
 * @param entry 单条词典词条。
 * @returns 保留词性、来源与顺序的释义列表。
 * @author zhenghq
 */
function readDefinitions(entry: unknown): PronunciationDefinition[] {
  if (!entry || typeof entry !== 'object') return []
  const meanings = (entry as Record<string, unknown>).meanings
  if (!Array.isArray(meanings)) return []
  const definitions: PronunciationDefinition[] = []
  const seen = new Set<string>()
  for (const meaning of meanings) {
    if (!meaning || typeof meaning !== 'object') continue
    const partOfSpeech = readString(meaning, 'partOfSpeech')
    const items = (meaning as Record<string, unknown>).definitions
    if (!Array.isArray(items)) continue
    for (const item of items) {
      const text = readString(item, 'definition')
      const key = text?.toLowerCase()
      if (!text || !key || seen.has(key)) continue
      seen.add(key)
      definitions.push({
        text,
        ...(partOfSpeech ? { partOfSpeech } : {}),
        language: 'en',
        source: 'dictionaryapi'
      })
      if (definitions.length >= MAX_DEFINITIONS) return definitions
    }
  }
  return definitions
}

/**
 * 校验词典音频地址是否为可代理的 HTTP(S) 地址。
 * @param value 未信任音频地址。
 * @returns 可安全交给主进程下载时返回规范化地址。
 * @author zhenghq
 */
function readTrustedAudioUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

/**
 * 解析 dictionaryapi.dev 响应，去重 IPA、限制变体数量并保留许可元数据。
 * @param payload 已通过 JSON 解析的上游响应。
 * @param word 用户当前查询或点击的单词。
 * @returns 可返回 Renderer 的音标结果及主进程内部音频映射。
 * @author zhenghq
 */
export function parsePronunciationDictionaryResponse(
  payload: unknown,
  word: string
): ParsedPronunciationDictionaryResponse {
  const unavailable: PronunciationResult = {
    status: 'unavailable',
    word,
    language: 'en',
    variants: [],
    source: 'dictionaryapi'
  }
  if (!Array.isArray(payload) || payload.length === 0) {
    return { result: unavailable, audioUrls: {} }
  }

  const candidates: Array<PronunciationVariant & { audioUrl?: string }> = []
  const audioUrls: Record<string, string> = {}
  const definitions: PronunciationDefinition[] = []
  const seenDefinitionTexts = new Set<string>()

  for (const entry of payload) {
    if (!entry || typeof entry !== 'object') continue
    for (const definition of readDefinitions(entry)) {
      const key = definition.text.toLowerCase()
      if (seenDefinitionTexts.has(key)) continue
      seenDefinitionTexts.add(key)
      definitions.push(definition)
      if (definitions.length >= MAX_DEFINITIONS) break
    }
    const phonetics = (entry as Record<string, unknown>).phonetics
    if (Array.isArray(phonetics)) {
      for (const phonetic of phonetics) {
        if (!phonetic || typeof phonetic !== 'object') continue
        const ipa = readString(phonetic, 'text')
        if (!ipa) continue
        const audioUrl = readTrustedAudioUrl((phonetic as Record<string, unknown>).audio)
        if (candidates.some((candidate) => candidate.ipa === ipa)) continue
        const accent = inferAccent(audioUrl, ipa)
        const id = `${accent.toLowerCase()}-${candidates.length}`
        candidates.push({ id, accent, ipa, hasAudio: Boolean(audioUrl), ...(audioUrl ? { audioUrl } : {}) })
        if (candidates.length >= 3) break
      }
    }
    if (candidates.length === 0) {
      const fallbackIpa = readString(entry, 'phonetic')
      if (fallbackIpa) {
        const phoneticAudio = Array.isArray(phonetics)
          ? phonetics.find((phonetic) => phonetic && typeof phonetic === 'object'
            && Boolean(readTrustedAudioUrl((phonetic as Record<string, unknown>).audio)))
          : undefined
        const audioUrl = phoneticAudio && typeof phoneticAudio === 'object'
          ? readTrustedAudioUrl((phoneticAudio as Record<string, unknown>).audio)
          : undefined
        const accent = inferAccent(audioUrl, fallbackIpa)
        const id = `${accent.toLowerCase()}-0`
        candidates.push({ id, accent, ipa: fallbackIpa, hasAudio: Boolean(audioUrl), ...(audioUrl ? { audioUrl } : {}) })
      }
    }
    if (candidates.length >= 3) break
  }

  if (candidates.length === 0 && definitions.length === 0) return { result: unavailable, audioUrls: {} }
  // 先按美式、英式、其他排序，再让同口音内有音频的变体优先，最后保持上游原始顺序。
  const accentOrder: Record<PronunciationAccent, number> = { US: 0, UK: 1, other: 2 }
  const variants: PronunciationVariant[] = candidates
    .map(({ audioUrl: _audioUrl, ...variant }, index) => ({ variant, index }))
    .sort((left, right) =>
      accentOrder[left.variant.accent] - accentOrder[right.variant.accent]
      || Number(right.variant.hasAudio) - Number(left.variant.hasAudio)
      || left.index - right.index
    )
    .map(({ variant }) => variant)
  for (const candidate of candidates) {
    if (candidate.audioUrl) audioUrls[candidate.id] = candidate.audioUrl
  }
  const firstEntry = payload.find((entry) => entry && typeof entry === 'object')
  const license = readRecord(firstEntry, 'license')
  const sourceUrls = firstEntry && typeof firstEntry === 'object'
    ? (firstEntry as Record<string, unknown>).sourceUrls
    : undefined
  const sourceUrl = Array.isArray(sourceUrls)
    ? sourceUrls.find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : undefined
  const attribution = sourceUrl || readString(license, 'name') || readString(license, 'url')
    ? {
        ...(sourceUrl ? { sourceUrl } : {}),
        ...(readString(license, 'name') ? { licenseName: readString(license, 'name') } : {}),
        ...(readString(license, 'url') ? { licenseUrl: readString(license, 'url') } : {})
      }
    : undefined

  return {
    result: {
      status: 'available',
      word,
      language: 'en',
      variants,
      source: 'dictionaryapi',
      ...(definitions.length > 0 ? { definitions } : {}),
      ...(attribution ? { attribution } : {})
    },
    audioUrls
  }
}
