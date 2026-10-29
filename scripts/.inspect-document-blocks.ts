import { readFileSync } from 'node:fs'
import { parsePdfDocument } from '../src/main/documentPdfParser.ts'
const path = '/Users/mac/Downloads/转换套件产品接口文档 (1).pdf'
const started = performance.now()
const model = await parsePdfDocument({ path, fileName: '转换套件产品接口文档 (1).pdf', format: 'pdf', sha256: 'inspect', bytes: readFileSync(path) })
for (const [index, page] of model.pages.entries()) {
  const counts: Record<string, number> = {}
  for (const block of page.blocks) counts[block.kind] = (counts[block.kind] ?? 0) + 1
  if (counts.table || counts.image) {
    console.log(JSON.stringify({ index, page: index + 1, counts, blocks: page.blocks.filter((b) => b.kind === 'table' || b.kind === 'image').map((b) => ({ kind: b.kind, bbox: b.bbox, rows: b.kind === 'table' ? b.rows.length : undefined, assetId: b.kind === 'image' ? b.assetId : undefined })) }))
  }
}
console.log(JSON.stringify({ elapsed: performance.now() - started, pages: model.pages.length, totalBlocks: model.pages.flatMap((p) => p.blocks).length }))
