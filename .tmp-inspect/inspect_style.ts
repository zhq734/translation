import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parsePdfDocument } from '/Users/mac/E/github/translation/src/main/documentPdfParser.ts'

const path = '/Users/mac/Downloads/web-page-translated.pdf'
const bytes = new Uint8Array(readFileSync(path))
const model = await parsePdfDocument({ path, fileName: 'web-page-translated.pdf', format: 'pdf', sha256: createHash('sha256').update(bytes).digest('hex'), bytes })
for (const block of model.pages[1]!.blocks) {
  if (block.kind !== 'text' || !block.bbox) continue
  if (![694.2, 714.2, 726.2, 749.2, 777.2, 789.2].some(y => Math.abs((block.bbox!.y ?? 0) - y) < 0.1)) continue
  console.log('order=', block.readingOrder, 'y=', Math.round(block.bbox.y*10)/10,
    'style=', JSON.stringify(block.runs.map(r => r.style)))
}
