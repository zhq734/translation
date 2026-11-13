import {
  isDocumentSnapshotCompleteForExport,
  resolveDocumentRetryActionState
} from '../../shared/documentCompletion'
import type { DocumentWarning } from '../../shared/documentTypes'
import { countVisibleDocumentWarnings } from '../../shared/documentWarnings'
import { collectDocumentManualTranslationEdits } from '../../shared/documentManualTranslationEdits'
import type {
  Api,
  DocumentApprovedSourceRequest,
  DocumentExportProgress,
  DocumentExportRequest,
  DocumentExportResult,
  DocumentWorkspaceSnapshot
} from '../../shared/types'
import {
  exportButton,
  exportCancelButton,
  exportConfirmButton,
  exportDialog,
  exportIncomplete,
  exportIncompleteNotice,
  exportOpenFolderButton,
  exportProgress,
  exportProgressPage,
  exportProgressPercent,
  exportProgressStage,
  exportProgressTrack,
  exportProgressbar,
  exportRetryButton,
  exportWarningCount,
  partialStatus
} from './documentElements'
import type { DocumentWorkspaceTab } from './documentUiModel'

/** 导出对话框当前对应的任务身份；为空表示尚未打开或已结束。 */
interface DocumentExportTarget {
  /** 所属任务标识。 */
  jobId: string
  /** 所属任务代际。 */
  generation: number
  /** 历史导出没有旧任务身份，不能在导出过程中调用任务取消接口。 */
  canCancel: boolean
  /** 主进程本次成功导出后返回的最终文件路径，用于精确定位目录。 */
  filePath?: string
}

/** 文档导出控制器依赖；任务、页面与确认流程均通过回调注入。 */
export interface DocumentExportControllerDependencies {
  /** 翻译当前界面词条。 */
  t(key: string, params?: Record<string, string | number>): string
  /** 返回当前激活的文档 Tab。 */
  getActiveDocumentTab(): DocumentWorkspaceTab | null
  /** 返回当前激活 Tab 标识。 */
  getActiveDocumentTabId(): string | null
  /** 判断 Tab 是否仍属于当前窗口。 */
  isDocumentTabOpen(tab: DocumentWorkspaceTab): boolean
  /** 激活导出目标 Tab。 */
  activateDocumentTab(tabId: string): Promise<void>
  /** 立即把最新任务快照同步到当前界面。 */
  flushSnapshotRenderForTab(tab: DocumentWorkspaceTab, snapshot: DocumentWorkspaceSnapshot): void
  /** 判断 Tab 是否为只读历史或恢复快照。 */
  isReadOnlyDocumentTab(tab: DocumentWorkspaceTab): boolean
  /** 获取只读 Tab 的受控源文件请求。 */
  approvedDocumentSourceRequest(tab: DocumentWorkspaceTab): DocumentApprovedSourceRequest | null
  /** 定位完成报告中的首个未完成目标。 */
  revealFirstIncompleteTarget(snapshot: DocumentWorkspaceSnapshot): boolean
  /** 等待用户确认是否导出部分结果。 */
  confirmPartialExport(snapshot: DocumentWorkspaceSnapshot): Promise<boolean>
  /** 将文档告警转换为当前界面语言。 */
  localizeDocumentWarning(warning: DocumentWarning): string
  /** 判断快照是否包含可导出内容。 */
  hasUsableExportResult(snapshot: DocumentWorkspaceSnapshot | null): boolean
  /** 重试当前文档的失败目标。 */
  retryFailedDocumentTranslation(): Promise<void>
  /** 返回当前受信任窗口的 IPC API。 */
  getApi(): Api
  /** 提交当前正在就地编辑的译文，确保导出模型包含用户最后一次输入。 */
  commitActiveManualEdit(): void
}

/** 文档导出控制器对外暴露的职责接口。 */
export interface DocumentExportController {
  /** 绑定导出入口、对话框和结果操作。 */
  bindEvents(): void
  /** 将当前译文导出为 PDF。 */
  exportTranslatedPdf(): Promise<void>
  /** 接收主进程推送的受控导出进度。 */
  updateProgress(progress: DocumentExportProgress): void
  /** 关闭导出对话框并清空当前导出身份。 */
  closeDialog(): void
  /** 提交当前导出对话框选择。 */
  confirmExport(): Promise<void>
}

/**
 * 创建文档导出控制器，集中管理导出任务身份、进度和对话框交互。
 * @param dependencies 文档任务与确认流程依赖。
 * @returns 文档导出控制器。
 * @author zhenghq
 */
export function createDocumentExportController(
  dependencies: DocumentExportControllerDependencies
): DocumentExportController {
  let target: DocumentExportTarget | null = null
  let inFlight = false
  let saved = false
  let percent = 0

  /**
   * 打开导出对话框，展示布局、未完成项与告警。
   * @param snapshot 当前任务快照。
   * @returns 对话框打开后的 Promise。
   * @author zhenghq
   */
  const openDialog = async (snapshot: DocumentWorkspaceSnapshot): Promise<void> => {
    const tab = dependencies.getActiveDocumentTab()
    if (!tab || tab.snapshot?.jobId !== snapshot.jobId ||
      tab.snapshot.generation !== snapshot.generation) return
    const readOnly = dependencies.isReadOnlyDocumentTab(tab)
    const retryAction = resolveDocumentRetryActionState(snapshot)
    const incomplete = readOnly ? 0 : retryAction.reverted
    const complete = readOnly || isDocumentSnapshotCompleteForExport(snapshot)
    target = {
      jobId: snapshot.jobId,
      generation: snapshot.generation,
      canCancel: !readOnly
    }
    saved = false
    percent = 0
    exportIncomplete.textContent = dependencies.t('document.export.incompleteCount', {
      count: incomplete
    })
    const warningCount = countVisibleDocumentWarnings(
      snapshot.source?.warnings ?? [],
      snapshot.translation?.warnings ?? []
    )
    exportWarningCount.textContent = dependencies.t('document.export.warningCount', {
      count: warningCount
    })
    exportIncompleteNotice.hidden = complete || incomplete === 0
    exportIncompleteNotice.textContent = dependencies.t('document.export.partialNotice', {
      count: incomplete
    })
    exportRetryButton.hidden = readOnly || complete || retryAction.retryDisabled
    exportConfirmButton.disabled = false
    exportConfirmButton.textContent = complete
      ? dependencies.t('document.export.confirm')
      : dependencies.t('document.export.confirmPartial')
    exportCancelButton.disabled = false
    exportOpenFolderButton.hidden = true
    exportProgress.hidden = true
    exportProgressStage.textContent = ''
    exportProgressPage.textContent = ''
    exportProgressPercent.textContent = ''
    exportProgressTrack.setAttribute('aria-valuenow', '0')
    exportProgressbar.style.width = '0%'
    if (typeof exportDialog.showModal === 'function') exportDialog.showModal()
    else exportDialog.setAttribute('open', '')
  }

  /**
   * 将当前译文导出为 PDF，并把稳定结果映射为界面提示。
   * @returns 无返回值。
   * @author zhenghq
   */
  const exportTranslatedPdf = async (): Promise<void> => {
    // 打开导出对话框前先落地活动手改，避免对话框打开后 DOM 失焦又改写模型导致快照过期。
    dependencies.commitActiveManualEdit()
    const tab = dependencies.getActiveDocumentTab()
    const snapshot = tab?.snapshot
    if (!tab || !snapshot?.translation) return
    if (dependencies.isReadOnlyDocumentTab(tab) && !dependencies.approvedDocumentSourceRequest(tab)) {
      return
    }
    // 导出入口可能在最后一帧译文尚未提交时触发，必须先同步刷新快照。
    dependencies.flushSnapshotRenderForTab(tab, snapshot)
    await openDialog(snapshot)
  }

  /**
   * 更新导出对话框中的阶段、百分比和页级进度。
   * @param progress 主进程推送的受控导出进度。
   * @returns 无返回值。
   * @author zhenghq
   */
  const updateProgress = (progress: DocumentExportProgress): void => {
    if (!target || progress.jobId !== target.jobId || progress.generation !== target.generation) {
      return
    }
    percent = Math.max(percent, Math.round(progress.percent))
    exportProgress.hidden = false
    exportProgressStage.textContent = dependencies.t(`document.export.phase.${progress.phase}`)
    exportProgressPage.textContent = progress.completedPages !== undefined && progress.totalPages !== undefined
      ? dependencies.t('document.export.progressPages', {
        completed: progress.completedPages,
        total: progress.totalPages
      })
      : ''
    exportProgressPercent.textContent = `${percent}%`
    exportProgressTrack.setAttribute('aria-valuenow', String(percent))
    exportProgressbar.style.width = `${percent}%`
    if (progress.warningCount !== undefined) {
      exportWarningCount.textContent = dependencies.t('document.export.warningCount', {
        count: progress.warningCount
      })
    }
  }

  /**
   * 关闭导出对话框并清空当前导出身份。
   * @returns 无返回值。
   * @author zhenghq
   */
  const closeDialog = (): void => {
    if (exportDialog.open) exportDialog.close()
    else exportDialog.removeAttribute('open')
    target = null
    inFlight = false
    saved = false
  }

  /**
   * 提交当前导出对话框选择，完成部分导出确认并等待主进程导出结果。
   * @returns 导出结束后的 Promise。
   * @author zhenghq
   */
  const confirmExport = async (): Promise<void> => {
    // 确认导出时再次提交活动手改，保证导出使用的是用户刚输入且已写入模型的文本。
    dependencies.commitActiveManualEdit()
    const exportTarget = target
    const tab = dependencies.getActiveDocumentTab()
    const snapshot = tab?.snapshot
    if (!exportTarget || !tab || !snapshot || snapshot.jobId !== exportTarget.jobId ||
      snapshot.generation !== exportTarget.generation || inFlight) return
    const readOnly = dependencies.isReadOnlyDocumentTab(tab)
    const approvedSource = readOnly ? dependencies.approvedDocumentSourceRequest(tab) : null
    if (readOnly && (!approvedSource || !snapshot.translation)) {
      partialStatus.textContent = dependencies.t('document.error.unreadable')
      partialStatus.hidden = false
      return
    }
    const complete = readOnly || isDocumentSnapshotCompleteForExport(snapshot)
    if (!complete) {
      dependencies.revealFirstIncompleteTarget(snapshot)
      const confirmed = await dependencies.confirmPartialExport(snapshot)
      if (!confirmed) {
        if (exportDialog.open) exportConfirmButton.focus()
        return
      }
    }
    if (!dependencies.isDocumentTabOpen(tab) || tab.generation !== snapshot.generation ||
      target !== exportTarget) return
    // 等待用户确认期间可能发生手改或流式更新；导出前重新读取同一任务身份的最新快照。
    const latestSnapshot = tab.snapshot
    if (!latestSnapshot || latestSnapshot.jobId !== exportTarget.jobId ||
      latestSnapshot.generation !== exportTarget.generation) return
    if (tab.id !== dependencies.getActiveDocumentTabId()) {
      await dependencies.activateDocumentTab(tab.id)
    }
    // 导出前先同步最新终态，确保文档模型与当前界面使用同一份翻译结果。
    dependencies.flushSnapshotRenderForTab(tab, latestSnapshot)
    inFlight = true
    exportConfirmButton.disabled = true
    exportCancelButton.disabled = !exportTarget.canCancel
    exportRetryButton.hidden = true
    exportOpenFolderButton.hidden = true
    try {
      // 使用显式对象分支固定导出语义，避免后续修改把部分结果误标为完整导出。
      const exportMode: Pick<DocumentExportRequest, 'mode'> = complete
        ? { mode: 'complete' }
        : { mode: 'partial' }
      const api = dependencies.getApi()
      const manualTranslationEdits = latestSnapshot.translation
        ? collectDocumentManualTranslationEdits(latestSnapshot.translation)
        : []
      const result: DocumentExportResult = readOnly && approvedSource && latestSnapshot.translation
        ? await api.exportApprovedDocumentPdf({
          source: approvedSource,
          fileName: tab.selection.name,
          translation: latestSnapshot.translation
        })
        : await api.exportDocumentPdf({
          jobId: latestSnapshot.jobId,
          generation: latestSnapshot.generation,
          ...exportMode,
          // OCR 原文导出必须保留原图并叠加透明文字层，形成可检索的双层 PDF。
          textLayer: true,
          ...(manualTranslationEdits.length > 0 ? { manualTranslationEdits } : {})
        })
      if (!dependencies.isDocumentTabOpen(tab) || target !== exportTarget) return
      if (result.status === 'saved') {
        saved = true
        exportTarget.filePath = result.filePath
        // 历史文档和当前任务导出都记录成功路径，成功保存后统一提供目录入口。
        exportOpenFolderButton.hidden = false
        exportProgressStage.textContent = dependencies.t('document.export.phase.completed')
        exportProgressPercent.textContent = '100%'
        exportProgressTrack.setAttribute('aria-valuenow', '100')
        exportProgressbar.style.width = '100%'
        partialStatus.textContent = result.warnings && result.warnings.length > 0
          ? `${dependencies.t('document.export.saved')} ${result.warnings.map(dependencies.localizeDocumentWarning).join(' ')}`
          : dependencies.t('document.export.saved')
      } else if (result.status === 'cancelled') {
        partialStatus.textContent = dependencies.t('document.export.cancelled')
        exportProgressStage.textContent = dependencies.t('document.export.cancelled')
      } else {
        partialStatus.textContent = result.code === 'font-missing'
          ? dependencies.t('document.fontMissing')
          : `${dependencies.t('document.export.failed')} ${dependencies.t('document.run.failedCode', {
              code: result.code ?? 'export-failed'
            })}`
        exportProgressStage.textContent = dependencies.t('document.export.failed')
      }
      partialStatus.hidden = false
    } catch {
      partialStatus.textContent = `${dependencies.t('document.export.failed')} ${dependencies.t('document.run.failedCode', {
        code: 'export-failed'
      })}`
      partialStatus.hidden = false
      exportProgressStage.textContent = dependencies.t('document.export.failed')
    } finally {
      inFlight = false
      if (target === exportTarget) {
        exportConfirmButton.disabled = saved
        exportConfirmButton.textContent = saved
          ? dependencies.t('document.export.saved')
          : dependencies.t('document.export.confirm')
        exportCancelButton.disabled = false
        const currentSnapshot = tab.snapshot
        exportButton.disabled = !currentSnapshot || !dependencies.hasUsableExportResult(currentSnapshot) ||
          (dependencies.isReadOnlyDocumentTab(tab) && !dependencies.approvedDocumentSourceRequest(tab))
      }
    }
  }

  /**
   * 绑定导出入口、对话框按钮和原生关闭事件。
   * @returns 无返回值。
   * @author zhenghq
   */
  const bindEvents = (): void => {
    exportButton.addEventListener('click', () => void exportTranslatedPdf())
    exportConfirmButton.addEventListener('click', () => void confirmExport())
    exportRetryButton.addEventListener('click', () => {
      closeDialog()
      void dependencies.retryFailedDocumentTranslation()
    })
    exportCancelButton.addEventListener('click', () => {
      const exportTarget = target
      if (inFlight && exportTarget) {
        if (!exportTarget.canCancel) return
        void dependencies.getApi().cancelDocumentExport(exportTarget.jobId, exportTarget.generation)
        exportCancelButton.disabled = true
        return
      }
      closeDialog()
    })
    exportOpenFolderButton.addEventListener('click', async () => {
      const exportTarget = target
      if (!exportTarget) return
      exportOpenFolderButton.disabled = true
      try {
        const opened = await dependencies.getApi().openDocumentExportFolder(
          exportTarget.jobId,
          exportTarget.generation,
          exportTarget.filePath
        )
        if (!opened) {
          exportIncompleteNotice.textContent = dependencies.t('document.export.openFolderFailed')
          exportIncompleteNotice.hidden = false
        }
      } catch {
        exportIncompleteNotice.textContent = dependencies.t('document.export.openFolderFailed')
        exportIncompleteNotice.hidden = false
      } finally {
        if (target === exportTarget) exportOpenFolderButton.disabled = false
      }
    })
    exportDialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      if (inFlight) {
        const exportTarget = target
        if (!exportTarget?.canCancel) return
        void dependencies.getApi().cancelDocumentExport(exportTarget.jobId, exportTarget.generation)
        exportCancelButton.disabled = true
        return
      }
      closeDialog()
    })
    exportDialog.addEventListener('close', () => {
      if (!inFlight) {
        target = null
        saved = false
      }
    })
  }

  return {
    bindEvents,
    exportTranslatedPdf,
    updateProgress,
    closeDialog,
    confirmExport
  }
}
