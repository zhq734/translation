/** 文档双栏正文检索控制器。 */

/** 正文检索命中项。 */
interface DocumentSearchMatch {
  /** 命中文本范围。 */
  range: Range
  /** 包含命中内容的文本 run 或 OCR 区域。 */
  element: HTMLElement
}

/** 文档检索控制器依赖。 */
export interface DocumentSearchControllerDependencies {
  /** 当前界面翻译函数。 */
  t(key: string, params?: Record<string, string | number>): string
  /** 检索输入框。 */
  getInput(): HTMLInputElement
  /** 命中数量状态栏。 */
  getStatus(): HTMLElement
  /** 上一项按钮。 */
  getPreviousButton(): HTMLButtonElement
  /** 下一项按钮。 */
  getNextButton(): HTMLButtonElement
  /** 原文滚动容器。 */
  getSourceContent(): HTMLElement
  /** 译文滚动容器。 */
  getTranslationContent(): HTMLElement
}

/** 文档检索控制器对外接口。 */
export interface DocumentSearchController {
  /** 绑定搜索框与导航按钮事件。 */
  bindEvents(): void
  /** 正文重绘后重新收集命中并恢复当前项。 */
  refresh(): void
  /** 跳转到下一项。 */
  next(): void
  /** 跳转到上一项。 */
  previous(): void
  /** 清空查询、高亮和状态文本。 */
  clear(): void
}

/** CSS Custom Highlight 注册表名称：全部命中。 */
const SEARCH_MATCH_HIGHLIGHT = 'document-search-match'
/** CSS Custom Highlight 注册表名称：当前命中。 */
const SEARCH_CURRENT_HIGHLIGHT = 'document-search-current'
/** 双栏中可作为检索命中容器的稳定文本节点。 */
const SEARCH_TEXT_SELECTOR = [
  '.document-text-run[data-run-id]',
  '.document-ocr-region-text',
  '.document-toc-title',
  '.document-ocr-text-region'
].join(', ')

/**
 * 去除查询首尾空白；正文中的连续空格必须保留。
 * @param query 用户输入。
 * @returns 规范化查询。
 * @author zhenghq
 */
export function normalizeDocumentSearchQuery(query: string): string {
  return query.trim()
}

/**
 * 计算循环检索中的目标序号。
 * @param current 当前命中序号；没有命中时为 -1。
 * @param total 命中总数。
 * @param delta 下一项为 1，上一项为 -1。
 * @returns 循环后的序号；没有命中时返回 -1。
 * @author zhenghq
 */
export function resolveDocumentSearchStep(current: number, total: number, delta: number): number {
  if (total <= 0) return -1
  if (current < 0 || current >= total) return delta < 0 ? total - 1 : 0
  return (current + delta + total) % total
}

/**
 * 按文档顺序收集元素内的文本节点。
 * @param element 检索容器。
 * @returns 文本节点列表。
 * @author zhenghq
 */
function collectTextNodes(element: HTMLElement): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let current = walker.nextNode()
  while (current) {
    nodes.push(current as Text)
    current = walker.nextNode()
  }
  return nodes
}

/**
 * 根据拼接后的文本偏移创建 DOM Range。
 * @param nodes 元素内文本节点。
 * @param start 命中起始偏移。
 * @param end 命中结束偏移。
 * @returns 对应范围；偏移越界时返回 null。
 * @author zhenghq
 */
function createTextRange(nodes: readonly Text[], start: number, end: number): Range | null {
  let offset = 0
  let startNode: Text | null = null
  let endNode: Text | null = null
  let startOffset = 0
  let endOffset = 0
  for (const node of nodes) {
    const nextOffset = offset + node.data.length
    if (!startNode && start >= offset && start < nextOffset) {
      startNode = node
      startOffset = start - offset
    }
    if (end >= offset && end <= nextOffset) {
      endNode = node
      endOffset = end - offset
      break
    }
    offset = nextOffset
  }
  if (!startNode || !endNode) return null
  const range = document.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  return range
}

/**
 * 创建文档正文检索控制器。
 * @param dependencies 搜索框、状态栏与双栏容器。
 * @returns 文档检索控制器。
 * @author zhenghq
 */
export function createDocumentSearchController(
  dependencies: DocumentSearchControllerDependencies
): DocumentSearchController {
  let matches: DocumentSearchMatch[] = []
  let currentIndex = -1

  /**
   * 兼容不支持 CSS Custom Highlight 的 Chromium 版本。
   * @param index 当前命中序号。
   * @returns 无返回值。
   * @author zhenghq
   */
  const applyFallbackElementHighlight = (index: number): void => {
    const roots = new Set(matches.map((match) => match.element))
    for (const root of roots) {
      root.classList.remove('document-search-match', 'document-search-current')
    }
    if (index < 0) return
    for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
      const element = matches[matchIndex]!.element
      element.classList.add(matchIndex === index ? 'document-search-current' : 'document-search-match')
    }
  }

  /**
   * 使用 Range 高亮全部命中和当前命中，不修改正文文本节点。
   * @param index 当前命中序号。
   * @returns 无返回值。
   * @author zhenghq
   */
  const applyHighlights = (index: number): void => {
    const supportsCustomHighlight = typeof Highlight === 'function' && Boolean(CSS.highlights)
    const registry = CSS.highlights as unknown as Map<string, Highlight> | undefined
    if (supportsCustomHighlight && registry) {
      registry.delete(SEARCH_MATCH_HIGHLIGHT)
      registry.delete(SEARCH_CURRENT_HIGHLIGHT)
      const otherRanges = matches
        .map((match, matchIndex) => matchIndex === index ? null : match.range)
        .filter((range): range is Range => range !== null)
      if (otherRanges.length > 0) registry.set(SEARCH_MATCH_HIGHLIGHT, new Highlight(...otherRanges))
      const currentRange = matches[index]?.range
      if (currentRange) registry.set(SEARCH_CURRENT_HIGHLIGHT, new Highlight(currentRange))
      applyFallbackElementHighlight(-1)
      return
    }
    applyFallbackElementHighlight(index)
  }

  /**
   * 更新命中文案和无结果提示。
   * @returns 无返回值。
   * @author zhenghq
   */
  const updateStatus = (): void => {
    const status = dependencies.getStatus()
    const query = normalizeDocumentSearchQuery(dependencies.getInput().value)
    if (!query) {
      status.textContent = ''
      status.hidden = true
      return
    }
    status.hidden = false
    status.textContent = matches.length === 0
      ? dependencies.t('document.search.empty')
      : dependencies.t('document.search.result', {
          current: currentIndex + 1,
          total: matches.length
        })
  }

  /**
   * 定位当前命中，并将所在文本节点滚动到视口中央。
   * @param scroll 是否执行滚动。
   * @returns 无返回值。
   * @author zhenghq
   */
  const select = (index: number, scroll = true): void => {
    currentIndex = matches.length === 0 ? -1 : Math.max(0, Math.min(index, matches.length - 1))
    applyHighlights(currentIndex)
    updateStatus()
    dependencies.getPreviousButton().disabled = matches.length === 0
    dependencies.getNextButton().disabled = matches.length === 0
    if (scroll && currentIndex >= 0) {
      matches[currentIndex]!.element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }

  /**
   * 重新收集双栏命中，并在正文流式重绘后恢复当前序号。
   * @returns 无返回值。
   * @author zhenghq
   */
  const refresh = (): void => {
    const previousIndex = currentIndex
    const query = normalizeDocumentSearchQuery(dependencies.getInput().value)
    matches = []
    if (!query) {
      select(-1, false)
      return
    }
    const normalizedQuery = query.toLocaleLowerCase()
    for (const container of [dependencies.getSourceContent(), dependencies.getTranslationContent()]) {
      for (const element of Array.from(container.querySelectorAll<HTMLElement>(SEARCH_TEXT_SELECTOR))) {
        // 单面视图会隐藏另一栏；隐藏节点不能污染命中总数或导航顺序。
        const hasVisibleRects = element.getClientRects().length > 0
        if (!hasVisibleRects) continue
        const nodes = collectTextNodes(element)
        const text = nodes.map((node) => node.data).join('')
        const normalizedText = text.toLocaleLowerCase()
        let offset = 0
        while (offset <= normalizedText.length - normalizedQuery.length) {
          const matchOffset = normalizedText.indexOf(normalizedQuery, offset)
          if (matchOffset < 0) break
          const range = createTextRange(nodes, matchOffset, matchOffset + normalizedQuery.length)
          if (range) matches.push({ range, element })
          offset = matchOffset + Math.max(1, normalizedQuery.length)
        }
      }
    }
    const nextIndex = matches.length === 0
      ? -1
      : previousIndex < 0
        ? 0
        : Math.min(previousIndex, matches.length - 1)
    select(nextIndex, false)
  }

  /**
   * 清空查询和所有正文高亮。
   * @returns 无返回值。
   * @author zhenghq
   */
  const clear = (): void => {
    dependencies.getInput().value = ''
    currentIndex = -1
    matches = []
    applyHighlights(-1)
    updateStatus()
    dependencies.getPreviousButton().disabled = true
    dependencies.getNextButton().disabled = true
  }

  /**
   * 跳转到上一项。
   * @returns 无返回值。
   * @author zhenghq
   */
  const previous = (): void => {
    if (matches.length === 0) return
    select(resolveDocumentSearchStep(currentIndex, matches.length, -1))
  }

  /**
   * 跳转到下一项。
   * @returns 无返回值。
   * @author zhenghq
   */
  const next = (): void => {
    if (matches.length === 0) return
    select(resolveDocumentSearchStep(currentIndex, matches.length, 1))
  }

  /**
   * 绑定查询输入、循环导航和 Escape 清空交互。
   * @returns 无返回值。
   * @author zhenghq
   */
  const bindEvents = (): void => {
    const input = dependencies.getInput()
    input.addEventListener('input', () => {
      currentIndex = 0
      refresh()
    })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        const delta = event.shiftKey ? -1 : 1
        if (matches.length === 0) return
        select(resolveDocumentSearchStep(currentIndex, matches.length, delta))
      } else if (event.key === 'Escape') {
        event.preventDefault()
        clear()
      }
    })
    dependencies.getPreviousButton().addEventListener('click', previous)
    dependencies.getNextButton().addEventListener('click', next)
  }

  return { bindEvents, refresh, next, previous, clear }
}
