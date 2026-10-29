import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DOCUMENT_OCR_FALLBACK_FONT_SIZE,
  DOCUMENT_OCR_LINE_HEIGHT_RATIO,
  DOCUMENT_OCR_UNIFORM_FONT_SIZE,
  resolveOcrRegionFontSize,
  resolveOcrRegionGapBefore,
  resolveOcrRegionLineHeight,
  resolveOcrRegionPadding
} from '../src/shared/documentOcrLayout.ts'
import type { DocumentOcrRegion } from '../src/shared/documentTypes.ts'

/**
 * 构造 OCR 排版测试区域。
 * @param bbox 归一化区域坐标。
 * @param fontSize 可选原文字号。
 * @returns OCR 区域。
 * @author zhenghq
 */
function region(
  bbox: { x: number; y: number; width: number; height: number },
  fontSize?: number
): DocumentOcrRegion {
  return {
    regionId: 'region',
    bbox,
    text: 'source',
    translatedText: '译文',
    status: 'recognized',
    ...(fontSize === undefined ? {} : { style: { fontSize } })
  }
}

test('OCR 预览与导出必须共享统一字号、行高和内边距', () => {
  const current = region({ x: 0.1, y: 0.2, width: 0.6, height: 0.1 }, 20)
  assert.equal(resolveOcrRegionFontSize(current, 200), DOCUMENT_OCR_UNIFORM_FONT_SIZE)
  assert.equal(
    resolveOcrRegionLineHeight(DOCUMENT_OCR_UNIFORM_FONT_SIZE),
    DOCUMENT_OCR_UNIFORM_FONT_SIZE * DOCUMENT_OCR_LINE_HEIGHT_RATIO
  )
  assert.deepEqual(resolveOcrRegionPadding(300, 200, current), { x: 3, y: 2 })
})

test('OCR 字号必须统一，不能随区域样式或图片高度变化', () => {
  const current = region({ x: 0, y: 0, width: 1, height: 1 })
  assert.equal(resolveOcrRegionFontSize(current, 700), DOCUMENT_OCR_FALLBACK_FONT_SIZE)
  assert.equal(resolveOcrRegionFontSize(region(current.bbox, 1), 700), DOCUMENT_OCR_UNIFORM_FONT_SIZE)
  assert.equal(resolveOcrRegionFontSize(region(current.bbox, 200), 200), DOCUMENT_OCR_UNIFORM_FONT_SIZE)
  assert.equal(DOCUMENT_OCR_FALLBACK_FONT_SIZE, DOCUMENT_OCR_UNIFORM_FONT_SIZE)
})

test('OCR 区域间距只保留原文行间空白，不包含前序区域剩余高度', () => {
  const previous = region({ x: 0.1, y: 0.1, width: 0.4, height: 0.2 })
  const current = region({ x: 0.1, y: 0.4, width: 0.4, height: 0.1 })
  assert.equal(resolveOcrRegionGapBefore(current, previous, 300), 30)
  assert.equal(resolveOcrRegionGapBefore(previous, undefined, 300), 30)
  assert.equal(
    resolveOcrRegionGapBefore(
      region({ x: 0.1, y: 0.2, width: 0.4, height: 0.1 }),
      previous,
      300
    ),
    0
  )
})
