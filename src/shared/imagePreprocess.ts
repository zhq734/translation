/** RGBA 图像（8 位，非预乘 alpha，行主序）。 */
export interface RgbaImage {
  /** 图像宽度（像素）。 */
  width: number
  /** 图像高度（像素）。 */
  height: number
  /** 像素数据，每像素 4 字节（R,G,B,A）。 */
  data: Uint8Array
}

/** OCR 输入图像像素总数上限，防止放大后内存与耗时失控。 */
export const MAX_OCR_PIXELS = 850000

/**
 * 按 ITU-R BT.601 权重计算亮度。
 * @param r 红色通道。
 * @param g 绿色通道。
 * @param b 蓝色通道。
 * @returns 亮度值（0-255）。
 * @author zhenghq
 */
export function lumaOf(r: number, g: number, b: number): number {
  return Math.round(r * 0.299 + g * 0.587 + b * 0.114)
}

/**
 * 从图像中裁剪矩形区域，超出边界的部分自动夹取。
 * @param image 源图像。
 * @param rect 裁剪矩形（图像像素坐标）。
 * @returns 裁剪后的新图像；矩形完全越界时返回 0 尺寸图像。
 * @author zhenghq
 */
export function cropRgba(
  image: RgbaImage,
  rect: { x: number; y: number; width: number; height: number }
): RgbaImage {
  const x = Math.max(0, Math.min(Math.round(rect.x), image.width))
  const y = Math.max(0, Math.min(Math.round(rect.y), image.height))
  const width = Math.max(0, Math.min(Math.round(rect.width), image.width - x))
  const height = Math.max(0, Math.min(Math.round(rect.height), image.height - y))
  const data = new Uint8Array(width * height * 4)
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = ((y + row) * image.width + x) * 4
    const targetOffset = row * width * 4
    data.set(image.data.subarray(sourceOffset, sourceOffset + width * 4), targetOffset)
  }
  return { width, height, data }
}

/**
 * 从源图像双线性采样一个像素。
 * @param image 源图像。
 * @param x 采样点 x 坐标（可越界，内部夹取）。
 * @param y 采样点 y 坐标（可越界，内部夹取）。
 * @returns [r, g, b, a] 采样结果。
 * @author zhenghq
 */
function sampleBilinear(
  image: RgbaImage,
  x: number,
  y: number
): [number, number, number, number] {
  const cx = Math.min(Math.max(x, 0), image.width - 1)
  const cy = Math.min(Math.max(y, 0), image.height - 1)
  const x0 = Math.min(Math.floor(cx), image.width - 1)
  const y0 = Math.min(Math.floor(cy), image.height - 1)
  const x1 = Math.min(x0 + 1, image.width - 1)
  const y1 = Math.min(y0 + 1, image.height - 1)
  const fx = cx - x0
  const fy = cy - y0
  const out: [number, number, number, number] = [0, 0, 0, 0]
  for (let channel = 0; channel < 4; channel += 1) {
    const top = image.data[(y0 * image.width + x0) * 4 + channel] * (1 - fx) +
      image.data[(y0 * image.width + x1) * 4 + channel] * fx
    const bottom = image.data[(y1 * image.width + x0) * 4 + channel] * (1 - fx) +
      image.data[(y1 * image.width + x1) * 4 + channel] * fx
    out[channel] = Math.round(top * (1 - fy) + bottom * fy)
  }
  return out
}

/**
 * OCR 前约束图像尺寸：倍率限制在 1~3 之间，总像素超过上限时按比例收回，
 * 源图本身超过上限时也会缩小到预算内，使用双线性采样保证边缘平滑。
 * 迁移自 Lumi-translate 的 resizeForOcr 策略。
 * @param image 源图像。
 * @param scale 放大倍率，默认 1（不放大）。
 * @returns 放大后的新图像；无需放大时原样返回。
 * @author zhenghq
 */
export function resizeRgbaForOcr(image: RgbaImage, scale = 1): RgbaImage {
  const safeScale = Math.min(3, Math.max(1, Number(scale) || 1))
  const sourcePixels = image.width * image.height
  const budgetScale = sourcePixels > 0 ? Math.sqrt(MAX_OCR_PIXELS / sourcePixels) : 1
  const targetScale = Math.min(safeScale, budgetScale)
  let width = Math.max(1, Math.round(image.width * targetScale))
  let height = Math.max(1, Math.round(image.height * targetScale))
  while (width * height > MAX_OCR_PIXELS) {
    if (width >= height) width -= 1
    else height -= 1
  }
  if (width === image.width && height === image.height) return image
  const scaleX = width / image.width
  const scaleY = height / image.height
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = sampleBilinear(
        image,
        (x + 0.5) / scaleX - 0.5,
        (y + 0.5) / scaleY - 0.5
      )
      const offset = (y * width + x) * 4
      data[offset] = r
      data[offset + 1] = g
      data[offset + 2] = b
      data[offset + 3] = a
    }
  }
  return { width, height, data }
}

/**
 * 可选的对比度增强：按直方图 5%~95% 百分位归一化并拉升对比度，
 * 输出灰度图，用于低对比度字幕等场景。
 * 迁移自 Lumi-translate 的 enhanceForSubtitleOcr。
 * @param image 源图像。
 * @returns 增强后的灰度 RGBA 图像。
 * @author zhenghq
 */
export function enhanceRgbaForOcr(image: RgbaImage): RgbaImage {
  const width = image.width
  const height = image.height
  const pixels = width * height
  const histogram = new Array<number>(256).fill(0)
  const lumas = new Uint8Array(pixels)
  for (let i = 0, j = 0; j < pixels; i += 4, j += 1) {
    const luma = lumaOf(image.data[i], image.data[i + 1], image.data[i + 2])
    lumas[j] = luma
    histogram[luma] += 1
  }

  const percentile = (ratio: number): number => {
    const target = Math.max(1, Math.floor(pixels * ratio))
    let seen = 0
    for (let value = 0; value < histogram.length; value += 1) {
      seen += histogram[value]
      if (seen >= target) return value
    }
    return 255
  }

  const low = percentile(0.05)
  const high = Math.max(low + 32, percentile(0.95))
  const data = new Uint8Array(pixels * 4)
  for (let i = 0, j = 0; j < pixels; i += 4, j += 1) {
    const normalized = Math.min(1, Math.max(0, (lumas[j] - low) / (high - low)))
    const value = Math.min(255, Math.max(0, Math.round((normalized - 0.5) * 1.9 * 255 + 128)))
    data[i] = value
    data[i + 1] = value
    data[i + 2] = value
    data[i + 3] = 255
  }
  return { width, height, data }
}
