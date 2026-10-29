import { readFileSync } from 'node:fs'
import { parsePdfDocument } from '../src/main/documentPdfParser.ts'
const path = '/Users/mac/Downloads/转换套件产品接口文档 (1).pdf'
const bytes = readFileSync(path)
const started = performance.now()
const model = await parsePdfDocument({ path, fileName: '转换套件产品接口文档 (1).pdf', format: 'pdf', sha256: 'inspect', bytes })
const page=model.pages[82]!
console.log(JSON.stringify({elapsed: performance.now()-started,pages:model.pages.length,blocks:model.pages.flatMap(p=>p.blocks).length,tables:model.pages.flatMap(p=>p.blocks).filter(b=>b.kind==='table').length,shapes:model.pages.flatMap(p=>p.blocks).filter(b=>b.kind==='shape').length,texts:model.pages.flatMap(p=>p.blocks).filter(b=>b.kind==='text').length}))
console.log('code blocks', page.blocks.filter(b=>b.kind==='text'&&b.role==='code').length)
for (const b of page.blocks) if (b.kind==='text'&&b.role==='code') console.log(JSON.stringify({bbox:b.bbox,codeFrame:b.codeFrame,text:b.runs.map(r=>r.text).join('')}))
console.log('shapes')
for (const b of page.blocks) if (b.kind==='shape') console.log(JSON.stringify({bbox:b.bbox,line:b.line}))
