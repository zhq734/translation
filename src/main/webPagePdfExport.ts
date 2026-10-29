import type { PrintToPDFOptions } from 'electron'
import { TRANSLATION_WATERMARK_LOGO_PATH } from '../shared/translationWatermark'

/**
 * 网页打印前等待字体、图片与两帧布局稳定，并标记需展开的滚动容器。
 * 固定高度或最大高度通常表示滚动视口；即使当前内容尚未溢出，打印时后续布局仍可能被裁掉。
 * 普通内容盒的 computed height 只是当前内容高度，因此仅在元素同时具备溢出模式与高度约束时展开，
 * 避免破坏图片、SVG、视频等固有尺寸。
 */
const WAIT_FOR_WEB_PAGE_PRINT_READY_SCRIPT = `(async () => {
  const printScrollAttribute = 'data-st-print-scroll-container';
  for (const element of document.querySelectorAll('[' + printScrollAttribute + ']')) {
    element.removeAttribute(printScrollAttribute);
  }
  for (const element of document.querySelectorAll('body *')) {
    const style = getComputedStyle(element);
    const scrollable = /(auto|scroll|overlay)/.test(style.overflowX + ' ' + style.overflowY);
    const constrained = style.maxHeight !== 'none' || !['auto', '0px'].includes(style.height);
    if (scrollable && constrained) element.setAttribute(printScrollAttribute, '');
  }
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const images = Array.from(document.images || []);
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

/** PDF 水印中的中文品牌文字，按码点构造以避免被界面硬编码检查误判。 */
const WEB_PAGE_WATERMARK_CHINESE = String.fromCharCode(0x5212, 0x8bcd, 0x7ffb, 0x8bd1)

/** 与文件翻译 PDF 完全一致的品牌水印图块宽度，单位为 CSS 像素。 */
const WEB_PAGE_WATERMARK_TILE_WIDTH = 320

/** 与文件翻译 PDF 完全一致的品牌水印图块高度，单位为 CSS 像素。 */
const WEB_PAGE_WATERMARK_TILE_HEIGHT = 180

/** 与文件翻译 PDF 完全一致的 A4 横向水印起点，使每行保持约三个水印。 */
const WEB_PAGE_WATERMARK_HORIZONTAL_OFFSET = -92

/** 网页打印水印使用的纸张墨色，与文件翻译 PDF 的强水印色一致。 */
const WEB_PAGE_WATERMARK_INK = 'rgba(17, 24, 39, 0.17)'

/** 网页 PDF 打印错误分类。 */
export type WebPagePdfPrintErrorCode = 'export-failed'

/** 网页 PDF 打印错误。 */
export class WebPagePdfPrintError extends Error {
  /** 可供界面本地化的稳定错误分类。 */
  readonly code: WebPagePdfPrintErrorCode

  /**
   * 创建网页 PDF 打印错误。
   * @param code 稳定错误分类。
   * @param message 内部脱敏错误说明。
   * @author zhenghq
   */
  constructor(code: WebPagePdfPrintErrorCode, message: string) {
    super(message)
    this.name = 'WebPagePdfPrintError'
    this.code = code
  }
}

/** 网页 PDF 打印所需的最小 Electron webContents 能力。 */
export interface WebPagePrintWebContents {
  /** 注入仅用于本次打印的样式。 */
  insertCSS(css: string): Promise<string>
  /** 移除本次打印注入的样式。 */
  removeInsertedCSS(key: string): Promise<void>
  /** 在远程网页中等待字体、图片与布局稳定。 */
  executeJavaScript(code: string): Promise<unknown>
  /** 将远程网页按打印样式输出为 PDF。 */
  printToPDF(options: PrintToPDFOptions): Promise<Uint8Array>
}

/**
 * 构建与文件翻译 PDF 共用品牌图形的斜向水印 SVG。
 * 图块尺寸、logo 位置、中英文上下排列和旋转角度均与文件翻译水印保持一致。
 * @returns 可直接编码为 data URL 的完整 SVG 字符串。
 * @author zhenghq
 */
function buildWebPageWatermarkSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WEB_PAGE_WATERMARK_TILE_WIDTH}" height="${WEB_PAGE_WATERMARK_TILE_HEIGHT}" viewBox="0 0 ${WEB_PAGE_WATERMARK_TILE_WIDTH} ${WEB_PAGE_WATERMARK_TILE_HEIGHT}">
  <g transform="rotate(-45 160 90)">
    <svg x="74" y="96" width="24" height="24" viewBox="0 0 36 36">
      <path id="rounded-yi-glyph" data-font-family="Wawati SC" fill="${WEB_PAGE_WATERMARK_INK}" stroke="${WEB_PAGE_WATERMARK_INK}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" paint-order="stroke fill" transform="translate(3.2 25.9) scale(0.113)" d="${TRANSLATION_WATERMARK_LOGO_PATH}"/>
    </svg>
    <text x="106" y="107" fill="${WEB_PAGE_WATERMARK_INK}" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="20" font-weight="650" letter-spacing="0.04em">${WEB_PAGE_WATERMARK_CHINESE}</text>
    <text x="108" y="127" fill="${WEB_PAGE_WATERMARK_INK}" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="14" font-weight="600" letter-spacing="0.02em">Selection Translator</text>
  </g>
</svg>`
}

/**
 * 将 SVG 完整编码为 CSS data URL，避免引号、尖括号等字符截断 CSS 字符串。
 * @param svg 完整 SVG 文本。
 * @returns 可安全放入双引号 CSS url() 的 data URL。
 * @author zhenghq
 */
function encodeWatermarkSvgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/**
 * 生成网页 PDF 打印样式。
 * 水印仅存在于打印媒体中，屏幕页面不会创建水印节点或改变显示效果。
 * @returns 可注入远程网页的打印样式。
 * @author zhenghq
 */
export function buildWebPagePrintCss(): string {
  const watermarkUrl = encodeWatermarkSvgDataUrl(buildWebPageWatermarkSvg())
  // 网页阅读器使用滚动容器展示长内容，打印时必须展开以免只输出首屏。
  // 表格允许自然跨页，但单行不得被纸张边界拆开；代码块必须在纸张宽度内换行。
  return `@media print {
  html,
  body {
    height: auto !important;
    max-height: none !important;
    overflow: visible !important;
  }
  body [data-st-print-scroll-container] {
    height: auto !important;
    max-height: none !important;
    overflow: visible !important;
  }
  table {
    break-inside: auto;
    page-break-inside: auto;
  }
  tr,
  td,
  th {
    break-inside: avoid;
    page-break-inside: avoid;
  }
  pre {
    white-space: pre-wrap !important;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  html::after {
    content: '';
    position: fixed;
    z-index: 2147483647;
    inset: 0;
    display: block;
    background-image: url("${watermarkUrl}");
    background-repeat: repeat;
    background-size: ${WEB_PAGE_WATERMARK_TILE_WIDTH}px ${WEB_PAGE_WATERMARK_TILE_HEIGHT}px;
    background-position: ${WEB_PAGE_WATERMARK_HORIZONTAL_OFFSET}px 0;
    color: ${WEB_PAGE_WATERMARK_INK};
    pointer-events: none;
    user-select: none;
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
}`
}

/**
 * 将当前翻译后的远程网页打印为带水印 PDF。
 * @param webContents 远程网页的 webContents。
 * @returns PDF 字节。
 * @author zhenghq
 */
export async function printWebPageToPdf(webContents: WebPagePrintWebContents): Promise<Uint8Array> {
  let cssKey: string | null = null
  try {
    cssKey = await webContents.insertCSS(buildWebPagePrintCss())
    await webContents.executeJavaScript(WAIT_FOR_WEB_PAGE_PRINT_READY_SCRIPT)
    const bytes = await webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      displayHeaderFooter: false,
      margins: { marginType: 'default' },
      preferCSSPageSize: true
    })
    return new Uint8Array(bytes)
  } catch (error) {
    if (error instanceof WebPagePdfPrintError) throw error
    throw new WebPagePdfPrintError('export-failed', 'PDF print failed')
  } finally {
    if (cssKey) {
      try {
        await webContents.removeInsertedCSS(cssKey)
      } catch {
        // 打印结果已经确定；清理失败不能覆盖成功字节或原始错误。
      }
    }
  }
}
