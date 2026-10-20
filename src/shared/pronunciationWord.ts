/** 单个英文单词的识别结果。 */
export interface ParsedPronunciationWord {
  /** 界面展示并用于上下文的规范化单词。 */
  word: string
  /** 首次词典请求使用的查询词；所有格会回退到基础词。 */
  lookupWord: string
  /** 是否为需要基础词回退的所有格形式。 */
  possessive: boolean
}

/** 原文分词中的可查询单词片段。 */
export interface PronunciationWordSegment {
  /** 片段类型。 */
  kind: 'word'
  /** 与原文完全一致的文本。 */
  text: string
  /** 用于查询的规范化单词信息。 */
  word: ParsedPronunciationWord
}

/** 原文分词中的普通文本片段。 */
export interface PronunciationTextSegment {
  /** 片段类型。 */
  kind: 'text'
  /** 与原文完全一致的文本。 */
  text: string
}

/** 原文分词片段。 */
export type PronunciationSegment = PronunciationWordSegment | PronunciationTextSegment

/** 原文形态分类。 */
export type PronunciationTextKind = 'word' | 'paragraph' | 'unsupported'

/** 单词允许的最大字符数。 */
export const PRONUNCIATION_WORD_MAX_LENGTH = 64

const WORD_PATTERN = /^[A-Za-z]+(?:['-][A-Za-z]+)*$/u
const WORD_AT_CURSOR_PATTERN = /^[A-Za-z]+(?:['’\-][A-Za-z]+)*/u
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s]+/giu
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/giu
const NON_POSSESSIVE_S_WORDS = new Set([
  "it's",
  "he's",
  "she's",
  "that's",
  "what's",
  "who's",
  "there's",
  "here's",
  "where's",
  "let's",
  "this's",
  "how's",
  "when's",
  "why's"
])

/**
 * 把弯撇号统一为直撇号并清理单词首尾标点。
 * @param value 原始单词或选区文本。
 * @returns 清理后的候选单词；输入为空时返回空字符串。
 * @author zhenghq
 */
export function normalizePronunciationWord(value: string): string {
  return String(value ?? '')
    .replace(/[’‘]/gu, "'")
    .trim()
    .replace(/^[^A-Za-z]+/u, '')
    .replace(/[^A-Za-z]+$/u, '')
}

/**
 * 判断原始输入是否包含会被边界清理掩盖的数字。
 * @param value 原始单词或选区文本。
 * @returns 包含 ASCII 数字时返回 true。
 * @author zhenghq
 */
function containsDigit(value: string): boolean {
  return /[0-9]/u.test(value)
}

/**
 * 判断规范化单词是否属于当前支持的可查询英文形态。
 * @param word 已规范化的候选单词。
 * @returns 是否符合 ASCII 英文、缩写、所有格或连字符词规则。
 * @author zhenghq
 */
function isSupportedWord(word: string): boolean {
  return word.length > 0
    && word.length <= PRONUNCIATION_WORD_MAX_LENGTH
    && WORD_PATTERN.test(word)
}

/**
 * 判断以 's 结尾的单词是否应作为所有格回退。
 * @param word 已规范化的单词。
 * @returns 需要回退基础词时返回 true。
 * @author zhenghq
 */
function isPossessiveWord(word: string): boolean {
  return /[A-Za-z]'s$/u.test(word) && !NON_POSSESSIVE_S_WORDS.has(word.toLowerCase())
}

/**
 * 识别单个英文单词，并生成展示词与首次查询词。
 * @param value 待识别的文本。
 * @returns 识别结果；包含数字、URL、邮箱、CJK 或超长内容时返回 null。
 * @author zhenghq
 */
export function parsePronunciationWord(value: string): ParsedPronunciationWord | null {
  if (containsDigit(String(value ?? ''))) return null
  const normalized = normalizePronunciationWord(value)
  if (!isSupportedWord(normalized)) return null
  const possessive = isPossessiveWord(normalized)
  return {
    word: normalized,
    lookupWord: possessive ? normalized.slice(0, -2) : normalized,
    possessive
  }
}

/**
 * 判断字符是否可作为英文单词的边界。
 * @param character 待判断字符。
 * @returns 字符不是 ASCII 字母或数字时返回 true。
 * @author zhenghq
 */
function isWordBoundary(character: string | undefined): boolean {
  return character === undefined || !/[A-Za-z0-9]/u.test(character)
}

/**
 * 计算 URL 和邮箱在原文中的保护区间，避免把其中的英文片段拆成查询词。
 * @param text 原始文本。
 * @returns 按起点排序且互不重叠的保护区间。
 * @author zhenghq
 */
function findProtectedRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  for (const pattern of [URL_PATTERN, EMAIL_PATTERN]) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue
      ranges.push({ start: match.index, end: match.index + match[0].length })
    }
  }
  ranges.sort((left, right) => left.start - right.start || right.end - left.end)
  const merged: Array<{ start: number; end: number }> = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end)
      continue
    }
    merged.push({ ...range })
  }
  return merged
}

/**
 * 把原文切分为可查询英文词和保持原样顺序的普通文本片段。
 * @param text 待切分的原文。
 * @returns 不丢失任何字符的分词片段列表。
 * @author zhenghq
 */
export function splitPronunciationText(text: string): PronunciationSegment[] {
  const source = String(text ?? '')
  if (!source) return []
  const protectedRanges = findProtectedRanges(source)
  const segments: PronunciationSegment[] = []
  let index = 0

  while (index < source.length) {
    const protectedRange = protectedRanges.find((range) => range.start === index)
    if (protectedRange) {
      segments.push({ kind: 'text', text: source.slice(protectedRange.start, protectedRange.end) })
      index = protectedRange.end
      continue
    }
    if (protectedRanges.some((range) => index > range.start && index < range.end)) {
      index += 1
      continue
    }

    const match = source.slice(index).match(WORD_AT_CURSOR_PATTERN)?.[0]
    if (match) {
      const previous = source[index - 1]
      const next = source[index + match.length]
      const parsed = isWordBoundary(previous) && isWordBoundary(next)
        ? parsePronunciationWord(match)
        : null
      if (parsed) {
        segments.push({ kind: 'word', text: match, word: parsed })
        index += match.length
        continue
      }
    }

    segments.push({ kind: 'text', text: source[index] })
    index += 1
  }

  return segments
}

/**
 * 判断原文应走单个单词自动查询、段落按需查询还是不支持音标。
 * @param text 当前翻译原文。
 * @returns 原文形态分类。
 * @author zhenghq
 */
export function classifyPronunciationText(text: string): PronunciationTextKind {
  const source = String(text ?? '').trim()
  if (!source) return 'unsupported'
  if (parsePronunciationWord(source)) return 'word'
  return splitPronunciationText(source).filter((segment) => segment.kind === 'word').length > 0
    ? 'paragraph'
    : 'unsupported'
}
