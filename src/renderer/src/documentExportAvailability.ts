/** 文档导出可用性判断。 */
import type { DocumentWorkspaceSnapshot } from '../../shared/types'

/**
 * 判断当前快照是否包含至少一个可导出的成功译文或无需翻译目标。
 * @param snapshot 当前任务快照。
 * @returns 存在可导出内容时返回 true。
 * @author zhenghq
 */
export function hasUsableExportResult(snapshot: DocumentWorkspaceSnapshot | null): boolean {
  // OCR 原文任务没有翻译目标，完成报告计数为 0 时仍应允许导出双层 PDF。
  if (snapshot?.runMode === 'ocr') return snapshot.task.status === 'completed'
  if (!snapshot?.completionReport) return snapshot?.task.status === 'completed'
  return snapshot.completionReport.translated + snapshot.completionReport.unchanged > 0
}
