type SelectedLineKind = 'prose' | 'list' | 'block'

const LIST_LINE_PATTERN = /^(?:[-*+•]\s+|\d+[.)]\s+)/u
const BLOCK_LINE_PATTERN = /^(?:#{1,6}\s+|>\s+|```|~~~|\|)/u
const INDENTED_CODE_PATTERN = /^(?:\t| {4,})\S/u
const CJK_CHARACTER_PATTERN = /[\u2e80-\u9fff\uf900-\ufaff]/u
// 全角逗号、顿号、分号与冒号紧跟前字，视觉换行合并时其后不应补空格。
const NO_SPACE_AFTER_PATTERN = /[(\[{“‘/\-‐‑–—，、；：]$/u
const NO_SPACE_BEFORE_PATTERN = /^[,.;:!?，。！？；：、)\]}”’]/u
const SENTENCE_END_PATTERN = /[.!?。！？]["'”’）)\]}]*$/u
/**
 * 强编程语言关键字：基本只出现在代码中，命中即认为当前行具备代码特征。
 * 刻意不包含 if/for/return/new/try 等英文常用词，避免普通散文被误判为代码。
 */
const STRONG_CODE_KEYWORD_PATTERN =
  /\b(?:function|const|let|var|import|export|class|extends|def|public|private|protected|static|void|package|namespace|struct|enum|interface|impl|fn|func|async|await|yield)\b/u
/**
 * 弱编程语言关键字：英文中也可能出现，只有同时具备代码标点时才认为具备代码特征。
 */
const WEAK_CODE_KEYWORD_PATTERN =
  /\b(?:return|if|else|elif|for|while|switch|case|default|break|continue|new|try|catch|finally|throw|using|with)\b/u
/** SQL 关键字：仅在整行以大写关键字开头且具备额外 SQL 特征时才命中。 */
const SQL_KEYWORD_PATTERN =
  /^\s*(?:SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|JOIN|GROUP|ORDER|HAVING|LIMIT|OFFSET|VALUES|UNION|DISTINCT|TABLE|INDEX|CASE|WHEN)\b/u
/** SQL 附加特征：逗号、等号、星号、括号或数字，用于降低英文散文误判概率。 */
const SQL_CONTEXT_PATTERN = /[,=*()\d]/u
/** 日志级别关键字：终端日志行通常以级别或带方括号的级别开头。 */
const LOG_LEVEL_PATTERN = /\b(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|VERBOSE)\b/iu
/** 行首方括号级别：如 `[INFO] application starting`。 */
const BRACKETED_LOG_LEVEL_PATTERN =
  /^\s*\[(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|VERBOSE)\]/iu
/** 行首级别加冒号或横线：如 `INFO: started`、`ERROR - failed`。 */
const PREFIXED_LOG_LEVEL_PATTERN =
  /^\s*(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|VERBOSE)\b\s*[:|-]/iu
/** 行首级别后跟线程名或进程号：如 `INFO [main]`、`INFO 12345 ---`。 */
const LOG_LEVEL_WITH_CONTEXT_PATTERN =
  /^\s*(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|VERBOSE)\b\s+(?:\[|\d+\s+---)/iu
/** 行首日期或时间戳：支持 ISO、日期时间、方括号时间与仅时间格式。 */
const LOG_TIMESTAMP_PATTERN =
  /^\s*\[?(?:\d{4}[-/]\d{2}[-/]\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,9})?)\]?/iu
/** 行首小驼峰模块前缀：如 `[capture]`、`[macForeground]`、`[autoLaunch]`。 */
const LOG_MODULE_PREFIX_PATTERN = /^\s*\[[a-z][A-Za-z0-9.-]*\]\s+\S/u

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
 * 判断单行文本是否具备代码特征，用于区分编辑器代码选区与浏览器视觉软换行。
 * 命中花括号、代码运算符、注释、HTML 标签、语言关键字、JSON 键值或函数调用等
 * 任一特征即视为代码行；判定保持保守，避免把普通散文误判为代码。
 * @param rawLine 尚未清理首尾空格的原始行。
 * @returns 当前行具备代码特征时返回 true。
 * @author zhenghq
 */
function isCodeLikeLine(rawLine: string): boolean {
  const line = rawLine.trim()
  if (!line) return false
  if (/^[{}();,[\]]+$/u.test(line)) return true
  if (/[{}]/u.test(line)) return true
  if (/(?:=>|->|::|==|!=|<=|>=|&&|\|\||\+=|-=|\*=|\/=|\+\+|--)/u.test(line)) return true
  if (/\/\/|\/\*|\*\/|^#\s|^<!--/u.test(line)) return true
  if (/^<\/?[A-Za-z][\w:-]*(?:\s[^>]*)?\/?>$/u.test(line)) return true
  if (STRONG_CODE_KEYWORD_PATTERN.test(line)) return true
  if (WEAK_CODE_KEYWORD_PATTERN.test(line) && /[();:{}]/u.test(line)) return true
  if (SQL_KEYWORD_PATTERN.test(line) && SQL_CONTEXT_PATTERN.test(line)) return true
  if (/^["'][\w.$-]+["']\s*:/u.test(line)) return true
  if (/^\s*[A-Za-z_$][\w$.\[\]]*\s*=\s*[^=]/u.test(line)) return true
  // 带类型声明的赋值（如 Java / C# / TypeScript 的 String name = "x"）。
  if (/^[A-Za-z_$][\w$.<>\[\]]*\s+[A-Za-z_$][\w$]*\s*=\s*[^=]/u.test(line)) return true
  if (/^[A-Za-z_$][\w$.]*\s*\([^)]*\)\s*[;{]?\s*$/u.test(line)) return true
  return false
}

/**
 * 判断一次多行选区是否整体更像代码而非自然语言段落。
 * 至少两行具备代码特征，且代码行占比过半时才认定，避免少量代码符号误伤散文。
 * @param lines 已完成基础规范化、按换行拆分后的文本行。
 * @returns 选区整体呈现代码特征时返回 true。
 * @author zhenghq
 */
function looksLikeCodeSelection(lines: string[]): boolean {
  const meaningfulLines = lines.filter((line) => line.trim().length > 0)
  if (meaningfulLines.length < 2) return false
  const codeLineCount = meaningfulLines.filter(isCodeLikeLine).length
  return codeLineCount >= 2 && codeLineCount / meaningfulLines.length >= 0.5
}

/**
 * 判断单行文本是否具备终端日志特征。
 * 命中方括号日志级别、行首级别、级别加线程/进程上下文，或时间戳加级别时返回 true。
 * @param rawLine 尚未清理首尾空格的原始行。
 * @returns 当前行具备终端日志特征时返回 true。
 * @author zhenghq
 */
function isLogLikeLine(rawLine: string): boolean {
  const line = rawLine.trim()
  if (!line) return false
  if (BRACKETED_LOG_LEVEL_PATTERN.test(line)) return true
  if (PREFIXED_LOG_LEVEL_PATTERN.test(line)) return true
  if (LOG_LEVEL_WITH_CONTEXT_PATTERN.test(line)) return true
  if (LOG_MODULE_PREFIX_PATTERN.test(line)) return true
  return LOG_TIMESTAMP_PATTERN.test(line) && LOG_LEVEL_PATTERN.test(line)
}

/**
 * 判断一次多行选区是否整体更像终端日志而非自然语言段落。
 * 至少两行具备日志特征，且日志行占比过半时才认定，避免普通文本中的级别单词误伤散文。
 * @param lines 已完成基础规范化、按换行拆分后的文本行。
 * @returns 选区整体呈现终端日志特征时返回 true。
 * @author zhenghq
 */
function looksLikeLogSelection(lines: string[]): boolean {
  const meaningfulLines = lines.filter((line) => line.trim().length > 0)
  if (meaningfulLines.length < 2) return false
  const logLineCount = meaningfulLines.filter(isLogLikeLine).length
  return logLineCount >= 2 && logLineCount / meaningfulLines.length >= 0.5
}

/**
 * 规范化取词管线捕获的选中文字，将浏览器或文档中的视觉软换行合并，
 * 同时保留空行分隔的段落、列表和块级内容，避免完整句子被逐行翻译。
 * Windows 剪贴板与部分原生直读返回的 CRLF 与 LF 同等对待：浏览器在 Windows
 * 上同样用 CRLF 表示视觉换行，无法与编辑器换行区分，因此统一交给段落、
 * 列表、代码、日志与句末标点启发式判断是否保留换行。
 * @param text 取词管线返回的原始选中文字。
 * @returns 适合语言检测、翻译请求和原文展示的文本。
 * @author zhenghq
 */
export function normalizeSelectedText(text: string): string {
  const normalizedText = String(text ?? '')
    .replace(/\u00ad/gu, '')
    .replace(/\u00a0/gu, ' ')
    .replace(/\r\n?|[\u2028\u2029]/gu, '\n')
    .trim()
  if (!normalizedText.includes('\n')) return normalizedText

  // 编辑器（如 IDEA）和终端通过原生直读返回的代码/日志选区不能套用浏览器
  // 视觉软换行合并规则，否则每一行会被压成一行。这里对整体选区做代码或日志
  // 特征识别，命中时保留换行与行首缩进。
  if (looksLikeCodeSelection(normalizedText.split('\n')) ||
    looksLikeLogSelection(normalizedText.split('\n'))) {
    return normalizedText
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/u, ''))
      .join('\n')
  }

  const lines = normalizedText.split('\n')
  let result = ''
  let previousRawLine = ''
  let paragraphBreakPending = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
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
      const currentKind = classifySelectedLine(rawLine)
      const preserveLineBreak = currentKind !== 'prose'
        || previousKind === 'block'
        || (previousKind === 'prose' && endsCompleteSentence(previousRawLine.trim()))
      result += preserveLineBreak
        ? `\n${line}`
        : `${resolveSoftLineSeparator(previousRawLine.trim(), line)}${line}`
    }

    previousRawLine = rawLine
    paragraphBreakPending = false
  }

  return result
}
