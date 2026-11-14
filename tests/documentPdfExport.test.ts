import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  decodePDFRawStream
} from 'pdf-lib'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as pdfjsWorkerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
import type { DocumentModel } from '../src/shared/documentTypes.ts'
import {
  DocumentPdfExportError,
  exportDocumentToPdf
} from '../src/main/documentPdfExport.ts'
import { encodePng } from '../src/main/pngCodec.ts'
import { DOCUMENT_OCR_UNIFORM_FONT_SIZE } from '../src/shared/documentOcrLayout.ts'
import type { RgbaImage } from '../src/shared/imagePreprocess.ts'

// PDF.js 以 CommonJS 发布；esbuild 打包测试时可能不生成 default，而 Node 原生加载会生成 default。
const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as typeof pdfjsModule
const pdfjsWorker = ('default' in pdfjsWorkerModule ? pdfjsWorkerModule.default : pdfjsWorkerModule) as unknown
;(globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker

/**
 * 构造 PDF 导出测试文档。
 * @param text 页面文本。
 * @returns 文档模型。
 * @author zhenghq
 */
function documentWithText(text: string): DocumentModel {
  return {
    schemaVersion: 1,
    documentId: 'document-1',
    source: {
      path: '/tmp/test.txt',
      fileName: 'test.txt',
      format: 'txt',
      sha256: 'abc',
      size: 1
    },
    metadata: { direction: 'ltr' },
    pages: [{
      pageId: 'page-1',
      index: 0,
      width: 612,
      height: 792,
      blocks: [{
        kind: 'text',
        blockId: 'block-1',
        readingOrder: 0,
        translatable: true,
        role: 'paragraph',
        bbox: { x: 40, y: 50, width: 500, height: 80 },
        runs: [{ runId: 'run-1', text, style: { fontSize: 12, fontWeight: 400 } }]
      }]
    }],
    assets: [],
    warnings: []
  }
}

/**
 * 生成纯色 PNG，用于验证 PDF 图内文字遮罩会从最上层图片采样背景色。
 * @param width 图片宽度。
 * @param height 图片高度。
 * @param color 不透明 RGB 颜色。
 * @returns PNG 字节。
 * @author zhenghq
 */
function createSolidPng(
  width: number,
  height: number,
  color: readonly [number, number, number]
): Uint8Array {
  const image: RgbaImage = { width, height, data: new Uint8Array(width * height * 4) }
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = color[0]
    image.data[offset + 1] = color[1]
    image.data[offset + 2] = color[2]
    image.data[offset + 3] = 255
  }
  return new Uint8Array(encodePng(image))
}

/**
 * 读取 PDF 指定页的可复制文本层。
 * @param bytes 已导出的 PDF 字节。
 * @param pageNumber 从 1 开始的页码。
 * @returns PDF.js 提取到的文本内容。
 * @author zhenghq
 */
async function extractFirstPageText(bytes: Uint8Array, pageNumber = 1): Promise<string> {
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const textContent = await (await exportedPdf.getPage(pageNumber)).getTextContent()
    return textContent.items.map((item) => 'str' in item ? item.str : '').join('')
  } finally {
    await exportedPdf.destroy()
  }
}

test('PDF 导出返回有效 PDF 字节并保留页面尺寸', async () => {
  const result = await exportDocumentToPdf(documentWithText('Hello document'), {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const bytes = result.bytes
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 5)), '%PDF-')
  assert.ok(bytes.byteLength > 500)
  assert.deepEqual(result.warnings, [])
})

test('译文 PDF 导出必须只包含译文并逐页上报进度', async () => {
  const model = documentWithText('Translated document')
  const progress: Array<{ completedPages: number; totalPages: number }> = []

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  }, {
    onProgress: (event) => progress.push(event)
  })

  const text = await extractFirstPageText(bytes)
  assert.match(text, /Translated document/u)
  assert.doesNotMatch(text, /Source document/u)
  assert.deepEqual(progress, [{ completedPages: 1, totalPages: 1 }])
})

test('PDF 合成导出必须在开始前响应取消信号', async () => {
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    exportDocumentToPdf(documentWithText('Cancelled'), {
      loadFontBytes: async () => null,
      loadAssetBytes: async () => null
    }, { signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError'
  )
})

test('PDF 导出必须逐页上报进度并支持中途取消', async () => {
  const model = documentWithText('Page one')
  model.pages.push({
    ...model.pages[0]!,
    pageId: 'page-2',
    index: 1,
    blocks: [{
      kind: 'text',
      blockId: 'block-2',
      readingOrder: 0,
      translatable: true,
      role: 'paragraph',
      bbox: { x: 40, y: 50, width: 500, height: 80 },
      runs: [{ runId: 'run-2', text: 'Page two', style: { fontSize: 12 } }]
    }]
  })
  const progress: Array<{ completedPages: number; totalPages: number }> = []
  const controller = new AbortController()

  await assert.rejects(
    exportDocumentToPdf(model, {
      loadFontBytes: async () => null,
      loadAssetBytes: async () => null
    }, {
      signal: controller.signal,
      onProgress: (event) => {
        progress.push(event)
        if (event.completedPages === 1) controller.abort()
      }
    }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError'
  )

  assert.deepEqual(progress, [{ completedPages: 1, totalPages: 2 }])
})

test('PDF 导出必须为表格单元格绘制边框并保留单元格文字', async () => {
  const model = documentWithText('')
  model.pages[0]!.blocks = [{
    kind: 'table',
    blockId: 'table-1',
    readingOrder: 0,
    translatable: true,
    bbox: { x: 40, y: 50, width: 400, height: 80 },
    columnWidths: [200, 200],
    headerRows: 1,
    rows: [
      {
        rowId: 'table-1-row-0',
        cells: [
          {
            cellId: 'cell-0-0',
            rowSpan: 1,
            colSpan: 1,
            blocks: [{
              kind: 'text',
              blockId: 'cell-0-0-block-0',
              readingOrder: 0,
              translatable: true,
              role: 'paragraph',
              runs: [{ runId: 'cell-0-0-run-0', text: 'Name', style: { fontSize: 12 } }]
            }]
          },
          {
            cellId: 'cell-0-1',
            rowSpan: 1,
            colSpan: 1,
            blocks: [{
              kind: 'text',
              blockId: 'cell-0-1-block-0',
              readingOrder: 0,
              translatable: true,
              role: 'paragraph',
              runs: [{ runId: 'cell-0-1-run-0', text: 'Value', style: { fontSize: 12 } }]
            }]
          }
        ]
      },
      {
        rowId: 'table-1-row-1',
        cells: [
          {
            cellId: 'cell-1-0',
            rowSpan: 1,
            colSpan: 1,
            blocks: [{
              kind: 'text',
              blockId: 'cell-1-0-block-0',
              readingOrder: 0,
              translatable: true,
              role: 'paragraph',
              runs: [{ runId: 'cell-1-0-run-0', text: 'Alice', style: { fontSize: 12 } }]
            }]
          },
          {
            cellId: 'cell-1-1',
            rowSpan: 1,
            colSpan: 1,
            blocks: [{
              kind: 'text',
              blockId: 'cell-1-1-block-0',
              readingOrder: 0,
              translatable: true,
              role: 'paragraph',
              runs: [{ runId: 'cell-1-1-run-0', text: '42', style: { fontSize: 12 } }]
            }]
          }
        ]
      }
    ]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const page = await exportedPdf.getPage(1)
    const operatorList = await page.getOperatorList()
    assert.ok(operatorList.fnArray.filter((operation) => operation === pdfjs.OPS.constructPath).length >= 4)
    assert.ok(operatorList.fnArray.filter((operation) => operation === pdfjs.OPS.stroke).length >= 4)
    const textContent = await page.getTextContent()
    const extracted = textContent.items
      .flatMap((item) => 'str' in item ? [item.str.trim()] : [])
      .filter(Boolean)
    assert.deepEqual(extracted, ['Name', 'Value', 'Alice', '42'])
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 导出必须按跨行单元格占用后的真实列定位后续单元格', async () => {
  const model = documentWithText('')
  model.pages[0]!.blocks = [{
    kind: 'table',
    blockId: 'table-row-span',
    readingOrder: 0,
    translatable: true,
    bbox: { x: 40, y: 50, width: 400, height: 80 },
    columnWidths: [200, 200],
    rows: [
      {
        rowId: 'table-row-span-row-0',
        cells: [
          {
            cellId: 'table-row-span-merged',
            rowSpan: 2,
            colSpan: 1,
            blocks: [{
              kind: 'text',
              blockId: 'table-row-span-merged-text',
              readingOrder: 0,
              translatable: true,
              role: 'paragraph',
              runs: [{ runId: 'table-row-span-merged-run', text: 'ROWSPAN_MERGED', style: { fontSize: 10 } }]
            }]
          },
          {
            cellId: 'table-row-span-right-top',
            rowSpan: 1,
            colSpan: 1,
            blocks: [{
              kind: 'text',
              blockId: 'table-row-span-right-top-text',
              readingOrder: 1,
              translatable: true,
              role: 'paragraph',
              runs: [{ runId: 'table-row-span-right-top-run', text: 'ROWSPAN_RIGHT_TOP', style: { fontSize: 10 } }]
            }]
          }
        ]
      },
      {
        rowId: 'table-row-span-row-1',
        cells: [{
          cellId: 'table-row-span-right-bottom',
          rowSpan: 1,
          colSpan: 1,
          blocks: [{
            kind: 'text',
            blockId: 'table-row-span-right-bottom-text',
            readingOrder: 2,
            translatable: true,
            role: 'paragraph',
            runs: [{ runId: 'table-row-span-right-bottom-run', text: 'ROWSPAN_RIGHT_BOTTOM', style: { fontSize: 10 } }]
          }]
        }]
      }
    ]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const textContent = await (await exportedPdf.getPage(1)).getTextContent()
    const positioned = textContent.items.flatMap((item) =>
      'str' in item && 'transform' in item
        ? [{ text: item.str, x: item.transform[4] ?? 0 }]
        : [])
    const merged = positioned.filter((item) => item.text === 'ROWSPAN_MERGED')
    const rightTop = positioned.find((item) => item.text === 'ROWSPAN_RIGHT_TOP')
    const rightBottom = positioned.find((item) => item.text === 'ROWSPAN_RIGHT_BOTTOM')
    assert.equal(merged.length, 1, '跨行单元格必须只绘制一次')
    assert.ok(rightTop && rightBottom)
    assert.ok(Math.abs(rightBottom.x - rightTop.x) <= 1, `第二行单元格必须位于右列，实际 x=${rightBottom.x}`)
    assert.ok(rightBottom.x > 200, `第二行单元格不得回退到左列，实际 x=${rightBottom.x}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 表格跨页后必须重复表头行', async () => {
  const model = documentWithText('')
  model.pages[0]!.width = 300
  model.pages[0]!.height = 200
  model.pages[0]!.blocks = [{
    kind: 'table',
    blockId: 'table-repeated-header',
    readingOrder: 0,
    translatable: true,
    bbox: { x: 20, y: 15, width: 260, height: 60 },
    columnWidths: [130, 130],
    headerRows: 1,
    rows: [
      {
        rowId: 'table-repeated-header-row-0',
        cells: [
          {
            cellId: 'table-repeated-header-cell-0',
            rowSpan: 1,
            colSpan: 1,
            blocks: [{
              kind: 'text',
              blockId: 'table-repeated-header-text-0',
              readingOrder: 0,
              translatable: true,
              role: 'paragraph',
              runs: [{ runId: 'table-repeated-header-run-0', text: 'REPEATED_TABLE_HEADER', style: { fontSize: 10 } }]
            }]
          },
          {
            cellId: 'table-repeated-header-cell-1',
            rowSpan: 1,
            colSpan: 1,
            blocks: [{
              kind: 'text',
              blockId: 'table-repeated-header-text-1',
              readingOrder: 1,
              translatable: true,
              role: 'paragraph',
              runs: [{ runId: 'table-repeated-header-run-1', text: 'VALUE', style: { fontSize: 10 } }]
            }]
          }
        ]
      },
      {
        rowId: 'table-repeated-header-row-1',
        cells: [{
          cellId: 'table-repeated-header-cell-2',
          rowSpan: 1,
          colSpan: 2,
          blocks: [{
            kind: 'text',
            blockId: 'table-repeated-header-text-2',
            readingOrder: 2,
            translatable: true,
            role: 'paragraph',
            runs: [{
              runId: 'table-repeated-header-run-2',
              text: 'LONG_DATA_'.repeat(30),
              style: { fontSize: 10 }
            }]
          }]
        }]
      },
      {
        rowId: 'table-repeated-header-row-2',
        cells: [{
          cellId: 'table-repeated-header-cell-3',
          rowSpan: 1,
          colSpan: 2,
          blocks: [{
            kind: 'text',
            blockId: 'table-repeated-header-text-3',
            readingOrder: 3,
            translatable: true,
            role: 'paragraph',
            runs: [{ runId: 'table-repeated-header-run-3', text: 'AFTER_BREAK', style: { fontSize: 10 } }]
          }]
        }]
      },
      {
        rowId: 'table-repeated-header-row-3',
        cells: [{
          cellId: 'table-repeated-header-cell-4',
          rowSpan: 1,
          colSpan: 2,
          blocks: [{
            kind: 'text',
            blockId: 'table-repeated-header-text-4',
            readingOrder: 4,
            translatable: true,
            role: 'paragraph',
            runs: [{ runId: 'table-repeated-header-run-4', text: 'LAST_ROW', style: { fontSize: 10 } }]
          }]
        }]
      }
    ]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    assert.ok(exportedPdf.numPages >= 2, '长数据行必须触发表格跨页')
    const secondPageText = await extractFirstPageText(bytes, 2)
    assert.equal(secondPageText.includes('REPEATED_TABLE_HEADER'), true, '跨页后的表格必须重复表头')
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 导出必须把表格内嵌图片限制在单元格内并让后续行避开图片', async () => {
  const model = documentWithText('')
  model.pages[0]!.blocks = [{
    kind: 'table',
    blockId: 'table-with-image',
    readingOrder: 0,
    translatable: true,
    bbox: { x: 40, y: 50, width: 400, height: 40 },
    columnWidths: [200, 200],
    rows: [{
      rowId: 'table-with-image-row-0',
      cells: [{
        cellId: 'table-with-image-cell-0',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'text',
          blockId: 'table-with-image-label',
          readingOrder: 0,
          translatable: true,
          role: 'paragraph',
          runs: [{ runId: 'table-with-image-label-run', text: 'Certificate', style: { fontSize: 12 } }]
        }]
      }, {
        cellId: 'table-with-image-cell-1',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'image',
          blockId: 'table-with-image-image',
          readingOrder: 1,
          translatable: false,
          assetId: 'table-with-image-asset',
          bbox: { x: 260, y: 55, width: 160, height: 80 }
        }]
      }]
    }, {
      rowId: 'table-with-image-row-1',
      cells: [{
        cellId: 'table-with-image-cell-2',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'text',
          blockId: 'table-with-image-after',
          readingOrder: 2,
          translatable: true,
          role: 'paragraph',
          runs: [{ runId: 'table-with-image-after-run', text: 'AFTER_TABLE_IMAGE', style: { fontSize: 12 } }]
        }]
      }, {
        cellId: 'table-with-image-cell-3',
        rowSpan: 1,
        colSpan: 1,
        blocks: []
      }]
    }]
  }]

  let loadCount = 0
  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async (assetId) => {
      assert.equal(assetId, 'table-with-image-asset')
      loadCount += 1
      return readFileSync('tests/fixtures/ocr-scaling/clear.png')
    }
  })
  assert.equal(loadCount, 1, '表格图片资源必须只加载一次')

  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const page = await exportedPdf.getPage(1)
    const operatorList = await page.getOperatorList()
    assert.ok(operatorList.fnArray.includes(pdfjs.OPS.paintImageXObject))
    const textContent = await page.getTextContent()
    const after = textContent.items.find((candidate) => 'str' in candidate && candidate.str === 'AFTER_TABLE_IMAGE')
    assert.ok(after && 'transform' in after)
    const afterTop = page.getViewport({ scale: 1 }).height - (after.transform[5] ?? 0)
    // 图片按右列可用宽度缩放后约为 50pt 高，第二行必须从图片底边之后开始。
    assert.ok(afterTop > 120, `next row must clear table image, got top=${afterTop}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 导出必须恢复历史表格单元格内未标记图片的几何叠放关系', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  const backId = 'legacy-table-stack-back'
  const frontId = 'legacy-table-stack-front'
  page.blocks = [{
    kind: 'table',
    blockId: 'legacy-table-stack',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 40, y: 50, width: 400, height: 300 },
    columnWidths: [400],
    rows: [{
      rowId: 'legacy-table-stack-row',
      cells: [{
        cellId: 'legacy-table-stack-cell',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'image',
          blockId: backId,
          readingOrder: 0,
          translatable: false,
          assetId: 'legacy-table-stack-asset',
          bbox: { x: 60, y: 60, width: 300, height: 200 },
          ocrRegions: [{
            regionId: 'legacy-table-stack-back-region',
            pageId: page.pageId,
            blockId: backId,
            assetId: 'legacy-table-stack-asset',
            bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.15 },
            text: 'LEGACY_TABLE_STACK_BACK_TEXT',
            status: 'recognized'
          }]
        }, {
          kind: 'image',
          blockId: frontId,
          readingOrder: 1,
          translatable: false,
          assetId: 'legacy-table-stack-asset',
          bbox: { x: 90, y: 90, width: 240, height: 140 },
          ocrRegions: [{
            regionId: 'legacy-table-stack-front-region',
            pageId: page.pageId,
            blockId: frontId,
            assetId: 'legacy-table-stack-asset',
            bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.15 },
            text: 'LEGACY_TABLE_STACK_FRONT_TEXT',
            status: 'recognized'
          }]
        }]
      }]
    }]
  }]
  model.assets = [{
    assetId: 'legacy-table-stack-asset',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'legacy-table-stack-fixture',
    byteLength: 9364
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => readFileSync('tests/fixtures/ocr-scaling/clear.png')
  }, { includeOcrTextLayer: true })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const exportedPage = await exportedPdf.getPage(1)
    const content = await exportedPage.getTextContent()
    const pageHeight = exportedPage.getViewport({ scale: 1 }).height
    const back = content.items.find((item) => (
      'str' in item && 'transform' in item && item.str.includes('LEGACY_TABLE_STACK_BACK')
    ))
    const front = content.items.find((item) => (
      'str' in item && 'transform' in item && item.str.includes('LEGACY_TABLE_STACK_FRONT')
    ))
    assert.ok(back && 'transform' in back, '导出必须包含底层表格图片 OCR 文字')
    assert.ok(front && 'transform' in front, '导出必须包含上层表格图片 OCR 文字')
    const backTop = pageHeight - (back.transform[5] ?? pageHeight)
    const frontTop = pageHeight - (front.transform[5] ?? pageHeight)
    assert.ok(frontTop - backTop < 80,
      `表格叠图不能被纵向拆开，底层顶部=${backTop}，上层顶部=${frontTop}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 表格叠图范围内文本必须原位绘制且不能重复占用单元格流', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.blocks = [{
    kind: 'table',
    blockId: 'table-stack-contained-text',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 40, y: 50, width: 400, height: 300 },
    columnWidths: [400],
    rows: [{
      rowId: 'table-stack-contained-text-row',
      cells: [{
        cellId: 'table-stack-contained-text-cell',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'image',
          blockId: 'table-stack-contained-text-back',
          readingOrder: 0,
          translatable: false,
          assetId: 'table-stack-contained-text-asset',
          bbox: { x: 60, y: 60, width: 300, height: 200 }
        }, {
          kind: 'image',
          blockId: 'table-stack-contained-text-front',
          readingOrder: 1,
          translatable: false,
          assetId: 'table-stack-contained-text-asset',
          bbox: { x: 90, y: 90, width: 240, height: 140 }
        }, {
          kind: 'text',
          blockId: 'table-stack-contained-text-inside',
          readingOrder: 2,
          translatable: true,
          role: 'paragraph',
          bbox: { x: 160, y: 160, width: 120, height: 12 },
          runs: [{ runId: 'table-stack-contained-text-inside-run', text: 'TABLE_IMAGE_INNER_TEXT' }]
        }, {
          kind: 'text',
          blockId: 'table-stack-contained-text-after',
          readingOrder: 3,
          translatable: true,
          role: 'paragraph',
          bbox: { x: 60, y: 280, width: 120, height: 12 },
          runs: [{ runId: 'table-stack-contained-text-after-run', text: 'TABLE_IMAGE_AFTER_TEXT' }]
        }]
      }]
    }]
  }]
  model.assets = [{
    assetId: 'table-stack-contained-text-asset',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'table-stack-contained-text-fixture',
    byteLength: 9364
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => readFileSync('tests/fixtures/ocr-scaling/clear.png')
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const exportedPage = await exportedPdf.getPage(1)
    const pageHeight = exportedPage.getViewport({ scale: 1 }).height
    const content = await exportedPage.getTextContent()
    const items = content.items.filter((item): item is typeof item & { str: string; transform: number[] } =>
      'str' in item && 'transform' in item && item.str.trim().length > 0)
    const innerItems = items.filter((item) => item.str.includes('TABLE_IMAGE_INNER_TEXT'))
    const after = items.find((item) => item.str.includes('TABLE_IMAGE_AFTER_TEXT'))

    assert.equal(innerItems.length, 1, '图片叠放范围内的文本只能绘制一次')
    assert.ok(after, '图片叠放组后的普通文本必须继续导出')
    const innerTop = pageHeight - (innerItems[0]!.transform[5] ?? pageHeight)
    const afterTop = pageHeight - (after.transform[5] ?? pageHeight)
    // 单元格内容宽度为 390pt，叠图并集宽 300pt；图内文本应落在约 185pt 的原始缩放位置，
    // 而不是被当作普通流排到约 315pt 的图片下方。
    assert.ok(Math.abs(innerTop - 185) < 12,
      `图内文本必须保持原始覆盖位置，实际顶部=${innerTop}`)
    assert.ok(afterTop < 335,
      `图内文本不能重复增加单元格流高度，后续文本实际顶部=${afterTop}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 表格图内文字必须先按最上层底图背景遮罩再绘制译文', async () => {
  const model = documentWithText('')
  model.pages[0]!.blocks = [{
    kind: 'table',
    blockId: 'table-stack-mask',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 40, y: 50, width: 400, height: 300 },
    columnWidths: [400],
    rows: [{
      rowId: 'table-stack-mask-row',
      cells: [{
        cellId: 'table-stack-mask-cell',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'image',
          blockId: 'table-stack-mask-back',
          readingOrder: 0,
          translatable: false,
          assetId: 'table-stack-mask-back-asset',
          bbox: { x: 60, y: 60, width: 300, height: 200 }
        }, {
          kind: 'image',
          blockId: 'table-stack-mask-front',
          readingOrder: 1,
          translatable: false,
          assetId: 'table-stack-mask-front-asset',
          bbox: { x: 90, y: 90, width: 240, height: 140 }
        }, {
          kind: 'text',
          blockId: 'table-stack-mask-text',
          readingOrder: 2,
          translatable: true,
          role: 'paragraph',
          bbox: { x: 160, y: 160, width: 120, height: 12 },
          runs: [{ runId: 'table-stack-mask-run', text: 'MASKED_TABLE_TRANSLATION' }]
        }]
      }]
    }]
  }]
  model.assets = [{
    assetId: 'table-stack-mask-back-asset',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'table-stack-mask-back',
    byteLength: 1
  }, {
    assetId: 'table-stack-mask-front-asset',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'table-stack-mask-front',
    byteLength: 1
  }]
  const backPng = createSolidPng(300, 200, [32, 64, 220])
  const frontPng = createSolidPng(240, 140, [220, 48, 32])

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async (assetId) => (
      assetId === 'table-stack-mask-front-asset' ? frontPng : backPng
    )
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const page = await exportedPdf.getPage(1)
    const operatorList = await page.getOperatorList()
    const imageIndices = operatorList.fnArray
      .map((operation, index) => operation === pdfjs.OPS.paintImageXObject ? index : -1)
      .filter((index) => index >= 0)
    const textIndex = operatorList.fnArray.indexOf(pdfjs.OPS.showText)
    assert.equal(imageIndices.length, 2, '叠放组必须绘制两层图片')
    assert.ok(textIndex > imageIndices[1]!, '图内译文必须绘制在叠放图片之后')

    const maskStart = imageIndices[1]! + 1
    const maskOperations = operatorList.fnArray.slice(maskStart, textIndex)
    const maskPathOffset = maskOperations.findIndex((operation) => operation === pdfjs.OPS.constructPath)
    assert.ok(maskPathOffset >= 0, '图片与译文之间必须先绘制原文字背景遮罩')
    const maskPathIndex = maskStart + maskPathOffset
    const maskPath = operatorList.argsArray[maskPathIndex]?.[0]
    assert.ok(Array.isArray(maskPath) && maskPath.includes(pdfjs.OPS.moveTo) &&
      maskPath.filter((operation) => operation === pdfjs.OPS.lineTo).length === 3 &&
      maskPath.includes(pdfjs.OPS.closePath),
    '原文字遮罩必须绘制闭合矩形，不能依赖图片重绘')
    const maskBounds = operatorList.argsArray[maskPathIndex]?.[2]
    assert.ok(Array.isArray(maskBounds) && Number(maskBounds[3]) < 30,
      '遮罩高度只能覆盖原文字 bbox 及安全边，不能遮住图片中的相邻行')

    const fillColors = operatorList.fnArray
      .slice(maskStart, maskPathIndex + 1)
      .map((operation, offset) => ({ operation, index: maskStart + offset }))
      .filter((entry) => entry.operation === pdfjs.OPS.setFillRGBColor)
      .map((entry) => operatorList.argsArray[entry.index])
    const redMask = fillColors.find((args) => {
      const colorChannels = args as
        | readonly number[]
        | Readonly<Record<number, number>>
        | undefined
      return Math.abs(Number(colorChannels?.[0]) - 220) < 2 &&
        Math.abs(Number(colorChannels?.[1]) - 48) < 2 &&
        Math.abs(Number(colorChannels?.[2]) - 32) < 2
    })
    assert.ok(redMask, '遮罩必须取最上层图片文字 bbox 外侧的背景色，不能使用底层蓝色或固定白色')
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 表格列宽必须按表格边界归一化，不能因列宽总和偏大而溢出页面', async () => {
  const model = documentWithText('')
  model.pages[0]!.blocks = [{
    kind: 'table',
    blockId: 'table-normalized-width',
    readingOrder: 0,
    translatable: true,
    bbox: { x: 40, y: 50, width: 300, height: 40 },
    columnWidths: [400, 200],
    rows: [{
      rowId: 'table-normalized-width-row',
      cells: ['LEFT_CELL', 'RIGHT_CELL'].map((text, index) => ({
        cellId: `table-normalized-width-cell-${index}`,
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'text' as const,
          blockId: `table-normalized-width-text-${index}`,
          readingOrder: index,
          translatable: true,
          role: 'paragraph' as const,
          runs: [{ runId: `table-normalized-width-run-${index}`, text, style: { fontSize: 10 } }]
        }]
      }))
    }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const content = await (await exportedPdf.getPage(1)).getTextContent()
    const items = content.items.filter((item): item is typeof item & { str: string; transform: number[]; width: number } =>
      'str' in item && 'transform' in item && item.str.trim().length > 0)
    const left = items.find((item) => item.str === 'LEFT_CELL')
    const right = items.find((item) => item.str === 'RIGHT_CELL')
    assert.ok(left && right)
    // 文本坐标包含单元格左侧 5pt 内边距，比较列边界时必须先还原。
    const rightCellLeft = (right.transform[4] ?? 0) - 5
    assert.ok(rightCellLeft <= 240.01, `right column must remain inside table: ${rightCellLeft}`)
    assert.ok((right.transform[4] ?? 0) > (left.transform[4] ?? 0) + 150)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 表格列宽必须根据译文自然扩展，长英文只能按单词换行', async () => {
  const model = documentWithText('')
  model.pages[0]!.blocks = [{
    kind: 'table',
    blockId: 'table-adaptive-width',
    readingOrder: 0,
    translatable: true,
    bbox: { x: 40, y: 50, width: 300, height: 40 },
    columnWidths: [60, 240],
    rows: [{
      rowId: 'table-adaptive-width-row',
      cells: [
        {
          cellId: 'table-adaptive-width-label',
          rowSpan: 1,
          colSpan: 1,
          blocks: [{
            kind: 'text',
            blockId: 'table-adaptive-width-label-text',
            readingOrder: 0,
            translatable: true,
            role: 'paragraph',
            runs: [{ runId: 'table-adaptive-width-label-run', text: 'Responsible person', style: { fontSize: 10 } }]
          }]
        },
        {
          cellId: 'table-adaptive-width-value',
          rowSpan: 1,
          colSpan: 1,
          blocks: [{
            kind: 'text',
            blockId: 'table-adaptive-width-value-text',
            readingOrder: 1,
            translatable: true,
            role: 'paragraph',
            runs: [{ runId: 'table-adaptive-width-value-run', text: 'Yuechuan Municipal People\'s Government', style: { fontSize: 10 } }]
          }]
        }
      ]
    }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const textContent = await (await exportedPdf.getPage(1)).getTextContent()
    const items = textContent.items.filter((item): item is typeof item & { str: string; transform: number[] } =>
      'str' in item && 'transform' in item && item.str.trim().length > 0)
    const labelParts = items.filter((item) => /Responsible|person/u.test(item.str))
    const value = items.find((item) => item.str.startsWith('Yuechuan'))
    assert.ok(labelParts.length > 0, 'adaptive table label must be exported')
    assert.ok(value, 'adaptive table value must be exported')
    // 原左列仅 60pt；英文标签必须获得足够宽度，否则会被逐字拆成多个文本项。
    assert.ok(labelParts.length <= 2, `label must wrap by words, got ${labelParts.map((item) => item.str).join('|')}`)
    assert.ok(labelParts.every((item) => !/^[A-Za-z]$/u.test(item.str)), 'single-letter text items indicate character-level wrapping')
    assert.ok((value.transform[4] ?? 0) > 40 + 70, `right column must move right for translated label: ${value.transform[4]}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 普通分隔线必须作为矢量线条导出', async () => {
  const model = documentWithText('')
  model.pages[0]!.blocks = [{
    kind: 'shape',
    blockId: 'horizontal-divider',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 40, y: 100, width: 300, height: 1 },
    line: { orientation: 'horizontal', color: '#336699', thickness: 1.5 }
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const page = await exportedPdf.getPage(1)
    const operatorList = await page.getOperatorList()
    const pathIndex = operatorList.fnArray.indexOf(pdfjs.OPS.constructPath)
    assert.ok(pathIndex >= 0)
    const pathOperations = operatorList.argsArray[pathIndex]?.[0]
    assert.ok(Array.isArray(pathOperations))
    assert.ok(pathOperations.includes(pdfjs.OPS.moveTo))
    assert.ok(pathOperations.includes(pdfjs.OPS.lineTo))
    assert.equal(pathOperations.includes(pdfjs.OPS.rectangle), false)
    const pathArguments = operatorList.argsArray[pathIndex]?.[1]
    assert.ok(Array.isArray(pathArguments))
    const horizontalYValues = pathArguments.filter((_, index) => index % 2 === 1)
    assert.ok(horizontalYValues.every((value) => typeof value === 'number'))
    assert.equal(new Set(horizontalYValues).size, 1, 'horizontal divider must have a single y coordinate')
  } finally {
    await exportedPdf.destroy()
  }
})

test('表格译文增高后下方分割线必须跟随实际底边并保留原始间距', async () => {
  const model = documentWithText('')
  model.pages[0]!.blocks = [{
    kind: 'table',
    blockId: 'table-before-divider',
    readingOrder: 0,
    translatable: true,
    bbox: { x: 40, y: 80, width: 320, height: 60 },
    columnWidths: [320],
    rows: [{
      rowId: 'table-before-divider-row',
      cells: [{
        cellId: 'table-before-divider-cell',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'text',
          blockId: 'table-before-divider-text',
          readingOrder: 0,
          translatable: true,
          role: 'paragraph',
          runs: [{
            runId: 'table-before-divider-run',
            text: 'Translated table content that must wrap across several lines. '.repeat(16),
            style: { fontSize: 12, lineHeight: 16 }
          }]
        }]
      }]
    }]
  }, {
    kind: 'shape',
    blockId: 'divider-after-table',
    readingOrder: 1,
    translatable: false,
    bbox: { x: 40, y: 160, width: 320, height: 1 },
    line: { orientation: 'horizontal', thickness: 1 }
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const page = await exportedPdf.getPage(1)
    const operatorList = await page.getOperatorList()
    const pageHeight = page.getViewport({ scale: 1 }).height
    const dividerYs: number[] = []
    for (let index = 0; index < operatorList.fnArray.length; index += 1) {
      if (operatorList.fnArray[index] !== pdfjs.OPS.constructPath) continue
      const pathOperations = operatorList.argsArray[index]?.[0]
      if (!Array.isArray(pathOperations) ||
        !pathOperations.includes(pdfjs.OPS.moveTo) ||
        !pathOperations.includes(pdfjs.OPS.lineTo) ||
        pathOperations.includes(pdfjs.OPS.rectangle)) continue
      const pathArguments = operatorList.argsArray[index]?.[1]
      if (!Array.isArray(pathArguments)) continue
      const yValues = pathArguments.filter((_, argumentIndex) => argumentIndex % 2 === 1)
      if (yValues.length > 0 && yValues.every((value) => value === yValues[0])) {
        dividerYs.push(pageHeight - Number(yValues[0]))
      }
    }
    // 表格边框本身也是 constructPath；只保留只有单一 y 坐标的水平线路径。
    assert.ok(dividerYs.length > 0, 'exported PDF must contain a horizontal divider path')
    const horizontalY = Math.max(...dividerYs)
    const sourceGap = 160 - (80 + 60)
    const tableText = await page.getTextContent()
    const tableItems = tableText.items.filter((item): item is typeof item & { transform: number[] } =>
      'str' in item && 'transform' in item && item.str.trim().length > 0)
    const tableTextBottom = Math.max(...tableItems.map((item) =>
      pageHeight - (item.transform[5] ?? 0)))
    assert.ok(horizontalY > 160 + 20,
      `divider must move below expanded table, actual y=${horizontalY}`)
    assert.ok(Math.abs(horizontalY - (tableTextBottom + sourceGap)) < 18,
      `divider must preserve original gap after expanded table: divider=${horizontalY}, textBottom=${tableTextBottom}, candidates=${dividerYs.join(',')}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 同行 logo 与文字必须保持在同一水平带并保留可复制文本', async () => {
  const model = documentWithText('')
  model.pages[0]!.blocks = [{
    kind: 'image',
    blockId: 'header-logo',
    readingOrder: 0,
    translatable: false,
    flowGroupId: 'page-1-flow-group-1',
    bbox: { x: 60, y: 50, width: 20, height: 20 },
    assetId: 'logo'
  }, {
    kind: 'text',
    blockId: 'header-company',
    readingOrder: 1,
    translatable: true,
    flowGroupId: 'page-1-flow-group-1',
    role: 'paragraph',
    bbox: { x: 90, y: 53, width: 120, height: 14 },
    runs: [{ runId: 'header-company-run', text: 'Company name', style: { fontSize: 12 } }]
  }, {
    kind: 'text',
    blockId: 'body-after-header',
    readingOrder: 2,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 60, y: 90, width: 400, height: 20 },
    runs: [{ runId: 'body-after-header-run', text: 'Body text', style: { fontSize: 12 } }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const content = await (await exportedPdf.getPage(1)).getTextContent()
    const items = content.items.filter((item): item is typeof item & { str: string; transform: number[] } =>
      'str' in item && 'transform' in item && item.str.trim().length > 0)
    const company = items.find((item) => item.str.includes('Company name'))
    const body = items.find((item) => item.str.includes('Body text'))
    assert.ok(company)
    assert.ok(body)
    assert.ok((company.transform[4] ?? 0) >= 90, `company text must stay right of logo: ${company.transform[4]}`)
    assert.ok((company.transform[5] ?? 0) > 710, `company text must remain in the header band: ${company.transform[5]}`)
    assert.ok((body.transform[5] ?? 0) < (company.transform[5] ?? 0) - 20)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 页眉分组必须使用最近内框宽度并保留文字原始纵向位置', async () => {
  const model = documentWithText('')
  model.pages[0]!.width = 595.3
  model.pages[0]!.height = 841.9
  model.pages[0]!.contentArea = { left: 132, right: 511.319, center: 321.6595 }
  model.pages[0]!.blocks = [{
    kind: 'image',
    blockId: 'header-logo',
    readingOrder: 0,
    translatable: false,
    flowGroupId: 'page-1-header-group',
    bbox: { x: 367.8, y: 42.6, width: 18.6, height: 18.6 },
    assetId: 'logo'
  }, {
    kind: 'text',
    blockId: 'header-company',
    readingOrder: 1,
    translatable: true,
    flowGroupId: 'page-1-header-group',
    role: 'paragraph',
    bbox: { x: 397.32, y: 46.13, width: 108, height: 9 },
    runs: [{ runId: 'header-company-run', text: 'Company name', style: { fontSize: 9 } }]
  }, {
    kind: 'shape',
    blockId: 'header-frame-right',
    readingOrder: 2,
    translatable: false,
    bbox: { x: 510.25, y: 42.55, width: 1, height: 24.5 },
    line: { orientation: 'vertical', thickness: 1 }
  }, {
    kind: 'shape',
    blockId: 'page-frame-right',
    readingOrder: 3,
    translatable: false,
    bbox: { x: 594.8, y: 0, width: 1, height: 841.9 },
    line: { orientation: 'vertical', thickness: 1 }
  }, {
    kind: 'shape',
    blockId: 'header-frame-top',
    readingOrder: 4,
    translatable: false,
    bbox: { x: 362.45, y: 42.05, width: 148.3, height: 1 },
    line: { orientation: 'horizontal', thickness: 1 }
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const content = await (await exportedPdf.getPage(1)).getTextContent()
    const company = content.items.find((item): item is typeof item & { str: string; transform: number[] } =>
      'str' in item && 'transform' in item && item.str.includes('Company name'))
    assert.ok(company)
    assert.ok(Math.abs((company.transform[4] ?? 0) - 397.32) < 1.5)
    assert.ok(Math.abs((company.transform[5] ?? 0) - (841.9 - 46.13 - 9)) < 1.5)
  } finally {
    await exportedPdf.destroy()
  }
})

test('表格单元格译文换行增高后必须扩展行高，后续行不能覆盖上一行', async () => {
  const model = documentWithText('')
  model.pages[0]!.blocks = [{
    kind: 'table',
    blockId: 'table-expanding-row',
    readingOrder: 0,
    translatable: true,
    bbox: { x: 40, y: 50, width: 320, height: 48 },
    columnWidths: [320],
    rows: [{
      rowId: 'table-expanding-row-first',
      cells: [{
        cellId: 'table-expanding-row-first-cell',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'text',
          blockId: 'table-expanding-row-first-text',
          readingOrder: 0,
          translatable: true,
          role: 'paragraph',
          runs: [{
            runId: 'table-expanding-row-first-run',
            text: 'Translated cell content '.repeat(24),
            style: { fontSize: 12, lineHeight: 16 }
          }]
        }]
      }]
    }, {
      rowId: 'table-expanding-row-second',
      cells: [{
        cellId: 'table-expanding-row-second-cell',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'text',
          blockId: 'table-expanding-row-second-text',
          readingOrder: 1,
          translatable: true,
          role: 'paragraph',
          runs: [{
            runId: 'table-expanding-row-second-run',
            text: 'SECOND_ROW_AFTER_WRAPPED_CELL',
            style: { fontSize: 12, lineHeight: 16 }
          }]
        }]
      }]
    }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const page = await exportedPdf.getPage(1)
    const textContent = await page.getTextContent()
    const items = textContent.items.filter((item): item is typeof item & { transform: number[] } =>
      'str' in item && 'transform' in item && item.str.trim().length > 0)
    const secondRowIndex = items.findIndex((item) => item.str === 'SECOND_ROW_AFTER_WRAPPED_CELL')
    assert.ok(secondRowIndex >= 0, 'second row text must be exported')
    const secondRow = items[secondRowIndex]!
    // 换行后的文本项不一定以首行原文开头，应按内容流顺序取第二行之前的所有非空文本。
    const wrappedRows = items.slice(0, secondRowIndex)
    assert.ok(wrappedRows.length > 1, 'first cell must wrap into multiple lines')
    const secondRowTop = page.getViewport({ scale: 1 }).height - (secondRow.transform[5] ?? page.getViewport({ scale: 1 }).height)
    const lastWrappedTop = Math.max(...wrappedRows.map((item) =>
      page.getViewport({ scale: 1 }).height - (item.transform[5] ?? page.getViewport({ scale: 1 }).height)))
    assert.ok(
      secondRowTop > lastWrappedTop + 8,
      `second row overlaps wrapped cell text: second=${secondRowTop}, lastWrapped=${lastWrappedTop}`
    )
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 导出缺少 CJK 字体时返回稳定 font-missing 错误', async () => {
  await assert.rejects(
    () => exportDocumentToPdf(documentWithText('中文内容'), {
      loadFontBytes: async () => null,
      loadAssetBytes: async () => null
    }),
    (error: unknown) => error instanceof DocumentPdfExportError && error.code === 'font-missing'
  )
})

test('PDF 导出应使用内置 CJK 字体生成包含中文的有效 PDF', async () => {
  const fontBytes = readFileSync('assets/fonts/NotoSansSC-Regular.ttf')
  const { bytes } = await exportDocumentToPdf(documentWithText('中文内容 Hello document'), {
    loadFontBytes: async () => fontBytes,
    loadAssetBytes: async () => null
  })

  assert.equal(new TextDecoder().decode(bytes.subarray(0, 5)), '%PDF-')
  assert.ok(bytes.byteLength > 10_000)
})

test('CJK 字体必须完整嵌入，避免子集在查看器中丢失中英文字形', async () => {
  const fontBytes = readFileSync('assets/fonts/NotoSansSC-Regular.ttf')
  const { bytes } = await exportDocumentToPdf(documentWithText('中文内容 Hello document'), {
    loadFontBytes: async () => fontBytes,
    loadAssetBytes: async () => null
  })
  const exported = await PDFDocument.load(bytes)
  const page = exported.getPage(0)
  const fontEntries = page.node.Resources().lookup(PDFName.of('Font'), PDFDict).entries()
  assert.ok(fontEntries.length > 0)
  const font = exported.context.lookup(fontEntries[0]![1])
  assert.ok(font instanceof PDFDict)
  const descendants = font.lookup(PDFName.of('DescendantFonts'), PDFArray)
  const cidFont = exported.context.lookup(descendants.get(0))
  assert.ok(cidFont instanceof PDFDict)
  const descriptor = exported.context.lookup(cidFont.lookup(PDFName.of('FontDescriptor')))
  assert.ok(descriptor instanceof PDFDict)
  const fontFile = descriptor.lookup(PDFName.of('FontFile2'))
  assert.ok(fontFile instanceof PDFRawStream)
  const decodedFontBytes = decodePDFRawStream(fontFile).decode()
  assert.ok(decodedFontBytes.byteLength > fontBytes.byteLength * 0.8)
})

test('中英文混排 PDF 必须保留正确的可复制文本层', async () => {
  const { bytes } = await exportDocumentToPdf(documentWithText(
    '1、admin 中新增身份源 client_id bdc_client_001 ' +
    'http://192.168.1.100:9001/auth/auu/authorize'
  ), {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => null
  })

  const text = await extractFirstPageText(bytes)
  assert.match(text, /1、admin 中新增身份源/u)
  assert.match(text, /client_id bdc_client_001/u)
  assert.match(text, /http:\/\/192\.168\.1\.100:9001\/auth\/auu\/authorize/u)
})

test('PDF 导出必须把 OCR 译文覆盖到图片对应区域并保留可检索文本', async () => {
  const model = documentWithText('OCR document')
  model.pages[0]!.blocks = [{
    kind: 'image',
    blockId: 'image-1',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 40, y: 40, width: 300, height: 200 },
    assetId: 'asset-ocr',
    ocrRegions: [{
      regionId: 'region-1',
      bbox: { x: 0.1, y: 0.2, width: 0.6, height: 0.2 },
      text: 'OCR target text',
      translatedText: 'OCR 译文内容',
      status: 'recognized'
    }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => readFileSync('tests/fixtures/ocr-scaling/clear.png')
  })
  const exported = await PDFDocument.load(bytes)
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 5)), '%PDF-')
  assert.ok(exported.getPageCount() === 1)
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const textContent = await (await exportedPdf.getPage(1)).getTextContent()
    assert.equal(textContent.items.map((item) => 'str' in item ? item.str : '').join(''), 'OCR 译文内容')
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 译文叠放图片必须共用一次纵向排版并保留真实错位与各自 OCR 译文', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.blocks = [{
    kind: 'image',
    blockId: 'stack-image-back',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 40, y: 100, width: 300, height: 240 },
    assetId: 'stack-image-back-asset',
    stackGroupId: 'stack-group-1',
    stackOrder: 0,
    ocrRegions: [{
      regionId: 'stack-region-back',
      bbox: { x: 0.1, y: 0.2, width: 0.5, height: 0.08 },
      text: 'Back source',
      translatedText: 'STACK_BACK_TRANSLATION',
      status: 'recognized'
    }]
  }, {
    kind: 'image',
    blockId: 'stack-image-front',
    readingOrder: 1,
    translatable: false,
    bbox: { x: 58, y: 124, width: 264, height: 192 },
    assetId: 'stack-image-front-asset',
    stackGroupId: 'stack-group-1',
    stackOrder: 1,
    ocrRegions: [{
      regionId: 'stack-region-front',
      bbox: { x: 0.1, y: 0.5, width: 0.5, height: 0.08 },
      text: 'Front source',
      translatedText: 'STACK_FRONT_TRANSLATION',
      status: 'recognized'
    }]
  }, {
    kind: 'text',
    blockId: 'after-image-stack',
    readingOrder: 2,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 360, width: 400, height: 20 },
    runs: [{ runId: 'after-image-stack-run', text: 'AFTER_IMAGE_STACK', style: { fontSize: 12 } }]
  }]
  model.assets = [{
    assetId: 'stack-image-back-asset',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'back',
    byteLength: 1
  }, {
    assetId: 'stack-image-front-asset',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'front',
    byteLength: 1
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => readFileSync('tests/fixtures/ocr-scaling/clear.png')
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const exportedPage = await exportedPdf.getPage(1)
    const pageHeight = exportedPage.getViewport({ scale: 1 }).height
    const content = await exportedPage.getTextContent()
    const items = content.items.filter((item): item is typeof item & { str: string; transform: number[] } =>
      'str' in item && 'transform' in item && item.str.trim().length > 0)
    const back = items.find((item) => item.str.includes('STACK_BACK_TRANSLATION'))
    const front = items.find((item) => item.str.includes('STACK_FRONT_TRANSLATION'))
    const after = items.find((item) => item.str.includes('AFTER_IMAGE_STACK'))
    assert.ok(back, '底层图片 OCR 译文必须导出')
    assert.ok(front, '上层图片 OCR 译文必须导出')
    assert.ok(after, '叠放图片后的正文必须导出')
    const backTop = pageHeight - (back.transform[5] ?? pageHeight)
    const frontTop = pageHeight - (front.transform[5] ?? pageHeight)
    const afterTop = pageHeight - (after.transform[5] ?? pageHeight)
    // 上层图片比底层图片下移 24pt，OCR 区域又分别位于各自高度的 20% 与 50%。
    // 两组位置叠加后应相差 72pt，不能为了叠放把它们强行移到同一顶部。
    assert.ok(Math.abs((frontTop - backTop) - 72) < 2,
      `叠放图片的 OCR 坐标必须保持原始相对位置，底层=${backTop}，上层=${frontTop}`)
    assert.ok(afterTop >= 335 && afterTop < 420,
      `后续正文必须从叠放组底边继续，不能把第二张图再次下推，实际顶部=${afterTop}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 图内原生文字必须覆盖在原图位置且后续正文从图片并集底边继续', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.width = 600
  page.height = 800
  page.blocks = [{
    kind: 'image',
    blockId: 'overlay-image-back',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 40, y: 100, width: 300, height: 240 },
    assetId: 'overlay-image-back-asset',
    stackGroupId: 'overlay-stack-1',
    stackOrder: 0,
    overlayGroupId: 'overlay-group-1'
  }, {
    kind: 'image',
    blockId: 'overlay-image-front',
    readingOrder: 1,
    translatable: false,
    bbox: { x: 58, y: 124, width: 264, height: 192 },
    assetId: 'overlay-image-front-asset',
    stackGroupId: 'overlay-stack-1',
    stackOrder: 1,
    overlayGroupId: 'overlay-group-1'
  }, {
    kind: 'text',
    blockId: 'overlay-native-text',
    readingOrder: 2,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 90, y: 286, width: 90, height: 16 },
    overlayGroupId: 'overlay-group-1',
    runs: [{
      runId: 'overlay-native-run',
      text: 'OVERLAY_NATIVE_TEXT_MUST_WRAP_INSIDE_IMAGE_AND_GROW_DOWNWARD',
      style: { fontSize: 12 }
    }]
  }, {
    kind: 'text',
    blockId: 'after-overlay',
    readingOrder: 3,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 380, width: 400, height: 20 },
    runs: [{ runId: 'after-overlay-run', text: 'AFTER_OVERLAY_GROUP', style: { fontSize: 12 } }]
  }]
  model.assets = [{
    assetId: 'overlay-image-back-asset',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'back',
    byteLength: 1
  }, {
    assetId: 'overlay-image-front-asset',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'front',
    byteLength: 1
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => readFileSync('tests/fixtures/ocr-scaling/clear.png')
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const exportedPage = await exportedPdf.getPage(1)
    const pageHeight = exportedPage.getViewport({ scale: 1 }).height
    const content = await exportedPage.getTextContent()
    const items = content.items.filter((item): item is typeof item & { str: string; transform: number[] } =>
      'str' in item && 'transform' in item && item.str.trim().length > 0)
    const after = items.find((item) => item.str.includes('AFTER_OVERLAY_GROUP'))
    const overlayItems = items.filter((item) => {
      // 后续正文也落在原图纵向范围内，必须从覆盖文字样本中排除，避免污染底边断言。
      if (item === after) return false
      const top = pageHeight - (item.transform[5] ?? pageHeight)
      return top >= 280 && top < 400
    })
    // 自动换行会把同一段译文拆成多个 fragment；合并后必须只出现一次，防止覆盖组重复绘制。
    const overlayText = overlayItems.map((item) => item.str).join('')
    assert.equal(overlayText.match(/OVERLAY_NATIVE_TEXT/gu)?.length, 1,
      '图内原生译文必须导出且只能绘制一次')
    assert.ok(after, '覆盖组后的正文必须导出')
    const overlayTop = Math.min(...overlayItems.map((item) => pageHeight - (item.transform[5] ?? pageHeight)))
    const afterTop = pageHeight - (after.transform[5] ?? pageHeight)
    // 文字 bbox 顶部为 286pt，必须仍落在图片内部，而不能被叠放图片底边 340pt 推到下方。
    assert.ok(overlayTop >= 280 && overlayTop < 310,
      `图内文字必须保留原覆盖位置，实际顶部=${overlayTop}`)
    // 图片并集底边为 340pt；后续正文保留自身 380pt 原始顶部。PDF.js 的文本顶部
    // 还包含基线/行盒偏移，因此允许约 12pt 的提取偏差，但不能落到覆盖文字底边之后。
    assert.ok(afterTop >= 388 && afterTop < 394,
      `后续正文必须保留原始位置，不能从长文字实际底边继续，实际顶部=${afterTop}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 同一原文行的多个图片覆盖组必须共用首个覆盖组实际顶部', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.width = 600
  page.height = 800
  page.blocks = [{
    kind: 'text',
    blockId: 'row-header',
    readingOrder: 0,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 40, width: 100, height: 10 },
    runs: [{
      runId: 'row-header-run',
      text: 'HEADER FILLER TEXT '.repeat(8),
      style: { fontSize: 12 }
    }]
  }, {
    kind: 'image',
    blockId: 'row-image-a',
    readingOrder: 1,
    translatable: false,
    bbox: { x: 40, y: 100, width: 120, height: 80 },
    assetId: 'row-image-a-asset',
    overlayGroupId: 'row-group-a'
  }, {
    kind: 'text',
    blockId: 'row-text-a',
    readingOrder: 2,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 50, y: 110, width: 100, height: 12 },
    overlayGroupId: 'row-group-a',
    runs: [{ runId: 'row-text-a-run', text: 'ROW_ONE_CARD_A', style: { fontSize: 10 } }]
  }, {
    kind: 'image',
    blockId: 'row-image-b',
    readingOrder: 3,
    translatable: false,
    bbox: { x: 180, y: 100, width: 120, height: 40 },
    assetId: 'row-image-b-asset',
    overlayGroupId: 'row-group-b'
  }, {
    kind: 'text',
    blockId: 'row-text-b',
    readingOrder: 4,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 190, y: 110, width: 100, height: 12 },
    overlayGroupId: 'row-group-b',
    runs: [{ runId: 'row-text-b-run', text: 'ROW_TWO_CARD_B', style: { fontSize: 10 } }]
  }]
  model.assets = [{
    assetId: 'row-image-a-asset',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'row-a',
    byteLength: 1
  }, {
    assetId: 'row-image-b-asset',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'row-b',
    byteLength: 1
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => readFileSync('tests/fixtures/ocr-scaling/clear.png')
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const exportedPage = await exportedPdf.getPage(1)
    const pageHeight = exportedPage.getViewport({ scale: 1 }).height
    const content = await exportedPage.getTextContent()
    const items = content.items.filter((item): item is typeof item & { str: string; transform: number[] } =>
      'str' in item && 'transform' in item && item.str.trim().length > 0)
    const cardA = items.find((item) => item.str.includes('ROW_ONE_CARD_A'))
    const cardB = items.find((item) => item.str.includes('ROW_TWO_CARD_B'))
    assert.ok(cardA, '首个覆盖组文字必须导出')
    assert.ok(cardB, '同行第二个覆盖组文字必须导出')
    const topA = pageHeight - (cardA.transform[5] ?? pageHeight)
    const topB = pageHeight - (cardB.transform[5] ?? pageHeight)
    assert.ok(Math.abs(topA - topB) < 2,
      `同一原文行的覆盖组必须共用实际顶部，首个=${topA}，第二个=${topB}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 图片覆盖组必须先铺完全部底图再统一绘制 OCR 译文', () => {
  const source = readFileSync('src/main/documentPdfExport.ts', 'utf8')
  const start = source.indexOf('async function drawImageOverlayGroup(')
  const end = source.indexOf('/**', start + 1)
  const overlaySource = source.slice(start, end)
  const firstPass = /for \(const entry of positionedImages\)[\s\S]*?drawImageBlock\([\s\S]*?false\s*\)/u
  const secondPass = /for \(const entry of positionedImages\)[\s\S]*?drawOcrRegions\(/u

  assert.match(overlaySource, /const positionedImages = orderedImages\.map/u)
  assert.match(overlaySource, firstPass,
    '覆盖组第一轮只能绘制底图，不能在下一张底图之前绘制当前图片的 OCR 译文')
  assert.match(overlaySource, secondPass,
    '覆盖组第二轮必须基于同一份换算坐标统一绘制 OCR 译文')
  assert.match(overlaySource, /drawImageOverlayText\(/u,
    '图内原生文字必须使用带 bbox 裁切的专用绘制流程')
  assert.doesNotMatch(overlaySource, /textBottom/u,
    '图内原生文字实际底边不能扩展覆盖组或后续正文起点')

  const overlayTextStart = source.indexOf('function drawImageOverlayText(')
  const overlayTextEnd = source.indexOf('/**', overlayTextStart + 1)
  const overlayTextSource = source.slice(overlayTextStart, overlayTextEnd)
  assert.doesNotMatch(overlayTextSource, /clip\(\)/u,
    '图内原生文字不能被原始 bbox 裁切，否则多行译文每行都会被截断')
  assert.match(overlayTextSource, /drawTextBlock\(/u,
    '图内原生文字必须复用文字绘制流程')
})

test('OCR 原文双层 PDF 必须写入图片对应位置的透明可复制文字层', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.width = 600
  page.height = 800
  page.blocks = [{
    kind: 'image',
    blockId: 'ocr-source-page',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 50, y: 80, width: 500, height: 640 },
    assetId: 'ocr-source-asset',
    ocrRegions: [{
      regionId: 'ocr-source-region',
      pageId: page.pageId,
      blockId: 'ocr-source-page',
      assetId: 'ocr-source-asset',
      bbox: { x: 0.2, y: 0.25, width: 0.3, height: 0.08 },
      text: 'OCR_LAYER_COORDINATE_CHECK',
      status: 'recognized'
    }]
  }]
  model.assets = [{
    assetId: 'ocr-source-asset',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'fixture',
    byteLength: 9364
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => readFileSync('tests/fixtures/ocr-scaling/clear.png')
  }, { includeOcrTextLayer: true })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const content = await (await exportedPdf.getPage(1)).getTextContent()
    const item = content.items.find((candidate) => (
      'str' in candidate && candidate.str.includes('OCR_LAYER_COORDINATE_CHECK')
    ))
    assert.ok(item && 'transform' in item, 'OCR 原文必须生成可被 PDF.js 提取的文本对象')
    const transform = item.transform as number[]
    const x = transform[4] ?? 0
    const top = page.height - (transform[5] ?? page.height)
    // 区域横坐标应为 50 + 0.2 * 500 = 150；纵坐标应为 80 + 0.25 * 640 = 240。
    assert.ok(x >= 150 && x < 310, `OCR 文字层 X 坐标错误: ${x}`)
    assert.ok(top >= 240 && top < 310, `OCR 文字层 Y 坐标错误: ${top}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('整页扫描图 OCR 原文文字层必须按页面坐标定位且不能额外换页', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.width = 594.95996
  page.height = 841.91998
  page.blocks = [{
    kind: 'image',
    blockId: 'full-page-scan',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 0, y: 0, width: page.width, height: page.height },
    assetId: 'full-page-scan-asset',
    ocrRegions: [{
      regionId: 'full-page-scan-region',
      pageId: page.pageId,
      blockId: 'full-page-scan',
      assetId: 'full-page-scan-asset',
      bbox: { x: 0.3, y: 0.4, width: 0.2, height: 0.05 },
      text: 'FULL_PAGE_OCR_COORDINATE_CHECK',
      status: 'recognized'
    }]
  }]
  model.assets = [{
    assetId: 'full-page-scan-asset',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'fixture',
    byteLength: 9364
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => readFileSync('tests/fixtures/ocr-scaling/clear.png')
  }, { includeOcrTextLayer: true })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    assert.equal(exportedPdf.numPages, 1)
    const content = await (await exportedPdf.getPage(1)).getTextContent()
    const item = content.items.find((candidate) => (
      'str' in candidate && candidate.str.includes('FULL_PAGE_OCR_COORDINATE_CHECK')
    ))
    assert.ok(item && 'transform' in item, '整页 OCR 原文必须生成可提取的文本对象')
    const transform = item.transform as number[]
    const x = transform[4] ?? 0
    const top = page.height - (transform[5] ?? page.height)
    assert.ok(Math.abs(x - page.width * 0.3) < 5, `OCR 文字层 X 坐标错误: ${x}`)
    // PDF.js 的文本 transform 以基线为原点；区域顶部到基线还包含约 2pt 内边距和 12pt 字号。
    assert.ok(
      top > page.height * 0.4 && top < page.height * 0.4 + 20,
      `OCR 文字层 Y 坐标错误: ${top}`
    )
    assert.ok(x > page.width * 0.2, 'OCR 文字层不能缩放到左上角')
    assert.ok(top > page.height * 0.3, 'OCR 文字层不能缩放到左上角')
  } finally {
    await exportedPdf.destroy()
  }
})

test('表格单元格内嵌图片的 OCR 原文文字层必须按图片坐标定位', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  const imageBox = { x: 280, y: 180, width: 220, height: 120 }
  page.blocks = [{
    kind: 'table',
    blockId: 'table-with-ocr-image',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 40, y: 50, width: 460, height: 300 },
    columnWidths: [220, 240],
    headerRows: 1,
    rows: [{
      rowId: 'table-with-ocr-image-row',
      cells: [{
        cellId: 'table-with-ocr-image-label-cell',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'text',
          blockId: 'table-with-ocr-image-label',
          readingOrder: 0,
          translatable: false,
          role: 'paragraph',
          runs: [{ runId: 'table-with-ocr-image-label-run', text: 'Embedded image', style: { fontSize: 12 } }]
        }]
      }, {
        cellId: 'table-with-ocr-image-cell',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'image',
          blockId: 'table-with-ocr-image',
          readingOrder: 1,
          translatable: false,
          bbox: imageBox,
          assetId: 'table-with-ocr-image-asset',
          ocrRegions: [{
            regionId: 'table-with-ocr-image-region',
            pageId: page.pageId,
            blockId: 'table-with-ocr-image',
            assetId: 'table-with-ocr-image-asset',
            bbox: { x: 0.2, y: 0.25, width: 0.5, height: 0.2 },
            text: 'TABLE_CELL_OCR_COORDINATE_CHECK',
            status: 'recognized'
          }]
        }]
      }]
    }]
  }]
  model.assets = [{
    assetId: 'table-with-ocr-image-asset',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'fixture',
    byteLength: 9364
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => readFileSync('tests/fixtures/ocr-scaling/clear.png')
  }, { includeOcrTextLayer: true })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const content = await (await exportedPdf.getPage(1)).getTextContent()
    const extractedText = content.items
      .flatMap((candidate) => 'str' in candidate ? [candidate.str] : [])
      .join('')
      .replaceAll(/\s+/gu, '')
    assert.match(extractedText, /TABLE_CELL_OCR_COORDINATE_CHECK/u, '表格单元格图片必须生成可提取的 OCR 原文文字层')
    const item = content.items.find((candidate) => (
      'str' in candidate && 'transform' in candidate && candidate.str.includes('TABLE')
    ))
    assert.ok(item && 'transform' in item, '表格单元格图片必须生成可定位的 OCR 原文文字层')
    const transform = item.transform as number[]
    const x = transform[4] ?? 0
    const top = page.height - (transform[5] ?? page.height)
    assert.ok(x > 0 && top > 0, '表格图片 OCR 文字层不能缩放到左上角')
    // 表格会按单元格可用宽度重新排版图片；文字层应位于图片所在的第二列和表格纵向范围内。
    assert.ok(x >= 240 && x <= 500, `OCR 文字层 X 必须位于图片所在的表格单元格内: ${x}`)
    assert.ok(top >= 50 && top <= 350, `OCR 文字层 Y 必须位于表格区域内: ${top}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('OCR 原文导出必须保留原始 PDF 页面并只在对应图片区域追加透明文字层', async () => {
  const sourceDocument = await PDFDocument.create()
  const sourcePage = sourceDocument.addPage([600, 800])
  sourcePage.drawText('ORIGINAL_NATIVE_TEXT', {
    x: 72,
    y: 700,
    size: 14
  })
  const sourcePdfBytes = await sourceDocument.save()

  const model = documentWithText('')
  model.source = {
    ...model.source,
    fileName: 'scan.pdf',
    format: 'pdf',
    pageCount: 1
  }
  const firstPage = model.pages[0]!
  firstPage.width = 600
  firstPage.height = 800
  firstPage.blocks = [{
    kind: 'image',
    blockId: 'source-scan-image',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 50, y: 80, width: 500, height: 640 },
    assetId: 'source-scan-asset',
    ocrRegions: [{
      regionId: 'source-scan-region',
      pageId: firstPage.pageId,
      blockId: 'source-scan-image',
      assetId: 'source-scan-asset',
      bbox: { x: 0.2, y: 0.25, width: 0.3, height: 0.08 },
      text: 'SOURCE_PDF_OCR_LAYER_CHECK',
      status: 'recognized'
    }]
  }]
  // 模拟解析模型被错误拆分出的额外页面；源 PDF 仍只有一页，导出不得重排或新增页面。
  model.pages.push({
    pageId: 'unexpected-extra-page',
    index: 1,
    width: 600,
    height: 800,
    blocks: [{
      kind: 'text',
      blockId: 'unexpected-extra-text',
      readingOrder: 0,
      translatable: false,
      role: 'paragraph',
      runs: [{ runId: 'unexpected-extra-run', text: 'MUST_NOT_BE_RENDERED' }]
    }]
  })
  model.assets = [{
    assetId: 'source-scan-asset',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'fixture',
    byteLength: 9364
  }]

  const result = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => readFileSync('tests/fixtures/ocr-scaling/clear.png'),
    sourcePdfBytes
  }, { includeOcrTextLayer: true })

  const exportedPdf = await pdfjs.getDocument({
    data: result.bytes,
    isEvalSupported: false,
    verbosity: 0
  }).promise
  try {
    assert.equal(exportedPdf.numPages, 1)
    const page = await exportedPdf.getPage(1)
    const viewport = page.getViewport({ scale: 1 })
    assert.ok(Math.abs(viewport.width - 600) < 0.01)
    assert.ok(Math.abs(viewport.height - 800) < 0.01)
    const content = await page.getTextContent()
    const text = content.items.map((item) => 'str' in item ? item.str : '').join('')
    assert.match(text, /ORIGINAL_NATIVE_TEXT/u)
    assert.match(text, /SOURCE_PDF_OCR_LAYER_CHECK/u)
    assert.doesNotMatch(text, /MUST_NOT_BE_RENDERED/u)

    const item = content.items.find((candidate) => (
      'str' in candidate && candidate.str.includes('SOURCE_PDF_OCR_LAYER_CHECK')
    ))
    assert.ok(item && 'transform' in item, 'OCR 原文必须生成可提取的透明文本对象')
    const transform = item.transform as number[]
    const x = transform[4] ?? 0
    const top = viewport.height - (transform[5] ?? viewport.height)
    assert.ok(Math.abs(x - 150) < 5, `OCR 文字层 X 坐标错误: ${x}`)
    assert.ok(top >= 240 && top < 260, `OCR 文字层 Y 坐标错误: ${top}`)
    assert.ok(result.warnings.some((warning) => warning.code === 'ocr-source-page-count-mismatch'))
  } finally {
    await exportedPdf.destroy()
  }
})

test('OCR 原文源 PDF 没有可写入文字层时必须返回明确告警', async () => {
  const sourceDocument = await PDFDocument.create()
  const sourcePage = sourceDocument.addPage([600, 800])
  sourcePage.drawText('ORIGINAL_PAGE', { x: 72, y: 700, size: 14 })
  const sourcePdfBytes = await sourceDocument.save()
  const model = documentWithText('')
  model.pages[0]!.width = 600
  model.pages[0]!.height = 800
  model.pages[0]!.blocks = [{
    kind: 'image',
    blockId: 'empty-ocr-image',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 40, y: 40, width: 300, height: 200 },
    assetId: 'empty-ocr-asset',
    ocrRegions: [{
      regionId: 'empty-ocr-region',
      pageId: model.pages[0]!.pageId,
      blockId: 'empty-ocr-image',
      assetId: 'empty-ocr-asset',
      bbox: { x: 0, y: 0, width: 1, height: 1 },
      text: '',
      status: 'failed',
      reason: 'ocr-failed'
    }]
  }]

  const result = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null,
    sourcePdfBytes
  }, { includeOcrTextLayer: true })

  assert.ok(result.warnings.some((warning) => warning.code === 'ocr-source-text-layer-empty'))
})

test('OCR 原文导出遇到旋转页面时必须跳过文字层并返回受控告警', async () => {
  const sourceDocument = await PDFDocument.create()
  const sourcePage = sourceDocument.addPage([600, 800])
  sourcePage.setRotation({ type: 'degrees', angle: 90 })
  const sourcePdfBytes = await sourceDocument.save()
  const model = documentWithText('')
  const page = model.pages[0]!
  page.width = 600
  page.height = 800
  page.blocks = [{
    kind: 'image',
    blockId: 'rotated-image',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 50, y: 80, width: 500, height: 640 },
    assetId: 'rotated-asset',
    ocrRegions: [{
      regionId: 'rotated-region',
      pageId: page.pageId,
      blockId: 'rotated-image',
      assetId: 'rotated-asset',
      bbox: { x: 0.2, y: 0.25, width: 0.3, height: 0.08 },
      text: 'ROTATED_OCR_MUST_NOT_BE_MISPLACED',
      status: 'recognized'
    }]
  }]

  const result = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null,
    sourcePdfBytes
  }, { includeOcrTextLayer: true })
  const exportedPdf = await pdfjs.getDocument({
    data: result.bytes,
    isEvalSupported: false,
    verbosity: 0
  }).promise
  try {
    assert.equal(exportedPdf.numPages, 1)
    const content = await (await exportedPdf.getPage(1)).getTextContent()
    assert.ok(content.items.every((item) => !('str' in item) || !item.str.includes('ROTATED_OCR_MUST_NOT_BE_MISPLACED')))
    assert.ok(result.warnings.some((warning) => warning.code === 'ocr-source-rotated-page'))
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 导出必须统一 OCR 译文字号并保留对齐方式', async () => {
  const model = documentWithText('OCR document')
  model.pages[0]!.blocks = [{
    kind: 'image',
    blockId: 'image-aligned',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 40, y: 40, width: 300, height: 200 },
    assetId: 'asset-aligned',
    ocrRegions: [{
      regionId: 'region-aligned',
      bbox: { x: 0.1, y: 0.2, width: 0.6, height: 0.3 },
      text: 'OCR target text',
      translatedText: 'Centered OCR',
      status: 'recognized',
      textAlign: 'center',
      style: { fontSize: 24, color: '#123456', fontWeight: 700 }
    }, {
      regionId: 'region-right-aligned',
      bbox: { x: 0.1, y: 0.6, width: 0.6, height: 0.08 },
      text: 'OCR right target text',
      translatedText: 'Right OCR',
      status: 'recognized',
      textAlign: 'right',
      style: { fontSize: 8 }
    }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => readFileSync('tests/fixtures/ocr-scaling/clear.png')
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const textContent = await (await exportedPdf.getPage(1)).getTextContent()
    const centeredItem = textContent.items.find((candidate) => 'str' in candidate && candidate.str === 'Centered OCR')
    assert.ok(centeredItem && 'transform' in centeredItem)
    const centeredTransform = centeredItem.transform as number[]
    const centeredFontSize = Math.hypot(centeredTransform[2] ?? 0, centeredTransform[3] ?? 0)
    assert.ok(Math.abs(centeredFontSize - DOCUMENT_OCR_UNIFORM_FONT_SIZE) < 1)
    // 区域范围是 x=70..250；文本宽度约 156.8，居中后起点应接近 81.6。
    const textWidth = 'width' in centeredItem ? Number(centeredItem.width) : 0
    const expectedX = 70 + (180 - textWidth) / 2
    assert.ok(Math.abs((centeredTransform[4] ?? 0) - expectedX) < 2)

    const rightItem = textContent.items.find((candidate) => 'str' in candidate && candidate.str === 'Right OCR')
    assert.ok(rightItem && 'transform' in rightItem)
    const rightTransform = rightItem.transform as number[]
    const rightFontSize = Math.hypot(rightTransform[2] ?? 0, rightTransform[3] ?? 0)
    assert.ok(Math.abs(rightFontSize - DOCUMENT_OCR_UNIFORM_FONT_SIZE) < 1)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 导出缺少 OCR 字号时必须使用可读默认字号而不是按整页高度放大', async () => {
  const model = documentWithText('OCR document')
  model.pages[0]!.blocks = [{
    kind: 'image',
    blockId: 'image-fallback-font',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 40, y: 40, width: 300, height: 700 },
    assetId: 'asset-fallback-font',
    ocrRegions: [{
      regionId: 'region-fallback-font',
      bbox: { x: 0, y: 0, width: 1, height: 1 },
      text: 'OCR target text',
      translatedText: 'Fallback OCR font',
      status: 'recognized'
    }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => readFileSync('tests/fixtures/ocr-scaling/clear.png')
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const textContent = await (await exportedPdf.getPage(1)).getTextContent()
    const item = textContent.items.find((candidate) => 'str' in candidate && candidate.str.includes('Fallback'))
    assert.ok(item && 'transform' in item)
    const transform = item.transform as number[]
    const fontSize = Math.hypot(transform[2] ?? 0, transform[3] ?? 0)
    assert.ok(Math.abs(fontSize - 12) < 1)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 导出必须按原生文本区块的对齐方式绘制译文', async () => {
  const model = documentWithText('Centered native text')
  const block = model.pages[0]!.blocks[0]
  assert.equal(block.kind, 'text')
  if (block.kind !== 'text') return
  block.textAlign = 'center'
  block.bbox = { x: 40, y: 50, width: 500, height: 80 }

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const textContent = await (await exportedPdf.getPage(1)).getTextContent()
    const item = textContent.items.find((candidate) => 'str' in candidate && candidate.str === 'Centered native text')
    assert.ok(item && 'transform' in item)
    const transform = item.transform as number[]
    const textWidth = 'width' in item ? Number(item.width) : 0
    const expectedCenter = 40 + 500 / 2
    const actualCenter = (transform[4] ?? 0) + textWidth / 2
    assert.ok(Math.abs(actualCenter - expectedCenter) < 2)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 导出左对齐长译文必须保留原文正文区右侧页边距', async () => {
  const model = documentWithText(
    'This translated paragraph is intentionally long enough to reach the right side of the original content area while still needing several wrapped lines.'
  )
  const block = model.pages[0]!.blocks[0]
  assert.equal(block.kind, 'text')
  if (block.kind !== 'text') return
  block.bbox = { x: 72, y: 50, width: 120, height: 14 }
  model.pages[0]!.contentArea = { left: 72, right: 540, center: 306 }

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const textContent = await (await exportedPdf.getPage(1)).getTextContent()
    const items = textContent.items.filter((item): item is typeof item & { transform: number[]; width: number } =>
      'str' in item && 'transform' in item && 'width' in item && item.str.trim().length > 0)
    assert.ok(items.length > 1, '长译文必须换行')
    const rightmost = Math.max(...items.map((item) => (item.transform[4] ?? 0) + item.width))
    assert.ok(rightmost <= 541, `译文不得越过正文区右边界：${rightmost}`)
    assert.ok(rightmost > 500, `译文应充分利用正文区宽度，不能缩回原文短行宽度：${rightmost}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 导出居中短标题译文应扩展到正文区宽度并保持原中心线', async () => {
  const model = documentWithText('Measures for the Administration of Electronic Archives')
  const block = model.pages[0]!.blocks[0]
  assert.equal(block.kind, 'text')
  if (block.kind !== 'text') return
  block.textAlign = 'center'
  block.bbox = { x: 255, y: 50, width: 90, height: 20 }
  block.runs[0]!.style = { fontSize: 16, lineHeight: 22 }
  model.pages[0]!.contentArea = { left: 72, right: 540, center: 306 }

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const textContent = await (await exportedPdf.getPage(1)).getTextContent()
    const items = textContent.items.filter((item): item is typeof item & { transform: number[]; width: number } =>
      'str' in item && 'transform' in item && 'width' in item && item.str.trim().length > 0)
    const left = Math.min(...items.map((item) => item.transform[4] ?? 0))
    const right = Math.max(...items.map((item) => (item.transform[4] ?? 0) + item.width))
    assert.ok(items.length <= 2, `译文应利用正文区宽度，而不是按中文短标题宽度提前换行：${items.length} 行`)
    assert.ok(right - left > 300, `居中标题译文应扩展到正文区宽度：${right - left}`)
    assert.ok(Math.abs((left + right) / 2 - 300) < 2, `居中标题不得改变原文中心线：${(left + right) / 2}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 导出多片段居中文本时必须按整行宽度定位，不能逐个片段重复居中', async () => {
  const model = documentWithText('')
  const block = model.pages[0]!.blocks[0]
  assert.equal(block.kind, 'text')
  if (block.kind !== 'text') return
  block.textAlign = 'center'
  block.bbox = { x: 40, y: 50, width: 500, height: 80 }
  block.runs = [
    { runId: 'run-a', text: 'Centered ', style: { fontSize: 20 } },
    { runId: 'run-b', text: 'heading', style: { fontSize: 20, fontWeight: 700 } }
  ]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const textContent = await (await exportedPdf.getPage(1)).getTextContent()
    const items = textContent.items.filter((item): item is typeof item & { transform: number[] } =>
      'str' in item && 'transform' in item && item.str.trim().length > 0)
    assert.equal(items.length, 2)
    const left = items[0]!.transform[4] ?? 0
    const rightItem = items[1]!
    const right = (rightItem.transform[4] ?? 0) + ('width' in rightItem ? Number(rightItem.width) : 0)
    assert.ok(Math.abs((left + right) / 2 - 290) < 2, `combined text center ${(left + right) / 2}`)
    assert.ok(left > 200, `second fragment must continue after the first instead of restarting at the center: ${left}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 目录导出必须让标题自然换行且页码只在最后一行右侧出现一次', async () => {
  const model = documentWithText('')
  model.pages[0]!.blocks = [{
    kind: 'text',
    blockId: 'toc-block',
    readingOrder: 0,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 90, y: 50, width: 415.27, height: 14 },
    toc: { pageNumber: '12' },
    runs: [
      {
        runId: 'toc-title',
        text: '2.1.3. This is a translated table of contents title that must wrap naturally without moving the page number into its own line',
        style: { fontSize: 12, lineHeight: 18 }
      },
      { runId: 'toc-leader', text: '.............................................................', protected: true },
      { runId: 'toc-page', text: '12', protected: true }
    ]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const textContent = await (await exportedPdf.getPage(1)).getTextContent()
    const items = textContent.items.filter((item): item is typeof item & { str: string; transform: number[]; width: number } =>
      'str' in item && 'transform' in item && 'width' in item && item.str.trim().length > 0)
    const pageItems = items.filter((item) => item.str.trim() === '12')
    assert.equal(pageItems.length, 1, `目录页码只能出现一次：${items.map((item) => item.str).join('|')}`)
    const pageItem = pageItems[0]!
    assert.ok(Math.abs((pageItem.transform[4] ?? 0) + pageItem.width - 505.27) < 2)

    const titleItems = items.filter((item) => item !== pageItem && /[A-Za-z]/u.test(item.str))
    assert.ok(titleItems.length > 1, '长目录标题必须换行')
    const lastTitle = titleItems.reduce((bottom, item) =>
      (item.transform[5] ?? 0) < (bottom.transform[5] ?? 0) ? item : bottom)
    assert.ok(Math.abs((lastTitle.transform[5] ?? 0) - (pageItem.transform[5] ?? 0)) < 1)
    assert.ok(items.every((item) => !/^\.{6,}$/u.test(item.str)), '引导点应绘制为矢量线，不能生成额外文本行')
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 导出必须同时保留右对齐、字号、颜色与粗体', async () => {
  const model = documentWithText('Right aligned heading')
  const block = model.pages[0]!.blocks[0]
  assert.equal(block.kind, 'text')
  if (block.kind !== 'text') return
  block.textAlign = 'right'
  block.bbox = { x: 40, y: 50, width: 500, height: 80 }
  block.runs[0]!.style = { fontSize: 28, color: '#123456', fontWeight: 700 }

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const textContent = await (await exportedPdf.getPage(1)).getTextContent()
    const item = textContent.items.find((candidate) => 'str' in candidate && candidate.str === 'Right aligned heading')
    assert.ok(item && 'transform' in item)
    const transform = item.transform as number[]
    const textWidth = 'width' in item ? Number(item.width) : 0
    const fontSize = Math.hypot(transform[2] ?? 0, transform[3] ?? 0)
    assert.ok(Math.abs(fontSize - 28) < 1)
    assert.ok(Math.abs((transform[4] ?? 0) + textWidth - 540) < 2)
    // PDF.js 在操作符列表解析完成前只暴露通用 fallback 字体族，需在字体对象就绪后核对真实 BaseFont。
    await (await exportedPdf.getPage(1)).getOperatorList()
    const font = (await exportedPdf.getPage(1)).commonObjs.get(item.fontName) as {
      name?: string
      bold?: boolean
    }
    assert.equal(font.bold, true)
    assert.equal(font.name, 'Helvetica-Bold')
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 导出必须使用以点为单位的多行行高，并允许译文超出原单行 bbox 高度', async () => {
  const model = documentWithText('A translated line that must wrap into several lines without being clipped by the original single-line bbox.')
  const block = model.pages[0]!.blocks[0]
  assert.equal(block.kind, 'text')
  if (block.kind !== 'text') return
  block.bbox = { x: 40, y: 50, width: 120, height: 14 }
  block.runs[0]!.style = { fontSize: 12, lineHeight: 18 }

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const textContent = await (await exportedPdf.getPage(1)).getTextContent()
    const items = textContent.items.filter((item) => 'str' in item && item.str.length > 0)
    assert.ok(items.length > 1)
    const baselines = items
      .filter((item): item is typeof item & { transform: number[] } => 'transform' in item)
      .map((item) => item.transform[5] ?? 0)
      .sort((left, right) => right - left)
    for (let index = 1; index < baselines.length; index += 1) {
      assert.ok(Math.abs((baselines[index - 1]! - baselines[index]!) - 18) < 1)
    }
  } finally {
    await exportedPdf.destroy()
  }
})

test('OCR 中文译文必须触发 CJK 字体判定', async () => {
  const model = documentWithText('English document')
  model.pages[0]!.blocks = [{
    kind: 'image',
    blockId: 'image-cjk',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 40, y: 40, width: 300, height: 200 },
    assetId: 'asset-cjk',
    ocrRegions: [{
      regionId: 'region-cjk',
      bbox: { x: 0.1, y: 0.2, width: 0.6, height: 0.2 },
      text: 'English OCR text',
      translatedText: 'OCR 中文译文',
      status: 'recognized'
    }]
  }]

  await assert.rejects(
    () => exportDocumentToPdf(model, {
      loadFontBytes: async () => null,
      loadAssetBytes: async () => readFileSync('tests/fixtures/ocr-scaling/clear.png')
    }),
    (error: unknown) => error instanceof DocumentPdfExportError && error.code === 'font-missing'
  )
})

test('PDF 导出遇到无效图片资源时保留页面并输出占位内容', async () => {
  const model = documentWithText('Fallback document')
  model.pages[0]!.blocks = [{
    kind: 'image',
    blockId: 'image-missing',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 40, y: 40, width: 300, height: 200 },
    assetId: 'missing-asset'
  }]

  const result = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const bytes = result.bytes
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 5)), '%PDF-')
  assert.deepEqual(result.warnings, [{
    code: 'image-asset-unavailable',
    severity: 'warning',
    message: 'An image asset could not be embedded and was replaced with a placeholder.',
    pageId: 'page-1',
    blockId: 'image-missing'
  }])
})

test('图片资源缺失时仍必须导出 OCR 译文并保留可检索文本', async () => {
  const model = documentWithText('English document')
  model.pages[0]!.blocks = [{
    kind: 'image',
    blockId: 'image-missing-ocr',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 40, y: 40, width: 300, height: 200 },
    assetId: 'missing-ocr-asset',
    ocrRegions: [{
      regionId: 'region-missing-ocr',
      bbox: { x: 0.1, y: 0.2, width: 0.6, height: 0.2 },
      text: 'OCR source text',
      translatedText: '缺失图片 OCR 译文',
      status: 'recognized'
    }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const textContent = await (await exportedPdf.getPage(1)).getTextContent()
    const text = textContent.items.map((item) => 'str' in item ? item.str : '').join('')
    assert.match(text, /缺失图片 OCR 译文|缺失图片 OCR译文/u)
  } finally {
    await exportedPdf.destroy()
  }
})

test('OCR 译文超出原区域时必须扩展绘制且保留完整可检索文本，不得裁切', async () => {
  const model = documentWithText('English document')
  const translatedText = '这是一段明显超过单行宽度的 OCR 译文，用于验证导出时不会横向溢出图片区域。'.repeat(12)
  model.pages[0]!.blocks = [{
    kind: 'image',
    blockId: 'image-overflow',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 40, y: 40, width: 300, height: 200 },
    assetId: 'asset-overflow',
    ocrRegions: [{
      regionId: 'region-overflow',
      bbox: { x: 0.1, y: 0.2, width: 0.2, height: 0.08 },
      text: 'Overflow source',
      translatedText,
      status: 'recognized'
    }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => readFileSync('tests/fixtures/ocr-scaling/clear.png')
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const page = await exportedPdf.getPage(1)
    const pageHeight = page.getViewport({ scale: 1 }).height
    const textContent = await page.getTextContent()
    const textItems = textContent.items.filter((item): item is typeof item & { str: string; transform: number[] } =>
      'str' in item && 'transform' in item && item.str.trim().length > 0)
    const text = textItems.map((item) => item.str).join('')
    assert.match(text, /这是一段明显超过单行宽度的 OCR 译文/u)
    assert.ok(textItems.length > 1, 'OCR translation must wrap into multiple lines')
    assert.ok(text.length > translatedText.length * 0.95)
    assert.doesNotMatch(text, /\.\.\.|…/u)
    const tops = textItems
      .map((item) => pageHeight - (item.transform[5] ?? pageHeight))
      .sort((left, right) => left - right)
    for (let index = 1; index < tops.length; index += 1) {
      assert.ok(
        tops[index]! - tops[index - 1]! >= 4,
        `OCR translation lines overlap: ${tops[index - 1]} -> ${tops[index]}`
      )
    }
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF OCR 白底必须按每行译文宽度绘制，不能沿用原文识别框宽度', async () => {
  const source = readFileSync('src/main/documentPdfExport.ts', 'utf8')

  assert.match(
    source,
    /const lineWidth = Math\.min\(availableWidth, font\.widthOfTextAtSize\(line, fontSize\)\)[\s\S]*?context\.page\.drawRectangle\(\{[\s\S]*?width: Math\.min\(regionWidth, lineWidth \+ padding\.x \* 2\)/u,
    'OCR 白底必须按当前译文行的实际文字宽度绘制，不能固定为原文识别框宽度'
  )
})

test('PDF 中相邻 OCR 译文变高后必须顺延，不能覆盖后续 OCR 行', async () => {
  const model = documentWithText('English document')
  model.pages[0]!.blocks = [{
    kind: 'image',
    blockId: 'image-ocr-stacking',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 40, y: 40, width: 300, height: 300 },
    assetId: 'asset-ocr-stacking',
    ocrRegions: [{
      regionId: 'region-first',
      bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
      text: 'First source line',
      translatedText: `FIRST_OCR ${'A'.repeat(360)}`,
      status: 'recognized'
    }, {
      regionId: 'region-second',
      bbox: { x: 0.1, y: 0.2, width: 0.4, height: 0.05 },
      text: 'Second source line',
      translatedText: 'SECOND_OCR_MARKER',
      status: 'recognized'
    }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => readFileSync('tests/fixtures/ocr-scaling/clear.png')
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const page = await exportedPdf.getPage(1)
    const pageHeight = page.getViewport({ scale: 1 }).height
    const content = await page.getTextContent()
    const items = content.items.filter((item): item is typeof item & { str: string; transform: number[] } =>
      'str' in item && 'transform' in item && item.str.trim().length > 0)
    const second = items.find((item) => item.str === 'SECOND_OCR_MARKER')
    const firstTops = items
      .filter((item) => item.str.startsWith('FIRST_OCR') || /^A+$/u.test(item.str))
      .map((item) => pageHeight - (item.transform[5] ?? pageHeight))
    assert.ok(second, 'second OCR translation must be exported')
    assert.ok(firstTops.length > 2, 'first OCR translation must wrap to multiple lines')
    const secondTop = pageHeight - (second.transform[5] ?? pageHeight)
    assert.ok(
      secondTop > Math.max(...firstTops) + 8,
      `second OCR line overlaps first translation: second=${secondTop}, first=${Math.max(...firstTops)}`
    )
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 中前序 OCR 译文变短后，后续区域仍必须锚定原文顶部', async () => {
  const model = documentWithText('English document')
  model.pages[0]!.blocks = [{
    kind: 'image',
    blockId: 'image-ocr-compact-flow',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 40, y: 40, width: 300, height: 300 },
    assetId: 'asset-ocr-compact-flow',
    ocrRegions: [{
      regionId: 'region-compact-first',
      bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
      text: 'First source line',
      translatedText: 'FIRST_COMPACT_MARKER',
      status: 'recognized',
      style: { fontSize: 12 }
    }, {
      regionId: 'region-compact-second',
      bbox: { x: 0.1, y: 0.4, width: 0.4, height: 0.05 },
      text: 'Second source line',
      translatedText: 'SECOND_COMPACT_MARKER',
      status: 'recognized',
      style: { fontSize: 12 }
    }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => readFileSync('tests/fixtures/ocr-scaling/clear.png')
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const page = await exportedPdf.getPage(1)
    const pageHeight = page.getViewport({ scale: 1 }).height
    const content = await page.getTextContent()
    const items = content.items.filter((item): item is typeof item & { str: string; transform: number[] } =>
      'str' in item && 'transform' in item && item.str.trim().length > 0)
    const first = items.find((item) => item.str === 'FIRST_COMPACT_MARKER')
    const second = items.find((item) => item.str === 'SECOND_COMPACT_MARKER')
    assert.ok(first, 'first OCR translation must be exported')
    assert.ok(second, 'second OCR translation must be exported')
    const firstTop = pageHeight - (first.transform[5] ?? pageHeight)
    const secondTop = pageHeight - (second.transform[5] ?? pageHeight)
    // 首条译文短于原区域时，第二条仍应回到自己的原文坐标，不能紧贴首条译文底边。
    assert.ok(
      Math.abs(secondTop - 172.9) < 2,
      `second OCR must retain source top: first=${firstTop}, second=${secondTop}`
    )
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 扫描页同排左右列 OCR 译文必须保持原始二维位置，不能被左列高度推到下方', async () => {
  const model = documentWithText('English document')
  model.pages[0]!.blocks = [{
    kind: 'image',
    blockId: 'image-ocr-columns',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 40, y: 40, width: 400, height: 400 },
    assetId: 'asset-ocr-columns',
    ocrRegions: [{
      regionId: 'ocr-left-column',
      bbox: { x: 0.05, y: 0.1, width: 0.35, height: 0.05 },
      text: 'Left column source',
      translatedText: `LEFT_COLUMN ${'A'.repeat(420)}`,
      status: 'recognized'
    }, {
      regionId: 'ocr-right-column',
      bbox: { x: 0.55, y: 0.1, width: 0.1, height: 0.05 },
      text: 'Right column source',
      translatedText: 'RIGHT_COLUMN_MARKER',
      status: 'recognized'
    }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => readFileSync('tests/fixtures/ocr-scaling/clear.png')
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const page = await exportedPdf.getPage(1)
    const pageHeight = page.getViewport({ scale: 1 }).height
    const content = await page.getTextContent()
    const items = content.items.filter((item): item is typeof item & { str: string; transform: number[] } =>
      'str' in item && 'transform' in item && item.str.trim().length > 0)
    const right = items.find((item) => item.str === 'RIGHT_COLUMN_MARKER')
    const leftTops = items
      .filter((item) => item.str.startsWith('LEFT_COLUMN') || /^A+$/u.test(item.str))
      .map((item) => pageHeight - (item.transform[5] ?? pageHeight))
    assert.ok(right, 'right column OCR translation must be exported')
    assert.ok(leftTops.length > 2, 'left column OCR translation must wrap')
    const rightTop = pageHeight - (right.transform[5] ?? pageHeight)
    assert.ok(
      Math.abs(rightTop - 92.9) < 2,
      `right column must stay on its source row: expected top=92.9, actual=${rightTop}, leftBottom=${Math.max(...leftTops)}`
    )
  } finally {
    await exportedPdf.destroy()
  }
})

test('Markdown 等流式文档超出单页时必须继续分页导出，不能丢失后续内容', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.height = 220
  page.blocks = Array.from({ length: 24 }, (_, index) => ({
    kind: 'text' as const,
    blockId: `flow-block-${index}`,
    readingOrder: index,
    translatable: true,
    role: 'paragraph' as const,
    runs: [{
      runId: `flow-run-${index}`,
      text: index === 23 ? 'FLOW_LAST_PARAGRAPH' : `Flow paragraph ${index} with enough text to consume vertical space.`,
      style: { fontSize: 14, lineHeight: 20 }
    }]
  }))

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    assert.ok(exportedPdf.numPages > 1, `expected multiple pages, got ${exportedPdf.numPages}`)
    const pageTexts: string[] = []
    for (let pageNumber = 1; pageNumber <= exportedPdf.numPages; pageNumber += 1) {
      const content = await (await exportedPdf.getPage(pageNumber)).getTextContent()
      pageTexts.push(content.items.map((item) => 'str' in item ? item.str : '').join(''))
    }
    assert.match(pageTexts.join(''), /FLOW_LAST_PARAGRAPH/u)
  } finally {
    await exportedPdf.destroy()
  }
})

test('单个超长 Markdown 文本块也必须跨页绘制并保留末尾内容', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.height = 220
  page.blocks = [{
    kind: 'text',
    blockId: 'long-flow-block',
    readingOrder: 0,
    translatable: true,
    role: 'paragraph',
    runs: [{
      runId: 'long-flow-run',
      text: `${'Long markdown paragraph content '.repeat(30)}FLOW_LONG_BLOCK_END`,
      style: { fontSize: 14, lineHeight: 20 }
    }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    assert.ok(exportedPdf.numPages > 1, `expected multiple pages, got ${exportedPdf.numPages}`)
    const pageTexts: string[] = []
    for (let pageNumber = 1; pageNumber <= exportedPdf.numPages; pageNumber += 1) {
      const content = await (await exportedPdf.getPage(pageNumber)).getTextContent()
      pageTexts.push(content.items.map((item) => 'str' in item ? item.str : '').join(''))
    }
    assert.match(pageTexts.join(''), /FLOW_LONG_BLOCK_END/u)
  } finally {
    await exportedPdf.destroy()
  }
})

test('原页坐标内的整页图片必须留在原页，不能因底部编辑留白额外产生空白页', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.blocks = [{
    kind: 'image',
    blockId: 'page-sized-image',
    readingOrder: 0,
    translatable: false,
    assetId: 'page-sized-image-asset',
    bbox: { x: 24, y: 24, width: page.width - 48, height: page.height - 48 }
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    assert.equal(exportedPdf.numPages, 1)
    const operatorList = await (await exportedPdf.getPage(1)).getOperatorList()
    assert.ok(operatorList.fnArray.includes(pdfjs.OPS.constructPath))
  } finally {
    await exportedPdf.destroy()
  }
})

test('多 run 长文本跨页后，后续 run 必须从新页游标继续绘制', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.height = 220
  page.blocks = [{
    kind: 'text',
    blockId: 'multi-run-crossing-page',
    readingOrder: 0,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 40, width: 140, height: 20 },
    runs: [
      {
        runId: 'multi-run-crossing-page-first',
        text: 'A'.repeat(600),
        style: { fontSize: 14, lineHeight: 20 }
      },
      {
        runId: 'multi-run-crossing-page-last',
        text: 'SECOND_RUN_AFTER_PAGE_BREAK',
        style: { fontSize: 14, lineHeight: 20 }
      }
    ]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    assert.ok(exportedPdf.numPages > 1)
    const pageTexts: string[] = []
    for (let pageNumber = 1; pageNumber <= exportedPdf.numPages; pageNumber += 1) {
      const pageContent = await (await exportedPdf.getPage(pageNumber)).getTextContent()
      pageTexts.push(pageContent.items.map((candidate) => 'str' in candidate ? candidate.str : '').join(''))
    }
    assert.match(pageTexts.join(''), /SECOND_RUN_AFTER_PAGE_BREAK/u, pageTexts.join('\n---\n'))
    const secondRunPage = pageTexts.findIndex((text) => text.includes('SECOND_RUN_AFT'))
    assert.ok(secondRunPage > 0, 'second run must start on a continuation page, not the old page bottom')
    const page = await exportedPdf.getPage(secondRunPage + 1)
    const content = await page.getTextContent()
    const item = content.items.find((candidate) => 'str' in candidate && candidate.str.startsWith('SECOND_RUN_AFT'))
    assert.ok(item && 'transform' in item)
    const top = page.getViewport({ scale: 1 }).height - (item.transform[5] ?? page.getViewport({ scale: 1 }).height)
    assert.ok(top > 0 && top < page.getViewport({ scale: 1 }).height - 20, `second run must continue in page flow, got ${top}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 普通正文的连续碎片 run 必须按文本流排版，不能逐字竖排', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.blocks = [{
    kind: 'text',
    blockId: 'fragmented-flow-paragraph',
    readingOrder: 0,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 65.25, y: 100, width: 459, height: 76.5 },
    runs: Array.from({ length: 201 }, (_, index) => ({
      runId: `fragmented-flow-run-${index}`,
      text: '用户中心权限申请审批流程测试'.at(index % 13)!,
      style: { fontSize: 9, lineHeight: 13.5 }
    }))
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    assert.equal(exportedPdf.numPages, 1, '短正文不能因碎片 run 被逐字竖排而膨胀成多页')
    const textContent = await (await exportedPdf.getPage(1)).getTextContent()
    const items = textContent.items.filter((item): item is typeof item & { transform: number[]; width: number } =>
      'str' in item && 'transform' in item && item.str.trim().length > 0)
    const baselines = [...new Set(items.map((item) => Math.round((item.transform[5] ?? 0) * 10) / 10))]
    assert.ok(baselines.length <= 6, `正文应横向排成少量视觉行，实际基线数: ${baselines.length}`)
    const firstBaselineItems = items.filter((item) =>
      Math.abs((item.transform[5] ?? 0) - (items[0]!.transform[5] ?? 0)) < 1)
    const left = Math.min(...firstBaselineItems.map((item) => item.transform[4] ?? 0))
    const right = Math.max(...firstBaselineItems.map((item) => (item.transform[4] ?? 0) + item.width))
    assert.ok(right - left > 300, `同一视觉行的文本必须横向连续排版，实际跨度: ${right - left}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 普通正文自动换行后必须保留混合 run 的样式', async () => {
  const model = documentWithText('')
  const block = model.pages[0]!.blocks[0]
  assert.equal(block.kind, 'text')
  if (block.kind !== 'text') return
  block.bbox = { x: 40, y: 50, width: 150, height: 40 }
  block.runs = [
    { runId: 'flow-style-regular', text: 'Regular text ', style: { fontSize: 12, color: '#123456' } },
    { runId: 'flow-style-bold', text: 'BOLD_MARKER', style: { fontSize: 14, color: '#654321', fontWeight: 700 } },
    { runId: 'flow-style-tail', text: ' tail text', style: { fontSize: 12, color: '#123456' } }
  ]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const page = await exportedPdf.getPage(1)
    const content = await page.getTextContent()
    const boldItem = content.items.find((item) => 'str' in item && item.str.includes('BOLD_MARKER'))
    assert.ok(boldItem && 'transform' in boldItem && 'fontName' in boldItem)
    const transform = boldItem.transform as number[]
    const fontSize = Math.hypot(transform[2] ?? 0, transform[3] ?? 0)
    assert.ok(Math.abs(fontSize - 14) < 1, `粗体片段字号必须保留: ${fontSize}`)
    await page.getOperatorList()
    const font = page.commonObjs.get(boldItem.fontName) as { name?: string; bold?: boolean }
    assert.equal(font.bold, true)
    assert.equal(font.name, 'Helvetica-Bold')
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 译文换行增高后，后续文本块必须顺延而不能覆盖原文坐标', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.blocks = [{
    kind: 'text',
    blockId: 'long-translation',
    readingOrder: 0,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 50, width: 100, height: 14 },
    runs: [{
      runId: 'long-translation-run',
      text: 'A'.repeat(300),
      style: { fontSize: 12, lineHeight: 18 }
    }]
  }, {
    kind: 'text',
    blockId: 'following-text',
    readingOrder: 1,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 80, width: 300, height: 14 },
    runs: [{
      runId: 'following-text-run',
      text: 'FOLLOWING_TEXT',
      style: { fontSize: 12, lineHeight: 18 }
    }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const content = await (await exportedPdf.getPage(1)).getTextContent()
    const textItems = content.items.filter((item): item is typeof item & { transform: number[] } =>
      'str' in item && 'transform' in item && item.str.trim().length > 0)
    const following = textItems.find((item) => item.str === 'FOLLOWING_TEXT')
    assert.ok(following)
    const followingTop = page.height - (following.transform[5] ?? page.height)
    const longTranslationTops = textItems
      .filter((item) => item !== following && /^A+$/u.test(item.str))
      .map((item) => page.height - (item.transform[5] ?? page.height))
    assert.ok(longTranslationTops.length > 2)
    assert.ok(
      followingTop > Math.max(...longTranslationTops) + 12,
      `following text overlaps translated lines: following=${followingTop}, lines=${longTranslationTops.join(',')}`
    )
  } finally {
    await exportedPdf.destroy()
  }
})

test('表格跨页后必须在新页面内容区顶部开始绘制，不能沿用旧页坐标', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.height = 240
  page.blocks = [{
    kind: 'table',
    blockId: 'table-after-flow',
    readingOrder: 0,
    translatable: true,
    bbox: { x: 40, y: 160, width: 300, height: 120 },
    columnWidths: [300],
    rows: [{
      rowId: 'table-after-flow-row',
      cells: [{
        cellId: 'table-after-flow-cell',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'text',
          blockId: 'table-after-flow-text',
          readingOrder: 0,
          translatable: true,
          role: 'paragraph',
          runs: [{ runId: 'table-after-flow-run', text: 'TABLE_AFTER_PAGE_BREAK', style: { fontSize: 10 } }]
        }]
      }]
    }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    assert.equal(exportedPdf.numPages, 2)
    const content = await (await exportedPdf.getPage(2)).getTextContent()
    const item = content.items.find((candidate) => 'str' in candidate && candidate.str === 'TABLE_AFTER_PAGE_BREAK')
    assert.ok(item && 'transform' in item)
    const top = page.height - (item.transform[5] ?? page.height)
    assert.ok(top < 60, `table must start near the new page top, got ${top}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('表格结束后的正文必须衔接表格实际底边，不能继承原文整表高度导致额外分页', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  const sourceRows = [
    { y: 45, text: 'ROW_0' },
    { y: 75, text: 'ROW_1' },
    { y: 105, text: 'ROW_2' }
  ]
  page.blocks = [{
    kind: 'table',
    blockId: 'table-followed-by-paragraph',
    readingOrder: 0,
    translatable: true,
    bbox: { x: 40, y: 40, width: 400, height: 90 },
    columnWidths: [400],
    rows: sourceRows.map((sourceRow, rowIndex) => ({
      rowId: `table-followed-by-paragraph-row-${rowIndex}`,
      cells: [{
        cellId: `table-followed-by-paragraph-cell-${rowIndex}`,
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'text' as const,
          blockId: `table-followed-by-paragraph-text-${rowIndex}`,
          readingOrder: rowIndex,
          translatable: true,
          role: 'paragraph' as const,
          bbox: { x: 45, y: sourceRow.y, width: 100, height: 13.5 },
          runs: [{ runId: `table-followed-by-paragraph-run-${rowIndex}`, text: sourceRow.text, style: { fontSize: 9, lineHeight: 13.5 } }]
        }]
      }]
    }))
  }, {
    kind: 'text',
    blockId: 'paragraph-after-compact-table',
    readingOrder: 1,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 135, width: 400, height: 20 },
    runs: [{ runId: 'paragraph-after-compact-table-run', text: 'PARAGRAPH_AFTER_COMPACT_TABLE', style: { fontSize: 9, lineHeight: 13.5 } }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    assert.equal(exportedPdf.numPages, 1, '紧凑表格后的正文不能被额外间距推到新页')
    const pageContent = await (await exportedPdf.getPage(1)).getTextContent()
    const paragraph = pageContent.items.find((item) => 'str' in item && item.str === 'PARAGRAPH_AFTER_COMPACT_TABLE')
    assert.ok(paragraph && 'transform' in paragraph)
    const paragraphTop = page.height - (paragraph.transform[5] ?? page.height)
    // 正文顶部由表格最后一条行带底边再叠加 10pt 块间距得到；
    // 这里验证的是不额外继承整表高度，而不是断言某个精确字号基线坐标。
    assert.ok(paragraphTop < 160, `正文必须紧随表格实际底边，实际顶部: ${paragraphTop}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 原生表格必须按原始单元格 Y 坐标保留行带高度，不能压缩原有留白', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  const sourceRows = [
    { y: 45, text: 'FIRST_ROW' },
    { y: 105, text: 'SECOND_ROW' },
    { y: 165, text: 'THIRD_ROW' }
  ]
  page.blocks = [{
    kind: 'table',
    blockId: 'table-with-source-row-heights',
    readingOrder: 0,
    translatable: true,
    bbox: { x: 40, y: 40, width: 400, height: 150 },
    columnWidths: [400],
    rows: sourceRows.map((sourceRow, rowIndex) => ({
      rowId: `table-with-source-row-heights-row-${rowIndex}`,
      cells: [{
        cellId: `table-with-source-row-heights-cell-${rowIndex}`,
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'text' as const,
          blockId: `table-with-source-row-heights-text-${rowIndex}`,
          readingOrder: rowIndex,
          translatable: true,
          role: 'paragraph' as const,
          bbox: { x: 45, y: sourceRow.y, width: 100, height: 13.5 },
          runs: [{ runId: `table-with-source-row-heights-run-${rowIndex}`, text: sourceRow.text, style: { fontSize: 9, lineHeight: 13.5 } }]
        }]
      }]
    }))
  }, {
    kind: 'text',
    blockId: 'paragraph-after-source-height-table',
    readingOrder: 1,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 200, width: 400, height: 20 },
    runs: [{ runId: 'paragraph-after-source-height-table-run', text: 'PARAGRAPH_AFTER_SOURCE_HEIGHT_TABLE', style: { fontSize: 9, lineHeight: 13.5 } }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const pageContent = await (await exportedPdf.getPage(1)).getTextContent()
    const items = pageContent.items.filter((item): item is typeof item & { str: string; transform: number[] } =>
      'str' in item && 'transform' in item)
    const rowTops = ['FIRST_ROW', 'SECOND_ROW', 'THIRD_ROW'].map((text) => {
      const item = items.find((candidate) => candidate.str === text)
      assert.ok(item, `表格行文本缺失: ${text}`)
      return page.height - (item.transform[5] ?? page.height)
    })
    assert.ok(rowTops[1]! - rowTops[0]! > 50, `第二行必须保留原始 60pt 行带: ${rowTops.join(',')}`)
    assert.ok(rowTops[2]! - rowTops[1]! > 50, `第三行必须保留原始 60pt 行带: ${rowTops.join(',')}`)
    const paragraph = items.find((item) => item.str === 'PARAGRAPH_AFTER_SOURCE_HEIGHT_TABLE')
    assert.ok(paragraph, '表格后的正文必须导出')
    const paragraphTop = page.height - (paragraph.transform[5] ?? page.height)
    assert.ok(paragraphTop > 185 && paragraphTop < 215, `正文必须衔接原始表格底边，实际顶部: ${paragraphTop}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 原生正文增高后，后续竖线边框仍必须保持原始页面坐标', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.height = 240
  page.blocks = [{
    kind: 'text',
    blockId: 'text-inside-native-frame',
    readingOrder: 0,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 60, width: 200, height: 20 },
    runs: [{
      runId: 'text-inside-native-frame-run',
      // 两段文本足以让译文从原单行增高并换行，同时仍完整位于 240pt 物理页面内。
      // 这样测试只会暴露竖线错误推进游标的问题，不会把正文自身超过页高误判为回归。
      text: 'TRANSLATED_TEXT_INSIDE_FRAME '.repeat(2),
      style: { fontSize: 12, lineHeight: 18 }
    }]
  }, {
    kind: 'shape',
    blockId: 'native-vertical-frame',
    readingOrder: 1,
    translatable: false,
    bbox: { x: 40, y: 50, width: 1, height: 170 },
    line: { orientation: 'vertical', thickness: 1 }
  }, {
    kind: 'text',
    blockId: 'text-after-native-frame',
    readingOrder: 2,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 190, width: 200, height: 18 },
    runs: [{ runId: 'text-after-native-frame-run', text: 'AFTER_NATIVE_FRAME', style: { fontSize: 12, lineHeight: 18 } }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    assert.equal(exportedPdf.numPages, 1, '原生竖线边框不能把仍在原页的后续正文推到新页')
    const content = await (await exportedPdf.getPage(1)).getTextContent()
    const item = content.items.find((candidate) => 'str' in candidate && candidate.str === 'AFTER_NATIVE_FRAME')
    assert.ok(item && 'transform' in item)
    const top = page.height - (item.transform[5] ?? page.height)
    assert.ok(top > 185 && top < 210, `后续正文必须保持原始顶部坐标，实际顶部: ${top}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 原生页脚文本位于物理页面内时不能被编辑留白强制分页', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.height = 240
  page.blocks = [{
    kind: 'text',
    blockId: 'native-footer-text',
    readingOrder: 0,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 226, width: 160, height: 9 },
    runs: [{ runId: 'native-footer-text-run', text: 'NATIVE_FOOTER', style: { fontSize: 9, lineHeight: 12 } }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    assert.equal(exportedPdf.numPages, 1, '仍位于原物理页面内的页脚不能被额外分页')
    const content = await (await exportedPdf.getPage(1)).getTextContent()
    assert.ok(content.items.some((item) => 'str' in item && item.str === 'NATIVE_FOOTER'))
  } finally {
    await exportedPdf.destroy()
  }
})

test('公式跨页后必须在新页面内容区顶部开始绘制，不能沿用旧页坐标', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.height = 240
  page.blocks = [{
    kind: 'formula',
    blockId: 'formula-after-flow',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 40, y: 220, width: 300, height: 40 },
    sourceText: 'FORMULA_AFTER_PAGE_BREAK'
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    assert.equal(exportedPdf.numPages, 2)
    const content = await (await exportedPdf.getPage(2)).getTextContent()
    const item = content.items.find((candidate) => 'str' in candidate && candidate.str === 'FORMULA_AFTER_PAGE_BREAK')
    assert.ok(item && 'transform' in item)
    const top = page.height - (item.transform[5] ?? page.height)
    assert.ok(top < 60, `formula must start near the new page top, got ${top}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 文本跨页后结束游标必须位于新页，不能把后续区块推回旧页底部', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.height = 240
  page.blocks = [{
    kind: 'text',
    blockId: 'text-before-crossing-page',
    readingOrder: 0,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 170, width: 120, height: 20 },
    runs: [{ runId: 'text-before-crossing-page-run', text: 'BEFORE', style: { fontSize: 12, lineHeight: 18 } }]
  }, {
    kind: 'text',
    blockId: 'text-crossing-page',
    readingOrder: 1,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 190, width: 120, height: 20 },
    runs: [{ runId: 'text-crossing-page-run', text: 'A'.repeat(500), style: { fontSize: 12, lineHeight: 18 } }]
  }, {
    kind: 'text',
    blockId: 'text-near-old-page-bottom',
    readingOrder: 2,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 226, width: 300, height: 14 },
    runs: [{ runId: 'text-near-old-page-bottom-run', text: 'TEXT_NEAR_OLD_PAGE_BOTTOM', style: { fontSize: 12, lineHeight: 18 } }]
  }, {
    kind: 'text',
    blockId: 'text-after-crossing-page',
    readingOrder: 3,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 238, width: 300, height: 14 },
    runs: [{ runId: 'text-after-crossing-page-run', text: 'TEXT_AFTER_CROSSING_PAGE', style: { fontSize: 12, lineHeight: 18 } }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    assert.ok(exportedPdf.numPages >= 2)
    const lastPageContent = await (await exportedPdf.getPage(exportedPdf.numPages)).getTextContent()
    const item = lastPageContent.items.find((candidate) => 'str' in candidate && candidate.str === 'TEXT_AFTER_CROSSING_PAGE')
    assert.ok(item, 'following text must be exported on the final page')
    assert.ok('transform' in item)
    const top = page.height - (item.transform[5] ?? page.height)
    assert.ok(top < 80, `following text must continue near the new page top, got ${top}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 表格单元格同一视觉行的多个文本片段必须同基线连续绘制', async () => {
  const model = documentWithText('')
  model.pages[0]!.blocks = [{
    kind: 'table',
    blockId: 'table-fragmented-cell-runs',
    readingOrder: 0,
    translatable: true,
    bbox: { x: 40, y: 50, width: 400, height: 40 },
    columnWidths: [160, 240],
    rows: [{
      rowId: 'table-fragmented-cell-runs-row',
      cells: [{
        cellId: 'table-fragmented-cell-runs-first',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'text',
          blockId: 'table-fragmented-cell-runs-first-text',
          readingOrder: 0,
          translatable: true,
          role: 'paragraph',
          runs: [
            { runId: 'table-fragmented-cell-runs-a', text: '证', style: { fontSize: 9, lineHeight: 13.5 } },
            { runId: 'table-fragmented-cell-runs-b', text: '书份', style: { fontSize: 9, lineHeight: 13.5 } },
            { runId: 'table-fragmented-cell-runs-c', text: '数', style: { fontSize: 9, lineHeight: 13.5 } }
          ]
        }]
      }, {
        cellId: 'table-fragmented-cell-runs-second',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'text',
          blockId: 'table-fragmented-cell-runs-second-text',
          readingOrder: 1,
          translatable: true,
          role: 'paragraph',
          textAlign: 'right',
          runs: [
            { runId: 'table-fragmented-cell-runs-d', text: 'RIGHT', style: { fontSize: 9, lineHeight: 13.5 } },
            { runId: 'table-fragmented-cell-runs-e', text: ' ALIGNED', style: { fontSize: 9, lineHeight: 13.5 } }
          ]
        }]
      }]
    }, {
      rowId: 'table-fragmented-cell-runs-next-row',
      cells: [{
        cellId: 'table-fragmented-cell-runs-next',
        rowSpan: 1,
        colSpan: 2,
        blocks: [{
          kind: 'text',
          blockId: 'table-fragmented-cell-runs-next-text',
          readingOrder: 2,
          translatable: true,
          role: 'paragraph',
          runs: [{ runId: 'table-fragmented-cell-runs-next-run', text: 'NEXT_TABLE_ROW', style: { fontSize: 9 } }]
        }]
      }]
    }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    assert.equal(exportedPdf.numPages, 1, '短表格不能因单元格 run 碎片化而异常分页')
    const page = await exportedPdf.getPage(1)
    const content = await page.getTextContent()
    const items = content.items.filter((item): item is typeof item & { str: string; transform: number[]; width: number } =>
      'str' in item && 'transform' in item && 'width' in item && item.str.trim().length > 0)
    const fragments = items.filter((item) =>
      ['证', '书份', '数'].includes(item.str))
    assert.deepEqual(fragments.map((item) => item.str), ['证', '书份', '数'])
    const baselines = fragments.map((item) => item.transform[5] ?? 0)
    assert.ok(Math.max(...baselines) - Math.min(...baselines) < 1, `同一视觉行必须共享基线: ${baselines.join(',')}`)
    assert.ok(fragments[1]!.transform[4]! > fragments[0]!.transform[4]!)
    assert.ok(fragments[2]!.transform[4]! > fragments[1]!.transform[4]!)

    const rightFragments = items.filter((item) => /RIGHT|ALIGNED/u.test(item.str))
    assert.ok(rightFragments.length >= 1, '右对齐文本必须完整导出')
    assert.equal(
      rightFragments.map((item) => item.str).join(' ').replace(/\s+/gu, ' ').trim(),
      'RIGHT ALIGNED',
      `右对齐文本导出不完整: ${rightFragments.map((item) => item.str).join('|')}`
    )
    const lastRightFragment = rightFragments[rightFragments.length - 1]!
    const rightEdge = (lastRightFragment.transform[4] ?? 0) + lastRightFragment.width
    assert.ok(Math.abs(rightEdge - 435) < 2, `右对齐片段必须保持整行右边界: ${rightEdge}`)
    const nextRow = items.find((item) => item.str === 'NEXT_TABLE_ROW')
    assert.ok(nextRow)
    const firstRowTop = page.getViewport({ scale: 1 }).height - (fragments[0]!.transform[5] ?? 0)
    const nextRowTop = page.getViewport({ scale: 1 }).height - (nextRow.transform[5] ?? 0)
    assert.ok(nextRowTop > firstRowTop + 10, '下一行必须避开单元格内容，不能被首行覆盖')
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 表格单元格内同排正文与页码必须保持原始横向位置和同一顶部', async () => {
  const model = documentWithText('')
  model.pages[0]!.blocks = [{
    kind: 'table',
    blockId: 'table-cell-side-by-side',
    readingOrder: 0,
    translatable: true,
    bbox: { x: 60.375, y: 100, width: 474.75, height: 60 },
    columnWidths: [80.625, 394.125],
    rows: [{
      rowId: 'table-cell-side-by-side-row',
      cells: [{
        cellId: 'table-cell-side-by-side-label',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'text',
          blockId: 'table-cell-side-by-side-label-text',
          readingOrder: 0,
          translatable: true,
          role: 'paragraph',
          textAlign: 'center',
          bbox: { x: 83.25, y: 109.875, width: 36, height: 10 },
          runs: [{ runId: 'table-cell-side-by-side-label-run', text: '申请表', style: { fontSize: 9, lineHeight: 13.5 } }]
        }]
      }, {
        cellId: 'table-cell-side-by-side-value',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'text',
          blockId: 'table-cell-side-by-side-body',
          readingOrder: 1,
          translatable: true,
          role: 'paragraph',
          bbox: { x: 145.5, y: 109.875, width: 250, height: 10 },
          runs: [{
            runId: 'table-cell-side-by-side-body-run',
            text: '这是一段需要换行的较长正文内容，用于模拟左侧正文和右侧页码在同一单元格内共享原始视觉行。',
            style: { fontSize: 9, lineHeight: 13.5 }
          }]
        }, {
          kind: 'text',
          blockId: 'table-cell-side-by-side-page-number',
          readingOrder: 2,
          translatable: true,
          role: 'paragraph',
          textAlign: 'right',
          bbox: { x: 515.847, y: 109.875, width: 15, height: 10 },
          runs: [{ runId: 'table-cell-side-by-side-page-number-run', text: '4页', style: { fontSize: 9, lineHeight: 13.5 } }]
        }]
      }]
    }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const page = await exportedPdf.getPage(1)
    const content = await page.getTextContent()
    const items = content.items.filter((item): item is typeof item & { str: string; transform: number[]; width: number } =>
      'str' in item && 'transform' in item && 'width' in item && item.str.trim().length > 0)
    const pageNumber = items.find((item) => item.str.includes('4') && (item.transform[4] as number) > 470)
    const bodyStart = items.find((item) => item.str.includes('这是一段'))
    assert.ok(pageNumber, '右侧页码必须导出')
    assert.ok(bodyStart, '左侧正文必须导出')
    const pageHeight = page.getViewport({ scale: 1 }).height
    const pageNumberTop = pageHeight - (pageNumber.transform[5] as number)
    const bodyTop = pageHeight - (bodyStart.transform[5] as number)
    assert.ok(Math.abs(pageNumberTop - bodyTop) < 2,
      `同排正文和页码顶部必须一致，正文=${bodyTop}，页码=${pageNumberTop}`)
    assert.ok(pageNumber.transform[4]! > 470,
      `页码必须保持在单元格右侧，实际 X=${pageNumber.transform[4]}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 表格单元格内的图片必须先于其后的文本绘制，不能被纵坐标排序挪到后面', async () => {
  const model = documentWithText('')
  model.pages[0]!.blocks = [{
    kind: 'table',
    blockId: 'table-cell-image-order',
    readingOrder: 0,
    translatable: true,
    bbox: { x: 60, y: 100, width: 400, height: 100 },
    columnWidths: [400],
    rows: [{
      rowId: 'table-cell-image-order-row',
      cells: [{
        cellId: 'table-cell-image-order-cell',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'image',
          blockId: 'table-cell-image-order-image',
          readingOrder: 0,
          translatable: false,
          assetId: 'table-cell-image-order-asset',
          bbox: { x: 65, y: 105, width: 120, height: 60 }
        }, {
          kind: 'text',
          blockId: 'table-cell-image-order-text',
          readingOrder: 1,
          translatable: true,
          role: 'paragraph',
          bbox: { x: 65, y: 105, width: 120, height: 12 },
          runs: [{ runId: 'table-cell-image-order-run', text: 'IMAGE_CAPTION_AFTER', style: { fontSize: 10 } }]
        }]
      }]
    }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => readFileSync('tests/fixtures/ocr-scaling/clear.png')
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const page = await exportedPdf.getPage(1)
    const operatorList = await page.getOperatorList()
    const paintIndex = operatorList.fnArray.indexOf(pdfjs.OPS.paintImageXObject)
    const textContent = await page.getTextContent()
    const caption = textContent.items.find((item) => 'str' in item && item.str.includes('IMAGE_CAPTION_AFTER'))
    assert.ok(paintIndex >= 0, '单元格图片必须导出')
    assert.ok(caption && 'transform' in caption, '图片后的文本必须导出')
    const pageHeight = page.getViewport({ scale: 1 }).height
    const captionTop = pageHeight - (caption.transform[5] ?? 0)
    const imageBottom = 105 + 60
    assert.ok(captionTop >= imageBottom, `图片后的文本必须排在图片下方，图片底=${imageBottom}，文本顶=${captionTop}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 表格单元格同排正文与页码只能累计一次视觉行高度', async () => {
  const model = documentWithText('')
  model.pages[0]!.blocks = [{
    kind: 'table',
    blockId: 'table-cell-side-by-side-height',
    readingOrder: 0,
    translatable: true,
    bbox: { x: 60, y: 100, width: 450, height: 30 },
    columnWidths: [450],
    rows: [{
      rowId: 'table-cell-side-by-side-height-row',
      cells: [{
        cellId: 'table-cell-side-by-side-height-cell',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'text',
          blockId: 'table-cell-side-by-side-height-body',
          readingOrder: 0,
          translatable: true,
          role: 'paragraph',
          bbox: { x: 65, y: 105, width: 350, height: 10 },
          runs: [{ runId: 'table-cell-side-by-side-height-body-run', text: 'SHORT_BODY', style: { fontSize: 10, lineHeight: 13 } }]
        }, {
          kind: 'text',
          blockId: 'table-cell-side-by-side-height-page',
          readingOrder: 1,
          translatable: true,
          role: 'paragraph',
          textAlign: 'right',
          bbox: { x: 475, y: 105, width: 30, height: 10 },
          runs: [{ runId: 'table-cell-side-by-side-height-page-run', text: '4页', style: { fontSize: 10, lineHeight: 13 } }]
        }]
      }]
    }, {
      rowId: 'table-cell-side-by-side-height-next-row',
      cells: [{
        cellId: 'table-cell-side-by-side-height-next-cell',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'text',
          blockId: 'table-cell-side-by-side-height-next-text',
          readingOrder: 2,
          translatable: true,
          role: 'paragraph',
          bbox: { x: 65, y: 130, width: 350, height: 10 },
          runs: [{ runId: 'table-cell-side-by-side-height-next-run', text: 'NEXT_ROW_AFTER_SIDE_BY_SIDE', style: { fontSize: 10, lineHeight: 13 } }]
        }]
      }]
    }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const page = await exportedPdf.getPage(1)
    const content = await page.getTextContent()
    const items = content.items.filter((item): item is typeof item & { str: string; transform: number[] } =>
      'str' in item && 'transform' in item && item.str.trim().length > 0)
    const body = items.find((item) => item.str.includes('SHORT_BODY'))
    const pageNumber = items.find((item) => item.str.includes('4') && (item.transform[4] ?? 0) > 430)
    const nextRow = items.find((item) => item.str.includes('NEXT_ROW_AFTER_SIDE_BY_SIDE'))
    assert.ok(body && pageNumber && nextRow)
    const pageHeight = page.getViewport({ scale: 1 }).height
    const bodyTop = pageHeight - (body.transform[5] ?? 0)
    const pageNumberTop = pageHeight - (pageNumber.transform[5] ?? 0)
    const nextRowTop = pageHeight - (nextRow.transform[5] ?? 0)
    assert.ok(Math.abs(bodyTop - pageNumberTop) < 2, '正文和页码必须共享同一视觉行')
    assert.ok(nextRowTop >= bodyTop + 12,
      `下一行必须避开同一视觉行，正文顶=${bodyTop}，下一行顶=${nextRowTop}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 文本跨页后签名、日期与底边必须紧跟续页正文', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.height = 240
  page.blocks = [{
    kind: 'text',
    blockId: 'flow-before-signature',
    readingOrder: 0,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 140, width: 160, height: 40 },
    runs: [{
      runId: 'flow-before-signature-run',
      text: `${'A'.repeat(240)}FLOW_CONTINUATION_END`,
      style: { fontSize: 12, lineHeight: 18 }
    }]
  }, {
    kind: 'text',
    blockId: 'signature-after-flow',
    readingOrder: 1,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 190, width: 160, height: 12 },
    runs: [{ runId: 'signature-after-flow-run', text: 'SIGNATURE_AFTER_FLOW', style: { fontSize: 10, lineHeight: 12 } }]
  }, {
    kind: 'text',
    blockId: 'date-after-flow',
    readingOrder: 2,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 210, width: 160, height: 12 },
    runs: [{ runId: 'date-after-flow-run', text: 'DATE_AFTER_FLOW', style: { fontSize: 10, lineHeight: 12 } }]
  }, {
    kind: 'shape',
    blockId: 'bottom-after-flow',
    readingOrder: 3,
    translatable: false,
    bbox: { x: 40, y: 230, width: 160, height: 1 },
    line: { orientation: 'horizontal', thickness: 1 }
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    assert.equal(exportedPdf.numPages, 2, '续页后的签名和底边不能制造第三页')
    const lastPage = await exportedPdf.getPage(exportedPdf.numPages)
    const pageHeight = lastPage.getViewport({ scale: 1 }).height
    const content = await lastPage.getTextContent()
    const items = content.items.filter((item): item is typeof item & { str: string; transform: number[] } =>
      'str' in item && 'transform' in item && item.str.trim().length > 0)
    const continuationEnd = items.find((item) => item.str.includes('NTINUATION_END'))
    const signature = items.find((item) => item.str.includes('SIGNATURE_AFTER_FLOW'))
    const date = items.find((item) => item.str.includes('DATE_AFTER_FLOW'))
    assert.ok(continuationEnd, '续页必须保留正文末尾')
    assert.ok(signature, '签名必须出现在续页')
    assert.ok(date, '日期必须出现在续页')
    const textTop = (item: { transform: number[] }): number => pageHeight - (item.transform[5] ?? pageHeight)
    const continuationTop = textTop(continuationEnd)
    const signatureTop = textTop(signature)
    const dateTop = textTop(date)
    assert.ok(signatureTop - continuationTop < 40,
      `签名必须紧跟续页正文，不能跳回原页底部：正文=${continuationTop}，签名=${signatureTop}`)
    assert.ok(dateTop - signatureTop < 40,
      `日期必须紧跟签名：签名=${signatureTop}，日期=${dateTop}`)

    const operatorList = await lastPage.getOperatorList()
    let bottomLineTop: number | undefined
    for (let index = 0; index < operatorList.fnArray.length; index += 1) {
      if (operatorList.fnArray[index] !== pdfjs.OPS.constructPath) continue
      const pathOperations = operatorList.argsArray[index]?.[0]
      if (!Array.isArray(pathOperations) ||
        !pathOperations.includes(pdfjs.OPS.moveTo) ||
        !pathOperations.includes(pdfjs.OPS.lineTo) ||
        pathOperations.includes(pdfjs.OPS.rectangle)) continue
      const pathArguments = operatorList.argsArray[index]?.[1]
      if (!Array.isArray(pathArguments)) continue
      const yValues = pathArguments.filter((_, argumentIndex) => argumentIndex % 2 === 1)
        .filter((value): value is number => typeof value === 'number')
      if (yValues.length > 0 && new Set(yValues).size === 1) {
        bottomLineTop = pageHeight - yValues[0]!
      }
    }
    assert.ok(bottomLineTop !== undefined, '续页必须绘制底部框线')
    assert.ok(bottomLineTop - dateTop < 40,
      `底部框线必须跟随日期实际底边：日期=${dateTop}，框线=${bottomLineTop}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 续页首个尾注不能继承旧页的大段间距', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.height = 260
  page.blocks = [{
    kind: 'text',
    blockId: 'continuation-body',
    readingOrder: 0,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 100, width: 160, height: 50 },
    runs: [{
      runId: 'continuation-body-run',
      // 固定宽度的英文正文跨越两页，末行必须留在第二页。
      text: `${'A'.repeat(190)} BODYEND`,
      style: { fontSize: 12, lineHeight: 18 }
    }]
  }, {
    kind: 'text',
    blockId: 'continuation-signature',
    readingOrder: 1,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 220, width: 160, height: 12 },
    runs: [{ runId: 'continuation-signature-run', text: 'SIGNATURE_TAIL', style: { fontSize: 10, lineHeight: 12 } }]
  }, {
    kind: 'text',
    blockId: 'continuation-id',
    readingOrder: 2,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 235, width: 160, height: 12 },
    runs: [{ runId: 'continuation-id-run', text: 'ID_TAIL', style: { fontSize: 10, lineHeight: 12 } }]
  }, {
    kind: 'text',
    blockId: 'continuation-date',
    readingOrder: 3,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 40, y: 250, width: 160, height: 9 },
    runs: [{ runId: 'continuation-date-run', text: 'DATE_TAIL', style: { fontSize: 10, lineHeight: 12 } }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    assert.equal(exportedPdf.numPages, 2, '长正文和尾注必须落在两页内')
    const continuationPage = await exportedPdf.getPage(2)
    const pageHeight = continuationPage.getViewport({ scale: 1 }).height
    const content = await continuationPage.getTextContent()
    const items = content.items.filter((item): item is typeof item & { str: string; transform: number[] } =>
      'str' in item && 'transform' in item && item.str.trim().length > 0)
    const textTop = (item: { transform: number[] }): number => pageHeight - (item.transform[5] ?? pageHeight)
    const continuationEnd = items.find((item) => item.str.includes('BODYEND'))
    const signature = items.find((item) => item.str.includes('SIGNATURE_TAIL'))
    const id = items.find((item) => item.str.includes('ID_TAIL'))
    const date = items.find((item) => item.str.includes('DATE_TAIL'))
    assert.ok(continuationEnd && signature && id && date,
      `续页必须保留正文末尾与全部尾注，实际文本=${items.map((item) => item.str).join('|')}`)
    const continuationTop = textTop(continuationEnd)
    const signatureTop = textTop(signature)
    const idTop = textTop(id)
    const dateTop = textTop(date)
    assert.ok(signatureTop - continuationTop < 40,
      `首个尾注不能继承旧页 70pt 大段距：正文=${continuationTop}，签名=${signatureTop}`)
    assert.ok(signatureTop < idTop && idTop < dateTop, '签名、ID 和日期必须保持原有先后顺序')
    assert.ok(Math.abs((idTop - signatureTop) - 15) < 2,
      `首个尾注压缩后，后续 ID 仍须保留源相对间距：签名=${signatureTop}，ID=${idTop}`)
    assert.ok(Math.abs((dateTop - idTop) - 15) < 2,
      `ID 到日期仍须保留源相对间距：ID=${idTop}，日期=${dateTop}`)
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 正文跨页后结构竖线必须续绘到续页正文底部', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.height = 240
  page.blocks = [{
    kind: 'shape',
    blockId: 'continuation-frame-left',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 40, y: 30, width: 1, height: 180 },
    line: { orientation: 'vertical', thickness: 1 }
  }, {
    kind: 'text',
    blockId: 'continuation-frame-text',
    readingOrder: 1,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 50, y: 40, width: 120, height: 20 },
    runs: [{
      runId: 'continuation-frame-text-run',
      // 240 个字符可在第二页结束，避免测试把正文跨到第三页而检查错页。
      text: `${'A'.repeat(240)}FRAME_CONTINUATION_END`,
      style: { fontSize: 12, lineHeight: 18 }
    }]
  }, {
    kind: 'shape',
    blockId: 'continuation-frame-right',
    readingOrder: 2,
    translatable: false,
    bbox: { x: 180, y: 30, width: 1, height: 180 },
    line: { orientation: 'vertical', thickness: 1 }
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null,
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    assert.ok(exportedPdf.numPages >= 2)
    const continuationPage = await exportedPdf.getPage(2)
    const pageHeight = continuationPage.getViewport({ scale: 1 }).height
    const textContent = await continuationPage.getTextContent()
    const continuationText = [...textContent.items]
      .reverse()
      .find((item): item is typeof item & { str: string; transform: number[] } =>
        'str' in item && 'transform' in item && item.str.trim().length > 0)
    assert.ok(continuationText, '续页必须保留正文末尾')
    const textTop = pageHeight - (continuationText.transform[5] ?? pageHeight)
    const operatorList = await continuationPage.getOperatorList()
    const verticalLines: Array<{ x: number; start: number; end: number }> = []
    for (let index = 0; index < operatorList.fnArray.length; index += 1) {
      if (operatorList.fnArray[index] !== pdfjs.OPS.constructPath) continue
      const pathOperations = operatorList.argsArray[index]?.[0]
      const pathArguments = operatorList.argsArray[index]
      if (!Array.isArray(pathOperations) || !Array.isArray(pathArguments) ||
        !pathOperations.includes(pdfjs.OPS.moveTo) ||
        !pathOperations.includes(pdfjs.OPS.lineTo) ||
        pathOperations.includes(pdfjs.OPS.rectangle)) continue
      // pdf-lib 的 constructPath 参数为 [操作数组, 坐标数组, 包围盒]。
      const coordinates = pathArguments[1]
      if (!Array.isArray(coordinates)) continue
      const points = coordinates.map(Number)
      const xValues = points.filter((_, pointIndex) => pointIndex % 2 === 0)
      const yValues = points.filter((_, pointIndex) => pointIndex % 2 === 1)
      if (points.every(Number.isFinite) && xValues.length >= 2 && new Set(xValues).size === 1 &&
        yValues.length >= 2 && new Set(yValues).size === 2) {
        verticalLines.push({
          x: Number(xValues[0]),
          start: pageHeight - Math.max(...yValues.map(Number)),
          end: pageHeight - Math.min(...yValues.map(Number))
        })
      }
    }
    for (const x of [40, 180]) {
      const line = verticalLines.find((candidate) => Math.abs(candidate.x - x) < 1)
      assert.ok(line, `续页必须续绘 x=${x} 的结构竖线`)
      assert.ok(line.start <= 16 && line.end >= textTop,
        `结构竖线必须覆盖续页正文：x=${x}，范围=${line.start}-${line.end}，正文顶=${textTop}`)
    }
  } finally {
    await exportedPdf.destroy()
  }
})

test('PDF 续页内下划线必须跟随正文，结构框线只能闭合到日期下方底边', async () => {
  const model = documentWithText('')
  const page = model.pages[0]!
  page.width = 594.95996
  page.height = 841.91998
  page.blocks = [{
    kind: 'shape',
    blockId: 'continuation-structural-left',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 60.375, y: 616.25, width: 1, height: 187.375 },
    line: { orientation: 'vertical', color: '#000000', thickness: 1 }
  }, {
    kind: 'shape',
    blockId: 'continuation-structural-right',
    readingOrder: 1,
    translatable: false,
    bbox: { x: 535.125, y: 616.25, width: 1, height: 187.375 },
    line: { orientation: 'vertical', color: '#000000', thickness: 1 }
  }, {
    kind: 'text',
    blockId: 'continuation-body',
    readingOrder: 2,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 65.25, y: 620.25, width: 459, height: 76.5 },
    runs: [{
      runId: 'continuation-body-run',
      text: 'The applicant confirms that all submitted information is true and accurate. '.repeat(24),
      style: { fontSize: 9, lineHeight: 13.5 }
    }]
  }, {
    kind: 'shape',
    blockId: 'continuation-underline-wide',
    readingOrder: 3,
    translatable: false,
    bbox: { x: 65.25, y: 670.5, width: 459, height: 1 },
    line: { orientation: 'horizontal', color: '#000000', thickness: 0.75 }
  }, {
    kind: 'shape',
    blockId: 'continuation-underline-short',
    readingOrder: 4,
    translatable: false,
    bbox: { x: 65.25, y: 684, width: 63, height: 1 },
    line: { orientation: 'horizontal', color: '#000000', thickness: 0.75 }
  }, {
    kind: 'text',
    blockId: 'continuation-signature',
    readingOrder: 5,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 307.5, y: 737.25, width: 99, height: 9 },
    runs: [{ runId: 'continuation-signature-run', text: 'Applicant (Natural Person) Signature:', style: { fontSize: 9 } }]
  }, {
    kind: 'text',
    blockId: 'continuation-id',
    readingOrder: 6,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 352.5, y: 752.25, width: 54, height: 9 },
    runs: [{ runId: 'continuation-id-run', text: 'ID Number:', style: { fontSize: 9 } }]
  }, {
    kind: 'text',
    blockId: 'continuation-date',
    readingOrder: 7,
    translatable: true,
    role: 'paragraph',
    bbox: { x: 444.8906, y: 782.25, width: 81.6029, height: 9 },
    textAlign: 'right',
    runs: [{ runId: 'continuation-date-run', text: 'October 12, 2026', style: { fontSize: 9 } }]
  }, {
    kind: 'shape',
    blockId: 'continuation-structural-bottom',
    readingOrder: 8,
    translatable: false,
    bbox: { x: 60.375, y: 803.625, width: 474.75, height: 1 },
    line: { orientation: 'horizontal', color: '#000000', thickness: 1 }
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => null
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    assert.equal(exportedPdf.numPages, 2, '续页尾注不能制造第三页')
    const continuationPage = await exportedPdf.getPage(2)
    const pageHeight = continuationPage.getViewport({ scale: 1 }).height
    const operatorList = await continuationPage.getOperatorList()
    const lines: Array<{
      lineWidth: number
      orientation: 'horizontal' | 'vertical'
      x: number
      top: number
      bottom: number
      width: number
    }> = []
    let lineWidth = 1
    for (let index = 0; index < operatorList.fnArray.length; index += 1) {
      const operation = operatorList.fnArray[index]
      if (operation === pdfjs.OPS.setLineWidth) {
        lineWidth = Number(operatorList.argsArray[index]?.[0] ?? lineWidth)
        continue
      }
      if (operation !== pdfjs.OPS.constructPath) continue
      const pathOperations = operatorList.argsArray[index]?.[0]
      const coordinates = operatorList.argsArray[index]?.[1]
      if (!Array.isArray(pathOperations) || !Array.isArray(coordinates) ||
        !pathOperations.includes(pdfjs.OPS.moveTo) ||
        !pathOperations.includes(pdfjs.OPS.lineTo) ||
        pathOperations.includes(pdfjs.OPS.rectangle)) continue
      const xValues = coordinates.filter((_, coordinateIndex) => coordinateIndex % 2 === 0)
        .map(Number)
      const yValues = coordinates.filter((_, coordinateIndex) => coordinateIndex % 2 === 1)
        .map(Number)
      if (!xValues.every(Number.isFinite) || !yValues.every(Number.isFinite)) continue
      const uniqueX = [...new Set(xValues)]
      const uniqueY = [...new Set(yValues)]
      if (uniqueX.length === 1 && uniqueY.length >= 2) {
        lines.push({
          lineWidth,
          orientation: 'vertical',
          x: uniqueX[0]!,
          top: pageHeight - Math.max(...yValues),
          bottom: pageHeight - Math.min(...yValues),
          width: 0
        })
      } else if (uniqueY.length === 1 && uniqueX.length >= 2) {
        lines.push({
          lineWidth,
          orientation: 'horizontal',
          x: Math.min(...uniqueX),
          top: pageHeight - uniqueY[0]!,
          bottom: pageHeight - uniqueY[0]!,
          width: Math.max(...uniqueX) - Math.min(...uniqueX)
        })
      }
    }

    const underlines = lines.filter((line) =>
      line.orientation === 'horizontal' && Math.abs(line.lineWidth - 0.75) < 0.05)
    assert.equal(underlines.length, 2, '续页必须保留两条正文下划线')
    assert.ok(underlines.every((line) => line.top < 200),
      `正文下划线必须跟随续页正文，不能落回原页底部：${underlines.map((line) => line.top).join(',')}`)

    const bottomBorder = lines
      .filter((line) => line.orientation === 'horizontal' && line.width > 400)
      .sort((left, right) => right.top - left.top)[0]
    assert.ok(bottomBorder, '续页必须绘制结构底边')
    assert.ok(bottomBorder.top < 250, `结构底边必须位于日期下方，实际 y=${bottomBorder.top}`)

    for (const x of [60.375, 535.125]) {
      const vertical = lines.find((line) =>
        line.orientation === 'vertical' && Math.abs(line.x - x) < 1)
      assert.ok(vertical, `续页必须续绘 x=${x} 的结构竖线`)
      assert.ok(vertical.bottom < 250,
        `结构竖线只能闭合到底边，不能贯穿续页：x=${x}，底部=${vertical.bottom}`)
      assert.ok(Math.abs(vertical.bottom - bottomBorder.top) < 2,
        `结构竖线必须闭合到底边：竖线=${vertical.bottom}，底边=${bottomBorder.top}`)
      assert.ok(Math.abs(vertical.lineWidth - 1.5) < 0.05,
        `结构竖线必须与顶部框线统一为 1.5pt，实际=${vertical.lineWidth}`)
    }
    assert.ok(Math.abs(bottomBorder.lineWidth - 1.5) < 0.05,
      `结构底边必须与顶部框线统一为 1.5pt，实际=${bottomBorder.lineWidth}`)
  } finally {
    await exportedPdf.destroy()
  }
})
