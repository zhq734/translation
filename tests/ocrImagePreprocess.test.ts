import assert from 'node:assert/strict'
import test from 'node:test'
import { preprocessOcrImageBytes } from '../src/main/ocrImagePreprocess.ts'
import { decodePng, encodePng } from '../src/main/pngCodec.ts'
import { MAX_OCR_PIXELS, type RgbaImage } from '../src/shared/imagePreprocess.ts'

/**
 * 构造测试用纯色 RGBA 图像。
 * @param width 图像宽度。
 * @param height 图像高度。
 * @returns RGBA 图像。
 * @author zhenghq
 */
function makeImage(width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 240
    data[i + 1] = 240
    data[i + 2] = 240
    data[i + 3] = 255
  }
  return { width, height, data }
}

/**
 * 校验 OCR 入口会把超大 PNG 限制到像素预算内。
 * @returns 无返回值。
 * @author zhenghq
 */
test('preprocessOcrImageBytes 应限制超大剪贴板图片像素数', () => {
  const original = makeImage(1200, 1000)
  const processed = preprocessOcrImageBytes(encodePng(original), 1.25)
  const decoded = decodePng(processed)

  assert.ok(decoded.width * decoded.height <= MAX_OCR_PIXELS)
  assert.ok(decoded.width < original.width)
  assert.ok(decoded.height < original.height)
})

/**
 * 校验已在预算内的图片不会被放大到超过预算。
 * @returns 无返回值。
 * @author zhenghq
 */
test('preprocessOcrImageBytes 应保持 OCR 图片不超过预算', () => {
  const original = makeImage(500, 500)
  const processed = preprocessOcrImageBytes(encodePng(original), 3)
  const decoded = decodePng(processed)

  assert.ok(decoded.width * decoded.height <= MAX_OCR_PIXELS)
  assert.ok(decoded.width >= original.width)
  assert.ok(decoded.height >= original.height)
})
