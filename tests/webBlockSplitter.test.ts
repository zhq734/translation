import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtractedWebTextBlock } from '../src/shared/webPageTranslation.ts'
import { splitWebTextBlocks } from '../src/shared/webBlockSplitter.ts'

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
