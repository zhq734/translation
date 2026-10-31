import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import * as esbuild from 'esbuild'

const source = readFileSync('src/main/documentPdfParser.ts', 'utf8')
const exports = ['extractPdfGridLines','detectPdfTableGrids','mergeAdjacentPdfTableGrids','extendPdfTableHeaderBands','trimPdfFormContainerBottom','mergePdfGridLines','groupPdfTextItems','selectPdfCodeFrames','filterPdfCodeFrameGrids','filterPdfOpenContainerGrids','filterNestedPdfTableGrids','preferPdfMultiColumnGrids','refinePdfSingleColumnGrid','detectPdfTextRowTableGrids','isPdfPageFrameGrid','createPdfTableBlock']
const debugSource = exports.reduce((value, name) => value.replace(`function ${name}(`, `export function ${name}(`), source)
const result = await esbuild.build({ stdin: { contents: debugSource, loader: 'ts', resolveDir: `${process.cwd()}/src/main` }, bundle: true, platform: 'node', format: 'esm', target: 'node18', write: false, external: ['pdfjs-dist', 'canvas'] })
const { writeFileSync } = await import('node:fs')
writeFileSync('/tmp/documentPdfParser.sparse-stage.mjs', result.outputFiles[0]!.contents)
const parser: any = await import(`/tmp/documentPdfParser.sparse-stage.mjs?${Date.now()}`)
const require = createRequire(import.meta.url)
const pdfjs: any = require('pdfjs-dist/legacy/build/pdf.js')
const worker: any = require('pdfjs-dist/legacy/build/pdf.worker.js')
;(globalThis as any).pdfjsWorker = worker.default ?? worker
const document = await PDFDocument.create(); const page = document.addPage([595.3, 841.9]); const font = await document.embedFont(StandardFonts.Helvetica); const drawY = (y: number) => page.getHeight() - y
const headerLeft=110.2,headerRight=485.1,tableLeft=109.96,tableRight=485.34,headerTop=81.1,headerBottom=111.29,dataTop=149.89,dataBottom=237.09,columns=[headerLeft,210.4,321.2,headerRight]
page.drawText('Name',{x:120,y:drawY(97),size:10,font});page.drawText('Type',{x:220,y:drawY(97),size:10,font});page.drawText('Description',{x:330,y:drawY(97),size:10,font});page.drawText('Value',{x:400,y:drawY(97),size:10,font});page.drawText('first',{x:120,y:drawY(175),size:10,font});page.drawText('second',{x:120,y:drawY(215),size:10,font})
page.drawLine({start:{x:90,y:drawY(headerTop)},end:{x:505.3,y:drawY(headerTop)},thickness:1});page.drawLine({start:{x:tableLeft,y:drawY(headerBottom)},end:{x:tableRight,y:drawY(headerBottom)},thickness:1})
for(const y of [dataTop,178.94,208.04,dataBottom]) page.drawLine({start:{x:tableLeft,y:drawY(y)},end:{x:tableRight,y:drawY(y)},thickness:1})
for(const x of columns) page.drawLine({start:{x,y:drawY(headerTop+0.85)},end:{x,y:drawY(dataBottom)},thickness:1})
const bytes=await document.save(); const pdf=await pdfjs.getDocument({data:bytes,verbosity:0}).promise;const p=await pdf.getPage(1);const viewport=p.getViewport({scale:1});const content=await p.getTextContent();const lines=parser.groupPdfTextItems(content.items,viewport.height);const ops=await p.getOperatorList();const raw=parser.extractPdfGridLines(ops,pdfjs,viewport);const merged=parser.mergePdfGridLines(raw);const closed=parser.detectPdfTableGrids(merged,lines);const fallback=parser.detectPdfTextRowTableGrids(raw,lines,viewport.width,viewport.height);const refined=parser.preferPdfMultiColumnGrids([...closed,...fallback].map((grid:any)=>parser.refinePdfSingleColumnGrid(grid,raw,lines,viewport.height)));const nonOpen=parser.filterPdfOpenContainerGrids(refined,merged);const tableCandidates=parser.filterPdfCodeFrameGrids(nonOpen,lines,content.styles??{});const adjacent=parser.mergeAdjacentPdfTableGrids(tableCandidates);const extended=adjacent.map((grid:any)=>parser.extendPdfTableHeaderBands(grid,merged,lines));const trimmed=extended.map((grid:any)=>parser.trimPdfFormContainerBottom(grid,merged,lines));const nested=parser.filterNestedPdfTableGrids(trimmed);const compact=(grid:any)=>({bbox:grid.bbox,columns:grid.columns,rows:grid.rows,rowBands:grid.rowBands});console.log('merged',JSON.stringify(merged.map((l:any)=>({o:l.orientation,p:l.position,s:l.start,e:l.end}))));console.log('closed',JSON.stringify(closed.map(compact)));console.log('fallback',JSON.stringify(fallback.map(compact)));console.log('refined',JSON.stringify(refined.map(compact)));console.log('adjacent',JSON.stringify(adjacent.map(compact)));console.log('extended',JSON.stringify(extended.map(compact)));console.log('trimmed',JSON.stringify(trimmed.map(compact)));console.log('nested',JSON.stringify(nested.map(compact)));
