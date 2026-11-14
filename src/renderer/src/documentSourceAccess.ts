import type { DocumentFormat } from '../../shared/documentTypes'
import type { DocumentApprovedSourceRequest } from '../../shared/documentWorkspace'
import {
  RESTORED_DOCUMENT_JOB_ID,
  type DocumentWorkspaceTab
} from './documentUiModel'

/**
 * 判断 Tab 是否使用本地恢复工作台的固定任务身份。
 * @param tab 待检查的文档 Tab。
 * @returns 快照任务标识为恢复态固定值时返回 true。
 * @author zhenghq
 */
export function isRestoredDocumentTab(tab: DocumentWorkspaceTab | null | undefined): boolean {
  return tab?.snapshot?.jobId === RESTORED_DOCUMENT_JOB_ID
}

/**
 * 判断 Tab 是否只能只读回放，不能重新读取资源或操作主进程任务。
 * @param tab 待检查的文档 Tab。
 * @returns 历史快照或本地恢复快照返回 true。
 * @author zhenghq
 */
export function isReadOnlyDocumentTab(tab: DocumentWorkspaceTab | null | undefined): boolean {
  return tab?.sourceKind === 'history' || tab?.sourceKind === 'restored' || isRestoredDocumentTab(tab)
}

/**
 * 构造只读 Tab 的受控源文件请求；快照与 Tab 必须一致且已重新授权。
 * @param tab 只读文档 Tab。
 * @returns 主进程可校验的源文件请求；未授权或元数据不完整时返回 null。
 * @author zhenghq
 */
export function approvedDocumentSourceRequest(
  tab: DocumentWorkspaceTab
): DocumentApprovedSourceRequest | null {
  const source = tab.snapshot?.source?.source
  if (!isReadOnlyDocumentTab(tab) || !tab.sourceAuthorized || !source ||
    !source.path || !source.sha256 || !Number.isSafeInteger(source.size) || source.size < 1 ||
    source.sha256 !== tab.selection.sha256 || source.size !== tab.selection.size) {
    return null
  }
  return {
    path: source.path,
    sourceSha256: source.sha256,
    sourceSize: source.size,
    format: source.format
  }
}

/**
 * 构造普通任务或只读 Tab 的受控源文件请求。
 * 普通任务使用已批准选择中的文件指纹；只读 Tab 继续要求快照源信息与选择完全一致。
 * @param tab 需要读取原文的文档 Tab。
 * @param isReadOnly 判断 Tab 是否为只读历史或恢复快照。
 * @param approvedSourceRequest 构造只读 Tab 源请求的方法。
 * @returns 主进程可校验的源文件请求；未授权或元数据不完整时返回 null。
 * @author zhenghq
 */
export function resolveAuthorizedDocumentSourceRequest(
  tab: DocumentWorkspaceTab,
  isReadOnly: (tab: DocumentWorkspaceTab) => boolean,
  approvedSourceRequest: (tab: DocumentWorkspaceTab) => DocumentApprovedSourceRequest | null
): DocumentApprovedSourceRequest | null {
  if (isReadOnly(tab)) return approvedSourceRequest(tab)
  if (!tab.sourceAuthorized || !tab.selection.path ||
    !/^[a-f0-9]{64}$/iu.test(tab.selection.sha256) ||
    !Number.isSafeInteger(tab.selection.size) || tab.selection.size < 1) {
    return null
  }
  return {
    path: tab.selection.path,
    sourceSha256: tab.selection.sha256,
    sourceSize: tab.selection.size,
    format: tab.selection.format as DocumentFormat
  }
}

/**
 * 判断当前可见原文是否已经属于指定 Tab 的同一 PDF 文件。
 * 待解析占位和已解析原文都可复用，避免重新翻译或切换 OCR 模式时重建左侧 Canvas。
 * @param tab 待检查的文档 Tab。
 * @param identity 当前原文预览身份。
 * @param renderedTabId 当前原文所属 Tab 标识。
 * @param renderedSha256 当前原文所属文件 SHA-256。
 * @returns 当前原文可直接复用时返回 true。
 * @author zhenghq
 */
export function hasReusablePdfSourcePreview(
  tab: DocumentWorkspaceTab,
  identity: string,
  renderedTabId: string | null,
  renderedSha256: string
): boolean {
  if (renderedTabId !== tab.id || renderedSha256 !== tab.selection.sha256) return false
  return identity === `pdf-pending:${tab.selection.sha256}` ||
    identity === `pdf:${tab.selection.sha256}`
}
