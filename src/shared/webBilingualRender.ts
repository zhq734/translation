import type {
  ExtractedWebTextBlock,
  ExtractedWebTextUnit
} from './webPageTranslation'

/** 对照模式的渲染方式。 */
export type WebBilingualRenderKind = 'inline' | 'skip'

/** 对照译文注入操作。 */
export interface WebBilingualOperation {
  /** 目标块标识。 */
  blockId: string
  /** 目标块选择器。 */
  selector: string
  /** 拼接后的整段译文。 */
  translation: string
}

/** 对照操作构建结果。 */
export interface WebBilingualOperationResult {
  /** 需要注入的块操作。 */
  operations: WebBilingualOperation[]
  /** 按设计跳过渲染的块数量。 */
  skipped: number
  /** 因翻译失败或锚点失配而未渲染的块数量。 */
  unrendered: number
}

/** 对照渲染方式判定输入。 */
export interface WebBilingualRenderInput {
  /** 待判定的语义块。 */
  block: ExtractedWebTextBlock
  /** 该块内的文本单元。 */
  units: readonly ExtractedWebTextUnit[]
}

/** 对照操作构建输入。 */
export interface WebBilingualOperationInput {
  /** 当前页面的全部语义块。 */
  blocks: readonly ExtractedWebTextBlock[]
  /** 当前页面的全部文本单元。 */
  units: readonly ExtractedWebTextUnit[]
  /** 按单元标识索引的译文。 */
  translations: ReadonlyMap<string, string>
}

/** 孤立碎片在对照模式下跳过的最大字符数。 */
const ISOLATED_SKIP_MAX_LENGTH = 40

/**
 * 折叠文本中的连续空白并去除首尾空白。
 * @param value 待规范化的文本。
 * @returns 折叠后的文本。
 * @author zhenghq
 */
function normalizeText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

/**
 * 判断字符串是否含有空白字符。
 * @param value 待判断的字符串。
 * @returns 含有空白字符时返回 true。
 * @author zhenghq
 */
function hasWhitespace(value: string): boolean {
  return /\s/u.test(value)
}

/**
 * 判定语义块在对照模式下应采用内联注入还是跳过渲染。
 * @param input 语义块与其文本单元。
 * @returns 内联注入或跳过。
 * @author zhenghq
 */
export function resolveWebBilingualRenderKind(
  input: WebBilingualRenderInput
): WebBilingualRenderKind {
  const { block, units } = input
  // 语义属性没有可注入的文本节点，注入会改写可访问名，必须跳过。
  if (units.some((unit) => unit.anchor.semanticAttribute)) return 'skip'
  // Shadow DOM 块的选择器指向宿主，注入会落到错误位置，必须跳过。
  if (units.some((unit) => unit.anchor.shadowPath !== undefined)) return 'skip'
  // 按钮与导航撑开后会破坏页面主要交互，必须跳过。
  if (block.type === 'button' || block.type === 'navigation') return 'skip'
  // 短碎片（标签、统计、页脚链接等）注入后会明显撑开布局，必须跳过。
  if (block.category === 'isolated' && normalizeText(block.text).length <= ISOLATED_SKIP_MAX_LENGTH) {
    return 'skip'
  }
  return 'inline'
}

/**
 * 按单元顺序把译文拼成一条整段译文，并按原文首尾空白重建单元间分隔。
 * @param units 按文档顺序排列的文本单元。
 * @param translations 按单元标识索引的译文。
 * @returns 拼接后的整段译文。
 * @author zhenghq
 */
export function composeWebBilingualText(
  units: readonly ExtractedWebTextUnit[],
  translations: ReadonlyMap<string, string>
): string {
  let composed = ''
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index]
    const translation = normalizeText(translations.get(unit.id) ?? '')
    if (!translation) continue
    if (composed) {
      const previous = units[index - 1]
      const separator = hasWhitespace(previous.sourceText.slice(-1)) || hasWhitespace(unit.sourceText.slice(0, 1))
        ? ' '
        : ''
      composed += separator
    }
    composed += translation
  }
  return composed
}

/**
 * 按块聚合译文并构建对照注入操作，同时区分按设计跳过与未对照的块。
 * @param input 当前页面的块、单元与译文。
 * @returns 注入操作与跳过、未对照统计。
 * @author zhenghq
 */
export function buildWebBilingualOperations(
  input: WebBilingualOperationInput
): WebBilingualOperationResult {
  const unitsByBlock = new Map<string, ExtractedWebTextUnit[]>()
  for (const unit of input.units) {
    const list = unitsByBlock.get(unit.blockId)
    if (list) list.push(unit)
    else unitsByBlock.set(unit.blockId, [unit])
  }

  const operations: WebBilingualOperation[] = []
  let skipped = 0
  let unrendered = 0
  const handledBlocks = new Set<string>()

  for (const block of input.blocks) {
    handledBlocks.add(block.id)
    const units = unitsByBlock.get(block.id) ?? []
    if (units.length === 0) {
      unrendered += 1
      continue
    }
    if (resolveWebBilingualRenderKind({ block, units }) === 'skip') {
      skipped += 1
      continue
    }
    const complete = units.every((unit) => typeof input.translations.get(unit.id) === 'string')
    if (!complete) {
      unrendered += 1
      continue
    }
    const translation = composeWebBilingualText(units, input.translations as ReadonlyMap<string, string>)
    if (!translation) {
      unrendered += 1
      continue
    }
    operations.push({ blockId: block.id, selector: block.anchor.selector, translation })
  }

  // 单元存在但对应块快照缺失时无法定位注入点，计入未对照而不是静默丢弃。
  for (const blockId of unitsByBlock.keys()) {
    if (!handledBlocks.has(blockId)) unrendered += 1
  }

  return { operations, skipped, unrendered }
}
