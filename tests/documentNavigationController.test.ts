import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentModel, DocumentTextBlock } from '../src/shared/documentTypes.ts'
import type { DocumentWorkspaceSnapshot } from '../src/shared/types'

interface ElementStub {
  hidden: boolean
  value: string
  max: string
  disabled: boolean
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  textContent: string
  dataset: Record<string, string>
  style: { setProperty(name: string, value: string): void }
  classList: { add(...names: string[]): void; remove(...names: string[]): void; contains(name: string): boolean }
  addEventListener(type: string, listener: (event: unknown) => void): void
  append(...nodes: unknown[]): void
  replaceChildren(...nodes: unknown[]): void
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  getAttribute(name: string): string | null
  querySelector<T>(selector: string): T | null
  querySelectorAll<T>(selector: string): T[]
  getBoundingClientRect(): { top: number; bottom: number; left: number; right: number; width: number; height: number }
  scrollIntoView(options?: unknown): void
  scrollTo(options: { top?: number }): void
  focus(): void
  contains(node: unknown): boolean
}

interface ElementCallLog {
  scrollIntoViewCount: number
  scrollToTop: number | null
}

const elementLogs = new WeakMap<ElementStub, ElementCallLog>()
const elementsById = new Map<string, ElementStub>()
const createdElements: ElementStub[] = []

/**
 * 创建最小的 DOM 元素替身，仅实现文档工作台绑定与滚动所需的接口。
 * @param tagName 元素标签名。
 * @returns 元素替身。
 * @author zhenghq
 */
function createElementStub(tagName = 'div'): ElementStub {
  const attributes = new Map<string, string>()
  const classes = new Set<string>()
  const element: ElementStub = {
    hidden: false,
    value: '',
    max: '',
    disabled: false,
    scrollTop: 0,
    scrollHeight: 2000,
    clientHeight: 600,
    textContent: '',
    dataset: {},
    style: { setProperty: () => undefined },
    classList: {
      add: (...names: string[]) => { for (const name of names) classes.add(name) },
      remove: (...names: string[]) => { for (const name of names) classes.delete(name) },
      contains: (name: string) => classes.has(name)
    },
    addEventListener: () => undefined,
    append: () => undefined,
    replaceChildren: () => undefined,
    setAttribute: (name: string, value: string) => { attributes.set(name, value) },
    removeAttribute: (name: string) => { attributes.delete(name) },
    getAttribute: (name: string) => attributes.get(name) ?? null,
    querySelector: <T>() => null as T | null,
    querySelectorAll: <T>() => [] as T[],
    getBoundingClientRect: () => ({ top: 0, bottom: 400, left: 0, right: 600, width: 600, height: 400 }),
    scrollIntoView: () => { const log = elementLogs.get(element); if (log) log.scrollIntoViewCount += 1 },
    scrollTo: (options) => {
      if (typeof options.top === 'number') element.scrollTop = options.top
      const log = elementLogs.get(element)
      if (log) log.scrollToTop = element.scrollTop
    },
    focus: () => undefined,
    contains: () => false
  }
  elementLogs.set(element, { scrollIntoViewCount: 0, scrollToTop: null })
  void tagName
  createdElements.push(element)
  return element
}

/**
 * 创建带尺寸与查询能力的滚动容器替身。
 * @param pages 容器内的页元素。
 * @returns 容器替身。
 * @author zhenghq
 */
function createContainerStub(
  pages: Array<{ selector: string; element: ElementStub; blocks: Map<string, ElementStub> }>
): ElementStub {
  const container = createElementStub('main')
  const queryCache = new Map<string, ElementStub | null>()
  container.querySelector = <T>(selector: string): T | null => {
    if (queryCache.has(selector)) return queryCache.get(selector) as T | null
    let result: ElementStub | null = null
    for (const page of pages) {
      if (page.selector === selector) {
        result = page.element
        break
      }
      const block = page.blocks.get(selector)
      if (block) {
        result = block
        break
      }
    }
    queryCache.set(selector, result)
    return result as T | null
  }
  container.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 600, width: 600, height: 600 })
  return container
}

/**
 * 创建用于控制器依赖的文本区块。
 * @param blockId 区块标识。
 * @param y 页面内纵向坐标。
 * @returns 文本区块。
 * @author zhenghq
 */
function textBlock(blockId: string, y: number): DocumentTextBlock {
  return {
    kind: 'text',
    blockId,
    readingOrder: 0,
    translatable: true,
    role: 'heading',
    bbox: { x: 0, y, width: 200, height: 20 },
    runs: [{ runId: `${blockId}-run`, text: blockId }]
  }
}

/**
 * 创建带原始页面几何信息的 PDF 文档模型。
 * @param blocks 页面区块。
 * @returns 文档模型。
 * @author zhenghq
 */
function pdfModel(blocks: DocumentTextBlock[]): DocumentModel {
  return {
    schemaVersion: 1,
    documentId: 'navigation-pdf',
    source: {
      path: '/tmp/navigation.pdf',
      fileName: 'navigation.pdf',
      format: 'pdf',
      sha256: 'navigation-sha',
      size: 1024
    },
    metadata: { direction: 'ltr' },
    pages: [{ pageId: 'page-1', index: 0, width: 600, height: 800, blocks }],
    assets: [],
    warnings: []
  }
}

/**
 * 允许测试在导入控制器前准备全局 DOM 替身。
 * @param elements 需要预先注册的固定元素。
 * @returns 无返回值。
 * @author zhenghq
 */
function installDomStub(elements: Map<string, ElementStub>): void {
  for (const [id, element] of elements) elementsById.set(id, element)
  const documentStub = {
    getElementById: (id: string): ElementStub => {
      const existing = elementsById.get(id)
      if (existing) return existing
      const created = createElementStub()
      elementsById.set(id, created)
      return created
    },
    createElement: (tagName: string): ElementStub => createElementStub(tagName),
    querySelector: (): ElementStub => createElementStub(),
    querySelectorAll: (): ElementStub[] => [],
    addEventListener: (): void => undefined
  }
  ;(globalThis as unknown as { document: unknown }).document = documentStub
  ;(globalThis as unknown as { CSS: unknown }).CSS = { escape: (value: string) => value }
  ;(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame =
    (callback: FrameRequestCallback) => { callback(0); return 0 }
  ;(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = () => undefined
}

test('PDF 原文页没有区块 DOM 时按模型几何偏移滚动到章节锚点', async () => {
  const sourcePage = createElementStub('article')
  sourcePage.getBoundingClientRect = () => ({ top: 100, bottom: 500, left: 0, right: 600, width: 600, height: 400 })
  const translationPage = createElementStub('article')
  const translationHeading = createElementStub('h2')
  const sourceContainer = createContainerStub([
    { selector: '.document-pdf-page[data-page-number="1"]', element: sourcePage, blocks: new Map() }
  ])
  const translationContainer = createContainerStub([{
    selector: '[data-page-id="page-1"]',
    element: translationPage,
    blocks: new Map([['[data-block-id="section-headed"]', translationHeading]])
  }])

  installDomStub(new Map())
  const { createDocumentNavigationController } = await import('../src/renderer/src/documentNavigationController.ts')
  const snapshot = { source: pdfModel([textBlock('section-headed', 160)]) } as unknown as DocumentWorkspaceSnapshot
  const controller = createDocumentNavigationController({
    t: (key: string) => key,
    getSnapshot: () => snapshot,
    getActiveDocumentTab: () => null,
    getCurrentPageNumber: () => 1,
    setCurrentPageNumber: () => undefined,
    setActiveBlockId: () => undefined,
    getViewMode: () => 'spread',
    getZoom: () => 1,
    setZoom: () => undefined,
    setFitZoom: () => undefined,
    stepZoom: () => undefined,
    scheduleStatePersist: () => undefined,
    getSourceContent: () => sourceContainer as unknown as HTMLElement,
    getTranslationContent: () => translationContainer as unknown as HTMLElement,
    getPageContentWidth: () => 600,
    getPageAvailableHeight: () => 600
  })

  const found = controller.scrollToTarget(
    { pageId: 'page-1', pageIndex: 0, pageNumber: 1, blockId: 'section-headed' },
    'instant'
  )

  assert.equal(found, true)
  // 页面顶部相对容器偏移 100px，加上按 400/800 比例换算的 160pt 锚点，共 180px。
  assert.equal(elementLogs.get(sourceContainer)?.scrollToTop, 180)
  assert.equal(elementLogs.get(translationHeading)?.scrollIntoViewCount, 1)
  assert.equal(createdElements.length > 0, true)
})

test('结构化页面缺少目标区块时回退滚动到页首', async () => {
  const page = createElementStub('article')
  page.getBoundingClientRect = () => ({ top: 20, bottom: 420, left: 0, right: 600, width: 600, height: 400 })
  const container = createContainerStub([
    { selector: '[data-page-id="page-1"]', element: page, blocks: new Map() }
  ])

  installDomStub(new Map())
  const { createDocumentNavigationController } = await import('../src/renderer/src/documentNavigationController.ts')
  const snapshot = { source: pdfModel([textBlock('missing-anchor', 100)]) } as unknown as DocumentWorkspaceSnapshot
  const controller = createDocumentNavigationController({
    t: (key: string) => key,
    getSnapshot: () => snapshot,
    getActiveDocumentTab: () => null,
    getCurrentPageNumber: () => 1,
    setCurrentPageNumber: () => undefined,
    setActiveBlockId: () => undefined,
    getViewMode: () => 'translation',
    getZoom: () => 1,
    setZoom: () => undefined,
    setFitZoom: () => undefined,
    stepZoom: () => undefined,
    scheduleStatePersist: () => undefined,
    getSourceContent: () => createContainerStub([]) as unknown as HTMLElement,
    getTranslationContent: () => container as unknown as HTMLElement,
    getPageContentWidth: () => 600,
    getPageAvailableHeight: () => 600
  })

  const found = controller.scrollToTarget(
    { pageId: 'page-1', pageIndex: 0, pageNumber: 1, blockId: 'unknown-block' },
    'instant'
  )

  assert.equal(found, true)
  assert.equal(elementLogs.get(page)?.scrollIntoViewCount, 1)
})

test('Markdown 等无分页预览没有页面容器时仍应滚动到区块锚点', async () => {
  const heading = createElementStub('h2')
  const container = createContainerStub([{
    selector: '[data-block-id="md-heading"]',
    element: heading,
    blocks: new Map([['[data-block-id="md-heading"]', heading]])
  }])

  installDomStub(new Map())
  const { createDocumentNavigationController } = await import('../src/renderer/src/documentNavigationController.ts')
  const markdownModel = pdfModel([textBlock('md-heading', 0)])
  markdownModel.source.format = 'markdown' as DocumentModel['source']['format']
  const snapshot = { source: markdownModel } as unknown as DocumentWorkspaceSnapshot
  const controller = createDocumentNavigationController({
    t: (key: string) => key,
    getSnapshot: () => snapshot,
    getActiveDocumentTab: () => null,
    getCurrentPageNumber: () => 1,
    setCurrentPageNumber: () => undefined,
    setActiveBlockId: () => undefined,
    getViewMode: () => 'source',
    getZoom: () => 1,
    setZoom: () => undefined,
    setFitZoom: () => undefined,
    stepZoom: () => undefined,
    scheduleStatePersist: () => undefined,
    getSourceContent: () => container as unknown as HTMLElement,
    getTranslationContent: () => createContainerStub([]) as unknown as HTMLElement,
    getPageContentWidth: () => 600,
    getPageAvailableHeight: () => 600
  })

  const found = controller.scrollToTarget(
    { pageId: 'page-1', pageIndex: 0, pageNumber: 1, blockId: 'md-heading' },
    'instant'
  )

  assert.equal(found, true)
  assert.equal(elementLogs.get(heading)?.scrollIntoViewCount, 1)
})
