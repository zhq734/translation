import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parsePdfDocument } from '/Users/mac/E/github/translation/src/main/documentPdfParser.ts'

const path = '/Users/mac/Downloads/web-page-translated.pdf'
const bytes = new Uint8Array(readFileSync(path))
const model = await parsePdfDocument({ path, fileName: 'web-page-translated.pdf', format: 'pdf', sha256: createHash('sha256').update(bytes).digest('hex'), bytes })
for (const block of model.pages[0]!.blocks) {
  if (block.kind !== 'text' || !block.bbox) continue
  const y = Math.round(block.bbox.y * 10) / 10
  if (![39.2, 61.8, 216.3, 264.3, 294.3].includes(y)) continue
  const r = block.runs[0]
  console.log('y=', y, 'x=', Math.round(block.bbox.x*10)/10, JSON.stringify(r.style), JSON.stringify(block.style))
}
