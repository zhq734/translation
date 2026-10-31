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
  if (pi !== 2) continue
  const blocks = page.blocks.filter((b): b is any => b.kind === 'text' && b.bbox)
  for (let i = 0; i < blocks.length - 1; i++) {
    const prev = blocks[i]!, cur = blocks[i + 1]!
    if (![28.7, 54.7, 66.8].some(y => Math.abs((prev.bbox!.y ?? 0) - y) < 0.1)) continue
    const ps = dominantStyle(prev), cs = dominantStyle(cur)
    console.log(`${prev.readingOrder}->${cur.readingOrder} y=${Math.round(prev.bbox!.y*10)/10}->${Math.round(cur.bbox!.y*10)/10} adv=${((cur.bbox!.y - prev.bbox!.y)).toFixed(1)}`)
    console.log('  prev dom:', ps?.fontFamily, ps?.color, ps?.fontSize, 'lh=', prev.runs[0]?.style?.lineHeight)
    console.log('  cur  dom:', cs?.fontFamily, cs?.color, cs?.fontSize)
    console.log('  sameStyle:', sameStyle(ps, cs), ' sameLeftX=', Math.abs((cur.bbox!.x)-(prev.bbox!.x)).toFixed(1))
  }
}
