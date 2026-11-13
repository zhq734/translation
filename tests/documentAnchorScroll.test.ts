import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import type { DocumentModel, DocumentTextBlock } from '../src/shared/documentTypes.ts'
import { resolveDocumentAnchorOffset } from '../src/renderer/src/documentViewer.ts'

/**
 * 创建带几何信息的文本区块。
 * @param blockId 区块标识。
 * @param bbox 页面内矩形区域。
 * @returns 文本区块。
 * @author zhenghq
 */
function textBlock(
  blockId: string,
  bbox?: { x: number; y: number; width: number; height: number }
): DocumentTextBlock {
  return {
    kind: 'text',
    blockId,
    readingOrder: 0,
    translatable: true,
    role: 'heading',
    ...(bbox ? { bbox } : {}),
    runs: [{ runId: `${blockId}-run`, text: blockId }]
  }
}

/**
 * 创建指定格式与页面尺寸的文档模型。
 * @param format 源文件格式。
 * @param width 原始页面宽度。
 * @param height 原始页面高度。
 * @param blocks 页面区块。
 * @returns 文档模型。
 * @author zhenghq
 */
function model(
  format: 'pdf' | 'docx',
  width: number,
  height: number,
  blocks: DocumentTextBlock[]
): DocumentModel {
  return {
    schemaVersion: 1,
    documentId: `anchor-${format}`,
    source: {
      path: `/tmp/anchor.${format}`,
      fileName: `anchor.${format}`,
      format,
      sha256: `anchor-${format}-sha`,
      size: 1024
    },
    metadata: { direction: 'ltr' },
    pages: [{
      pageId: 'page-1',
      index: 0,
      width,
      height,
      blocks
    }],
    assets: [],
    warnings: []
  }
}

test('PDF 原文锚点应按渲染页高比例换算区块纵向偏移', () => {
  const document = model('pdf', 600, 800, [
    textBlock('section-headed', { x: 40, y: 160, width: 520, height: 30 })
  ])
  const target = { pageId: 'page-1', pageIndex: 0, pageNumber: 1, blockId: 'section-headed' }
  // 渲染页高为模型页高的一半时，160pt 的锚点应换算成 80px。
  assert.equal(resolveDocumentAnchorOffset(document, target, 400), 80)
})

test('缺少区块几何信息时锚点偏移回退为页首', () => {
  const document = model('pdf', 600, 800, [textBlock('no-geometry')])
  const target = { pageId: 'page-1', pageIndex: 0, pageNumber: 1, blockId: 'no-geometry' }
  assert.equal(resolveDocumentAnchorOffset(document, target, 400), null)
})

test('DOCX 等流式页面不参与几何锚点换算', () => {
  const document = model('docx', 600, 800, [
    textBlock('docx-heading', { x: 40, y: 160, width: 520, height: 30 })
  ])
  const target = { pageId: 'page-1', pageIndex: 0, pageNumber: 1, blockId: 'docx-heading' }
  assert.equal(resolveDocumentAnchorOffset(document, target, 400), null)
})

test('目标区块不存在时不返回锚点偏移', () => {
  const document = model('pdf', 600, 800, [textBlock('section-a', { x: 0, y: 10, width: 10, height: 10 })])
  const target = { pageId: 'page-1', pageIndex: 0, pageNumber: 1, blockId: 'missing' }
  assert.equal(resolveDocumentAnchorOffset(document, target, 400), null)
})

test('导航控制器必须用模型几何锚点补齐 PDF 原文页内滚动', () => {
  const source = readFileSync('src/renderer/src/documentNavigationController.ts', 'utf8')
  assert.match(source, /resolveDocumentAnchorOffset/u)
  assert.match(source, /scrollTo\(\{/u)
})
