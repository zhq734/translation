import { BrowserWindow, dialog, ipcMain } from 'electron'
import { isAbsolute } from 'node:path'
import {
  normalizeDocumentApprovedExportRequest,
  normalizeDocumentExportCancelRequest,
  normalizeDocumentExportRequest,
  normalizeDocumentOpenExportFolderRequest,
  normalizeDocumentRunRequest,
  normalizeDocumentTargetId,
  normalizeDocumentTaskIdentityRequest,
  type DocumentApprovedAssetRequest,
  type DocumentApprovedSourceRequest
} from '../../shared/documentWorkspace'
import { getDocumentPlatformCapability } from '../../shared/documentPlatformCapability'
import { parseDocumentTargetId } from '../../shared/documentTargetLocator'
import type {
  DocumentFileSelectionResult,
  Settings
} from '../../shared/types'
import type { DocumentMainRuntime } from '../documentRuntime'
import type { DocumentTranslationCacheStore } from '../documentTranslationCache'
import type { DocumentTaskHistoryStore } from '../documentTaskHistory'
import type { DocumentWorkspaceTaskService } from '../documentWorkspaceTaskService'

/** 文档工作台 IPC 注册依赖。 */
export interface DocumentIpcDependencies {
  /** 当前窗口已批准文件的路径集合。 */
  approvedPaths: Set<string>
  /** 当前窗口按任务标识登记的任务服务。 */
  taskServices: Map<string, DocumentWorkspaceTaskService>
  /** 从弹窗打开文档工作台。 */
  openWorkspace(): void
  /** 判断 IPC 是否来自当前文档工作台窗口。 */
  isWorkspaceSender(sender: Electron.WebContents): boolean
  /** 判断 IPC 是否来自当前设置窗口。 */
  isSettingsWindowSender(sender: Electron.WebContents): boolean
  /** 返回当前设置。 */
  getSettings(): Settings
  /** 重新校验并批准一个候选路径。 */
  validateApprovedPath(path: string): Promise<DocumentFileSelectionResult>
  /** 创建当前窗口的任务服务。 */
  createTaskService(): Promise<DocumentWorkspaceTaskService>
  /** 释放指定任务服务。 */
  releaseTask(jobId: string): boolean
  /** 按需加载文档运行时。 */
  loadRuntime(): Promise<DocumentMainRuntime>
  /** 返回任务历史存储。 */
  getTaskHistoryStore(runtime: DocumentMainRuntime): DocumentTaskHistoryStore
  /** 返回翻译缓存存储。 */
  getTranslationCacheStore(runtime: DocumentMainRuntime): DocumentTranslationCacheStore
  /** 翻译主进程用户可见文案。 */
  translate(key: string): string
}

/**
 * 注册文档工作台文件选择、任务、导出、历史与资源 IPC。
 * @param dependencies 文档窗口、任务服务、运行时和本地化依赖。
 * @returns 无返回值。
 * @author zhenghq
 */
export function registerDocumentIpc(dependencies: DocumentIpcDependencies): void {
  ipcMain.on('document:open', () => {
    dependencies.openWorkspace()
  })
  ipcMain.handle('document:get-platform-capability', () => getDocumentPlatformCapability())
  /**
   * 从文档窗口一次选择并校验多个本地文件。
   *
   * 只有当前文档工作台可以调用；每个候选路径都重新读取有限文件片段，
   * 通过校验后才加入当前窗口批准集合，拒绝项不携带路径或正文。
   * @param event IPC 事件对象。
   * @returns 每个候选文件的选择、取消或拒绝结果。
   * @author zhenghq
   */
  ipcMain.handle('document:select-files', async (event): Promise<DocumentFileSelectionResult[]> => {
    if (!dependencies.isWorkspaceSender(event.sender)) {
      return [{ status: 'rejected', code: 'unreadable' }]
    }
    if (!getDocumentPlatformCapability().supported) {
      return [{ status: 'rejected', code: 'unreadable' }]
    }
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    if (!senderWindow) return [{ status: 'rejected', code: 'unreadable' }]
    const result = await dialog.showOpenDialog(senderWindow, {
      title: dependencies.translate('document.upload.chooseFiles'),
      properties: ['openFile', 'multiSelections'],
      filters: [{
        name: dependencies.translate('document.upload.formats'),
        extensions: ['pdf', 'docx', 'epub', 'html', 'htm', 'md', 'markdown', 'txt', 'json', 'csv', 'srt', 'vtt', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']
      }]
    })
    if (result.canceled || result.filePaths.length === 0) return [{ status: 'cancelled' }]
    const validated = await Promise.allSettled(
      result.filePaths.map((path) => dependencies.validateApprovedPath(path))
    )
    const selections = validated.map((entry) =>
      entry.status === 'fulfilled'
        ? entry.value
        : { status: 'rejected' as const, code: 'unreadable' as const }
    )
    for (const selected of selections) {
      if (selected.status === 'selected') dependencies.approvedPaths.add(selected.path)
    }
    return selections
  })
  /**
   * 重新校验拖放得到的本地路径，并在当前文档窗口登记为可运行文件。
   * @param event IPC 事件对象。
   * @param path Renderer 从受信任拖放 File 对象取得的绝对路径。
   * @returns 选择、取消或拒绝结果。
   * @author zhenghq
   */
  ipcMain.handle('document:approve-file', async (event, path: unknown) => {
    if (!dependencies.isWorkspaceSender(event.sender)) {
      return { status: 'rejected', code: 'unreadable' }
    }
    if (!getDocumentPlatformCapability().supported) {
      return { status: 'rejected', code: 'unreadable' }
    }
    if (typeof path !== 'string') return { status: 'rejected', code: 'unreadable' }
    const selected = await dependencies.validateApprovedPath(path)
    if (selected.status === 'selected') dependencies.approvedPaths.add(selected.path)
    return selected
  })
  /**
   * 重新校验拖放得到的多个本地路径，并批量登记当前文档窗口的可运行文件。
   * 成功项只追加到批准集合，不能清空队列中此前已批准的文件。
   * @param event IPC 事件对象。
   * @param paths Renderer 从受信任拖放 File 对象取得的绝对路径列表。
   * @returns 每个候选文件的选择或拒绝结果。
   * @author zhenghq
   */
  ipcMain.handle('document:approve-files', async (
    event,
    paths: unknown
  ): Promise<DocumentFileSelectionResult[]> => {
    if (!dependencies.isWorkspaceSender(event.sender)) {
      return [{ status: 'rejected', code: 'unreadable' }]
    }
    if (!getDocumentPlatformCapability().supported) {
      return [{ status: 'rejected', code: 'unreadable' }]
    }
    if (!Array.isArray(paths) || paths.length === 0 ||
      paths.some((path) => typeof path !== 'string')) {
      return [{ status: 'rejected', code: 'unreadable' }]
    }
    const validated = await Promise.allSettled(
      paths.map((path) => dependencies.validateApprovedPath(path as string))
    )
    const selections = validated.map((entry) =>
      entry.status === 'fulfilled'
        ? entry.value
        : { status: 'rejected' as const, code: 'unreadable' as const }
    )
    for (const selected of selections) {
      if (selected.status === 'selected') dependencies.approvedPaths.add(selected.path)
    }
    return selections
  })
  /**
   * 启动当前文档窗口已批准文件的翻译任务。
   * @param event IPC 事件对象。
   * @param request 文件路径、任务代际与语言偏好。
   * @returns 主进程是否接受任务。
   * @author zhenghq
   */
  ipcMain.handle('document:run', async (event, request: unknown) => {
    if (!dependencies.isWorkspaceSender(event.sender)) {
      return { accepted: false, code: 'unreadable' }
    }
    if (!dependencies.getSettings().documentTranslationEnabled) {
      return { accepted: false, code: 'disabled' }
    }
    const normalizedRequest = normalizeDocumentRunRequest(request)
    if (!normalizedRequest || !isAbsolute(normalizedRequest.path)) {
      return { accepted: false, code: 'invalid-request' }
    }
    const service = await dependencies.createTaskService()
    let acceptedJobId: string | null = null
    try {
      // 首条进度会携带图片资源声明；必须先登记服务，Renderer 才能按 jobId 读取资源。
      const result = await service.run(normalizedRequest, (jobId) => {
        acceptedJobId = jobId
        dependencies.taskServices.set(jobId, service)
      })
      if (!result.accepted || !result.jobId) service.dispose()
      return result
    } catch (error) {
      // 接受回调可能已经登记服务；异常返回前必须同时移除映射，避免残留不可达任务。
      if (acceptedJobId && dependencies.taskServices.get(acceptedJobId) === service) {
        dependencies.taskServices.delete(acceptedJobId)
      }
      service.dispose()
      throw error
    }
  })
  /**
   * 使用新代际重新翻译当前文档中失败的目标。
   * @param event IPC 事件对象。
   * @param jobId 任务标识。
   * @param generation Renderer 生成的新任务代际。
   * @returns 主进程是否接受重试。
   * @author zhenghq
   */
  ipcMain.handle('document:retry-failed', (event, jobId: unknown, generation: unknown) => {
    if (!dependencies.isWorkspaceSender(event.sender) || typeof jobId !== 'string' ||
      !Number.isInteger(generation)) {
      return { accepted: false, code: 'invalid-request' }
    }
    return dependencies.taskServices.get(jobId)?.retryFailed(generation as number) ??
      { accepted: false, code: 'not-ready' }
  })
  /**
   * 使用新代际仅重试当前文档中的一个可重试目标。
   * @param event IPC 事件对象。
   * @param jobId 任务标识。
   * @param generation Renderer 生成的新任务代际。
   * @param targetId 稳定目标标识。
   * @returns 主进程是否接受重试。
   * @author zhenghq
   */
  ipcMain.handle('document:retry-failed-target', (
    event,
    jobId: unknown,
    generation: unknown,
    targetId: unknown
  ) => {
    if (!dependencies.isWorkspaceSender(event.sender)) {
      return { accepted: false, code: 'invalid-request' }
    }
    const identity = normalizeDocumentTaskIdentityRequest({ jobId, generation })
    const normalizedTargetId = normalizeDocumentTargetId(targetId)
    if (!identity || !normalizedTargetId || parseDocumentTargetId(normalizedTargetId) === null) {
      return { accepted: false, code: 'invalid-request' }
    }
    return dependencies.taskServices.get(identity.jobId)
      ?.retryFailedTarget(identity.generation, normalizedTargetId) ??
      { accepted: false, code: 'not-ready' }
  })
  /**
   * 取消当前文档翻译任务；任务标识和代际必须同时匹配。
   * @param event IPC 事件对象。
   * @param jobId 任务标识。
   * @param generation 任务代际。
   * @returns 是否实际发出了取消请求。
   * @author zhenghq
   */
  ipcMain.handle('document:cancel', (event, jobId: unknown, generation: unknown) => {
    if (!dependencies.isWorkspaceSender(event.sender)) return false
    const identity = normalizeDocumentTaskIdentityRequest({ jobId, generation })
    if (!identity) return false
    return dependencies.taskServices.get(identity.jobId)
      ?.cancel(identity.jobId, identity.generation) ?? false
  })
  /**
   * 释放已关闭文档标签对应的任务和内存资源。
   * @param event IPC 事件对象。
   * @param jobId 任务标识。
   * @returns 是否找到并释放了任务服务。
   * @author zhenghq
   */
  ipcMain.handle('document:release', (event, jobId: unknown) => {
    if (!dependencies.isWorkspaceSender(event.sender)) return false
    const identity = normalizeDocumentTaskIdentityRequest({ jobId, generation: 1 })
    if (!identity) return false
    return dependencies.releaseTask(identity.jobId)
  })
  /**
   * 将当前译文导出为 PDF。
   * @param event IPC 事件对象。
   * @param request 当前任务标识、代际与显式导出模式。
   * @returns 保存、取消或拒绝结果。
   * @author zhenghq
   */
  ipcMain.handle('document:export-pdf', async (event, request: unknown) => {
    if (!dependencies.isWorkspaceSender(event.sender)) {
      return { status: 'rejected', code: 'unreadable' }
    }
    const normalizedRequest = normalizeDocumentExportRequest(request)
    if (!normalizedRequest) return { status: 'rejected', code: 'invalid-request' }
    const result = await dependencies.taskServices.get(normalizedRequest.jobId)
      ?.exportPdf(normalizedRequest) ??
      { status: 'rejected', code: 'not-ready' }
    if (result.status === 'rejected') {
      console.warn('[document-export]', {
        jobId: normalizedRequest.jobId,
        generation: normalizedRequest.generation,
        mode: normalizedRequest.mode,
        status: result.status,
        code: result.code ?? null
      })
    }
    return result
  })
  /**
   * 导出已重新授权历史文档中的已保存译文；不复用旧任务身份。
   * @param event IPC 事件对象。
   * @param request 已批准源信息、建议文件名与译文模型。
   * @returns 保存、取消或拒绝结果。
   * @author zhenghq
   */
  ipcMain.handle('document:export-approved-pdf', async (event, request: unknown) => {
    if (!dependencies.isWorkspaceSender(event.sender)) {
      return { status: 'rejected', code: 'unreadable' }
    }
    const normalizedRequest = normalizeDocumentApprovedExportRequest(request)
    if (!normalizedRequest) return { status: 'rejected', code: 'invalid-request' }
    const runtime = await dependencies.loadRuntime()
    const result = await runtime.approvedExportService.exportPdf(normalizedRequest)
    if (result.status === 'rejected') {
      console.warn('[document-export-approved]', {
        status: result.status,
        code: result.code ?? null
      })
    }
    return result
  })
  /**
   * 取消当前正在执行的 PDF 导出；任务终态与已完成译文保持不变。
   * @param event IPC 事件对象。
   * @param request 当前任务标识与代际。
   * @returns 是否实际中止了导出。
   * @author zhenghq
   */
  ipcMain.handle('document:cancel-export', (event, request: unknown) => {
    if (!dependencies.isWorkspaceSender(event.sender)) return false
    const normalized = normalizeDocumentExportCancelRequest(request)
    if (!normalized) return false
    return dependencies.taskServices.get(normalized.jobId)
      ?.cancelExport(normalized.jobId, normalized.generation) ?? false
  })
  /**
   * 打开当前任务最近一次成功导出文件所在目录。
   * 文件路径只来自任务服务记录，Renderer 无法指定任意路径。
   * @param event IPC 事件对象。
   * @param request 当前任务标识与代际。
   * @returns 是否成功调用系统文件管理器。
   * @author zhenghq
   */
  ipcMain.handle('document:open-export-folder', async (event, request: unknown) => {
    if (!dependencies.isWorkspaceSender(event.sender)) return false
    const normalized = normalizeDocumentOpenExportFolderRequest(request)
    if (!normalized) return false
    const taskService = dependencies.taskServices.get(normalized.jobId)
    if (taskService) {
      if (normalized.filePath) {
        if (await taskService.openExportFolderPath(
          normalized.jobId,
          normalized.generation,
          normalized.filePath
        )) return true
      } else if (await taskService.openExportFolder(
        normalized.jobId,
        normalized.generation
      )) return true
    }
    // Renderer 指定路径时只回退到历史导出白名单，不能打开当前任务的另一份文件。
    const runtime = await dependencies.loadRuntime()
    const documentApprovedExportService = runtime.approvedExportService
    return normalized.filePath
      ? documentApprovedExportService.openExportFolder(normalized.filePath)
      : documentApprovedExportService.openLastExportFolder()
  })
  /**
   * 读取文档任务历史的安全摘要列表。
   * @param event IPC 事件对象。
   * @returns 按更新时间倒序排列的历史摘要。
   * @author zhenghq
   */
  ipcMain.handle('document:list-history', async (event) => {
    if (!dependencies.isWorkspaceSender(event.sender)) return []
    const runtime = await dependencies.loadRuntime()
    return dependencies.getTaskHistoryStore(runtime).list()
  })
  /**
   * 打开指定文档任务的只读恢复快照。
   * @param event IPC 事件对象。
   * @param jobId 任务标识。
   * @returns 可恢复快照；任务不存在或请求非法时返回 null。
   * @author zhenghq
   */
  ipcMain.handle('document:open-history', async (event, jobId: unknown) => {
    if (!dependencies.isWorkspaceSender(event.sender) ||
      typeof jobId !== 'string' || !jobId) return null
    const runtime = await dependencies.loadRuntime()
    return dependencies.getTaskHistoryStore(runtime).open(jobId)
  })
  /**
   * 删除指定文档任务历史及其源文件对应的翻译缓存。
   * @param event IPC 事件对象。
   * @param jobId 任务标识。
   * @returns 是否实际删除了历史条目。
   * @author zhenghq
   */
  ipcMain.handle('document:delete-history', async (event, jobId: unknown) => {
    if (!dependencies.isWorkspaceSender(event.sender) ||
      typeof jobId !== 'string' || !jobId) return false
    const runtime = await dependencies.loadRuntime()
    const historyStore = dependencies.getTaskHistoryStore(runtime)
    const sourceSha256 = await historyStore.getSourceSha256(jobId)
    const removed = await historyStore.delete(jobId)
    if (removed && sourceSha256) {
      await dependencies.getTranslationCacheStore(runtime).deleteBySourceSha256(sourceSha256)
    }
    return removed
  })
  /**
   * 清空全部文档翻译缓存与任务历史，不修改用户设置。
   * @param event IPC 事件对象。
   * @returns 清空完成后的 Promise。
   * @author zhenghq
   */
  ipcMain.handle('document:clear-cache', async (event) => {
    if (!dependencies.isWorkspaceSender(event.sender)) return
    const runtime = await dependencies.loadRuntime()
    const documentTranslationCache = dependencies.getTranslationCacheStore(runtime)
    const documentTaskHistory = dependencies.getTaskHistoryStore(runtime)
    await documentTranslationCache.clear()
    await documentTaskHistory.clear()
  })
  /**
   * 仅清空全部文档翻译缓存；设置页与文档工作台可调用，不删除任务历史。
   * @param event IPC 事件对象。
   * @returns 清空完成后的 Promise。
   * @author zhenghq
   */
  ipcMain.handle('document:clear-translation-cache', async (event) => {
    if (!dependencies.isWorkspaceSender(event.sender) &&
      !dependencies.isSettingsWindowSender(event.sender)) return
    const runtime = await dependencies.loadRuntime()
    await dependencies.getTranslationCacheStore(runtime).clear()
  })
  /**
   * 读取当前任务中的受控图片资源。
   * @param event IPC 事件对象。
   * @param jobId 任务标识。
   * @param assetId 解析阶段生成的资源标识。
   * @returns 资源字节或稳定错误分类。
   * @author zhenghq
   */
  ipcMain.handle('document:get-asset', async (event, jobId: unknown, assetId: unknown) => {
    if (!dependencies.isWorkspaceSender(event.sender) || typeof jobId !== 'string' ||
      typeof assetId !== 'string') {
      return { ok: false, code: 'asset-not-found' }
    }
    return dependencies.taskServices.get(jobId)?.getAsset(assetId) ??
      { ok: false, code: 'asset-not-found' }
  })
  /**
   * 读取当前活动 PDF 任务的原始字节，供文档窗口使用 PDF.js 原生渲染。
   * @param event IPC 事件对象。
   * @param jobId 任务标识。
   * @returns 受控源文件字节或稳定错误分类。
   * @author zhenghq
   */
  ipcMain.handle('document:get-source', (event, jobId: unknown) => {
    if (!dependencies.isWorkspaceSender(event.sender) || typeof jobId !== 'string') {
      return { ok: false, code: 'source-not-found' }
    }
    return dependencies.taskServices.get(jobId)?.getSource() ??
      { ok: false, code: 'source-not-found' }
  })
  /**
   * 读取已重新授权历史文件的受控图片资源。
   * @param event IPC 事件对象。
   * @param request 源文件快照与资源元数据。
   * @returns 资源字节或稳定错误分类。
   * @author zhenghq
   */
  ipcMain.handle('document:get-approved-asset', async (event, request: unknown) => {
    if (!dependencies.isWorkspaceSender(event.sender)) {
      return { ok: false, code: 'asset-not-found' }
    }
    const runtime = await dependencies.loadRuntime()
    return runtime.approvedResourceService.getAsset(request as DocumentApprovedAssetRequest)
  })
  /**
   * 读取已重新授权历史文件的源预览字节。
   * @param event IPC 事件对象。
   * @param request 源文件路径、格式、大小与 SHA-256。
   * @returns 源预览字节或稳定错误分类。
   * @author zhenghq
   */
  ipcMain.handle('document:get-approved-source', async (event, request: unknown) => {
    if (!dependencies.isWorkspaceSender(event.sender)) {
      return { ok: false, code: 'source-not-approved' }
    }
    const runtime = await dependencies.loadRuntime()
    return runtime.approvedResourceService.getSource(request as DocumentApprovedSourceRequest)
  })
}
