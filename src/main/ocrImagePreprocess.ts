import { resizeRgbaForOcr } from '../shared/imagePreprocess'
import { decodePng, encodePng } from './pngCodec'

/**
 * 对 OCR 输入 PNG 字节做统一尺寸约束，避免超大截图或剪贴板图片直接进入 OCR 引擎。
 * 解码失败时返回原始字节，由后续引擎按自身错误处理。
 * @param imageBytes PNG 图片字节。
 * @param scale OCR 放大倍率。
 * @returns 预处理后的 PNG 字节。
 * @author zhenghq
 */
export function preprocessOcrImageBytes(imageBytes: Uint8Array | Buffer, scale: number): Buffer {
  try {
    const image = decodePng(imageBytes)
    const resized = resizeRgbaForOcr(image, scale)
    if (resized === image) return Buffer.from(imageBytes)
    return encodePng(resized)
  } catch {
    return Buffer.from(imageBytes)
  }
}
