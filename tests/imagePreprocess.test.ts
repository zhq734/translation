import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_OCR_PIXELS,
  cropRgba,
  enhanceRgbaForOcr,
  lumaOf,
  resizeRgbaForOcr,
  type RgbaImage
} from '../src/shared/imagePreprocess.ts'

/**
 * 构造测试用 RGBA 图像。
 * @param width 图像宽度。
 * @param height 图像高度。
 * @param fill 像素填充回调。
 * @returns RGBA 图像。
 * @author zhenghq
 */
function makeImage(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number, number]
): RgbaImage {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = fill(x, y)
      const i = (y * width + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a
    }
  }
  return { width, height, data }
}

/**
 * 校验亮度计算符合 ITU-R BT.601 权重。
 * @returns 无返回值。
 * @author zhenghq
 */
test('亮度应按 BT.601 权重计算', () => {
  assert.equal(lumaOf(0, 0, 0), 0)
  assert.equal(lumaOf(255, 255, 255), 255)
  assert.ok(Math.abs(lumaOf(100, 100, 100) - 100) < 1)
  assert.ok(lumaOf(255, 0, 0) > lumaOf(0, 0, 255))
})

/**
 * 校验小于等于 1 的倍率不触发放大。
 * @returns 无返回值。
 * @author zhenghq
 */
test('倍率不超过 1 时应保持原尺寸', () => {
  const image = makeImage(10, 8, () => [1, 2, 3, 255])
  assert.equal(resizeRgbaForOcr(image, 0.5).width, 10)
  assert.equal(resizeRgbaForOcr(image, 1).width, 10)
})

/**
 * 校验放大倍率被限制在 3 以内。
 * @returns 无返回值。
 * @author zhenghq
 */
test('放大倍率应被限制在 3 以内', () => {
  const image = makeImage(10, 10, () => [1, 2, 3, 255])
  const scaled = resizeRgbaForOcr(image, 9)
  assert.equal(scaled.width, 30)
  assert.equal(scaled.height, 30)
})

/**
 * 校验像素总数上限防止放大后图像过大。
 * @returns 无返回值。
 * @author zhenghq
 */
test('放大后像素总数不应超过上限', () => {
  const image = makeImage(500, 500, () => [1, 2, 3, 255])
  const scaled = resizeRgbaForOcr(image, 3)
  assert.ok(scaled.width * scaled.height <= MAX_OCR_PIXELS)
  assert.ok(scaled.width >= 500)
  assert.ok(scaled.height >= 500)
})

/**
 * 校验源图像本身超过像素上限时会被缩小到预算内。
 * @returns 无返回值。
 * @author zhenghq
 */
test('源图像超过像素上限时应缩小到预算内', () => {
  const image = makeImage(1000, 1000, () => [1, 2, 3, 255])
  const scaled = resizeRgbaForOcr(image, 3)
  assert.ok(scaled.width * scaled.height <= MAX_OCR_PIXELS)
  assert.ok(scaled.width < 1000)
  assert.ok(scaled.height < 1000)
})

/**
 * 校验放大均匀色块时颜色保持稳定。
 * @returns 无返回值。
 * @author zhenghq
 */
test('均匀色块放大后颜色应保持', () => {
  const image = makeImage(4, 4, () => [200, 100, 50, 255])
  const scaled = resizeRgbaForOcr(image, 2)
  assert.equal(scaled.width, 8)
  const first = scaled.data.slice(0, 4)
  assert.deepEqual(Array.from(first), [200, 100, 50, 255])
})

/**
 * 校验放大时边界像素不被采样越界污染。
 * @returns 无返回值。
 * @author zhenghq
 */
test('放大采样应正确夹取边界', () => {
  const image = makeImage(2, 2, (x, y) => (x + y === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]))
  const scaled = resizeRgbaForOcr(image, 2)
  assert.deepEqual(Array.from(scaled.data.slice(0, 4)), [255, 0, 0, 255])
  const lastOffset = (scaled.height - 1) * scaled.width * 4 + (scaled.width - 1) * 4
  assert.deepEqual(Array.from(scaled.data.slice(lastOffset, lastOffset + 4)), [0, 0, 255, 255])
})

/**
 * 校验裁剪区域被限制在图像边界内。
 * @returns 无返回值。
 * @author zhenghq
 */
test('裁剪区域应夹取到图像边界内', () => {
  const image = makeImage(10, 10, (x, y) => [x * 10, y * 10, 0, 255])
  const cropped = cropRgba(image, { x: 8, y: 8, width: 5, height: 5 })
  assert.equal(cropped.width, 2)
  assert.equal(cropped.height, 2)
  assert.equal(cropped.data[0], 80)
})

/**
 * 校验增强后图像为灰度且对比度被拉升。
 * @returns 无返回值。
 * @author zhenghq
 */
test('低对比度图像增强后应对比度提升', () => {
  const image = makeImage(8, 8, (x) => [60 + x * 20, 60 + x * 20, 60 + x * 20, 255])
  const enhanced = enhanceRgbaForOcr(image)
  const first = enhanced.data[0]
  const last = enhanced.data[(enhanced.width * enhanced.height - 1) * 4]
  assert.equal(enhanced.data[1], first)
  assert.equal(enhanced.data[2], first)
  assert.ok(Math.abs(last - first) > 100)
})

/**
 * 校验均匀图像增强时不出现除零或 NaN。
 * @returns 无返回值。
 * @author zhenghq
 */
test('均匀图像增强应保持有限像素值', () => {
  const image = makeImage(4, 4, () => [120, 120, 120, 100])
  const enhanced = enhanceRgbaForOcr(image)
  for (let i = 0; i < enhanced.data.length; i += 1) {
    assert.ok(Number.isFinite(enhanced.data[i]))
  }
  assert.equal(enhanced.data[3], 255)
})
