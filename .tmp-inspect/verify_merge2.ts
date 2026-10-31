import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parsePdfDocument } from '/Users/mac/E/github/translation/src/main/documentPdfParser.ts'

const path = '/Users/mac/Downloads/web-page-translated.pdf'
const bytes = new Uint8Array(readFileSync(path))
const model = await parsePdfDocument({ path, fileName: 'web-page-translated.pdf', format: 'pdf', sha256: createHash('sha256').update(bytes).digest('hex'), bytes })
const page = model.pages[1]!
for (const block of page.blocks) {
  if (block.kind !== 'text') continue
  const text = block.runs.map(r => r.text).join('')
  if (!text.trim()) continue
  console.log('order=', block.readingOrder, 'y=', Math.round(block.bbox?.y ?? 0), '=>', text.slice(0, 40))
}
