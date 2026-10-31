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
function sameStyle(left: any, right: any): boolean {
  if (!left || !right) return left === right
  const l = left.fontSize ?? 0, r = right.fontSize ?? 0
  return Math.abs(l - r) <= Math.max(0.25, l * 0.03) &&
    norm(left.fontFamily) === norm(right.fontFamily) &&
    left.fontWeight === right.fontWeight && left.color === right.color && left.italic === right.italic
}
function dominantStyle(block: any): any {
  const candidates = block.runs.map((r: any, index: number) => {
    const normalized = r.text.replace(/\s/gu, '')
    const marker = /^(?:[•●▪◦·*\uF0B7\uFFFD-]|\d+[.)、．]|[A-Za-z][.)])/u.exec(normalized)?.[0] ?? ''
    const trailingPunctuation = normalized.endsWith('。') || normalized.endsWith('.') ? 1 : 0
    return { item: r, index, weight: normalized.length - marker.length - trailingPunctuation }
  }).filter((c: any) => c.weight > 0)
  if (candidates.length === 0) return undefined
  return candidates.reduce((best: any, candidate: any) => {
    const bestStyle = best.item.style, candidateStyle = candidate.item.style
    if (candidate.weight !== best.weight) return candidate.weight > best.weight ? candidate : best
    return sameStyle(candidateStyle, bestStyle) ? best : candidate.index < best.index ? candidate : best
  }).item.style
}

for (const [pi, page] of model.pages.entries()) {
  if (pi < 1 || pi > 3) continue
  console.log('PAGE', pi)
  const textBlocks = page.blocks.filter((b): b is any => b.kind === 'text' && b.bbox)
  for (let i = 0; i < textBlocks.length; i++) {
    const b = textBlocks[i]!
    const d = dominantStyle(b)
    const text = b.runs.map((r:any)=>r.text).join('')
    console.log(` order=${String(b.readingOrder).padStart(3)} x=${Math.round(b.bbox.x)} y=${Math.round(b.bbox.y)} w=${Math.round(b.bbox.width)} dom=${d?.fontFamily ?? '?'}|${d?.color ?? '?'}|${d?.fontSize?.toFixed(1)} len=${text.length} tail=${JSON.stringify(text.slice(-6))}`)
  }
}
