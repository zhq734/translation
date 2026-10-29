import { readFileSync } from 'node:fs'
import { parsePdfDocument } from '../src/main/documentPdfParser.ts'

const path = '/Users/mac/Downloads/转换套件产品接口文档 (1).pdf'
const model = await parsePdfDocument({
  path,
  fileName: '转换套件产品接口文档 (1).pdf',
  format: 'pdf',
  sha256: 'inspect-page75',
  bytes: readFileSync(path)
})
const page = model.pages[74]!
for (const block of page.blocks) {
  if (block.kind === 'text') {
    console.log(JSON.stringify({
      kind: block.kind,
      role: block.role,
      bbox: block.bbox,
      codeFrame: block.codeFrame,
      text: block.runs.map((run) => run.text).join('')
    }))
  } else {
    console.log(JSON.stringify({ kind: block.kind, bbox: block.bbox, line: block.kind === 'shape' ? block.line : undefined }))
  }
}
