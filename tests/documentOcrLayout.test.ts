import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DOCUMENT_OCR_FALLBACK_FONT_SIZE,
  DOCUMENT_OCR_LINE_HEIGHT_RATIO,
  DOCUMENT_OCR_UNIFORM_FONT_SIZE,
  normalizeDocumentOcrRegionBox,
  resolveDocumentImageContentBox,
  resolveDocumentOcrOverlayBox,
  resolveDocumentOcrRegionFlowTop,
  resolveDocumentOcrSourceWidthRatio,
  resolveDocumentOcrTranslationHorizontalBounds,
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

test('图片内容框必须按原始宽高比在目标边界内等比居中', () => {
  assert.deepEqual(
    resolveDocumentImageContentBox(400, 200, 200, 200),
    { x: 0, y: 50, width: 200, height: 100 }
  )
  assert.deepEqual(
    resolveDocumentImageContentBox(200, 400, 200, 200),
    { x: 50, y: 0, width: 100, height: 200 }
  )
  assert.deepEqual(
    resolveDocumentImageContentBox(400, 200, 200, 100),
    { x: 0, y: 0, width: 200, height: 100 }
  )
})

test('图片尺寸无效时必须回退到完整目标框，避免译文图片消失', () => {
  assert.deepEqual(
    resolveDocumentImageContentBox(0, Number.NaN, 200, 100),
    { x: 0, y: 0, width: 200, height: 100 }
  )
})

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

test('OCR 透明文字层坐标必须有效、不越界并保留最小可命中尺寸', () => {
  assert.deepEqual(
    normalizeDocumentOcrRegionBox({ x: 0.25, y: 0.3, width: 0.4, height: 0.2 }),
    { x: 0.25, y: 0.3, width: 0.4, height: 0.2 }
  )
  assert.deepEqual(
    normalizeDocumentOcrRegionBox({ x: -0.1, y: 1, width: 0, height: Number.NaN }),
    { x: 0, y: 0.999, width: 0.001, height: 0.001 }
  )
  assert.deepEqual(
    normalizeDocumentOcrRegionBox({ x: 0.9, y: 0.8, width: 0.5, height: 0.5 }),
    { x: 0.9, y: 0.8, width: 0.1, height: 0.2 }
  )
})

test('OCR 遮罩与译文必须共用同一个安全覆盖框，左对齐短文本不能扩到图片右边界', () => {
  assert.deepEqual(
    resolveDocumentOcrOverlayBox({ x: 0.25, y: 0.3, width: 0.2, height: 0.08 }),
    { x: 0.25, y: 0.3, width: 0.2, height: 0.08 }
  )
  assert.deepEqual(
    resolveDocumentOcrOverlayBox({ x: 0.9, y: 0.8, width: 0.5, height: 0.5 }),
    { x: 0.9, y: 0.8, width: 0.1, height: 0.2 }
  )
})

test('OCR 译文必须优先锚定原文顶部，仅横向重叠时才避让前序译文', () => {
  const previous = { left: 20, right: 120, top: 40, bottom: 96 }
  assert.equal(
    resolveDocumentOcrRegionFlowTop(40, { left: 20, right: 120 }, [previous], 4),
    100
  )
  assert.equal(
    resolveDocumentOcrRegionFlowTop(140, { left: 20, right: 120 }, [previous], 4),
    140
  )
  assert.equal(
    resolveDocumentOcrRegionFlowTop(40, { left: 130, right: 230 }, [previous], 4),
    40
  )
})

test('OCR 左对齐译文必须扩展到同行右侧区域之前，避免窄框逐字换行', () => {
  const current = {
    ...region({ x: 0.05, y: 0.2, width: 0.04, height: 0.02 }),
    regionId: 'current'
  }
  const sameRow = {
    ...region({ x: 0.32, y: 0.205, width: 0.12, height: 0.02 }),
    regionId: 'same-row'
  }
  const lowerRow = {
    ...region({ x: 0.6, y: 0.5, width: 0.1, height: 0.02 }),
    regionId: 'lower-row'
  }

  assert.deepEqual(
    resolveDocumentOcrTranslationHorizontalBounds(current, [current, sameRow, lowerRow]),
    { x: 0.05, width: 0.27 }
  )
})

test('OCR 白底宽度必须按原识别框占扩宽译文框的比例计算', () => {
  const sourceBox = { x: 0.05, y: 0.2, width: 0.04, height: 0.02 }
  const horizontalBounds = { x: 0.05, width: 0.27 }

  assert.equal(
    resolveDocumentOcrSourceWidthRatio(sourceBox, horizontalBounds),
    0.04 / 0.27
  )
  assert.equal(
    resolveDocumentOcrSourceWidthRatio(
      { ...sourceBox, width: 0.3 },
      horizontalBounds
    ),
    1
  )
  assert.equal(
    resolveDocumentOcrSourceWidthRatio(sourceBox, { x: 0.05, width: 0 }),
    1
  )
})

test('OCR 左对齐译文没有同行右侧区域时最多延伸到图片内容右边界', () => {
  const current = {
    ...region({ x: 0.05, y: 0.2, width: 0.04, height: 0.02 }),
    regionId: 'current'
  }
  const lowerRow = {
    ...region({ x: 0.6, y: 0.5, width: 0.1, height: 0.02 }),
    regionId: 'lower-row'
  }

  assert.deepEqual(
    resolveDocumentOcrTranslationHorizontalBounds(current, [current, lowerRow]),
    { x: 0.05, width: 0.95 }
  )
})

test('OCR 居中或右对齐译文必须保留原始识别框宽度', () => {
  const current = {
    ...region({ x: 0.2, y: 0.3, width: 0.18, height: 0.04 }),
    regionId: 'current',
    textAlign: 'center' as const
  }
  const right = {
    ...region({ x: 0.6, y: 0.3, width: 0.1, height: 0.04 }),
    regionId: 'right'
  }

  assert.deepEqual(
    resolveDocumentOcrTranslationHorizontalBounds(current, [current, right]),
    { x: 0.2, width: 0.18 }
  )
  assert.deepEqual(
    resolveDocumentOcrTranslationHorizontalBounds(
      { ...current, textAlign: 'right' },
      [current, right]
    ),
    { x: 0.2, width: 0.18 }
  )
})
