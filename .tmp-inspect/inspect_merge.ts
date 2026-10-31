import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parsePdfDocument } from '/Users/mac/E/github/translation/src/main/documentPdfParser.ts'

const path = '/Users/mac/Downloads/web-page-translated.pdf'
const bytes = new Uint8Array(readFileSync(path))
const model = await parsePdfDocument({ path, fileName: 'web-page-translated.pdf', format: 'pdf', sha256: createHash('sha256').update(bytes).digest('hex'), bytes })
for (const [pi, page] of model.pages.entries()) {
  if (pi > 2) continue
  console.log('PAGE', pi)
  for (const block of page.blocks) {
    if (block.kind !== 'text' || !block.bbox) continue
    const text = block.runs.map(r => r.text).join('')
    if (!text.trim()) continue
    console.log('  order=', String(block.readingOrder).padStart(3),
      'y=', Math.round(block.bbox.y*10)/10,
      'h=', Math.round(block.bbox.height*10)/10,
      'w=', Math.round(block.bbox.width*10)/10,
      'fontSize=', block.runs[0]?.style?.fontSize,
      'lineHeight=', block.runs[0]?.style?.lineHeight,
      'role=', block.role,
      'align=', block.textAlign,
      'flow=', block.flowGroupId,
      JSON.stringify(text.slice(0,40)))
  }
}
