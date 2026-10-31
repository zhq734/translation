import { readFileSync } from 'node:fs'
import { parsePdfDocument } from '../src/main/documentPdfParser.ts'

const path = '/Users/mac/Downloads/web-page-translated.pdf'
const model = await parsePdfDocument({
  path,
  fileName: 'web-page-translated.pdf',
  format: 'pdf',
  sha256: 'web-page-translated',
  bytes: readFileSync(path)
})

const report = []
for (const [index, page] of model.pages.entries()) {
  const blocks = page.blocks.map((block) => {
    if (block.kind === 'table') {
      return {
        kind: block.kind,
        bbox: block.bbox,
        rows: block.rows.length,
        columns: block.columnWidths?.length,
        columnWidths: block.columnWidths,
        texts: block.rows.flatMap((row) => row.cells.flatMap((cell) =>
          cell.blocks.flatMap((child) => child.kind === 'text'
            ? [child.runs.map((run) => run.text).join('')]
            : [])))
      }
    }
    if (block.kind === 'text') {
      return {
        kind: block.kind,
        role: block.role,
        bbox: block.bbox,
        text: block.runs.map((run) => run.text).join(''),
        codeFrame: block.codeFrame
      }
    }
    return { kind: block.kind, bbox: block.bbox, line: block.line }
  })
  report.push({ page: index + 1, blocks })
}
console.log(JSON.stringify(report, null, 2))
