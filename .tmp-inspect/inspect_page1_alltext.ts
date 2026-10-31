import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parsePdfDocument } from '/Users/mac/E/github/translation/src/main/documentPdfParser.ts'

const path = '/Users/mac/Downloads/web-page-translated.pdf'
const bytes = new Uint8Array(readFileSync(path))
const model = await parsePdfDocument({ path, fileName: 'web-page-translated.pdf', format: 'pdf', sha256: createHash('sha256').update(bytes).digest('hex'), bytes })
for (const [pi, page] of model.pages.entries()) {
  console.log('PAGE', pi)
  for (const block of page.blocks) {
    if (block.kind !== 'text') continue
    const text = block.runs.map(r => r.text).join('')
    if (!text.trim()) continue
    console.log('  order=', String(block.readingOrder).padStart(3), 'x=', Math.round((block.bbox?.x ?? 0)*10)/10, 'y=', Math.round((block.bbox?.y ?? 0)*10)/10, 'w=', Math.round((block.bbox?.width ?? 0)*10)/10, 'flow=', block.flowGroupId, JSON.stringify(text.slice(0,80)))
  }
}
