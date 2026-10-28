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
 * 读取 PDF 第一页的可复制文本层。
 * @param bytes 已导出的 PDF 字节。
 * @returns PDF.js 提取到的文本内容。
 * @author zhenghq
 */
async function extractFirstPageText(bytes: Uint8Array): Promise<string> {
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const textContent = await (await exportedPdf.getPage(1)).getTextContent()
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
    loadFontBytes: async () => null,
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
    const items = content.items.filter((item): item is typeof item & { str: string; transform: number[] } =>
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

test('PDF 导出必须保留 OCR 译文字号与居中对齐', async () => {
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
    }]
  }]

  const { bytes } = await exportDocumentToPdf(model, {
    loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
    loadAssetBytes: async () => readFileSync('tests/fixtures/ocr-scaling/clear.png')
  })
  const exportedPdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  try {
    const textContent = await (await exportedPdf.getPage(1)).getTextContent()
    const item = textContent.items.find((candidate) => 'str' in candidate && candidate.str === 'Centered OCR')
    assert.ok(item && 'transform' in item)
    const transform = item.transform as number[]
    const fontSize = Math.hypot(transform[2] ?? 0, transform[3] ?? 0)
    assert.ok(Math.abs(fontSize - 24) < 1)
    // 区域范围是 x=70..250；文本宽度约 156.8，居中后起点应接近 81.6。
    const textWidth = 'width' in item ? Number(item.width) : 0
    const expectedX = 70 + (180 - textWidth) / 2
    assert.ok(Math.abs((transform[4] ?? 0) - expectedX) < 2)
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

test('PDF 中前序 OCR 译文变短后，后续区域必须紧接实际底边而不能跳回原始顶边', async () => {
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
    // 首条实际高度为 13.8，原区域高 60；第二条应只保留 30 的原始行间空白。
    assert.ok(
      Math.abs(secondTop - (firstTop + 13.8 + 30)) < 2,
      `second OCR must follow actual bottom: first=${firstTop}, second=${secondTop}`
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
