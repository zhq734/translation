import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parsePdfDocument } from '/Users/mac/E/github/translation/src/main/documentPdfParser.ts'

const path = '/Users/mac/Downloads/web-page-translated.pdf'
const bytes = new Uint8Array(readFileSync(path))
const model = await parsePdfDocument({ path, fileName: 'web-page-translated.pdf', format: 'pdf', sha256: createHash('sha256').update(bytes).digest('hex'), bytes })

for (const [pi, page] of model.pages.entries()) {
  if (pi < 1 || pi > 2) continue
  console.log('PAGE', pi)
  for (const block of page.blocks) {
    if (block.kind !== 'text') continue
    const text = block.runs.map(r => r.text).join('')
    if (!text.trim()) continue
    if (text.includes('亞惟润滑油') || text.includes('连接编辑器') || text.includes('统一模型网关') || text.includes('远程节点')) {
      console.log('--- order=', block.readingOrder, 'y=', Math.round(block.bbox?.y ?? 0 * 10)/10)
      console.log(text)
    }
  }
}
