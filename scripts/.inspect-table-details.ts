import { readFileSync } from 'node:fs'
import { parsePdfDocument } from '../src/main/documentPdfParser.ts'

const path = '/Users/mac/Downloads/转换套件产品接口文档 (1).pdf'
const model = await parsePdfDocument({
  path,
  fileName: '转换套件产品接口文档 (1).pdf',
  format: 'pdf',
  sha256: 'inspect-table-details',
  bytes: readFileSync(path)
})

const targetPages = new Set([5, 6, 72, 75, 77, 78, 79, 82])
for (const page of model.pages) {
  const pageNumber = page.index + 1
  if (!targetPages.has(pageNumber)) continue
  const tables = page.blocks.filter((block) => block.kind === 'table')
  const images = page.blocks.filter((block) => block.kind === 'image')
  const shapes = page.blocks.filter((block) => block.kind === 'shape')
  const cellImages = tables.flatMap((table) => table.kind === 'table'
    ? table.rows.flatMap((row, rowIndex) => row.cells.flatMap((cell, cellIndex) =>
        cell.blocks.filter((child) => child.kind === 'image').map((child) => ({
          rowIndex,
          cellIndex,
          child
        }))))
    : [])
  console.log(`\nPAGE ${pageNumber} tables=${tables.length} pageImages=${images.length} cellImages=${cellImages.length} shapes=${shapes.length}`)
  for (const [tableIndex, table] of tables.entries()) {
    if (table.kind !== 'table') continue
    console.log(JSON.stringify({
      tableIndex,
      blockId: table.blockId,
      bbox: table.bbox,
      columns: table.columnWidths,
      rows: table.rows.length,
      rowCells: table.rows.map((row) => row.cells.length),
    }))
  }
  for (const entry of cellImages) {
    const child = entry.child
    if (child.kind !== 'image') continue
    console.log(JSON.stringify({
      cellImage: {
        rowIndex: entry.rowIndex,
        cellIndex: entry.cellIndex,
        blockId: child.blockId,
        bbox: child.bbox,
        assetId: child.assetId,
        renderPending: child.renderPending
      }
    }))
  }
  for (const image of images) {
    if (image.kind !== 'image') continue
    console.log(JSON.stringify({ pageImage: { blockId: image.blockId, bbox: image.bbox, assetId: image.assetId } }))
  }
  for (const shape of shapes) {
    if (shape.kind !== 'shape') continue
    console.log(JSON.stringify({ shape: { blockId: shape.blockId, bbox: shape.bbox, line: shape.line } }))
  }
}
