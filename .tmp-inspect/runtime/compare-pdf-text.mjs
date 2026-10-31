import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js')

async function extract(path) {
  const bytes = new Uint8Array(await readFile(path))
  const document = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise
  const page = await document.getPage(1)
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const items = content.items.filter((item) => 'str' in item).map((item) => ({
    text: item.str,
    x: item.transform[4],
    y: item.transform[5],
    top: viewport.height - item.transform[5],
    width: item.width,
    height: item.height,
    fontName: item.fontName
  }))
  await document.destroy()
  return { items, width: viewport.width, height: viewport.height }
}

const source = await extract(process.argv[2])
const output = await extract(process.argv[3])
const sourceCounts = new Map()
for (const item of source.items) sourceCounts.set(item.text, (sourceCounts.get(item.text) ?? 0) + 1)
const outputCounts = new Map()
for (const item of output.items) outputCounts.set(item.text, (outputCounts.get(item.text) ?? 0) + 1)
const added = []
for (const [text, count] of outputCounts) {
  const delta = count - (sourceCounts.get(text) ?? 0)
  if (delta > 0) added.push({ text, count: delta })
}
console.log(JSON.stringify({
  source: { width: source.width, height: source.height, count: source.items.length },
  output: { width: output.width, height: output.height, count: output.items.length },
  addedCount: added.reduce((sum, item) => sum + item.count, 0),
  added: added.slice(0, 100),
  outputItemsAroundLogo: output.items.filter((item) => item.x > 400 && item.top < 150).slice(0, 100)
}, null, 2))
