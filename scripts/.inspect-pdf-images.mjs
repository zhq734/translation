// ../../../../../private/tmp/inspect-pdf-images.ts
import { readFileSync } from "node:fs";
import * as pdfjsModule from "pdfjs-dist/legacy/build/pdf.js";
import * as workerModule from "pdfjs-dist/legacy/build/pdf.worker.js";

// src/main/documentPdfParser.ts
import { createRequire } from "node:module";

// src/shared/documentTypes.ts
function stableShortHash(value) {
  let first = 2166136261;
  let second = 2654435769;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 16777619);
    second ^= code + index;
    second = Math.imul(second, 2246822507);
  }
  return (first >>> 0).toString(16).padStart(8, "0") + (second >>> 0).toString(16).padStart(8, "0");
}
function createDocumentPageId(documentFingerprint, pageIndex) {
  return `page-${stableShortHash(`${documentFingerprint}\0${pageIndex}`).slice(0, 12)}`;
}
function createDocumentBlockId(documentFingerprint, pageId, readingOrder, kind) {
  return `block-${stableShortHash(`${documentFingerprint}\0${pageId}\0${readingOrder}\0${kind}`).slice(0, 12)}`;
}

// src/main/documentParserShared.ts
import { createHash } from "node:crypto";
var DOCUMENT_MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
var DOCUMENT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
var DOCUMENT_MAX_PAGES = 2e3;
var DOCUMENT_MAX_IMAGES = 1e3;
function hashDocumentBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function createDocumentModelId(fingerprint) {
  return `document-${hashDocumentBytes(new TextEncoder().encode(fingerprint)).slice(0, 16)}`;
}
function createTextRunId(blockId, index) {
  return `${blockId}-run-${index}`;
}
function createTableCellId(fingerprint, pageId, tableBlockId, rowIndex, cellIndex) {
  const digest = hashDocumentBytes(new TextEncoder().encode(
    `${fingerprint}\0${pageId}\0${tableBlockId}\0${rowIndex}\0${cellIndex}`
  )).slice(0, 16);
  return `cell-${digest}`;
}
function createTableRowId(tableBlockId, rowIndex) {
  return `${tableBlockId}-row-${rowIndex}`;
}
function sanitizeDocumentText(value) {
  return String(value ?? "").replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}
function createDocumentWarning(code, message, options = {}) {
  return {
    code,
    severity: options.severity ?? "warning",
    message,
    ...options.pageId ? { pageId: options.pageId } : {},
    ...options.blockId ? { blockId: options.blockId } : {}
  };
}

// src/main/documentPdfParser.ts
function createPdfCanvasFactory() {
  const require2 = createRequire(import.meta.url);
  return {
    /**
     * 创建画布及二维上下文。
     * @param width 画布宽度。
     * @param height 画布高度。
     * @returns PDF.js 画布条目。
     * @author zhenghq
     */
    create(width, height) {
      const canvasModule = require2("canvas");
      const canvas = canvasModule.createCanvas(width, height);
      return { canvas, context: canvas.getContext("2d") };
    },
    /**
     * 复用画布并调整尺寸。
     * @param entry PDF.js 画布条目。
     * @param width 新宽度。
     * @param height 新高度。
     * @returns 无返回值。
     * @author zhenghq
     */
    reset(entry, width, height) {
      entry.canvas.width = width;
      entry.canvas.height = height;
    },
    /**
     * 释放画布尺寸与上下文引用。
     * @param entry PDF.js 画布条目。
     * @returns 无返回值。
     * @author zhenghq
     */
    destroy(entry) {
      entry.canvas.width = 0;
      entry.canvas.height = 0;
      entry.context = null;
    }
  };
}
var PDF_MIN_IMAGE_SIZE = 8;
var PDF_MIN_IMAGE_AREA = 64;
var PDF_MIN_TABLE_LINE_LENGTH = 8;
var PDF_MIN_FILLED_LINE_THICKNESS = 0.5;
var PDF_MAX_FILLED_LINE_THICKNESS = 2;
var PDF_TABLE_LINE_TOLERANCE = 2;
var PDF_MIN_TABLE_SIZE = 16;
var PDF_PAGE_FRAME_MIN_RATIO = 0.9;
var PDF_PATH_GEOMETRY_TOLERANCE = 0.1;
function pdfAxisAlignedRectangle(points, closed) {
  if (!closed || points.length !== 4) return void 0;
  const uniqueX = points.map((point) => point.x).filter((value, index, values) => values.findIndex((candidate) => Math.abs(candidate - value) <= PDF_PATH_GEOMETRY_TOLERANCE) === index);
  const uniqueY = points.map((point) => point.y).filter((value, index, values) => values.findIndex((candidate) => Math.abs(candidate - value) <= PDF_PATH_GEOMETRY_TOLERANCE) === index);
  if (uniqueX.length !== 2 || uniqueY.length !== 2) return void 0;
  const left = Math.min(...uniqueX);
  const right = Math.max(...uniqueX);
  const top = Math.min(...uniqueY);
  const bottom = Math.max(...uniqueY);
  if (right - left <= PDF_PATH_GEOMETRY_TOLERANCE || bottom - top <= PDF_PATH_GEOMETRY_TOLERANCE) {
    return void 0;
  }
  return { left, right, top, bottom };
}
function pdfFilledLineFromRectangle(rectangle, color) {
  const width = rectangle.right - rectangle.left;
  const height = rectangle.bottom - rectangle.top;
  const thickness = Math.min(width, height);
  const length = Math.max(width, height);
  if (thickness < PDF_MIN_FILLED_LINE_THICKNESS || thickness > PDF_MAX_FILLED_LINE_THICKNESS || length < PDF_MIN_TABLE_LINE_LENGTH) {
    return void 0;
  }
  return width >= height ? {
    orientation: "horizontal",
    start: rectangle.left,
    end: rectangle.right,
    position: rectangle.top,
    ...color ? { color } : {},
    thickness
  } : {
    orientation: "vertical",
    start: rectangle.top,
    end: rectangle.bottom,
    position: rectangle.left,
    ...color ? { color } : {},
    thickness
  };
}
function readPngDimensions(bytes) {
  if (bytes.byteLength < 24 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return width > 0 && height > 0 ? { width, height } : null;
}
function createPdfAbortError() {
  const error = new Error("PDF parsing was aborted");
  error.name = "AbortError";
  return error;
}
function isPdfAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}
async function loadPdfJs() {
  const [module, workerModule2] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.js"),
    import("pdfjs-dist/legacy/build/pdf.worker.js")
  ]);
  const runtime = module.default ?? module;
  if (!runtime.getDocument || !runtime.OPS) throw new Error("PDF runtime is unavailable");
  globalThis.pdfjsWorker = workerModule2.default ?? workerModule2;
  return runtime;
}
function fontSizeFromTransform(transform, fallbackHeight = 12) {
  if (!transform) return Math.max(1, fallbackHeight);
  const scaleX = Math.hypot(transform[0] ?? 0, transform[1] ?? 0);
  const scaleY = Math.hypot(transform[2] ?? 0, transform[3] ?? 0);
  return Math.max(1, scaleY || scaleX || fallbackHeight);
}
function normalizePdfColorChannel(value) {
  const scaled = value <= 1 ? value * 255 : value;
  return Math.max(0, Math.min(255, Math.round(scaled)));
}
function pdfRgbColor(channels) {
  return `#${channels.map((value) => normalizePdfColorChannel(value).toString(16).padStart(2, "0")).join("")}`;
}
function pdfColorComponents(args) {
  const components = [];
  const visit = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      components.push(value);
      return;
    }
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      for (const item of Array.from(value)) visit(item);
    }
  };
  for (const arg of args) visit(arg);
  return components;
}
function pdfFillColorFromOperator(operation, args, runtime) {
  const components = pdfColorComponents(args);
  if (operation === runtime.OPS["setFillGray"] && components.length >= 1) {
    return pdfRgbColor([components[0], components[0], components[0]]);
  }
  if (operation === runtime.OPS["setFillRGBColor"] && components.length >= 3) {
    return pdfRgbColor(components.slice(0, 3));
  }
  if (operation === runtime.OPS["setFillCMYKColor"] && components.length >= 4) {
    const [cyan = 0, magenta = 0, yellow = 0, black = 0] = components;
    return pdfRgbColor([
      (1 - cyan) * (1 - black),
      (1 - magenta) * (1 - black),
      (1 - yellow) * (1 - black)
    ]);
  }
  if ((operation === runtime.OPS["setFillColor"] || operation === runtime.OPS["setFillColorN"]) && (components.length === 1 || components.length === 3 || components.length === 4)) {
    return components.length === 1 ? pdfRgbColor([components[0], components[0], components[0]]) : pdfRgbColor(components.slice(0, 3));
  }
  return void 0;
}
function pdfStrokeColorFromOperator(operation, args, runtime) {
  const components = pdfColorComponents(args);
  if (operation === runtime.OPS["setStrokeGray"] && components.length >= 1) {
    return pdfRgbColor([components[0], components[0], components[0]]);
  }
  if (operation === runtime.OPS["setStrokeRGBColor"] && components.length >= 3) {
    return pdfRgbColor(components.slice(0, 3));
  }
  if (operation === runtime.OPS["setStrokeCMYKColor"] && components.length >= 4) {
    const [cyan = 0, magenta = 0, yellow = 0, black = 0] = components;
    return pdfRgbColor([
      (1 - cyan) * (1 - black),
      (1 - magenta) * (1 - black),
      (1 - yellow) * (1 - black)
    ]);
  }
  if ((operation === runtime.OPS["setStrokeColor"] || operation === runtime.OPS["setStrokeColorN"]) && (components.length === 1 || components.length === 3 || components.length === 4)) {
    return components.length === 1 ? pdfRgbColor([components[0], components[0], components[0]]) : pdfRgbColor(components.slice(0, 3));
  }
  return void 0;
}
function extractPdfTextColors(operatorList, runtime) {
  const colors = [];
  const colorStack = [];
  let currentColor;
  const saveOperation = runtime.OPS["save"];
  const restoreOperation = runtime.OPS["restore"];
  const showTextOperations = new Set([
    runtime.OPS["showText"],
    runtime.OPS["showSpacedText"],
    runtime.OPS["nextLineShowText"],
    runtime.OPS["nextLineSetSpacingShowText"]
  ].filter((value) => typeof value === "number"));
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    const args = operatorList.argsArray[index] ?? [];
    if (operation === saveOperation) {
      colorStack.push(currentColor);
      continue;
    }
    if (operation === restoreOperation) {
      currentColor = colorStack.pop();
      continue;
    }
    const fillColor = pdfFillColorFromOperator(operation, args, runtime);
    if (fillColor) {
      currentColor = fillColor;
      continue;
    }
    if (showTextOperations.has(operation)) colors.push(currentColor);
  }
  return colors;
}
function hasVisiblePdfPageContent(operatorList, runtime) {
  const visibleOperationNames = [
    "showText",
    "showSpacedText",
    "nextLineShowText",
    "nextLineSetSpacingShowText",
    "paintImageXObject",
    "paintInlineImageXObject",
    "paintInlineImageXObjectGroup",
    "paintImageXObjectRepeat",
    "paintImageMaskXObject",
    "paintImageMaskXObjectGroup",
    "paintImageMaskXObjectRepeat",
    "paintSolidColorImageMask",
    "fill",
    "eoFill",
    "fillStroke",
    "eoFillStroke",
    "closeFillStroke",
    "closeEOFillStroke",
    "stroke",
    "closeStroke",
    "shadingFill"
  ];
  const visibleOperations = new Set(visibleOperationNames.map((name) => runtime.OPS[name]).filter((value) => typeof value === "number"));
  return operatorList.fnArray.some((operation) => visibleOperations.has(operation));
}
function extractPdfGridLines(operatorList, runtime, viewport) {
  const initial = asPdfMatrix(viewport.transform) ?? [1, 0, 0, -1, 0, viewport.height];
  let current = initial;
  const stack = [];
  const lines = [];
  const saveOperation = runtime.OPS["save"];
  const restoreOperation = runtime.OPS["restore"];
  const transformOperation = runtime.OPS["transform"];
  const formBeginOperation = runtime.OPS["paintFormXObjectBegin"];
  const formEndOperation = runtime.OPS["paintFormXObjectEnd"];
  const constructPathOperation = runtime.OPS["constructPath"];
  const moveToOperation = runtime.OPS["moveTo"];
  const lineToOperation = runtime.OPS["lineTo"];
  const rectangleOperation = runtime.OPS["rectangle"];
  const closePathOperation = runtime.OPS["closePath"];
  const strokeOperations = new Set([
    runtime.OPS["stroke"],
    runtime.OPS["closeStroke"]
  ].filter((value) => typeof value === "number"));
  const fillStrokeOperations = new Set([
    runtime.OPS["fillStroke"],
    runtime.OPS["eoFillStroke"],
    runtime.OPS["closeFillStroke"],
    runtime.OPS["closeEOFillStroke"]
  ].filter((value) => typeof value === "number"));
  const fillOperations = new Set([
    runtime.OPS["fill"],
    runtime.OPS["eoFill"]
  ].filter((value) => typeof value === "number"));
  const discardPathOperations = new Set([
    runtime.OPS["endPath"],
    runtime.OPS["clip"],
    runtime.OPS["eoClip"]
  ].filter((value) => typeof value === "number"));
  const saveOperationValue = saveOperation;
  const restoreOperationValue = restoreOperation;
  const transformOperationValue = transformOperation;
  const formBeginOperationValue = formBeginOperation;
  const formEndOperationValue = formEndOperation;
  const strokeColorOperations = new Set([
    runtime.OPS["setStrokeGray"],
    runtime.OPS["setStrokeRGBColor"],
    runtime.OPS["setStrokeCMYKColor"],
    runtime.OPS["setStrokeColor"],
    runtime.OPS["setStrokeColorN"]
  ].filter((value) => typeof value === "number"));
  const fillColorOperations = new Set([
    runtime.OPS["setFillGray"],
    runtime.OPS["setFillRGBColor"],
    runtime.OPS["setFillCMYKColor"],
    runtime.OPS["setFillColor"],
    runtime.OPS["setFillColorN"]
  ].filter((value) => typeof value === "number"));
  const lineWidthOperation = runtime.OPS["setLineWidth"];
  let strokeColor;
  let fillColor;
  let strokeThickness = 1;
  const graphicsStack = [];
  let pendingLines = [];
  let pendingFilledLine;
  let pendingPathHasNonRectangleGeometry = false;
  const point = (x, y) => ({
    x: current[0] * x + current[2] * y + current[4],
    y: current[1] * x + current[3] * y + current[5]
  });
  const addLine = (start, end) => {
    const dx = Math.abs(end.x - start.x);
    const dy = Math.abs(end.y - start.y);
    const tolerance = 0.75;
    if (dx <= tolerance && dy >= PDF_MIN_TABLE_LINE_LENGTH) {
      pendingLines.push({
        orientation: "vertical",
        start: Math.min(start.y, end.y),
        end: Math.max(start.y, end.y),
        position: (start.x + end.x) / 2,
        ...strokeColor ? { color: strokeColor } : {},
        thickness: strokeThickness
      });
    } else if (dy <= tolerance && dx >= PDF_MIN_TABLE_LINE_LENGTH) {
      pendingLines.push({
        orientation: "horizontal",
        start: Math.min(start.x, end.x),
        end: Math.max(start.x, end.x),
        position: (start.y + end.y) / 2,
        ...strokeColor ? { color: strokeColor } : {},
        thickness: strokeThickness
      });
    }
  };
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    const args = operatorList.argsArray[index] ?? [];
    if (operation === saveOperationValue) {
      graphicsStack.push({ strokeColor, fillColor, thickness: strokeThickness });
      stack.push(current);
      continue;
    }
    if (operation === restoreOperationValue) {
      const graphics = graphicsStack.pop();
      if (graphics) {
        strokeColor = graphics.strokeColor;
        fillColor = graphics.fillColor;
        strokeThickness = graphics.thickness;
      }
      current = stack.pop() ?? initial;
      continue;
    }
    if (operation === transformOperationValue) {
      const transform = asPdfMatrix(args);
      if (transform) current = multiplyPdfMatrix(current, transform);
      continue;
    }
    if (operation === formBeginOperationValue) {
      stack.push(current);
      const transform = asPdfMatrix(args[0]);
      if (transform) current = multiplyPdfMatrix(current, transform);
      continue;
    }
    if (operation === formEndOperationValue) {
      current = stack.pop() ?? initial;
      continue;
    }
    if (strokeColorOperations.has(operation)) {
      const color = pdfStrokeColorFromOperator(operation, args, runtime);
      if (color) strokeColor = color;
      continue;
    }
    if (fillColorOperations.has(operation)) {
      const color = pdfFillColorFromOperator(operation, args, runtime);
      if (color) fillColor = color;
      continue;
    }
    if (operation === lineWidthOperation) {
      const width = pdfColorComponents(args)[0];
      if (typeof width === "number" && Number.isFinite(width) && width > 0) strokeThickness = width;
      continue;
    }
    if (discardPathOperations.has(operation)) {
      pendingLines = [];
      pendingFilledLine = void 0;
      pendingPathHasNonRectangleGeometry = false;
      continue;
    }
    if (fillOperations.has(operation)) {
      if (pendingFilledLine && !pendingPathHasNonRectangleGeometry) {
        lines.push(pendingFilledLine);
      }
      pendingLines = [];
      pendingFilledLine = void 0;
      pendingPathHasNonRectangleGeometry = false;
      continue;
    }
    if (strokeOperations.has(operation) || fillStrokeOperations.has(operation)) {
      lines.push(...pendingLines);
      pendingLines = [];
      pendingFilledLine = void 0;
      pendingPathHasNonRectangleGeometry = false;
      continue;
    }
    if (operation !== constructPathOperation) continue;
    pendingLines = [];
    pendingFilledLine = void 0;
    pendingPathHasNonRectangleGeometry = false;
    const pathOperations = Array.isArray(args[0]) ? args[0] : [];
    const pathArguments = Array.isArray(args[1]) ? args[1] : [];
    let argumentIndex = 0;
    let cursor;
    let subpathStart;
    let pathClosed = false;
    const pathPoints = [];
    for (const pathOperation of pathOperations) {
      if (pathOperation === rectangleOperation) {
        const x = pathArguments[argumentIndex];
        const y = pathArguments[argumentIndex + 1];
        const width = pathArguments[argumentIndex + 2];
        const height = pathArguments[argumentIndex + 3];
        argumentIndex += 4;
        if ([x, y, width, height].some((value) => typeof value !== "number" || !Number.isFinite(value))) continue;
        const topLeft = point(x, y);
        const topRight = point(x + width, y);
        const bottomLeft = point(x, y + height);
        const bottomRight = point(x + width, y + height);
        addLine(topLeft, topRight);
        addLine(bottomLeft, bottomRight);
        addLine(topLeft, bottomLeft);
        addLine(topRight, bottomRight);
        cursor = topLeft;
        subpathStart = topLeft;
        pathPoints.push(topLeft, topRight, bottomRight, bottomLeft);
      } else if (pathOperation === moveToOperation) {
        const x = pathArguments[argumentIndex];
        const y = pathArguments[argumentIndex + 1];
        argumentIndex += 2;
        if (typeof x !== "number" || typeof y !== "number") continue;
        cursor = point(x, y);
        subpathStart = cursor;
        pathPoints.push(cursor);
      } else if (pathOperation === lineToOperation) {
        const x = pathArguments[argumentIndex];
        const y = pathArguments[argumentIndex + 1];
        argumentIndex += 2;
        if (typeof x !== "number" || typeof y !== "number") continue;
        const next = point(x, y);
        if (cursor) addLine(cursor, next);
        cursor = next;
        pathPoints.push(next);
      } else if (pathOperation === closePathOperation) {
        if (cursor && subpathStart) addLine(cursor, subpathStart);
        cursor = subpathStart;
        pathClosed = true;
      } else if (pathOperation === runtime.OPS["curveTo"]) {
        pendingPathHasNonRectangleGeometry = true;
        pendingFilledLine = void 0;
        argumentIndex += 6;
        cursor = void 0;
      } else if (pathOperation === runtime.OPS["curveTo2"] || pathOperation === runtime.OPS["curveTo3"]) {
        pendingPathHasNonRectangleGeometry = true;
        pendingFilledLine = void 0;
        argumentIndex += 4;
        cursor = void 0;
      }
    }
    if (!pendingPathHasNonRectangleGeometry && pathOperations.length === 5 && pathOperations[4] === closePathOperation) {
      const rectangle = pdfAxisAlignedRectangle(pathPoints, pathClosed);
      pendingFilledLine = rectangle ? pdfFilledLineFromRectangle(rectangle, fillColor) : void 0;
    } else if (!pendingPathHasNonRectangleGeometry && pathOperations.length === 1 && pathOperations[0] === rectangleOperation) {
      const rectangle = pdfAxisAlignedRectangle(pathPoints, true);
      pendingFilledLine = rectangle ? pdfFilledLineFromRectangle(rectangle, fillColor) : void 0;
    }
  }
  return lines;
}
function mergePdfGridLines(lines) {
  const result = [];
  for (const line of lines) {
    const existing = result.find((candidate) => candidate.orientation === line.orientation && Math.abs(candidate.position - line.position) <= PDF_TABLE_LINE_TOLERANCE && // 同方向、同坐标并不代表是同一条线。只有横向范围重叠或首尾相接时
    // 才能合并，否则会把页面两侧的独立装饰线连成贯穿空白区域的长线。
    candidate.start <= line.end + PDF_TABLE_LINE_TOLERANCE && line.start <= candidate.end + PDF_TABLE_LINE_TOLERANCE);
    if (!existing) {
      result.push({ ...line });
      continue;
    }
    existing.start = Math.min(existing.start, line.start);
    existing.end = Math.max(existing.end, line.end);
    if (!existing.color && line.color) existing.color = line.color;
    if (line.thickness !== void 0) {
      existing.thickness = Math.max(existing.thickness ?? 0, line.thickness);
    }
  }
  return result;
}
function pdfLineOutsideDetectedGrid(line, grid) {
  const gridLeft = grid.bbox.x - PDF_TABLE_LINE_TOLERANCE;
  const gridRight = grid.bbox.x + grid.bbox.width + PDF_TABLE_LINE_TOLERANCE;
  const gridTop = grid.bbox.y - PDF_TABLE_LINE_TOLERANCE;
  const gridBottom = grid.bbox.y + grid.bbox.height + PDF_TABLE_LINE_TOLERANCE;
  if (line.orientation === "horizontal") {
    if (line.position < gridTop || line.position > gridBottom) return [{ ...line }];
    if (line.end <= gridLeft || line.start >= gridRight) return [{ ...line }];
    const segments2 = [];
    if (line.start < gridLeft) {
      segments2.push({ ...line, end: Math.min(line.end, gridLeft) });
    }
    if (line.end > gridRight) {
      segments2.push({ ...line, start: Math.max(line.start, gridRight) });
    }
    return segments2.filter((segment) => segment.end - segment.start >= PDF_MIN_TABLE_LINE_LENGTH);
  }
  if (line.position < gridLeft || line.position > gridRight) return [{ ...line }];
  if (line.end <= gridTop || line.start >= gridBottom) return [{ ...line }];
  const segments = [];
  if (line.start < gridTop) {
    segments.push({ ...line, end: Math.min(line.end, gridTop) });
  }
  if (line.end > gridBottom) {
    segments.push({ ...line, start: Math.max(line.start, gridBottom) });
  }
  return segments.filter((segment) => segment.end - segment.start >= PDF_MIN_TABLE_LINE_LENGTH);
}
function clipPdfLinesOutsideDetectedGrids(lines, grids) {
  return lines.flatMap((line) => grids.reduce((segments, grid) => segments.flatMap((segment) => pdfLineOutsideDetectedGrid(segment, grid)), [line]));
}
function pdfLineOnDetectedPageFrame(line, pageFrameGrids) {
  const tolerance = PDF_TABLE_LINE_TOLERANCE + 1;
  return pageFrameGrids.some((grid) => {
    const right = grid.bbox.x + grid.bbox.width;
    const bottom = grid.bbox.y + grid.bbox.height;
    if (line.orientation === "horizontal") {
      return (Math.abs(line.position - grid.bbox.y) <= tolerance || Math.abs(line.position - bottom) <= tolerance) && line.start >= grid.bbox.x - tolerance && line.end <= right + tolerance;
    }
    return (Math.abs(line.position - grid.bbox.x) <= tolerance || Math.abs(line.position - right) <= tolerance) && line.start >= grid.bbox.y - tolerance && line.end <= bottom + tolerance;
  });
}
function isPdfPageEdgeDecoration(line, pageWidth, pageHeight) {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0 || !Number.isFinite(pageHeight) || pageHeight <= 0) {
    return false;
  }
  const edgeTolerance = PDF_TABLE_LINE_TOLERANCE;
  const length = line.end - line.start;
  if (line.orientation === "vertical") {
    return (line.position <= edgeTolerance || line.position >= pageWidth - edgeTolerance) && length >= pageHeight * PDF_PAGE_FRAME_MIN_RATIO;
  }
  return (line.position <= edgeTolerance || line.position >= pageHeight - edgeTolerance) && length >= pageWidth * PDF_PAGE_FRAME_MIN_RATIO;
}
function createPdfDividerBlocks(lines, grids, pageFrameGrids, codeFrameGrids, pageWidth, pageHeight, pageId, fingerprint) {
  const outsideCodeFrames = clipPdfLinesOutsideDetectedGrids(lines, codeFrameGrids);
  const dividers = clipPdfLinesOutsideDetectedGrids(outsideCodeFrames, grids).filter((line) => !pdfLineOnDetectedPageFrame(line, pageFrameGrids)).filter((line) => !isPdfPageEdgeDecoration(line, pageWidth, pageHeight));
  return dividers.map((line, index) => {
    const lineStyle = {
      orientation: line.orientation,
      ...line.color ? { color: line.color } : {},
      ...line.thickness !== void 0 ? { thickness: line.thickness } : {}
    };
    return {
      kind: "shape",
      blockId: createDocumentBlockId(fingerprint, pageId, index, "shape"),
      readingOrder: index,
      translatable: false,
      bbox: line.orientation === "horizontal" ? {
        x: line.start,
        y: line.position,
        width: Math.max(1, line.end - line.start),
        height: Math.max(1, line.thickness ?? 1)
      } : {
        x: line.position,
        y: line.start,
        width: Math.max(1, line.thickness ?? 1),
        height: Math.max(1, line.end - line.start)
      },
      line: lineStyle
    };
  });
}
function pdfBlocksShareVisualRow(left, right) {
  if (!left.bbox || !right.bbox) return false;
  if (!(left.kind === "image" && right.kind === "text" || left.kind === "text" && right.kind === "image")) return false;
  const image = left.kind === "image" ? left : right;
  const text = left.kind === "text" ? left : right;
  const imageBox = image.bbox;
  const textBox = text.bbox;
  if (imageBox.width > 80 || imageBox.height > 80) return false;
  const overlap = Math.min(imageBox.y + imageBox.height, textBox.y + textBox.height) - Math.max(imageBox.y, textBox.y);
  const minHeight = Math.min(imageBox.height, textBox.height);
  if (overlap < minHeight * 0.35) return false;
  const gap = left === image ? textBox.x - (imageBox.x + imageBox.width) : imageBox.x - (textBox.x + textBox.width);
  return gap >= -PDF_TABLE_LINE_TOLERANCE && gap <= Math.max(32, imageBox.height * 1.5);
}
function mergePdfGridCoordinates(values) {
  const result = [];
  for (const value of [...values].sort((left, right) => left - right)) {
    const previous = result[result.length - 1];
    if (previous === void 0 || value - previous > PDF_TABLE_LINE_TOLERANCE) result.push(value);
  }
  return result;
}
function trimPdfFormContainerBottom(grid, lines, textLines = []) {
  const bottom = grid.bbox.y + grid.bbox.height;
  if (grid.rows.length < 2) return grid;
  const vertical = lines.filter((line) => line.orientation === "vertical");
  const gridRight = grid.bbox.x + grid.bbox.width;
  const interiorLines = vertical.filter((line) => line.position > grid.bbox.x + PDF_TABLE_LINE_TOLERANCE && line.position < gridRight - PDF_TABLE_LINE_TOLERANCE && line.start <= grid.bbox.y + PDF_TABLE_LINE_TOLERANCE && line.end < bottom - PDF_TABLE_LINE_TOLERANCE);
  if (interiorLines.length === 0) return grid;
  const interiorBottom = Math.min(...interiorLines.map((line) => line.end));
  if (interiorBottom >= bottom - PDF_TABLE_LINE_TOLERANCE) return grid;
  const borderLines = vertical.filter((line) => (Math.abs(line.position - grid.bbox.x) <= PDF_TABLE_LINE_TOLERANCE || Math.abs(line.position - (grid.bbox.x + grid.bbox.width)) <= PDF_TABLE_LINE_TOLERANCE) && line.end >= bottom - PDF_TABLE_LINE_TOLERANCE);
  if (borderLines.length < 2) return grid;
  const hasTextInTrimmedRows = textLines.some((line) => {
    const centerY = line.bbox.y + line.bbox.height / 2;
    return centerY > interiorBottom + PDF_TABLE_LINE_TOLERANCE && centerY < bottom - PDF_TABLE_LINE_TOLERANCE && line.bbox.x + line.bbox.width >= grid.bbox.x - PDF_TABLE_LINE_TOLERANCE && line.bbox.x <= grid.bbox.x + grid.bbox.width + PDF_TABLE_LINE_TOLERANCE;
  });
  if (hasTextInTrimmedRows) return grid;
  const rows = grid.rows.filter((row) => row <= interiorBottom + PDF_TABLE_LINE_TOLERANCE);
  if (rows.length < 2) return grid;
  const nextBottom = rows[rows.length - 1];
  return {
    bbox: { ...grid.bbox, height: nextBottom - grid.bbox.y },
    columns: [...grid.columns],
    rows
  };
}
function pdfHorizontalLineHasVerticalSupports(line, verticalLines) {
  const hasSupportAt = (x) => verticalLines.some((vertical) => Math.abs(vertical.position - x) <= PDF_TABLE_LINE_TOLERANCE && vertical.start <= line.position + PDF_TABLE_LINE_TOLERANCE && vertical.end >= line.position - PDF_TABLE_LINE_TOLERANCE);
  return hasSupportAt(line.start) && hasSupportAt(line.end);
}
function pdfGridInteriorColumnReachesBottom(columns, left, right, bottom, verticalLines) {
  const interiorColumns = columns.filter((column) => column > left + PDF_TABLE_LINE_TOLERANCE && column < right - PDF_TABLE_LINE_TOLERANCE);
  if (interiorColumns.length === 0) return true;
  return interiorColumns.some((column) => verticalLines.some((line) => Math.abs(line.position - column) <= PDF_TABLE_LINE_TOLERANCE && line.end >= bottom - PDF_TABLE_LINE_TOLERANCE));
}
function detectPdfTableGrids(lines, textLines = []) {
  const horizontal = lines.filter((line) => line.orientation === "horizontal");
  const vertical = lines.filter((line) => line.orientation === "vertical");
  if (horizontal.length < 2 || vertical.length < 2) return [];
  const grids = [];
  for (const top of horizontal) {
    for (const bottom of horizontal) {
      if (bottom.position <= top.position + PDF_TABLE_LINE_TOLERANCE) continue;
      const rowLines = horizontal.filter((line) => line.position >= top.position - PDF_TABLE_LINE_TOLERANCE && line.position <= bottom.position + PDF_TABLE_LINE_TOLERANCE && line.start <= Math.min(top.start, bottom.start) + PDF_TABLE_LINE_TOLERANCE && line.end >= Math.max(top.end, bottom.end) - PDF_TABLE_LINE_TOLERANCE && pdfHorizontalLineHasVerticalSupports(line, vertical));
      if (rowLines.length < 2) continue;
      const left = Math.min(top.start, bottom.start);
      const right = Math.max(top.end, bottom.end);
      const columnLines = vertical.filter((line) => line.position >= left - PDF_TABLE_LINE_TOLERANCE && line.position <= right + PDF_TABLE_LINE_TOLERANCE && line.start <= bottom.position + PDF_TABLE_LINE_TOLERANCE && line.end >= top.position - PDF_TABLE_LINE_TOLERANCE);
      const borderColumnLines = columnLines.filter((line) => line.start <= top.position + PDF_TABLE_LINE_TOLERANCE && line.end >= bottom.position - PDF_TABLE_LINE_TOLERANCE);
      if (borderColumnLines.length < 2) continue;
      const columns = mergePdfGridCoordinates([
        left,
        right,
        ...borderColumnLines.map((line) => line.position),
        ...columnLines.filter((line) => !borderColumnLines.includes(line)).map((line) => line.position)
      ]);
      const rows = mergePdfGridCoordinates(rowLines.map((line) => line.position));
      if (columns.length < 2 || rows.length < 2) continue;
      const topPosition = rows[0];
      const bottomPosition = rows[rows.length - 1];
      if (!pdfGridInteriorColumnReachesBottom(columns, left, right, bottomPosition, vertical)) continue;
      const bbox = {
        x: left,
        y: topPosition,
        width: right - left,
        height: bottomPosition - topPosition
      };
      if (bbox.width < PDF_MIN_TABLE_SIZE || bbox.height < PDF_MIN_TABLE_SIZE) continue;
      const duplicate = grids.some((grid) => Math.abs(grid.bbox.x - bbox.x) <= PDF_TABLE_LINE_TOLERANCE && Math.abs(grid.bbox.y - bbox.y) <= PDF_TABLE_LINE_TOLERANCE && Math.abs(grid.bbox.width - bbox.width) <= PDF_TABLE_LINE_TOLERANCE && Math.abs(grid.bbox.height - bbox.height) <= PDF_TABLE_LINE_TOLERANCE);
      if (duplicate) continue;
      grids.push({ bbox, columns, rows });
    }
  }
  return grids;
}
function groupPdfGridRowSegments(lines, grid) {
  const bottom = grid.bbox.y + grid.bbox.height;
  const groups = [];
  const horizontal = lines.filter((line) => line.orientation === "horizontal" && line.position >= grid.bbox.y - PDF_TABLE_LINE_TOLERANCE && line.position <= bottom + PDF_TABLE_LINE_TOLERANCE && line.end >= grid.bbox.x - PDF_TABLE_LINE_TOLERANCE && line.start <= grid.bbox.x + grid.bbox.width + PDF_TABLE_LINE_TOLERANCE).sort((left, right) => left.position - right.position);
  for (const line of horizontal) {
    const group = groups.find((candidate) => Math.abs(candidate[0].position - line.position) <= PDF_TABLE_LINE_TOLERANCE);
    if (group) group.push(line);
    else groups.push([line]);
  }
  return groups;
}
function inferPdfGridColumnsFromRowSegments(rawLines, grid) {
  const endpointClusters = [];
  let segmentedRowCount = 0;
  for (const segments of groupPdfGridRowSegments(rawLines, grid)) {
    const rowEndpoints = mergePdfGridCoordinates(segments.flatMap((segment) => [
      Math.max(grid.bbox.x, segment.start),
      Math.min(grid.bbox.x + grid.bbox.width, segment.end)
    ])).filter((position) => position >= grid.bbox.x - PDF_TABLE_LINE_TOLERANCE && position <= grid.bbox.x + grid.bbox.width + PDF_TABLE_LINE_TOLERANCE);
    if (rowEndpoints.length < 3) continue;
    segmentedRowCount += 1;
    const rowIndex = segmentedRowCount;
    for (const position of rowEndpoints) {
      const cluster = endpointClusters.find((candidate) => Math.abs(candidate.position - position) <= PDF_TABLE_LINE_TOLERANCE);
      if (cluster) {
        cluster.rows.add(rowIndex);
      } else {
        endpointClusters.push({ position, rows: /* @__PURE__ */ new Set([rowIndex]) });
      }
    }
  }
  if (segmentedRowCount < 2) return [];
  const columns = mergePdfGridCoordinates([
    grid.bbox.x,
    grid.bbox.x + grid.bbox.width,
    ...endpointClusters.filter((cluster) => cluster.rows.size >= 2).map((cluster) => cluster.position)
  ]);
  return columns.length >= 3 ? columns : [];
}
function pdfStableTextColumnStarts(grid, textLines, pageHeight) {
  const startClusters = [];
  const rows = [];
  const left = grid.bbox.x + PDF_TABLE_LINE_TOLERANCE;
  const right = grid.bbox.x + grid.bbox.width - PDF_TABLE_LINE_TOLERANCE;
  for (const line of textLines) {
    if (!pdfLineCenterInsideGrid(line, grid)) continue;
    const clusters = pdfTextLineColumnClusters(line, pageHeight).filter((cluster) => cluster.start >= left && cluster.start <= right);
    const itemStarts = pdfTextItemColumnStarts(line, pageHeight).filter((start) => start >= left && start <= right);
    if (clusters.length === 0) continue;
    const rowIndex = rows.length;
    rows.push({ starts: clusters.map((cluster) => cluster.start), clusters });
    for (const position of mergePdfGridCoordinates([...clusters.map((cluster) => cluster.start), ...itemStarts])) {
      const existing = startClusters.find((candidate) => Math.abs(candidate.position - position) <= Math.max(4, PDF_TABLE_LINE_TOLERANCE * 2));
      if (existing) existing.rows.add(rowIndex);
      else startClusters.push({ position, rows: /* @__PURE__ */ new Set([rowIndex]) });
    }
  }
  return {
    starts: mergePdfGridCoordinates(startClusters.filter((cluster) => cluster.rows.size >= 2).map((cluster) => cluster.position)),
    rows
  };
}
function pdfGridColumnBoundaryIsSupported(position, grid, textStarts, segmentColumns) {
  const left = grid.bbox.x;
  const right = grid.bbox.x + grid.bbox.width;
  if (Math.abs(position - left) <= PDF_TABLE_LINE_TOLERANCE || Math.abs(position - right) <= PDF_TABLE_LINE_TOLERANCE) return true;
  const tolerance = Math.max(4, PDF_TABLE_LINE_TOLERANCE * 2);
  if (textStarts.some((start) => Math.abs(start - position) <= tolerance)) return true;
  return segmentColumns.some((column) => Math.abs(column - position) <= tolerance);
}
function inferPdfGridColumnsFromEvidence(grid, textLines, pageHeight, segmentColumns) {
  const textEvidence = pdfStableTextColumnStarts(grid, textLines, pageHeight);
  const left = grid.bbox.x;
  const right = grid.bbox.x + grid.bbox.width;
  const textColumns = inferPdfGridColumnsFromText(grid, textLines, pageHeight);
  const textBoundaries = textColumns.length >= 2 ? textColumns.slice(1, -1) : textEvidence.starts.slice(1).map((start, index, starts) => {
    const previous = index === 0 ? textEvidence.starts[0] : starts[index - 1];
    return Math.min(
      start - Math.max(4, PDF_TABLE_LINE_TOLERANCE * 2),
      (previous + start) / 2 + Math.max(8, (start - previous) * 0.35)
    );
  });
  const candidates = mergePdfGridCoordinates([
    left,
    right,
    ...textBoundaries,
    ...segmentColumns.filter((column) => column > left + PDF_TABLE_LINE_TOLERANCE && column < right - PDF_TABLE_LINE_TOLERANCE)
  ]).filter((position) => pdfGridColumnBoundaryIsSupported(
    position,
    grid,
    textEvidence.starts,
    segmentColumns
  ));
  const merged = mergePdfGridCoordinates([
    left,
    right,
    ...candidates.filter((position) => position > left + PDF_TABLE_LINE_TOLERANCE && position < right - PDF_TABLE_LINE_TOLERANCE)
  ]);
  if (merged.length < 3) return [];
  const minimumWidth = Math.max(PDF_TABLE_LINE_TOLERANCE * 2, grid.bbox.width * 0.04);
  const valid = merged.every((position, index) => index === 0 || position - merged[index - 1] >= minimumWidth);
  return valid ? merged : [];
}
function pdfTextLineColumnClusters(line, pageHeight) {
  const items = line.items.filter((item) => item.str.trim().length > 0).map((item) => ({ item, bbox: textItemBoundingBox(item, pageHeight) })).sort((left, right) => left.bbox.x - right.bbox.x);
  const clusters = [];
  let current;
  for (const entry of items) {
    const fontSize = fontSizeFromTransform(entry.item.transform, entry.item.height);
    const allowedGap = Math.max(PDF_MIN_TABLE_LINE_LENGTH, fontSize * 1.8);
    const right = entry.bbox.x + entry.bbox.width;
    if (!current || entry.bbox.x - current.end > allowedGap) {
      current = { start: entry.bbox.x, end: right };
      clusters.push(current);
    } else {
      current.end = Math.max(current.end, right);
    }
  }
  return clusters;
}
function pdfTextItemColumnStarts(line, pageHeight) {
  const items = line.items.filter((item) => item.str.trim().length > 0).map((item) => ({ item, bbox: textItemBoundingBox(item, pageHeight) })).sort((left, right) => left.bbox.x - right.bbox.x);
  if (items.length < 2) return [];
  const starts = [];
  let previous;
  for (const entry of items) {
    if (!previous) {
      starts.push(entry.bbox.x);
    } else {
      const fontSize = Math.max(
        fontSizeFromTransform(previous.item.transform, previous.item.height),
        fontSizeFromTransform(entry.item.transform, entry.item.height)
      );
      const previousRight = previous.bbox.x + previous.bbox.width;
      if (entry.bbox.x - previousRight > Math.max(4, fontSize * 0.35) || entry.bbox.x < previous.bbox.x + previous.bbox.width - fontSize * 0.5) {
        starts.push(entry.bbox.x);
      }
    }
    previous = entry;
  }
  return starts.length >= 2 ? mergePdfGridCoordinates(starts) : [];
}
function inferPdfGridColumnsFromText(grid, textLines, pageHeight) {
  const starts = [];
  const itemStarts = [];
  let multiItemRowCount = 0;
  for (const line of textLines) {
    if (!pdfLineCenterInsideGrid(line, grid)) continue;
    const lineClusters = pdfTextLineColumnClusters(line, pageHeight).filter((cluster) => cluster.start > grid.bbox.x + PDF_TABLE_LINE_TOLERANCE && cluster.start < grid.bbox.x + grid.bbox.width - PDF_TABLE_LINE_TOLERANCE);
    const lineItemStarts = pdfTextItemColumnStarts(line, pageHeight).filter((start) => start > grid.bbox.x + PDF_TABLE_LINE_TOLERANCE && start < grid.bbox.x + grid.bbox.width - PDF_TABLE_LINE_TOLERANCE);
    const lineStarts = lineClusters.map((cluster) => cluster.start);
    if (lineStarts.length < 2 && lineItemStarts.length < 2) continue;
    multiItemRowCount += 1;
    const rowIndex = multiItemRowCount;
    for (const position of lineStarts) {
      const cluster = starts.find((candidate) => Math.abs(candidate.position - position) <= Math.max(4, PDF_TABLE_LINE_TOLERANCE * 2));
      if (cluster) cluster.rows.add(rowIndex);
      else starts.push({ position, rows: /* @__PURE__ */ new Set([rowIndex]) });
    }
    for (const position of lineItemStarts) {
      const cluster = itemStarts.find((candidate) => Math.abs(candidate.position - position) <= Math.max(4, PDF_TABLE_LINE_TOLERANCE * 2));
      if (cluster) cluster.rows.add(rowIndex);
      else itemStarts.push({ position, rows: /* @__PURE__ */ new Set([rowIndex]) });
    }
  }
  if (multiItemRowCount < 2) return [];
  const stableClusterStarts = mergePdfGridCoordinates(starts.filter((start) => start.rows.size >= 2).map((start) => start.position));
  const stableItemStarts = mergePdfGridCoordinates(itemStarts.filter((start) => start.rows.size >= 2).map((start) => start.position));
  const columnStarts = stableClusterStarts.length >= 3 ? stableClusterStarts : stableItemStarts;
  if (columnStarts.length < 2) return [];
  const boundaryCandidates = [];
  let boundaryRowIndex = 0;
  for (const line of textLines) {
    if (!pdfLineCenterInsideGrid(line, grid)) continue;
    const lineClusters = pdfTextLineColumnClusters(line, pageHeight).filter((cluster) => cluster.start > grid.bbox.x + PDF_TABLE_LINE_TOLERANCE && cluster.start < grid.bbox.x + grid.bbox.width - PDF_TABLE_LINE_TOLERANCE);
    if (lineClusters.length < 2) continue;
    boundaryRowIndex += 1;
    for (let index = 0; index < lineClusters.length - 1; index += 1) {
      const left2 = lineClusters[index];
      const right2 = lineClusters[index + 1];
      if (right2.start - left2.end <= PDF_TABLE_LINE_TOLERANCE) continue;
      const position = (left2.end + right2.start) / 2;
      const cluster = boundaryCandidates.find((candidate) => Math.abs(candidate.position - position) <= Math.max(4, PDF_TABLE_LINE_TOLERANCE * 2));
      if (cluster) cluster.rows.add(boundaryRowIndex);
      else boundaryCandidates.push({ position, rows: /* @__PURE__ */ new Set([boundaryRowIndex]) });
    }
  }
  const stableBoundaries = mergePdfGridCoordinates(boundaryCandidates.filter((boundary) => boundary.rows.size >= 2).map((boundary) => boundary.position));
  const left = grid.bbox.x;
  const right = grid.bbox.x + grid.bbox.width;
  const boundaries = [left];
  for (let index = 0; index < columnStarts.length - 1; index += 1) {
    const nextStart = columnStarts[index + 1];
    const textBoundary = stableBoundaries.filter((position) => position > columnStarts[index] && position < nextStart).sort((first, second) => Math.abs(second - nextStart) - Math.abs(first - nextStart))[0];
    boundaries.push(textBoundary ?? nextStart);
  }
  boundaries.push(right);
  const minimumWidth = grid.bbox.width / columnStarts.length * 0.66;
  for (let index = 1; index < boundaries.length - 1; index += 1) {
    boundaries[index] = Math.max(boundaries[index], boundaries[index - 1] + minimumWidth);
  }
  for (let index = boundaries.length - 2; index > 0; index -= 1) {
    boundaries[index] = Math.min(boundaries[index], boundaries[index + 1] - minimumWidth);
  }
  const columns = mergePdfGridCoordinates(boundaries);
  const valid = columns.length === columnStarts.length + 1 && columns.every((column, index) => index === 0 || column - columns[index - 1] > PDF_TABLE_LINE_TOLERANCE);
  return valid ? columns : [];
}
function refinePdfSingleColumnGrid(grid, rawLines, textLines, pageHeight) {
  if (grid.rows.length < 3) return grid;
  const segmentColumns = inferPdfGridColumnsFromRowSegments(rawLines, grid);
  if (segmentColumns.length >= 3) return { ...grid, columns: segmentColumns };
  if (grid.columns.length !== 2) return grid;
  const columns = inferPdfGridColumnsFromEvidence(
    grid,
    textLines,
    pageHeight,
    segmentColumns
  );
  return columns.length >= 3 ? { ...grid, columns } : grid;
}
function groupPdfRawHorizontalRowLines(rawLines) {
  const groups = [];
  for (const line of rawLines.filter((candidate) => candidate.orientation === "horizontal")) {
    const group = groups.find((candidate) => Math.abs(candidate.positions[0] - line.position) <= PDF_TABLE_LINE_TOLERANCE);
    if (group) {
      group.positions.push(line.position);
      group.lines.push(line);
    } else {
      groups.push({ positions: [line.position], lines: [line] });
    }
  }
  return groups.map((group) => ({
    position: group.positions.reduce((sum, position) => sum + position, 0) / group.positions.length,
    left: Math.min(...group.lines.map((line) => line.start)),
    right: Math.max(...group.lines.map((line) => line.end)),
    segmentCount: group.lines.length
  })).sort((left, right) => left.position - right.position);
}
function pdfRowLineClustersAreRegular(rows) {
  if (rows.length < 3) return false;
  const gaps = rows.slice(1).map((row, index) => row.position - rows[index].position).filter((gap) => gap > PDF_TABLE_LINE_TOLERANCE);
  if (gaps.length < 2) return false;
  const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  if (average < PDF_MIN_TABLE_SIZE) return false;
  const maximumDeviation = Math.max(...gaps.map((gap) => Math.abs(gap - average)));
  return maximumDeviation <= Math.max(PDF_TABLE_LINE_TOLERANCE * 2, average * 0.3);
}
function detectPdfTextRowTableGrids(rawLines, textLines, pageWidth, pageHeight) {
  const rowLines = groupPdfRawHorizontalRowLines(rawLines);
  if (rowLines.length < 3) return [];
  const groups = [];
  for (const row of rowLines) {
    const previousGroup = groups[groups.length - 1];
    const previous = previousGroup?.[previousGroup.length - 1];
    if (previous && Math.abs(row.position - previous.position) <= PDF_MIN_TABLE_SIZE * 3) {
      previousGroup.push(row);
    } else {
      groups.push([row]);
    }
  }
  const candidates = [];
  for (const rows of groups) {
    if (!pdfRowLineClustersAreRegular(rows)) continue;
    const left = Math.min(...rows.map((row) => row.left));
    const right = Math.max(...rows.map((row) => row.right));
    if (right - left < PDF_MIN_TABLE_SIZE) continue;
    const top = rows[0].position;
    const lastLine = rows[rows.length - 1].position;
    const textRows = textLines.filter((line) => {
      const centerY = line.bbox.y + line.bbox.height / 2;
      return centerY >= top - PDF_TABLE_LINE_TOLERANCE && centerY <= lastLine + PDF_TABLE_LINE_TOLERANCE && line.bbox.x + line.bbox.width >= left - PDF_TABLE_LINE_TOLERANCE && line.bbox.x <= right + PDF_TABLE_LINE_TOLERANCE;
    });
    const multiColumnRows = textRows.filter((line) => pdfTextLineColumnClusters(line, pageHeight).filter((cluster) => cluster.start >= left - PDF_TABLE_LINE_TOLERANCE && cluster.start <= right + PDF_TABLE_LINE_TOLERANCE).length >= 2);
    if (multiColumnRows.length < 3) continue;
    const candidate = {
      bbox: { x: left, y: top, width: right - left, height: lastLine - top },
      columns: [left, right],
      rows: rows.map((row) => row.position)
    };
    const columns = inferPdfGridColumnsFromText(candidate, textLines, pageHeight);
    if (columns.length < 3) continue;
    const textBottom = textRows.length > 0 ? Math.max(...textRows.map((line) => line.bbox.y + line.bbox.height)) : lastLine;
    const bottom = textBottom > lastLine + PDF_TABLE_LINE_TOLERANCE ? Math.min(pageHeight, textBottom + PDF_TABLE_LINE_TOLERANCE) : lastLine;
    const grid = {
      bbox: { x: left, y: top, width: right - left, height: Math.min(pageHeight, bottom) - top },
      columns,
      rows: mergePdfGridCoordinates(rows.map((row) => row.position))
    };
    if (grid.bbox.width >= pageWidth * PDF_PAGE_FRAME_MIN_RATIO && grid.bbox.height >= pageHeight * PDF_PAGE_FRAME_MIN_RATIO) continue;
    candidates.push(grid);
  }
  return candidates;
}
function pdfGridsHaveSubstantialOverlap(left, right) {
  const overlapWidth = Math.max(
    0,
    Math.min(left.bbox.x + left.bbox.width, right.bbox.x + right.bbox.width) - Math.max(left.bbox.x, right.bbox.x)
  );
  const overlapHeight = Math.max(
    0,
    Math.min(left.bbox.y + left.bbox.height, right.bbox.y + right.bbox.height) - Math.max(left.bbox.y, right.bbox.y)
  );
  const overlap = overlapWidth * overlapHeight;
  const smallerArea = Math.min(
    left.bbox.width * left.bbox.height,
    right.bbox.width * right.bbox.height
  );
  return smallerArea > 0 && overlap / smallerArea >= 0.25;
}
function preferPdfMultiColumnGrids(grids) {
  return grids.filter((grid) => !(grid.columns.length === 2 && grids.some((candidate) => candidate !== grid && candidate.columns.length > grid.columns.length && pdfGridContainedBy(grid, candidate))));
}
function pdfTableGridsShareHorizontalBounds(left, right) {
  return Math.abs(left.bbox.x - right.bbox.x) <= PDF_TABLE_LINE_TOLERANCE && Math.abs(
    left.bbox.x + left.bbox.width - right.bbox.x - right.bbox.width
  ) <= PDF_TABLE_LINE_TOLERANCE;
}
function pdfTableGridsAreVerticallyAdjacent(top, bottom) {
  const topBottom = top.bbox.y + top.bbox.height;
  const bottomTop = bottom.bbox.y;
  return bottomTop - topBottom <= PDF_TABLE_LINE_TOLERANCE * 2;
}
function mergeAdjacentPdfTableGrids(grids) {
  const sorted = [...grids].sort((left, right) => left.bbox.y - right.bbox.y || left.bbox.x - right.bbox.x);
  const groups = [];
  for (const grid of sorted) {
    const group = groups.find((candidateGroup) => candidateGroup.some((candidate) => pdfTableGridsShareHorizontalBounds(candidate, grid) && (pdfTableGridsAreVerticallyAdjacent(candidate, grid) || pdfTableGridsAreVerticallyAdjacent(grid, candidate))));
    if (group) group.push(grid);
    else groups.push([grid]);
  }
  return groups.map((group) => {
    if (group.length === 1) return group[0];
    const left = Math.min(...group.map((grid) => grid.bbox.x));
    const top = Math.min(...group.map((grid) => grid.bbox.y));
    const right = Math.max(...group.map((grid) => grid.bbox.x + grid.bbox.width));
    const bottom = Math.max(...group.map((grid) => grid.bbox.y + grid.bbox.height));
    return {
      bbox: { x: left, y: top, width: right - left, height: bottom - top },
      columns: mergePdfGridCoordinates(group.flatMap((grid) => grid.columns)),
      rows: mergePdfGridCoordinates(group.flatMap((grid) => grid.rows))
    };
  });
}
function isPdfHeaderImageGrid(grid, imageRegions) {
  if (grid.rows.length !== 2) return false;
  return imageRegions.some((region) => {
    const bbox = region.bbox;
    const centerX = bbox.x + bbox.width / 2;
    const centerY = bbox.y + bbox.height / 2;
    const inside = centerX >= grid.bbox.x - PDF_TABLE_LINE_TOLERANCE && centerX <= grid.bbox.x + grid.bbox.width + PDF_TABLE_LINE_TOLERANCE && centerY >= grid.bbox.y - PDF_TABLE_LINE_TOLERANCE && centerY <= grid.bbox.y + grid.bbox.height + PDF_TABLE_LINE_TOLERANCE;
    return inside && bbox.width <= 80 && bbox.height <= 80;
  });
}
function pdfLineIntersectsGrid(line, grid) {
  return line.bbox.x + line.bbox.width >= grid.bbox.x - PDF_TABLE_LINE_TOLERANCE && line.bbox.x <= grid.bbox.x + grid.bbox.width + PDF_TABLE_LINE_TOLERANCE && line.bbox.y + line.bbox.height >= grid.bbox.y - PDF_TABLE_LINE_TOLERANCE && line.bbox.y <= grid.bbox.y + grid.bbox.height + PDF_TABLE_LINE_TOLERANCE;
}
function isPdfMonospaceFontFamily(fontFamily) {
  return Boolean(fontFamily && /(?:mono|courier|consolas|menlo|monaco|code|lucida\s*console)/iu.test(fontFamily));
}
function isPdfCodeFrameGrid(grid, lines, styles) {
  if (grid.columns.length !== 2) return false;
  const insideLines = lines.filter((line) => pdfLineIntersectsGrid(line, grid));
  if (insideLines.length < 2) return false;
  const items = insideLines.flatMap((line) => line.items);
  const text = items.map((item) => item.str).join("");
  if (!text.trim()) return false;
  const monospace = items.some((item) => {
    const style = item.fontName ? styles[item.fontName] : void 0;
    return isPdfMonospaceFontFamily(item.fontName) || isPdfMonospaceFontFamily(style?.fontName) || isPdfMonospaceFontFamily(style?.fontFamily);
  });
  const codeSymbols = text.match(/[{}()[\];=<>./\\:_$@#]/gu)?.length ?? 0;
  const symbolDensity = codeSymbols / Math.max(1, text.length);
  const hasCodeShape = /(?:=>|::|;\s*$|[{}]\s*$)/mu.test(text);
  return monospace || symbolDensity >= 0.06 || hasCodeShape && codeSymbols >= 3;
}
function filterPdfCodeFrameGrids(grids, lines, styles) {
  const codeFrames = selectPdfCodeFrames(grids, lines, styles);
  return grids.filter((grid) => !codeFrames.some((frame) => grid === frame || pdfGridContainedBy(frame, grid)));
}
function isPdfOpenContainerGrid(grid, lines) {
  if (grid.columns.length !== 2) return false;
  const top = grid.bbox.y;
  const bottom = top + grid.bbox.height;
  const left = grid.bbox.x;
  const right = left + grid.bbox.width;
  const vertical = lines.filter((line) => line.orientation === "vertical");
  const leftBorder = vertical.some((line) => Math.abs(line.position - left) <= PDF_TABLE_LINE_TOLERANCE && line.start <= top + PDF_TABLE_LINE_TOLERANCE && line.end > bottom + PDF_TABLE_LINE_TOLERANCE);
  const rightBorder = vertical.some((line) => Math.abs(line.position - right) <= PDF_TABLE_LINE_TOLERANCE && line.start <= top + PDF_TABLE_LINE_TOLERANCE && line.end > bottom + PDF_TABLE_LINE_TOLERANCE);
  return leftBorder && rightBorder;
}
function filterPdfOpenContainerGrids(grids, lines) {
  return grids.filter((grid) => !isPdfOpenContainerGrid(grid, lines));
}
function pdfLineUsesCodeFont(line, styles) {
  return line.items.some((item) => {
    const style = item.fontName ? styles[item.fontName] : void 0;
    return isPdfMonospaceFontFamily(item.fontName) || isPdfMonospaceFontFamily(style?.fontName) || isPdfMonospaceFontFamily(style?.fontFamily);
  });
}
function pdfLineUsesCodeSemantics(line, styles) {
  if (pdfLineUsesCodeFont(line, styles)) return true;
  const text = line.items.map((item) => item.str).join("");
  if (!text.trim()) return false;
  const codeSymbols = text.match(/[{}()[\];=<>./\\:_$@#]/gu)?.length ?? 0;
  const symbolDensity = codeSymbols / Math.max(1, text.length);
  const hasCodeShape = /(?:=>|::|;\s*$|[{}]\s*$)/mu.test(text);
  return symbolDensity >= 0.06 || hasCodeShape && codeSymbols >= 3;
}
function detectPdfOpenCodeContainers(lines, textLines, styles, tableGrids = []) {
  const vertical = lines.filter((line) => line.orientation === "vertical");
  const horizontal = lines.filter((line) => line.orientation === "horizontal");
  const groups = [];
  for (const leftBorder of vertical) {
    for (const rightBorder of vertical) {
      if (rightBorder.position <= leftBorder.position + PDF_MIN_TABLE_SIZE) continue;
      const top = Math.max(leftBorder.start, rightBorder.start);
      const bottom = Math.min(leftBorder.end, rightBorder.end);
      if (bottom - top < PDF_MIN_TABLE_SIZE * 4) continue;
      const overlapsClosedTable = tableGrids.some((grid) => grid.columns.length >= 3 && leftBorder.position >= grid.bbox.x - PDF_TABLE_LINE_TOLERANCE && leftBorder.position <= grid.bbox.x + grid.bbox.width + PDF_TABLE_LINE_TOLERANCE && rightBorder.position >= grid.bbox.x - PDF_TABLE_LINE_TOLERANCE && rightBorder.position <= grid.bbox.x + grid.bbox.width + PDF_TABLE_LINE_TOLERANCE && top <= grid.bbox.y + PDF_TABLE_LINE_TOLERANCE && bottom >= grid.bbox.y + grid.bbox.height - PDF_TABLE_LINE_TOLERANCE);
      if (overlapsClosedTable) continue;
      const separators = horizontal.filter((line) => line.start <= leftBorder.position + PDF_TABLE_LINE_TOLERANCE && line.end >= rightBorder.position - PDF_TABLE_LINE_TOLERANCE && line.position >= top - PDF_TABLE_LINE_TOLERANCE && line.position <= bottom + PDF_TABLE_LINE_TOLERANCE);
      if (separators.length < 2) continue;
      if (groups.some((group) => Math.abs(group.left - leftBorder.position) <= PDF_TABLE_LINE_TOLERANCE && Math.abs(group.right - rightBorder.position) <= PDF_TABLE_LINE_TOLERANCE && Math.abs(group.top - top) <= PDF_TABLE_LINE_TOLERANCE && Math.abs(group.bottom - bottom) <= PDF_TABLE_LINE_TOLERANCE)) continue;
      groups.push({
        left: leftBorder.position,
        right: rightBorder.position,
        top,
        bottom,
        separators
      });
    }
  }
  const codeRegions = [];
  const clipRegions = [];
  const clipRegionsByBounds = /* @__PURE__ */ new Map();
  for (const group of groups) {
    const groupKey = [group.left, group.top, group.right, group.bottom].map((value) => Math.round(value * 100) / 100).join(":");
    const insideLines = textLines.filter((line) => {
      const centerX = line.bbox.x + line.bbox.width / 2;
      const centerY = line.bbox.y + line.bbox.height / 2;
      return centerX > group.left + PDF_TABLE_LINE_TOLERANCE && centerX < group.right - PDF_TABLE_LINE_TOLERANCE && centerY >= group.top - PDF_TABLE_LINE_TOLERANCE && centerY <= group.bottom + PDF_TABLE_LINE_TOLERANCE;
    });
    const codeLines = insideLines.filter((line) => pdfLineUsesCodeSemantics(line, styles)).sort((left, right) => left.bbox.y - right.bbox.y || left.bbox.x - right.bbox.x);
    if (codeLines.length < 2) continue;
    const groupHorizontalBounds = group.separators.filter((line) => Math.abs(line.start - group.left) <= PDF_TABLE_LINE_TOLERANCE || Math.abs(line.end - group.right) <= PDF_TABLE_LINE_TOLERANCE).map((line) => line.position);
    const codeFrameTop = Math.round(Math.min(group.top, ...groupHorizontalBounds) * 100) / 100;
    const codeFrameBottom = Math.round(Math.max(group.bottom, ...groupHorizontalBounds) * 100) / 100;
    if (!clipRegionsByBounds.has(groupKey)) {
      const clipRegion = {
        bbox: {
          x: group.left,
          y: group.top,
          width: group.right - group.left,
          height: group.bottom - group.top
        },
        columns: [group.left, group.right],
        rows: [group.top, group.bottom]
      };
      clipRegionsByBounds.set(groupKey, { grid: clipRegion, separators: group.separators });
      clipRegions.push(clipRegion);
    }
    const groupSeparators = group.separators;
    let runStart = 0;
    for (let index = 1; index <= codeLines.length; index += 1) {
      const current = codeLines[index];
      const previous = codeLines[index - 1];
      const previousBottom = previous.bbox.y + previous.bbox.height;
      const gap = current ? current.bbox.y - previousBottom : Number.POSITIVE_INFINITY;
      const fontSize = Math.max(previous.bbox.height, current?.bbox.height ?? previous.bbox.height);
      if (current && gap <= Math.max(fontSize * 3, PDF_TABLE_LINE_TOLERANCE * 3)) continue;
      const run = codeLines.slice(runStart, index);
      const runTop = Math.min(...run.map((line) => line.bbox.y));
      const runBottom = Math.max(...run.map((line) => line.bbox.y + line.bbox.height));
      codeRegions.push({
        bbox: {
          x: Math.round(group.left * 100) / 100,
          y: codeFrameTop,
          width: Math.round((group.right - group.left) * 100) / 100,
          height: Math.round((codeFrameBottom - codeFrameTop) * 100) / 100
        },
        columns: [group.left, group.right],
        rows: [runTop, runBottom]
      });
      runStart = index;
    }
  }
  return { codeRegions, clipRegions };
}
function selectPdfCodeFrames(grids, lines, styles) {
  const codeFrames = grids.filter((grid) => isPdfCodeFrameGrid(grid, lines, styles));
  const completeFrames = codeFrames.filter((grid) => !codeFrames.some((candidate) => candidate !== grid && pdfGridContainedBy(candidate, grid) && lines.filter((line) => pdfLineCenterInsideGrid(line, candidate)).length >= lines.filter((line) => pdfLineCenterInsideGrid(line, grid)).length));
  return mergeAdjacentPdfCodeFrameRows(completeFrames, lines);
}
function mergeAdjacentPdfCodeFrameRows(grids, lines) {
  const sorted = [...grids].sort((left, right) => left.bbox.y - right.bbox.y);
  const groups = [];
  for (const grid of sorted) {
    const containingGroup = groups.find((group) => group.some((candidate) => pdfCodeGridsShareTextFlow(candidate, grid, lines)));
    if (containingGroup) containingGroup.push(grid);
    else groups.push([grid]);
  }
  return groups.map((group) => {
    const left = Math.min(...group.map((grid) => grid.bbox.x));
    const top = Math.min(...group.map((grid) => grid.bbox.y));
    const right = Math.max(...group.map((grid) => grid.bbox.x + grid.bbox.width));
    const bottom = Math.max(...group.map((grid) => grid.bbox.y + grid.bbox.height));
    return {
      bbox: { x: left, y: top, width: right - left, height: bottom - top },
      columns: mergePdfGridCoordinates(group.flatMap((grid) => grid.columns)),
      rows: mergePdfGridCoordinates(group.flatMap((grid) => grid.rows))
    };
  });
}
function pdfCodeGridsShareTextFlow(left, right, lines) {
  const horizontalTolerance = Math.max(3, PDF_TABLE_LINE_TOLERANCE * 1.5);
  if (Math.abs(left.bbox.x - right.bbox.x) > horizontalTolerance) return false;
  if (Math.abs(left.bbox.x + left.bbox.width - right.bbox.x - right.bbox.width) > horizontalTolerance) return false;
  const leftLines = lines.filter((line) => pdfLineCenterInsideGrid(line, left));
  const rightLines = lines.filter((line) => pdfLineCenterInsideGrid(line, right));
  if (leftLines.length === 0 || rightLines.length === 0) return false;
  const sharesRowBoundary = left.rows.some((row) => right.rows.some((candidate) => Math.abs(row - candidate) <= PDF_TABLE_LINE_TOLERANCE));
  if (sharesRowBoundary) return true;
  const leftBottom = Math.max(...leftLines.map((line) => line.bbox.y + line.bbox.height));
  const rightTop = Math.min(...rightLines.map((line) => line.bbox.y));
  const fontSize = Math.max(leftLines[0].items[0]?.height ?? 0, rightLines[0].items[0]?.height ?? 0);
  return rightTop - leftBottom <= Math.max(fontSize * 3, PDF_TABLE_LINE_TOLERANCE * 3);
}
function pdfLineCenterInsideGrid(line, grid) {
  const centerX = line.bbox.x + line.bbox.width / 2;
  const centerY = line.bbox.y + line.bbox.height / 2;
  return centerX >= grid.bbox.x - PDF_TABLE_LINE_TOLERANCE && centerX <= grid.bbox.x + grid.bbox.width + PDF_TABLE_LINE_TOLERANCE && centerY >= grid.bbox.y - PDF_TABLE_LINE_TOLERANCE && centerY <= grid.bbox.y + grid.bbox.height + PDF_TABLE_LINE_TOLERANCE;
}
function restorePdfCodeLineSpacing(line, contentLeft = line.bbox.x) {
  const result = [];
  const leadingItem = line.items.find((item) => item.str);
  const leadingIndent = leadingItem ? Math.max(0, (leadingItem.transform?.[4] ?? contentLeft) - contentLeft) : 0;
  for (const item of line.items) {
    if (!item.str) {
      result.push(item);
      continue;
    }
    let previous;
    for (let index = result.length - 1; index >= 0; index -= 1) {
      if (result[index].str) {
        previous = result[index];
        break;
      }
    }
    if (!previous) {
      const indent = item === leadingItem && leadingIndent > Math.max(0.5, (item.height ?? 0) * 0.25) ? " ".repeat(Math.max(1, Math.round(leadingIndent / Math.max(1, (item.height ?? 1) * 0.5)))) : "";
      result.push(indent ? { ...item, str: `${indent}${item.str}` } : item);
      continue;
    }
    const previousRight = (previous.transform?.[4] ?? 0) + (previous.width ?? 0);
    const gap = (item.transform?.[4] ?? 0) - previousRight;
    const fontSize = Math.max(previous.height ?? 0, item.height ?? 0);
    const needsSpace = gap > Math.max(0.5, fontSize * 0.15) && !/[\s([{]$/u.test(previous.str) && !/^[\s,.;:)\]}]/u.test(item.str);
    result.push(needsSpace ? { ...item, str: ` ${item.str}` } : item);
  }
  return result;
}
function pdfGridContainedBy(container, candidate) {
  const tolerance = PDF_TABLE_LINE_TOLERANCE;
  return candidate.bbox.x >= container.bbox.x - tolerance && candidate.bbox.y >= container.bbox.y - tolerance && candidate.bbox.x + candidate.bbox.width <= container.bbox.x + container.bbox.width + tolerance && candidate.bbox.y + candidate.bbox.height <= container.bbox.y + container.bbox.height + tolerance;
}
function filterNestedPdfTableGrids(grids) {
  return grids.filter((grid, index) => !grids.some(
    (candidate, candidateIndex) => candidateIndex !== index && // 表单外框候选可能比内部数据表更高；只有候选在内部列线终点处仍闭合时才允许覆盖。
    candidate.rows.includes(grid.rows[grid.rows.length - 1]) && candidate.bbox.x <= grid.bbox.x + PDF_TABLE_LINE_TOLERANCE && candidate.bbox.y <= grid.bbox.y + PDF_TABLE_LINE_TOLERANCE && candidate.bbox.x + candidate.bbox.width >= grid.bbox.x + grid.bbox.width - PDF_TABLE_LINE_TOLERANCE && candidate.bbox.y + candidate.bbox.height >= grid.bbox.y + grid.bbox.height - PDF_TABLE_LINE_TOLERANCE && (candidate.bbox.width > grid.bbox.width + PDF_TABLE_LINE_TOLERANCE || candidate.bbox.height > grid.bbox.height + PDF_TABLE_LINE_TOLERANCE)
  ));
}
function isPdfPageFrameGrid(grid, pageWidth, pageHeight) {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0 || !Number.isFinite(pageHeight) || pageHeight <= 0) {
    return false;
  }
  return grid.bbox.width >= pageWidth * PDF_PAGE_FRAME_MIN_RATIO && grid.bbox.height >= pageHeight * PDF_PAGE_FRAME_MIN_RATIO;
}
function applyPdfTextColors(items, colors) {
  let colorIndex = 0;
  for (const item of items) {
    if (!item.str || item.str.trim().length === 0) continue;
    const color = colors[colorIndex];
    colorIndex += 1;
    if (color) item.color = color;
  }
}
function pdfTextStyle(item, style) {
  const fontFlags = pdfFontStyleFlags(item.fontName, style);
  return {
    fontSize: fontSizeFromTransform(item.transform, item.height),
    ...item.color ? { color: item.color } : {},
    ...style?.fontName ? { fontFamily: style.fontName } : style?.fontFamily ? { fontFamily: style.fontFamily } : {},
    ...fontFlags.fontWeight ? { fontWeight: fontFlags.fontWeight } : {},
    ...fontFlags.italic ? { italic: true } : {}
  };
}
function pdfFontStyleFlags(fontName, style) {
  const fontObject = style;
  const descriptor = [
    typeof fontObject?.name === "string" ? fontObject.name : "",
    typeof fontObject?.fontFamily === "string" ? fontObject.fontFamily : "",
    fontName ?? ""
  ].join(" ");
  const bold = fontObject?.bold === true || style?.fontWeight === 700 || /bold|black|heavy|semibold|demi/iu.test(descriptor);
  const italic = fontObject?.italic === true || /italic|oblique/iu.test(descriptor);
  return {
    ...bold ? { fontWeight: 700 } : {},
    ...italic ? { italic: true } : {}
  };
}
function textItemBoundingBox(item, pageHeight) {
  const transform = item.transform ?? [];
  const x = transform[4] ?? 0;
  const baseline = transform[5] ?? pageHeight;
  const fontSize = fontSizeFromTransform(transform, item.height);
  return {
    x,
    y: Math.max(0, pageHeight - baseline - fontSize),
    width: Math.max(1, item.width ?? 1),
    height: Math.max(1, item.height ?? fontSize)
  };
}
function textItemBaseline(item, pageHeight) {
  const transform = item.transform ?? [];
  const baseline = transform[5] ?? pageHeight;
  return pageHeight - baseline;
}
function groupPdfTextItems(items, pageHeight) {
  const lines = [];
  for (const item of items) {
    if (!item.str || item.str.trim().length === 0) continue;
    const bbox = textItemBoundingBox(item, pageHeight);
    const last = lines[lines.length - 1];
    const sameLine = last && Math.abs(last.bbox.y - bbox.y) <= Math.max(2, Math.min(last.bbox.height, bbox.height) * 0.5);
    if (sameLine) {
      last.items.push(item);
      const right = Math.max(last.bbox.x + last.bbox.width, bbox.x + bbox.width);
      const top = Math.min(last.bbox.y, bbox.y);
      const bottom = Math.max(last.bbox.y + last.bbox.height, bbox.y + bbox.height);
      last.bbox = { x: Math.min(last.bbox.x, bbox.x), y: top, width: right - Math.min(last.bbox.x, bbox.x), height: bottom - top };
      last.baseline = Math.min(last.baseline, textItemBaseline(item, pageHeight));
    } else {
      lines.push({ items: [item], bbox, baseline: textItemBaseline(item, pageHeight) });
    }
  }
  return lines;
}
function inferPdfLineHeights(lines) {
  const result = /* @__PURE__ */ new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const size = fontSizeFromTransform(line.items[0]?.transform, line.items[0]?.height);
    let nextBaseline;
    const next = lines[index + 1];
    if (next) {
      const nextSize = fontSizeFromTransform(next.items[0]?.transform, next.items[0]?.height);
      const advance = next.baseline - line.baseline;
      const sameLeftEdge = Math.abs(next.bbox.x - line.bbox.x) <= Math.max(2, size * 0.25);
      if (sameLeftEdge && Math.abs(nextSize - size) <= Math.max(1.5, size * 0.2) && advance >= size * 1.02 && advance <= size * 3) {
        nextBaseline = advance;
      }
    }
    if (nextBaseline !== void 0) {
      result.set(line, Math.round(nextBaseline * 100) / 100);
    }
  }
  return result;
}
function normalizePdfParagraphFontFamily(fontFamily) {
  if (!fontFamily) return "";
  return fontFamily.replace(/^[A-Z]{6}\+/u, "").replace(/[,_+\s-]+/gu, "").replace(/(?:bold|black|heavy|semibold|demi|italic|oblique)$/u, "").toLowerCase();
}
function pdfLineDominantStyle(line, styles) {
  const candidates = line.items.map((item, index) => {
    const normalized = item.str.replace(/\s/gu, "");
    const marker = /^(?:[•●▪◦·*\uF0B7\uFFFD-]|\d+[.)、．]|[A-Za-z][.)])/u.exec(normalized)?.[0] ?? "";
    const trailingPunctuation = normalized.endsWith("\u3002") || normalized.endsWith(".") ? 1 : 0;
    return {
      item,
      index,
      weight: normalized.length - marker.length - trailingPunctuation
    };
  }).filter((candidate) => candidate.weight > 0);
  if (candidates.length === 0) return void 0;
  const dominant = candidates.reduce((best, candidate) => {
    const bestStyle = pdfTextStyle(best.item, best.item.fontName ? styles[best.item.fontName] : void 0);
    const candidateStyle = pdfTextStyle(candidate.item, candidate.item.fontName ? styles[candidate.item.fontName] : void 0);
    if (candidate.weight !== best.weight) return candidate.weight > best.weight ? candidate : best;
    return samePdfParagraphStyle(candidateStyle, bestStyle) ? best : candidate.index < best.index ? candidate : best;
  });
  const fontStyle = dominant.item.fontName ? styles[dominant.item.fontName] : void 0;
  return pdfTextStyle(dominant.item, {
    ...fontStyle,
    ...dominant.item.fontName ? { key: dominant.item.fontName } : {}
  });
}
function samePdfParagraphStyle(left, right) {
  if (!left || !right) return left === right;
  const leftSize = left.fontSize ?? 0;
  const rightSize = right.fontSize ?? 0;
  return Math.abs(leftSize - rightSize) <= Math.max(0.25, leftSize * 0.03) && normalizePdfParagraphFontFamily(left.fontFamily) === normalizePdfParagraphFontFamily(right.fontFamily) && left.fontWeight === right.fontWeight && left.color === right.color && left.italic === right.italic;
}
function startsPdfSemanticParagraph(text) {
  const normalized = text.trim();
  return /^(?:第[〇零一二三四五六七八九十百千万两\d]+(?:条|章|节|款|项)|[（(][〇零一二三四五六七八九十百千万两\d]+[）)]|[〇零一二三四五六七八九十百千万两\d]+[、.．]|[•●▪◦·*\uF0B7\uFFFD-]\s*|\d+[.)、．]\s*|[A-Za-z][.)]\s*)/u.test(normalized);
}
function parsePdfTableOfContentsLine(text) {
  const match = /^(.+?)(\s*(?:[.…·]\s*){8,})(\d{1,4})\s*$/u.exec(text);
  if (!match) return void 0;
  const title = match[1]?.trim() ?? "";
  const leader = match[2]?.replace(/\s/gu, "") ?? "";
  const pageNumber = match[3]?.trim() ?? "";
  if (!title || !pageNumber || !/^[.…·]{8,}$/u.test(leader)) return void 0;
  return { title, leader, pageNumber };
}
function endsPdfSemanticSentence(text) {
  const normalized = text.trimEnd().replace(/[”’」』】）)\]]+$/u, "");
  return /[。！？!?…]$/u.test(normalized) || /\.$/u.test(normalized);
}
function pdfLinesHaveHorizontalOverlap(previous, current) {
  const overlap = Math.min(
    previous.bbox.x + previous.bbox.width,
    current.bbox.x + current.bbox.width
  ) - Math.max(previous.bbox.x, current.bbox.x);
  const shorterWidth = Math.min(previous.bbox.width, current.bbox.width);
  return overlap > 0 && overlap >= Math.max(2, shorterWidth * 0.25);
}
function needsPdfLineSeparator(previousText, currentText) {
  const previous = previousText.trimEnd();
  const current = currentText.trimStart();
  if (!previous || !current) return false;
  const previousCharacter = previous.at(-1) ?? "";
  const currentCharacter = current[0] ?? "";
  if (/\s/u.test(previousCharacter) || /\s/u.test(currentCharacter)) return false;
  const hasCjkBoundary = /[\u3400-\u9fff]/u.test(previousCharacter) || /[\u3400-\u9fff]/u.test(currentCharacter);
  if (hasCjkBoundary) return false;
  if (/[.,;:!?%)\]}]/u.test(currentCharacter)) return false;
  return !/[(\[{/-]$/u.test(previousCharacter);
}
function canMergePdfParagraphLine(paragraph, previous, current, pageWidth, bodyFontSize, styles, contentArea) {
  const previousStyle = pdfLineDominantStyle(previous, styles);
  const currentStyle = pdfLineDominantStyle(current, styles);
  if (!samePdfParagraphStyle(previousStyle, currentStyle)) return false;
  const previousSize = previousStyle?.fontSize ?? 0;
  const currentSize = currentStyle?.fontSize ?? 0;
  const headingThreshold = Math.max(14, bodyFontSize * 1.2);
  if (previousSize >= headingThreshold || currentSize >= headingThreshold) return false;
  const previousAlign = inferPdfTextAlignment(
    previous.bbox,
    pageWidth,
    previousSize,
    bodyFontSize,
    contentArea
  );
  const currentAlign = inferPdfTextAlignment(
    current.bbox,
    pageWidth,
    currentSize,
    bodyFontSize,
    contentArea
  );
  if (previousAlign === "center" || previousAlign === "right" || currentAlign === "center" || currentAlign === "right") return false;
  const baselineAdvance = current.baseline - previous.baseline;
  const minimumAdvance = Math.max(1, Math.max(previousSize, currentSize) * 1.02);
  const maximumAdvance = Math.max(previousSize, currentSize) * 3;
  if (baselineAdvance < minimumAdvance || baselineAdvance > maximumAdvance) return false;
  if (paragraph.lineHeight !== void 0 && Math.abs(baselineAdvance - paragraph.lineHeight) > Math.max(1, currentSize * 0.25)) return false;
  if (!pdfLinesHaveHorizontalOverlap(previous, current)) return false;
  const previousText = previous.items.map((item) => item.str).join("");
  const currentText = current.items.map((item) => item.str).join("");
  if (parsePdfTableOfContentsLine(previousText) || parsePdfTableOfContentsLine(currentText)) {
    return false;
  }
  if (startsPdfSemanticParagraph(currentText)) return false;
  const indentation = current.bbox.x - previous.bbox.x;
  if (indentation > Math.max(8, currentSize * 0.8)) {
    const previousStartsParagraph = startsPdfSemanticParagraph(previousText);
    const markerWidth = previousStartsParagraph ? previous.items[0]?.width : void 0;
    const previousBodyX = previous.items[1]?.transform?.[4] ?? (markerWidth === void 0 ? previous.bbox.x : previous.bbox.x + markerWidth);
    if (Math.abs(current.bbox.x - previousBodyX) > Math.max(2, currentSize * 0.25)) return false;
    if (previousStartsParagraph && endsPdfSemanticSentence(previousText)) return false;
  }
  return true;
}
function groupPdfParagraphs(lines, pageWidth, bodyFontSize, styles, lineHeights, contentArea, codeFrames = []) {
  const paragraphs = [];
  let previousLine;
  const codeContentLefts = codeFrames.map((frame) => {
    const frameLines = lines.filter((line) => pdfLineCenterInsideGrid(line, frame));
    return frameLines.length > 0 ? Math.min(...frameLines.map((line) => line.bbox.x)) : frame.bbox.x;
  });
  for (const line of lines) {
    const current = paragraphs[paragraphs.length - 1];
    const codeFrameIndex = codeFrames.findIndex((frame) => pdfLineCenterInsideGrid(line, frame));
    const insideCodeFrame = codeFrameIndex >= 0;
    const codeContentLeft = codeFrameIndex >= 0 ? codeContentLefts[codeFrameIndex] : void 0;
    const continuesCodeFrame = insideCodeFrame && current?.codeFrameIndex === codeFrameIndex;
    const cannotContinue = insideCodeFrame ? !continuesCodeFrame : Boolean(current?.codeFrame) || previousLine !== void 0 && !canMergePdfParagraphLine(
      current,
      previousLine,
      line,
      pageWidth,
      bodyFontSize,
      styles,
      contentArea
    );
    if (!current || !previousLine || cannotContinue) {
      const lineHeight = lineHeights.get(line);
      paragraphs.push({
        items: insideCodeFrame ? restorePdfCodeLineSpacing(line, codeContentLeft) : [...line.items],
        bbox: { ...line.bbox },
        baseline: line.baseline,
        ...lineHeight === void 0 ? {} : { lineHeight },
        ...insideCodeFrame ? { codeFrame: true, codeFrameIndex } : {}
      });
      previousLine = line;
      continue;
    }
    if (continuesCodeFrame) {
      const lineItems = restorePdfCodeLineSpacing({
        ...line,
        items: line.items
      }, codeContentLeft);
      current.items.push({ ...lineItems[0], str: `
${lineItems[0].str}` });
      current.items.push(...lineItems.slice(1));
    } else {
      const previousText = current.items.map((item) => item.str).join("");
      const currentText = line.items.map((item) => item.str).join("");
      const separator = needsPdfLineSeparator(previousText, currentText) ? " " : "";
      line.items.forEach((item, index) => {
        current.items.push(index === 0 && separator ? { ...item, str: `${separator}${item.str}` } : item);
      });
    }
    const right = Math.max(current.bbox.x + current.bbox.width, line.bbox.x + line.bbox.width);
    const bottom = Math.max(current.bbox.y + current.bbox.height, line.bbox.y + line.bbox.height);
    current.bbox = {
      x: Math.min(current.bbox.x, line.bbox.x),
      y: Math.min(current.bbox.y, line.bbox.y),
      width: right - Math.min(current.bbox.x, line.bbox.x),
      height: bottom - Math.min(current.bbox.y, line.bbox.y)
    };
    const baselineAdvance = line.baseline - previousLine.baseline;
    if (current.lineHeight === void 0) {
      current.lineHeight = Math.round(baselineAdvance * 100) / 100;
    }
    previousLine = line;
  }
  return paragraphs;
}
function inferPdfContentArea(lines, pageWidth) {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0 || lines.length < 3) return void 0;
  const leftCounts = /* @__PURE__ */ new Map();
  for (const line of lines) {
    if (line.bbox.width <= 0) continue;
    const left2 = Math.round(line.bbox.x);
    leftCounts.set(left2, (leftCounts.get(left2) ?? 0) + 1);
  }
  const mostFrequent = (counts) => {
    let selected;
    let selectedCount = 0;
    for (const [value, count] of counts) {
      if (count > selectedCount) {
        selected = value;
        selectedCount = count;
      }
    }
    return selected;
  };
  const left = mostFrequent(leftCounts);
  if (left === void 0) return void 0;
  const bodyRightEdges = lines.filter((line) => Math.abs(line.bbox.x - left) <= Math.max(3, pageWidth * 0.012)).map((line) => line.bbox.x + line.bbox.width).filter((right2) => Number.isFinite(right2) && right2 > left && right2 <= pageWidth).sort((a, b) => a - b);
  if (bodyRightEdges.length < 3) return void 0;
  const right = bodyRightEdges[bodyRightEdges.length - 1];
  if (right - left < pageWidth * 0.25) return void 0;
  return { left, right, center: (left + right) / 2 };
}
function inferPdfBodyFontSize(lines) {
  if (lines.length <= 1) return 0;
  const weights = /* @__PURE__ */ new Map();
  for (const line of lines) {
    const item = line.items.find((candidate) => candidate.str.trim().length > 0);
    if (!item) continue;
    const fontSize = Math.round(fontSizeFromTransform(item.transform, item.height) * 10) / 10;
    if (fontSize <= 0) continue;
    const textLength = line.items.reduce((sum, candidate) => sum + candidate.str.replace(/\s/gu, "").length, 0);
    weights.set(fontSize, (weights.get(fontSize) ?? 0) + Math.max(1, textLength));
  }
  let bodyFontSize = 0;
  let bodyWeight = -1;
  for (const [fontSize, weight] of weights) {
    if (weight > bodyWeight || weight === bodyWeight && fontSize < bodyFontSize) {
      bodyFontSize = fontSize;
      bodyWeight = weight;
    }
  }
  return bodyFontSize;
}
function inferPdfTextAlignment(bbox, pageWidth, fontSize, bodyFontSize = 0, contentArea) {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0 || bbox.width <= 0) return void 0;
  const leftGap = Math.max(0, bbox.x);
  const rawRightGap = pageWidth - bbox.x - bbox.width;
  const rightGap = Math.max(0, rawRightGap);
  const centerGap = Math.abs(leftGap - rightGap);
  const horizontalTolerance = Math.max(2, pageWidth * 8e-3);
  const contentCenterGap = contentArea ? Math.abs(bbox.x + bbox.width / 2 - contentArea.center) : Number.POSITIVE_INFINITY;
  const pageCenterlineGap = Math.abs(bbox.x + bbox.width / 2 - pageWidth / 2);
  const headingCenterTolerance = Math.max(3, pageWidth * 0.012);
  const isCentered = centerGap <= horizontalTolerance || contentCenterGap <= horizontalTolerance;
  const hasBalancedMargin = Math.min(leftGap, rightGap) > Math.max(2, pageWidth * 0.015);
  const isAlignedToContentLeft = contentArea !== void 0 && Math.abs(bbox.x - contentArea.left) <= Math.max(3, pageWidth * 0.012);
  const isAlignedToContentRight = contentArea !== void 0 && Math.abs(bbox.x + bbox.width - contentArea.right) <= Math.max(3, pageWidth * 0.012);
  const isOnPageCenter = centerGap <= horizontalTolerance;
  const isOnContentCenter = contentCenterGap <= horizontalTolerance;
  const contentWidth = contentArea ? contentArea.right - contentArea.left : 0;
  const isBodySized = bodyFontSize > 0 && fontSize <= bodyFontSize * 1.1;
  const isNearFullContentWidth = contentWidth > 0 && bbox.width >= contentWidth * 0.8;
  if (isBodySized && isNearFullContentWidth) return void 0;
  const isHeadingSized = bodyFontSize > 0 && fontSize >= Math.max(14, bodyFontSize * 1.2);
  const isHeadingOnCenter = pageCenterlineGap <= headingCenterTolerance || contentCenterGap <= headingCenterTolerance;
  if (isHeadingSized && isHeadingOnCenter && hasBalancedMargin) return "center";
  const isShortCenteredContent = contentArea !== void 0 && (isOnPageCenter || isOnContentCenter) && !isAlignedToContentLeft && !isAlignedToContentRight && bbox.width < contentWidth * 0.9;
  if (isShortCenteredContent) return "center";
  if (isCentered && hasBalancedMargin && bodyFontSize > 0) {
    if (fontSize >= Math.max(14, bodyFontSize * 1.2)) return "center";
  }
  if (isCentered && hasBalancedMargin && bodyFontSize <= 0 && fontSize >= 14) {
    return "center";
  }
  const isNearRightPageEdge = rawRightGap >= 0 && rawRightGap <= Math.max(3, pageWidth * 0.12);
  if (bbox.width < pageWidth * 0.82 && leftGap > pageWidth * 0.12 && rightGap < leftGap * 0.6 && isNearRightPageEdge) return "right";
  return void 0;
}
function createPdfTextBlock(items, pageId, fingerprint, readingOrder, bbox, pageWidth, bodyFontSize, styles, lineHeight, contentArea, role = "paragraph", codeFrame) {
  const blockId = createDocumentBlockId(fingerprint, pageId, readingOrder, "text");
  const itemRuns = items.map((item, index) => {
    const fontStyle = item.fontName ? styles[item.fontName] : void 0;
    const style = pdfTextStyle(item, {
      ...fontStyle,
      ...item.fontName ? { key: item.fontName } : {}
    });
    return {
      runId: createTextRunId(blockId, index),
      text: sanitizeDocumentText(item.str),
      style: lineHeight === void 0 ? style : { ...style, lineHeight }
    };
  });
  const tocEntry = role === "code" ? void 0 : parsePdfTableOfContentsLine(items.map((item) => item.str).join(""));
  const runs = tocEntry ? [
    {
      runId: createTextRunId(blockId, 0),
      text: tocEntry.title,
      ...itemRuns[0]?.style ? { style: { ...itemRuns[0].style } } : {}
    },
    {
      runId: createTextRunId(blockId, 1),
      text: tocEntry.leader,
      ...itemRuns[0]?.style ? { style: { ...itemRuns[0].style } } : {},
      protected: true
    },
    {
      runId: createTextRunId(blockId, 2),
      text: tocEntry.pageNumber,
      ...itemRuns[0]?.style ? { style: { ...itemRuns[0].style } } : {},
      protected: true
    }
  ] : itemRuns;
  const primaryFontSize = runs[0]?.style?.fontSize ?? 0;
  const textAlign = inferPdfTextAlignment(bbox, pageWidth, primaryFontSize, bodyFontSize, contentArea);
  return {
    kind: "text",
    blockId,
    readingOrder,
    translatable: true,
    role,
    bbox,
    ...textAlign ? { textAlign } : {},
    runs,
    ...tocEntry ? { toc: { pageNumber: tocEntry.pageNumber } } : {},
    ...codeFrame ? { codeFrame } : {}
  };
}
function pdfTextItemInsideRegion(item, bbox, region) {
  if (!item.str.trim()) return false;
  const centerX = bbox.x + bbox.width / 2;
  const centerY = bbox.y + bbox.height / 2;
  return centerX >= region.x - PDF_TABLE_LINE_TOLERANCE && centerX <= region.x + region.width + PDF_TABLE_LINE_TOLERANCE && centerY >= region.y - PDF_TABLE_LINE_TOLERANCE && centerY <= region.y + region.height + PDF_TABLE_LINE_TOLERANCE;
}
function createPdfTableBlock(grid, lines, pageId, fingerprint, pageHeight, pageWidth, bodyFontSize, styles, lineHeights, contentArea) {
  const tableId = createDocumentBlockId(fingerprint, pageId, 0, "table");
  const rowCount = Math.max(1, grid.rows.length - 1);
  const columnCount = Math.max(1, grid.columns.length - 1);
  const cellItems = Array.from(
    { length: rowCount },
    () => Array.from({ length: columnCount }, () => [])
  );
  const remainingLines = [];
  for (const line of lines) {
    const intersectsGrid = line.bbox.x + line.bbox.width >= grid.bbox.x - PDF_TABLE_LINE_TOLERANCE && line.bbox.x <= grid.bbox.x + grid.bbox.width + PDF_TABLE_LINE_TOLERANCE && line.bbox.y + line.bbox.height >= grid.bbox.y - PDF_TABLE_LINE_TOLERANCE && line.bbox.y <= grid.bbox.y + grid.bbox.height + PDF_TABLE_LINE_TOLERANCE;
    if (!intersectsGrid) {
      remainingLines.push(line);
      continue;
    }
    let matchedItem = false;
    for (const item of line.items) {
      const itemBbox = textItemBoundingBox(item, pageHeight);
      if (!pdfTextItemInsideRegion(item, itemBbox, grid.bbox)) continue;
      const centerX = itemBbox.x + itemBbox.width / 2;
      const centerY = itemBbox.y + itemBbox.height / 2;
      const leftColumnIndex = grid.columns.findIndex((left, index) => index < grid.columns.length - 1 && itemBbox.x >= left - PDF_TABLE_LINE_TOLERANCE && itemBbox.x < grid.columns[index + 1] - PDF_TABLE_LINE_TOLERANCE);
      const centerColumnIndex = leftColumnIndex >= 0 ? leftColumnIndex : grid.columns.findIndex((left, index) => index < grid.columns.length - 1 && centerX >= left - PDF_TABLE_LINE_TOLERANCE && centerX < grid.columns[index + 1] - PDF_TABLE_LINE_TOLERANCE);
      const rowIndex = grid.rows.findIndex((top, index) => index < grid.rows.length - 1 && centerY >= top - PDF_TABLE_LINE_TOLERANCE && centerY <= grid.rows[index + 1] + PDF_TABLE_LINE_TOLERANCE);
      if (centerColumnIndex < 0 || rowIndex < 0) continue;
      cellItems[rowIndex][centerColumnIndex].push({ item, bbox: itemBbox });
      matchedItem = true;
    }
    if (!matchedItem && pdfTextItemInsideRegion(line.items[0] ?? { str: "" }, line.bbox, grid.bbox)) {
      remainingLines.push(line);
    }
  }
  const rows = cellItems.map((cells, rowIndex) => ({
    rowId: createTableRowId(tableId, rowIndex),
    cells: cells.map((entries, cellIndex) => {
      const cellId = createTableCellId(fingerprint, pageId, tableId, rowIndex, cellIndex);
      const cellLeft = grid.columns[cellIndex];
      const cellRight = grid.columns[cellIndex + 1];
      const cellTop = grid.rows[rowIndex];
      const cellBottom = grid.rows[rowIndex + 1];
      const sortedEntries = [...entries].sort((left, right) => left.bbox.y - right.bbox.y || left.bbox.x - right.bbox.x);
      const childBlocks = [];
      let currentEntries = [];
      let currentLine;
      for (const entry of sortedEntries) {
        const sourceLine = lines.find((line) => line.items.includes(entry.item));
        if (currentLine && sourceLine !== currentLine) {
          childBlocks.push(createPdfTableCellTextBlock(
            currentEntries,
            cellId,
            childBlocks.length,
            currentLine,
            pageWidth,
            bodyFontSize,
            styles,
            lineHeights,
            contentArea,
            cellLeft,
            cellRight,
            cellTop,
            cellBottom
          ));
          currentEntries = [];
        }
        currentEntries.push(entry);
        currentLine = sourceLine;
      }
      if (currentEntries.length > 0 && currentLine) {
        childBlocks.push(createPdfTableCellTextBlock(
          currentEntries,
          cellId,
          childBlocks.length,
          currentLine,
          pageWidth,
          bodyFontSize,
          styles,
          lineHeights,
          contentArea,
          cellLeft,
          cellRight,
          cellTop,
          cellBottom
        ));
      }
      return { cellId, rowSpan: 1, colSpan: 1, blocks: childBlocks };
    })
  }));
  return {
    table: {
      kind: "table",
      blockId: tableId,
      readingOrder: 0,
      translatable: true,
      bbox: grid.bbox,
      rows,
      columnWidths: grid.columns.slice(1).map((right, index) => Math.round((right - grid.columns[index]) * 100) / 100),
      headerRows: rowCount > 1 ? 1 : 0
    },
    remainingLines
  };
}
function pdfTableCellIndexForRegion(grid, region) {
  const left = region.bbox.x;
  const right = region.bbox.x + region.bbox.width;
  const top = region.bbox.y;
  const bottom = region.bbox.y + region.bbox.height;
  const centerX = left + region.bbox.width / 2;
  const centerY = top + region.bbox.height / 2;
  const imageArea = Math.max(1, region.bbox.width * region.bbox.height);
  let best;
  for (let rowIndex = 0; rowIndex < grid.rows.length - 1; rowIndex += 1) {
    const cellTop = grid.rows[rowIndex];
    const cellBottom = grid.rows[rowIndex + 1];
    for (let cellIndex = 0; cellIndex < grid.columns.length - 1; cellIndex += 1) {
      const cellLeft = grid.columns[cellIndex];
      const cellRight = grid.columns[cellIndex + 1];
      const overlapWidth = Math.max(0, Math.min(right, cellRight) - Math.max(left, cellLeft));
      const overlapHeight = Math.max(0, Math.min(bottom, cellBottom) - Math.max(top, cellTop));
      const overlap = overlapWidth * overlapHeight;
      const centerInside = centerX >= cellLeft - PDF_TABLE_LINE_TOLERANCE && centerX <= cellRight + PDF_TABLE_LINE_TOLERANCE && centerY >= cellTop - PDF_TABLE_LINE_TOLERANCE && centerY <= cellBottom + PDF_TABLE_LINE_TOLERANCE;
      if ((centerInside || overlap / imageArea >= 0.6) && (!best || overlap > best.overlap)) {
        best = { rowIndex, cellIndex, overlap };
      }
    }
  }
  return best ? { rowIndex: best.rowIndex, cellIndex: best.cellIndex } : void 0;
}
function appendPdfTableCellBlock(table, rowIndex, cellIndex, block) {
  const cell = table.rows[rowIndex]?.cells[cellIndex];
  if (!cell) return false;
  cell.blocks.push(block);
  cell.blocks.sort((left, right) => {
    const leftY = left.bbox?.y ?? Number.POSITIVE_INFINITY;
    const rightY = right.bbox?.y ?? Number.POSITIVE_INFINITY;
    if (leftY !== rightY) return leftY - rightY;
    return (left.bbox?.x ?? Number.POSITIVE_INFINITY) - (right.bbox?.x ?? Number.POSITIVE_INFINITY);
  });
  return true;
}
function createPdfTableCellBlockId(cellId, readingOrder) {
  return `${cellId}-block-${readingOrder}`;
}
function createPdfTableCellTextBlock(entries, cellId, readingOrder, line, pageWidth, bodyFontSize, styles, lineHeights, contentArea, cellLeft, cellRight, cellTop, cellBottom) {
  const blockId = createPdfTableCellBlockId(cellId, readingOrder);
  const lineHeight = lineHeights.get(line);
  const runs = entries.map(({ item }, index) => {
    const fontStyle = item.fontName ? styles[item.fontName] : void 0;
    const style = pdfTextStyle(item, {
      ...fontStyle,
      ...item.fontName ? { key: item.fontName } : {}
    });
    return {
      runId: createTextRunId(blockId, index),
      text: sanitizeDocumentText(item.str),
      style: lineHeight === void 0 ? style : { ...style, lineHeight }
    };
  });
  const bbox = {
    x: Math.max(cellLeft, Math.min(...entries.map((entry) => entry.bbox.x))),
    y: Math.max(cellTop, Math.min(...entries.map((entry) => entry.bbox.y))),
    width: Math.max(1, Math.min(cellRight, Math.max(...entries.map((entry) => entry.bbox.x + entry.bbox.width))) - Math.max(cellLeft, Math.min(...entries.map((entry) => entry.bbox.x)))),
    height: Math.max(1, Math.min(cellBottom, Math.max(...entries.map((entry) => entry.bbox.y + entry.bbox.height))) - Math.max(cellTop, Math.min(...entries.map((entry) => entry.bbox.y))))
  };
  const primaryFontSize = runs[0]?.style?.fontSize ?? 0;
  const textAlign = inferPdfTextAlignment(bbox, pageWidth, primaryFontSize, bodyFontSize, contentArea);
  return {
    kind: "text",
    blockId,
    readingOrder,
    translatable: true,
    role: "paragraph",
    bbox,
    ...textAlign ? { textAlign } : {},
    runs
  };
}
function enrichPdfFontStyles(page, items, styles) {
  const result = {};
  for (const [key, style] of Object.entries(styles)) {
    let font;
    try {
      font = page.commonObjs?.get(key);
    } catch {
      font = void 0;
    }
    const candidate = font && typeof font === "object" ? font : void 0;
    const fontName = typeof candidate?.name === "string" && candidate.name.trim() ? candidate.name : typeof candidate?.loadedName === "string" && candidate.loadedName.trim() ? candidate.loadedName : typeof style.fontFamily === "string" ? style.fontFamily : key;
    const cssWeight = candidate?.cssFontInfo?.fontWeight;
    const cssItalicAngle = candidate?.cssFontInfo?.italicAngle;
    const fontWeight = cssWeight === "bold" || cssWeight === "700" || typeof cssWeight === "number" && cssWeight >= 600 ? 700 : void 0;
    const flags = pdfFontStyleFlags(key, {
      ...style,
      fontName,
      ...fontWeight ? { fontWeight } : {},
      ...typeof candidate?.bold === "boolean" ? { bold: candidate.bold } : {},
      ...typeof candidate?.italic === "boolean" ? { italic: candidate.italic } : {},
      ...typeof cssItalicAngle === "number" && cssItalicAngle !== 0 ? { italic: true } : {}
    });
    result[key] = {
      ...style,
      key,
      fontName,
      ...flags.fontWeight ? { fontWeight: flags.fontWeight } : {},
      ...flags.italic ? { italic: true } : {}
    };
  }
  for (const item of items) {
    if (!item.fontName || result[item.fontName]) continue;
    const flags = pdfFontStyleFlags(item.fontName, void 0);
    result[item.fontName] = {
      key: item.fontName,
      fontName: item.fontName,
      ...flags.fontWeight ? { fontWeight: flags.fontWeight } : {},
      ...flags.italic ? { italic: true } : {}
    };
  }
  return result;
}
async function createScannedPageImage(page, pageIndex, fingerprint, renderPageToImage, registerAssetBytes) {
  const pageId = createDocumentPageId(fingerprint, pageIndex);
  const blockId = createDocumentBlockId(fingerprint, pageId, 0, "image");
  const bytes = renderPageToImage ? await renderPageToImage(page, pageIndex) : null;
  const content = bytes ?? new Uint8Array();
  const dimensions = bytes ? readPngDimensions(bytes) : null;
  const viewport = page.getViewport({ scale: 1 });
  const sha256 = hashDocumentBytes(content);
  const assetId = `asset-${sha256.slice(0, 16)}`;
  if (bytes) registerAssetBytes?.(assetId, bytes);
  return {
    block: {
      kind: "image",
      blockId,
      readingOrder: 0,
      translatable: false,
      assetId,
      bbox: { x: 0, y: 0, width: viewport.width, height: viewport.height },
      renderPending: bytes === null
    },
    asset: {
      assetId,
      kind: "image",
      mimeType: "image/png",
      sha256,
      byteLength: content.byteLength,
      ...dimensions ? { width: dimensions.width, height: dimensions.height } : {}
    }
  };
}
function multiplyPdfMatrix(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5]
  ];
}
function asPdfMatrix(value) {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
  const values = Array.from(value);
  if (values.length !== 6 || values.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    return null;
  }
  return values;
}
function transformedImageBoundingBox(matrix, pageWidth, pageHeight) {
  const points = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => ({
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    // PDF.js 视口矩阵已经完成左下角原点到页面视图左上角的转换；
    // 此处只能应用图片操作符矩阵，不能再翻转一次，否则图片会上下颠倒。
    y: matrix[1] * x + matrix[3] * y + matrix[5]
  }));
  const left = Math.max(0, Math.min(pageWidth, Math.min(...points.map((point) => point.x))));
  const top = Math.max(0, Math.min(pageHeight, Math.min(...points.map((point) => point.y))));
  const right = Math.max(0, Math.min(pageWidth, Math.max(...points.map((point) => point.x))));
  const bottom = Math.max(0, Math.min(pageHeight, Math.max(...points.map((point) => point.y))));
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
function extractPdfImageRegions(operatorList, runtime, viewport) {
  const initial = asPdfMatrix(viewport.transform) ?? [1, 0, 0, -1, 0, viewport.height];
  let current = initial;
  const stack = [];
  const regions = [];
  const seen = /* @__PURE__ */ new Set();
  const saveOperation = runtime.OPS["save"];
  const restoreOperation = runtime.OPS["restore"];
  const transformOperation = runtime.OPS["transform"];
  const formBeginOperation = runtime.OPS["paintFormXObjectBegin"];
  const formEndOperation = runtime.OPS["paintFormXObjectEnd"];
  const imageOperations = new Set([
    runtime.OPS["paintImageXObject"],
    runtime.OPS["paintInlineImageXObject"]
  ].filter((value) => typeof value === "number"));
  const repeatOperation = runtime.OPS["paintImageXObjectRepeat"];
  const inlineGroupOperation = runtime.OPS["paintInlineImageXObjectGroup"];
  const addRegion = (matrix, objectId) => {
    const bbox = transformedImageBoundingBox(matrix, viewport.width, viewport.height);
    if (bbox.width < PDF_MIN_IMAGE_SIZE || bbox.height < PDF_MIN_IMAGE_SIZE || bbox.width * bbox.height < PDF_MIN_IMAGE_AREA) return;
    const key = [bbox.x, bbox.y, bbox.width, bbox.height].map((value) => value.toFixed(2)).join(":");
    if (seen.has(key)) return;
    seen.add(key);
    regions.push({ bbox, ...objectId ? { objectId } : {} });
  };
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    const args = operatorList.argsArray[index] ?? [];
    if (operation === saveOperation) {
      stack.push(current);
    } else if (operation === restoreOperation) {
      current = stack.pop() ?? initial;
    } else if (operation === transformOperation) {
      const transform = asPdfMatrix(args);
      if (transform) current = multiplyPdfMatrix(current, transform);
    } else if (operation === formBeginOperation) {
      stack.push(current);
      const transform = asPdfMatrix(args[0]);
      if (transform) current = multiplyPdfMatrix(current, transform);
    } else if (operation === formEndOperation) {
      current = stack.pop() ?? initial;
    } else if (imageOperations.has(operation)) {
      const objectId = operation === runtime.OPS["paintImageXObject"] && typeof args[0] === "string" ? args[0] : void 0;
      addRegion(current, objectId);
    } else if (operation === repeatOperation) {
      const scaleX = typeof args[1] === "number" ? args[1] : 1;
      const scaleY = typeof args[2] === "number" ? args[2] : 1;
      const positions = Array.from(args[3] ?? []);
      const objectId = typeof args[0] === "string" ? args[0] : void 0;
      for (let position = 0; position + 1 < positions.length; position += 2) {
        const x = positions[position];
        const y = positions[position + 1];
        if (typeof x !== "number" || typeof y !== "number") continue;
        addRegion(multiplyPdfMatrix(current, [scaleX, 0, 0, scaleY, x, y]), objectId);
      }
    } else if (operation === inlineGroupOperation && Array.isArray(args[1])) {
      for (const entry of args[1]) {
        if (!entry || typeof entry !== "object" || !("transform" in entry)) continue;
        const transform = asPdfMatrix(entry.transform);
        if (transform) addRegion(multiplyPdfMatrix(current, transform));
      }
    }
  }
  return regions;
}
async function createEmbeddedImageBlock(page, pageIndex, fingerprint, readingOrder, bbox, objectId, renderEmbeddedImageToImage, renderPageRegionToImage, registerAssetBytes, assetBytesById) {
  const pageId = createDocumentPageId(fingerprint, pageIndex);
  let bytes = null;
  if (objectId && renderEmbeddedImageToImage) {
    try {
      bytes = await renderEmbeddedImageToImage(page, pageIndex, objectId);
    } catch (error) {
      if (isPdfAbortError(error)) throw error;
    }
  }
  if (!bytes && renderPageRegionToImage) {
    bytes = await renderPageRegionToImage(page, pageIndex, bbox);
  }
  const content = bytes ?? new TextEncoder().encode(`pdf-image:${pageIndex}:${readingOrder}`);
  const dimensions = bytes ? readPngDimensions(bytes) : null;
  const sha256 = hashDocumentBytes(content);
  const assetId = `asset-${sha256.slice(0, 16)}`;
  if (bytes) {
    assetBytesById.set(assetId, bytes);
    registerAssetBytes?.(assetId, bytes);
  }
  return {
    block: {
      kind: "image",
      blockId: createDocumentBlockId(fingerprint, pageId, readingOrder, "image"),
      readingOrder,
      translatable: false,
      bbox,
      assetId,
      alt: "Embedded PDF image",
      renderPending: bytes === null
    },
    asset: {
      assetId,
      kind: "image",
      mimeType: "image/png",
      sha256,
      byteLength: content.byteLength,
      ...dimensions ? { width: dimensions.width, height: dimensions.height } : {}
    }
  };
}
function orderPdfPageBlocks(blocks, pageId, fingerprint) {
  const ordered = blocks.map((block, sourceIndex) => ({ block, sourceIndex })).sort((left, right) => {
    const leftY = left.block.bbox?.y ?? Number.POSITIVE_INFINITY;
    const rightY = right.block.bbox?.y ?? Number.POSITIVE_INFINITY;
    if (leftY !== rightY) return leftY - rightY;
    const leftX = left.block.bbox?.x ?? Number.POSITIVE_INFINITY;
    const rightX = right.block.bbox?.x ?? Number.POSITIVE_INFINITY;
    if (leftX !== rightX) return leftX - rightX;
    return left.sourceIndex - right.sourceIndex;
  });
  let flowGroupIndex = 0;
  const flowGroups = /* @__PURE__ */ new Map();
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    const next = ordered[index + 1];
    if (!next || !pdfBlocksShareVisualRow(current.block, next.block)) continue;
    const groupId = `flow-${createDocumentBlockId(fingerprint, pageId, index, "shape")}-${flowGroupIndex}`.replace(/^flow-block-/u, "flow-");
    flowGroups.set(index, groupId);
    flowGroups.set(index + 1, groupId);
    flowGroupIndex += 1;
    index += 1;
  }
  return ordered.map(({ block }, readingOrder) => {
    const flowGroupId = flowGroups.get(readingOrder);
    const blockId = createDocumentBlockId(fingerprint, pageId, readingOrder, block.kind);
    if (block.kind === "text") {
      return {
        ...block,
        blockId,
        readingOrder,
        ...flowGroupId ? { flowGroupId } : {},
        runs: block.runs.map((run, index) => ({ ...run, runId: createTextRunId(blockId, index) }))
      };
    }
    if (block.kind === "table") {
      return {
        ...block,
        blockId,
        readingOrder,
        ...flowGroupId ? { flowGroupId } : {},
        rows: block.rows.map((row, rowIndex) => ({
          ...row,
          rowId: createTableRowId(blockId, rowIndex),
          cells: row.cells.map((cell, cellIndex) => {
            const cellId = createTableCellId(fingerprint, pageId, blockId, rowIndex, cellIndex);
            return {
              ...cell,
              cellId,
              blocks: cell.blocks.map((child, childIndex) => {
                const childBlockId = createPdfTableCellBlockId(cellId, childIndex);
                if (child.kind === "image") {
                  return { ...child, blockId: childBlockId, readingOrder: childIndex };
                }
                if (child.kind !== "text") return child;
                return {
                  ...child,
                  blockId: childBlockId,
                  runs: child.runs.map((run, runIndex) => ({
                    ...run,
                    runId: createTextRunId(childBlockId, runIndex)
                  }))
                };
              })
            };
          })
        }))
      };
    }
    return { ...block, blockId, readingOrder, ...flowGroupId ? { flowGroupId } : {} };
  });
}
async function parsePdfDocument(input, options = {}) {
  const runtime = await loadPdfJs();
  const pdfBytes = input.bytes instanceof Uint8Array && !Buffer.isBuffer(input.bytes) ? input.bytes : new Uint8Array(input.bytes);
  const loadingTask = runtime.getDocument({
    data: pdfBytes,
    canvasFactory: createPdfCanvasFactory(),
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0
  });
  const document = await loadingTask.promise;
  try {
    const pageCount = Math.min(document.numPages, DOCUMENT_MAX_PAGES);
    const pages = [];
    const assets = [];
    const warnings = [];
    if (document.numPages > DOCUMENT_MAX_PAGES) {
      warnings.push(createDocumentWarning("page-limit-reached", "The PDF page limit was reached; remaining pages were skipped."));
    }
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      if (options.signal?.aborted) throw createPdfAbortError();
      const page = await document.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 1 });
      const pageId = createDocumentPageId(input.sha256, pageIndex);
      const textContent = await page.getTextContent();
      const hasNativeText = textContent.items.some((item) => item.str.trim().length > 0);
      const blocks = [];
      const operatorList = await page.getOperatorList();
      const imageRegions = extractPdfImageRegions(operatorList, runtime, viewport);
      let contentArea;
      const tableGridTargets = [];
      if (hasNativeText) {
        applyPdfTextColors(textContent.items, extractPdfTextColors(operatorList, runtime));
        const styles = enrichPdfFontStyles(page, textContent.items, textContent.styles ?? {});
        const lines = groupPdfTextItems(textContent.items, viewport.height);
        const bodyFontSize = inferPdfBodyFontSize(lines);
        const lineHeights = inferPdfLineHeights(lines);
        contentArea = inferPdfContentArea(lines, viewport.width);
        const rawGridLines = extractPdfGridLines(operatorList, runtime, viewport);
        const gridLines = mergePdfGridLines(rawGridLines);
        const closedDetectedGrids = detectPdfTableGrids(gridLines, lines);
        const textRowDetectedGrids = detectPdfTextRowTableGrids(
          rawGridLines,
          lines,
          viewport.width,
          viewport.height
        );
        const filteredTextRowGrids = textRowDetectedGrids.filter((candidate) => !closedDetectedGrids.some((closed) => closed.columns.length >= 3 && pdfGridsHaveSubstantialOverlap(candidate, closed)));
        const detectedGrids = preferPdfMultiColumnGrids([
          ...closedDetectedGrids,
          ...filteredTextRowGrids
        ].map((grid) => refinePdfSingleColumnGrid(grid, rawGridLines, lines, viewport.height))).filter((grid) => !isPdfHeaderImageGrid(grid, imageRegions));
        const pageFrameGrids = detectedGrids.filter((grid) => isPdfPageFrameGrid(grid, viewport.width, viewport.height));
        const tableCandidateGrids = detectedGrids.filter((grid) => !pageFrameGrids.includes(grid));
        const nonOpenContainerGrids = filterPdfOpenContainerGrids(tableCandidateGrids, gridLines);
        const closedCodeFrameGrids = selectPdfCodeFrames(
          nonOpenContainerGrids,
          lines,
          styles
        );
        const openCodeContainers = detectPdfOpenCodeContainers(
          gridLines,
          lines,
          styles,
          tableCandidateGrids
        );
        const allCodeFrameGrids = [...closedCodeFrameGrids, ...openCodeContainers.codeRegions];
        const tableCandidates = filterPdfCodeFrameGrids(
          nonOpenContainerGrids,
          lines,
          styles
        );
        const mergedGrids = mergeAdjacentPdfTableGrids(
          filterPdfOpenContainerGrids(tableCandidates, gridLines)
        ).map((grid) => trimPdfFormContainerBottom(grid, gridLines, lines));
        const grids = filterNestedPdfTableGrids(mergedGrids);
        let remainingLines = [...lines];
        const tableBlocks = [];
        for (const grid of grids) {
          const parsed = createPdfTableBlock(
            grid,
            remainingLines,
            pageId,
            input.sha256,
            viewport.height,
            viewport.width,
            bodyFontSize,
            styles,
            lineHeights,
            contentArea
          );
          if (parsed.table.rows.some((row) => row.cells.some((cell) => cell.blocks.length > 0))) {
            tableBlocks.push(parsed.table);
            tableGridTargets.push({ table: parsed.table, grid });
            remainingLines = parsed.remainingLines;
          }
        }
        const paragraphs = groupPdfParagraphs(
          remainingLines,
          viewport.width,
          bodyFontSize,
          styles,
          lineHeights,
          contentArea,
          allCodeFrameGrids
        );
        blocks.push(...tableBlocks, ...createPdfDividerBlocks(
          gridLines,
          grids,
          pageFrameGrids,
          [...allCodeFrameGrids, ...openCodeContainers.clipRegions],
          viewport.width,
          viewport.height,
          pageId,
          input.sha256
        ), ...paragraphs.map((paragraph, readingOrder) => createPdfTextBlock(
          paragraph.items,
          pageId,
          input.sha256,
          readingOrder,
          paragraph.bbox,
          viewport.width,
          bodyFontSize,
          styles,
          paragraph.lineHeight,
          contentArea,
          paragraph.codeFrame ? "code" : "paragraph",
          paragraph.codeFrameIndex === void 0 ? void 0 : allCodeFrameGrids[paragraph.codeFrameIndex]?.bbox
        )));
      }
      const isBlankPage = blocks.length === 0 && !hasVisiblePdfPageContent(operatorList, runtime);
      if (blocks.length === 0 && !isBlankPage) {
        const scanned = await createScannedPageImage(
          page,
          pageIndex,
          input.sha256,
          options.renderPageToImage,
          options.registerAssetBytes
        );
        blocks.push(scanned.block);
        assets.push(scanned.asset);
        if (scanned.block.renderPending) {
          warnings.push(createDocumentWarning(
            "ocr-required",
            "A scanned page requires local rendering before OCR.",
            { pageId, blockId: scanned.block.blockId }
          ));
        }
      } else if (blocks.length > 0) {
        const regions = imageRegions;
        const availableImageSlots = Math.max(0, DOCUMENT_MAX_IMAGES - assets.length);
        const acceptedRegions = regions.slice(0, availableImageSlots);
        if (regions.length > acceptedRegions.length) {
          warnings.push(createDocumentWarning("image-limit-reached", "The PDF image limit was reached; remaining images were skipped.", { pageId }));
        }
        const assetBytesById = /* @__PURE__ */ new Map();
        for (let regionIndex = 0; regionIndex < acceptedRegions.length; regionIndex += 1) {
          if (options.signal?.aborted) throw createPdfAbortError();
          const region = acceptedRegions[regionIndex];
          const image = await createEmbeddedImageBlock(
            page,
            pageIndex,
            input.sha256,
            blocks.length + regionIndex,
            region.bbox,
            region.objectId,
            options.renderEmbeddedImageToImage,
            options.renderPageRegionToImage,
            options.registerAssetBytes,
            assetBytesById
          );
          let tableTarget;
          let cellIndex;
          for (const target of tableGridTargets) {
            const targetCell = pdfTableCellIndexForRegion(target.grid, region);
            if (!targetCell) continue;
            tableTarget = target;
            cellIndex = targetCell;
            break;
          }
          if (!tableTarget || !cellIndex || !appendPdfTableCellBlock(
            tableTarget.table,
            cellIndex.rowIndex,
            cellIndex.cellIndex,
            image.block
          )) {
            blocks.push(image.block);
          }
          if (!assets.some((asset) => asset.assetId === image.asset.assetId)) assets.push(image.asset);
        }
        if (acceptedRegions.length > 0) {
          warnings.push(createDocumentWarning("embedded-image-ocr-required", "The PDF page contains images whose text will be recognized during OCR.", { pageId }));
        }
      }
      pages.push({
        pageId,
        index: pageIndex,
        width: viewport.width,
        height: viewport.height,
        ...contentArea ? { contentArea } : {},
        ...isBlankPage ? { background: { kind: "solid", color: "#ffffff" } } : {},
        blocks: orderPdfPageBlocks(blocks, pageId, input.sha256)
      });
      if (options.signal?.aborted) throw createPdfAbortError();
    }
    return {
      schemaVersion: 1,
      documentId: createDocumentModelId(input.sha256),
      source: {
        path: input.path,
        fileName: input.fileName,
        format: "pdf",
        sha256: input.sha256,
        size: input.bytes.byteLength,
        pageCount: pages.length
      },
      metadata: { direction: "auto" },
      pages,
      assets,
      warnings
    };
  } finally {
    await document.destroy();
  }
}

// ../../../../../private/tmp/inspect-pdf-images.ts
var pdfjs = "default" in pdfjsModule ? pdfjsModule.default : pdfjsModule;
var worker = "default" in workerModule ? workerModule.default : workerModule;
globalThis.pdfjsWorker = worker;
var path = "/Users/mac/Downloads/\u8F6C\u6362\u5957\u4EF6\u4EA7\u54C1\u63A5\u53E3\u6587\u6863 (1).pdf";
var model = await parsePdfDocument({ path, fileName: "doc.pdf", format: "pdf", sha256: "inspect", bytes: readFileSync(path) });
for (const page of model.pages) {
  const tables = page.blocks.filter((b) => b.kind === "table");
  const cellImages = tables.flatMap((t) => t.rows.flatMap((r, ri) => r.cells.flatMap((c, ci) => c.blocks.filter((x) => x.kind === "image").map((x) => ({ ri, ci, x })))));
  if (cellImages.length || tables.length) {
    console.log(`PAGE ${page.index + 1}: tables=${tables.length}, cellImages=${cellImages.length}`);
    for (const item of cellImages) console.log(JSON.stringify(item));
  }
}
