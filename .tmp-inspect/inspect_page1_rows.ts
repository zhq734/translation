import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parsePdfDocument } from '/Users/mac/E/github/translation/src/main/documentPdfParser.ts'

const path = '/Users/mac/Downloads/web-page-translated.pdf'
const bytes = new Uint8Array(readFileSync(path))
const model = await parsePdfDocument({ path, fileName: 'web-page-translated.pdf', format: 'pdf', sha256: createHash('sha256').update(bytes).digest('hex'), bytes })
const page = model.pages[0]!
for (const block of page.blocks) {
  if (!block.bbox) continue
  const kind = block.kind
  const text = block.kind === 'text' ? block.runs.map((r) => r.text).join('').slice(0, 30) : (block.kind === 'image' ? 'IMG' : (block.kind === 'shape' ? 'SHAPE' : 'other'))
  console.log('order=', String(block.readingOrder).padStart(3), 'y=', Math.round(block.bbox.y * 10) / 10, 'x=', Math.round(block.bbox.x * 10) / 10, 'w=', Math.round(block.bbox.width * 10) / 10, 'flow=', block.flowGroupId, kind, JSON.stringify(text))
}
