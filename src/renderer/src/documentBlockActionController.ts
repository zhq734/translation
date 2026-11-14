/** 文档译文块操作菜单与手改快捷键控制器。 */
import { resolveDocumentElementTargetId } from '../../shared/documentTargetLocator'
import type { DocumentWorkspaceTab } from './documentUiModel'

/** 译文块级操作菜单目标。 */
interface DocumentBlockActionTarget {
  /** 触发操作的译文元素；手改必须使用可编辑叶子节点。 */
  element: HTMLElement
  /** 翻译流水线使用的稳定目标标识。 */
  targetId: string
  /** 是否允许就地手改当前元素。 */
  editable: boolean
}

/** 文档译文块交互控制器依赖。 */
export interface DocumentBlockActionControllerDependencies {
  /** 当前界面翻译函数。 */
  t(key: string, params?: Record<string, string | number>): string
  /** 返回译文滚动容器。 */
  getTranslationContent(): HTMLElement
  /** 返回当前激活的文档 Tab。 */
  getActiveDocumentTab(): DocumentWorkspaceTab | null
  /** 判断当前是否有活动手改。 */
  isEditing(): boolean
  /** 提交当前活动手改。 */
  commitActiveEdit(): void
  /** 进入指定译文元素的手改态。 */
  startEdit(element: HTMLElement): void
  /** 强制重新翻译指定目标。 */
  retranslateTarget(targetId: string): Promise<void> | void
  /** 回退最近一次手改。 */
  undo(): boolean
  /** 前进到最近一次被回退的手改。 */
  redo(): boolean
  /** 手改历史变化后刷新工具栏状态。 */
  onHistoryChange(): void
}

/** 文档译文块交互控制器对外接口。 */
export interface DocumentBlockActionController {
  /** 绑定块操作菜单和手改撤销/重做快捷键。 */
  bindEvents(): void
  /** 关闭并移除当前块操作菜单。 */
  close(): void
}

/** 块级操作菜单关闭延迟；留出从译文移动到浮层的鼠标路径。 */
const DOCUMENT_BLOCK_ACTION_CLOSE_DELAY_MS = 180
/** 悬停展开延迟；避免快速扫过正文时反复闪现菜单。 */
const DOCUMENT_BLOCK_ACTION_HOVER_DELAY_MS = 320

/**
 * 创建文档译文块交互控制器。
 * @param dependencies 块操作菜单与手改快捷键所需依赖。
 * @returns 可绑定事件并主动关闭菜单的控制器。
 * @author zhenghq
 */
export function createDocumentBlockActionController(
  dependencies: DocumentBlockActionControllerDependencies
): DocumentBlockActionController {
  const {
    t,
    getTranslationContent,
    getActiveDocumentTab,
    isEditing,
    commitActiveEdit,
    startEdit,
    retranslateTarget: retranslateDocumentTarget,
    undo,
    redo,
    onHistoryChange
  } = dependencies
  let documentBlockActionMenu: HTMLElement | null = null
  let documentBlockActionTarget: DocumentBlockActionTarget | null = null
  let documentBlockActionHoverTimer: number | null = null
  let documentBlockActionCloseTimer: number | null = null

  /**
   * 清理块级操作菜单的延迟任务，避免过期悬停打开已切换页面的菜单。
   * @returns 无返回值。
   * @author zhenghq
   */
  function clearDocumentBlockActionTimers(): void {
    if (documentBlockActionHoverTimer !== null) {
      window.clearTimeout(documentBlockActionHoverTimer)
      documentBlockActionHoverTimer = null
    }
    if (documentBlockActionCloseTimer !== null) {
      window.clearTimeout(documentBlockActionCloseTimer)
      documentBlockActionCloseTimer = null
    }
  }

  /**
   * 关闭并移除块级操作菜单。
   * @returns 无返回值。
   * @author zhenghq
   */
  function closeDocumentBlockActionMenu(): void {
    clearDocumentBlockActionTimers()
    documentBlockActionMenu?.remove()
    documentBlockActionMenu = null
    documentBlockActionTarget = null
  }

  /**
   * 安排延迟关闭菜单，鼠标进入浮层后可取消关闭。
   * @returns 无返回值。
   * @author zhenghq
   */
  function scheduleDocumentBlockActionClose(): void {
    if (!documentBlockActionMenu) return
    if (documentBlockActionCloseTimer !== null) window.clearTimeout(documentBlockActionCloseTimer)
    documentBlockActionCloseTimer = window.setTimeout(() => {
      documentBlockActionCloseTimer = null
      closeDocumentBlockActionMenu()
    }, DOCUMENT_BLOCK_ACTION_CLOSE_DELAY_MS)
  }

  /**
   * 从译文事件目标解析块级操作对象。
   * 文本优先使用实际 run；表格行使用 rowId；OCR 使用区域标识。未翻译块回退到区块本身。
   * @param eventTarget 鼠标事件目标。
   * @returns 可操作目标；事件不在译文栏或不属于可翻译结构时返回 null。
   * @author zhenghq
   */
  function resolveDocumentBlockActionTarget(eventTarget: EventTarget | null): DocumentBlockActionTarget | null {
    if (!(eventTarget instanceof Element) || !getTranslationContent().contains(eventTarget)) return null
    const tab = getActiveDocumentTab()
    const model = tab?.snapshot?.source ?? tab?.snapshot?.translation
    if (!tab || !model) return null
    const block = eventTarget.closest<HTMLElement>('[data-block-id]')
    const page = eventTarget.closest<HTMLElement>('[data-page-id]')
    if (!block?.dataset.blockId || !page?.dataset.pageId) return null
    const row = eventTarget.closest<HTMLElement>('[data-row-id]')
    const region = eventTarget.closest<HTMLElement>('.document-ocr-region[data-region-id]')
    const run = eventTarget.closest<HTMLElement>('.document-text-run[data-run-id]')
    // 空译文 OCR 槽位通常只会命中外层区域，必须回退到内部可编辑文字节点才能提供“手改译文”。
    const editable = eventTarget.closest<HTMLElement>('[data-manually-editable="true"]') ??
      region?.querySelector<HTMLElement>('.document-ocr-region-text[data-manually-editable="true"]') ??
      null
    const targetElement = editable ?? run ?? region ?? row ?? block
    const targetId = resolveDocumentElementTargetId(model, {
      pageId: page.dataset.pageId,
      blockId: block.dataset.blockId,
      ...(row?.dataset.rowId ? { rowId: row.dataset.rowId } : {}),
      ...(region?.dataset.regionId ? { regionId: region.dataset.regionId } : {}),
      ...(run?.dataset.runId ? { runId: run.dataset.runId } : {})
    })
    if (!targetId) return null
    return {
      element: targetElement,
      targetId,
      editable: Boolean(editable && editable.dataset.manuallyEditable === 'true')
    }
  }

  /**
   * 在指针附近创建块级操作菜单，并限制在视口内保持自适应。
   * @param target 菜单操作目标。
   * @param clientX 首选横坐标。
   * @param clientY 首选纵坐标。
   * @returns 无返回值。
   * @author zhenghq
   */
  function openDocumentBlockActionMenu(
    target: DocumentBlockActionTarget,
    clientX: number,
    clientY: number
  ): void {
    closeDocumentBlockActionMenu()
    documentBlockActionTarget = target
    const menu = document.createElement('div')
    menu.className = 'document-block-action-menu'
    menu.setAttribute('role', 'menu')
    menu.dataset.documentBlockActionMenu = 'true'
    if (target.editable) {
      const edit = document.createElement('button')
      edit.type = 'button'
      edit.className = 'document-block-action'
      edit.dataset.documentBlockAction = 'edit'
      edit.setAttribute('role', 'menuitem')
      edit.textContent = t('document.blockAction.edit')
      edit.addEventListener('click', () => {
        const current = documentBlockActionTarget
        closeDocumentBlockActionMenu()
        if (!current?.editable) return
        commitActiveEdit()
        startEdit(current.element)
      })
      menu.append(edit)
    }
    const retranslate = document.createElement('button')
    retranslate.type = 'button'
    retranslate.className = 'document-block-action'
    retranslate.dataset.documentBlockAction = 'retranslate'
    retranslate.setAttribute('role', 'menuitem')
    retranslate.textContent = t('document.blockAction.retranslate')
    retranslate.addEventListener('click', () => {
      const current = documentBlockActionTarget
      closeDocumentBlockActionMenu()
      if (!current) return
      // 用户主动点击“重新翻译此块”表示要求重新请求提供方，不能复用旧缓存。
      // 失败、未完成与疑似未翻译目标也必须走强制重译，否则最容易命中历史缓存。
      void retranslateDocumentTarget(current.targetId)
    })
    menu.append(retranslate)
    menu.addEventListener('pointerenter', () => {
      if (documentBlockActionCloseTimer !== null) {
        window.clearTimeout(documentBlockActionCloseTimer)
        documentBlockActionCloseTimer = null
      }
    })
    menu.addEventListener('pointerleave', scheduleDocumentBlockActionClose)
    document.body.append(menu)
    const bounds = menu.getBoundingClientRect()
    const margin = 8
    const left = Math.max(margin, Math.min(clientX, window.innerWidth - bounds.width - margin))
    const top = Math.max(margin, Math.min(clientY, window.innerHeight - bounds.height - margin))
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
    documentBlockActionMenu = menu
    // 手改中的悬停/右键菜单不能抢走 contenteditable 焦点，否则输入会中断且触发失焦提交。
    if (!isEditing()) {
      menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    }
  }

  /**
   * 绑定译文块悬停、右键与手改快捷键事件。
   * @returns 无返回值。
   * @author zhenghq
   */
  function bindEvents(): void {
    const translationContent = getTranslationContent()
    translationContent.addEventListener('pointerover', (event) => {
      // 编辑期间鼠标经过其他译文不得启动悬停菜单；用户仍可显式右键打开菜单。
      if (isEditing()) return
      const target = resolveDocumentBlockActionTarget(event.target)
      if (!target) {
        scheduleDocumentBlockActionClose()
        return
      }
      if (documentBlockActionTarget?.targetId === target.targetId &&
        documentBlockActionMenu) {
        if (documentBlockActionCloseTimer !== null) {
          window.clearTimeout(documentBlockActionCloseTimer)
          documentBlockActionCloseTimer = null
        }
        return
      }
      if (documentBlockActionHoverTimer !== null) window.clearTimeout(documentBlockActionHoverTimer)
      documentBlockActionHoverTimer = window.setTimeout(() => {
        documentBlockActionHoverTimer = null
        const bounds = target.element.getBoundingClientRect()
        openDocumentBlockActionMenu(target, bounds.left, bounds.bottom + 6)
      }, DOCUMENT_BLOCK_ACTION_HOVER_DELAY_MS)
    })
    translationContent.addEventListener('pointerleave', scheduleDocumentBlockActionClose)
    translationContent.addEventListener('contextmenu', (event) => {
      const target = resolveDocumentBlockActionTarget(event.target)
      if (!target) return
      event.preventDefault()
      clearDocumentBlockActionTimers()
      openDocumentBlockActionMenu(target, event.clientX, event.clientY)
    })
    translationContent.addEventListener('scroll', closeDocumentBlockActionMenu, { passive: true })
    document.addEventListener('pointerdown', (event) => {
      const target = event.target
      if (!(target instanceof Node) || documentBlockActionMenu?.contains(target)) return
      closeDocumentBlockActionMenu()
    })
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !documentBlockActionMenu) return
      event.preventDefault()
      event.stopPropagation()
      closeDocumentBlockActionMenu()
    })
    window.addEventListener('resize', closeDocumentBlockActionMenu)
    document.addEventListener('keydown', (event) => {
      if (!event.metaKey && !event.ctrlKey) return
      if (event.altKey) return
      const key = event.key.toLowerCase()
      const undoShortcut = key === 'z' && !event.shiftKey
      const redoShortcut = (key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey)
      if (!undoShortcut && !redoShortcut) return
      // 编辑中的输入与表单控件内的撤销交给原生处理，避免与 contenteditable 抢键。
      if (isEditing()) return
      const target = event.target
      if (target instanceof HTMLElement &&
        (target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]'))) {
        return
      }
      const handled = undoShortcut ? undo() : redo()
      if (!handled) return
      event.preventDefault()
      onHistoryChange()
    })
  }

  return { bindEvents, close: closeDocumentBlockActionMenu }
}
