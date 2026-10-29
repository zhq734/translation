// scripts/.render-page75.ts
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import * as pdfjsModule from "pdfjs-dist/legacy/build/pdf.js";
import * as workerModule from "pdfjs-dist/legacy/build/pdf.worker.js";
var require2 = createRequire(import.meta.url);
var { createCanvas } = require2("canvas");
var pdfjs = "default" in pdfjsModule ? pdfjsModule.default : pdfjsModule;
var worker = "default" in workerModule ? workerModule.default : workerModule;
globalThis.pdfjsWorker = worker;
var path = "/Users/mac/Downloads/\u8F6C\u6362\u5957\u4EF6\u4EA7\u54C1\u63A5\u53E3\u6587\u6863 (1).pdf";
var document = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise;
var page = await document.getPage(75);
var viewport = page.getViewport({ scale: 2 });
var canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
writeFileSync("/tmp/translation-page75.png", canvas.toBuffer("image/png"));
console.log("/tmp/translation-page75.png");
