/** 文档文本样式的受控字段集合（与 shared/documentTypes 保持一致）。 */
import type { DocumentTextBlock, DocumentTextStyle, DocumentTextRun } from '../../shared/documentTypes'

/**
 * 将文档样式转换为 CSS 属性；只接受模型中的受控样式字段。
 * @param style 文档样式。
 * @returns 可应用到 HTMLElement 的样式映射。
 * @author zhenghq
 */
export function styleProperties(style: DocumentTextStyle | undefined): Partial<CSSStyleDeclaration> {
  if (!style) return {}
  const result: Partial<CSSStyleDeclaration> = {}
  if (style.fontFamily) result.fontFamily = style.fontFamily
  if (style.fontSize !== undefined) result.fontSize = `${style.fontSize}pt`
  if (style.fontWeight !== undefined) result.fontWeight = String(style.fontWeight)
  if (style.color) result.color = style.color
  if (style.backgroundColor) result.backgroundColor = style.backgroundColor
  if (style.italic) result.fontStyle = 'italic'
  if (style.underline) result.textDecoration = 'underline'
  if (style.strikethrough) {
    result.textDecoration = result.textDecoration === 'underline'
      ? 'underline line-through'
      : 'line-through'
  }
  if (style.letterSpacing !== undefined) result.letterSpacing = `${style.letterSpacing}pt`
  if (style.lineHeight !== undefined) result.lineHeight = `${style.lineHeight}pt`
  return result
}

/**
 * 根据字体名称推断带中英文系统字体回退的 CSS font-family。
 * @param fontFamily PDF 模型中的字体名称。
 * @returns 带中英文系统字体回退的 CSS font-family 值。
 * @author zhenghq
 */
export function pdfPreviewFontFamily(fontFamily: string): string {
  const escaped = fontFamily.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
  const normalized = fontFamily.toLowerCase()
  // PDF.js 对中文 PDF 常把内嵌字体标记为 monospace；优先依据实际字体名选择衬线或无衬线回退。
  if (/song|simsun|serif|times|georgia|garamond|ming|kai|fang|宋|明|楷|仿/iu.test(normalized)) {
    return `"${escaped}", "Times New Roman", "Songti SC", "SimSun", "Noto Serif CJK SC", serif`
  }
  if (/mono|courier|consolas|menlo|monaco|code/iu.test(normalized)) {
    return `"${escaped}", Menlo, Consolas, "Songti SC", "SimSun", monospace`
  }
  return `"${escaped}", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif`
}

/**
 * 将 PDF 原文样式写入可缩放文本元素；字号保留为 CSS 自定义属性供译文页换算。
 * @param element 目标文本元素。
 * @param style 文档文本样式。
 * @returns 无返回值。
 * @author zhenghq
 */
export function applyScalableTextStyle(
  element: HTMLElement,
  style: DocumentTextStyle | undefined
): void {
  if (style?.fontSize !== undefined) {
    // PDF.js 在 scale=1 时页面点与 CSS 像素一一对应；变量显式携带 px，避免 pt 与屏幕像素混算。
    element.style.setProperty('--document-run-font-size-px', `${style.fontSize}px`)
  }
  if (style?.lineHeight !== undefined) {
    element.style.setProperty('--document-run-line-height-px', `${style.lineHeight}px`)
  }
  if (style?.color) element.style.color = style.color
  if (style?.fontWeight !== undefined) element.style.fontWeight = String(style.fontWeight)
  if (style?.fontFamily) {
    element.style.setProperty('--document-run-font-family', pdfPreviewFontFamily(style.fontFamily))
  }
  if (style?.italic) element.style.fontStyle = 'italic'
  if (style?.underline) element.style.textDecoration = 'underline'
  if (style?.strikethrough) {
    element.style.textDecoration = element.style.textDecoration === 'underline'
      ? 'underline line-through'
      : 'line-through'
  }
  if (style?.letterSpacing !== undefined) element.style.letterSpacing = `${style.letterSpacing}px`
}

/**
 * 合并区块与文本片段的样式，片段样式优先。
 * PDF 解析器常把字号、颜色、字重和行高放在区块上，只读取 run 样式会导致译文回退到默认 12px。
 * @param block 文本区块。
 * @param run 文本片段。
 * @returns 用于预览渲染的最终文本样式。
 * @author zhenghq
 */
export function effectiveTextStyle(block: DocumentTextBlock, run: DocumentTextRun): DocumentTextStyle {
  return { ...block.style, ...run.style }
}
