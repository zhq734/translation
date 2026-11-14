import type {
  DocumentBlock,
  DocumentBoundingBox,
  DocumentImageBlock,
  DocumentTextBlock
} from '../../shared/documentTypes'
import {
  resolveDocumentImageStackContainedTexts,
  resolveDocumentImageStackGroups
} from '../../shared/documentImageStacks'

/**
 * 仅在像素值实际变化时写入元素的内联样式，避免观察器因无意义写入反复触发。
 * @param element 目标元素。
 * @param property 内联样式属性名。
 * @param value 新的像素值。
 * @returns 是否实际写入属性。
 * @author zhenghq
 */
export function setCssPixelPropertyIfChanged(
  element: HTMLElement,
  property: string,
  value: number
): boolean {
  if (!Number.isFinite(value)) return false
  const rawValue = element.style.getPropertyValue(property).trim()
  const currentValue = Number.parseFloat(rawValue)
  // 自定义属性参与 calc 时必须有单位；数值相同但旧值无单位时仍要重写，
  // 否则浏览器会持续把高度声明判为无效并让绝对定位的覆盖组塌陷。
  if (
    /^-?(?:\d+\.?\d*|\.\d+)px$/u.test(rawValue) &&
    Number.isFinite(currentValue) &&
    Math.abs(currentValue - value) < 0.01
  ) {
    return false
  }
  element.style.setProperty(property, `${value}px`)
  return true
}

/**
 * 仅在像素值实际变化时写入元素的内联样式，避免观察器因无意义写入反复触发。
 * @param element 目标元素。
 * @param property 内联样式属性名。
 * @param value 新的像素值。
 * @returns 是否实际写入属性。
 * @author zhenghq
 */
export function setInlinePixelPropertyIfChanged(
  element: HTMLElement,
  property: 'top' | 'height' | 'minHeight',
  value: number
): boolean {
  if (!Number.isFinite(value)) return false
  const currentValue = Number.parseFloat(element.style[property])
  if (Number.isFinite(currentValue) && Math.abs(currentValue - value) < 0.01) return false
  element.style[property] = `${value}px`
  return true
}

/**
 * 计算同一叠放组内全部图片的并集边界。
 * @param blocks 叠放组内的图片区块。
 * @returns 并集边界；组内没有有效坐标时返回 undefined。
 * @author zhenghq
 */
export function resolveDocumentImageStackBounds(
  blocks: readonly DocumentImageBlock[]
): DocumentBoundingBox | undefined {
  const bounds = blocks
    .map((block) => block.bbox)
    .filter((bbox): bbox is DocumentBoundingBox => bbox !== undefined)
  if (bounds.length === 0) return undefined
  const left = Math.min(...bounds.map((bbox) => bbox.x))
  const top = Math.min(...bounds.map((bbox) => bbox.y))
  const right = Math.max(...bounds.map((bbox) => bbox.x + bbox.width))
  const bottom = Math.max(...bounds.map((bbox) => bbox.y + bbox.height))
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  }
}

/**
 * 计算叠放成员相对组容器左上角的偏移。
 * 成员会先由通用图片渲染器写入原页面绝对坐标，因此进入叠放组时必须显式改算为组内坐标；
 * 否则第二个及后续成员会在已经平移过的组容器内再次叠加页面偏移，视觉上被逐张拆开。
 * @param bbox 成员在原页面中的边界。
 * @param bounds 叠放组的并集边界。
 * @returns 相对组容器左上角的横向与纵向偏移。
 * @author zhenghq
 */
export function resolveDocumentImageStackMemberOffset(
  bbox: DocumentBoundingBox,
  bounds: DocumentBoundingBox
): { left: number; top: number } {
  return {
    left: Math.max(0, bbox.x - bounds.x),
    top: Math.max(0, bbox.y - bounds.y)
  }
}

/** 表格单元格图片叠放布局：组边界以及各成员相对组边界的百分比位置。 */
export interface DocumentTableCellImageStackLayout {
  /** 单元格图片叠放组的并集边界。 */
  bounds: DocumentBoundingBox
  /** 按 stackOrder 排序后的成员百分比布局。 */
  members: Array<{
    /** 图片区块。 */
    block: DocumentImageBlock
    /** 相对组左边界的百分比。 */
    left: number
    /** 相对组上边界的百分比。 */
    top: number
    /** 相对组宽度的百分比。 */
    width: number
    /** 相对组高度的百分比。 */
    height: number
  }>
}

/**
 * 将表格单元格图片的页面坐标换算为叠放组内的百分比坐标。
 * 单元格宽度由表格列动态决定，百分比可以让叠图随列宽整体缩放，同时保留成员之间的覆盖关系。
 * @param blocks 同一单元格内的叠放图片。
 * @returns 叠放组边界与成员布局；没有有效坐标时返回 undefined。
 * @author zhenghq
 */
export function resolveDocumentTableCellImageStackLayout(
  blocks: readonly DocumentImageBlock[]
): DocumentTableCellImageStackLayout | undefined {
  const bounds = resolveDocumentImageStackBounds(blocks)
  if (!bounds) return undefined
  return {
    bounds,
    members: [...blocks]
      .sort((left, right) => (left.stackOrder ?? 0) - (right.stackOrder ?? 0))
      .filter((block): block is DocumentImageBlock & { bbox: DocumentBoundingBox } =>
        block.bbox !== undefined)
      .map((block) => ({
        block,
        left: (block.bbox.x - bounds.x) / bounds.width * 100,
        top: (block.bbox.y - bounds.y) / bounds.height * 100,
        width: block.bbox.width / bounds.width * 100,
        height: block.bbox.height / bounds.height * 100
      }))
  }
}

/**
 * 创建表格单元格图片叠放组；外层只占一次普通流空间，成员按原始相对坐标绝对覆盖。
 * @param blocks 同一叠放组内的图片区块。
 * @param renderImage 图片区块渲染函数，由调用方复用原文或译文侧的资源加载逻辑。
 * @param containedTexts 完全位于叠放组并集内的文本区块。
 * @param renderText 文本区块渲染函数。
 * @returns 表格单元格图片叠放组容器。
 * @author zhenghq
 */
export function createDocumentTableCellImageStackGroup(
  blocks: readonly DocumentImageBlock[],
  renderImage: (block: DocumentImageBlock) => HTMLElement,
  containedTexts: readonly DocumentTextBlock[] = [],
  renderText?: (block: DocumentTextBlock) => HTMLElement
): HTMLElement {
  const stack = document.createElement('div')
  stack.className = 'document-image-stack document-table-cell-image-stack'
  stack.dataset.stackGroupId = blocks[0]?.stackGroupId ?? ''
  stack.dataset.tableCellImageStack = 'true'
  stack.dataset.tableCellContent = 'true'
  const layout = resolveDocumentTableCellImageStackLayout(blocks)
  if (layout) {
    stack.style.setProperty(
      '--document-table-cell-image-ratio',
      `${layout.bounds.width} / ${layout.bounds.height}`
    )
    for (const member of layout.members) {
      const element = renderImage(member.block)
      element.dataset.imageStackMember = 'true'
      element.dataset.stackOrder = String(member.block.stackOrder ?? 0)
      element.style.setProperty('--document-table-cell-image-member-left', `${member.left}%`)
      element.style.setProperty('--document-table-cell-image-member-top', `${member.top}%`)
      element.style.setProperty('--document-table-cell-image-member-width', `${member.width}%`)
      element.style.setProperty('--document-table-cell-image-member-height', `${member.height}%`)
      element.style.setProperty('--document-image-stack-layer', String((member.block.stackOrder ?? 0) + 1))
      stack.append(element)
    }
    for (const text of containedTexts) {
      if (!text.bbox) continue
      const element = renderText?.(text) ?? createFallbackTableCellImageText(text)
      element.dataset.tableCellImageText = 'true'
      element.dataset.tableCellContent = 'true'
      element.style.setProperty(
        '--document-table-cell-image-text-left',
        `${(text.bbox.x - layout.bounds.x) / layout.bounds.width * 100}%`
      )
      element.style.setProperty(
        '--document-table-cell-image-text-top',
        `${(text.bbox.y - layout.bounds.y) / layout.bounds.height * 100}%`
      )
      element.style.setProperty(
        '--document-table-cell-image-text-width',
        `${text.bbox.width / layout.bounds.width * 100}%`
      )
      element.style.setProperty(
        '--document-table-cell-image-text-height',
        `${text.bbox.height / layout.bounds.height * 100}%`
      )
      stack.append(element)
    }
    return stack
  }
  for (const block of blocks) stack.append(renderImage(block))
  return stack
}

/**
 * 在调用方未提供文本渲染器时创建最小文本节点，保持底层布局组合接口向后兼容。
 * @param block 图片叠放范围内的文本区块。
 * @returns 带完整文本内容的文本区块元素。
 * @author zhenghq
 */
function createFallbackTableCellImageText(block: DocumentTextBlock): HTMLElement {
  const element = document.createElement('div')
  element.className = `document-text-block document-text-${block.role}`
  element.dataset.blockId = block.blockId
  element.textContent = block.runs.map((run) => run.text).join('')
  return element
}

/**
 * 渲染表格单元格中的子区块。
 * 显式叠放组和按几何重叠推断出的历史叠放组都只创建一个普通流容器，
 * 其余区块保持原始顺序逐个渲染。
 * @param blocks 单元格内的子区块。
 * @param renderBlock 普通区块渲染函数。
 * @param renderImage 叠放组内图片渲染函数。
 * @param renderText 图片叠放范围内文本渲染函数；缺省时回退到普通区块渲染器。
 * @returns 保持原始内容顺序的单元格元素列表。
 * @author zhenghq
 */
export function renderDocumentTableCellBlocks(
  blocks: readonly DocumentBlock[],
  renderBlock: (block: DocumentBlock) => HTMLElement,
  renderImage: (block: DocumentImageBlock) => HTMLElement,
  renderText?: (block: DocumentTextBlock) => HTMLElement
): HTMLElement[] {
  const groups = resolveDocumentImageStackGroups(blocks)
  const stackByBlock = new Map<DocumentImageBlock, readonly DocumentImageBlock[]>()
  const textByStack = new Map<readonly DocumentImageBlock[], readonly DocumentTextBlock[]>()
  const containedTexts = new Set<DocumentTextBlock>()
  for (const group of groups) {
    for (const block of group.blocks) stackByBlock.set(block, group.blocks)
    const texts = resolveDocumentImageStackContainedTexts(blocks, group.blocks)
    textByStack.set(group.blocks, texts)
    for (const text of texts) containedTexts.add(text)
  }
  const renderedStacks = new Set<readonly DocumentImageBlock[]>()
  const elements: HTMLElement[] = []
  for (const block of blocks) {
    if (block.kind === 'text' && containedTexts.has(block)) continue
    const stackBlocks = block.kind === 'image' ? stackByBlock.get(block) : undefined
    if (!stackBlocks) {
      elements.push(renderBlock(block))
      continue
    }
    if (renderedStacks.has(stackBlocks)) continue
    renderedStacks.add(stackBlocks)
    elements.push(createDocumentTableCellImageStackGroup(
      stackBlocks,
      renderImage,
      textByStack.get(stackBlocks) ?? [],
      renderText ?? renderBlock
    ))
  }
  return elements
}

/**
 * 依据叠放成员的实际高度更新组容器高度，避免 OCR 译文增高后压住后续正文。
 * 成员始终按原文坐标绝对定位，容器只负责在普通流中占用一次并集高度。
 * @param page 已挂载的译文页面。
 * @returns 无返回值。
 * @author zhenghq
 */
export function normalizeImageStackLayout(page: HTMLElement): void {
  if (!page.isConnected) return
  const scale = Number.parseFloat(page.style.getPropertyValue('--document-page-scale')) || 1
  for (const stack of page.querySelectorAll<HTMLElement>('.document-image-stack')) {
    const stackRect = stack.getBoundingClientRect()
    const sourceHeight = Math.max(1, Number.parseFloat(
      stack.style.getPropertyValue('--document-image-stack-base-height')
    ) || Number.parseFloat(stack.style.getPropertyValue('--document-image-stack-height')) || 1)
    let flowHeight = sourceHeight * scale
    for (const member of stack.querySelectorAll<HTMLElement>(
      ':scope > .document-image-block[data-image-stack-member="true"]'
    )) {
      const memberRect = member.getBoundingClientRect()
      flowHeight = Math.max(flowHeight, memberRect.bottom - stackRect.top)
    }
    setCssPixelPropertyIfChanged(stack, '--document-image-stack-height', flowHeight / scale)
  }
}
