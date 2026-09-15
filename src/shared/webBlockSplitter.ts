import type { ExtractedWebTextBlock, ExtractedWebTextUnit } from './webPageTranslation'

/** 网页翻译分块。 */
export interface WebTranslationSegment {
  /** 来源段落首个文本单元标识。 */
  unitId: string
  /** 来源文本块标识。 */
  blockId: string
  /** 当前段落覆盖的全部文本单元标识。 */
  unitIds: string[]
  /** 当前块内稳定的分段标识。 */
  segmentId: string
  /** 来源块内的分段序号。 */
  index: number
  /** 当前来源段落拆分出的分段总数。 */
  segmentTotal: number
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

/** 网页翻译请求的默认最大字符数。 */
export const WEB_TRANSLATION_MAX_CHARS_PER_SEGMENT = 5000

/** 默认单批最多包含的网页分段数，控制跨块合并的粒度与首屏延迟。 */
export const WEB_TRANSLATION_DEFAULT_MAX_SEGMENTS_PER_BATCH = 5

/** 跨块合并时用于分隔各分段译文的稳定标记样式。 */
const SEGMENT_MARKER_TEST = /\[\[\[\s*ST-SEG-\d+\s*\]\]\]/u

/**
 * 构造跨块合并时使用的分段标记。
 * @param index 标记序号，从 0 开始。
 * @returns 可被模型原样保留的分段标记。
 * @author zhenghq
 */
function segmentMarker(index: number): string {
  return `\n[[[ST-SEG-${index}]]]\n`
}

/** 跨块合并后的批量翻译请求。 */
export interface WebTranslationBatch {
  /** 批次标识，用于结果去重与缓存。 */
  batchId: string
  /** 批次包含的网页分段，按原文顺序排列。 */
  segments: WebTranslationSegment[]
  /** 实际发送给翻译服务的文本；多段时包含分隔标记。 */
  text: string
  /** 是否包含分隔标记并可拆分回多段。 */
  mergeable: boolean
}

/** 跨块合并配置。 */
export interface WebBatchSplitOptions {
  /** 单批允许的最大字符数，包含分隔标记。 */
  maxChars: number
  /** 单批最多包含的分段数，未提供时使用默认值。 */
  maxBlocksPerBatch?: number
}

/**
 * 将相邻网页分段合并为批量翻译请求，超出字符或分段上限时自动分批。
 * 原文已包含分隔标记的分段会被单独成批，避免拆分时产生歧义。
 * @param segments 已按原文顺序排列的网页分段。
 * @param options 单批字符与分段上限。
 * @returns 有序的批量翻译请求列表。
 * @author zhenghq
 */
export function buildWebTranslationBatches(
  segments: WebTranslationSegment[],
  options: WebBatchSplitOptions
): WebTranslationBatch[] {
  const maxChars = Math.max(1, Math.floor(options.maxChars))
  const configuredSegments = options.maxBlocksPerBatch ?? WEB_TRANSLATION_DEFAULT_MAX_SEGMENTS_PER_BATCH
  const maxSegments = Math.max(1, Math.floor(configuredSegments))
  const batches: WebTranslationBatch[] = []
  let pending: WebTranslationSegment[] = []
  let pendingText = ''

  /**
   * 提交当前累积的分段为一个批次。
   * @returns 无返回值。
   * @author zhenghq
   */
  const flush = (): void => {
    if (pending.length === 0) return
    batches.push(createWebTranslationBatch(pending, pendingText))
    pending = []
    pendingText = ''
  }

  for (const segment of segments) {
    // 原文自带标记时无法可靠区分标记归属，只能单独成批走普通翻译。
    if (SEGMENT_MARKER_TEST.test(segment.text)) {
      flush()
      batches.push(createWebTranslationBatch([segment], segment.text))
      continue
    }
    const candidate = pending.length === 0
      ? segment.text
      : `${pendingText}${segmentMarker(pending.length - 1)}${segment.text}`
    if (pending.length > 0 && (candidate.length > maxChars || pending.length >= maxSegments)) {
      flush()
      pending = [segment]
      pendingText = segment.text
      continue
    }
    pending.push(segment)
    pendingText = candidate
  }
  flush()
  return batches
}

/**
 * 根据分段列表构造批量翻译请求。
 * @param segments 批次包含的分段。
 * @param text 发送给翻译服务的文本。
 * @returns 批量翻译请求；单段批次不含标记。
 * @author zhenghq
 */
function createWebTranslationBatch(segments: WebTranslationSegment[], text: string): WebTranslationBatch {
  return {
    batchId: segments.map((segment) => segment.segmentId).join('|'),
    segments: segments.slice(),
    text,
    mergeable: segments.length > 1
  }
}

/**
 * 将批量翻译结果按分隔标记拆回各分段译文。
 * @param batch 原始批量翻译请求。
 * @param translation 翻译服务返回的整批译文。
 * @returns 与批次分段一一对应的译文；标记缺失、乱序或数量不符时返回 null。
 * @author zhenghq
 */
export function parseMergedTranslation(batch: WebTranslationBatch, translation: string): string[] | null {
  if (batch.segments.length <= 1) return [translation.trim()]
  const count = batch.segments.length
  const pattern = /\[\[\[\s*ST-SEG-(\d+)\s*\]\]\]/gu
  const markers: Array<{ index: number; start: number; end: number }> = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(translation)) !== null) {
    markers.push({ index: Number(match[1]), start: match.index, end: match.index + match[0].length })
  }
  // 标准协议包含 count - 1 个分隔标记；部分模型会额外回显最后一段的标记，也予以兼容。
  if (markers.length !== count - 1 && markers.length !== count) return null
  for (let index = 0; index < markers.length; index += 1) {
    if (markers[index].index !== index) return null
  }
  const parts: string[] = []
  let lastIndex = 0
  for (let index = 0; index < count - 1; index += 1) {
    parts.push(translation.slice(lastIndex, markers[index].start))
    lastIndex = markers[index].end
  }
  if (markers.length === count) {
    // 末段标记之后必须没有实际内容，否则视为模型改写了结构，交由调用方逐段回退。
    if (translation.slice(markers[count - 1].end).trim() !== '') return null
    parts.push(translation.slice(lastIndex, markers[count - 1].start))
  } else {
    parts.push(translation.slice(lastIndex))
  }
  return parts.map((part) => part.trim())
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
  const unitsByBlock = new Map<string, ExtractedWebTextUnit[]>()
  for (const unit of units) {
    const list = unitsByBlock.get(unit.blockId)
    if (list) list.push(unit)
    else unitsByBlock.set(unit.blockId, [unit])
  }
  for (const blockUnits of unitsByBlock.values()) {
    // 文本单元的 text 已去除首尾空白，必须用 sourceText 拼接，避免相邻词被粘连。
    const text = blockUnits.map((unit) => unit.sourceText).join('').replace(/\s+/gu, ' ').trim()
    if (!text) continue
    const primary = blockUnits[0]
    const parts = splitText(text, maxChars, options.locale)
    parts.forEach((part, index) => {
      segments.push({
        unitId: primary.id,
        blockId: primary.blockId,
        unitIds: blockUnits.map((unit) => unit.id),
        segmentId: `${primary.id}:${index}`,
        index,
        segmentTotal: parts.length,
        text: part
      })
    })
  }
  return segments
}
