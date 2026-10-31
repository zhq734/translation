import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findDocumentTarget,
  parseDocumentTargetId,
  serializeDocumentBlockPath
} from '../src/shared/documentTargetLocator.ts'
import type { DocumentModel } from '../src/shared/documentTypes.ts'

/**
 * 构造包含顶层文本、表格嵌套文本与 OCR 区域的文档夹具。
 * @returns 文档模型。
 * @author zhenghq
 */
function createModel(): DocumentModel {
  return {
    schemaVersion: 1,
    documentId: 'document-1',
    source: {
      path: '/tmp/example.pdf',
      fileName: 'example.pdf',
      format: 'pdf',
      sha256: 'sha',
      size: 10
    },
    metadata: { direction: 'auto' },
    pages: [{
      pageId: 'page-1',
      index: 0,
      width: 600,
      height: 800,
      blocks: [{
        kind: 'text',
        blockId: 'block-top',
        readingOrder: 0,
        translatable: true,
        role: 'paragraph',
        runs: [{ runId: 'run-top', text: 'Hello' }]
      }, {
        kind: 'table',
        blockId: 'block-table',
        readingOrder: 1,
        translatable: true,
        rows: [{
          rowId: 'row-1',
          cells: [{
            cellId: 'cell-1',
            rowSpan: 1,
            colSpan: 1,
            blocks: [{
              kind: 'text',
              blockId: 'block-cell',
              readingOrder: 0,
              translatable: true,
              role: 'paragraph',
              runs: [{ runId: 'run-cell', text: 'Cell' }]
            }]
          }]
        }]
      }, {
        kind: 'image',
        blockId: 'block-image',
        readingOrder: 2,
        translatable: false,
        assetId: 'asset-1',
        ocrRegions: [{
          regionId: 'region-1',
          pageId: 'page-1',
          blockId: 'block-image',
          assetId: 'asset-1',
          bbox: { x: 0, y: 0, width: 1, height: 1 },
          text: 'OCR text',
          status: 'recognized'
        }]
      }]
    }],
    assets: [],
    warnings: []
  }
}

test('目标标识必须解析顶层文本、表格嵌套文本、OCR 与表格行', () => {
  assert.deepEqual(parseDocumentTargetId('0:0:text:run-top'), {
    pageIndex: 0,
    blockPath: [0],
    kind: 'text',
    identifier: 'run-top'
  })
  assert.deepEqual(parseDocumentTargetId('0:0.r0c0.0:text:run-cell'), {
    pageIndex: 0,
    blockPath: [0, { row: 0, cell: 0 }, 0],
    kind: 'text',
    identifier: 'run-cell'
  })
  assert.deepEqual(parseDocumentTargetId('0:2:ocr:region-1'), {
    pageIndex: 0,
    blockPath: [2],
    kind: 'ocr',
    identifier: 'region-1'
  })
  assert.deepEqual(parseDocumentTargetId('0:1:row:row-1'), {
    pageIndex: 0,
    blockPath: [1],
    kind: 'row',
    identifier: 'row-1'
  })
  assert.equal(serializeDocumentBlockPath([0, { row: 0, cell: 0 }, 0]), '0.r0c0.0')
})

test('目标定位必须返回稳定区块、run、表格行与 OCR 区域', () => {
  const model = createModel()
  const top = findDocumentTarget(model, '0:0:text:run-top')
  assert.equal(top?.page.pageId, 'page-1')
  assert.equal(top?.block.blockId, 'block-top')
  assert.equal(top?.kind, 'text')
  assert.equal(top?.runId, 'run-top')
  assert.equal(top?.isNested, false)

  const nested = findDocumentTarget(model, '0:1.r0c0.0:text:run-cell')
  assert.equal(nested?.block.blockId, 'block-cell')
  assert.equal(nested?.runId, 'run-cell')
  assert.equal(nested?.isNested, true)

  const row = findDocumentTarget(model, '0:1:row:row-1')
  assert.equal(row?.block.blockId, 'block-table')
  assert.equal(row?.rowId, 'row-1')

  const ocr = findDocumentTarget(model, '0:2:ocr:region-1')
  assert.equal(ocr?.block.blockId, 'block-image')
  assert.equal(ocr?.regionId, 'region-1')
})

test('目标定位必须拒绝非法路径、越界路径与类型不匹配', () => {
  const model = createModel()
  assert.equal(parseDocumentTargetId('x:0:text:run-top'), null)
  assert.equal(parseDocumentTargetId('0:0.text:run-top'), null)
  assert.equal(parseDocumentTargetId('0:0:text:'), null)
  assert.equal(parseDocumentTargetId('-1:0:text:run-top'), null)
  assert.equal(parseDocumentTargetId('0:r0c0:text:run-top'), null)
  assert.equal(parseDocumentTargetId('0:0:unknown:run-top'), null)
  assert.equal(findDocumentTarget(model, '9:0:text:run-top'), null)
  assert.equal(findDocumentTarget(model, '0:9:text:run-top'), null)
  assert.equal(findDocumentTarget(model, '0:0:ocr:region-1'), null)
  assert.equal(findDocumentTarget(model, '0:1.r9c0.0:text:run-cell'), null)
  assert.equal(findDocumentTarget(model, '0:0:text:missing-run'), null)
})
