import type { PrintToPDFOptions } from 'electron'
import type { DocumentModel, DocumentWarning } from '../shared/documentTypes.ts'
import type { DocumentPdfExportResult } from './documentWorkspaceTaskService.ts'
import type { DocumentPartialExportSummary } from '../shared/documentPartialExport.ts'
import { resolveTranslationWatermarkHorizontalOffset } from '../renderer/src/documentPdfLayout.ts'

/** 默认 A4 页面宽度，单位为 PDF 点。 */
const DEFAULT_PAGE_WIDTH_PT = 612

/** 默认 A4 页面高度，单位为 PDF 点。 */
const DEFAULT_PAGE_HEIGHT_PT = 792

/** CSS 像素与 PDF 点之间的换算比例，即 96 / 72。 */
const CSS_PX_PER_PDF_POINT = 1.3333333333

/** 打印尺寸保留三位小数，消除 CSS 像素换算产生的浮点尾差。 */
const PRINT_POINT_PRECISION = 1000

/** Markdown 打印页四周留白，单位为 PDF 点。 */
const MARKDOWN_PRINT_MARGIN_PT = 25.2

/**
 * 生成打印前资源等待脚本。
 * 水印在打印时铺满整页，横向起点必须依据目标纸张宽度计算，不能沿用屏幕预览宽度。
 * @param watermarkOffset 水印图案相对页面左边缘的横向偏移，单位为 CSS 像素。
 * @param waitForPdfCanvas 是否逐页触发并等待 PDF.js Canvas 绘制完成。
 * @returns 可在文档窗口执行的打印准备脚本。
 * @author zhenghq
 */
function buildWaitForPrintReadyScript(watermarkOffset: number, waitForPdfCanvas = false): string {
  const offset = Number.isFinite(watermarkOffset)
    ? Math.round(watermarkOffset * PRINT_POINT_PRECISION) / PRINT_POINT_PRECISION
    : 0
  return `(async () => {
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const images = Array.from(document.querySelectorAll('#document-translation-content img'));
  await Promise.all(images.map(async (image) => {
    if (!image.complete) {
      await new Promise((resolve) => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      });
    }
    if (typeof image.decode === 'function') {
      try { await image.decode(); } catch {}
    }
  }));
  ${waitForPdfCanvas ? `// PDF.js loads pages lazily; scroll each page into view before printing so every canvas is ready.
  const pdfPages = Array.from(document.querySelectorAll('#document-translation-content .document-pdf-page'));
  for (const page of pdfPages) {
    page.scrollIntoView({ block: 'center', inline: 'nearest' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const canvas = page.querySelector('.document-pdf-canvas');
    if (canvas && (canvas.width <= 0 || canvas.height <= 0)) {
      await new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          if (canvas.width <= 0 || canvas.height <= 0) return;
          observer.disconnect();
          resolve();
        });
        observer.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
        setTimeout(() => { observer.disconnect(); resolve(); }, 3000);
      });
    }
  }
  if (pdfPages.length > 0) {
    pdfPages[0].scrollIntoView({ block: 'start', inline: 'nearest' });
  }` : ''}
  // Print layout is driven by the target paper width; reuse its offset instead of the screen viewport.
  for (const watermark of document.querySelectorAll('#document-translation-content .document-translation-watermark')) {
    const tile = watermark.querySelector('pattern');
    if (!tile) continue;
    const offset = ${offset};
    tile.setAttribute('x', String(offset === 0 ? 0 : offset));
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  ${waitForPdfCanvas ? `// OCR 译文可能增高图片容器，PDF 页还可能受内容可见性影响；透明文字层必须按底图真实矩形重新定位。
  const alignOcrTextLayers = () => {
    // 每次都在打印样式和异步布局稳定后重新查询，避免 OCR 更新替换节点后仍校正旧引用。
    const layers = Array.from(document.querySelectorAll(
      '#document-translation-content .document-ocr-print-text-layer'
    ));
    const round = (value) => Math.round(value * 1000) / 1000;
    for (const layer of layers) {
      const imageBlock = layer.closest('.document-image-block');
      const pdfPage = layer.closest('.document-pdf-page');
      const base = imageBlock
        ? imageBlock.querySelector(':scope > img.document-page-image')
        : pdfPage ? pdfPage.querySelector('.document-pdf-canvas') : null;
      const offsetParent = layer.offsetParent;
      if (!base || !(offsetParent instanceof HTMLElement)) {
        for (const property of [
          '--document-ocr-print-left',
          '--document-ocr-print-top',
          '--document-ocr-print-width',
          '--document-ocr-print-height'
        ]) layer.style.removeProperty(property);
        continue;
      }
      const baseRect = base.getBoundingClientRect();
      const parentRect = offsetParent.getBoundingClientRect();
      layer.style.setProperty(
        '--document-ocr-print-left',
        String(round(baseRect.left - parentRect.left - offsetParent.clientLeft)) + 'px'
      );
      layer.style.setProperty(
        '--document-ocr-print-top',
        String(round(baseRect.top - parentRect.top - offsetParent.clientTop)) + 'px'
      );
      layer.style.setProperty('--document-ocr-print-width', String(round(baseRect.width)) + 'px');
      layer.style.setProperty('--document-ocr-print-height', String(round(baseRect.height)) + 'px');
    }
  };
  alignOcrTextLayers();
  // 写入定位变量后再等待一帧，确保打印引擎读取到已经稳定的最终矩形。
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  alignOcrTextLayers();` : ''}
  return true;
})()`
}

/**
 * 生成部分导出的打印准备脚本。
 * 脚本必须在打印样式生效后等待字体、图片和布局稳定，再插入可见的部分结果标记；
 * 标记只存在于打印 DOM 中，打印结束后由 Renderer 恢复为最新预览。
 * @param watermarkOffset 水印图案相对页面左边缘的横向偏移，单位为 CSS 像素。
 * @param summary 部分导出目标统计。
 * @returns 可在文档窗口执行的打印准备脚本。
 * @author zhenghq
 */
function buildPreparePartialExportScript(
  watermarkOffset: number,
  summary: DocumentPartialExportSummary
): string {
  const offset = Number.isFinite(watermarkOffset)
    ? Math.round(watermarkOffset * PRINT_POINT_PRECISION) / PRINT_POINT_PRECISION
    : 0
  const safeSummary = JSON.stringify({
    total: Math.max(0, Math.trunc(summary.total)),
    translated: Math.max(0, Math.trunc(summary.translated)),
    unchanged: Math.max(0, Math.trunc(summary.unchanged)),
    reverted: Math.max(0, Math.trunc(summary.reverted)),
    failed: Math.max(0, Math.trunc(summary.failed)),
    pending: Math.max(0, Math.trunc(summary.pending)),
    suspectUntranslated: Math.max(0, Math.trunc(summary.suspectUntranslated))
  }).replace(/</gu, '\\u003c')
  return `(async () => {
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const images = Array.from(document.querySelectorAll('#document-translation-content img'));
  await Promise.all(images.map(async (image) => {
    if (!image.complete) {
      await new Promise((resolve) => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      });
    }
    if (typeof image.decode === 'function') {
      try { await image.decode(); } catch {}
    }
  }));
  for (const watermark of document.querySelectorAll('#document-translation-content .document-translation-watermark')) {
    const tile = watermark.querySelector('pattern');
    if (!tile) continue;
    const offset = ${offset};
    tile.setAttribute('x', String(offset === 0 ? 0 : offset));
  }
  const summary = ${safeSummary};
  if (!window.__documentPrintPreview || typeof window.__documentPrintPreview.preparePartialExport !== 'function') {
    throw new Error('document-print-preview-unavailable');
  }
  return window.__documentPrintPreview.preparePartialExport(summary, ${JSON.stringify('Partial result')});
})()`
}

/** 测量打印样式生效后译文页的最大真实高度。 */
const MEASURE_TRANSLATION_PAGE_HEIGHT_SCRIPT = `(() => {
  const pages = Array.from(document.querySelectorAll(
    '#document-translation-content .document-page, #document-translation-content .document-pdf-page'
  ));
  const pageHeightCssPx = Math.max(0, ...pages.map((page) => page.getBoundingClientRect().height));
  return { pageHeightCssPx };
})()`

/** PDF 打印稳定错误分类。 */
export type DocumentPdfPrintErrorCode = 'invalid-document' | 'export-failed'

/** 文档预览打印错误。 */
export class DocumentPdfPrintError extends Error {
  /** 可供界面本地化的稳定错误分类。 */
  readonly code: DocumentPdfPrintErrorCode

  /**
   * 创建文档预览打印错误。
   * @param code 稳定错误分类。
   * @param message 内部脱敏错误说明。
   * @author zhenghq
   */
  constructor(code: DocumentPdfPrintErrorCode, message: string) {
    super(message)
    this.name = 'DocumentPdfPrintError'
    this.code = code
  }
}

/** 打印链路需要的最小 Electron webContents 能力，便于单元测试注入。 */
export interface DocumentPrintWebContents {
  /** 注入仅用于本次打印的样式。 */
  insertCSS(css: string): Promise<string>
  /** 移除本次打印注入的样式。 */
  removeInsertedCSS(key: string): Promise<void>
  /** 在预览页面等待字体、图片和布局稳定。 */
  executeJavaScript(code: string): Promise<unknown>
  /** 将当前页面按打印样式输出为 PDF。 */
  printToPDF(options: PrintToPDFOptions): Promise<Uint8Array>
}

/**
 * 解析第一页的有效尺寸，异常值回退 A4。
 * @param model 文档模型。
 * @returns 页面宽高，单位为 PDF 点。
 * @author zhenghq
 */
function resolvePrintPageSize(model: DocumentModel): { width: number; height: number } {
  const page = model.pages[0]
  const width = page?.width
  const height = page?.height
  const validWidth = Number.isFinite(width) && (width ?? 0) > 0 ? width as number : DEFAULT_PAGE_WIDTH_PT
  const validHeight = Number.isFinite(height) && (height ?? 0) > 0 ? height as number : DEFAULT_PAGE_HEIGHT_PT
  if (model.source.format === 'pdf') {
    return { width: validWidth, height: validHeight }
  }
  // 流式文档模型使用 96 DPI 的 CSS 像素，打印前必须换算为 PDF 点。
  return {
    width: roundPrintPoints(validWidth / CSS_PX_PER_PDF_POINT),
    height: roundPrintPoints(validHeight / CSS_PX_PER_PDF_POINT)
  }
}

/**
 * 判断文档是否使用连续流式排版。
 * 此类文档没有固定页数，必须由浏览器按标准纸张高度自然分页；
 * 不能把整篇内容高度扩展成单个超长页面。
 * @param model 文档模型。
 * @returns 是否为连续流式文档。
 * @author zhenghq
 */
function usesContinuousPrintPagination(model: DocumentModel): boolean {
  return model.source.format !== 'pdf'
}

/**
 * 计算导出 PDF 时水印图案的横向起点。
 * Markdown 使用带页边距的打印内容区，其余文档水印铺满纸张宽度。
 * @param model 文档模型。
 * @returns 水印图案相对打印内容区左边缘的非正横向偏移。
 * @author zhenghq
 */
function resolvePrintWatermarkHorizontalOffset(model: DocumentModel): number {
  const { width } = resolvePrintPageSize(model)
  const pageMargin = model.source.format === 'markdown' ? MARKDOWN_PRINT_MARGIN_PT * 2 : 0
  const printableWidthPt = Math.max(0, width - pageMargin)
  return resolveTranslationWatermarkHorizontalOffset(printableWidthPt * CSS_PX_PER_PDF_POINT)
}

/**
 * 生成 PDF 预览打印样式。
 * 打印时只保留译文栏，并把预览页恢复到 PDF 点对应的 CSS 像素比例，
 * 使导出的换行、字号和段间距与屏幕上的译文保持一致。
 * @param model 文档模型，用于读取页面尺寸。
 * @param pageHeightOverridePt 可选的打印页高，单位为 PDF 点；译文超过原页时用于保留完整内容。
 * @returns 可注入文档窗口的打印 CSS。
 * @author zhenghq
 */
export function buildDocumentPrintCss(model: DocumentModel, pageHeightOverridePt?: number): string {
  const { width, height } = resolvePrintPageSize(model)
  const isMarkdown = model.source.format === 'markdown'
  const printHeight = Number.isFinite(pageHeightOverridePt) && (pageHeightOverridePt ?? 0) > 0
    ? roundPrintPoints(pageHeightOverridePt as number)
    : height
  return `@media print {
  @page {
    size: ${width}pt ${printHeight}pt;
    margin: ${isMarkdown ? '0.35in' : '0'};
  }
}

@media screen, print {
  :root,
  html,
  body {
    display: block !important;
    width: auto !important;
    height: auto !important;
    min-width: 0 !important;
    min-height: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    overflow: visible !important;
    background: var(--document-paper-bg) !important;
    color-scheme: light !important;
  }

  body {
    color: var(--document-paper-text) !important;
  }

  .window-titlebar,
  .document-toolbar,
  .document-workbench-header,
  .document-progress-panel,
  .document-column:first-child,
  .document-column-header,
  .document-warning-list,
  #document-upload-panel,
  #document-batch-panel {
    display: none !important;
  }

  .document-shell,
  #document-workbench,
  .document-columns,
  .document-column:last-child,
  #document-translation-content,
  .document-preview-host,
  .document-preview-host[data-preview-kind='paged'],
  .document-preview-host[data-preview-kind='flow'],
  .document-preview-host[data-preview-kind='markdown'],
  .document-preview-host[data-preview-kind='table'],
  .document-preview-host[data-preview-kind='subtitle'],
  .document-flow-preview,
  .document-table-preview,
  .document-subtitle-preview {
    display: block !important;
    width: auto !important;
    height: auto !important;
    min-width: 0 !important;
    min-height: 0 !important;
    max-width: none !important;
    margin: 0 !important;
    padding: 0 !important;
    overflow: visible !important;
    border: 0 !important;
    border-radius: 0 !important;
    background: var(--document-paper-bg) !important;
    box-shadow: none !important;
  }

  #document-translation-content .document-markdown-preview {
    --text-primary: var(--document-paper-text) !important;
    --text-secondary: var(--document-paper-text) !important;
    --panel-bg: var(--document-paper-bg) !important;
    --bg-secondary: color-mix(in srgb, var(--document-paper-text) 5%, var(--document-paper-bg)) !important;
    --border-default: color-mix(in srgb, var(--document-paper-text) 16%, var(--document-paper-bg)) !important;
    display: block !important;
    box-sizing: border-box !important;
    /* Explicitly reserve horizontal padding when the print viewport is narrower than 920px. */
    width: calc(100% - 64px) !important;
    max-width: 920px !important;
    height: auto !important;
    min-height: 0 !important;
    margin: 0 auto !important;
    padding: clamp(16px, 4vw, 40px) !important;
    overflow: visible !important;
    border: var(--border-width) solid var(--border-default) !important;
    border-radius: var(--radius-control) !important;
    background: var(--document-paper-bg) !important;
    color: var(--document-paper-text) !important;
    box-shadow: none !important;
  }

  #document-translation-content .document-markdown-preview > * + * {
    margin-top: var(--space-3);
  }

  #document-translation-content,
  .document-column:last-child,
  .document-columns {
    width: 100% !important;
  }

  #document-translation-content .document-page {
    --document-page-scale: ${CSS_PX_PER_PDF_POINT} !important;
    display: flex !important;
    box-sizing: content-box !important;
    max-width: none !important;
    margin: 0 !important;
    overflow: visible !important;
    border: 0 !important;
    border-radius: 0 !important;
    background: var(--document-paper-bg) !important;
    color: var(--document-paper-text) !important;
    box-shadow: none !important;
    break-after: page;
    page-break-after: always;
  }

  #document-translation-content .document-page:last-child {
    margin-bottom: 0 !important;
    break-after: auto;
    page-break-after: auto;
  }

  #document-translation-content .document-page[data-layout='translation-flow'] {
    width: calc(var(--document-page-width, 100%) * var(--document-page-scale)) !important;
    height: auto !important;
    min-height: 0 !important;
  }

  #document-translation-content .document-page[data-layout='flow'] {
    box-sizing: border-box !important;
    width: var(--document-page-width, 100%) !important;
    max-width: 100% !important;
    margin: 0 auto !important;
  }

  #document-translation-content .document-page[data-layout='absolute'] {
    width: var(--document-page-width, auto) !important;
    height: var(--document-page-height) !important;
    min-height: var(--document-page-height) !important;
  }

  #document-translation-content .document-pdf-page {
    --document-page-scale: ${CSS_PX_PER_PDF_POINT} !important;
    position: relative !important;
    display: flex !important;
    box-sizing: border-box !important;
    justify-content: center !important;
    width: calc(var(--document-pdf-source-width) * ${CSS_PX_PER_PDF_POINT}px) !important;
    height: calc(var(--document-pdf-source-height) * ${CSS_PX_PER_PDF_POINT}px) !important;
    min-height: 0 !important;
    max-width: none !important;
    margin: 0 !important;
    overflow: hidden !important;
    border: 0 !important;
    border-radius: 0 !important;
    background: var(--document-paper-bg) !important;
    color: var(--document-paper-text) !important;
    box-shadow: none !important;
    /* 打印前必须让所有 PDF 页参与布局，避免 content-visibility 改变 Canvas 与文字层的实际矩形。 */
    content-visibility: visible !important;
    contain-intrinsic-size: none !important;
    break-after: page;
    page-break-after: always;
  }

  #document-translation-content .document-pdf-page:last-child {
    break-after: auto;
    page-break-after: auto;
  }

  #document-translation-content .document-pdf-canvas {
    display: block !important;
    width: 100% !important;
    max-width: 100% !important;
    height: 100% !important;
    object-fit: contain !important;
  }

  #document-translation-content .document-flow-preview,
  #document-translation-content .document-table-preview,
  #document-translation-content .document-subtitle-preview {
    height: auto !important;
    min-height: 0 !important;
    overflow: visible !important;
  }

  #document-translation-content .document-translation-watermark {
    display: block !important;
    /* Repeating a fixed element on each printed page keeps every PDF page watermarked. */
    position: fixed !important;
    z-index: 2 !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    min-width: 0 !important;
    min-height: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    overflow: hidden !important;
    border: 0 !important;
    background: transparent !important;
    pointer-events: none !important;
    print-color-adjust: exact !important;
    -webkit-print-color-adjust: exact !important;
  }

  #document-translation-content .document-translation-watermark-pattern {
    display: block !important;
    width: 100% !important;
    height: 100% !important;
    overflow: visible !important;
    color: var(--document-watermark-ink-strong) !important;
  }

  #document-translation-content .document-table-block {
    /* Keep table borders intact when printing instead of clipping horizontally. */
    overflow: visible !important;
  }

  #document-translation-content .document-image-block {
    /* OCR 文字层按图片块定位；表格图片和流式图片都必须保持同一包含块。 */
    position: relative !important;
    /* 建立独立层叠上下文，避免透明文字层被后续绘制内容遮住。 */
    isolation: isolate !important;
  }

  #document-translation-content .document-ocr-print-text-layer {
    display: block !important;
    position: absolute !important;
    left: var(--document-ocr-print-left, 0) !important;
    top: var(--document-ocr-print-top, 0) !important;
    right: auto !important;
    bottom: auto !important;
    width: var(--document-ocr-print-width, 100%) !important;
    height: var(--document-ocr-print-height, 100%) !important;
    min-width: 0 !important;
    min-height: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    transform: none !important;
    z-index: 0 !important;
    overflow: hidden !important;
    pointer-events: none !important;
    background: transparent !important;
  }

  #document-translation-content .document-ocr-print-text-layer .document-ocr-text-region {
    margin: 0 !important;
    padding: 0 !important;
    transform: none !important;
    color: transparent !important;
    opacity: 1 !important;
    background: transparent !important;
    -webkit-text-fill-color: transparent !important;
  }

  #document-translation-content .document-partial-export-notice {
    display: block !important;
    box-sizing: border-box !important;
    width: auto !important;
    margin: 0 0 12px !important;
    padding: 10px 12px !important;
    border: 1px solid var(--status-warning) !important;
    border-radius: 8px !important;
    background: color-mix(in srgb, var(--status-warning) 12%, var(--document-paper-bg)) !important;
    color: var(--document-paper-text) !important;
    font-family: var(--font-family-sans) !important;
    font-size: 12px !important;
    font-weight: 600 !important;
    line-height: 1.5 !important;
    break-inside: avoid;
    page-break-inside: avoid;
  }

  #document-translation-content .document-table-block tr {
    /* Avoid splitting a translated row across printed pages. */
    break-inside: avoid;
    page-break-inside: avoid;
  }

  #document-translation-content .document-markdown-preview h1,
  #document-translation-content .document-markdown-preview h2,
  #document-translation-content .document-markdown-preview h3,
  #document-translation-content .document-markdown-preview h4,
  #document-translation-content .document-markdown-preview h5,
  #document-translation-content .document-markdown-preview h6 {
    break-after: avoid;
    page-break-after: avoid;
  }

  #document-translation-content .document-markdown-preview pre,
  #document-translation-content .document-markdown-preview blockquote,
  #document-translation-content .document-markdown-preview li,
  #document-translation-content .document-markdown-preview tr,
  #document-translation-content .document-markdown-preview img {
    break-inside: avoid;
    page-break-inside: avoid;
  }
}` 
}

/**
 * 将 PDF 点尺寸归一化到打印所需的精度。
 * @param value 原始 PDF 点尺寸。
 * @returns 保留三位小数的尺寸。
 * @author zhenghq
 */
function roundPrintPoints(value: number): number {
  return Math.round(value * PRINT_POINT_PRECISION) / PRINT_POINT_PRECISION
}

/**
 * 从页面脚本结果中读取译文页最大高度。
 * @param result executeJavaScript 的返回值。
 * @returns 页面高度，单位为 CSS 像素。
 * @throws {DocumentPdfPrintError} 页面不存在或高度无效时拒绝导出，避免生成截断文件。
 * @author zhenghq
 */
function resolveMeasuredPageHeightCssPx(result: unknown): number {
  const pageHeightCssPx = typeof result === 'object' && result !== null && 'pageHeightCssPx' in result
    ? (result as { pageHeightCssPx?: unknown }).pageHeightCssPx
    : undefined
  if (typeof pageHeightCssPx !== 'number' || !Number.isFinite(pageHeightCssPx) || pageHeightCssPx <= 0) {
    throw new DocumentPdfPrintError('export-failed', 'Translation preview has no printable height')
  }
  return pageHeightCssPx
}

/**
 * 将文档窗口中的译文预览直接打印为 PDF。
 * @param webContents 文档窗口的 webContents。
 * @param model 当前译文模型，用于确定打印页面尺寸。
 * @param partialExport 可选的部分导出统计；存在时打印前插入部分结果标记。
 * @param textLayer 是否等待并打印原图上的透明 OCR 文字层。
 * @returns PDF 字节与可降级告警。
 * @author zhenghq
 */
export async function printDocumentPreviewToPdf(
  webContents: DocumentPrintWebContents,
  model: DocumentModel,
  partialExport?: DocumentPartialExportSummary,
  textLayer?: boolean
): Promise<DocumentPdfExportResult> {
  if (!model || !Array.isArray(model.pages) || model.pages.length === 0) {
    throw new DocumentPdfPrintError('invalid-document', 'Document has no pages')
  }

  const { width, height } = resolvePrintPageSize(model)
  const insertedCssKeys: string[] = []
  try {
    insertedCssKeys.push(await webContents.insertCSS(buildDocumentPrintCss(model)))
    if (partialExport) {
      await webContents.executeJavaScript(buildPreparePartialExportScript(
        resolvePrintWatermarkHorizontalOffset(model),
        partialExport
      ))
    } else {
      await webContents.executeJavaScript(buildWaitForPrintReadyScript(
        resolvePrintWatermarkHorizontalOffset(model),
        textLayer === true
      ))
    }
    // 连续流式文档由浏览器按 @page 高度自然分页；固定页文档才需要把单页译文高度扩展到原页高以上。
    const measuredHeightPt = usesContinuousPrintPagination(model)
      ? height
      : roundPrintPoints(resolveMeasuredPageHeightCssPx(
        await webContents.executeJavaScript(MEASURE_TRANSLATION_PAGE_HEIGHT_SCRIPT)
      ) / CSS_PX_PER_PDF_POINT)
    const printHeightPt = Math.max(height, measuredHeightPt)
    if (printHeightPt > height) {
      // CSS 页面尺寸会覆盖 printToPDF 的 pageSize，内容变高时必须同步更新 @page，否则浏览器会额外分页。
      insertedCssKeys.push(await webContents.insertCSS(buildDocumentPrintCss(model, printHeightPt)))
    }
    const bytes = await webContents.printToPDF({
      printBackground: true,
      displayHeaderFooter: false,
      margins: { marginType: 'none' },
      preferCSSPageSize: true,
      pageSize: { width: width / 72, height: printHeightPt / 72 }
    })
    const warnings: DocumentWarning[] = []
    return { bytes: new Uint8Array(bytes), warnings }
  } catch (error) {
    if (error instanceof DocumentPdfPrintError) throw error
    throw new DocumentPdfPrintError('export-failed', 'PDF print failed')
  } finally {
    if (partialExport) {
      try {
        await webContents.executeJavaScript('window.__documentPrintPreview?.restorePrintPreview?.()')
      } catch {
        // 预览恢复失败不能覆盖已经确定的 PDF 结果或原始打印错误。
      }
    }
    for (const cssKey of insertedCssKeys.reverse()) {
      try {
        await webContents.removeInsertedCSS(cssKey)
      } catch {
        // 打印结果已经确定；清理失败不能覆盖成功字节或原始错误。
      }
    }
  }
}
