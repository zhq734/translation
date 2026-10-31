import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parsePdfDocument } from '/Users/mac/E/github/translation/src/main/documentPdfParser.ts'

const path = '/Users/mac/Downloads/web-page-translated.pdf'
const bytes = new Uint8Array(readFileSync(path))
const model = await parsePdfDocument({ path, fileName: 'web-page-translated.pdf', format: 'pdf', sha256: createHash('sha256').update(bytes).digest('hex'), bytes })

function summarize(block: any) {
  const buckets = new Map<string, {count:number, family:string, bold?:boolean}>()
  for (const r of block.runs) {
    const key = `${r.style?.color ?? '?'}|${r.style?.fontFamily ?? '?'}|${r.style?.fontWeight ?? ''}`
    const b = buckets.get(key) ?? {count:0, family: r.style?.fontFamily ?? '?', bold: r.style?.fontWeight}
    b.count += r.text.replace(/\s/g,'').length
    buckets.set(key, b)
  }
  return [...buckets.entries()].sort((a,b)=>b[1].count-a[1].count).map(([k,v])=>`${k} n=${v.count}`).join(' ; ')
}

for (const [pi, page] of model.pages.entries()) {
  if (pi > 2) continue
  console.log('PAGE', pi)
  for (const block of page.blocks) {
    if (block.kind !== 'text' || !block.bbox) continue
    if (!block.runs.some(r => r.style?.color === '#59636e')) continue
    console.log(' order=', block.readingOrder, 'y=', Math.round(block.bbox.y*10)/10, summarize(block))
  }
}
