import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAdaptiveOcrFallbackImageBytes,
  OCR_FALLBACK_MIN_EFFECTIVE_SCALE,
  OCR_FALLBACK_TARGET_PIXELS,
  preprocessOcrBaselineImageBytes,
  preprocessOcrImageBytes,
  selectAdaptiveOcrFallback
} from '../src/main/ocrImagePreprocess.ts'
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
  const original = makeImage(1600, 1400)
  const processed = preprocessOcrImageBytes(encodePng(original), 1)
  const decoded = decodePng(processed)

  assert.ok(decoded.width * decoded.height <= MAX_OCR_PIXELS)
  assert.ok(decoded.width < original.width)
  assert.ok(decoded.height < original.height)
})

/**
 * 校验统一 OCR 预处理不会降采样全高清原图。
 * @returns 无返回值。
 * @author zhenghq
 */
test('preprocessOcrImageBytes 应在 1 倍率下保留 1920×1080 尺寸', () => {
  const original = makeImage(1920, 1080)
  const processed = preprocessOcrImageBytes(encodePng(original), 1)
  const decoded = decodePng(processed)

  assert.equal(decoded.width, 1920)
  assert.equal(decoded.height, 1080)
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

/**
 * 校验小图备用候选会按目标像素和用户上限选择单一适度倍率。
 * @returns 无返回值。
 * @author zhenghq
 */
test('自适应备用候选应在用户上限内适度放大小图', () => {
  const selected = selectAdaptiveOcrFallback(400, 300, 3)

  assert.equal(selected.strategy, 'moderate-scale')
  assert.ok(selected.actualScale > 1)
  assert.ok(selected.actualScale <= 3)
  assert.ok(400 * 300 * selected.actualScale ** 2 <= OCR_FALLBACK_TARGET_PIXELS + 1)
})

/**
 * 校验倍率配置和统一像素预算均能约束备用候选实际倍率。
 * @returns 无返回值。
 * @author zhenghq
 */
test('自适应备用候选应同时遵守用户倍率上限和像素预算', () => {
  const userLimited = selectAdaptiveOcrFallback(500, 400, 1.5)
  const budgetLimited = selectAdaptiveOcrFallback(1400, 1000, 3)

  assert.equal(userLimited.strategy, 'moderate-scale')
  assert.ok(userLimited.actualScale <= 1.5)
  assert.ok(1400 * 1000 * budgetLimited.actualScale ** 2 <= MAX_OCR_PIXELS + 1)
})

/**
 * 校验无有意义放大空间时固定选择 1× 对比度增强。
 * @returns 无返回值。
 * @author zhenghq
 */
test('自适应备用候选应在倍率为 1、已达目标或有效倍率不足时使用增强', () => {
  const configuredOne = selectAdaptiveOcrFallback(400, 300, 1)
  const alreadyLarge = selectAdaptiveOcrFallback(1920, 1080, 3)
  const tooLittleRoom = selectAdaptiveOcrFallback(1450, 1400, 3)

  assert.deepEqual(configuredOne, {
    strategy: 'contrast-enhance',
    requestedScale: 1,
    actualScale: 1
  })
  assert.equal(alreadyLarge.strategy, 'contrast-enhance')
  assert.equal(tooLittleRoom.strategy, 'contrast-enhance')
  assert.ok(OCR_FALLBACK_MIN_EFFECTIVE_SCALE > 1)
})

/**
 * 校验基线固定 1×，备用图片直接从原始像素生成且只有一种处理策略。
 * @returns 无返回值。
 * @author zhenghq
 */
test('基线与备用候选应分别从原始图片生成并遵守像素预算', () => {
  const original = makeImage(400, 300)
  original.data[0] = 10
  const encoded = encodePng(original)
  const baseline = decodePng(preprocessOcrBaselineImageBytes(encoded))
  const fallback = createAdaptiveOcrFallbackImageBytes(encoded, 2)
  const decodedFallback = decodePng(fallback.imageBytes)

  assert.equal(baseline.width, original.width)
  assert.equal(baseline.height, original.height)
  assert.equal(fallback.strategy, 'moderate-scale')
  assert.ok(decodedFallback.width > original.width)
  assert.ok(decodedFallback.width * decodedFallback.height <= MAX_OCR_PIXELS)
})
