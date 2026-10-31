import { app, BrowserWindow, ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = '/Users/mac/E/github/translation'
const imagePath = '/private/tmp/translation-ocr-verify/screenshot-1.png'
const markdownPath = '/tmp/restore-smoke.md'
const pdfPath = '/Users/mac/Downloads/用户中心-20261012.pdf'
const pdfModel = JSON.parse(readFileSync('/tmp/user-center-model.json', 'utf8'))
const imageBytes = readFileSync(imagePath)
const markdownBytes = Buffer.from([
  '# Restored Markdown',
  '',
  '> Restored quote',
  '',
  '- First item',
  '- Second item',
  '',
  '```ts',
  'const restored = true',
  '```',
  ''
].join('\n'))
writeFileSync(markdownPath, markdownBytes)

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const imageSha = sha256(imageBytes)
const markdownSha = sha256(markdownBytes)
const pdfBytes = readFileSync(pdfPath)
const pdfSha = sha256(pdfBytes)

const text = (blockId, value, role = 'paragraph') => ({
  blockId,
  kind: 'text',
  role,
  readingOrder: 0,
  translatable: true,
  runs: [{ runId: `${blockId}-run`, text: value }]
})

const imageModel = (translated) => ({
  schemaVersion: 1,
  documentId: 'restore-smoke-image',
  source: {
    path: imagePath,
    fileName: 'screenshot-1.png',
    format: 'image',
    sha256: imageSha,
    size: imageBytes.byteLength,
    pageCount: 1
  },
  metadata: { direction: 'ltr' },
  pages: [{
    pageId: 'image-page-1',
    index: 0,
    width: 1750,
    height: 980,
    blocks: [{
      blockId: 'image-1',
      kind: 'image',
      readingOrder: 0,
      translatable: false,
      bbox: { x: 0, y: 0, width: 1750, height: 980 },
      assetId: 'image-1',
      alt: translated ? '图片译文' : '图片原文',
      renderPending: true
    }]
  }],
  assets: [{
    assetId: 'image-1',
    kind: 'image',
    mimeType: 'image/png',
    sha256: imageSha,
    byteLength: imageBytes.byteLength,
    width: 1750,
    height: 980
  }],
  warnings: []
})

const markdownModel = (translated) => ({
  schemaVersion: 1,
  documentId: 'restore-smoke-markdown',
  source: {
    path: markdownPath,
    fileName: 'restore-smoke.md',
    format: 'markdown',
    sha256: markdownSha,
    size: markdownBytes.byteLength,
    pageCount: 1
  },
  metadata: { direction: 'ltr' },
  pages: [{
    pageId: 'markdown-page-1',
    index: 0,
    width: 800,
    height: 600,
    blocks: [
      text('md-heading', translated ? '恢复的 Markdown' : 'Restored Markdown', 'heading'),
      text('md-quote', translated ? '恢复的引用' : 'Restored quote', 'quote'),
      {
        ...text('md-list-1', translated ? '第一项' : 'First item', 'list-item'),
        list: { level: 0, marker: '-', ordered: false }
      },
      {
        ...text('md-list-2', translated ? '第二项' : 'Second item', 'list-item'),
        list: { level: 0, marker: '-', ordered: false }
      },
      text('md-code', translated ? 'const restored = true' : 'const restored = true', 'code')
    ]
  }],
  assets: [],
  warnings: []
})

const pdfTranslation = structuredClone(pdfModel)
for (const page of pdfTranslation.pages) {
  for (const block of page.blocks) {
    if (block.kind === 'text') {
      block.runs.forEach((run, index) => { run.text = index === 0 ? `译文：${run.text}` : '' })
    }
    if (block.kind === 'table') {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          for (const child of cell.blocks) {
            if (child.kind === 'text') {
              // 模拟真实翻译管线：完整译文写回首个 run，其余参与 run 清空。
              child.runs.forEach((run, index) => {
                run.text = index === 0 ? `译文：${child.runs.map((candidate) => candidate.text).join('')}` : ''
              })
            }
          }
        }
      }
    }
  }
}

const imageTab = {
  id: 'saved-image-tab',
  selection: {
    path: imagePath,
    name: 'screenshot-1.png',
    size: imageBytes.byteLength,
    format: 'image',
    sha256: imageSha
  },
  sourceLang: 'auto',
  targetLang: 'zh-CN',
  viewMode: 'spread',
  zoom: 1,
  scroll: { source: 0, translation: 0 },
  scrollSyncEnabled: true,
  pageNumber: 1,
  ocrDisplayMode: 'translation',
  activePageId: 'image-page-1',
  activeBlockId: null,
  source: imageModel(false),
  translation: imageModel(true)
}

const markdownTab = {
  id: 'saved-markdown-tab',
  selection: {
    path: markdownPath,
    name: 'restore-smoke.md',
    size: markdownBytes.byteLength,
    format: 'markdown',
    sha256: markdownSha
  },
  sourceLang: 'en',
  targetLang: 'zh-CN',
  viewMode: 'spread',
  zoom: 1,
  scroll: { source: 0, translation: 0 },
  scrollSyncEnabled: true,
  pageNumber: 1,
  ocrDisplayMode: 'translation',
  activePageId: 'markdown-page-1',
  activeBlockId: null,
  source: markdownModel(false),
  translation: markdownModel(true)
}

const pdfTab = {
  id: 'saved-pdf-tab',
  selection: {
    path: pdfPath,
    name: '用户中心-20261012.pdf',
    size: pdfBytes.byteLength,
    format: 'pdf',
    sha256: pdfSha
  },
  sourceLang: 'zh-CN',
  targetLang: 'en',
  viewMode: 'spread',
  zoom: 1,
  scroll: { source: 0, translation: 0 },
  scrollSyncEnabled: true,
  pageNumber: 1,
  ocrDisplayMode: 'translation',
  activePageId: pdfModel.pages[0].pageId,
  activeBlockId: null,
  source: pdfModel,
  translation: pdfTranslation
}

const viewerState = {
  version: 3,
  activeTabId: markdownTab.id,
  tabs: [imageTab, markdownTab, pdfTab]
}

const settings = {
  themePreset: 'sakura',
  themeMode: 'light',
  uiLocale: 'zh-CN',
  sourceLang: 'auto',
  targetLang: 'zh-CN',
  documentTranslationEnabled: true
}

const selectionFor = (path) => {
  if (path === imagePath) {
    return {
      status: 'selected', path: imagePath, fileName: 'screenshot-1.png',
      size: imageBytes.byteLength, format: 'image', sha256: imageSha,
      capabilities: { nativeLayout: true, ocrPageImages: true, ocrEmbeddedImages: false, preserveStyles: false, exportPdf: true }
    }
  }
  if (path === markdownPath) {
    return {
      status: 'selected', path: markdownPath, fileName: 'restore-smoke.md',
      size: markdownBytes.byteLength, format: 'markdown', sha256: markdownSha,
      capabilities: { nativeLayout: false, ocrPageImages: false, ocrEmbeddedImages: false, preserveStyles: false, exportPdf: true }
    }
  }
  if (path === pdfPath) {
    return {
      status: 'selected', path: pdfPath, fileName: '用户中心-20261012.pdf',
      size: pdfBytes.byteLength, format: 'pdf', sha256: pdfSha,
      capabilities: { nativeLayout: true, ocrPageImages: true, ocrEmbeddedImages: true, preserveStyles: true, exportPdf: true }
    }
  }
  return { status: 'rejected', code: 'unreadable' }
}

ipcMain.on('i18n:get-current-locale', (event) => { event.returnValue = 'zh-CN' })
ipcMain.on('app:get-win7-compatibility', (event) => { event.returnValue = false })
ipcMain.handle('settings:get', () => settings)
ipcMain.handle('document:get-platform-capability', () => ({ supported: true }))
ipcMain.handle('window:is-maximized', () => false)
ipcMain.handle('document:list-history', () => [])
ipcMain.handle('document:approve-file', (_event, path) => selectionFor(path))
ipcMain.handle('document:approve-files', (_event, paths) => paths.map(selectionFor))
ipcMain.handle('document:get-approved-source', (_event, request) => {
  if (request.path === pdfPath) {
    return { ok: true, mimeType: 'application/pdf', bytes: new Uint8Array(pdfBytes) }
  }
  if (request.path === imagePath) {
    return { ok: true, mimeType: 'image/png', bytes: new Uint8Array(imageBytes) }
  }
  if (request.path === markdownPath) {
    return { ok: true, mimeType: 'text/markdown', bytes: new Uint8Array(markdownBytes) }
  }
  return { ok: false, code: 'source-not-approved' }
})
ipcMain.handle('document:get-approved-asset', (_event, request) => {
  if (request.path === imagePath && request.assetId === 'image-1') {
    return { ok: true, mimeType: 'image/png', bytes: new Uint8Array(imageBytes) }
  }
  if (request.path === pdfPath) {
    // 冒烟脚本只验证恢复后的 DOM 资源链路；真实 PDF 资源重解析由单元测试覆盖。
    return { ok: true, mimeType: 'image/png', bytes: new Uint8Array(imageBytes) }
  }
  return { ok: false, code: 'asset-not-found' }
})

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1800,
    height: 1000,
    show: false,
    webPreferences: {
      preload: join(root, 'out/preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.error(`[renderer:${level}] ${message} (${sourceId}:${line})`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('render-process-gone', details)
  })
  await win.loadFile(join(root, 'out/renderer/document.html'))
  await win.webContents.executeJavaScript(`localStorage.setItem('selection-translator.document-viewer-state', ${JSON.stringify(JSON.stringify(viewerState))}); true`)
  await win.reload()
  await win.webContents.executeJavaScript(`new Promise((resolve) => {
    const deadline = Date.now() + 8000
    const wait = () => {
      const tabs = document.querySelectorAll('.document-file-tab')
      if (tabs.length === 3 && document.getElementById('document-workbench')?.hidden === false) return resolve(true)
      if (Date.now() >= deadline) return resolve(false)
      setTimeout(wait, 50)
    }
    wait()
  })`).then((ready) => { if (!ready) throw new Error('恢复工作台未就绪') })
  await new Promise((resolve) => setTimeout(resolve, 1800))

  const collect = () => win.webContents.executeJavaScript(`(() => {
    const tabs = Array.from(document.querySelectorAll('.document-file-tab')).map((tab) => ({
      id: tab.dataset.tabId,
      name: tab.querySelector('.document-file-tab-label')?.textContent,
      selected: tab.getAttribute('aria-selected')
    }))
    const activeTab = document.querySelector('.document-file-tab[aria-selected="true"]')
    const source = document.getElementById('document-source-content')
    const translation = document.getElementById('document-translation-content')
    const image = translation?.querySelector('.document-page-image')
    const imageBlock = translation?.querySelector('.document-image-block')
    const markdown = translation?.querySelector('.document-markdown-preview')
    const markdownStyle = markdown ? getComputedStyle(markdown) : null
    const labels = []
    if (translation) {
      const walker = document.createTreeWalker(translation, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const value = walker.currentNode.nodeValue?.trim()
        if (value && /重试此块|OCR|缓存|重试/u.test(value)) labels.push(value)
      }
    }
    const table = translation?.querySelector('.document-table-block table')
    const measureTable = () => {
      if (!table) return null
      const cells = Array.from(table.querySelectorAll('th, td')).map((cell) => {
        const run = cell.querySelector('.document-text-run')
        let lineBoxes = 0
        if (run?.firstChild) {
          const range = document.createRange()
          range.selectNodeContents(run.firstChild)
          lineBoxes = range.getClientRects().length
        }
        return {
          text: cell.textContent,
          width: cell.getBoundingClientRect().width,
          height: cell.getBoundingClientRect().height,
          lineBoxes
        }
      })
      return {
        tableLayout: getComputedStyle(table).tableLayout,
        tableWidth: table.getBoundingClientRect().width,
        cells
      }
    }
    const targetCell = Array.from(translation?.querySelectorAll('td') ?? []).find((cell) => cell.textContent?.includes('2026R11L3505485'))
    const targetRun = targetCell?.querySelector('.document-text-run')
    const cellStyle = targetCell ? getComputedStyle(targetCell) : null
    const runStyle = targetRun ? getComputedStyle(targetRun) : null
    return {
      tabs,
      activeTab: activeTab?.dataset.tabId,
      workbenchName: document.getElementById('document-workbench-name')?.textContent,
      source: {
        previewKind: source?.dataset.previewKind,
        text: source?.textContent?.slice(0, 300),
        markdown: Boolean(source?.querySelector('.document-markdown-preview')),
        image: Boolean(source?.querySelector('.document-page-image'))
      },
      translation: {
        previewKind: translation?.dataset.previewKind,
        text: translation?.textContent?.slice(0, 500),
        markdown: Boolean(markdown),
        markdownChildren: markdown ? Array.from(markdown.children).map((el) => ({ tag: el.tagName, text: el.textContent })) : [],
        markdownStyle: markdownStyle ? {
          display: markdownStyle.display,
          padding: markdownStyle.padding,
          color: markdownStyle.color,
          background: markdownStyle.backgroundColor
        } : null,
        imageBlock: imageBlock ? {
          pending: imageBlock.dataset.pending,
          assetState: imageBlock.dataset.assetState,
          placeholder: imageBlock.querySelector('.document-image-placeholder')?.textContent,
          rect: imageBlock.getBoundingClientRect().toJSON()
        } : null,
        image: image ? {
          complete: image.complete,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          src: image.src.slice(0, 30)
        } : null,
        table: table ? {
          rect: table.getBoundingClientRect().toJSON(),
          width: table.getBoundingClientRect().width
        } : null,
        targetCell: targetCell ? {
          text: targetCell.textContent,
          rect: targetCell.getBoundingClientRect().toJSON(),
          clientWidth: targetCell.clientWidth,
          scrollWidth: targetCell.scrollWidth,
          paddingLeft: cellStyle.paddingLeft,
          paddingRight: cellStyle.paddingRight,
          borderLeft: cellStyle.borderLeftWidth,
          borderRight: cellStyle.borderRightWidth
        } : null,
        targetRun: targetRun ? {
          text: targetRun.textContent,
          rect: targetRun.getBoundingClientRect().toJSON(),
          whiteSpace: runStyle.whiteSpace,
          wordBreak: runStyle.wordBreak,
          overflowWrap: runStyle.overflowWrap,
          clientWidth: targetRun.clientWidth,
          scrollWidth: targetRun.scrollWidth,
          clientHeight: targetRun.clientHeight,
          scrollHeight: targetRun.scrollHeight
        } : null,
        labels
      }
    }
  })()`)

  const initial = await collect()
  const clickProbe = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector('[data-tab-id="document-tab-1"]')
    const before = document.querySelector('.document-file-tab[aria-selected="true"]')?.dataset.tabId
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return {
      before,
      targetExists: Boolean(target),
      targetClass: target?.className,
      afterSync: document.querySelector('.document-file-tab[aria-selected="true"]')?.dataset.tabId,
      apiKeys: Object.keys(window.api ?? {}).filter((key) => key.toLowerCase().includes('document')).sort()
    }
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 1800))
  const afterProbe = await collect()
  const snapshots = { initial, tabs: [] }
  for (const savedTabId of ['saved-image-tab', 'saved-markdown-tab', 'saved-pdf-tab']) {
    const tabId = await win.webContents.executeJavaScript(`(() => {
      const index = ${JSON.stringify(['saved-image-tab', 'saved-markdown-tab', 'saved-pdf-tab'])}.indexOf(${JSON.stringify(savedTabId)})
      return document.querySelectorAll('.document-file-tab')[index]?.dataset.tabId ?? ''
    })()`)
    await win.webContents.executeJavaScript(`document.querySelector('[data-tab-id="${tabId}"]')?.click(); true`)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    snapshots.tabs.push({ savedTabId, tabId, state: await collect() })
  }
  const tableLayoutProbe = await win.webContents.executeJavaScript(`(() => {
    const translation = document.querySelector('#document-translation-content')
    const page = translation?.querySelector(".document-page[data-layout='translation-flow']")
    const wrapper = Array.from(translation?.querySelectorAll('.document-table-block') ?? [])
      .sort((left, right) => right.getBoundingClientRect().width - left.getBoundingClientRect().width)[0]
    const table = wrapper?.querySelector('table')
    if (!translation || !page || !wrapper || !table) return null
    const countLineBoxes = (element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const tops = Array.from(range.getClientRects())
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => Math.round(rect.top * 10) / 10)
      return new Set(tops).size
    }
    const measure = () => Array.from(table.querySelectorAll('th, td')).map((cell) => {
      const run = cell.querySelector('.document-text-run')
      return {
        text: cell.textContent,
        width: Math.round(cell.getBoundingClientRect().width * 100) / 100,
        height: Math.round(cell.getBoundingClientRect().height * 100) / 100,
        lineBoxes: countLineBoxes(cell),
        textLineBoxes: run ? countLineBoxes(run) : 0,
        runWidth: Math.round((run?.getBoundingClientRect().width ?? 0) * 100) / 100,
        runHeight: Math.round((run?.getBoundingClientRect().height ?? 0) * 100) / 100,
        fontSize: run ? getComputedStyle(run).fontSize : null,
        whiteSpace: run ? getComputedStyle(run).whiteSpace : null
      }
    })
    const geometry = () => ({
      paneWidth: Math.round(translation.getBoundingClientRect().width * 100) / 100,
      pageWidth: Math.round(page.getBoundingClientRect().width * 100) / 100,
      wrapperWidth: Math.round(wrapper.getBoundingClientRect().width * 100) / 100,
      wrapperLeft: Math.round((wrapper.getBoundingClientRect().left - page.getBoundingClientRect().left) * 100) / 100,
      tableWidth: Math.round(table.getBoundingClientRect().width * 100) / 100,
      pageRightSpace: Math.round((page.getBoundingClientRect().right - wrapper.getBoundingClientRect().right) * 100) / 100
    })
    const originalColumns = Array.from(table.querySelectorAll('col')).map((column) => column.style.width)
    const before = { layout: getComputedStyle(table).tableLayout, geometry: geometry(), cells: measure() }
    const setWhiteSpace = (value) => {
      for (const element of table.querySelectorAll('.document-text-block, .document-text-run')) {
        element.style.whiteSpace = value
      }
      return { whiteSpace: value, cells: measure() }
    }
    const preLine = setWhiteSpace('pre-line')
    const normal = setWhiteSpace('normal')
    const resetWhiteSpace = setWhiteSpace('pre-wrap')
    table.style.tableLayout = 'auto'
    const auto = { layout: getComputedStyle(table).tableLayout, geometry: geometry(), cells: measure() }
    wrapper.style.setProperty('width', '100%', 'important')
    wrapper.style.marginLeft = '0'
    const fullWidthAuto = { layout: getComputedStyle(table).tableLayout, geometry: geometry(), cells: measure() }
    table.querySelector('colgroup')?.remove()
    const noColumnsAuto = { layout: getComputedStyle(table).tableLayout, geometry: geometry(), cells: measure() }
    table.style.tableLayout = 'fixed'
    const noColumnsFixed = { layout: getComputedStyle(table).tableLayout, geometry: geometry(), cells: measure() }
    wrapper.style.setProperty('width', '100%', 'important')
    table.style.tableLayout = 'auto'
    const noColumnsFullWidthAuto = { layout: getComputedStyle(table).tableLayout, geometry: geometry(), cells: measure() }
    table.style.tableLayout = 'fixed'
    const noColumnsFullWidthFixed = { layout: getComputedStyle(table).tableLayout, geometry: geometry(), cells: measure() }
    return { originalColumns, before, preLine, normal, resetWhiteSpace, auto, fullWidthAuto, noColumnsAuto, noColumnsFixed, noColumnsFullWidthAuto, noColumnsFullWidthFixed }
  })()`)
  const image = await win.webContents.capturePage()
  writeFileSync('/tmp/restore-multi-tab-smoke.png', image.toPNG())
  console.log(JSON.stringify({ clickProbe, afterProbe, ...snapshots, tableLayoutProbe }, null, 2))
  win.destroy()
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
