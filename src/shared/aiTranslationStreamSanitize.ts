import { sanitizeAiTranslation } from './aiTranslationSanitize'

/** 可能作为工具调用起始的已知关键字。 */
const TOOL_KEYWORDS = [
  'search',
  'web_search',
  'browse',
  'browser',
  'open',
  'click',
  'fetch',
  'tool',
  'tool_call',
  'function_call',
  'function',
  'functions'
]

/** 可能的译文标签前缀，用于暂存尚未录入完整的标签。 */
const TRANSLATION_LABELS = [
  '译文：',
  '译文:',
  '翻译结果：',
  '翻译结果:',
  '翻译：',
  '翻译:',
  'Translation:',
  'Translated text:',
  'Output:'
]

/**
 * 在文本尾部寻找尚未闭合、可能继续变化的构造起点。
 * @param raw 到目前为止累积的原始文本。
 * @returns 需要从该下标起暂存的起点；全部稳定时返回 raw.length。
 * @author zhenghq
 */
function findUnstableStart(raw: string): number {
  const candidates: number[] = []

  const partialTag = findPartialReasoningTagStart(raw)
  if (partialTag !== null) candidates.push(partialTag)

  const reasoning = findUnclosedReasoningStart(raw)
  if (reasoning !== null) candidates.push(reasoning)

  const fence = findUnclosedFenceStart(raw)
  if (fence !== null) candidates.push(fence)

  const label = findPartialTranslationLabelStart(raw)
  if (label !== null) candidates.push(label)

  const tool = findPartialToolCallStart(raw)
  if (tool !== null) candidates.push(tool)

  if (candidates.length === 0) return raw.length
  return Math.min(...candidates)
}

/**
 * 查找尾部尚未闭合的推理标签前缀，例如 `<thi`。
 * @param raw 原始文本。
 * @returns 标签起始下标；不存在时返回 null。
 * @author zhenghq
 */
function findPartialReasoningTagStart(raw: string): number | null {
  const lastLt = raw.lastIndexOf('<')
  if (lastLt < 0 || raw.indexOf('>', lastLt) >= 0) return null
  const partial = raw.slice(lastLt).toLowerCase()
  const isPrefix = ['think', 'thinking', 'reasoning', 'scratchpad'].some((name) =>
    `<${name}`.startsWith(partial)
  )
  return isPrefix ? lastLt : null
}

/**
 * 查找尚未闭合的推理块起始下标。
 * @param raw 原始文本。
 * @returns 起始下标；不存在未闭合推理块时返回 null。
 * @author zhenghq
 */
function findUnclosedReasoningStart(raw: string): number | null {
  const pattern = /<\s*(\/?)\s*(think|thinking|reasoning|scratchpad)\s*>/giu
  let openStart: number | null = null
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    if (match[1] === '/') {
      if (openStart !== null) openStart = null
    } else {
      openStart = match.index
    }
  }
  return openStart
}

/**
 * 查找尚未闭合的 Markdown 代码围栏起始下标。
 * @param raw 原始文本。
 * @returns 起始下标；围栏已闭合或不存在时返回 null。
 * @author zhenghq
 */
function findUnclosedFenceStart(raw: string): number | null {
  const start = raw.search(/\S/u)
  if (start < 0 || raw.slice(start, start + 3) !== '```') return null
  const fences = raw.match(/```/gu)
  const count = fences?.length ?? 0
  return count % 2 === 1 ? start : null
}

/**
 * 查找尚未录入完整的译文标签起始下标，例如单独输入的「译」。
 * @param raw 原始文本。
 * @returns 起始下标；标签已完整或不存在时返回 null。
 * @author zhenghq
 */
function findPartialTranslationLabelStart(raw: string): number | null {
  const start = raw.search(/\S/u)
  if (start < 0) return null
  const rest = raw.slice(start)
  const normalized = rest.toLowerCase()
  const isPrefix = TRANSLATION_LABELS.some((label) => {
    const lower = label.toLowerCase()
    return rest.length < label.length && lower.startsWith(normalized)
  })
  return isPrefix ? start : null
}

/**
 * 查找尾部可能继续扩展为工具调用或调度指令的起点。
 * @param raw 原始文本。
 * @returns 起始下标；不存在未完成构造时返回 null。
 * @author zhenghq
 */
function findPartialToolCallStart(raw: string): number | null {
  const lineStart = raw.lastIndexOf('\n') + 1
  const line = raw.slice(lineStart)
  const trimmed = line.trimStart()
  if (!trimmed) return null
  const offset = lineStart + (line.length - trimmed.length)

  // 尾部裸关键字可能继续扩展为 search( 等工具调用前缀。
  const trailing = /([A-Za-z_][\w.]*)$/u.exec(trimmed)
  if (trailing) {
    const token = trailing[1].toLowerCase()
    if (TOOL_KEYWORDS.some((keyword) => keyword.startsWith(token))) {
      return offset + trailing.index
    }
  }

  // 关键字后的左括号尚未闭合。
  const keywordPattern = new RegExp(`\\b(?:${TOOL_KEYWORDS.join('|')})\\s*\\(`, 'iu')
  const open = keywordPattern.exec(trimmed)
  if (open && !hasBalancedParenthesis(trimmed, open.index + open[0].length - 1)) {
    return offset + open.index
  }

  // 调度指令只录入到 `fast|` 或 `fast|trans` 等半成品时暂存整行。
  if (/\|\s*[A-Za-z_-]*$/u.test(trimmed)) {
    return offset
  }
  return null
}

/**
 * 判断指定左括号是否有对应的右括号。
 * @param text 待检查文本。
 * @param openIndex 左括号下标。
 * @returns 已闭合返回 true，否则返回 false。
 * @author zhenghq
 */
function hasBalancedParenthesis(text: string, openIndex: number): boolean {
  let depth = 0
  let quote: string | null = null
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return true
    }
  }
  return false
}

/**
 * 将模型原始流式文本安全地增量净化，只返回已经确定不会变化的新增译文。
 * @author zhenghq
 */
export class AiTranslationStreamSanitizer {
  private raw = ''
  private emitted = ''

  /**
   * 追加一段原始流式文本并返回新增的安全译文片段。
   * @param chunk 原始流式文本片段。
   * @returns 本次可以安全展示的新增译文；尚未稳定时返回空字符串。
   * @author zhenghq
   */
  push(chunk: string): string {
    this.raw += chunk
    return this.flushStable()
  }

  /**
   * 结束流式输入并返回完整最终清洗译文，供界面校正、缓存和复制使用。
   * @returns 完整最终清洗译文。
   * @author zhenghq
   */
  finish(): string {
    const cleaned = sanitizeAiTranslation(this.raw)
    this.emitted = cleaned
    return cleaned
  }

  /**
   * 计算并返回当前已经稳定的新增译文。
   * @returns 新增译文片段。
   * @author zhenghq
   */
  private flushStable(): string {
    const stableRaw = this.raw.slice(0, findUnstableStart(this.raw))
    const cleaned = sanitizeAiTranslation(stableRaw)
    if (!cleaned.startsWith(this.emitted)) {
      // 净化结果发生回退时以最新稳定结果为准，避免输出过期片段。
      this.emitted = cleaned
      return cleaned
    }
    const delta = cleaned.slice(this.emitted.length)
    this.emitted = cleaned
    return delta
  }
}
