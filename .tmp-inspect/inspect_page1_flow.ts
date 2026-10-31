import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parsePdfDocument } from '/Users/mac/E/github/translation/src/main/documentPdfParser.ts'

const path = '/Users/mac/Downloads/web-page-translated.pdf'
const bytes = new Uint8Array(readFileSync(path))
const model = await parsePdfDocument({ path, fileName: 'web-page-translated.pdf', format: 'pdf', sha256: createHash('sha256').update(bytes).digest('hex'), bytes })
const page = model.pages[0]!
for (const block of page.blocks) {
  if (block.kind !== 'text') continue
  if (block.bbox && (block.bbox.y < 300 || block.bbox.y > 400)) continue
  const text = block.runs.map(r => r.text).join('')
  console.log('order=', block.readingOrder, 'bbox=', block.bbox, 'flow=', block.flowGroupId, 'align=', block.textAlign, 'text=', JSON.stringify(text))
}
