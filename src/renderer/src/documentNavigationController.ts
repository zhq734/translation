import type { DocumentWorkspaceSnapshot } from '../../shared/types'
import {
  documentPageInput,
  documentPageNextButton,
  documentPagePreviousButton,
  documentTocButton,
  documentTocList,
  documentZoomFitButton,
  documentZoomFitHeightButton,
  documentZoomInButton,
  documentZoomOutButton,
  documentZoomResetButton
} from './documentElements'
import type { DocumentTocEntry, DocumentViewMode, DocumentWorkspaceTab } from './documentUiModel'
import type { DocumentScrollSide } from './documentScrollSync'
import {
  parseDocumentPageNumber,
  resolveDocumentFitZoom,
  resolveDocumentPageJump,
  resolveDocumentTocTarget,
  type DocumentNavigationTarget
} from './documentViewer'

/** 文档导航控制器依赖；页面测量与状态写入通过回调注入。 */
export interface DocumentNavigationControllerDependencies {
  /** 翻译当前界面词条。 */
  t(key: string, params?: Record<string, string | number>): string
  /** 返回当前任务快照。 */
  getSnapshot(): DocumentWorkspaceSnapshot | null
  /** 返回当前激活的文档 Tab。 */
  getActiveDocumentTab(): DocumentWorkspaceTab | null
  /** 返回当前可见页码。 */
  getCurrentPageNumber(): number
  /** 同步当前可见页码到活动 Tab。 */
  setCurrentPageNumber(pageNumber: number): void
  /** 同步活动区块标识到活动 Tab。 */
  setActiveBlockId(blockId: string | null): void
  /** 返回当前预览模式。 */
  getViewMode(): DocumentViewMode
  /** 返回当前缩放比例。 */
  getZoom(): number
  /** 设置普通缩放比例。 */
  setZoom(zoom: number): void
  /** 设置适合宽度或高度的精确缩放比例。 */
  setFitZoom(zoom: number): void
  /** 按固定步长调整缩放。 */
  stepZoom(delta: number): void
  /** 调度查看器状态持久化。 */
  scheduleStatePersist(): void
  /** 原文滚动容器。 */
  getSourceContent(): HTMLElement
  /** 译文滚动容器。 */
  getTranslationContent(): HTMLElement
  /** 计算页面可用内容宽度。 */
  getPageContentWidth(container: HTMLElement): number
  /** 计算页面可用高度。 */
  getPageAvailableHeight(container: HTMLElement): number
}

/** 文档导航控制器对外暴露的职责接口。 */
export interface DocumentNavigationController {
  /** 绑定页码、目录与缩放控件交互。 */
  bindEvents(): void
  /** 重新渲染目录列表。 */
  renderToc(): void
  /** 打开或关闭章节目录。 */
  setTocOpen(open: boolean, focusButton?: boolean): void
  /** 在下一帧按当前可见栏刷新页码。 */
  schedulePageUpdate(): void
  /** 计算并同步当前可见页。 */
  updateCurrentPage(side?: DocumentScrollSide): number
  /** 跳转到页面或区块导航目标。 */
  scrollToTarget(target: DocumentNavigationTarget, behavior?: ScrollBehavior): boolean
  /** 高亮指定区块。 */
  highlightBlock(blockId: string): void
  /** 清除区块高亮并同步活动 Tab。 */
  clearBlockHighlight(): void
  /** 仅清除 DOM 区块高亮。 */
  clearBlockDomHighlight(): void
}

/**
 * 创建文档导航控制器，集中管理目录、页码、缩放与目标定位。
 * @param dependencies 页面测量和状态同步依赖。
 * @returns 文档导航控制器。
 * @author zhenghq
 */
export function createDocumentNavigationController(
  dependencies: DocumentNavigationControllerDependencies
): DocumentNavigationController {
  /**
   * 从当前文档模型生成目录项，优先使用显式目录区块，其次使用标题与页面标题。
   * @returns 去重后的目录项。
   * @author zhenghq
   */
  const buildTocEntries = (): DocumentTocEntry[] => {
    const snapshot = dependencies.getSnapshot()
    const model = snapshot?.source ?? snapshot?.translation
    if (!model) return []
    const entries: DocumentTocEntry[] = []
    const seen = new Set<string>()
    for (const page of model.pages) {
      for (const block of page.blocks) {
        if (block.kind !== 'text') continue
        const text = block.runs.map((run) => run.text).join('').trim()
        if (!text) continue
        const target = block.toc
          ? resolveDocumentTocTarget(model, text, block.toc.pageNumber)
          : block.role === 'heading' || block.role === 'subtitle'
            ? {
                pageId: page.pageId,
                pageIndex: page.index,
                pageNumber: page.index + 1,
                blockId: block.blockId
              }
            : null
        if (!target || seen.has(text)) continue
        seen.add(text)
        entries.push({ title: text, target })
      }
    }
    if (entries.length === 0) {
      for (const page of model.pages) {
        const title = page.title?.trim()
        if (!title || seen.has(title)) continue
        seen.add(title)
        entries.push({
          title,
          target: { pageId: page.pageId, pageIndex: page.index, pageNumber: page.index + 1, blockId: null }
        })
      }
    }
    return entries
  }

  /**
   * 仅清除双栏 DOM 中的区块高亮及活动区块标记。
   * @returns 无返回值。
   * @author zhenghq
   */
  const clearBlockDomHighlight = (): void => {
    for (const container of [dependencies.getSourceContent(), dependencies.getTranslationContent()]) {
      for (const block of container.querySelectorAll<HTMLElement>('.document-block-active')) {
        block.classList.remove('document-block-active')
        block.removeAttribute('data-active-block')
      }
    }
    dependencies.setActiveBlockId(null)
  }

  /**
   * 在双栏中高亮指定稳定区块。
   * @param blockId 待高亮区块标识。
   * @returns 无返回值。
   * @author zhenghq
   */
  const highlightBlock = (blockId: string): void => {
    // 高亮新区块只替换 DOM 标记，不能先清除随后还要写入 Tab 的持久化锚点。
    clearBlockDomHighlight()
    dependencies.setActiveBlockId(blockId)
    const tab = dependencies.getActiveDocumentTab()
    if (tab) tab.activeBlockId = blockId
    for (const container of [dependencies.getSourceContent(), dependencies.getTranslationContent()]) {
      const blocks = container.querySelectorAll<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`)
      for (const block of blocks) {
        block.classList.add('document-block-active')
        block.setAttribute('data-active-block', 'true')
      }
    }
    dependencies.scheduleStatePersist()
  }

  /**
   * 清除双栏中的区块高亮及活动区块标记。
   * @returns 无返回值。
   * @author zhenghq
   */
  const clearBlockHighlight = (): void => {
    const tab = dependencies.getActiveDocumentTab()
    if (tab) tab.activeBlockId = null
    clearBlockDomHighlight()
  }

  /**
   * 在下一帧按当前可见栏刷新页码控件。
   * @returns 无返回值。
   * @author zhenghq
   */
  const schedulePageUpdate = (): void => {
    const tab = dependencies.getActiveDocumentTab()
    const tabId = tab?.id ?? null
    requestAnimationFrame(() => {
      if (tabId === null || dependencies.getActiveDocumentTab()?.id !== tabId) return
      const side: DocumentScrollSide = dependencies.getViewMode() === 'translation'
        ? 'translation'
        : 'source'
      updateCurrentPage(side)
    })
  }

  /**
   * 在双栏中定位到页面或区块，并同步双侧高亮。
   * @param target 页码、目录或块级导航目标。
   * @param behavior 滚动动画方式。
   * @returns 是否找到可定位元素。
   * @author zhenghq
   */
  const scrollToTarget = (
    target: DocumentNavigationTarget,
    behavior: ScrollBehavior = 'smooth'
  ): boolean => {
    const selectors = [
      `[data-page-id="${CSS.escape(target.pageId)}"]`,
      `.document-pdf-page[data-page-number="${target.pageNumber}"]`
    ]
    let found = false
    for (const container of [dependencies.getSourceContent(), dependencies.getTranslationContent()]) {
      const page = selectors.map((selector) => container.querySelector<HTMLElement>(selector))
        .find((candidate): candidate is HTMLElement => Boolean(candidate))
      if (!page) continue
      const block = target.blockId
        ? page.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(target.blockId)}"]`) ??
          container.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(target.blockId)}"]`)
        : null
      const destination = block ?? page
      destination.scrollIntoView({ block: 'start', behavior })
      found = true
    }
    dependencies.setCurrentPageNumber(target.pageNumber)
    documentPageInput.value = String(target.pageNumber)
    if (target.blockId) highlightBlock(target.blockId)
    else clearBlockHighlight()
    const snapshot = dependencies.getSnapshot()
    const total = snapshot?.source?.pages.length ?? snapshot?.translation?.pages.length ?? 1
    documentPagePreviousButton.disabled = target.pageNumber <= 1
    documentPageNextButton.disabled = target.pageNumber >= total
    if (behavior === 'instant') schedulePageUpdate()
    dependencies.scheduleStatePersist()
    return found
  }

  /**
   * 计算当前可见文档页，并同步页码输入框与前后页按钮状态。
   * @param side 最近滚动的栏；省略时优先读取原文栏。
   * @returns 当前页面序号，从 1 开始；没有页面时返回 1。
   * @author zhenghq
   */
  const updateCurrentPage = (side: DocumentScrollSide = 'source'): number => {
    const container = side === 'source'
      ? dependencies.getSourceContent()
      : dependencies.getTranslationContent()
    const pages = Array.from(container.querySelectorAll<HTMLElement>('[data-page-id], .document-pdf-page[data-page-number]'))
    const snapshot = dependencies.getSnapshot()
    const total = snapshot?.source?.pages.length ?? pages.length
    if (total < 1) {
      dependencies.setCurrentPageNumber(1)
      documentPageInput.value = ''
      documentPageInput.max = '1'
      documentPagePreviousButton.disabled = true
      documentPageNextButton.disabled = true
      return 1
    }
    const containerRect = container.getBoundingClientRect()
    let visiblePageIndex = 0
    let visibleDistance = Number.POSITIVE_INFINITY
    pages.forEach((page, index) => {
      const rect = page.getBoundingClientRect()
      if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) return
      const distance = Math.abs(rect.top - containerRect.top)
      if (distance < visibleDistance) {
        visibleDistance = distance
        visiblePageIndex = index
      }
    })
    const currentPage = Math.min(total, Math.max(1, visiblePageIndex + 1))
    dependencies.setCurrentPageNumber(currentPage)
    documentPageInput.value = String(currentPage)
    documentPageInput.max = String(total)
    documentPagePreviousButton.disabled = currentPage <= 1
    documentPageNextButton.disabled = currentPage >= total
    return currentPage
  }

  /**
   * 重新渲染目录列表并同步弹层状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  const renderToc = (): void => {
    const entries = buildTocEntries()
    documentTocList.replaceChildren()
    if (entries.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'document-toc-empty'
      empty.textContent = dependencies.t('document.toc.empty')
      documentTocList.append(empty)
      return
    }
    for (const entry of entries) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'document-toc-item'
      button.setAttribute('role', 'option')
      button.dataset.tocPage = String(entry.target.pageNumber)
      button.textContent = entry.title
      button.addEventListener('click', () => {
        scrollToTarget(entry.target)
        setTocOpen(false)
      })
      documentTocList.append(button)
    }
  }

  /**
   * 打开或关闭章节目录弹层。
   * @param open 是否展开目录。
   * @param focusButton 关闭时是否把焦点返回目录按钮。
   * @returns 无返回值。
   * @author zhenghq
   */
  const setTocOpen = (open: boolean, focusButton = false): void => {
    if (open) renderToc()
    documentTocList.hidden = !open
    documentTocButton.setAttribute('aria-expanded', String(open))
    if (open) documentTocList.querySelector<HTMLButtonElement>('button')?.focus()
    else if (focusButton) documentTocButton.focus()
  }

  /**
   * 跳转到指定页码；非法或越界输入恢复当前页码。
   * @param value 页码输入文本。
   * @returns 是否成功跳转。
   * @author zhenghq
   */
  const jumpToPage = (value: string): boolean => {
    const snapshot = dependencies.getSnapshot()
    const model = snapshot?.source ?? snapshot?.translation
    if (!model) {
      documentPageInput.value = ''
      return false
    }
    const pageNumber = parseDocumentPageNumber(value, model.pages.length)
    const target = resolveDocumentPageJump(model, value)
    if (pageNumber === null || !target) {
      documentPageInput.value = String(dependencies.getCurrentPageNumber())
      return false
    }
    return scrollToTarget(target, 'instant')
  }

  /**
   * 按当前可见页切换上一页或下一页。
   * @param offset 相对当前页的偏移量。
   * @returns 无返回值。
   * @author zhenghq
   */
  const stepPage = (offset: number): void => {
    const snapshot = dependencies.getSnapshot()
    const model = snapshot?.source ?? snapshot?.translation
    if (!model) return
    const currentPage = dependencies.getCurrentPageNumber()
    const nextPage = Math.min(model.pages.length, Math.max(1, currentPage + offset))
    jumpToPage(String(nextPage))
  }

  /**
   * 将当前文档缩放到适合可用宽度。
   * @returns 无返回值。
   * @author zhenghq
   */
  const fitToWidth = (): void => {
    const snapshot = dependencies.getSnapshot()
    const model = snapshot?.source ?? snapshot?.translation
    const container = dependencies.getViewMode() === 'source'
      ? dependencies.getSourceContent()
      : dependencies.getTranslationContent()
    const renderedPages = Array.from(container.querySelectorAll<HTMLElement>('[data-page-id], .document-pdf-page[data-page-number]'))
    const currentPageNumber = dependencies.getCurrentPageNumber()
    const renderedPage = renderedPages[currentPageNumber - 1] ?? renderedPages[0]
    const availableWidth = dependencies.getPageContentWidth(container)
    const currentPage = model?.pages[currentPageNumber - 1] ?? model?.pages[0]
    // 图片页的 zoom 会直接作用于原始像素宽度，必须使用模型尺寸作为稳定基准。
    const renderedWidth = renderedPage?.getBoundingClientRect().width ?? 0
    const baseWidth = model?.source.format === 'image'
      ? currentPage?.width
      : renderedWidth > 0 ? renderedWidth / dependencies.getZoom() : currentPage?.width
    dependencies.setFitZoom(baseWidth ? resolveDocumentFitZoom(baseWidth, availableWidth) : 1)
  }

  /**
   * 将当前阅读页缩放到适合可用高度，保持页面原始宽高比例。
   * @returns 无返回值。
   * @author zhenghq
   */
  const fitToHeight = (): void => {
    const snapshot = dependencies.getSnapshot()
    const model = snapshot?.source ?? snapshot?.translation
    const container = dependencies.getViewMode() === 'source'
      ? dependencies.getSourceContent()
      : dependencies.getTranslationContent()
    const renderedPages = Array.from(container.querySelectorAll<HTMLElement>('[data-page-id], .document-pdf-page[data-page-number]'))
    const currentPageNumber = dependencies.getCurrentPageNumber()
    const renderedPage = renderedPages[currentPageNumber - 1] ?? renderedPages[0]
    const availableHeight = dependencies.getPageAvailableHeight(container)
    const currentPage = model?.pages[currentPageNumber - 1] ?? model?.pages[0]
    // 图片页与适合宽度使用同一个原始尺寸基准；其他格式仍从渲染高度还原。
    const renderedHeight = renderedPage?.getBoundingClientRect().height ?? 0
    const baseHeight = model?.source.format === 'image'
      ? currentPage?.height
      : renderedHeight > 0 ? renderedHeight / dependencies.getZoom() : currentPage?.height
    dependencies.setFitZoom(baseHeight ? resolveDocumentFitZoom(baseHeight, availableHeight) : 1)
  }

  /**
   * 绑定页码、目录与缩放控件交互。
   * @returns 无返回值。
   * @author zhenghq
   */
  const bindEvents = (): void => {
    setTocOpen(false)
    documentPageInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        jumpToPage(documentPageInput.value)
        return
      }
      if (event.key !== 'Escape') return
      event.preventDefault()
      documentPageInput.value = String(dependencies.getCurrentPageNumber())
      documentPageInput.blur()
    })
    documentPageInput.addEventListener('change', () => jumpToPage(documentPageInput.value))
    documentPagePreviousButton.addEventListener('click', () => stepPage(-1))
    documentPageNextButton.addEventListener('click', () => stepPage(1))
    documentTocButton.addEventListener('click', () => setTocOpen(documentTocList.hidden))
    documentTocButton.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || documentTocList.hidden) return
      event.preventDefault()
      setTocOpen(false, true)
    })
    documentTocList.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setTocOpen(false, true)
    })
    documentZoomOutButton.addEventListener('click', () => dependencies.stepZoom(-0.1))
    documentZoomInButton.addEventListener('click', () => dependencies.stepZoom(0.1))
    documentZoomResetButton.addEventListener('click', () => dependencies.setZoom(1))
    documentZoomFitButton.addEventListener('click', fitToWidth)
    documentZoomFitHeightButton.addEventListener('click', fitToHeight)
    document.addEventListener('click', (event) => {
      if (documentTocList.hidden ||
        documentTocList.contains(event.target as Node) ||
        documentTocButton.contains(event.target as Node)) return
      setTocOpen(false)
    })
  }

  return {
    bindEvents,
    renderToc,
    setTocOpen,
    schedulePageUpdate,
    updateCurrentPage,
    scrollToTarget,
    highlightBlock,
    clearBlockHighlight,
    clearBlockDomHighlight
  }
}
