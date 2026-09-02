/** 模型推理/思考块，部分模型会把内部推理包在标签里输出。 */
const REASONING_BLOCK = /<\s*(think|thinking|reasoning|scratchpad)\s*>[\s\S]*?<\s*\/\s*\1\s*>/giu

/** 整段被 Markdown 代码块包裹时的匹配模式。 */
const WRAPPING_CODE_FENCE = /^```[A-Za-z0-9_+-]*\s*\n([\s\S]*?)\n?```$/u

/** 译文标签前缀，如「译文：」「Translation:」。 */
const TRANSLATION_LABEL = /^(?:译文|翻译结果|翻译|Translation|Translated(?:\s+text)?|Output)\s*[:：]\s*/iu

/**
 * 工具调用噪声：形如 `search("...")fast|translate phrase`。
 * 仅匹配已知的工具/调度关键字，避免误删译文中的普通函数调用与括号内容。
 */
const TOOL_CALL_NOISE = new RegExp(
  [
    '(?:\\b(?:search|web_search|browse|browser|open|click|fetch|tool|tool_call|function_call|functions?\\.[\\w.]+)',
    '\\s*\\((?:"[^"]*"|\'[^\']*\'|[^()]*)\\)\\s*)',
    '(?:[A-Za-z_][\\w-]*\\s*\\|\\s*)*',
    '(?:translate\\s+(?:phrase|sentence|word|words|text|paragraph|line|segment)?\\s*)?'
  ].join(''),
  'giu'
)

/** 独立成行的调度指令噪声，如 `fast|translate phrase`。 */
const DIRECTIVE_LINE_NOISE =
  /^(?:[A-Za-z_][\w-]*\s*\|\s*)*translate\s+(?:phrase|sentence|word|words|text|paragraph|line|segment)\s*$/iu

/**
 * 清洗 AI 译文，去除工具调用、调度指令、推理块与代码块等噪声，仅保留最终译文。
 * @param raw 模型返回的原始文本，可能为空或非字符串。
 * @returns 只包含最终译文的字符串；全部为噪声时返回空字符串。
 * @author zhenghq
 */
export function sanitizeAiTranslation(raw: string): string {
  let text = String(raw ?? '').replace(/\r\n?/gu, '\n')
  if (!text.trim()) return ''

  text = text.replace(REASONING_BLOCK, '')

  const fenced = text.trim().match(WRAPPING_CODE_FENCE)
  if (fenced) text = fenced[1]

  const lines: string[] = []
  for (const line of text.split('\n')) {
    const stripped = line.replace(TOOL_CALL_NOISE, '').trim()
    const isNoiseOnlyLine = stripped !== line.trim() && stripped === ''
    if (isNoiseOnlyLine) continue
    if (DIRECTIVE_LINE_NOISE.test(stripped)) continue
    lines.push(stripped)
  }

  return lines.join('\n').replace(TRANSLATION_LABEL, '').trim()
}
