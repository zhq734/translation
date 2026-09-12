import assert from 'node:assert/strict'
import test from 'node:test'
import type { OcrRecognizeResult } from '../src/shared/ocrEngine.ts'
import {
  canSafelyAcceptOcrResult,
  compareOcrQuality,
  evaluateOcrQuality,
  isOcrResultValid
} from '../src/shared/ocrQuality.ts'

/**
 * 构造质量评价测试所需的 OCR 结果。
 * @param text 识别文本。
 * @param confidences 可选的逐行置信度。
 * @returns OCR 识别结果。
 * @author zhenghq
 */
function result(text: string, confidences: Array<number | undefined> = []): OcrRecognizeResult {
  return {
    text,
    engine: 'tesseract',
    lines: confidences.length > 0
      ? confidences.map((confidence, index) => ({ text: `${text}${index}`, confidence }))
      : [{ text }]
  }
}

/**
 * 校验空文本和噪声不会被质量门控接受。
 * @returns 无返回值。
 * @author zhenghq
 */
test('统一 OCR 质量评价应拒绝空文本与噪声', () => {
  assert.equal(isOcrResultValid(result('')), false)
  assert.equal(isOcrResultValid(result('□□□')), false)
  assert.equal(evaluateOcrQuality(result('□□□'), 'zh').safeToAccept, false)
})

/**
 * 校验中文优先场景会识别足量纯拉丁文本的语言不匹配。
 * @returns 无返回值。
 * @author zhenghq
 */
test('统一 OCR 质量评价应优先目标语言匹配结果', () => {
  const mismatch = evaluateOcrQuality(result('abcdef ghijkl'), 'zh')
  const matched = evaluateOcrQuality(result('中文结果'), 'zh')

  assert.equal(mismatch.languageMismatch, true)
  assert.equal(matched.languageMismatch, false)
  assert.ok(compareOcrQuality(matched, mismatch) > 0)
})

/**
 * 校验自动语言不预设中文，避免英文/代码截图被误判为语言不匹配而反复降级。
 * @returns 无返回值。
 * @author zhenghq
 */
test('统一 OCR 质量评价在 auto 语言下不应把拉丁文本判为语言不匹配', () => {
  const english = evaluateOcrQuality(result('Upload the archive package to the server.'), 'auto')
  const zh = evaluateOcrQuality(result('abcdef ghijkl'), 'zh')

  assert.equal(english.languageMismatch, false)
  assert.equal(english.safeToAccept, true)
  // 显式中文目标仍应保留语言不匹配惩罚。
  assert.equal(zh.languageMismatch, true)
})

/**
 * 校验缺失置信度可沿用文本门控，低置信度则不得安全接受。
 * @returns 无返回值。
 * @author zhenghq
 */
test('统一 OCR 质量评价应兼容置信度缺失并拒绝低置信度', () => {
  assert.equal(canSafelyAcceptOcrResult(result('清晰中文文本内容'), 'zh'), true)
  assert.equal(canSafelyAcceptOcrResult(result('清晰中文文本内容', [0.3, 0.5]), 'zh'), false)
  assert.equal(evaluateOcrQuality(result('清晰中文文本内容', [0.8, 0.6]), 'zh').averageConfidence, 0.7)
})

/**
 * 校验质量排序在语言和置信度相同时使用文本分数择优。
 * @returns 无返回值。
 * @author zhenghq
 */
test('统一 OCR 质量评价应以文本分数完成最终排序', () => {
  const short = evaluateOcrQuality(result('中文', [0.8]), 'zh')
  const long = evaluateOcrQuality(result('这是更完整的中文结果', [0.8]), 'zh')

  assert.ok(long.textScore > short.textScore)
  assert.ok(compareOcrQuality(long, short) > 0)
  assert.ok(compareOcrQuality(short, long) < 0)
})

/**
 * 校验严格比较的平局语义，避免备用候选在相等时覆盖基线。
 * @returns 无返回值。
 * @author zhenghq
 */
test('统一 OCR 质量严格排序应将完全相同和不可证明更优视为平局', () => {
  const baseline = evaluateOcrQuality(result('相同结果', [0.8]), 'zh')
  const tied = evaluateOcrQuality(result('相同结果', [0.8]), 'zh')

  assert.equal(compareOcrQuality(tied, baseline), 0)
})
