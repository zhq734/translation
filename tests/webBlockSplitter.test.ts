import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtractedWebTextBlock } from '../src/shared/webPageTranslation.ts'
import {
  buildWebTranslationBatches,
  parseMergedTranslation,
  splitWebTextBlocks,
  splitWebTextUnits
} from '../src/shared/webBlockSplitter.ts'

function block(id: string, text: string): ExtractedWebTextBlock {
  return {
    id,
    text,
    type: 'paragraph',
    category: 'body',
    anchor: { selector: `#${id}`, textFingerprint: 'x' },
    ancestorTags: ['main', 'p'],
    ancestorRoles: ['main'],
    linkTextLength: 0,
    textDensity: 1
  }
}

test('网页分块优先保留短段落并保留块与顺序标识', () => {
  const segments = splitWebTextBlocks([block('a', '第一段'), block('b', '第二段')], { maxChars: 20 })
  assert.deepEqual(segments.map((item) => [item.blockId, item.index, item.text]), [
    ['a', 0, '第一段'],
    ['b', 0, '第二段']
  ])
  assert.notEqual(segments[0].segmentId, segments[1].segmentId)
})

test('网页分块在句边界拆分且任何分块不超过上限', () => {
  const source = '这是第一句。这里是第二句！This is the third sentence. 最后一句。'
  const segments = splitWebTextBlocks([block('long', source)], { maxChars: 12 })
  assert.ok(segments.length > 1)
  assert.ok(segments.every((item) => item.text.length <= 12))
  assert.equal(segments.map((item) => item.text).join(''), source)
})

test('无可用句边界时按字符安全切分且不丢失空白', () => {
  const source = 'abcdefghijklmnop'
  const segments = splitWebTextBlocks([block('raw', source)], { maxChars: 5 })
  assert.deepEqual(segments.map((item) => item.text), ['abcde', 'fghij', 'klmno', 'p'])
})

test('同一段落的多个文本单元应合并为一个请求，且段落上限不超过 5000 字', () => {
  const first = 'Hello '
  const second = 'world'
  const third = '!'
  const segments = splitWebTextUnits([
    {
      id: 'u1',
      blockId: 'p1',
      sourceText: first,
      text: first,
      category: 'body',
      anchor: { parentSelector: '#p1', textNodeIndex: 0, sourceFingerprint: 'a' }
    },
    {
      id: 'u2',
      blockId: 'p1',
      sourceText: second,
      text: second,
      category: 'body',
      anchor: { parentSelector: '#p1', textNodeIndex: 1, sourceFingerprint: 'b' }
    },
    {
      id: 'u3',
      blockId: 'p1',
      sourceText: third,
      text: third,
      category: 'body',
      anchor: { parentSelector: '#p1', textNodeIndex: 2, sourceFingerprint: 'c' }
    }
  ], { maxChars: 5000 })

  assert.equal(segments.length, 1)
  assert.equal(segments[0].blockId, 'p1')
  assert.equal(segments[0].text, 'Hello world!')
})

test('段落拼接应依据原文保留文本节点之间的空格', () => {
  const segments = splitWebTextUnits([
    {
      id: 'u1',
      blockId: 'p1',
      sourceText: 'Hello ',
      text: 'Hello',
      category: 'body',
      anchor: { parentSelector: '#p1', textNodeIndex: 0, sourceFingerprint: 'a' }
    },
    {
      id: 'u2',
      blockId: 'p1',
      sourceText: 'world',
      text: 'world',
      category: 'body',
      anchor: { parentSelector: '#p1', textNodeIndex: 1, sourceFingerprint: 'b' }
    }
  ], { maxChars: 5000 })

  assert.equal(segments.length, 1)
  assert.equal(segments[0].text, 'Hello world')
})

test('超长段落应在 5000 字上限内按句子边界拆分为多个请求', () => {
  const source = `${'A'.repeat(4999)}。${'B'.repeat(2)}`
  const segments = splitWebTextUnits([
    {
      id: 'long',
      blockId: 'p-long',
      sourceText: source,
      text: source,
      category: 'body',
      anchor: { parentSelector: '#p-long', textNodeIndex: 0, sourceFingerprint: 'd' }
    }
  ], { maxChars: 5000 })

  assert.ok(segments.length > 1)
  assert.ok(segments.every((item) => item.text.length <= 5000))
  assert.equal(segments.map((item) => item.text).join(''), source)
})
