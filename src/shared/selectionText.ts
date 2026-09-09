type SelectedLineKind = 'prose' | 'list' | 'block'

const LIST_LINE_PATTERN = /^(?:[-*+•]\s+|\d+[.)]\s+)/u
const BLOCK_LINE_PATTERN = /^(?:#{1,6}\s+|>\s+|```|~~~|\|)/u
const INDENTED_CODE_PATTERN = /^(?:\t| {4,})\S/u
const CJK_CHARACTER_PATTERN = /[\u2e80-\u9fff\uf900-\ufaff]/u
const NO_SPACE_AFTER_PATTERN = /[(\[{“‘/\-‐‑–—]$/u
const NO_SPACE_BEFORE_PATTERN = /^[,.;:!?，。！？；：、)\]}”’]/u
const SENTENCE_END_PATTERN = /[.!?。！？]["'”’）)\]}]*$/u
const WINDOWS_LINE_BREAK_MARKER = '\uE000'

/**
 * 判断捕获文本中的一行属于普通段落、列表还是需要独立保留的块级内容。
 * @param rawLine 尚未清理首尾空格的原始行。
 * @returns 当前行的语义类型。
 * @author zhenghq
 */
function classifySelectedLine(rawLine: string): SelectedLineKind {
  const trimmedLine = rawLine.trim()
  if (LIST_LINE_PATTERN.test(trimmedLine)) return 'list'
  if (BLOCK_LINE_PATTERN.test(trimmedLine) || INDENTED_CODE_PATTERN.test(rawLine)) return 'block'
  return 'prose'
}

/**
 * 计算两个被软换行分隔的文本片段合并时需要插入的连接符。
 * @param leftLine 换行前的文本片段。
 * @param rightLine 换行后的文本片段。
 * @returns 空字符串或单个空格。
 * @author zhenghq
 */
function resolveSoftLineSeparator(leftLine: string, rightLine: string): string {
  const leftCharacter = leftLine.at(-1) ?? ''
  const rightCharacter = rightLine.at(0) ?? ''
  if (!leftCharacter || !rightCharacter) return ''
  if (CJK_CHARACTER_PATTERN.test(leftCharacter) && CJK_CHARACTER_PATTERN.test(rightCharacter)) {
    return ''
  }
  if (NO_SPACE_AFTER_PATTERN.test(leftCharacter) || NO_SPACE_BEFORE_PATTERN.test(rightCharacter)) {
    return ''
  }
  return ' '
}

/**
 * 判断普通文本行是否已经形成完整句子，可作为 Windows 单个换行表示的段落边界。
 * @param line 换行前已经清理首尾空格的文本行。
 * @returns 行尾为完整句子结束标点时返回 true。
 * @author zhenghq
 */
function endsCompleteSentence(line: string): boolean {
  return SENTENCE_END_PATTERN.test(line)
}

/**
 * 规范化系统剪贴板捕获的选中文字，将浏览器或文档中的单个视觉硬换行合并，
 * 同时保留空行分隔的段落、列表和块级内容，避免完整句子被逐行翻译。
 * @param text 系统剪贴板返回的原始选中文字。
 * @returns 适合语言检测、翻译请求和原文展示的文本。
 * @author zhenghq
 */
export function normalizeSelectedText(text: string): string {
  const normalizedText = String(text ?? '')
    .replace(/\u00ad/gu, '')
    .replace(/\u00a0/gu, ' ')
    .trim()
    // 先裁剪原始选区的首尾空白，再注入仅供内部判断的 Windows 换行标记。
    // 否则末尾 CRLF 会先变成“标记 + 换行”，trim() 只会移除换行，导致标记泄漏到结果。
    .replace(/\r\n/gu, `${WINDOWS_LINE_BREAK_MARKER}\n`)
    .replace(/\r|[\u2028\u2029]/gu, '\n')
  if (!normalizedText.includes('\n')) return normalizedText

  const lines = normalizedText.split('\n')
  let result = ''
  let previousRawLine = ''
  let previousLineEndsWithWindowsBreak = false
  let paragraphBreakPending = false

  for (const rawLine of lines) {
    const lineEndsWithWindowsBreak = rawLine.endsWith(WINDOWS_LINE_BREAK_MARKER)
    const contentRawLine = lineEndsWithWindowsBreak
      ? rawLine.slice(0, -WINDOWS_LINE_BREAK_MARKER.length)
      : rawLine
    const line = contentRawLine.trim()
    if (!line) {
      if (result) paragraphBreakPending = true
      continue
    }

    if (!result) {
      result = line
    } else if (paragraphBreakPending) {
      result += `\n\n${line}`
    } else {
      const previousKind = classifySelectedLine(previousRawLine)
      const currentKind = classifySelectedLine(contentRawLine)
      const preserveLineBreak = previousLineEndsWithWindowsBreak
        || currentKind !== 'prose'
        || previousKind === 'block'
        || (previousKind === 'prose' && endsCompleteSentence(previousRawLine.trim()))
      result += preserveLineBreak
        ? `\n${line}`
        : `${resolveSoftLineSeparator(previousRawLine.trim(), line)}${line}`
    }

    previousRawLine = contentRawLine
    previousLineEndsWithWindowsBreak = lineEndsWithWindowsBreak
    paragraphBreakPending = false
  }

  return result
}
