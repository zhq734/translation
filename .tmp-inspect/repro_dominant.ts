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
function samePdfParagraphStyle(left: any, right: any): boolean {
  if (!left || !right) return left === right
  const leftSize = left.fontSize ?? 0
  const rightSize = right.fontSize ?? 0
  return Math.abs(leftSize - rightSize) <= Math.max(0.25, leftSize * 0.03) &&
    norm(left.fontFamily) === norm(right.fontFamily) &&
    left.fontWeight === right.fontWeight &&
    left.color === right.color &&
    left.italic === right.italic
}
function dominantStyle(block: any): any {
  const candidates = block.runs.map((r: any, index: number) => {
    const normalized = r.text.replace(/\s/gu, '')
    const marker = /^(?:[•●▪◦·*\uF0B7\uFFFD-]|\d+[.)、．]|[A-Za-z][.)])/u.exec(normalized)?.[0] ?? ''
    const trailingPunctuation = normalized.endsWith('。') || normalized.endsWith('.') ? 1 : 0
    return { item: r, index, weight: normalized.length - marker.length - trailingPunctuation }
  }).filter((c: any) => c.weight > 0)
  if (candidates.length === 0) return undefined
  const dominant = candidates.reduce((best: any, candidate: any) => {
    const bestStyle = best.item.style
    const candidateStyle = candidate.item.style
    if (candidate.weight !== best.weight) return candidate.weight > best.weight ? candidate : best
    return samePdfParagraphStyle(candidateStyle, bestStyle) ? best : candidate.index < best.index ? candidate : best
  })
  return dominant.item.style
}
function sameLine(a: any, b: any): boolean {
  return Math.abs(a.fontSize - b.fontSize) <= Math.max(0.25, a.fontSize*0.03) &&
    norm(a.fontFamily) === norm(b.fontFamily) && a.fontWeight === b.fontWeight &&
    a.color === b.color && a.italic === b.italic
}
const page = model.pages[1]!
for (const block of page.blocks) {
  if (block.kind !== 'text' || !block.bbox) continue
  if (![694.2, 714.2, 726.2, 777.2, 789.2].some(y => Math.abs((block.bbox!.y ?? 0) - y) < 0.1)) continue
  const d = dominantStyle(block)
  console.log('order=', block.readingOrder, 'y=', Math.round(block.bbox.y*10)/10,
    'dom=', d?.fontFamily, '|', d?.color, '|', d?.fontWeight, '|', d?.fontSize, '| italic=', d?.italic)
}
