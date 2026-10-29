// scripts/.inspect-real-page-text.ts
import { readFileSync } from "node:fs";
import * as pdfjsModule from "pdfjs-dist/legacy/build/pdf.js";
import * as workerModule from "pdfjs-dist/legacy/build/pdf.worker.js";
var pdfjs = "default" in pdfjsModule ? pdfjsModule.default : pdfjsModule;
var worker = "default" in workerModule ? workerModule.default : workerModule;
globalThis.pdfjsWorker = worker;
var path = "/Users/mac/Downloads/\u8F6C\u6362\u5957\u4EF6\u4EA7\u54C1\u63A5\u53E3\u6587\u6863 (1).pdf";
var document = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise;
for (const pageNumber of [72, 75, 78]) {
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const lines = /* @__PURE__ */ new Map();
  for (const item of content.items) {
    if (!item.str?.trim()) continue;
    const tx = pdfjs.Util.transform(viewport.transform, item.transform);
    const y = Math.round(tx[5] * 10) / 10;
    const key = Math.round(y / 2) * 2;
    const entries = lines.get(key) ?? [];
    entries.push({ x: Math.round(tx[4] * 10) / 10, y, text: item.str, width: Math.round(item.width * 10) / 10 });
    lines.set(key, entries);
  }
  console.log(`
PAGE ${pageNumber}`);
  for (const entries of [...lines.values()].sort((left, right) => left[0].y - right[0].y)) {
    console.log(entries.map((entry) => `${entry.x},${entry.y}:${entry.text}`).join(" | "));
  }
}
