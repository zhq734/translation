import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DOCUMENT_IMAGE_STACK_MIN_OVERLAP_RATIO,
  resolveDocumentImageStackContainedTexts,
  resolveDocumentImageStackGroups
} from '../src/shared/documentImageStacks.ts'
import type { DocumentImageBlock, DocumentTextBlock } from '../src/shared/documentTypes.ts'

/**
 * 构造图片区块测试数据。
 * @param blockId 图片区块标识。
 * @param bbox 图片原页面边界。
 * @param stackGroupId 可选的显式叠放组标识。
 * @param stackOrder 可选的显式叠放顺序。
 * @returns 图片区块。
 * @author zhenghq
 */
function imageBlock(
  blockId: string,
  bbox: DocumentImageBlock['bbox'],
  stackGroupId?: string,
  stackOrder?: number
): DocumentImageBlock {
  return {
    kind: 'image',
    blockId,
    readingOrder: 0,
    translatable: false,
    bbox,
    assetId: `${blockId}-asset`,
    ...(stackGroupId === undefined ? {} : { stackGroupId }),
    ...(stackOrder === undefined ? {} : { stackOrder })
  }
}

test('历史快照中未标记的表格图片必须按显著几何重叠恢复叠放组', () => {
  const back = imageBlock('back', { x: 63.12, y: 220.56, width: 469.44, height: 354.96 })
  const front = imageBlock('front', { x: 81.6, y: 233.52, width: 432.48, height: 318.24 })

  const groups = resolveDocumentImageStackGroups([back, front])

  assert.equal(DOCUMENT_IMAGE_STACK_MIN_OVERLAP_RATIO, 0.3)
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0]?.blocks.map((block) => block.blockId), ['back', 'front'])
  assert.equal(groups[0]?.stackGroupId, undefined)
})

test('未标记图片只有显著重叠时才合并，轻微相交不得拆错普通图片流', () => {
  const left = imageBlock('left', { x: 0, y: 0, width: 100, height: 100 })
  const slightlyOverlapping = imageBlock('slightly-overlapping', {
    x: 90,
    y: 0,
    width: 100,
    height: 100
  })
  const separate = imageBlock('separate', { x: 250, y: 0, width: 100, height: 100 })

  const groups = resolveDocumentImageStackGroups([left, slightlyOverlapping, separate])

  assert.deepEqual(groups, [])
})

test('历史快照的几何叠放必须支持传递重叠形成完整图层组', () => {
  const first = imageBlock('first', { x: 0, y: 0, width: 100, height: 100 })
  const second = imageBlock('second', { x: 50, y: 0, width: 100, height: 100 })
  const third = imageBlock('third', { x: 100, y: 0, width: 100, height: 100 })

  const groups = resolveDocumentImageStackGroups([first, second, third])

  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0]?.blocks.map((block) => block.blockId), ['first', 'second', 'third'])
})

test('显式 stackGroupId 必须优先于几何判断并保留原始叠放顺序', () => {
  const front = imageBlock('front', { x: 200, y: 200, width: 30, height: 30 }, 'explicit', 1)
  const back = imageBlock('back', { x: 0, y: 0, width: 100, height: 100 }, 'explicit', 0)

  const groups = resolveDocumentImageStackGroups([front, back])

  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.stackGroupId, 'explicit')
  assert.deepEqual(groups[0]?.blocks.map((block) => [block.blockId, block.stackOrder]), [
    ['back', 0],
    ['front', 1]
  ])
})

test('图片叠放范围完全包含的文本必须归入同一覆盖组，范围外文本保持普通流', () => {
  const images = [
    imageBlock('back', { x: 63.12, y: 220.56, width: 469.44, height: 354.96 }),
    imageBlock('front', { x: 81.6, y: 233.52, width: 432.48, height: 318.24 })
  ]
  const inside: DocumentTextBlock = {
    kind: 'text',
    blockId: 'inside',
    readingOrder: 2,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 160.44, y: 387.43, width: 174.56, height: 7.93 },
    runs: [{ runId: 'inside-run', text: '进入下一阶段前必须满足的条件，不满足就停下来' }]
  }
  const outside: DocumentTextBlock = {
    ...inside,
    blockId: 'outside',
    readingOrder: 3,
    bbox: { x: 160.44, y: 600, width: 174.56, height: 7.93 }
  }

  assert.deepEqual(
    resolveDocumentImageStackContainedTexts([images[0]!, images[1]!, inside, outside], images)
      .map((block) => block.blockId),
    ['inside']
  )
})
