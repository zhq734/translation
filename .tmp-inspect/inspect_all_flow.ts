import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parsePdfDocument } from '/Users/mac/E/github/translation/src/main/documentPdfParser.ts'

const path = '/Users/mac/Downloads/web-page-translated.pdf'
const bytes = new Uint8Array(readFileSync(path))
const model = await parsePdfDocument({ path, fileName: 'web-page-translated.pdf', format: 'pdf', sha256: createHash('sha256').update(bytes).digest('hex'), bytes })
for (const [pi, page] of model.pages.entries()) {
  const groups = new Map<string, typeof page.blocks>()
  for (const block of page.blocks) {
    if (!block.flowGroupId) continue
    const arr = groups.get(block.flowGroupId) ?? []
    arr.push(block)
    groups.set(block.flowGroupId, arr)
  }
  for (const [gid, blocks] of groups) {
    const left = Math.min(...blocks.map(b => b.bbox?.x ?? 0))
    const right = Math.max(...blocks.map(b => (b.bbox?.x ?? 0) + (b.bbox?.width ?? 0)))
    const top = Math.min(...blocks.map(b => b.bbox?.y ?? 0))
    const bottom = Math.max(...blocks.map(b => (b.bbox?.y ?? 0) + (b.bbox?.height ?? 0)))
    const text = blocks.map(b => b.kind === 'text' ? b.runs.map(r => r.text).join('') : b.kind).join(' | ')
    console.log(`p${pi} ${gid} x=${left.toFixed(1)}-${right.toFixed(1)} y=${top.toFixed(1)}-${bottom.toFixed(1)} :: ${text}`)
  }
}
