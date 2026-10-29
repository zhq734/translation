import { readFileSync } from 'node:fs'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as any
const worker = ('default' in workerModule ? workerModule.default : workerModule)
;(globalThis as any).pdfjsWorker = worker
const bytes=readFileSync('/Users/mac/Downloads/转换套件产品接口文档 (1).pdf')
const doc=await pdfjs.getDocument({data:new Uint8Array(bytes),verbosity:0}).promise
const page=await doc.getPage(83)
const op=await page.getOperatorList()
const names=Object.fromEntries(Object.entries(pdfjs.OPS).map(([k,v])=>[v,k]))
for(let i=0;i<op.fnArray.length;i++){const n=names[op.fnArray[i]]; if(['constructPath','fill','stroke','closeStroke','fillStroke','closeFillStroke'].includes(n)){const a=op.argsArray[i]; if(n==='constructPath'){console.log(i,n,JSON.stringify(a).slice(0,500))} else console.log(i,n)}}
