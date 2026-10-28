import type { PrintToPDFOptions } from 'electron'
import type { DocumentModel, DocumentWarning } from '../shared/documentTypes.ts'
import type { DocumentPdfExportResult } from './documentWorkspaceTaskService.ts'

/** 默认 A4 页面宽度，单位为 PDF 点。 */
const DEFAULT_PAGE_WIDTH_PT = 612

/** 默认 A4 页面高度，单位为 PDF 点。 */
const DEFAULT_PAGE_HEIGHT_PT = 792

/** CSS 像素与 PDF 点之间的换算比例，即 96 / 72。 */
const CSS_PX_PER_PDF_POINT = 1.3333333333

/** 打印尺寸保留三位小数，消除 CSS 像素换算产生的浮点尾差。 */
const PRINT_POINT_PRECISION = 1000

/** 打印前等待字体、图片和两帧布局完成。 */
const WAIT_FOR_PRINT_READY_SCRIPT = `(async () => {
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
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
})()`

/** 测量打印样式生效后译文页的最大真实高度。 */
const MEASURE_TRANSLATION_PAGE_HEIGHT_SCRIPT = `(() => {
  const pages = Array.from(document.querySelectorAll('#document-translation-content .document-page'));
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
  return {
    width: Number.isFinite(width) && (width ?? 0) > 0 ? width as number : DEFAULT_PAGE_WIDTH_PT,
    height: Number.isFinite(height) && (height ?? 0) > 0 ? height as number : DEFAULT_PAGE_HEIGHT_PT
  }
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
  const printHeight = Number.isFinite(pageHeightOverridePt) && (pageHeightOverridePt ?? 0) > 0
    ? roundPrintPoints(pageHeightOverridePt as number)
    : height
  return `@media print {
  @page {
    size: ${width}pt ${printHeight}pt;
    margin: 0;
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
  .document-markdown-preview,
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

  #document-translation-content .document-page[data-layout='absolute'] {
    width: var(--document-page-width, auto) !important;
    height: var(--document-page-height) !important;
    min-height: var(--document-page-height) !important;
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
 * @returns PDF 字节与可降级告警。
 * @author zhenghq
 */
export async function printDocumentPreviewToPdf(
  webContents: DocumentPrintWebContents,
  model: DocumentModel
): Promise<DocumentPdfExportResult> {
  if (!model || !Array.isArray(model.pages) || model.pages.length === 0) {
    throw new DocumentPdfPrintError('invalid-document', 'Document has no pages')
  }

  const { width, height } = resolvePrintPageSize(model)
  const insertedCssKeys: string[] = []
  try {
    insertedCssKeys.push(await webContents.insertCSS(buildDocumentPrintCss(model)))
    await webContents.executeJavaScript(WAIT_FOR_PRINT_READY_SCRIPT)
    const measuredHeightCssPx = resolveMeasuredPageHeightCssPx(
      await webContents.executeJavaScript(MEASURE_TRANSLATION_PAGE_HEIGHT_SCRIPT)
    )
    const measuredHeightPt = roundPrintPoints(measuredHeightCssPx / CSS_PX_PER_PDF_POINT)
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
    for (const cssKey of insertedCssKeys.reverse()) {
      try {
        await webContents.removeInsertedCSS(cssKey)
      } catch {
        // 打印结果已经确定；清理失败不能覆盖成功字节或原始错误。
      }
    }
  }
}
