import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parsePdfDocument } from '/Users/mac/E/github/translation/src/main/documentPdfParser.ts'

const path = '/Users/mac/Downloads/web-page-translated-translated.pdf'
const bytes = new Uint8Array(readFileSync(path))
const model = await parsePdfDocument({
  path,
  fileName: 'web-page-translated-translated.pdf',
  format: 'pdf',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes
})
console.log(JSON.stringify({
  pages: model.pages.length,
  warnings: model.warnings,
  summary: model.pages.map((page) => ({
    page: page.index + 1,
    width: page.width,
    height: page.height,
    blocks: page.blocks.map((block) => {
      if (block.kind === 'text') {
        const text = block.runs.map((run) => run.text).join('')
        return { kind: block.kind, id: block.blockId, translatable: block.translatable, role: block.role, bbox: block.bbox, text: text.slice(0, 500), length: text.length }
      }
      if (block.kind === 'table') return { kind: block.kind, id: block.blockId, translatable: block.translatable, bbox: block.bbox, rows: block.rows.length, text: block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.blocks.flatMap((child) => child.kind === 'text' ? child.runs.map((run) => run.text).join('') : []))).join(' | ').slice(0, 500) }
      return { kind: block.kind, id: block.blockId, translatable: block.translatable, bbox: block.bbox }
    })
  }))
}, null, 2))
