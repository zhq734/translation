import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { PrintToPDFOptions } from 'electron'
import type { DocumentModel } from '../src/shared/documentTypes.ts'
import {
  buildDocumentPrintCss,
  DocumentPdfPrintError,
  printDocumentPreviewToPdf,
  type DocumentPrintWebContents
} from '../src/main/documentPdfPrint.ts'

/**
 * 读取项目内文本文件。
 * @param path 相对项目根目录的路径。
 * @returns 文件文本。
 * @author zhenghq
 */
function read(path: string): string {
  return readFileSync(path, 'utf8')
}

/**
 * 构造打印测试文档。
 * @param width 页面宽度，单位为 PDF 点。
 * @param height 页面高度，单位为 PDF 点。
 * @returns 文档模型。
 * @author zhenghq
 */
function documentModel(width = 612, height = 792): DocumentModel {
  return {
    schemaVersion: 1,
    documentId: 'document-print-test',
    source: {
      path: '/tmp/test.pdf',
      fileName: 'test.pdf',
      format: 'pdf',
      sha256: 'abc',
      size: 1
    },
    metadata: { direction: 'ltr' },
    pages: [{
      pageId: 'page-1',
      index: 0,
      width,
      height,
      blocks: []
    }],
    assets: [],
    warnings: []
  }
}

/**
 * 构造 Markdown 打印测试文档。
 * @param height 页面高度，单位为 PDF 点。
 * @returns Markdown 文档模型。
 * @author zhenghq
 */
function markdownDocumentModel(height = 1056): DocumentModel {
  const model = documentModel(816, height)
  model.source.path = '/tmp/guide.md'
  model.source.fileName = 'guide.md'
  model.source.format = 'markdown'
  return model
}

/**
 * 构造其他连续流式格式的打印测试文档。
 * @param format 文档格式。
 * @returns 流式文档模型。
 * @author zhenghq
 */
function flowDocumentModel(format: DocumentModel['source']['format']): DocumentModel {
  // 文本类流式文档的模型尺寸使用 96 DPI 的 CSS 像素，对应标准 A4 纸张。
  const model = documentModel(816, 1056)
  model.source.path = `/tmp/guide.${format}`
  model.source.fileName = `guide.${format}`
  model.source.format = format
  return model
}

/**
 * 创建记录调用的打印 webContents 假对象。
 * @param printResult 打印返回的字节或抛出的异常。
 * @returns 假对象及其调用记录。
 * @author zhenghq
 */
function createWebContentsFake(printResult: Uint8Array | Error = new Uint8Array([37, 80, 68, 70])): {
  webContents: DocumentPrintWebContents
  insertedCss: string[]
  executedScripts: string[]
  printOptions: PrintToPDFOptions[]
  removedCssKeys: string[]
} {
  const insertedCss: string[] = []
  const executedScripts: string[] = []
  const printOptions: PrintToPDFOptions[] = []
  const removedCssKeys: string[] = []
  return {
    insertedCss,
    executedScripts,
    printOptions,
    removedCssKeys,
    webContents: {
      async insertCSS(css: string): Promise<string> {
        insertedCss.push(css)
        return 'document-print-css'
      },
      async removeInsertedCSS(key: string): Promise<void> {
        removedCssKeys.push(key)
      },
      async executeJavaScript(script: string): Promise<unknown> {
        executedScripts.push(script)
        return script.includes('document-page') ? { pageHeightCssPx: 1056 } : { ready: true }
      },
      async printToPDF(options: PrintToPDFOptions): Promise<Uint8Array> {
        printOptions.push(options)
        if (printResult instanceof Error) throw printResult
        return printResult
      }
    }
  }
}

/**
 * 创建按顺序返回执行结果的 webContents 假对象。
 * @param results executeJavaScript 的依次返回结果。
 * @returns 假对象及其调用记录。
 * @author zhenghq
 */
function createSequencedWebContentsFake(results: unknown[]): {
  webContents: DocumentPrintWebContents
  insertedCss: string[]
  executedScripts: string[]
  printOptions: PrintToPDFOptions[]
  removedCssKeys: string[]
} {
  const insertedCss: string[] = []
  const executedScripts: string[] = []
  const printOptions: PrintToPDFOptions[] = []
  const removedCssKeys: string[] = []
  return {
    insertedCss,
    executedScripts,
    printOptions,
    removedCssKeys,
    webContents: {
      async insertCSS(css: string): Promise<string> {
        insertedCss.push(css)
        return `document-print-css-${insertedCss.length}`
      },
      async removeInsertedCSS(key: string): Promise<void> {
        removedCssKeys.push(key)
      },
      async executeJavaScript(script: string): Promise<unknown> {
        executedScripts.push(script)
        const result = results.shift()
        if (result instanceof Error) throw result
        return result
      },
      async printToPDF(options: PrintToPDFOptions): Promise<Uint8Array> {
        printOptions.push(options)
        return new Uint8Array([37, 80, 68, 70])
      }
    }
  }
}

test('PDF 打印样式必须隐藏工作台并只保留译文预览', () => {
  const css = buildDocumentPrintCss(documentModel())

  assert.match(css, /@media print/u)
  assert.match(css, /@media screen,\s*print/u)
  assert.match(css, /@page\s*\{[\s\S]*?size:\s*612pt 792pt;[\s\S]*?margin:\s*0;/u)
  assert.match(css, /\.window-titlebar[\s\S]*?display:\s*none\s*!important/u)
  assert.match(css, /\.document-toolbar[\s\S]*?display:\s*none\s*!important/u)
  assert.match(css, /\.document-column:first-child[\s\S]*?display:\s*none\s*!important/u)
  assert.match(css, /#document-translation-content[\s\S]*?display:\s*block\s*!important/u)
  assert.match(css, /--document-page-scale:\s*1\.3333333333\s*!important/u)
  assert.match(css, /break-after:\s*page/u)
  assert.match(css, /\.document-page:last-child[\s\S]*?break-after:\s*auto/u)
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/iu)
})

test('下载 PDF 必须保留译文水印且打印时保持覆盖在正文上方', () => {
  const css = buildDocumentPrintCss(documentModel())
  const watermarkRule = /#document-translation-content \.document-translation-watermark\s*\{([^}]*)\}/u
    .exec(css)?.[1] ?? ''
  const patternRule = /#document-translation-content \.document-translation-watermark-pattern\s*\{([^}]*)\}/u
    .exec(css)?.[1] ?? ''

  assert.match(watermarkRule, /display:\s*block\s*!important/u)
  assert.match(watermarkRule, /position:\s*fixed\s*!important/u)
  assert.match(watermarkRule, /inset:\s*0\s*!important/u)
  assert.match(watermarkRule, /width:\s*100%\s*!important/u)
  assert.match(watermarkRule, /height:\s*100%\s*!important/u)
  assert.match(watermarkRule, /pointer-events:\s*none\s*!important/u)
  assert.match(watermarkRule, /z-index:\s*2\s*!important/u)
  assert.match(watermarkRule, /print-color-adjust:\s*exact/u)
  assert.match(patternRule, /display:\s*block\s*!important/u)
  assert.match(patternRule, /width:\s*100%\s*!important/u)
  assert.match(patternRule, /height:\s*100%\s*!important/u)
  assert.doesNotMatch(css, /\.document-translation-watermark[^{]*\{[^}]*display:\s*none/isu)
})

test('PDF 打印前必须按目标页面宽度固定水印横向起点，不能读取屏幕布局宽度', async () => {
  const fake = createWebContentsFake()
  await printDocumentPreviewToPdf(fake.webContents, documentModel())
  const waitScript = fake.executedScripts[0] ?? ''

  assert.match(waitScript, /document-translation-watermark/u)
  assert.match(waitScript, /querySelector\('pattern'\)/u)
  // A4 的 612pt 对应 816 CSS 像素，水印应向左平移 92px 以保持左右留白均衡。
  assert.match(waitScript, /const offset = -92;/u)
  assert.doesNotMatch(waitScript, /clientWidth/u)
})

test('PDF 水印横向起点必须随自定义纸张宽度变化', async () => {
  const fake = createWebContentsFake()
  await printDocumentPreviewToPdf(fake.webContents, documentModel(595.28, 841.89))
  const waitScript = fake.executedScripts[0] ?? ''

  // 595.28pt 对应约 793.707 CSS 像素，偏移应同步缩小到约 103.147px。
  assert.match(waitScript, /const offset = -103\.147;/u)
})

test('Markdown 导出水印必须按扣除纸张页边距后的内容宽度定位', async () => {
  const fake = createWebContentsFake()
  await printDocumentPreviewToPdf(fake.webContents, markdownDocumentModel())
  const waitScript = fake.executedScripts[0] ?? ''

  // 816 CSS 像素换算为 A4 的 612pt，再扣除左右各 0.35in 后对应 748.8 CSS 像素。
  assert.match(waitScript, /const offset = -125\.6;/u)
})

test('PDF 打印样式必须按文档页面尺寸生成 CSS 页面并回退有效尺寸', () => {
  const customCss = buildDocumentPrintCss(documentModel(595.28, 841.89))
  assert.match(customCss, /size:\s*595\.28pt 841\.89pt;/u)

  const fallbackCss = buildDocumentPrintCss(documentModel(Number.NaN, -1))
  assert.match(fallbackCss, /size:\s*612pt 792pt;/u)
})

test('PDF 打印样式必须把译文栏 OCR 原文打印层输出为透明可检索文字层', () => {
  const css = buildDocumentPrintCss(documentModel())

  // 打印时透明文字层必须重新显示，且整体不遮挡译文底图。
  const layerRule = /#document-translation-content \.document-ocr-print-text-layer\s*\{([^}]*)\}/u
    .exec(css)?.[1] ?? ''
  assert.match(layerRule, /display:\s*block\s*!important/u)
  assert.match(layerRule, /position:\s*absolute\s*!important/u)
  assert.match(layerRule, /z-index:\s*0\s*!important/u)
  assert.match(layerRule, /background:\s*transparent\s*!important/u)
  assert.match(layerRule, /pointer-events:\s*none\s*!important/u)

  // 每个 OCR 原文区域必须保持透明，但文字仍写入 PDF 文本层，支持检索和复制。
  const regionRule = /#document-translation-content \.document-ocr-print-text-layer \.document-ocr-text-region\s*\{([^}]*)\}/u
    .exec(css)?.[1] ?? ''
  assert.match(regionRule, /color:\s*transparent\s*!important/u)
  assert.match(regionRule, /background:\s*transparent\s*!important/u)
  assert.match(regionRule, /-webkit-text-fill-color:\s*transparent\s*!important/u)
})

test('PDF 打印页、Canvas 与 OCR 文字层必须共享同一页面矩形', () => {
  const css = buildDocumentPrintCss(documentModel())
  const pageRule = /#document-translation-content \.document-pdf-page\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const canvasRule = /#document-translation-content \.document-pdf-canvas\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const layerRule = /#document-translation-content \.document-ocr-print-text-layer\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const imageBlockRule = /#document-translation-content \.document-image-block\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''

  assert.match(pageRule, /width:\s*calc\(var\(--document-pdf-source-width\)\s*\*\s*1\.3333333333px\)/u)
  assert.match(pageRule, /height:\s*calc\(var\(--document-pdf-source-height\)\s*\*\s*1\.3333333333px\)/u)
  assert.match(pageRule, /content-visibility:\s*visible\s*!important/u)
  assert.match(pageRule, /contain-intrinsic-size:\s*none\s*!important/u)
  assert.match(canvasRule, /width:\s*100%\s*!important/u)
  assert.match(canvasRule, /height:\s*100%\s*!important/u)
  assert.match(layerRule, /left:\s*var\(--document-ocr-print-left,\s*0(?:px)?\)\s*!important/u)
  assert.match(layerRule, /top:\s*var\(--document-ocr-print-top,\s*0(?:px)?\)\s*!important/u)
  assert.match(layerRule, /width:\s*var\(--document-ocr-print-width,\s*100%\)\s*!important/u)
  assert.match(layerRule, /height:\s*var\(--document-ocr-print-height,\s*100%\)\s*!important/u)
  assert.doesNotMatch(layerRule, /inset:/u)
  assert.match(imageBlockRule, /position:\s*relative\s*!important/u)
  assert.match(imageBlockRule, /isolation:\s*isolate\s*!important/u)
})

test('OCR 原文打印前必须按底图真实矩形校正透明文字层', async () => {
  const fake = createWebContentsFake()
  await printDocumentPreviewToPdf(fake.webContents, documentModel(), undefined, true)
  const waitScript = fake.executedScripts[0] ?? ''

  // 图片块会因 OCR 译文变高，PDF 页也可能受内容可见性影响；文字层必须重新贴合底图而不是父容器。
  assert.match(waitScript, /querySelectorAll\([\s\S]*?\.document-ocr-print-text-layer/u)
  assert.match(waitScript, /\.document-image-block/u)
  assert.match(waitScript, /:scope > img\.document-page-image/u)
  assert.match(waitScript, /\.document-pdf-canvas/u)
  assert.match(waitScript, /getBoundingClientRect\(\)/u)
  assert.match(waitScript, /--document-ocr-print-left/u)
  assert.match(waitScript, /--document-ocr-print-top/u)
  assert.match(waitScript, /--document-ocr-print-width/u)
  assert.match(waitScript, /--document-ocr-print-height/u)
})

test('普通译文 PDF 打印不得测量 OCR 原文文字层', async () => {
  const fake = createWebContentsFake()
  await printDocumentPreviewToPdf(fake.webContents, documentModel())
  const waitScript = fake.executedScripts[0] ?? ''

  assert.doesNotMatch(waitScript, /document-ocr-print-text-layer/u)
  assert.doesNotMatch(waitScript, /--document-ocr-print-left/u)
})

test('PDF 打印样式不能把同行布局分组覆盖为纵向块', () => {
  const css = buildDocumentPrintCss(documentModel())

  assert.doesNotMatch(css, /\.document-flow-group[^{]*\{[^}]*display:\s*block\s*!important/isu)
  assert.doesNotMatch(css, /\.document-flow-group[^{]*\{[^}]*flex-direction:\s*column\s*!important/isu)
})

test('PDF 译文表格必须按整行分页且打印时不能横向裁切表格', () => {
  const css = buildDocumentPrintCss(documentModel())
  const tableRule = /#document-translation-content \.document-table-block\s*\{([^}]*)\}/u
    .exec(css)?.[1] ?? ''
  const rowRule = /#document-translation-content \.document-table-block tr\s*\{([^}]*)\}/u
    .exec(css)?.[1] ?? ''

  assert.match(tableRule, /overflow:\s*visible\s*!important/u)
  assert.match(rowRule, /break-inside:\s*avoid/u)
  assert.match(rowRule, /page-break-inside:\s*avoid/u)
})

test('PDF 导出必须等待预览资源稳定后按原页面尺寸打印并清理注入样式', async () => {
  const fake = createWebContentsFake()
  const result = await printDocumentPreviewToPdf(fake.webContents, documentModel())

  assert.deepEqual([...result.bytes], [37, 80, 68, 70])
  assert.deepEqual(result.warnings, [])
  assert.equal(fake.insertedCss.length, 1)
  assert.match(fake.insertedCss[0] ?? '', /@page/u)
  assert.equal(fake.executedScripts.length, 2)
  assert.match(fake.executedScripts[0] ?? '', /document\.fonts\.ready/u)
  assert.match(fake.executedScripts[0] ?? '', /\.decode\(\)/u)
  assert.match(fake.executedScripts[0] ?? '', /requestAnimationFrame/u)
  assert.match(fake.executedScripts[1] ?? '', /document-page/u)
  assert.equal(fake.printOptions.length, 1)
  assert.deepEqual(fake.printOptions[0], {
    printBackground: true,
    displayHeaderFooter: false,
    margins: { marginType: 'none' },
    preferCSSPageSize: true,
    pageSize: { width: 612 / 72, height: 792 / 72 }
  })
  assert.deepEqual(fake.removedCssKeys, ['document-print-css'])
})

test('PDF 打印必须按模型页高分页，不能把单页译文切成额外页', async () => {
  const fake = createSequencedWebContentsFake([{ ready: true }, { pageHeightCssPx: 1056 }])
  await printDocumentPreviewToPdf(fake.webContents, documentModel())

  assert.equal(fake.executedScripts.length, 2)
  assert.match(fake.executedScripts[0] ?? '', /document\.fonts\.ready/u)
  assert.match(fake.executedScripts[1] ?? '', /document-page/u)
  assert.match(fake.executedScripts[1] ?? '', /getBoundingClientRect/u)
  assert.match(fake.executedScripts[1] ?? '', /Math\.max/u)
})

test('PDF 打印分页结果异常时必须拒绝导出，不能生成截断文件', async () => {
  const fake = createSequencedWebContentsFake([{ ready: true }, { pageHeightCssPx: 0 }])

  await assert.rejects(
    printDocumentPreviewToPdf(fake.webContents, documentModel()),
    (error: unknown) => error instanceof DocumentPdfPrintError && error.code === 'export-failed'
  )
  assert.equal(fake.executedScripts.length, 2)
})

test('PDF 打印必须在译文高于原页时扩展页面高度以保留完整内容', async () => {
  const fake = createSequencedWebContentsFake([{ ready: true }, { pageHeightCssPx: 1200 }])
  await printDocumentPreviewToPdf(fake.webContents, documentModel())

  assert.equal(fake.insertedCss.length, 2)
  assert.match(fake.insertedCss[1] ?? '', /size:\s*612pt 900pt;/u)
  assert.deepEqual(fake.printOptions[0]?.pageSize, { width: 612 / 72, height: 900 / 72 })
  assert.deepEqual(fake.removedCssKeys, ['document-print-css-2', 'document-print-css-1'])
})

test('Markdown 连续译文必须按标准纸张自然分页，不能把整篇内容扩展为单页', async () => {
  const fake = createSequencedWebContentsFake([{ ready: true }, { pageHeightCssPx: 2400 }])
  await printDocumentPreviewToPdf(fake.webContents, markdownDocumentModel())

  assert.equal(fake.executedScripts.length, 1, 'Markdown 不应把整篇内容高度作为打印页高')
  assert.equal(fake.insertedCss.length, 1)
  assert.deepEqual(fake.printOptions[0]?.pageSize, { width: 612 / 72, height: 792 / 72 })
  assert.deepEqual(fake.removedCssKeys, ['document-print-css-1'])
})

test('DOCX 译文必须按 A4 纸张尺寸导出并保持页面水平居中', async () => {
  const model = flowDocumentModel('docx')
  const css = buildDocumentPrintCss(model)
  const flowPageRule = /#document-translation-content \.document-page\[data-layout='flow'\]\s*\{([^}]*)\}/u
    .exec(css)?.[1] ?? ''
  const fake = createSequencedWebContentsFake([{ ready: true }, { pageHeightCssPx: 2400 }])

  assert.match(css, /@page\s*\{[\s\S]*?size:\s*612pt 792pt;/u)
  assert.match(flowPageRule, /box-sizing:\s*border-box\s*!important/u)
  assert.match(flowPageRule, /width:\s*var\(--document-page-width,\s*100%\)\s*!important/u)
  assert.match(flowPageRule, /margin:\s*0 auto\s*!important/u)

  await printDocumentPreviewToPdf(fake.webContents, model)

  assert.deepEqual(fake.printOptions[0]?.pageSize, { width: 612 / 72, height: 792 / 72 })
})

test('所有非 PDF 流式译文都必须按标准纸张自然分页', async () => {
  for (const format of ['docx', 'epub', 'html', 'txt', 'json', 'csv', 'srt', 'vtt'] as const) {
    const fake = createSequencedWebContentsFake([{ ready: true }, { pageHeightCssPx: 2400 }])
    await printDocumentPreviewToPdf(fake.webContents, flowDocumentModel(format))

    assert.equal(fake.executedScripts.length, 1, `${format} 不应把整篇内容高度作为打印页高`)
    assert.equal(fake.insertedCss.length, 1)
  }
})

test('Markdown 打印样式必须允许连续内容跨页并避免标题与代码块被拆断', () => {
  const css = buildDocumentPrintCss(markdownDocumentModel())

  assert.match(css, /\.document-markdown-preview[\s\S]*?height:\s*auto\s*!important/u)
  assert.match(css, /\.document-markdown-preview[\s\S]*?overflow:\s*visible\s*!important/u)
  assert.match(css, /\.document-markdown-preview h1[\s\S]*?break-after:\s*avoid/u)
  assert.match(css, /\.document-markdown-preview pre[\s\S]*?break-inside:\s*avoid/u)
})

test('Markdown 打印必须保留每页四周边距、预览卡片的居中宽度与纸张配色', () => {
  const css = buildDocumentPrintCss(markdownDocumentModel())
  const markdownRule = /#document-translation-content \.document-markdown-preview\s*\{([^}]*)\}/u
    .exec(css)?.[1] ?? ''

  assert.match(css, /@page\s*\{[\s\S]*?margin:\s*0\.35in;/u)
  assert.doesNotMatch(css, /@page\s*\{[\s\S]*?margin:\s*16px;/u)
  assert.match(markdownRule, /display:\s*block\s*!important/u)
  assert.match(markdownRule, /width:\s*calc\(100%\s*-\s*64px\)\s*!important/u)
  assert.match(markdownRule, /max-width:\s*920px\s*!important/u)
  assert.match(markdownRule, /margin:\s*0 auto\s*!important/u)
  assert.match(markdownRule, /padding:\s*clamp\(16px,\s*4vw,\s*40px\)\s*!important/u)
  assert.match(markdownRule, /background:\s*var\(--document-paper-bg\)\s*!important/u)
  assert.match(markdownRule, /color:\s*var\(--document-paper-text\)\s*!important/u)
  assert.match(css, /\.document-markdown-preview\s*>\s*\*\s*\+\s*\*\s*\{[^}]*margin-top:\s*var\(--space-3\)/su)
})

test('PDF 打印失败时仍必须移除注入样式并返回稳定错误码', async () => {
  const fake = createWebContentsFake(new Error('printer unavailable'))

  await assert.rejects(
    printDocumentPreviewToPdf(fake.webContents, documentModel()),
    (error: unknown) => error instanceof DocumentPdfPrintError && error.code === 'export-failed'
  )
  assert.deepEqual(fake.removedCssKeys, ['document-print-css'])
})

test('PDF 打印必须拒绝没有页面的文档', async () => {
  const fake = createWebContentsFake()
  const model = documentModel()
  model.pages = []

  await assert.rejects(
    printDocumentPreviewToPdf(fake.webContents, model),
    (error: unknown) => error instanceof DocumentPdfPrintError && error.code === 'invalid-document'
  )
  assert.equal(fake.insertedCss.length, 0)
})

test('部分导出必须在打印前准备可见标记并在打印后恢复最新预览', async () => {
  const fake = createSequencedWebContentsFake([
    { ready: true },
    { pageHeightCssPx: 1056 },
    { restored: true }
  ])

  await printDocumentPreviewToPdf(fake.webContents, documentModel(), {
    mode: 'partial',
    summary: {
      total: 4,
      translated: 1,
      unchanged: 0,
      reverted: 3,
      failed: 1,
      pending: 1,
      suspectUntranslated: 1
    }
  })

  assert.equal(fake.executedScripts.length, 3)
  assert.match(fake.executedScripts[0] ?? '', /__documentPrintPreview/u)
  assert.match(fake.executedScripts[0] ?? '', /preparePartialExport/u)
  assert.match(fake.executedScripts[0] ?? '', /Partial result/u)
  assert.match(fake.executedScripts[2] ?? '', /restorePrintPreview/u)
})

test('部分导出准备失败时不得打印且必须尝试恢复预览', async () => {
  const fake = createSequencedWebContentsFake([
    new Error('prepare failed'),
    { restored: true }
  ])

  await assert.rejects(
    printDocumentPreviewToPdf(fake.webContents, documentModel(), {
      mode: 'partial',
      summary: {
        total: 1,
        translated: 0,
        unchanged: 0,
        reverted: 1,
        failed: 1,
        pending: 0,
        suspectUntranslated: 0
      }
    }),
    (error: unknown) => error instanceof DocumentPdfPrintError && error.code === 'export-failed'
  )
  assert.equal(fake.printOptions.length, 0)
  assert.equal(fake.executedScripts.length, 2)
  assert.match(fake.executedScripts[1] ?? '', /restorePrintPreview/u)
})

test('OCR 原文导出必须等待 PDF Canvas 并测量 PDF 页面高度以生成双层 PDF', async () => {
  const fake = createSequencedWebContentsFake([
    { ready: true },
    { pageHeightCssPx: 1056 }
  ])

  await printDocumentPreviewToPdf(fake.webContents, documentModel(), undefined, true)

  assert.match(fake.executedScripts[0] ?? '', /\.document-pdf-canvas/u)
  assert.match(fake.executedScripts[1] ?? '', /\.document-pdf-page/u)
})
