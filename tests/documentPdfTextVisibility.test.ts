import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PDFDocument, StandardFonts, beginText, endText, moveText, rgb,
  setFontAndSize, setFillingRgbColor, showText
} from 'pdf-lib'
import { parsePdfDocument } from '../src/main/documentPdfParser.ts'
import type { DocumentBlock, DocumentModel, DocumentTextBlock } from '../src/shared/documentTypes.ts'
import { encodePng } from '../src/main/pngCodec.ts'
import { exportDocumentToPdf } from '../src/main/documentPdfExport.ts'

/**
 * 解析内存 PDF，避免回归测试依赖用户文件或外部服务。
 * @param document 测试 PDF。
 * @returns 解析模型。
 * @author zhenghq
 */
async function parse(document: PDFDocument): Promise<DocumentModel> {
  return parsePdfDocument({
    path: '/tmp/visibility.pdf', fileName: 'visibility.pdf', format: 'pdf',
    sha256: 'pdf-text-visibility', bytes: await document.save()
  })
}

/**
 * 递归读取普通段落与表格内的文本，避免布局分类干扰颜色断言。
 * @param blocks 模型区块。
 * @returns 文本区块数组。
 * @author zhenghq
 */
function texts(blocks: DocumentBlock[]): DocumentTextBlock[] {
  return blocks.flatMap(block => block.kind === 'text' ? [block] : block.kind === 'table'
    ? block.rows.flatMap(row => row.cells.flatMap(cell => texts(cell.blocks))) : [])
}

/**
 * 按正文定位区块的所有颜色。
 * @param model 文档模型。
 * @param text 目标文本。
 * @returns 颜色集合。
 * @author zhenghq
 */
function colors(model: DocumentModel, text: string): Set<string | undefined> {
  const block = model.pages.flatMap(page => texts(page.blocks))
    .find(block => block.runs.map(run => run.text).join('').includes(text))
  assert.ok(block, `未找到文本：${text}`)
  return new Set(block.runs.filter(run => run.text.trim()).map(run => run.style?.color))
}

test('逐字绘制被 PDF.js 合并后，按钮颜色不得串到后面的正文', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const key = page.node.newFontDictionary('F', font.ref)
  for (const [text, y, color] of [
    ['Heading', 730, rgb(0.1, 0.2, 0.3)],
    ['Button', 650, rgb(1, 1, 1)],
    ['Readable body after the button', 570, rgb(0.11, 0.11, 0.11)]
  ] as const) {
    page.pushOperators(beginText(), setFontAndSize(key, 12), setFillingRgbColor(color.red, color.green, color.blue), moveText(72, y))
    for (const character of text) page.pushOperators(showText(font.encodeText(character)))
    page.pushOperators(endText())
  }
  const model = await parse(document)
  assert.deepEqual(colors(model, 'Readable body'), new Set(['#1c1c1c']))
  assert.deepEqual(colors(model, 'Heading'), new Set(['#1a334c']))
})

test('空白显示操作不得消耗正文颜色，单次显示拆出的多个文本项应共用颜色', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  page.drawText(' ', { x: 72, y: 730, font, color: rgb(1, 1, 1) })
  page.drawText('Alpha          Beta', { x: 72, y: 650, size: 12, font, color: rgb(0.1, 0.2, 0.3) })
  page.drawText('Tail', { x: 72, y: 570, size: 12, font, color: rgb(0.2, 0.1, 0.1) })
  const model = await parse(document)
  assert.deepEqual(colors(model, 'Alpha'), new Set(['#1a334c']))
  assert.deepEqual(colors(model, 'Beta'), new Set(['#1a334c']))
  assert.deepEqual(colors(model, 'Tail'), new Set(['#331a1a']))
})

test('丢失矢量底色的白字应在重排纸面上可读，并按页提示保真降级', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  page.drawRectangle({ x: 60, y: 620, width: 160, height: 80, color: rgb(0.2, 0.1, 0.7) })
  page.drawText('Plan', { x: 72, y: 670, size: 12, font, color: rgb(1, 1, 1) })
  page.drawText('Verify', { x: 72, y: 640, size: 12, font, color: rgb(0.96, 0.96, 0.96) })
  const model = await parse(document)
  assert.deepEqual(colors(model, 'Plan'), new Set(['#1f2937']))
  assert.deepEqual(colors(model, 'Verify'), new Set(['#1f2937']))
  assert.equal(model.warnings.filter(warning => warning.code === 'pdf-text-contrast-adjusted').length, 1)
})

test('PDF.js 字节 RGB 中的 1 不得被放大成 255', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  page.drawText('Nearly black', { x: 72, y: 700, size: 12, font, color: rgb(1 / 255, 1 / 255, 1 / 255) })
  const model = await parse(document)
  assert.deepEqual(colors(model, 'Nearly black'), new Set(['#010101']))
})

test('同一文本项内颜色切换应保留分段，跨行合并不能丢失英文空格', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const key = page.node.newFontDictionary('F', font.ref)
  for (const y of [700, 686]) {
    page.pushOperators(beginText(), setFontAndSize(key, 12), moveText(72, y),
      setFillingRgbColor(0.6, 0, 0), showText(font.encodeText('Red ')),
      setFillingRgbColor(0, 0, 0.6), showText(font.encodeText('blue paragraph')), endText())
  }
  const model = await parse(document)
  const blocks = texts(model.pages[0]!.blocks)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]!.runs.map(run => run.text).join(''), 'Red blue paragraph Red blue paragraph')
  assert.deepEqual(colors(model, 'Red blue'), new Set(['#990000', '#000099']))
  const ids = blocks[0]!.runs.map(run => run.runId)
  assert.equal(new Set(ids).size, ids.length)
})

test('表单 XObject 的颜色不能泄漏到外层默认黑色正文', async () => {
  const embedded = await PDFDocument.create()
  const inner = embedded.addPage([200, 100])
  const font = await embedded.embedFont(StandardFonts.Helvetica)
  const key = inner.node.newFontDictionary('F', font.ref)
  inner.pushOperators(beginText(), setFontAndSize(key, 12), moveText(10, 50),
    setFillingRgbColor(0.6, 0, 0), showText(font.encodeText('Form text')), endText())
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  const [form] = await document.embedPdf(await embedded.save())
  page.drawPage(form!, { x: 72, y: 600 })
  const outerFont = await document.embedFont(StandardFonts.Helvetica)
  const outerKey = page.node.newFontDictionary('F', outerFont.ref)
  page.pushOperators(beginText(), setFontAndSize(outerKey, 12), moveText(72, 500),
    showText(outerFont.encodeText('Default black')), endText())
  const model = await parse(document)
  assert.deepEqual(colors(model, 'Form text'), new Set(['#990000']))
  assert.deepEqual(colors(model, 'Default black'), new Set(['#000000']))
})

test('不可见页外字形导致对齐失败时必须告警并安全回退，不能猜测正文颜色', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  page.drawText('Off page', { x: -900, y: 700, size: 12, font, color: rgb(1, 1, 1) })
  page.drawText('Visible body', { x: 72, y: 600, size: 12, font, color: rgb(0.1, 0.1, 0.1) })
  const model = await parse(document)
  assert.deepEqual(colors(model, 'Visible body'), new Set([undefined]))
  assert.equal(model.warnings.filter(warning => warning.code === 'pdf-text-color-unavailable').length, 1)
})

test('已有图片底图的白字覆盖层不能被纸面可读性兜底改黑', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  const data = new Uint8Array(16 * 16 * 4)
  for (let index = 3; index < data.length; index += 4) data[index] = 255
  const png = new Uint8Array(encodePng({ width: 16, height: 16, data }))
  const image = await document.embedPng(png)
  page.drawImage(image, { x: 100, y: 200, width: 300, height: 180 })
  page.drawText('White on image', { x: 140, y: 290, size: 16, font, color: rgb(1, 1, 1) })
  page.drawText('Body outside image', { x: 100, y: 150, size: 12, font })
  const model = await parsePdfDocument({
    path: '/tmp/overlay.pdf', fileName: 'overlay.pdf', format: 'pdf',
    sha256: 'overlay', bytes: await document.save()
  }, { renderEmbeddedImageToImage: async () => png, registerAssetBytes: () => undefined })
  assert.deepEqual(colors(model, 'White on image'), new Set(['#ffffff']))
  assert.equal(model.warnings.some(warning => warning.code === 'pdf-text-contrast-adjusted'), false)
})

test('解析可读性修复必须进入实际 PDF 导出，而不只是预览显示', async () => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([600, 800])
  page.drawRectangle({ x: 60, y: 640, width: 200, height: 80, color: rgb(0.1, 0.2, 0.5) })
  page.drawText('Plan Verify Ship', { x: 72, y: 680, size: 12, font, color: rgb(1, 1, 1) })
  page.drawText('Readable body', { x: 72, y: 580, size: 12, font, color: rgb(0.1, 0.1, 0.1) })
  const model = await parse(document)
  const exported = await exportDocumentToPdf(model, {
    loadFontBytes: async () => null, loadAssetBytes: async () => null
  })
  assert.deepEqual(exported.warnings, [])
  const reopened = await parsePdfDocument({
    path: '/tmp/exported.pdf', fileName: 'exported.pdf', format: 'pdf',
    sha256: 'visibility-exported', bytes: exported.bytes
  })
  assert.equal(reopened.pages.length, 1)
  assert.deepEqual(colors(reopened, 'Plan Verify Ship'), new Set(['#1f2937']))
  assert.deepEqual(colors(reopened, 'Readable body'), new Set(['#1a1a1a']))
  assert.equal(reopened.warnings.some(warning => warning.code === 'pdf-text-contrast-adjusted'), false)
})
