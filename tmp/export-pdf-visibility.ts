import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { exportDocumentToPdf } from '../src/main/documentPdfExport.ts'
import type { DocumentModel } from '../src/shared/documentTypes.ts'

/**
 * 导出修复前后第 4 页并栅格化；只使用本地原文，不调用翻译服务。
 * @returns 无返回值，报告和验收文件写入临时目录。
 * @author zhenghq
 */
async function run(): Promise<void> {
  const require = createRequire(`${process.cwd()}/package.json`)
  const canvas = require('@napi-rs/canvas')
  Object.assign(globalThis, { DOMMatrix: canvas.DOMMatrix, Path2D: canvas.Path2D })
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js')
  for (const stage of ['before', 'after']) {
    const directory = `tmp/pdf-visibility-${stage}`
    const model = JSON.parse(readFileSync(`${directory}/model.json`, 'utf8')) as DocumentModel
    model.pages = [model.pages[3]!]
    const exported = await exportDocumentToPdf(model, {
      loadFontBytes: async () => readFileSync('assets/fonts/NotoSansSC-Regular.ttf'),
      loadAssetBytes: async () => null
    })
    assert.equal(exported.warnings.length, 0)
    writeFileSync(`${directory}/reflow-page-4.pdf`, exported.bytes)
    const pdf = await pdfjs.getDocument({ data: exported.bytes, verbosity: 0 }).promise
    const page = await pdf.getPage(1)
    const text = await page.getTextContent()
    const content = text.items.map((item: { str?: string }) => item.str ?? '').join('')
    for (const label of ['Brainstorm', 'Design', 'Plan', 'Execute', 'Verify', 'Ship', '可以把它们看成']) {
      assert.ok(content.includes(label), `导出缺少：${label}`)
    }
    const viewport = page.getViewport({ scale: 1.5 })
    const image = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    await page.render({ canvasContext: image.getContext('2d'), viewport }).promise
    writeFileSync(`${directory}/reflow-page-4.png`, image.toBuffer('image/png'))
    console.log(JSON.stringify({ stage, pages: pdf.numPages, bytes: exported.bytes.byteLength, characters: content.length }))
    await pdf.destroy()
  }
}
await run()
