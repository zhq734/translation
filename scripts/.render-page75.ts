import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.js'
import * as workerModule from 'pdfjs-dist/legacy/build/pdf.worker.js'

const require = createRequire(import.meta.url)
const { createCanvas } = require('canvas') as typeof import('canvas')
const pdfjs = ('default' in pdfjsModule ? pdfjsModule.default : pdfjsModule) as any
const worker = ('default' in workerModule ? workerModule.default : workerModule) as any
;(globalThis as any).pdfjsWorker = worker

const path = '/Users/mac/Downloads/转换套件产品接口文档 (1).pdf'
const document = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise
const page = await document.getPage(75)
const viewport = page.getViewport({ scale: 2 })
const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
writeFileSync('/tmp/translation-page75.png', canvas.toBuffer('image/png'))
console.log('/tmp/translation-page75.png')
