import type { ExtractedWebTextBlock, ExtractedWebTextUnit } from './webPageTranslation'

/** 网页翻译分块。 */
export interface WebTranslationSegment {
  /** 来源文本单元标识。 */
  unitId: string
  /** 来源文本块标识。 */
  blockId: string
  /** 当前块内稳定的分段标识。 */
  segmentId: string
  /** 来源块内的分段序号。 */
  index: number
  /** 待翻译文本。 */
  text: string
}

/** 网页分块配置。 */
export interface WebBlockSplitOptions {
  /** 单个请求允许的最大字符数。 */
  maxChars: number
  /** 句子分割语言，未提供时使用自动分割。 */
  locale?: string
}

/**
 * 按句边界拆分超长文本，必要时再按字符硬切，保证请求长度契约不被突破。
 * @param text 待拆分的文本。
 * @param maxChars 单段最大字符数。
 * @param locale 可选的语言标签。
 * @returns 不超过上限且拼接后等于原文的文本段。
 * @author zhenghq
 */
function splitText(text: string, maxChars: number, locale?: string): string[] {
  if (text.length <= maxChars) return [text]
  const segmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(locale, { granularity: 'sentence' })
    : undefined
  const sentences = segmenter
    ? Array.from(segmenter.segment(text), (item) => item.segment)
    : text.split(/(?<=[。！？.!?])(?=\s|$)/u)
  const parts: string[] = []
  let current = ''
  /**
   * 将句子或硬切片段追加到当前安全分段。
   * @param piece 待追加文本。
   * @returns 无返回值。
   * @author zhenghq
   */
  const append = (piece: string): void => {
    if (!piece) return
    if (piece.length > maxChars) {
      if (current) {
        parts.push(current)
        current = ''
      }
      for (let offset = 0; offset < piece.length; offset += maxChars) {
        parts.push(piece.slice(offset, offset + maxChars))
      }
      return
    }
    if (current && current.length + piece.length > maxChars) {
      parts.push(current)
      current = ''
    }
    current += piece
  }
  for (const sentence of sentences) append(sentence)
  if (current) parts.push(current)
  return parts.length ? parts : [text]
}

/**
 * 将网页文本块转换为批量翻译请求，短段落保持原块，长段落按句边界拆分。
 * @param blocks 网页文本块列表。
 * @param options 分块上限和语言配置。
 * @returns 有序的翻译分段列表。
 * @author zhenghq
 */
export function splitWebTextBlocks(
  blocks: ExtractedWebTextBlock[],
  options: WebBlockSplitOptions
): WebTranslationSegment[] {
  return splitWebTextUnits(blocks.map((block) => ({
    id: block.id,
    blockId: block.id,
    sourceText: block.text,
    text: block.text,
    anchor: { parentSelector: block.anchor.selector, textNodeIndex: 0, sourceFingerprint: block.anchor.textFingerprint },
    category: block.category,
    ...(block.language ? { language: block.language } : {})
  })), options)
}

/**
 * 将可写回文本单元转换为批量翻译请求。
 * @param units 可写回文本单元列表。
 * @param options 分块上限和语言配置。
 * @returns 有序的翻译分段列表。
 * @author zhenghq
 */
export function splitWebTextUnits(
  units: ExtractedWebTextUnit[],
  options: WebBlockSplitOptions
): WebTranslationSegment[] {
  const maxChars = Math.max(1, Math.floor(options.maxChars))
  const segments: WebTranslationSegment[] = []
  for (const unit of units) {
    const text = unit.text
    if (!text) continue
    splitText(text, maxChars, options.locale).forEach((part, index) => {
      segments.push({
        unitId: unit.id,
        blockId: unit.blockId,
        segmentId: `${unit.id}:${index}`,
        index,
        text: part
      })
    })
  }
  return segments
}
