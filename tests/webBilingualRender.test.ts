import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildWebBilingualOperations,
  composeWebBilingualText,
  resolveWebBilingualRenderKind
} from '../src/shared/webBilingualRender.ts'
import type {
  ExtractedWebTextBlock,
  ExtractedWebTextUnit
} from '../src/shared/webPageTranslation.ts'

/**
 * 构造测试用语义块。
 * @param patch 需要覆盖的块字段。
 * @returns 完整的语义块。
 * @author zhenghq
 */
function block(patch: Partial<ExtractedWebTextBlock> = {}): ExtractedWebTextBlock {
  return {
    id: 'b1',
    text: 'Hello world',
    type: 'paragraph',
    category: 'body',
    anchor: { selector: '#p1', textFingerprint: 'aaaa0000' },
    ancestorTags: ['p'],
    ancestorRoles: [],
    linkTextLength: 0,
    textDensity: 1,
    ...patch
  }
}

/**
 * 构造测试用文本单元。
 * @param patch 需要覆盖的单元字段。
 * @returns 完整的文本单元。
 * @author zhenghq
 */
function unit(patch: Partial<ExtractedWebTextUnit> = {}): ExtractedWebTextUnit {
  return {
    id: 'u1',
    blockId: 'b1',
    sourceText: 'Hello',
    text: 'Hello',
    anchor: { parentSelector: '#p1', textNodeIndex: 0, sourceFingerprint: 'bbbb0000' },
    category: 'body',
    ...patch
  }
}

test('段落内多个文本单元应按原文空白重建分隔并拼成整段译文', () => {
  const units = [
    unit({ id: 'u1', sourceText: 'Hello ', text: 'Hello' }),
    unit({ id: 'u2', sourceText: 'world', text: 'world', anchor: { parentSelector: '#p1', textNodeIndex: 1, sourceFingerprint: 'cccc0000' } }),
    unit({ id: 'u3', sourceText: '!', text: '!', anchor: { parentSelector: '#p1', textNodeIndex: 2, sourceFingerprint: 'dddd0000' } })
  ]
  const translations = new Map([['u1', '你好'], ['u2', '世界'], ['u3', '！']])
  assert.equal(composeWebBilingualText(units, translations), '你好 世界！')
})

test('相邻单元原文均无空白时不应插入分隔符', () => {
  const units = [
    unit({ id: 'u1', sourceText: 'Hello' }),
    unit({ id: 'u2', sourceText: 'world', anchor: { parentSelector: '#p1', textNodeIndex: 1, sourceFingerprint: 'cccc0000' } })
  ]
  assert.equal(composeWebBilingualText(units, new Map([['u1', '你好'], ['u2', '世界']])), '你好世界')
})

test('按钮与导航块在对照模式下应跳过渲染', () => {
  assert.equal(resolveWebBilingualRenderKind({ block: block({ type: 'button' }), units: [unit()] }), 'skip')
  assert.equal(resolveWebBilingualRenderKind({ block: block({ type: 'navigation' }), units: [unit()] }), 'skip')
})

test('短碎片块应跳过渲染，长正文块应内联注入', () => {
  assert.equal(
    resolveWebBilingualRenderKind({ block: block({ category: 'isolated', text: '首页' }), units: [unit()] }),
    'skip'
  )
  assert.equal(
    resolveWebBilingualRenderKind({
      block: block({ category: 'isolated', text: '这是一段明显超过四十个字符阈值的较长说明性正文内容，用于验证孤立分类下的长文本仍会走内联注入路径。' }),
      units: [unit()]
    }),
    'inline'
  )
  assert.equal(resolveWebBilingualRenderKind({ block: block({ category: 'body', text: '首页' }), units: [unit()] }), 'inline')
})

test('语义属性与 Shadow DOM 单元所在块应跳过渲染', () => {
  assert.equal(
    resolveWebBilingualRenderKind({
      block: block({ type: 'other' }),
      units: [unit({ anchor: { parentSelector: '#i1', textNodeIndex: 0, sourceFingerprint: 'eeee0000', semanticAttribute: 'placeholder' } })]
    }),
    'skip'
  )
  assert.equal(
    resolveWebBilingualRenderKind({
      block: block({ type: 'other' }),
      units: [unit({ anchor: { parentSelector: '#host', textNodeIndex: 0, sourceFingerprint: 'ffff0000', shadowPath: [0, 1] } })]
    }),
    'skip'
  )
})

test('块内部分单元失败时不应产出操作且计入未对照', () => {
  const result = buildWebBilingualOperations({
    blocks: [block()],
    units: [unit({ id: 'u1' }), unit({ id: 'u2', anchor: { parentSelector: '#p1', textNodeIndex: 1, sourceFingerprint: 'cccc0000' } })],
    translations: new Map([['u1', '你好']])
  })
  assert.equal(result.operations.length, 0)
  assert.equal(result.unrendered, 1)
  assert.equal(result.skipped, 0)
})

test('块内全部单元完成时应产出按块聚合的注入操作', () => {
  const result = buildWebBilingualOperations({
    blocks: [block()],
    units: [
      unit({ id: 'u1', sourceText: 'Hello ' }),
      unit({ id: 'u2', sourceText: 'world', anchor: { parentSelector: '#p1', textNodeIndex: 1, sourceFingerprint: 'cccc0000' } })
    ],
    translations: new Map([['u1', '你好'], ['u2', '世界']])
  })
  assert.deepEqual(result.operations, [{ blockId: 'b1', selector: '#p1', translation: '你好 世界' }])
  assert.equal(result.unrendered, 0)
  assert.equal(result.skipped, 0)
})

test('按设计跳过的块计入 skipped 且不计入 unrendered', () => {
  const result = buildWebBilingualOperations({
    blocks: [block({ id: 'b1', type: 'button', text: '提交' })],
    units: [unit({ id: 'u1', blockId: 'b1', sourceText: '提交' })],
    translations: new Map([['u1', 'Submit']])
  })
  assert.equal(result.operations.length, 0)
  assert.equal(result.skipped, 1)
  assert.equal(result.unrendered, 0)
})
