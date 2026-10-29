import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as esbuild from 'esbuild'
import { PDFDocument, StandardFonts } from 'pdf-lib'
const source = readFileSync('src/main/documentPdfParser.ts','utf8')
 .replace('function extractPdfGridLines(','export function extractPdfGridLines(')
 .replace('function detectPdfTableGrids(','export function detectPdfTableGrids(')
 .replace('function detectPdfTextRowTableGrids(','export function detectPdfTextRowTableGrids(')
 .replace('function refinePdfSingleColumnGrid(','export function refinePdfSingleColumnGrid(')
 .replace('function mergePdfGridLines(','export function mergePdfGridLines(')
 .replace('function groupPdfTextItems(','export function groupPdfTextItems(')
 .replace('function pdfTextLineColumnClusters(','export function pdfTextLineColumnClusters(')
 .replace('function inferPdfGridColumnsFromText(','export function inferPdfGridColumnsFromText(')
 .replace('function inferPdfGridColumnsFromRowSegments(','export function inferPdfGridColumnsFromRowSegments(')
 .replace('function groupPdfGridRowSegments(','export function groupPdfGridRowSegments(')
const result=await esbuild.build({stdin:{contents:source,loader:'ts',resolveDir:`${process.cwd()}/src/main`},bundle:true,platform:'node',format:'esm',target:'node18',write:false,external:['pdfjs-dist','canvas']})
writeFileSync('/tmp/parser-fixtures.mjs',result.outputFiles[0]!.contents)
const parser:any=await import(`/tmp/parser-fixtures.mjs?${Date.now()}`)
const require=createRequire(import.meta.url);const pdfjs:any=require('pdfjs-dist/legacy/build/pdf.js');const worker:any=require('pdfjs-dist/legacy/build/pdf.worker.js');(globalThis as any).pdfjsWorker=worker.default??worker
async function inspect(kind:'frame'|'row'|'long'|'segmented'){
 const doc=await PDFDocument.create();const page=doc.addPage([595.92,842.88]);const font=await doc.embedFont(StandardFonts.Helvetica);const drawY=(y:number)=>page.getHeight()-y
 if(kind==='segmented'){const cb=[51,252,452,552],rt=[608,649,690,731],rows=[['name','description','updated'],['alpha','first package','today'],['beta','second package','yesterday']];rows.forEach((ts,i)=>{const y=drawY(rt[i]!+22);page.drawText(ts[0]!,{x:61,y,size:10,font});page.drawText(ts[1]!,{x:262,y,size:10,font});page.drawText(ts[2]!,{x:462,y,size:10,font})});for(const y of rt)for(let i=0;i<3;i++)page.drawLine({start:{x:cb[i]!,y:drawY(y)},end:{x:cb[i+1]!,y:drawY(y)},thickness:.72});page.drawLine({start:{x:cb[0]!,y:drawY(rt[0]!)},end:{x:cb[0]!,y:drawY(rt[3]!)},thickness:.72});page.drawLine({start:{x:cb[3]!,y:drawY(rt[0]!)},end:{x:cb[3]!,y:drawY(rt[3]!)},thickness:.72})}
 else {const left=kind==='frame'?68:53,right=kind==='frame'?528:543,rt=[330,372,414,456],first=kind==='long'?'requirements-desktop-verification':'docs',rows=[[first,'Update docs','Last month'],[first,'Refactor parser','Last week'],[first,'Add coverage','Yesterday']];rows.forEach((ts,i)=>{const y=drawY(rt[i]!+22);page.drawText(ts[0]!,{x:kind==='frame'?78:74,y,size:10,font});page.drawText(ts[1]!,{x:kind==='frame'?220:212,y,size:10,font});page.drawText(ts[2]!,{x:kind==='frame'?455:445,y,size:10,font})});for(const y of rt)page.drawLine({start:{x:left,y:drawY(y)},end:{x:right,y:drawY(y)},thickness:.72});if(kind==='frame'){page.drawLine({start:{x:left,y:drawY(rt[0]!)},end:{x:left,y:drawY(rt[3]!)},thickness:.72});page.drawLine({start:{x:right,y:drawY(rt[0]!)},end:{x:right,y:drawY(rt[3]!)},thickness:.72})}}
 const bytes=await doc.save();const pdf=await pdfjs.getDocument({data:bytes,verbosity:0}).promise;const p=await pdf.getPage(1);const vp=p.getViewport({scale:1});const tc=await p.getTextContent();const lines=parser.groupPdfTextItems(tc.items,vp.height);const ops=await p.getOperatorList();const raw=parser.extractPdfGridLines(ops,pdfjs,vp);const merged=parser.mergePdfGridLines(raw);const regular=parser.detectPdfTableGrids(merged,lines);const fallback=parser.detectPdfTextRowTableGrids(raw,lines,vp.width,vp.height);const all=[...regular,...fallback];console.log('\n',kind);console.log('lines',JSON.stringify(lines.map((l:any)=>({bbox:l.bbox,clusters:parser.pdfTextLineColumnClusters(l,vp.height),str:l.items.map((i:any)=>i.str).join('')}))));for(const g of all){console.log('grid',JSON.stringify({bbox:g.bbox,rows:g.rows,cols:g.columns,seg:parser.inferPdfGridColumnsFromRowSegments(raw,g),text:parser.inferPdfGridColumnsFromText(g,lines,vp.height),refined:parser.refinePdfSingleColumnGrid(g,raw,lines,vp.height).columns}))}}
for(const k of ['frame','row','long','segmented'] as const) await inspect(k)
