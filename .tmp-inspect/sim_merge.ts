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

const page = model.pages[1]!
const blocks = page.blocks.filter((b): b is any => b.kind === 'text' && b.bbox)
for (let i = 0; i < blocks.length - 1; i++) {
  const prev = blocks[i]!, cur = blocks[i + 1]!
  if (![694.2, 714.2, 726.2, 749.2, 777.2, 789.2].some(y => Math.abs((prev.bbox!.y ?? 0) - y) < 0.1)) continue
  const ps = dominantStyle(prev), cs = dominantStyle(cur)
  const prevText = prev.runs.map((r:any)=>r.text).join('')
  const curText = cur.runs.map((r:any)=>r.text).join('')
  const baselineAdvance = (cur.bbox!.y - prev.bbox!.y)
  console.log(`--- ${prev.readingOrder}->${cur.readingOrder} y=${Math.round(prev.bbox!.y*10)/10}->${Math.round(cur.bbox!.y*10)/10} adv=${baselineAdvance.toFixed(1)}`)
  console.log('  prev dom:', ps?.fontFamily, ps?.color, ps?.fontSize)
  console.log('  cur  dom:', cs?.fontFamily, cs?.color, cs?.fontSize)
  console.log('  sameStyle:', sameStyle(ps, cs))
  console.log('  prev x=', prev.bbox!.x, 'w=', prev.bbox!.width, ' cur x=', cur.bbox!.x, 'w=', cur.bbox!.width)
  console.log('  prev h=', prev.bbox!.height, 'cur h=', cur.bbox!.height)
  console.log('  prev text tail:', JSON.stringify(prevText.slice(-12)), ' cur head:', JSON.stringify(curText.slice(0,12)))
}
