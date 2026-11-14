import { langLabel } from '../../shared/langs'
import type { Locale } from '../../shared/i18n'
import type {
  DocumentFileSelectionResult,
  DocumentHistoryEntry,
  DocumentWorkspaceSnapshot
} from '../../shared/types'
import {
  documentHistoryClearButton,
  documentHistoryConfirmCancel,
  documentHistoryConfirmDelete,
  documentHistoryConfirmDescription,
  documentHistoryConfirmDialog,
  documentHistoryConfirmTitle,
  documentHistoryEmpty,
  documentHistoryList,
  documentHistorySearch,
  documentHistoryStatus,
  historyButton,
  historyPopover
} from './documentElements'
import {
  DOCUMENT_FILE_HISTORY_STORAGE_KEY,
  filterDocumentFileHistory,
  filterDocumentTaskHistory,
  findExistingTaskHistoryTab,
  mergeDocumentHistoryEntries,
  normalizeDocumentFileHistory,
  recordDocumentFileHistory,
  type DocumentFileHistoryEntry,
  type DocumentHistoryListItem
} from './documentHistory'
import type {
  DocumentTabStatus,
  DocumentViewMode,
  DocumentWorkspaceTab
} from './documentUiModel'
import { migrateRestoredPdfDocumentWorkspaceSnapshot } from './documentViewer'

/** 历史控制器创建历史任务 Tab 时需要的当前视图默认值。 */
interface DocumentHistoryViewerDefaults {
  /** 当前文档缩放比例。 */
  zoom: number
  /** 当前原文、译文或双栏显示模式。 */
  viewMode: DocumentViewMode
  /** 当前双栏滚动同步开关。 */
  scrollSyncEnabled: boolean
}

/** 文档历史控制器依赖；所有跨职责操作通过回调注入。 */
export interface DocumentHistoryControllerDependencies {
  /** 翻译当前界面词条。 */
  t(key: string, params?: Record<string, string | number>): string
  /** 返回当前界面语言。 */
  getLocale(): Locale
  /** 格式化文件大小。 */
  formatFileSize(bytes: number): string
  /** 将文件校验错误码转换为用户提示。 */
  validationMessage(code: string): string
  /** 当前平台是否支持文档工作台。 */
  isPlatformSupported(): boolean
  /** 返回所有已打开文档 Tab。 */
  getDocumentTabs(): DocumentWorkspaceTab[]
  /** 按文件路径查找已打开 Tab。 */
  findDocumentTabByPath(path: string): DocumentWorkspaceTab | null
  /** 添加新的历史任务 Tab。 */
  addDocumentTab(tab: DocumentWorkspaceTab): void
  /** 分配稳定的文档 Tab 标识。 */
  allocateDocumentTabId(): string
  /** 激活指定文档 Tab。 */
  activateDocumentTab(tabId: string): Promise<void>
  /** 创建或复用普通文件 Tab。 */
  createDocumentTab(
    result: DocumentFileSelectionResult,
    options: { activate: boolean; start: boolean }
  ): Promise<DocumentWorkspaceTab | null>
  /** 启动指定 Tab 的文档翻译任务。 */
  startDocumentTabTranslation(tab: DocumentWorkspaceTab): Promise<void>
  /** 返回当前文档视图默认值。 */
  getViewerDefaults(): DocumentHistoryViewerDefaults
  /** 根据任务快照解析 Tab 状态。 */
  resolveDocumentTabStatus(snapshot: DocumentWorkspaceSnapshot): DocumentTabStatus
}

/** 文档历史控制器对外暴露的职责接口。 */
export interface DocumentHistoryController {
  /** 从本地存储恢复文件历史并完成首次渲染。 */
  initialize(): void
  /** 绑定历史面板、搜索、确认框与键盘交互。 */
  bindEvents(): void
  /** 从主进程加载任务历史。 */
  loadTaskHistory(): Promise<void>
  /** 记录一次成功选择的文件。 */
  rememberSelectedDocument(
    selection: Pick<DocumentFileHistoryEntry, 'path' | 'name' | 'size' | 'format'>
  ): void
  /** 按当前搜索词重绘历史列表。 */
  render(): void
  /** 打开或关闭历史下拉。 */
  setOpen(open: boolean, restoreFocus?: boolean): void
  /** 关闭历史删除或清空确认框。 */
  closeConfirmation(restoreFocus?: boolean): void
  /** 执行已确认的删除或清空操作。 */
  confirmAction(): Promise<void>
  /** 打开统一历史条目。 */
  openEntry(entry: DocumentHistoryListItem): Promise<void>
}

/**
 * 创建文档历史控制器，集中管理本地文件历史、任务历史与相关交互。
 * @param dependencies 跨职责操作依赖。
 * @returns 文档历史控制器。
 * @author zhenghq
 */
export function createDocumentHistoryController(
  dependencies: DocumentHistoryControllerDependencies
): DocumentHistoryController {
  /** 当前本地文件翻译历史；按最近选择时间倒序排列。 */
  let fileHistory: DocumentFileHistoryEntry[] = []
  /** 当前搜索条件下实际展示的任务历史。 */
  let visibleTaskHistory: DocumentHistoryEntry[] = []
  /** 主进程持久化的文档任务历史摘要。 */
  let taskHistory: DocumentHistoryEntry[] = []
  /** 当前搜索条件下合并展示的任务与文件历史。 */
  let visibleHistory: DocumentHistoryListItem[] = []
  /** 是否正在执行历史文件切换。 */
  let switchInFlight = false
  /** 当前等待用户确认的历史操作。 */
  let pendingAction:
    | { kind: 'delete'; entry: DocumentHistoryListItem }
    | { kind: 'clear' }
    | null = null
  /** 历史确认对话框关闭后应恢复焦点的触发按钮。 */
  let focusTarget: HTMLElement | null = null

  /**
   * 从本地存储读取并规范化文件翻译历史。
   * @returns 可安全渲染的历史记录；存储不可用或内容损坏时返回空列表。
   * @author zhenghq
   */
  const readFileHistory = (): DocumentFileHistoryEntry[] => {
    try {
      const raw = window.localStorage.getItem(DOCUMENT_FILE_HISTORY_STORAGE_KEY)
      return raw ? normalizeDocumentFileHistory(JSON.parse(raw)) : []
    } catch {
      return []
    }
  }

  /**
   * 将文件翻译历史持久化到本地存储。
   * @param entries 待保存的历史记录。
   * @returns 无返回值。
   * @author zhenghq
   */
  const writeFileHistory = (entries: readonly DocumentFileHistoryEntry[]): void => {
    try {
      window.localStorage.setItem(DOCUMENT_FILE_HISTORY_STORAGE_KEY, JSON.stringify(entries))
    } catch {
      // 本地存储受限时仍保留当前窗口内可用的历史记录。
    }
  }

  /**
   * 将任务状态转换为当前语言下的简短标签。
   * @param status 历史任务的终态。
   * @returns 可展示的状态文本。
   * @author zhenghq
   */
  const historyStatusLabel = (status: DocumentHistoryEntry['status']): string => {
    const keys: Partial<Record<DocumentHistoryEntry['status'], string>> = {
      completed: 'document.progress.completed',
      partial: 'document.partial',
      failed: 'document.progress.failed',
      cancelled: 'document.progress.cancelled'
    }
    return dependencies.t(keys[status] ?? 'document.progress.preparing')
  }

  /**
   * 格式化历史条目的最近更新时间。
   * @param timestamp 毫秒时间戳。
   * @returns 当前界面语言下的日期和时间。
   * @author zhenghq
   */
  const formatHistoryTime = (timestamp: number): string => {
    try {
      return new Intl.DateTimeFormat(dependencies.getLocale(), {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(timestamp))
    } catch {
      return new Date(timestamp).toLocaleString()
    }
  }

  /**
   * 创建历史列表中的删除图标按钮。
   * @param label 按钮的可访问文本。
   * @param index 条目在当前可见列表中的索引。
   * @returns 带 X 图标和事件数据的删除按钮。
   * @author zhenghq
   */
  const createDeleteButton = (label: string, index: number): HTMLButtonElement => {
    const button = document.createElement('button')
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const firstLine = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    const secondLine = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    button.type = 'button'
    button.className = 'document-history-delete'
    button.dataset.historyAction = 'delete'
    button.dataset.historyIndex = String(index)
    button.setAttribute('aria-label', label)
    button.setAttribute('title', label)
    icon.setAttribute('viewBox', '0 0 16 16')
    icon.setAttribute('aria-hidden', 'true')
    firstLine.setAttribute('d', 'm4 4 8 8')
    secondLine.setAttribute('d', 'm12 4-8 8')
    icon.append(firstLine, secondLine)
    button.append(icon)
    return button
  }

  /**
   * 根据当前搜索词渲染任务与文件历史下拉列表。
   * @returns 无返回值。
   * @author zhenghq
   */
  const render = (): void => {
    const query = documentHistorySearch.value
    const visibleFileHistory = filterDocumentFileHistory(fileHistory, query)
    visibleTaskHistory = filterDocumentTaskHistory(taskHistory, query)
    visibleHistory = mergeDocumentHistoryEntries(visibleTaskHistory, visibleFileHistory)
    documentHistoryList.replaceChildren()
    documentHistoryEmpty.hidden = visibleHistory.length > 0
    documentHistoryEmpty.textContent = taskHistory.length === 0 && fileHistory.length === 0
      ? dependencies.t('document.historyEmpty')
      : dependencies.t('document.historyNoResults')
    documentHistoryClearButton.disabled = taskHistory.length === 0 && fileHistory.length === 0

    const tabs = dependencies.getDocumentTabs()
    visibleHistory.forEach((entry, index) => {
      const item = document.createElement('li')
      const openButton = document.createElement('button')
      const copy = document.createElement('span')
      const name = document.createElement('strong')
      const meta = document.createElement('span')
      item.className = 'document-history-row'
      const isCurrent = entry.kind === 'task'
        ? findExistingTaskHistoryTab(tabs, entry.jobId) !== null
        : dependencies.findDocumentTabByPath(entry.path) !== null
      item.dataset.selected = String(isCurrent)
      openButton.type = 'button'
      openButton.className = 'document-history-item'
      openButton.dataset.historyIndex = String(index)
      openButton.dataset.historyAction = 'open'
      openButton.addEventListener('click', () => void openEntry(entry))
      openButton.setAttribute('role', 'option')
      openButton.setAttribute('aria-selected', String(isCurrent))
      openButton.title = entry.kind === 'task' ? entry.task.fileName : entry.path
      copy.className = 'document-history-item-copy'
      name.textContent = entry.kind === 'task' ? entry.task.fileName : entry.file.name
      if (entry.kind === 'task') {
        const direction = `${langLabel(entry.task.languagePair.sourceLang, dependencies.getLocale())} → ${langLabel(entry.task.languagePair.targetLang, dependencies.getLocale())}`
        const exportLabel = entry.task.exportStatus === 'saved'
          ? dependencies.t('document.historyExported')
          : dependencies.t('document.historyNotExported')
        meta.textContent = `${entry.task.format.toUpperCase()} · ${direction} · ${historyStatusLabel(entry.task.status)} · ${Math.round(entry.task.percent)}% · ${formatHistoryTime(entry.task.updatedAt)} · ${exportLabel}`
      } else {
        meta.textContent = `${entry.file.format.toUpperCase()} · ${dependencies.formatFileSize(entry.file.size)} · ${formatHistoryTime(entry.file.lastUsedAt)}`
      }
      copy.append(name, meta)
      openButton.append(copy)
      item.append(openButton, createDeleteButton(dependencies.t('document.historyDelete'), index))
      documentHistoryList.append(item)
    })
  }

  /**
   * 打开或关闭历史文件下拉，并在打开时聚焦搜索框。
   * @param open 是否打开下拉。
   * @param restoreFocus 关闭时是否把焦点还给历史按钮。
   * @returns 无返回值。
   * @author zhenghq
   */
  const setOpen = (open: boolean, restoreFocus = false): void => {
    if (historyPopover.hidden === !open) return
    historyPopover.hidden = !open
    historyButton.setAttribute('aria-expanded', String(open))
    if (open) {
      documentHistoryStatus.hidden = true
      documentHistorySearch.value = ''
      render()
      requestAnimationFrame(() => documentHistorySearch.focus())
    } else if (restoreFocus) {
      historyButton.focus()
    }
  }

  /**
   * 关闭历史操作确认框并恢复触发按钮焦点。
   * @param restoreFocus 是否把焦点恢复到打开确认框前的元素。
   * @returns 无返回值。
   * @author zhenghq
   */
  const closeConfirmation = (restoreFocus = true): void => {
    pendingAction = null
    const target = focusTarget
    focusTarget = null
    if (documentHistoryConfirmDialog.open) documentHistoryConfirmDialog.close()
    else documentHistoryConfirmDialog.removeAttribute('open')
    if (restoreFocus && target?.isConnected) target.focus()
  }

  /**
   * 打开历史删除或清空确认对话框。
   * @param action 待确认操作；null 表示关闭对话框。
   * @param nextFocusTarget 对话框关闭后恢复焦点的元素。
   * @returns 无返回值。
   * @author zhenghq
   */
  const setConfirmation = (
    action: NonNullable<typeof pendingAction> | null,
    nextFocusTarget?: HTMLElement | null
  ): void => {
    if (!action) {
      if (nextFocusTarget) focusTarget = nextFocusTarget
      closeConfirmation()
      return
    }
    pendingAction = action
    focusTarget = nextFocusTarget ?? (document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null)
    const isClear = action.kind === 'clear'
    const isFile = action.kind === 'delete' && action.entry.kind === 'file'
    const fileName = action.kind === 'delete'
      ? action.entry.kind === 'task' ? action.entry.task.fileName : action.entry.file.name
      : ''
    documentHistoryConfirmDialog.setAttribute('aria-modal', 'true')
    documentHistoryConfirmTitle.textContent = dependencies.t(isClear
      ? 'document.historyClearTitle'
      : 'document.historyDeleteTitle')
    documentHistoryConfirmDescription.textContent = isClear
      ? dependencies.t('document.historyClearDescription')
      : dependencies.t(isFile
        ? 'document.historyDeleteFileDescription'
        : 'document.historyDeleteDescription', { name: fileName })
    documentHistoryConfirmDelete.textContent = dependencies.t(isClear
      ? 'document.historyConfirmClear'
      : 'document.historyConfirmDelete')
    documentHistoryConfirmDelete.dataset.action = action.kind
    documentHistoryConfirmDialog.dataset.action = action.kind
    if (typeof documentHistoryConfirmDialog.showModal === 'function') {
      documentHistoryConfirmDialog.showModal()
    } else {
      documentHistoryConfirmDialog.setAttribute('open', '')
    }
    requestAnimationFrame(() => documentHistoryConfirmCancel.focus())
  }

  /**
   * 使用历史记录快速切换到已选择过的文件。
   * @param entry 待切换的历史记录。
   * @returns 无返回值。
   * @author zhenghq
   */
  const switchToFileEntry = async (entry: DocumentFileHistoryEntry): Promise<void> => {
    if (!dependencies.isPlatformSupported() || switchInFlight) return
    const existingTab = dependencies.findDocumentTabByPath(entry.path)
    if (existingTab) {
      await dependencies.activateDocumentTab(existingTab.id)
      setOpen(false, true)
      return
    }
    switchInFlight = true
    historyButton.disabled = true
    documentHistoryStatus.hidden = true
    try {
      // 历史路径只作为候选值，切换前仍由主进程重新读取文件并登记授权。
      const result = await window.api.approveDocumentFile(entry.path)
      if (result.status === 'cancelled') return
      if (result.status === 'rejected') {
        documentHistoryStatus.textContent = dependencies.validationMessage(result.code)
        documentHistoryStatus.hidden = false
        return
      }
      const tab = await dependencies.createDocumentTab(result, { activate: true, start: false })
      if (tab) await dependencies.startDocumentTabTranslation(tab)
      setOpen(false, true)
    } catch {
      documentHistoryStatus.textContent = dependencies.t('document.error.unreadable')
      documentHistoryStatus.hidden = false
    } finally {
      switchInFlight = false
      historyButton.disabled = !dependencies.isPlatformSupported()
    }
  }

  /**
   * 以只读方式打开持久化的历史任务快照。
   * @param entry 待打开的任务历史摘要。
   * @returns 打开完成后的 Promise。
   * @author zhenghq
   */
  const openTaskEntry = async (entry: DocumentHistoryEntry): Promise<void> => {
    if (switchInFlight) return
    const existingTab = findExistingTaskHistoryTab(dependencies.getDocumentTabs(), entry.jobId)
    if (existingTab) {
      await dependencies.activateDocumentTab(existingTab.id)
      setOpen(false, true)
      return
    }
    switchInFlight = true
    documentHistoryStatus.hidden = true
    try {
      const result = await window.api.openDocumentHistory(entry.jobId)
      if (!result) {
        documentHistoryStatus.textContent = dependencies.t('document.historyLoadFailed')
        documentHistoryStatus.hidden = false
        return
      }
      const snapshot = migrateRestoredPdfDocumentWorkspaceSnapshot(result.snapshot)
      const source = snapshot.source?.source
      // 快照加载后再次按文件身份绑定实时 Tab；普通打开的同一文件不得再开只读回放 Tab。
      const fileTab = findExistingTaskHistoryTab(dependencies.getDocumentTabs(), entry.jobId, source)
      if (fileTab) {
        await dependencies.activateDocumentTab(fileTab.id)
        setOpen(false, true)
        return
      }
      let sourceAuthorized = false
      if (source?.path && source.sha256 && Number.isSafeInteger(source.size) && source.size > 0) {
        try {
          const authorized = await window.api.approveDocumentFile(source.path)
          sourceAuthorized = authorized.status === 'selected' &&
            authorized.path === source.path &&
            authorized.format === source.format &&
            authorized.size === source.size &&
            authorized.sha256 === source.sha256
        } catch {
          // 源文件已移动、删除或不可读时仍允许回放已保存译文，但不能读取源资源。
          sourceAuthorized = false
        }
      }
      const viewerDefaults = dependencies.getViewerDefaults()
      const tab: DocumentWorkspaceTab = {
        id: dependencies.allocateDocumentTabId(),
        sourceKind: 'history',
        selection: {
          path: source?.path ?? '',
          name: entry.fileName,
          size: source?.size ?? 0,
          format: entry.format,
          sha256: source?.sha256 ?? '',
          error: null
        },
        snapshot,
        activeJobId: null,
        expectedJobId: null,
        generation: snapshot.generation,
        startInFlight: false,
        status: dependencies.resolveDocumentTabStatus(snapshot),
        scrollPositions: { source: 0, translation: 0 },
        zoom: viewerDefaults.zoom,
        viewMode: viewerDefaults.viewMode,
        pageNumber: 1,
        scrollSyncEnabled: viewerDefaults.scrollSyncEnabled,
        sourceLang: snapshot.sourcePreference ?? entry.sourcePreference,
        targetLang: snapshot.targetPreference ?? entry.targetPreference,
        ocrDisplayMode: snapshot.runMode === 'ocr' ? 'ocr-text' : 'translation',
        activeBlockId: null,
        pendingLanguageRetranslation: false,
        pendingOcrModeTarget: null,
        ocrModeSwitchInFlight: false,
        pendingModeSwitchGeneration: null,
        pendingModeSwitchSnapshot: null,
        pendingModeSwitchSnapshotTerminal: false,
        languageRevision: 0,
        sourceAuthorized
      }
      dependencies.addDocumentTab(tab)
      await dependencies.activateDocumentTab(tab.id)
      setOpen(false, true)
    } catch {
      documentHistoryStatus.textContent = dependencies.t('document.historyLoadFailed')
      documentHistoryStatus.hidden = false
    } finally {
      switchInFlight = false
    }
  }

  /**
   * 从历史列表中打开任务摘要或重新授权本地文件。
   * @param entry 统一历史条目。
   * @returns 打开完成后的 Promise。
   * @author zhenghq
   */
  const openEntry = async (entry: DocumentHistoryListItem): Promise<void> => {
    if (entry.kind === 'task') {
      await openTaskEntry(entry.task)
      return
    }
    await switchToFileEntry(entry.file)
  }

  /**
   * 执行已确认的历史删除或清空操作。
   * @returns 操作完成后的 Promise。
   * @author zhenghq
   */
  const confirmAction = async (): Promise<void> => {
    const action = pendingAction
    if (!action) return
    const restoreTarget = focusTarget
    documentHistoryConfirmDelete.disabled = true
    try {
      const entry = action.kind === 'delete' ? action.entry : null
      if (entry?.kind === 'file') {
        fileHistory = fileHistory.filter((candidate) => candidate.path !== entry.file.path)
        writeFileHistory(fileHistory)
        render()
        documentHistoryStatus.textContent = dependencies.t('document.historyDeleted')
        documentHistoryStatus.hidden = false
      } else if (entry?.kind === 'task') {
        const jobId = entry.task.jobId
        const removed = await window.api.deleteDocumentHistory(jobId)
        taskHistory = taskHistory.filter((candidate) => candidate.jobId !== jobId)
        // 同名本地文件入口可能只是该任务的重新授权记录，删除任务时一并移除避免残留重复项。
        fileHistory = fileHistory.filter((candidate) => candidate.name !== entry.task.fileName)
        writeFileHistory(fileHistory)
        render()
        documentHistoryStatus.textContent = removed
          ? dependencies.t('document.historyDeleted')
          : dependencies.t('document.historyLoadFailed')
        documentHistoryStatus.hidden = false
      } else {
        await window.api.clearDocumentCache()
        taskHistory = []
        fileHistory = []
        writeFileHistory(fileHistory)
        render()
        documentHistoryStatus.textContent = dependencies.t('document.historyCleared')
        documentHistoryStatus.hidden = false
      }
      setConfirmation(null, restoreTarget ?? undefined)
    } catch {
      documentHistoryStatus.textContent = dependencies.t('document.historyLoadFailed')
      documentHistoryStatus.hidden = false
    } finally {
      documentHistoryConfirmDelete.disabled = false
    }
  }

  /**
   * 绑定历史面板、搜索、确认框与键盘交互。
   * @returns 无返回值。
   * @author zhenghq
   */
  const bindEvents = (): void => {
    historyButton.addEventListener('click', () => setOpen(historyPopover.hidden))
    documentHistoryClearButton.addEventListener('click', () => {
      setConfirmation({ kind: 'clear' }, documentHistoryClearButton)
    })
    documentHistoryConfirmDelete.addEventListener('click', () => void confirmAction())
    documentHistoryConfirmCancel.addEventListener('click', () => closeConfirmation())
    documentHistoryConfirmDialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      closeConfirmation()
    })
    documentHistoryConfirmDialog.addEventListener('close', () => {
      // 原生关闭路径只清理待确认状态；焦点由显式按钮或 cancel 路径恢复。
      if (pendingAction) closeConfirmation(false)
    })
    documentHistorySearch.addEventListener('input', render)
    documentHistorySearch.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        const firstEntry = visibleHistory[0]
        if (firstEntry) {
          event.preventDefault()
          void openEntry(firstEntry)
        }
        return
      }
      if (event.key !== 'ArrowDown') return
      event.preventDefault()
      documentHistoryList.querySelector<HTMLButtonElement>('.document-history-item')?.focus()
    })
    documentHistoryList.addEventListener('click', (event) => {
      const deleteButton = (event.target as HTMLElement)
        .closest<HTMLButtonElement>('[data-history-action="delete"]')
      if (!deleteButton) return
      // 删除按钮与整行打开按钮分开渲染，按列表索引找回任务或文件历史条目。
      const entry = visibleHistory[Number(deleteButton.dataset.historyIndex)]
      if (entry) setConfirmation({ kind: 'delete', entry }, deleteButton)
    })
    documentHistoryList.addEventListener('keydown', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-history-action]')
      if (!item) return
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      // 上下键在整行打开按钮之间移动；X 删除按钮通过 Tab 单独访问，避免误触删除。
      const items = Array.from(documentHistoryList.querySelectorAll<HTMLButtonElement>('.document-history-item'))
      const currentIndex = items.indexOf(item as HTMLButtonElement)
      if (currentIndex < 0) return
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[nextIndex]?.focus()
    })
    document.addEventListener('click', (event) => {
      if (historyPopover.hidden ||
        historyPopover.contains(event.target as Node) ||
        historyButton.contains(event.target as Node)) return
      setOpen(false)
    })
    document.addEventListener('keydown', (event) => {
      // 确认框打开时由原生 cancel 处理 Escape，避免同时关闭其背后的历史面板。
      if (event.key === 'Escape' && !historyPopover.hidden && !documentHistoryConfirmDialog.open) {
        event.preventDefault()
        setOpen(false, true)
      }
    })
  }

  return {
    initialize: () => {
      fileHistory = readFileHistory()
      render()
    },
    bindEvents,
    loadTaskHistory: async () => {
      try {
        taskHistory = await window.api.listDocumentHistory()
        render()
      } catch {
        documentHistoryStatus.textContent = dependencies.t('document.historyLoadFailed')
        documentHistoryStatus.hidden = false
      }
    },
    rememberSelectedDocument: (selection) => {
      fileHistory = recordDocumentFileHistory(fileHistory, selection, Date.now())
      writeFileHistory(fileHistory)
      render()
    },
    render,
    setOpen,
    closeConfirmation,
    confirmAction,
    openEntry
  }
}
