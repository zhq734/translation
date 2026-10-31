// src/main/documentPdfRasterizer.ts
var DOCUMENT_PDF_RENDER_SCALE = 2;
var DOCUMENT_PDF_MAX_RENDER_PIXELS = 2e7;
function createAbortError() {
  const error = new Error("PDF rendering was aborted");
  error.name = "AbortError";
  return error;
}
function isAborted(signal) {
  return signal?.aborted === true;
}
function createDocumentPdfRasterizerBundle(dependencies) {
  const scale = Number.isFinite(dependencies.scale) && (dependencies.scale ?? 0) > 0 ? dependencies.scale : DOCUMENT_PDF_RENDER_SCALE;
  const maxPixels = Number.isFinite(dependencies.maxPixels) && (dependencies.maxPixels ?? 0) > 0 ? Math.floor(dependencies.maxPixels) : DOCUMENT_PDF_MAX_RENDER_PIXELS;
  let cachedPageIndex = -1;
  let cachedPage = null;
  let cachedCanvas = null;
  let cachedPng = null;
  let pendingPageIndex = -1;
  let pendingPage = null;
  let pendingRender = null;
  const clearCache = () => {
    cachedPageIndex = -1;
    cachedPage = null;
    cachedCanvas = null;
    cachedPng = null;
  };
  const getPageCanvas = async (page, pageIndex) => {
    if (isAborted(dependencies.signal)) throw createAbortError();
    if (cachedPage === page && cachedPageIndex === pageIndex) return cachedCanvas;
    if (pendingRender && pendingPage === page && pendingPageIndex === pageIndex) {
      return pendingRender;
    }
    clearCache();
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width * height > maxPixels) {
      return null;
    }
    pendingPage = page;
    pendingPageIndex = pageIndex;
    pendingRender = (async () => {
      const canvas = dependencies.createCanvas(width, height);
      const context = canvas.getContext("2d");
      let renderTask = null;
      const abortCleanup = [];
      try {
        if (isAborted(dependencies.signal)) throw createAbortError();
        renderTask = page.render({ canvasContext: context, viewport, background: "white" });
        const abortPromise = new Promise((_resolve, reject) => {
          if (!dependencies.signal) return;
          const onAbort = () => {
            renderTask?.cancel();
            reject(createAbortError());
          };
          dependencies.signal.addEventListener("abort", onAbort, { once: true });
          abortCleanup.push(() => {
            dependencies.signal?.removeEventListener("abort", onAbort);
          });
        });
        await Promise.race([renderTask.promise, abortPromise]);
        if (isAborted(dependencies.signal)) throw createAbortError();
        cachedPage = page;
        cachedPageIndex = pageIndex;
        cachedCanvas = canvas;
        return canvas;
      } finally {
        for (const cleanup of abortCleanup) cleanup();
        if (isAborted(dependencies.signal)) renderTask?.cancel();
        pendingPage = null;
        pendingPageIndex = -1;
        pendingRender = null;
      }
    })();
    return pendingRender;
  };
  const renderPage = async (page, pageIndex) => {
    const canvas = await getPageCanvas(page, pageIndex);
    if (!canvas) return null;
    if (cachedPng) return cachedPng;
    const png = canvas.toBuffer("image/png");
    const bytes = png instanceof Uint8Array ? png : new Uint8Array(png);
    cachedPng = bytes;
    return bytes;
  };
  const renderRegion = async (page, pageIndex, bbox) => {
    if (isAborted(dependencies.signal)) throw createAbortError();
    if (!Number.isFinite(bbox.x) || !Number.isFinite(bbox.y) || !Number.isFinite(bbox.width) || !Number.isFinite(bbox.height) || bbox.width <= 0 || bbox.height <= 0) return null;
    const unscaledViewport = page.getViewport({ scale: 1 });
    const left = Math.max(0, Math.min(unscaledViewport.width, bbox.x));
    const top = Math.max(0, Math.min(unscaledViewport.height, bbox.y));
    const right = Math.max(0, Math.min(unscaledViewport.width, bbox.x + bbox.width));
    const bottom = Math.max(0, Math.min(unscaledViewport.height, bbox.y + bbox.height));
    if (right <= left || bottom <= top) return null;
    const canvas = await getPageCanvas(page, pageIndex);
    if (!canvas) return null;
    if (isAborted(dependencies.signal)) throw createAbortError();
    const sourceX = Math.max(0, Math.floor(left * scale));
    const sourceY = Math.max(0, Math.floor(top * scale));
    const sourceRight = Math.min(canvas.width, Math.ceil(right * scale));
    const sourceBottom = Math.min(canvas.height, Math.ceil(bottom * scale));
    const width = sourceRight - sourceX;
    const height = sourceBottom - sourceY;
    if (width <= 0 || height <= 0) return null;
    const target = dependencies.createCanvas(width, height);
    const context = target.getContext("2d");
    context.drawImage(canvas, sourceX, sourceY, width, height, 0, 0, width, height);
    if (isAborted(dependencies.signal)) throw createAbortError();
    const png = target.toBuffer("image/png");
    return png instanceof Uint8Array ? png : new Uint8Array(png);
  };
  return { renderPage, renderRegion };
}

// src/main/documentPdfRuntime.ts
var PDF_IMAGE_KIND_RGB_24BPP = 2;
var PDF_IMAGE_KIND_RGBA_32BPP = 3;
var runtimePromise = null;
function createRuntimeAbortError() {
  const error = new Error("PDF image export was aborted");
  error.name = "AbortError";
  return error;
}
function isRuntimeAborted(signal) {
  return signal?.aborted === true;
}
async function getPdfImageObject(store, objectId, signal) {
  if (!store) throw new Error("PDF image object store is unavailable");
  if (isRuntimeAborted(signal)) throw createRuntimeAbortError();
  if (store.has?.(objectId)) {
    return store.get(objectId);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(createRuntimeAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    store.get(objectId, (value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    });
  });
}
function createPdfImageData(image, context) {
  if (!context.createImageData || !context.putImageData) {
    throw new Error("PDF canvas does not support raw image data");
  }
  const imageData = context.createImageData(image.width, image.height);
  const source = image.data;
  if (!source) throw new Error("PDF image pixel data is unavailable");
  const expectedRgbaLength = image.width * image.height * 4;
  if (image.kind === PDF_IMAGE_KIND_RGBA_32BPP) {
    if (source.byteLength < expectedRgbaLength) throw new Error("PDF RGBA image data is truncated");
    imageData.data.set(source.subarray(0, expectedRgbaLength));
    return imageData;
  }
  if (image.kind === PDF_IMAGE_KIND_RGB_24BPP) {
    const expectedRgbLength = image.width * image.height * 3;
    if (source.byteLength < expectedRgbLength) throw new Error("PDF RGB image data is truncated");
    let sourceOffset = 0;
    let targetOffset = 0;
    while (sourceOffset < expectedRgbLength) {
      imageData.data[targetOffset] = source[sourceOffset];
      imageData.data[targetOffset + 1] = source[sourceOffset + 1];
      imageData.data[targetOffset + 2] = source[sourceOffset + 2];
      imageData.data[targetOffset + 3] = 255;
      sourceOffset += 3;
      targetOffset += 4;
    }
    return imageData;
  }
  throw new Error(`Unsupported PDF image kind: ${String(image.kind)}`);
}
function createPdfEmbeddedImageExporter(createCanvas, signal) {
  return async (page, _pageIndex, objectId) => {
    if (isRuntimeAborted(signal)) throw createRuntimeAbortError();
    const store = objectId.startsWith("g_") ? page.commonObjs : page.objs;
    const image = await getPdfImageObject(store, objectId, signal);
    if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0) return null;
    if (image.kind === 1) return null;
    if (isRuntimeAborted(signal)) throw createRuntimeAbortError();
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    if (image.bitmap) {
      context.drawImage(image.bitmap, 0, 0, image.width, image.height, 0, 0, image.width, image.height);
    } else {
      const imageData = createPdfImageData(image, context);
      context.putImageData?.(imageData, 0, 0);
    }
    if (isRuntimeAborted(signal)) throw createRuntimeAbortError();
    const png = canvas.toBuffer("image/png");
    return png instanceof Uint8Array ? png : new Uint8Array(png);
  };
}
async function loadPdfRuntime() {
  const canvasModule = await import("canvas");
  if (typeof canvasModule.createCanvas !== "function") {
    throw new Error("PDF canvas runtime is unavailable");
  }
  try {
    const polyfillModule = await import("path2d-polyfill");
    polyfillModule.polyfillPath2D(globalThis);
  } catch {
  }
  return { createCanvas: (width, height) => canvasModule.createCanvas(width, height) };
}
function getPdfRuntime() {
  runtimePromise ??= loadPdfRuntime();
  return runtimePromise;
}
async function createProductionPdfRasterizer(signal, dependencies = {}) {
  const runtime = dependencies.createCanvas ? { createCanvas: dependencies.createCanvas } : await getPdfRuntime();
  const rasterizer = createDocumentPdfRasterizerBundle({
    ...dependencies,
    createCanvas: runtime.createCanvas,
    ...signal ? { signal } : {}
  });
  return {
    renderPageToImage: rasterizer.renderPage,
    renderPageRegionToImage: rasterizer.renderRegion,
    renderEmbeddedImageToImage: createPdfEmbeddedImageExporter(runtime.createCanvas, signal)
  };
}
function resetProductionPdfRuntime() {
  runtimePromise = null;
}
export {
  createPdfEmbeddedImageExporter,
  createProductionPdfRasterizer,
  resetProductionPdfRuntime
};
