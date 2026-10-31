import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parsePdfDocument } from '/Users/mac/E/github/translation/src/main/documentPdfParser.ts'

const path = '/Users/mac/Downloads/web-page-translated.pdf'
const bytes = new Uint8Array(readFileSync(path))
const model = await parsePdfDocument({ path, fileName: 'web-page-translated.pdf', format: 'pdf', sha256: createHash('sha256').update(bytes).digest('hex'), bytes })

function norm(f: string | undefined): string {
  if (!f) return ''
  return f.replace(/^[A-Z]{6}\+/u, '').replace(/[,_+\s-]+/gu, '')
    .replace(/(?:bold|black|heavy|semibold|demi|italic|oblique)$/u, '').toLowerCase()
}

for (const [pi, page] of model.pages.entries()) {
  if (pi < 1 || pi > 2) continue
  console.log('PAGE', pi)
  for (const b of page.blocks) {
    if (b.kind !== 'text' || !b.bbox) continue
    if (pi === 1 && ![694.2,714.2,726.2,777.2,789.2].some(y => Math.abs(b.bbox.y - y) < 0.1)) continue
    if (pi === 2 && ![54.7,66.8].some(y => Math.abs(b.bbox.y - y) < 0.1)) continue
    const fams = new Set<string>()
    const colors = new Set<string>()
    const sizes = new Set<string>()
    for (const r of b.runs) {
      if (r.style?.fontFamily) fams.add(`${norm(r.style.fontFamily)} (raw=${r.style.fontFamily})`)
      if (r.style?.color) colors.add(r.style.color)
      if (r.style?.fontSize) sizes.add(r.style.fontSize.toFixed(2))
    }
    console.log(` order=${b.readingOrder} y=${Math.round(b.bbox.y*10)/10}`)
    console.log('   fams:', [...fams].join(' | '))
    console.log('   colors:', [...colors].join(','))
    console.log('   sizes:', [...sizes].join(','))
  }
}
