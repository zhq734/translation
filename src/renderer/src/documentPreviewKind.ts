import type { DocumentModel } from '../../shared/documentTypes'
import type { DocumentPreviewKind, DocumentRenderSide } from './documentUiModel'

/**
 * 根据源文件格式和当前栏位选择预览呈现方式。
 * @param model 当前文档模型。
 * @param side 当前渲染侧。
 * @returns 对应的预览类型。
 * @author zhenghq
 */
export function resolvePreviewKind(
  model: DocumentModel,
  side: DocumentRenderSide
): DocumentPreviewKind {
  const format = model.source.format
  // PDF 与图片文档都按页等比缩放，避免整页图片在窄栏中被压变形。
  if (format === 'pdf' || format === 'image') return 'paged'
  if (format === 'markdown') return 'markdown'
  if (format === 'csv') return 'table'
  if (format === 'srt' || format === 'vtt') return 'subtitle'
  if (side === 'source' && format === 'html') return 'html-source'
  if (format === 'html') return 'flow'
  return 'flow'
}
