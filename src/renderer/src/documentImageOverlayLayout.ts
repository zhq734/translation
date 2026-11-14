import type {
  DocumentBoundingBox,
  DocumentImageBlock,
  DocumentTextBlock
} from '../../shared/documentTypes'
import {
  setCssPixelPropertyIfChanged,
  resolveDocumentImageStackBounds,
  resolveDocumentImageStackMemberOffset
} from './documentImageStackLayout'

type ImageOverlayMaskPixel = {
  red: number
  green: number
  blue: number
  alpha: number
}

type ImageOverlayMaskRect = {
  left: number
  top: number
  right: number
  bottom: number
}

type ImageOverlayMaskCanvas = {
  context: CanvasRenderingContext2D
  image: HTMLImageElement
}

const imageOverlayMaskCanvasCache = new WeakMap<HTMLImageElement, ImageOverlayMaskCanvas | null>()

/**
 * 计算图片覆盖组的普通流边界。
 * 普通流占位只由叠放底图的并集决定；图内原生文字只做绝对覆盖，原始 bbox 底边
 * 以内的行盒不撑高组高度，译文换行超出 bbox 底边时由 normalizeImageOverlayLayout 扩展。
 * @param images 同一覆盖组内的图片区块。
 * @param _texts 同一覆盖组内的原生文字区块；保留参数用于兼容统一调用语义。
 * @returns 图片并集边界；没有有效图片坐标时返回 undefined。
 * @author zhenghq
 */
export function resolveDocumentImageOverlayBounds(
  images: readonly DocumentImageBlock[],
  _texts: readonly DocumentTextBlock[] = []
): DocumentBoundingBox | undefined {
  return resolveDocumentImageStackBounds(images)
}

/**
 * 计算覆盖成员相对覆盖组左上角的偏移。
 * 图片和文字渲染器都会写入原页面坐标，进入覆盖组后必须统一改算为组内相对坐标。
 * @param bbox 成员在原页面中的边界。
 * @param bounds 覆盖组并集边界。
 * @returns 相对覆盖组左上角的横向与纵向偏移。
 * @author zhenghq
 */
export function resolveDocumentImageOverlayMemberOffset(
  bbox: DocumentBoundingBox,
  bounds: DocumentBoundingBox
): { left: number; top: number } {
  return {
    left: bbox.x - bounds.x,
    top: bbox.y - bounds.y
  }
}

/**
 * 计算图片覆盖文字遮罩色；只平均完全不透明像素，避免透明边缘把背景色拉向纸张白色。
 * @param pixels 从底图局部邻域采样的 RGBA 像素。
 * @returns 可直接写入 CSS 的 RGB 颜色；没有不透明像素时返回 undefined。
 * @author zhenghq
 */
export function resolveImageOverlayTextMaskColor(
  pixels: readonly ImageOverlayMaskPixel[]
): string | undefined {
  let red = 0
  let green = 0
  let blue = 0
  let count = 0
  for (const pixel of pixels) {
    if (pixel.alpha !== 255) continue
    red += pixel.red
    green += pixel.green
    blue += pixel.blue
    count += 1
  }
  if (count === 0) return undefined
  return `rgb(${Math.round(red / count)} ${Math.round(green / count)} ${Math.round(blue / count)})`
}

/**
 * 将页面坐标矩形裁剪到图片实际绘制区域。
 * @param rect 待裁剪矩形。
 * @param bounds 图片绘制边界。
 * @returns 有面积的交集；完全不相交时返回 undefined。
 * @author zhenghq
 */
function intersectImageOverlayMaskRect(
  rect: ImageOverlayMaskRect,
  bounds: ImageOverlayMaskRect
): ImageOverlayMaskRect | undefined {
  const intersection = {
    left: Math.max(rect.left, bounds.left),
    top: Math.max(rect.top, bounds.top),
    right: Math.min(rect.right, bounds.right),
    bottom: Math.min(rect.bottom, bounds.bottom)
  }
  return intersection.right > intersection.left && intersection.bottom > intersection.top
    ? intersection
    : undefined
}

/**
 * 读取图片像素并在文字上下边缘外侧采集背景，避开文字 bbox 内的原始字形。
 * @param image 已加载的底图。
 * @param textRect 文字在页面中的实际边界。
 * @param imageRect 图片在页面中的实际边界。
 * @returns 文字局部背景的平均颜色；图片未就绪或无法读取像素时返回 undefined。
 * @author zhenghq
 */
function sampleImageOverlayTextMaskColor(
  image: HTMLImageElement,
  textRect: ImageOverlayMaskRect,
  imageRect: ImageOverlayMaskRect
): string | undefined {
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return undefined
  const clippedText = intersectImageOverlayMaskRect(textRect, imageRect)
  if (!clippedText) return undefined

  let cached = imageOverlayMaskCanvasCache.get(image)
  if (cached === undefined) {
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) {
      imageOverlayMaskCanvasCache.set(image, null)
      cached = null
    } else {
      try {
        context.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight)
        cached = { context, image }
        imageOverlayMaskCanvasCache.set(image, cached)
      } catch {
        imageOverlayMaskCanvasCache.set(image, null)
        cached = null
      }
    }
  }
  if (!cached) return undefined

  const scaleX = cached.image.naturalWidth / Math.max(1, imageRect.right - imageRect.left)
  const scaleY = cached.image.naturalHeight / Math.max(1, imageRect.bottom - imageRect.top)
  const horizontalPadding = Math.max(1, clippedText.right - clippedText.left) * 0.08
  const sampleLeft = clippedText.left + horizontalPadding
  const sampleRight = clippedText.right - horizontalPadding
  const textHeight = Math.max(1, clippedText.bottom - clippedText.top)
  const bandGap = Math.max(0.75, Math.min(1.5, textHeight * 0.15))
  const bandHeight = Math.max(1, Math.min(4, textHeight * 0.6))
  const bands: ImageOverlayMaskRect[] = [
    {
      left: sampleLeft,
      top: clippedText.top - bandGap - bandHeight,
      right: sampleRight,
      bottom: clippedText.top - bandGap
    },
    {
      left: sampleLeft,
      top: clippedText.bottom + bandGap,
      right: sampleRight,
      bottom: clippedText.bottom + bandGap + bandHeight
    }
  ]

  const pixels: ImageOverlayMaskPixel[] = []
  for (const band of bands) {
    const clippedBand = intersectImageOverlayMaskRect(band, imageRect)
    if (!clippedBand) continue
    const x = Math.max(0, Math.floor((clippedBand.left - imageRect.left) * scaleX))
    const y = Math.max(0, Math.floor((clippedBand.top - imageRect.top) * scaleY))
    const width = Math.min(
      cached.image.naturalWidth - x,
      Math.max(1, Math.ceil((clippedBand.right - clippedBand.left) * scaleX))
    )
    const height = Math.min(
      cached.image.naturalHeight - y,
      Math.max(1, Math.ceil((clippedBand.bottom - clippedBand.top) * scaleY))
    )
    if (width <= 0 || height <= 0) continue
    try {
      const data = cached.context.getImageData(x, y, width, height).data
      for (let index = 0; index < data.length; index += 4) {
        pixels.push({
          red: data[index]!,
          green: data[index + 1]!,
          blue: data[index + 2]!,
          alpha: data[index + 3]!
        })
      }
    } catch {
      return undefined
    }
  }
  return resolveImageOverlayTextMaskColor(pixels)
}

/**
 * 将表格图内文字的百分比定位换算为原始文字 bbox 的实际像素矩形。
 * 遮罩只能覆盖图片中已烘焙的原字形，不能使用译文多行行盒，否则会误盖相邻表格内容。
 * @param text 图内文字元素。
 * @param stackRect 图片叠放组的实际边界。
 * @returns 原始文字 bbox 的实际矩形；坐标变量缺失或无效时返回 undefined。
 * @author zhenghq
 */
function resolveTableCellImageTextMaskRect(
  text: HTMLElement,
  stackRect: ImageOverlayMaskRect
): ImageOverlayMaskRect | undefined {
  const left = Number.parseFloat(
    text.style.getPropertyValue('--document-table-cell-image-text-left')
  )
  const top = Number.parseFloat(
    text.style.getPropertyValue('--document-table-cell-image-text-top')
  )
  const width = Number.parseFloat(
    text.style.getPropertyValue('--document-table-cell-image-text-width')
  )
  const height = Number.parseFloat(
    text.style.getPropertyValue('--document-table-cell-image-text-height')
  )
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return undefined
  }
  const rectLeft = stackRect.left + (stackRect.right - stackRect.left) * left / 100
  return {
    left: rectLeft,
    top: stackRect.top + (stackRect.bottom - stackRect.top) * top / 100,
    right: rectLeft + (stackRect.right - stackRect.left) * width / 100,
    bottom: stackRect.top + (stackRect.bottom - stackRect.top) * (top + height) / 100
  }
}

/**
 * 从覆盖组实际叠放底图中为每个图内文字采样局部背景遮罩。
 * 按 DOM 叠放顺序从顶到底选择首个可读到不透明背景的图片，避免把文字本身混入采样区域。
 * @param page 已挂载的译文页面。
 * @returns 无返回值。
 * @author zhenghq
 */
export function applyImageOverlayTextMasks(page: HTMLElement): void {
  const overlays = page.querySelectorAll<HTMLElement>(
    '.document-image-overlay, .document-table-cell-image-stack'
  )
  for (const overlay of overlays) {
    const isTableCellStack = overlay.classList?.contains('document-table-cell-image-stack') ?? false
    const images = Array.from(overlay.querySelectorAll<HTMLImageElement>(
      isTableCellStack
        ? ':scope > .document-image-block[data-image-stack-member="true"] > img.document-page-image'
        : ':scope > .document-image-block[data-image-overlay-member="true"] > img.document-page-image'
    ))
    if (images.length === 0) continue
    for (const text of overlay.querySelectorAll<HTMLElement>(
      isTableCellStack
        ? ':scope > .document-text-block[data-table-cell-image-text="true"]'
        : ':scope > .document-text-block[data-image-overlay-text="true"]'
    )) {
      const textRect = text.getBoundingClientRect()
      if (textRect.width <= 0 || textRect.height <= 0) continue
      const overlayRect = isTableCellStack ? overlay.getBoundingClientRect() : undefined
      const sourceTextRect = overlayRect
        ? resolveTableCellImageTextMaskRect(text, overlayRect) ?? textRect
        : textRect
      if (isTableCellStack) {
        const padding = Math.max(1, (sourceTextRect.bottom - sourceTextRect.top) * 0.15)
        text.style.setProperty(
          '--document-table-cell-image-text-mask-width',
          `${Math.max(1, sourceTextRect.right - sourceTextRect.left)}px`
        )
        text.style.setProperty(
          '--document-table-cell-image-text-mask-height',
          `${Math.max(1, sourceTextRect.bottom - sourceTextRect.top)}px`
        )
        text.style.setProperty(
          '--document-table-cell-image-text-mask-padding',
          `${padding}px`
        )
      }
      const maskProperty = isTableCellStack
        ? '--document-table-cell-image-text-mask-color'
        : '--document-image-overlay-text-mask-color'
      if (text.style.getPropertyValue(maskProperty)) continue
      for (let index = images.length - 1; index >= 0; index -= 1) {
        const image = images[index]!
        const imageRect = image.getBoundingClientRect()
        if (imageRect.width <= 0 || imageRect.height <= 0) continue
        if (!intersectImageOverlayMaskRect(sourceTextRect, imageRect)) continue
        const color = sampleImageOverlayTextMaskColor(image, sourceTextRect, imageRect)
        if (!color) continue
        text.style.setProperty(maskProperty, color)
        break
      }
    }
  }
}

/**
 * 创建图片覆盖组，让叠放底图与图内原生文字共享一次普通流占位。
 * 图片按 stackOrder 从底到顶绘制，原生文字最后绝对定位在图片之上。
 * @param images 覆盖组内的图片区块。
 * @param texts 覆盖组内的原生文字区块。
 * @param pageWidth 原始页面宽度。
 * @param renderImage 图片成员渲染函数。
 * @param renderText 原生文字成员渲染函数。
 * @returns 图片覆盖组容器。
 * @author zhenghq
 */
export function createDocumentImageOverlayGroup(
  images: readonly DocumentImageBlock[],
  texts: readonly DocumentTextBlock[],
  pageWidth: number,
  renderImage: (block: DocumentImageBlock) => HTMLElement,
  renderText: (block: DocumentTextBlock) => HTMLElement
): HTMLElement {
  const overlay = document.createElement('div')
  overlay.className = 'document-image-overlay'
  overlay.dataset.overlayGroupId = images[0]?.overlayGroupId ?? texts[0]?.overlayGroupId ?? ''
  const bounds = resolveDocumentImageOverlayBounds(images, texts)
  if (bounds) {
    overlay.style.setProperty('--document-image-left', `${Math.max(0, Math.min(pageWidth, bounds.x))}px`)
    overlay.style.setProperty('--document-image-width', `${Math.max(1, bounds.width)}px`)
    overlay.style.setProperty('--document-image-height', `${Math.max(1, bounds.height)}px`)
    overlay.style.setProperty('--document-image-overlay-height', `${Math.max(1, bounds.height)}px`)
    overlay.style.setProperty('--document-image-overlay-base-height', `${Math.max(1, bounds.height)}px`)
  }
  const orderedImages = [...images].sort((left, right) =>
    (left.stackOrder ?? 0) - (right.stackOrder ?? 0))
  for (const block of orderedImages) {
    const member = renderImage(block)
    member.dataset.imageOverlayMember = 'true'
    member.dataset.stackOrder = String(block.stackOrder ?? 0)
    if (bounds && block.bbox) {
      const offset = resolveDocumentImageOverlayMemberOffset(block.bbox, bounds)
      member.style.setProperty('--document-image-overlay-member-left', `${offset.left}px`)
      member.style.setProperty('--document-image-overlay-member-top', `${offset.top}px`)
      // 只给底图本身分层；成员容器不能建立堆叠上下文，否则底层图片的 OCR 译文无法盖过上层底图。
      member.style.setProperty('--document-image-overlay-layer', String((block.stackOrder ?? 0) + 1))
    }
    overlay.append(member)
  }
  for (const block of texts) {
    const member = renderText(block)
    member.dataset.imageOverlayText = 'true'
    if (bounds && block.bbox) {
      const offset = resolveDocumentImageOverlayMemberOffset(block.bbox, bounds)
      member.style.setProperty('--document-image-overlay-text-left', `${offset.left}px`)
      member.style.setProperty('--document-image-overlay-text-top', `${offset.top}px`)
      member.style.setProperty('--document-image-overlay-text-width', `${Math.max(1, block.bbox.width)}px`)
      // 图内原生文字仍绝对覆盖在原位置；原始 bbox 是最小占位，译文换行超出
      // bbox 底边时由 normalizeImageOverlayLayout 按实际底边扩展组高度。
      member.style.setProperty(
        '--document-image-overlay-text-height',
        `${Math.max(1, block.bbox.height)}px`
      )
    }
    overlay.append(member)
  }
  return overlay
}

/**
 * 依据覆盖组中图片或 OCR 译文的实际 DOM 底边更新组容器高度。
 * 图内原生文字的原始 bbox（含本身越出图片底边的部分）是既有预留空间，不改变组高；
 * 只有译文换行实际超出原始 bbox 底边时，才把新增高度计入普通流占位，
 * 避免长译文直接压在覆盖组下方的正文上。
 * @param page 已挂载的译文页面。
 * @returns 无返回值。
 * @author zhenghq
 */
export function normalizeImageOverlayLayout(page: HTMLElement): void {
  if (!page.isConnected) return
  const parsedScale = Number.parseFloat(page.style.getPropertyValue('--document-page-scale'))
  const scale = Number.isFinite(parsedScale) && parsedScale > 0 ? parsedScale : 1
  for (const overlay of page.querySelectorAll<HTMLElement>('.document-image-overlay')) {
    const overlayRect = overlay.getBoundingClientRect()
    const sourceHeight = Math.max(1, Number.parseFloat(
      overlay.style.getPropertyValue('--document-image-overlay-base-height')
    ) || Number.parseFloat(
      overlay.style.getPropertyValue('--document-image-overlay-height')
    ) || 1)
    let flowHeight = sourceHeight * scale
    for (const member of overlay.querySelectorAll<HTMLElement>(
      ':scope > .document-image-block[data-image-overlay-member="true"]'
    )) {
      const memberRect = member.getBoundingClientRect()
      // 覆盖组塌陷时成员坐标仍以组顶部为基准；只有拿到有效成员底边才扩展流式占位。
      if (Number.isFinite(memberRect.bottom) && memberRect.bottom > overlayRect.top) {
        flowHeight = Math.max(flowHeight, memberRect.bottom - overlayRect.top)
      }
    }
    for (const member of overlay.querySelectorAll<HTMLElement>(
      ':scope > .document-text-block[data-image-overlay-text="true"]'
    )) {
      const memberRect = member.getBoundingClientRect()
      // 覆盖组塌陷时成员坐标仍以组顶部为基准；拿不到有效底边时跳过。
      if (!Number.isFinite(memberRect.bottom) || memberRect.bottom <= overlayRect.top) continue
      const textTop = Number.parseFloat(
        member.style?.getPropertyValue('--document-image-overlay-text-top') ?? ''
      )
      const textHeight = Number.parseFloat(
        member.style?.getPropertyValue('--document-image-overlay-text-height') ?? ''
      )
      // 原始 bbox 变量缺失（旧快照或无坐标成员）时无法判断换行是否越界，保持旧行为不扩展。
      if (!Number.isFinite(textTop) || !Number.isFinite(textHeight)) continue
      const reservedBottom = (textTop + textHeight) * scale
      const memberBottom = memberRect.bottom - overlayRect.top
      if (memberBottom > reservedBottom) {
        flowHeight = Math.max(flowHeight, memberBottom)
      }
    }
    // 自定义属性参与 calc 时必须带长度单位，否则浏览器会把整条高度声明判为无效。
    setCssPixelPropertyIfChanged(
      overlay,
      '--document-image-overlay-height',
      Math.max(1, flowHeight / scale)
    )
  }
  applyImageOverlayTextMasks(page)
}

/**
 * 解析图片覆盖组成员相对组并集的位置，供预览与导出共用同一坐标语义。
 * @param images 覆盖组图片。
 * @param texts 覆盖组原生文字。
 * @returns 覆盖组并集和成员偏移；没有坐标时返回 undefined。
 * @author zhenghq
 */
export function resolveDocumentImageOverlayLayout(
  images: readonly DocumentImageBlock[],
  texts: readonly DocumentTextBlock[] = []
): {
  bounds: DocumentBoundingBox
  images: Array<{ block: DocumentImageBlock; left: number; top: number }>
  texts: Array<{ block: DocumentTextBlock; left: number; top: number }>
} | undefined {
  const bounds = resolveDocumentImageOverlayBounds(images, texts)
  if (!bounds) return undefined
  return {
    bounds,
    images: images
      .filter((block): block is DocumentImageBlock & { bbox: DocumentBoundingBox } => block.bbox !== undefined)
      .map((block) => ({ block, ...resolveDocumentImageOverlayMemberOffset(block.bbox, bounds) })),
    texts: texts
      .filter((block): block is DocumentTextBlock & { bbox: DocumentBoundingBox } => block.bbox !== undefined)
      .map((block) => ({ block, ...resolveDocumentImageOverlayMemberOffset(block.bbox, bounds) }))
  }
}

// 保留叠放图片偏移函数的同源入口，避免预览层重复实现坐标换算。
export { resolveDocumentImageStackMemberOffset }
