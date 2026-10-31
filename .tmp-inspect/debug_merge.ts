import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parsePdfDocument } from '/Users/mac/E/github/translation/src/main/documentPdfParser.ts'

const path = '/Users/mac/Downloads/web-page-translated.pdf'
const bytes = new Uint8Array(readFileSync(path))
const model = await parsePdfDocument({ path, fileName: 'web-page-translated.pdf', format: 'pdf', sha256: createHash('sha256').update(bytes).digest('hex'), bytes })

// 复刻 dominant style 归一化逻辑
function norm(f: string | undefined): string {
  if (!f) return ''
  return f
    .replace(/^[A-Z]{6}\+/u, '')
    .replace(/[,_+\s-]+/gu, '')
    .replace(/(?:bold|black|heavy|semibold|demi|italic|oblique)$/u, '')
    .toLowerCase()
}
for (const block of model.pages[1]!.blocks) {
  if (block.kind !== 'text' || !block.bbox) continue
  if (![714.2, 726.2, 777.2, 789.2].some(y => Math.abs((block.bbox!.y ?? 0) - y) < 0.1)) continue
  // 计算 dominant item
  const items = block.runs.map(r => ({ text: r.text, style: r.style }))
  const candidates = items.map((item, index) => {
    const normalized = item.text.replace(/\s/gu, '')
    const marker = /^(?:[•●▪◦·*\uF0B7\uFFFD-]|\d+[.)、．]|[A-Za-z][.)])/u.exec(normalized)?.[0] ?? ''
    const trailingPunctuation = normalized.endsWith('。') || normalized.endsWith('.') ? 1 : 0
    return { item, index, weight: normalized.length - marker.length - trailingPunctuation }
  }).filter(c => c.weight > 0)
  const dominant = candidates.reduce((best, c) => {
    const w = c.item.text.replace(/\s/g,'').length
    return w > (best?.item?.text?.replace(/\s/g,'').length ?? -1) ? c : best
  }, undefined as any)
  const ds = dominant?.item?.style
  console.log('order=', block.readingOrder, 'y=', Math.round(block.bbox.y*10)/10,
    'domFamily=', ds?.fontFamily, 'norm=', norm(ds?.fontFamily), 'color=', ds?.color, 'weight=', ds?.fontWeight, 'size=', ds?.fontSize)
}
