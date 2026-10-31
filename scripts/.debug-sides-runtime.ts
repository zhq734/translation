import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as esbuild from 'esbuild'

const source = readFileSync('src/main/documentPdfParser.ts', 'utf8')
  .replace('function extractPdfGridLines(', 'export function extractPdfGridLines(')
  .replace('function detectPdfTableGrids(', 'export function detectPdfTableGrids(')
  .replace('function detectPdfTextRowTableGrids(', 'export function detectPdfTextRowTableGrids(')
  .replace('function refinePdfSingleColumnGrid(', 'export function refinePdfSingleColumnGrid(')
  .replace('function mergeAdjacentPdfTableGrids(', 'export function mergeAdjacentPdfTableGrids(')
  .replace('function trimPdfFormContainerBottom(', 'export function trimPdfFormContainerBottom(')
  .replace('function mergePdfGridLines(', 'export function mergePdfGridLines(')
  .replace('function groupPdfTextItems(', 'export function groupPdfTextItems(')
  .replace('function selectPdfCodeFrames(', 'export function selectPdfCodeFrames(')
  .replace('function filterPdfCodeFrameGrids(', 'export function filterPdfCodeFrameGrids(')
  .replace('function filterPdfOpenContainerGrids(', 'export function filterPdfOpenContainerGrids(')
  .replace('function isPdfPageFrameGrid(', 'export function isPdfPageFrameGrid(')
  .replace('function filterNestedPdfTableGrids(', 'export function filterNestedPdfTableGrids(')
  .replace('function preferPdfMultiColumnGrids(', 'export function preferPdfMultiColumnGrids(')
  .replace('function inferPdfGridColumnsFromText(', 'export function inferPdfGridColumnsFromText(')
  .replace('function inferPdfGridColumnsFromRowSegments(', 'export function inferPdfGridColumnsFromRowSegments(')

const result = await esbuild.build({ stdin: { contents: source, loader: 'ts', resolveDir: `${process.cwd()}/src/main` }, bundle: true, platform: 'node', format: 'esm', target: 'node18', write: false, external: ['pdfjs-dist', 'canvas'] })
writeFileSync('/tmp/documentPdfParser.debug-runtime.mjs', result.outputFiles[0]!.contents)
const parser: any = await import(`/tmp/documentPdfParser.debug-runtime.mjs?${Date.now()}`)
const require = createRequire(import.meta.url)
const pdfjs: any = require('pdfjs-dist/legacy/build/pdf.js')
const worker: any = require('pdfjs-dist/legacy/build/pdf.worker.js')
;(globalThis as any).pdfjsWorker = worker.default ?? worker
const path = '/tmp/sides.pdf'
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise
for (const n of [1]) {
  const page = await doc.getPage(n)
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const lines = parser.groupPdfTextItems(content.items, viewport.height)
  const ops = await page.getOperatorList()
  const raw = parser.extractPdfGridLines(ops, pdfjs, viewport)
  const merged = parser.mergePdfGridLines(raw)
  const regular = parser.detectPdfTableGrids(merged, lines)
  const fallback = parser.detectPdfTextRowTableGrids(raw, lines, viewport.width, viewport.height)
  const refined = parser.preferPdfMultiColumnGrids([...regular, ...fallback].map((g:any)=>parser.refinePdfSingleColumnGrid(g, raw, lines, viewport.height)))
  const compact=(g:any)=>({bbox:g.bbox,columns:g.columns,rows:g.rows})
  console.log(`PAGE ${n}`)
  console.log('raw horizontal', raw.filter((l:any)=>l.orientation==='horizontal').length, 'vertical', raw.filter((l:any)=>l.orientation==='vertical').length)
  console.log('regular', JSON.stringify(regular.map(compact)))
  console.log('fallback', JSON.stringify(fallback.map(compact)))
  console.log('refined', JSON.stringify(refined.map(compact)))
}
