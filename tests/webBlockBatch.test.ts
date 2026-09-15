import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtractedWebTextUnit } from '../src/shared/webPageTranslation.ts'
import {
  buildWebTranslationBatches,
  parseMergedTranslation,
  splitWebTextUnits
} from '../src/shared/webBlockSplitter.ts'

/**
 * 创建跨块合并测试用文本单元。
 * @param id 单元标识。
 * @param blockId 块标识。
 * @param text 原文。
 * @returns 可直接参与分块的文本单元。
 * @author zhenghq
 */
function unit(id: string, blockId: string, text: string): ExtractedWebTextUnit {
  return {
    id,
    blockId,
    sourceText: text,
    text,
    category: 'body',
    anchor: { parentSelector: `#${id}`, textNodeIndex: 0, sourceFingerprint: id }
  }
}

test('相邻短段落应合并为一次请求，且不破坏分段顺序', () => {
  const segments = splitWebTextUnits([
    unit('a', 'pa', 'First.'),
    unit('b', 'pb', 'Second.'),
    unit('c', 'pc', 'Third.')
  ], { maxChars: 5000 })

  const batches = buildWebTranslationBatches(segments, { maxChars: 5000 })
  assert.equal(batches.length, 1)
  assert.deepEqual(batches[0].segments.map((item) => item.blockId), ['pa', 'pb', 'pc'])
  assert.equal(batches[0].text, 'First.\n[[[ST-SEG-0]]]\nSecond.\n[[[ST-SEG-1]]]\nThird.')
})

test('跨块合并必须同时遵守单批字符上限和单批块数上限', () => {
  const segments = splitWebTextUnits([
    unit('a', 'pa', 'AAAA'),
    unit('b', 'pb', 'BBBB'),
    unit('c', 'pc', 'CCCC')
  ], { maxChars: 5000 })

  const byChars = buildWebTranslationBatches(segments, { maxChars: 20 })
  assert.ok(byChars.every((batch) => batch.text.length <= 20))
  assert.ok(byChars.length > 1)

  const byBlocks = buildWebTranslationBatches(segments, { maxChars: 5000, maxBlocksPerBatch: 2 })
  assert.deepEqual(byBlocks.map((batch) => batch.segments.length), [2, 1])
})

test('原文已包含合并标记的段落不得参与合并，避免拆分歧义', () => {
  const risky = 'already [[[ST-SEG-0]]] inside'
  const segments = splitWebTextUnits([
    unit('a', 'pa', risky),
    unit('b', 'pb', 'Second.')
  ], { maxChars: 5000 })

  const batches = buildWebTranslationBatches(segments, { maxChars: 5000 })
  assert.equal(batches.length, 2)
  assert.equal(batches.find((batch) => batch.segments[0]?.blockId === 'pa')?.mergeable, false)
})

test('合并译文应按标记拆回各段落并保持原文顺序', () => {
  const segments = splitWebTextUnits([
    unit('a', 'pa', 'First.'),
    unit('b', 'pb', 'Second.')
  ], { maxChars: 5000 })

  const batch = buildWebTranslationBatches(segments, { maxChars: 5000 })[0]
  const parts = parseMergedTranslation(batch, '第一。\n[[[ST-SEG-0]]]\n第二。')
  assert.deepEqual(parts, ['第一。', '第二。'])
})

test('模型丢弃或改写标记时返回空值，调用方应回退逐段翻译', () => {
  const segments = splitWebTextUnits([
    unit('a', 'pa', 'First.'),
    unit('b', 'pb', 'Second.')
  ], { maxChars: 5000 })

  const batch = buildWebTranslationBatches(segments, { maxChars: 5000 })[0]
  assert.equal(parseMergedTranslation(batch, '第一。第二。'), null)
  assert.equal(parseMergedTranslation(batch, '第一。\n[[[ST-SEG-0]]]\n第二。\n[[[ST-SEG-5]]]'), null)
})

test('单段批次不应包含合并标记，避免无谓改写模型输入', () => {
  const segments = splitWebTextUnits([unit('a', 'pa', 'Only one.')], { maxChars: 5000 })
  const batches = buildWebTranslationBatches(segments, { maxChars: 5000 })
  assert.equal(batches.length, 1)
  assert.equal(batches[0].text, 'Only one.')
  assert.equal(batches[0].mergeable, false)
})

test('模型额外输出末尾分隔标记时仍应正确拆回各段', () => {
  const segments = splitWebTextUnits([
    unit('a', 'pa', 'First.'),
    unit('b', 'pb', 'Second.')
  ], { maxChars: 5000 })

  const batch = buildWebTranslationBatches(segments, { maxChars: 5000 })[0]
  assert.deepEqual(parseMergedTranslation(batch, '第一。\n[[[ST-SEG-0]]]\n第二。\n[[[ST-SEG-1]]]'), ['第一。', '第二。'])
})
