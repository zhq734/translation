/** 目标语言校验所需的源文与语言方向。 */
export interface AiTranslationLanguageGuard {
  /** 本次请求的完整原文。 */
  sourceText: string
  /** 源语言代码；auto 表示交由提供方检测。 */
  sourceLang: string
  /** 目标语言代码。 */
  targetLang: string
}

/** 用于目标语言校验的字符阈值。 */
const LANGUAGE_GUARD_MIN_MEANINGFUL_CHARACTERS = 8
const LANGUAGE_GUARD_CHINESE_TARGET_RATIO = 0.25
const LANGUAGE_GUARD_SENTENCE_BOUNDARY = /[.!?;:。！？；：]/u
const LANGUAGE_GUARD_SOURCE_ECHO_RATIO = 0.85
const LANGUAGE_GUARD_EXECUTION_STATUS =
  /(?:已|成功)?(?:生成|创建|绘制|切换|调用|执行)|(?:generated|created|rendered|switched|called|executed|recommend(?:ed|ing)?\s+(?:another|a different)\s+model)/iu

/**
 * 统计文本中匹配指定全局正则的字符数。
 * @param text 待统计文本。
 * @param pattern 全局正则表达式。
 * @returns 匹配字符数。
 * @author zhenghq
 */
function countCharacters(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length
}

/**
 * 去掉 URL、代码和协议标记，避免它们干扰语言方向判断。
 * @param text 待处理文本。
 * @returns 只保留自然语言部分的文本。
 * @author zhenghq
 */
function stripLanguageNoise(text: string): string {
  return text
    .replace(/https?:\/\/[^\s<>"']+/giu, ' ')
    .replace(/`[^`\n]+`/gu, ' ')
    .replace(/\[\[\[[^\]\n]+\]\]\]/gu, ' ')
    .replace(/\{\{[^{}\n]+\}\}/gu, ' ')
}

/**
 * 判断文本是否足以按脚本方向判断语言。
 * @param text 已去掉协议噪声的文本。
 * @returns 达到最小自然语言长度时返回 true。
 * @author zhenghq
 */
function hasLanguageContext(text: string): boolean {
  const chineseCharacters = countCharacters(text, /[\u3400-\u9fff]/gu)
  const latinLetters = countCharacters(text, /[A-Za-z]/gu)
  return chineseCharacters + latinLetters >= LANGUAGE_GUARD_MIN_MEANINGFUL_CHARACTERS
}

/**
 * 判断目标语言主体是否已经出现在文本中。
 * @param text 已去掉协议噪声的文本。
 * @param targetLang 目标语言代码。
 * @returns 文本符合目标语言主体比例时返回 true；非中英目标暂不拦截。
 * @author zhenghq
 */
function containsTargetLanguage(text: string, targetLang: string): boolean {
  const chineseCharacters = countCharacters(text, /[\u3400-\u9fff]/gu)
  const latinLetters = countCharacters(text, /[A-Za-z]/gu)
  const meaningfulCharacters = chineseCharacters + latinLetters
  if (meaningfulCharacters === 0) return true
  if (targetLang === 'ZH') {
    return chineseCharacters / meaningfulCharacters >= LANGUAGE_GUARD_CHINESE_TARGET_RATIO
  }
  if (targetLang === 'EN') {
    return chineseCharacters / meaningfulCharacters < 0.2
  }
  return true
}

/**
 * 判断文本是否主要由中文书写。
 * @param text 已去掉协议噪声的文本。
 * @returns 中文字符占自然语言主体时返回 true。
 * @author zhenghq
 */
function isPredominantlyChinese(text: string): boolean {
  const chineseCharacters = countCharacters(text, /[\u3400-\u9fff]/gu)
  const latinLetters = countCharacters(text, /[A-Za-z]/gu)
  const meaningfulCharacters = chineseCharacters + latinLetters
  return meaningfulCharacters > 0 && chineseCharacters > latinLetters
}

/**
 * 判断文本是否主要由拉丁字母书写。
 * @param text 已去掉协议噪声的文本。
 * @returns 拉丁字母占自然语言主体时返回 true。
 * @author zhenghq
 */
function isPredominantlyLatin(text: string): boolean {
  const chineseCharacters = countCharacters(text, /[\u3400-\u9fff]/gu)
  const latinLetters = countCharacters(text, /[A-Za-z]/gu)
  const meaningfulCharacters = chineseCharacters + latinLetters
  return meaningfulCharacters > 0 && latinLetters > chineseCharacters
}

/**
 * 计算短文本的词元集合相似度，用于识别模型原样复述了源文而没有翻译。
 * @param left 已规范化的文本。
 * @param right 已规范化的文本。
 * @returns 两侧词元交集占较小集合的比例。
 * @author zhenghq
 */
function tokenOverlapRatio(left: string, right: string): number {
  const leftTokens = new Set(left.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  const rightTokens = new Set(right.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0
  let shared = 0
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1
  }
  return shared / Math.min(leftTokens.size, rightTokens.size)
}

/**
 * 判断模型输出是否明显使用了错误的目标语言，主要用于拦截误执行原文指令后的说明文本。
 * @param translation 模型已清洗的输出。
 * @param guard 本次请求的源文与语言方向。
 * @returns 输出达到句级长度且明显不是目标语言时返回 true。
 * @author zhenghq
 */
export function isWrongTargetLanguage(translation: string, guard: AiTranslationLanguageGuard): boolean {
  const targetLang = guard.targetLang.trim().toUpperCase()
  if (targetLang !== 'ZH' && targetLang !== 'EN') return false
  const source = stripLanguageNoise(guard.sourceText)
  const output = stripLanguageNoise(translation)
  if (!hasLanguageContext(output)) return false

  if (containsTargetLanguage(output, targetLang)) return false

  const sourceDominatesOutput = targetLang === 'EN'
    ? isPredominantlyChinese(output)
    : isPredominantlyLatin(output)
  if (!sourceDominatesOutput || !LANGUAGE_GUARD_SENTENCE_BOUNDARY.test(output)) return false

  // 目标为英文时，原文通常已是英文；只有输出明确在报告执行状态时，才能认定它不是译文。
  if (targetLang === 'EN') return LANGUAGE_GUARD_EXECUTION_STATUS.test(output)

  // 目标为中文时，英文输出必须高度复述英文源文或明确报告执行状态，避免误删含大量术语的正常译文。
  return LANGUAGE_GUARD_EXECUTION_STATUS.test(output) ||
    tokenOverlapRatio(source, output) >= LANGUAGE_GUARD_SOURCE_ECHO_RATIO
}

/**
 * 判断尚未完成的流式输出是否可能使用了错误目标语言，避免先展示错误摘要再触发降级。
 * @param translation 当前已清洗的稳定输出。
 * @param guard 本次请求的源文与语言方向。
 * @returns 需要暂缓展示时返回 true。
 * @author zhenghq
 */
export function shouldHoldForLanguageGuard(translation: string, guard: AiTranslationLanguageGuard): boolean {
  const targetLang = guard.targetLang.trim().toUpperCase()
  if (targetLang !== 'ZH' && targetLang !== 'EN') return false
  const source = stripLanguageNoise(guard.sourceText)
  const output = stripLanguageNoise(translation)
  if (!output.trim() || containsTargetLanguage(source, targetLang)) return false
  if (targetLang === 'EN') {
    const chineseCharacters = countCharacters(output, /[\u3400-\u9fff]/gu)
    const latinLetters = countCharacters(output, /[A-Za-z]/gu)
    return chineseCharacters > 0 && chineseCharacters >= latinLetters
  }
  const chineseCharacters = countCharacters(output, /[\u3400-\u9fff]/gu)
  const latinLetters = countCharacters(output, /[A-Za-z]/gu)
  return latinLetters > 0 && latinLetters >= chineseCharacters
}
