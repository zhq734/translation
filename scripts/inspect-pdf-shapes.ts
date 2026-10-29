import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as pdfjsWorkerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'

const require = createRequire(import.meta.url)
const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as typeof pdfjsModule
const worker = ('default' in pdfjsWorkerModule ? pdfjsWorkerModule.default : pdfjsWorkerModule) as unknown
;(globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker = worker
void require

const path = '/Users/mac/Downloads/转换套件产品接口文档 (1).pdf'
const bytes = readFileSync(path)
const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise
const operationNames = Object.fromEntries(Object.entries(pdfjs.OPS).map(([name, value]) => [value, name]))
const watchedOperations = new Set([
  'save', 'restore', 'transform', 'paintFormXObjectBegin', 'paintFormXObjectEnd',
  'constructPath', 'stroke', 'closeStroke', 'fill', 'eoFill', 'fillStroke',
  'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke', 'endPath', 'clip', 'eoClip',
  'setStrokeGray', 'setStrokeRGBColor', 'setStrokeCMYKColor', 'setStrokeColor',
  'setStrokeColorN', 'setFillGray', 'setFillRGBColor', 'setFillCMYKColor',
  'setFillColor', 'setFillColorN', 'setLineWidth', 'setDash'
])
const pathOperationNames = Object.fromEntries(Object.entries(pdfjs.OPS).map(([name, value]) => [value, name]))

for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
  const page = await document.getPage(pageNumber)
  const textContent = await page.getTextContent()
  const text = textContent.items.map((item) => 'str' in item ? item.str : '').join('')
  const compactText = text.replace(/\s+/g, '')
  const targets = ['调用示例', '权利归属证明文件', '软件鉴别材料', '申请人（自然人）签名', '申请人', '签名']
  if (!targets.some((target) => compactText.includes(target))) {
    if (textContent.items.some((item) => 'str' in item && /签名|申请|证明|鉴别/.test(item.str))) {
      console.log(`MATCH? PAGE ${pageNumber}: ${textContent.items.map((item) => 'str' in item ? item.str : '').join('|').slice(0, 300)}`)
    }
    continue
  }
  const viewport = page.getViewport({ scale: 1 })
  const operatorList = await page.getOperatorList()
  console.log(`\n===== PAGE ${pageNumber} ${viewport.width}x${viewport.height} =====`)
  console.log(`TEXT ${text.slice(0, 180)}`)
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const name = operationNames[operatorList.fnArray[index]!] ?? String(operatorList.fnArray[index])
    if (!watchedOperations.has(name)) continue
    const args = operatorList.argsArray[index] ?? []
    if (name === 'constructPath') {
      const operations = Array.isArray(args[0]) ? args[0] : []
      const values = Array.isArray(args[1]) ? args[1] : []
      console.log(`#${index} constructPath ops=${operations.map((value) => pathOperationNames[value as number] ?? value).join(',')}`)
      console.log(`  args=${JSON.stringify(values)}`)
      continue
    }
    if (name.startsWith('set') || name === 'transform' || name === 'paintFormXObjectBegin') {
      console.log(`#${index} ${name} ${JSON.stringify(args)}`)
      continue
    }
    console.log(`#${index} ${name}`)
  }
}
