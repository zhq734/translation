import assert from 'node:assert/strict'
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
        return results.shift()
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

test('PDF 打印样式必须按文档页面尺寸生成 CSS 页面并回退有效尺寸', () => {
  const customCss = buildDocumentPrintCss(documentModel(595.28, 841.89))
  assert.match(customCss, /size:\s*595\.28pt 841\.89pt;/u)

  const fallbackCss = buildDocumentPrintCss(documentModel(Number.NaN, -1))
  assert.match(fallbackCss, /size:\s*612pt 792pt;/u)
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
