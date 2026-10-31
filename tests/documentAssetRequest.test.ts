import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { resolveDocumentPdfImageAssetLocation } from '../src/renderer/src/documentAssetRequest.ts'
import type {
  DocumentBlock,
  DocumentFormat,
  DocumentImageBlock,
  DocumentModel
} from '../src/shared/documentTypes.ts'

/**
 * 创建跨页重复图片的 PDF 文档模型。
 * @param format 文档格式。
 * @param repeated 是否在第二页重复同一图片资源。
 * @param nestedOnSecondPage 第二页图片是否位于表格单元格内。
 * @returns 文档模型。
 * @author zhenghq
 */
function createImageModel(
  format: DocumentFormat = 'pdf',
  repeated = true,
  nestedOnSecondPage = false
): DocumentModel {
  const firstImage: DocumentImageBlock = {
    kind: 'image',
    blockId: 'image-1',
    readingOrder: 0,
    translatable: false,
    assetId: 'shared-asset',
    bbox: { x: 10, y: 20, width: 100, height: 50 }
  }
  const secondImage: DocumentImageBlock = {
    kind: 'image',
    blockId: 'image-2',
    readingOrder: 0,
    translatable: false,
    assetId: 'shared-asset',
    bbox: { x: 30, y: 40, width: 120, height: 60 }
  }
  const secondBlocks: DocumentBlock[] = nestedOnSecondPage
    ? [{
        kind: 'table',
        blockId: 'table-1',
        readingOrder: 0,
        translatable: true,
        rows: [{
          rowId: 'row-1',
          cells: [{ cellId: 'cell-1', rowSpan: 1, colSpan: 1, blocks: [secondImage] }]
        }]
      }]
    : [secondImage]
  return {
    schemaVersion: 1,
    documentId: 'document-1',
    source: {
      path: `/tmp/example.${format}`,
      fileName: `example.${format}`,
      format,
      sha256: 'source-sha',
      size: 100
    },
    metadata: { direction: 'auto' },
    pages: [{
      pageId: 'page-0',
      index: 0,
      width: 600,
      height: 800,
      blocks: [firstImage]
    }, ...(repeated ? [{
      pageId: 'page-1',
      index: 1,
      width: 600,
      height: 800,
      blocks: secondBlocks
    }] : [])],
    assets: [],
    warnings: []
  }
}

test('历史 PDF 同一图片跨页时必须优先返回当前页定位', () => {
  const model = createImageModel()
  const firstPageBlock = model.pages[0]!.blocks[0] as DocumentImageBlock
  const secondPageBlock = model.pages[1]!.blocks[0] as DocumentImageBlock

  assert.deepEqual(resolveDocumentPdfImageAssetLocation(model, firstPageBlock, 0), {
    pageIndex: 0,
    bbox: { x: 10, y: 20, width: 100, height: 50 }
  })
  assert.deepEqual(resolveDocumentPdfImageAssetLocation(model, secondPageBlock, 1), {
    pageIndex: 1,
    bbox: { x: 30, y: 40, width: 120, height: 60 }
  })
})

test('表格单元格中的历史 PDF 图片必须使用所在页面定位', () => {
  const model = createImageModel('pdf', true, true)
  const table = model.pages[1]!.blocks[0]
  assert.equal(table?.kind, 'table')
  const nestedImage = table?.kind === 'table'
    ? table.rows[0]!.cells[0]!.blocks[0] as DocumentImageBlock
    : undefined

  assert.deepEqual(resolveDocumentPdfImageAssetLocation(model, nestedImage!, 1), {
    pageIndex: 1,
    bbox: { x: 30, y: 40, width: 120, height: 60 }
  })
})

test('缺少当前页索引时只允许回退到全文档唯一图片定位', () => {
  const uniqueModel = createImageModel('pdf', false)
  const uniqueImage = uniqueModel.pages[0]!.blocks[0] as DocumentImageBlock
  assert.deepEqual(resolveDocumentPdfImageAssetLocation(uniqueModel, uniqueImage, undefined), {
    pageIndex: 0,
    bbox: { x: 10, y: 20, width: 100, height: 50 }
  })

  const repeatedModel = createImageModel('pdf', true)
  const repeatedImage = repeatedModel.pages[1]!.blocks[0] as DocumentImageBlock
  assert.equal(resolveDocumentPdfImageAssetLocation(repeatedModel, repeatedImage, undefined), undefined)
})

test('非 PDF 独立图片不得携带 PDF 页面定位', () => {
  const model = createImageModel('image', false)
  const image = model.pages[0]!.blocks[0] as DocumentImageBlock
  assert.equal(resolveDocumentPdfImageAssetLocation(model, image, 0), undefined)
})

test('资源请求缓存必须按页面区分，避免同资源跨页复用错误定位结果', () => {
  const source = readFileSync('src/renderer/src/document.ts', 'utf8')

  assert.match(source, /const cacheKey = `\$\{tab\.id\}:\$\{sourceSha256\}:\$\{assetId\}:\$\{pageIndex\}`/u)
})
