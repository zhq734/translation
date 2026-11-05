import OpenCC from 'opencc-js'

/** 繁体到简体的字形转换器。 */
const traditionalToSimplified = OpenCC.Converter({ from: 't', to: 'cn' })

/** 简体到台湾繁体的字形转换器。 */
const simplifiedToTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' })

/**
 * 按识别语言规范中文字形，避免 Whisper 返回与用户选择不一致的简繁变体。
 * @param text ASR 返回的原始文本。
 * @param language 用户选择的识别语言。
 * @returns 规范字形后的文本；非中文简繁设置原样返回。
 * @author zhenghq
 */
export function normalizeChineseScript(text: string, language: string): string {
  if (language === 'zh-CN') return traditionalToSimplified(text)
  if (language === 'zh-TW') return simplifiedToTraditional(text)
  return text
}
