// scripts/.inspect-real-table-candidates.ts
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
var source = readFileSync("src/main/documentPdfParser.ts", "utf8").replace("function extractPdfGridLines(", "export function extractPdfGridLines(").replace("function detectPdfTableGrids(", "export function detectPdfTableGrids(").replace("function mergeAdjacentPdfTableGrids(", "export function mergeAdjacentPdfTableGrids(").replace("function trimPdfFormContainerBottom(", "export function trimPdfFormContainerBottom(").replace("function mergePdfGridLines(", "export function mergePdfGridLines(").replace("function groupPdfTextItems(", "export function groupPdfTextItems(").replace("function selectPdfCodeFrames(", "export function selectPdfCodeFrames(").replace("function filterPdfCodeFrameGrids(", "export function filterPdfCodeFrameGrids(").replace("function isPdfHeaderImageGrid(", "export function isPdfHeaderImageGrid(").replace("function isPdfPageFrameGrid(", "export function isPdfPageFrameGrid(").replace("function filterNestedPdfTableGrids(", "export function filterNestedPdfTableGrids(");
var result = await esbuild.build({
  stdin: { contents: source, loader: "ts", resolveDir: `${process.cwd()}/src/main` },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  write: false,
  external: ["pdfjs-dist", "canvas"]
});
var temporaryPath = "/tmp/documentPdfParser.inspect.mjs";
await import("node:fs").then(({ writeFileSync }) => writeFileSync(temporaryPath, result.outputFiles[0].contents));
var parser = await import(`${temporaryPath}?${Date.now()}`);
var require2 = createRequire(import.meta.url);
var pdfjsModule = require2("pdfjs-dist/legacy/build/pdf.js");
var workerModule = require2("pdfjs-dist/legacy/build/pdf.worker.js");
var pdfjs = pdfjsModule.default ?? pdfjsModule;
var worker = workerModule.default ?? workerModule;
globalThis.pdfjsWorker = worker;
var path = "/Users/mac/Downloads/\u8F6C\u6362\u5957\u4EF6\u4EA7\u54C1\u63A5\u53E3\u6587\u6863 (1).pdf";
var document = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise;
for (const pageNumber of [72, 75, 78, 82]) {
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();
  const lines = parser.groupPdfTextItems(textContent.items, viewport.height);
  const operatorList = await page.getOperatorList();
  const gridLines = parser.mergePdfGridLines(parser.extractPdfGridLines(operatorList, pdfjs, viewport));
  const detected = parser.detectPdfTableGrids(gridLines, lines);
  const pageFrames = detected.filter((grid) => parser.isPdfPageFrameGrid(grid, viewport.width, viewport.height));
  const remaining = detected.filter((grid) => !pageFrames.includes(grid));
  const codeFrames = parser.selectPdfCodeFrames(remaining, lines, textContent.styles ?? {});
  const tableCandidates = parser.filterPdfCodeFrameGrids(remaining, lines, textContent.styles ?? {});
  const merged = parser.mergeAdjacentPdfTableGrids(tableCandidates);
  const trimmed = merged.map((grid) => parser.trimPdfFormContainerBottom(grid, gridLines, lines));
  const nested = parser.filterNestedPdfTableGrids(trimmed);
  console.log(`
PAGE ${pageNumber} size=${viewport.width}x${viewport.height}`);
  console.log("detected", JSON.stringify(detected.map((grid) => ({ bbox: grid.bbox, columns: grid.columns, rows: grid.rows }))));
  console.log("codeFrames", JSON.stringify(codeFrames.map((grid) => grid.bbox)));
  console.log("tableCandidates", JSON.stringify(tableCandidates.map((grid) => ({ bbox: grid.bbox, columns: grid.columns, rows: grid.rows }))));
  console.log("merged", JSON.stringify(merged.map((grid) => ({ bbox: grid.bbox, columns: grid.columns, rows: grid.rows }))));
  console.log("trimmed", JSON.stringify(trimmed.map((grid) => ({ bbox: grid.bbox, rows: grid.rows }))));
  console.log("nested", JSON.stringify(nested.map((grid) => ({ bbox: grid.bbox, rows: grid.rows }))));
  const relevant = gridLines.filter((line) => {
    const value = line.orientation === "vertical" ? line.position : line.position;
    return value > 70 && value < 540;
  });
  console.log("verticalLines", JSON.stringify(relevant.filter((line) => line.orientation === "vertical").map((line) => ({ x: line.position, y1: line.start, y2: line.end, color: line.color, thickness: line.thickness }))));
  console.log("horizontalLines", JSON.stringify(relevant.filter((line) => line.orientation === "horizontal").map((line) => ({ y: line.position, x1: line.start, x2: line.end, color: line.color, thickness: line.thickness }))));
}
