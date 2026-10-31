import { readFileSync } from 'node:fs'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'
const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as any
const worker = ('default' in workerModule ? workerModule.default : workerModule)
;(globalThis as any).pdfjsWorker = worker
const bytes=readFileSync('/Users/mac/Downloads/转换套件产品接口文档 (1).pdf')
const doc=await pdfjs.getDocument({data:new Uint8Array(bytes),verbosity:0}).promise
const page=await doc.getPage(83)
const content=await page.getTextContent()
const styles=content.styles
for(const item of content.items){if(!('str' in item)||!item.str.trim())continue;console.log(JSON.stringify({str:item.str,transform:item.transform,width:item.width,height:item.height,fontName:item.fontName,style:styles[item.fontName]}))}
