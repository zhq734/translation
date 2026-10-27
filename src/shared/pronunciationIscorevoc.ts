/** 雅思词汇本地词条的最小结构，仅保留音标、释义和来源。 */
export interface IscorevocEntry {
  /** 规范化英文词条。 */
  word: string
  /** 不带斜线的 IPA 文本。 */
  ipa: string
  /** 中文释义。 */
  definitions: Array<{
    /** 释义正文。 */
    text: string
    /** 释义语言。 */
    language: 'zh'
    /** 释义来源。 */
    source: 'iscorevoc'
  }>
  /** 词条来源。 */
  source: 'iscorevoc'
}

/**
 * 解析单个 iscorevoc 原始词条。
 * @param value 未信任词条对象。
 * @returns 有效词条；缺少单词或 IPA 时返回 null。
 * @author zhenghq
 */
export function parseIscorevocWord(value: unknown): IscorevocEntry | null {
  // 本地词表同时兼容对象格式和构建阶段生成的紧凑元组格式。
  let wordValue: unknown
  let ipaValue: unknown
  let definitionValue: unknown
  if (Array.isArray(value)) {
    [wordValue, ipaValue, definitionValue] = value
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    wordValue = record.w
    ipaValue = record.ipa
    definitionValue = record.cn
  } else {
    return null
  }
  if (typeof wordValue !== 'string' || typeof ipaValue !== 'string' || typeof definitionValue !== 'string') {
    return null
  }
  const word = wordValue.trim().toLowerCase()
  const ipa = ipaValue.trim().replace(/^\/+|\/+$/gu, '')
  const definition = definitionValue.trim()
  if (!word || !ipa || !definition) return null
  return {
    word,
    ipa,
    definitions: [{ text: definition, language: 'zh', source: 'iscorevoc' }],
    source: 'iscorevoc'
  }
}

/**
 * 解析 iscorevoc 词条数组。
 * @param _payload 原始 JSON 文本。
 * @returns 去重后的有效词条。
 * @author zhenghq
 */
export function parseIscorevocWords(payload: string): IscorevocEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(payload ?? ''))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const entries: IscorevocEntry[] = []
  const seen = new Set<string>()
  for (const value of parsed) {
    const entry = parseIscorevocWord(value)
    if (!entry || seen.has(entry.word)) continue
    seen.add(entry.word)
    entries.push(entry)
  }
  return entries
}
