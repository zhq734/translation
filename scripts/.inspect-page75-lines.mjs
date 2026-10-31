// scripts/.inspect-page75-lines.ts
import { readFileSync } from "node:fs";
import * as pdfjsModule from "pdfjs-dist/legacy/build/pdf.js";
import * as workerModule from "pdfjs-dist/legacy/build/pdf.worker.js";
var pdfjs = "default" in pdfjsModule ? pdfjsModule.default : pdfjsModule;
var worker = "default" in workerModule ? workerModule.default : workerModule;
globalThis.pdfjsWorker = worker;
var path = "/Users/mac/Downloads/\u8F6C\u6362\u5957\u4EF6\u4EA7\u54C1\u63A5\u53E3\u6587\u6863 (1).pdf";
var document = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise;
var page = await document.getPage(75);
var viewport = page.getViewport({ scale: 1 });
var ops = await page.getOperatorList();
var names = Object.fromEntries(Object.entries(pdfjs.OPS).map(([name, value]) => [value, name]));
for (let index = 0; index < ops.fnArray.length; index += 1) {
  const name = names[ops.fnArray[index]];
  if (!["constructPath", "transform", "paintFormXObjectBegin", "setStrokeRGBColor", "setFillRGBColor", "setLineWidth", "setStrokeColor"].includes(name)) continue;
  const args = ops.argsArray[index];
  if (name === "constructPath") {
    const values = args[1];
    if (values.some((value) => value >= 70 && value <= 140 || value >= 700 && value <= 770)) {
      console.log(JSON.stringify({ index, name, viewport, args }));
    }
  } else {
    console.log(JSON.stringify({ index, name, args }));
  }
}
