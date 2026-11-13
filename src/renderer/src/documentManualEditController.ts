/** 文档译文块级手改控制器。 */
import type {
  DocumentBlock,
  DocumentModel,
  DocumentOcrRegion,
  DocumentTextBlock,
  DocumentTextRun
} from '../../shared/documentTypes.ts'
import {
  applyDocumentManualTranslationEdits,
  createDocumentManualTextBlockEdits,
  createDocumentManualTocEdits,
  setDocumentManualTranslationText
} from '../../shared/documentManualTranslationEdits.ts'
import type { DocumentTabStatus, DocumentWorkspaceTab } from './documentUiModel.ts'

/**
 * 在区块数组中递归定位稳定区块标识；表格单元格会继续向下搜索。
 * @param blocks 当前层级区块数组。
 * @param blockId 目标区块标识。
 * @returns 命中的区块；不存在时返回 null。
 * @author zhenghq
 */
function findBlock(blocks: readonly DocumentBlock[], blockId: string): DocumentBlock | null {
  for (const block of blocks) {
    if (block.blockId === blockId) return block
    if (block.kind !== 'table') continue
    for (const row of block.rows) {
      for (const cell of row.cells) {
        const nested = findBlock(cell.blocks, blockId)
        if (nested) return nested
      }
    }
  }
  return null
}

/**
 * 从文档模型中定位指定页面内的区块。
 * @param model 当前译文模型。
 * @param pageId 页面标识。
 * @param blockId 区块标识。
 * @returns 命中的区块；不存在时返回 null。
 * @author zhenghq
 */
function findDocumentBlock(model: DocumentModel, pageId: string, blockId: string): DocumentBlock | null {
  const page = model.pages.find((candidate) => candidate.pageId === pageId)
  return page ? findBlock(page.blocks, blockId) : null
}

/**
 * 定位文本区块中的指定 run。
 * @param model 当前译文模型。
 * @param pageId 页面标识。
 * @param blockId 文本区块标识。
 * @param runId 文本 run 标识。
 * @returns 命中的 run；目标类型或标识不匹配时返回 null。
 * @author zhenghq
 */
function findTextRun(
  model: DocumentModel,
  pageId: string,
  blockId: string,
  runId: string | null
): DocumentTextRun | null {
  if (!runId) return null
  const block = findDocumentBlock(model, pageId, blockId)
  if (!block || block.kind !== 'text') return null
  return block.runs.find((run) => run.runId === runId) ?? null
}

/**
 * 定位图片区块中的指定 OCR 区域。
 * @param model 当前译文模型。
 * @param pageId 页面标识。
 * @param blockId 图片区块标识。
 * @param regionId OCR 区域标识。
 * @returns 命中的区域；目标类型或标识不匹配时返回 null。
 * @author zhenghq
 */
function findOcrRegion(
  model: DocumentModel,
  pageId: string,
  blockId: string,
  regionId: string | null
): DocumentOcrRegion | null {
  if (!regionId) return null
  const block = findDocumentBlock(model, pageId, blockId)
  if (!block || block.kind !== 'image') return null
  return block.ocrRegions?.find((region) => region.regionId === regionId) ?? null
}

/**
 * 定位目录文本区块。
 * @param model 当前译文模型。
 * @param pageId 页面标识。
 * @param blockId 区块标识。
 * @returns 目录文本区块；目标不是目录时返回 null。
 * @author zhenghq
 */
function findTocBlock(
  model: DocumentModel,
  pageId: string,
  blockId: string
): DocumentTextBlock | null {
  const block = findDocumentBlock(model, pageId, blockId)
  return block?.kind === 'text' && block.toc ? block : null
}

/**
 * 定位可整体手改的普通文本区块。
 * @param model 当前译文模型。
 * @param pageId 页面标识。
 * @param blockId 区块标识。
 * @returns 普通文本区块；目录或不存在时返回 null。
 * @author zhenghq
 */
function findEditableTextBlock(
  model: DocumentModel,
  pageId: string,
  blockId: string
): DocumentTextBlock | null {
  const block = findDocumentBlock(model, pageId, blockId)
  return block?.kind === 'text' && !block.toc ? block : null
}

/** 文档手改控制器依赖。 */
export interface DocumentManualEditControllerDependencies {
  /** 返回当前激活的文档 Tab。 */
  getActiveDocumentTab(): DocumentWorkspaceTab | null
  /** 译文滚动容器。 */
  getTranslationContent(): HTMLElement
  /** 提交成功后同步模型签名并刷新派生界面。 */
  onCommit(tab: DocumentWorkspaceTab): void
  /** 手改历史栈变化后同步工具栏状态。 */
  onHistoryChange?(): void
}

/** 当前正在编辑的译文目标。 */
export interface DocumentManualEditTarget {
  /** 目标种类。 */
  kind: 'run' | 'block' | 'ocr' | 'toc'
  /** 所属页面标识。 */
  pageId: string
  /** 所属区块标识。 */
  blockId: string
  /** 文本 run 标识；OCR 目标为空。 */
  runId: string | null
  /** OCR 区域标识；文本目标为空。 */
  regionId: string | null
}

/** 文档手改控制器对外接口。 */
export interface DocumentManualEditController {
  /** 绑定双击进入编辑及提交、取消快捷键。 */
  bindEvents(): void
  /** 从块级操作菜单进入指定译文元素的就地编辑态。 */
  startEdit(element: HTMLElement): void
  /** 当前是否存在活动编辑。 */
  isEditing(): boolean
  /** 判断指定文本 run 是否正在编辑。 */
  isEditingRun(runId: string): boolean
  /** 判断指定 OCR 区域是否正在编辑。 */
  isEditingOcrRegion(regionId: string): boolean
  /** 判断图片区块内是否存在活动 OCR 编辑。 */
  hasActiveOcrEditInBlock(blockId: string): boolean
  /** 判断指定区块内是否存在任意活动手改。 */
  isEditingBlock(blockId: string): boolean
  /** 回退最近一次手改；没有可回退历史时返回 false。 */
  undo(): boolean
  /** 前进到最近一次被回退的手改；没有可前进历史时返回 false。 */
  redo(): boolean
  /** 当前 Tab 是否存在可回退的手改。 */
  canUndo(): boolean
  /** 当前 Tab 是否存在可前进的手改。 */
  canRedo(): boolean
  /** 提交当前活动编辑。 */
  commitActiveEdit(): void
  /** 取消当前活动编辑并恢复原文。 */
  cancelActiveEdit(): void
  /** 正文重绘后清理已经脱离文档的活动编辑。 */
  refresh(): void
}

/** 块级手改开始前的 run DOM 快照。 */
interface DocumentManualEditRunSnapshot {
  /** 原始 run 元素；取消编辑时直接复用以避免破坏补丁依赖。 */
  element: HTMLElement
  /** run 稳定标识。 */
  runId: string
  /** 用户进入编辑前的原始文本。 */
  text: string
}

/** 单次手改提交前的模型快照，用于回退与前进。 */
interface DocumentManualEditHistoryEntry {
  /** 提交前的译文模型。 */
  translation: DocumentModel
  /** 提交前的界面状态。 */
  status: DocumentTabStatus
}

/** 单个 Tab 保留的最大手改历史条数；避免长会话下无限增长。 */
const DOCUMENT_MANUAL_EDIT_HISTORY_LIMIT = 50

/**
 * 记录普通文本块编辑前的 run 节点与文本快照。
 * @param element 正在进入编辑态的普通文本块。
 * @returns 保持原 DOM 顺序的 run 快照。
 * @author zhenghq
 */
function captureManualEditBlockRuns(element: HTMLElement): DocumentManualEditRunSnapshot[] {
  return Array.from(element.querySelectorAll<HTMLElement>(':scope > .document-text-run'))
    .filter((run) => Boolean(run.dataset.runId))
    .map((run) => ({
      element: run,
      runId: run.dataset.runId!,
      text: run.textContent ?? ''
    }))
}

/**
 * 取消块级手改时恢复原始 run 节点与文本，清除 contenteditable 产生的额外节点。
 * @param element 正在取消编辑的普通文本块。
 * @param snapshots 进入编辑前记录的 run 快照。
 * @returns 无返回值。
 * @author zhenghq
 */
function restoreManualEditBlockRuns(
  element: HTMLElement,
  snapshots: readonly DocumentManualEditRunSnapshot[]
): void {
  const nodes = snapshots.map((snapshot) => {
    snapshot.element.textContent = snapshot.text
    return snapshot.element
  })
  element.replaceChildren(...nodes)
}

/**
 * 提交块级手改后按模型逐个同步现有 run 节点，保持 run 数量与顺序不丢失。
 * @param element 已完成块级编辑的普通文本块。
 * @param block 提交后的文本区块模型。
 * @param snapshots 进入编辑前记录的 run 快照。
 * @returns 无返回值。
 * @author zhenghq
 */
function syncManualEditBlockRuns(
  element: HTMLElement,
  block: DocumentTextBlock,
  snapshots: readonly DocumentManualEditRunSnapshot[]
): void {
  const snapshotsByRunId = new Map(snapshots.map((snapshot) => [snapshot.runId, snapshot.element]))
  const currentRuns = Array.from(element.querySelectorAll<HTMLElement>(':scope > .document-text-run'))
  const nodes = block.runs.map((run) => {
    const node = snapshotsByRunId.get(run.runId) ??
      currentRuns.find((candidate) => candidate.dataset.runId === run.runId) ??
      document.createElement('span')
    node.className = 'document-text-run'
    node.dataset.runId = run.runId
    node.textContent = run.text
    return node
  })
  element.replaceChildren(...nodes)
}

/**
 * 判断当前文档状态是否允许手改译文。
 * @param status 文档 Tab 状态。
 * @param readOnly 是否为只读回放 Tab。
 * @param runMode 当前任务实际运行模式；OCR 原文任务没有可手改的译文。
 * @param displayMode 当前展示模式；OCR 原文模式展示的是识别源文本。
 * @returns 仅在译文模式的完成或部分完成态允许编辑。
 * @author zhenghq
 */
export function resolveDocumentManualEditAvailability(
  status: DocumentTabStatus,
  readOnly: boolean,
  runMode: 'translation' | 'ocr' = 'translation',
  displayMode: 'translation' | 'ocr-text' = 'translation'
): boolean {
  // 只读回放仍允许形成本地手改与导出模型；OCR 原文不是译文，绝不能写入译文覆盖模型。
  void readOnly
  return (status === 'completed' || status === 'partial') &&
    runMode === 'translation' &&
    displayMode === 'translation'
}

/**
 * 规范化 contenteditable 读取出的文本，统一换行符并保留用户空格。
 * @param value 原始文本。
 * @returns 使用 LF 换行的文本。
 * @author zhenghq
 */
export function normalizeDocumentManualEditText(value: string): string {
  return value.replace(/\r\n?/gu, '\n')
}

/**
 * 创建文档译文手改控制器。
 * @param dependencies 活动 Tab、译文容器与提交回调。
 * @returns 文档手改控制器。
 * @author zhenghq
 */
export function createDocumentManualEditController(
  dependencies: DocumentManualEditControllerDependencies
): DocumentManualEditController {
  let activeElement: HTMLElement | null = null
  let activeTarget: DocumentManualEditTarget | null = null
  let originalText = ''
  let originalBlockRuns: DocumentManualEditRunSnapshot[] = []
  let focusOutCommitTimer: number | null = null
  /** 手改回退栈；按 Tab 标识隔离，避免跨文件串改。 */
  const manualEditUndoStacks = new Map<string, DocumentManualEditHistoryEntry[]>()
  /** 手改前进栈；记录被回退的模型，供重新前进。 */
  const manualEditRedoStacks = new Map<string, DocumentManualEditHistoryEntry[]>()

  /**
   * 取消尚未执行的失焦提交，避免已取消或切换目标后的迟到提交覆盖当前编辑。
   * @returns 无返回值。
   * @author zhenghq
   */
  const clearPendingFocusOutCommit = (): void => {
    if (focusOutCommitTimer === null) return
    window.clearTimeout(focusOutCommitTimer)
    focusOutCommitTimer = null
  }

  /**
   * 清理编辑态 DOM 标记。
   * @param element 正在编辑的文本元素。
   * @returns 无返回值。
   * @author zhenghq
   */
  const clearEditingDom = (element: HTMLElement): void => {
    element.removeAttribute('contenteditable')
    element.removeAttribute('data-document-editing')
    element.classList.remove('document-manual-edit-active')
  }

  /**
   * 判断文本元素是否属于译文栏。
   * @param element 目标文本元素。
   * @returns 属于译文栏时返回 true。
   * @author zhenghq
   */
  const isTranslationElement = (element: HTMLElement): boolean =>
    dependencies.getTranslationContent().contains(element)

  /**
   * 解析双击目标对应的稳定模型标识。
   * @param element 被双击的文本元素。
   * @returns 可提交目标；结构不完整时返回 null。
   * @author zhenghq
   */
  const resolveTarget = (element: HTMLElement): DocumentManualEditTarget | null => {
    if (element.dataset.manuallyEditable !== 'true') return null
    const page = element.closest<HTMLElement>('[data-page-id]')
    const pageId = page?.dataset.pageId
    if (!pageId) return null
    const block = element.closest<HTMLElement>('[data-block-id]')
    if (!block?.dataset.blockId) return null
    if (element.classList.contains('document-toc-title')) {
      return {
        kind: 'toc',
        pageId,
        blockId: block.dataset.blockId,
        runId: null,
        regionId: null
      }
    }
    if (element.classList.contains('document-text-block')) {
      return {
        kind: 'block',
        pageId,
        blockId: block.dataset.blockId,
        runId: null,
        regionId: null
      }
    }
    if (element.classList.contains('document-ocr-region-text')) {
      const region = element.closest<HTMLElement>('.document-ocr-region[data-region-id]')
      if (!region?.dataset.regionId) return null
      return {
        kind: 'ocr',
        pageId,
        blockId: block.dataset.blockId,
        runId: null,
        regionId: region.dataset.regionId
      }
    }
    if (!element.classList.contains('document-text-run') || !element.dataset.runId) return null
    return {
      kind: 'run',
      pageId,
      blockId: block.dataset.blockId,
      runId: element.dataset.runId,
      regionId: null
    }
  }

  /**
   * 恢复当前编辑元素的原始文本并退出编辑态。
   * @returns 无返回值。
   * @author zhenghq
   */
  const cancelActiveEdit = (): void => {
    clearPendingFocusOutCommit()
    if (!activeElement) return
    if (activeTarget?.kind === 'block') {
      restoreManualEditBlockRuns(activeElement, originalBlockRuns)
    } else {
      activeElement.textContent = originalText
    }
    clearEditingDom(activeElement)
    activeElement = null
    activeTarget = null
    originalText = ''
    originalBlockRuns = []
  }

  /**
   * 记录一次手改前的模型快照，供回退使用；任何新编辑都会清空前进栈。
   * @param tab 发生手改的文档 Tab。
   * @param entry 提交前的模型与状态快照。
   * @returns 无返回值。
   * @author zhenghq
   */
  const pushManualEditHistory = (
    tab: DocumentWorkspaceTab,
    entry: DocumentManualEditHistoryEntry
  ): void => {
    const undoStack = manualEditUndoStacks.get(tab.id) ?? []
    undoStack.push(entry)
    if (undoStack.length > DOCUMENT_MANUAL_EDIT_HISTORY_LIMIT) undoStack.shift()
    manualEditUndoStacks.set(tab.id, undoStack)
    manualEditRedoStacks.set(tab.id, [])
  }

  /**
   * 用一条历史快照恢复 Tab 的译文模型与状态，并在当前 Tab 上刷新界面。
   * @param tab 目标文档 Tab。
   * @param entry 要恢复的模型与状态快照。
   * @returns 无返回值。
   * @author zhenghq
   */
  const restoreManualEditHistory = (
    tab: DocumentWorkspaceTab,
    entry: DocumentManualEditHistoryEntry
  ): void => {
    if (!tab.snapshot) return
    tab.snapshot = { ...tab.snapshot, translation: entry.translation }
    tab.status = entry.status
    if (tab.id === dependencies.getActiveDocumentTab()?.id) {
      dependencies.onCommit(tab)
    }
  }

  /**
   * 提交当前编辑文本到 Tab 快照中的译文模型。
   * @returns 无返回值。
   * @author zhenghq
   */
  const commitActiveEdit = (): void => {
    clearPendingFocusOutCommit()
    const element = activeElement
    const target = activeTarget
    if (!element || !target) return
    const tab = dependencies.getActiveDocumentTab()
    const model: DocumentModel | undefined = tab?.snapshot?.translation
    if (!tab || !model) {
      cancelActiveEdit()
      return
    }
    /** 覆盖状态前保留提交前的状态，供回退恢复。 */
    const previousStatus = tab.status
    const text = normalizeDocumentManualEditText(element.textContent ?? '')
    const updated = target.kind === 'toc' || target.kind === 'block'
      ? applyDocumentManualTranslationEdits(
          model,
          target.kind === 'toc'
            ? createDocumentManualTocEdits(model, target.pageId, target.blockId, text)
            : createDocumentManualTextBlockEdits(model, target.pageId, target.blockId, text)
        )
      : setDocumentManualTranslationText(model, target.kind === 'run'
          ? {
              pageId: target.pageId,
              blockId: target.blockId,
              runId: target.runId as string,
              text
            }
          : {
              pageId: target.pageId,
              blockId: target.blockId,
              regionId: target.regionId as string,
              text
            })
    if (!updated) {
      cancelActiveEdit()
      return
    }
    if (target.kind === 'block') {
      const updatedBlock = findEditableTextBlock(updated, target.pageId, target.blockId)
      if (updatedBlock) syncManualEditBlockRuns(element, updatedBlock, originalBlockRuns)
    } else {
      element.textContent = text
    }
    element.dataset.manuallyEdited = 'true'
    element.setAttribute('data-manually-edited', 'true')
    clearEditingDom(element)
    activeElement = null
    activeTarget = null
    originalText = ''
    originalBlockRuns = []
    tab.snapshot = { ...tab.snapshot!, translation: updated }
    tab.status = tab.snapshot.task.status === 'partial' ? 'partial' : 'completed'
    // 覆盖模型前记录一次快照，使本次手改可以回退并再次前进。
    pushManualEditHistory(tab, { translation: model, status: previousStatus })
    dependencies.onCommit(tab)
  }

  /**
   * 回退最近一次手改。编辑态下的输入交给原生撤销，避免与 contenteditable 抢键。
   * @returns 是否实际发生回退。
   * @author zhenghq
   */
  const undo = (): boolean => {
    if (activeElement) return false
    const tab = dependencies.getActiveDocumentTab()
    const model = tab?.snapshot?.translation
    if (!tab || !model) return false
    const entry = manualEditUndoStacks.get(tab.id)?.pop()
    if (!entry) return false
    const redoStack = manualEditRedoStacks.get(tab.id) ?? []
    redoStack.push({ translation: model, status: tab.status })
    manualEditRedoStacks.set(tab.id, redoStack)
    restoreManualEditHistory(tab, entry)
    return true
  }

  /**
   * 前进到最近一次被回退的手改。
   * @returns 是否实际发生前进。
   * @author zhenghq
   */
  const redo = (): boolean => {
    if (activeElement) return false
    const tab = dependencies.getActiveDocumentTab()
    const model = tab?.snapshot?.translation
    if (!tab || !model) return false
    const entry = manualEditRedoStacks.get(tab.id)?.pop()
    if (!entry) return false
    const undoStack = manualEditUndoStacks.get(tab.id) ?? []
    undoStack.push({ translation: model, status: tab.status })
    if (undoStack.length > DOCUMENT_MANUAL_EDIT_HISTORY_LIMIT) undoStack.shift()
    manualEditUndoStacks.set(tab.id, undoStack)
    restoreManualEditHistory(tab, entry)
    return true
  }

  /**
   * 判断当前 Tab 是否存在可回退的手改。
   * @returns 存在可回退历史时返回 true。
   * @author zhenghq
   */
  const canUndo = (): boolean => {
    const tab = dependencies.getActiveDocumentTab()
    return Boolean(tab) && (manualEditUndoStacks.get(tab!.id)?.length ?? 0) > 0
  }

  /**
   * 判断当前 Tab 是否存在可前进的手改。
   * @returns 存在可前进历史时返回 true。
   * @author zhenghq
   */
  const canRedo = (): boolean => {
    const tab = dependencies.getActiveDocumentTab()
    return Boolean(tab) && (manualEditRedoStacks.get(tab!.id)?.length ?? 0) > 0
  }

  /**
   * 在光标位置插入纯文本，避免 contenteditable 生成富文本节点。
   * @param text 待插入文本。
   * @returns 无返回值。
   * @author zhenghq
   */
  const insertPlainText = (text: string): void => {
    const selection = window.getSelection()
    if (!activeElement || !selection?.rangeCount) return
    const range = selection.getRangeAt(0)
    if (!activeElement.contains(range.commonAncestorContainer)) return
    range.deleteContents()
    const node = document.createTextNode(text)
    range.insertNode(node)
    range.setStartAfter(node)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  /**
   * 进入指定文本元素的就地编辑态。
   * @param element 文本 run 或 OCR 区域文本节点。
   * @returns 无返回值。
   * @author zhenghq
   */
  const startEdit = (element: HTMLElement): void => {
    const tab = dependencies.getActiveDocumentTab()
    const target = resolveTarget(element)
    if (!tab || !target || !tab.snapshot?.translation) return
    const readOnly = tab.sourceKind !== 'task'
    if (!resolveDocumentManualEditAvailability(
      tab.status,
      readOnly,
      tab.snapshot.runMode ?? 'translation',
      tab.ocrDisplayMode
    )) return
    if (activeElement && activeElement !== element) commitActiveEdit()
    if (activeElement === element) return
    activeElement = element
    activeTarget = target
    originalText = element.textContent ?? ''
    originalBlockRuns = target.kind === 'block' ? captureManualEditBlockRuns(element) : []
    element.setAttribute('contenteditable', 'plaintext-only')
    element.setAttribute('data-document-editing', 'true')
    element.classList.add('document-manual-edit-active')
    element.focus({ preventScroll: true })
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(element)
    range.collapse(false)
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  /**
   * 处理双击进入编辑。
   * @param event 鼠标事件。
   * @returns 无返回值。
   * @author zhenghq
   */
  const handleDoubleClick = (event: MouseEvent): void => {
    const eventTarget = event.target
    if (!(eventTarget instanceof Element)) return
    const editable = eventTarget.closest<HTMLElement>('[data-manually-editable="true"]')
    const element = editable?.matches('.document-text-block[data-manually-editable="true"], .document-text-run[data-run-id], .document-toc-title, .document-ocr-region-text')
      ? editable
      : null
    if (!element || !isTranslationElement(element)) return
    event.preventDefault()
    startEdit(element)
  }

  /**
   * 处理编辑态快捷键和失焦提交。
   * @param event 键盘或焦点事件。
   * @returns 无返回值。
   * @author zhenghq
   */
  const handleEditKeydown = (event: KeyboardEvent): void => {
    if (!activeElement || event.target !== activeElement) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      cancelActiveEdit()
      return
    }
    if (event.key === 'Enter') {
      if (event.shiftKey) {
        event.preventDefault()
        insertPlainText('\n')
        return
      }
      event.preventDefault()
      event.stopPropagation()
      commitActiveEdit()
    }
  }

  /**
   * 将粘贴内容限制为纯文本。
   * @param event 粘贴事件。
   * @returns 无返回值。
   * @author zhenghq
   */
  const handlePaste = (event: ClipboardEvent): void => {
    if (!activeElement || event.target !== activeElement) return
    event.preventDefault()
    insertPlainText(normalizeDocumentManualEditText(event.clipboardData?.getData('text/plain') ?? ''))
  }

  /**
   * 在编辑元素失焦后延迟确认焦点去向，避免点击块操作菜单时过早提交并退出编辑。
   * 焦点进入菜单时保留当前编辑；其他情况仍提交，防止界面切换丢失用户输入。
   * @param event 焦点事件。
   * @returns 无返回值。
   * @author zhenghq
   */
  const handleFocusOut = (event: FocusEvent): void => {
    const element = activeElement
    if (!element || event.target !== element) return
    clearPendingFocusOutCommit()
    focusOutCommitTimer = window.setTimeout(() => {
      focusOutCommitTimer = null
      if (activeElement !== element) return
      const focused = document.activeElement
      if (focused instanceof Element && focused.closest('.document-block-action-menu')) return
      // 元素仍在编辑态时提交；若菜单操作已显式切换目标，activeElement 会先变化并在这里安全跳过。
      commitActiveEdit()
    }, 0)
  }

  /**
   * 绑定译文栏内的手改事件。
   * @returns 无返回值。
   * @author zhenghq
   */
  const bindEvents = (): void => {
    const container = dependencies.getTranslationContent()
    container.addEventListener('dblclick', handleDoubleClick)
    container.addEventListener('keydown', handleEditKeydown)
    container.addEventListener('paste', handlePaste)
    container.addEventListener('focusout', handleFocusOut)
  }

  /**
   * 清理已被正文重绘移除的编辑元素。
   * @returns 无返回值。
   * @author zhenghq
   */
  const refresh = (): void => {
    const tab = dependencies.getActiveDocumentTab()
    const model = tab?.snapshot?.translation
    const container = dependencies.getTranslationContent()
    for (const element of Array.from(container.querySelectorAll<HTMLElement>('[data-manually-editable="true"]'))) {
      if (!element.isConnected) continue
      const target = resolveTarget(element)
      if (!target || !model) continue
      const run = target.kind === 'run'
        ? findTextRun(model, target.pageId, target.blockId, target.runId)
        : null
      const edited = target.kind === 'run'
        ? run?.protected !== true && run?.manuallyEdited === true
        : target.kind === 'block'
          ? findEditableTextBlock(model, target.pageId, target.blockId)?.runs.some((run) =>
              run.protected !== true && run.manuallyEdited === true) === true
          : target.kind === 'ocr'
            ? findOcrRegion(model, target.pageId, target.blockId, target.regionId)?.manuallyEdited === true
            : findTocBlock(model, target.pageId, target.blockId)?.runs.some((run) =>
                run.protected !== true && run.manuallyEdited === true) === true
      if (edited) {
        element.dataset.manuallyEdited = 'true'
        element.setAttribute('data-manually-edited', 'true')
      } else {
        delete element.dataset.manuallyEdited
        element.removeAttribute('data-manually-edited')
      }
    }
    // 手改提交或回退后模型已变化，回退/前进可用状态必须同步刷新。
    dependencies.onHistoryChange?.()
    if (activeElement?.isConnected) {
      activeElement.dataset.manuallyEditable = 'true'
      activeElement.setAttribute('data-document-editing', 'true')
      activeElement.classList.add('document-manual-edit-active')
      return
    }
    activeElement = null
    activeTarget = null
    originalText = ''
    originalBlockRuns = []
  }

  return {
    bindEvents,
    startEdit,
    isEditing: () => activeElement !== null,
    isEditingRun: (runId) => activeElement !== null && activeTarget?.runId === runId,
    isEditingOcrRegion: (regionId) => activeElement !== null && activeTarget?.regionId === regionId,
    hasActiveOcrEditInBlock: (blockId) => activeElement !== null && activeTarget?.kind === 'ocr' &&
      activeTarget.blockId === blockId,
    isEditingBlock: (blockId) => activeElement !== null && activeTarget?.blockId === blockId,
    undo,
    redo,
    canUndo,
    canRedo,
    commitActiveEdit,
    cancelActiveEdit,
    refresh
  }
}
