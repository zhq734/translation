import { readFileSync } from 'node:fs'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
const pdfjs:any=('default' in pdfjsModule?pdfjsModule.default:pdfjsModule);(globalThis as any).pdfjsWorker=('default' in workerModule?workerModule.default:workerModule)
const doc=await pdfjs.getDocument({data:new Uint8Array(readFileSync('/Users/mac/Downloads/web-page-translated.pdf')),verbosity:0}).promise
for(const n of [1,2]){const page=await doc.getPage(n);const vp=page.getViewport({scale:1});const tc=await page.getTextContent();const items=(tc.items as any[]).filter(i=>i.str?.trim()).map(i=>({s:i.str,x:+i.transform[4].toFixed(1),y:+(vp.height-i.transform[5]-(i.height??0)).toFixed(1),w:+(i.width??0).toFixed(1),h:+(i.height??0).toFixed(1)}));console.log(`PAGE ${n}`);for(const i of items)console.log(JSON.stringify(i))}
