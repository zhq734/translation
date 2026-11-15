const fs = require('node:fs')
const canvas = require('@napi-rs/canvas')
global.DOMMatrix = canvas.DOMMatrix
global.Path2D = canvas.Path2D
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js')

/** 检查指定 PDF 页的文字与绘制颜色，并输出原页截图；参数来自命令行，无返回值。创建者：zhenghq。 */
async function inspect() {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(process.argv[2])), verbosity: 0 }).promise
  const page = await doc.getPage(Number(process.argv[3] || 4))
  const text = await page.getTextContent()
  const ops = await page.getOperatorList()
  const names = Object.fromEntries(Object.entries(pdfjs.OPS).map(([k, v]) => [v, k]))
  const shows = []
  let color = 'default'
  const stack = []
  ops.fnArray.forEach((op, i) => {
    const name = names[op]
    const args = ops.argsArray[i]
    if (name === 'save' || name === 'paintFormXObjectBegin') stack.push(color)
    if (name === 'restore' || name === 'paintFormXObjectEnd') color = stack.pop()
    if (name.startsWith('setFill')) color = JSON.stringify(args)
    if (name.includes('showText') || name.includes('ShowText')) shows.push({ color, text: args[0]?.map?.(g => g?.unicode || '').join(''), args: args[0]?.slice?.(0, 1) })
  })
  fs.writeFileSync('tmp/pdf-visibility-before/operators.json', JSON.stringify({ items: text.items, shows }, null, 2))
  const viewport = page.getViewport({ scale: 1.5 })
  const image = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  await page.render({ canvasContext: image.getContext('2d'), viewport }).promise
  fs.writeFileSync('tmp/pdf-visibility-before/source-page.png', image.toBuffer('image/png'))
  console.log({ items: text.items.length, shows: shows.length })
  await doc.destroy()
}
inspect().catch(error => { console.error(error); process.exitCode = 1 })
