import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js')

for (const path of process.argv.slice(2)) {
  const bytes = new Uint8Array(await readFile(path))
  const document = await pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    verbosity: 0
  }).promise
  console.log(`\nFILE ${path}`)
  console.log('pages', document.numPages)
  const metadata = await document.getMetadata().catch(() => null)
  console.log('metadata', JSON.stringify(metadata?.info ?? {}, null, 2))
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const items = content.items.filter((item) => 'str' in item && item.str.trim())
    const transforms = items.slice(0, 12).map((item) => ({
      text: item.str.slice(0, 80),
      x: Number(item.transform[4].toFixed(2)),
      y: Number(item.transform[5].toFixed(2)),
      top: Number((viewport.height - item.transform[5]).toFixed(2)),
      width: Number(item.width.toFixed(2))
    }))
    const imageOps = await page.getOperatorList()
    const imageCount = imageOps.fnArray.filter((fn) => fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject).length
    console.log(JSON.stringify({
      page: pageNumber,
      size: [Number(viewport.width.toFixed(2)), Number(viewport.height.toFixed(2))],
      rotation: page.rotate,
      textCount: items.length,
      imageCount,
      transforms
    }, null, 2))
  }
  await document.destroy()
}
