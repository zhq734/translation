import { app, BrowserWindow, ipcMain } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const projectRoot = '/Users/mac/E/github/translation'
const documentHtml = join(projectRoot, 'out/renderer/document.html')
const preload = join(projectRoot, 'out/preload/index.js')
const samplePdf = readFileSync(join(projectRoot, 'tests/fixtures/document/sample.pdf'))
const windowWidth = Number(process.argv[2] ?? 1200)

function textBlock(id, text, y, style = {}) {
  return {
    blockId: id,
    readingOrder: y,
    translatable: true,
    bbox: { x: 72, y, width: 451, height: 72 },
    style: { fontFamily: 'Arial', fontSize: 12, lineHeight: 16, color: '#111111', ...style },
    kind: 'text',
    role: 'paragraph',
    textAlign: 'left',
    runs: [{ runId: `${id}-run`, text, style: { fontFamily: 'Arial', fontSize: 12, lineHeight: 16, color: '#111111', ...style } }]
  }
}

function model(text, tableText, pageCount = 1) {
  const pages = Array.from({ length: pageCount }, (_, index) => ({
    pageId: `page-${index + 1}`,
    index,
    width: 612,
    height: 792,
    contentArea: { left: 72, right: 523, center: 297.5 },
    blocks: [
      textBlock(`p${index + 1}-heading`, index === 0 ? 'Streaming translation stability check' : `Page ${index + 1}`, 72, { fontSize: 18, lineHeight: 22 }),
      textBlock(`p${index + 1}-body`, text, 180),
      {
        blockId: `p${index + 1}-table`,
        readingOrder: 2,
        translatable: true,
        bbox: { x: 72, y: 300, width: 451, height: 120 },
        kind: 'table',
        headerRows: 1,
        columnWidths: [225, 226],
        rows: [
          { rowId: 'r1', cells: [
            { cellId: 'c1', rowSpan: 1, colSpan: 1, blocks: [textBlock('th1', 'Header A', 300)] },
            { cellId: 'c2', rowSpan: 1, colSpan: 1, blocks: [textBlock('th2', 'Header B', 300)] }
          ] },
          { rowId: 'r2', cells: [
              { cellId: 'c3', rowSpan: 1, colSpan: 1, blocks: [textBlock('td1', tableText, 330)] },
            { cellId: 'c4', rowSpan: 1, colSpan: 1, blocks: [textBlock('td2', 'Value B', 330)] }
          ] }
        ]
      }
    ]
  }))
  return {
    schemaVersion: 1,
    documentId: 'visual-smoke',
    source: { path: '/tmp/sample.pdf', fileName: 'sample.pdf', format: 'pdf', sha256: 'visual-smoke', size: 1, pageCount },
    metadata: { title: 'Visual smoke', direction: 'ltr' },
    pages,
    assets: [],
    warnings: []
  }
}

function mixedPageModel(text) {
  const portrait = model(text, '横竖混排表格', 1)
  const landscapePage = model(text, '横版表格', 1).pages[0]
  landscapePage.pageId = 'page-2'
  landscapePage.index = 1
  landscapePage.width = 792
  landscapePage.height = 612
  landscapePage.contentArea = { left: 72, right: 703, center: 387.5 }
  for (const block of landscapePage.blocks) {
    if (!block.bbox) continue
    block.bbox.x = 72
    block.bbox.width = Math.min(block.bbox.width, 631)
    if (block.columnWidths) block.columnWidths = [315, 316]
  }
  return {
    ...portrait,
    documentId: 'mixed-page-visual-smoke',
    source: { ...portrait.source, sha256: 'mixed-page-visual-smoke', pageCount: 2 },
    pages: [portrait.pages[0], landscapePage]
  }
}

function singleShortPageModel(text) {
  const single = model(text, '短表格', 1)
  single.documentId = 'single-scrollbar-visual-smoke'
  single.source = { ...single.source, sha256: 'single-scrollbar-visual-smoke', pageCount: 1 }
  // 只保留标题和正文，确保首帧不溢出，随后正文流式增长后会出现纵向滚动条。
  single.pages[0].blocks = single.pages[0].blocks.slice(0, 2)
  return single
}

const settings = { themePreset: 'sky', themeMode: 'light', uiLocale: 'zh-CN', sourceLanguage: 'auto', targetLanguage: 'zh-CN' }
ipcMain.on('i18n:get-current-locale', (event) => { event.returnValue = 'zh-CN' })
ipcMain.on('app:get-win7-compatibility', (event) => { event.returnValue = false })
ipcMain.handle('settings:get', () => settings)
ipcMain.handle('document:get-platform-capability', () => ({ supported: true }))
ipcMain.handle('window:is-maximized', () => false)
ipcMain.handle('document:get-source', () => ({
  ok: true,
  mimeType: 'application/pdf',
  bytes: new Uint8Array(samplePdf)
}))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: windowWidth,
    height: 800,
    show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  await win.loadFile(documentHtml)
  await win.webContents.executeJavaScript(`new Promise((resolve) => {
    const deadline = Date.now() + 3000
    const wait = () => document.documentElement.hasAttribute('data-i18n-pending') && Date.now() < deadline
      ? setTimeout(wait, 25)
      : resolve(true)
    wait()
  })`)
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('document-workbench').hidden = false
    document.getElementById('document-upload-panel').hidden = true
    window.__visualProgress = []
    return true
  })()`)
  const generation = Number(await win.webContents.executeJavaScript(
    `sessionStorage.getItem('selection-translator.document-generation') ?? '0'`
  ))
  const scenario = process.argv[3] ?? 'mixed'
  const source = scenario === 'scrollbar' ? singleShortPageModel('原文内容') : mixedPageModel('原文内容')
  const translations = [
    '短译文',
    '短译文正在增长，页面宽度必须保持稳定。'.repeat(6),
    '短译文正在增长，页面宽度必须保持稳定。'.repeat(14),
    '短译文正在增长，页面宽度必须保持稳定。'.repeat(26),
    '短译文正在增长，页面宽度必须保持稳定。'.repeat(42),
    '短译文正在增长，页面宽度必须保持稳定。'.repeat(62),
    '短译文正在增长，页面宽度必须保持稳定。'.repeat(88)
  ]
  const results = []
  let previousNode = null
  for (let index = 0; index < translations.length; index += 1) {
    const snapshot = {
      jobId: 'visual-smoke',
      generation,
      task: {
        status: 'translating', phase: 'translate', phaseCompleted: false,
        progress: { completed: index + 1, total: translations.length, failed: 0 },
        failedBlocks: 0, warningCount: 0
      },
      percent: Math.round(((index + 1) / translations.length) * 100),
      source,
    translation: scenario === 'scrollbar'
      ? singleShortPageModel(translations[index])
      : mixedPageModel(translations[index])
    }
    // 从主进程推送真实 IPC，确保走 preload 暴露的生产监听链路。
    win.webContents.send('document:progress', snapshot)
    const frames = await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const samples = []
      const deadline = performance.now() + 420
      const collect = () => {
        const translation = document.getElementById('document-translation-content')
        const source = document.getElementById('document-source-content')
        const page = translation?.querySelector('.document-page')
        const pages = Array.from(translation?.querySelectorAll('.document-page') ?? [])
        const table = page?.querySelector('[data-block-id="p1-table"]')
        const body = page?.querySelector('[data-block-id="p1-body"] .document-text-run')
        const tableCell = page?.querySelector('[data-block-id="td1"] .document-text-run')
        const sourceArticle = source?.querySelector('.document-pdf-page')
        const sourceCanvas = source?.querySelector('.document-pdf-canvas')
        const sample = {
          time: performance.now(),
          translationClientWidth: translation?.clientWidth ?? null,
          translationClientHeight: translation?.clientHeight ?? null,
          translationScrollWidth: translation?.scrollWidth ?? null,
          translationScrollHeight: translation?.scrollHeight ?? null,
          pageWidths: pages.map((item) => item.getBoundingClientRect().width),
          pageNodeIds: pages.map((item, pageIndex) => {
            item.__visualPageIndex = pageIndex
            return item.__visualPageId ?? (item.__visualPageId = 'page-node-' + pageIndex)
          }),
          scales: pages.map((item) => item.style.getPropertyValue('--document-page-scale')),
          pageNodeStates: pages.map((item) => item.__visualPageNode === item ? 'same' : (item.__visualPageNode = item, 'new')),
          tableNodeState: table ? (window.__visualTableNode === table ? 'same' : (window.__visualTableNode = table, 'new')) : 'missing',
          translationScrollTop: translation?.scrollTop ?? null,
          translationHasVerticalOverflow: translation ? translation.scrollHeight > translation.clientHeight : null,
          tableWidth: table?.getBoundingClientRect().width ?? null,
          tableHeight: table?.getBoundingClientRect().height ?? null,
          sourcePageWidth: sourceArticle?.getBoundingClientRect().width ?? null,
          sourceCanvasWidth: sourceCanvas?.getBoundingClientRect().width ?? null,
          sourceRendered: sourceArticle?.dataset.pdfRendered ?? null,
          bodyText: body?.textContent ?? '',
          tableCellText: tableCell?.textContent ?? ''
        }
        // 同一绘制帧内再采样一次，能发现先触发布局、随后被 ResizeObserver 修正的尺寸抖动。
        requestAnimationFrame(() => samples.push({ ...sample, phase: 'paint' }))
        sample.phase = 'layout'
        samples.push(sample)
        if (performance.now() < deadline) requestAnimationFrame(collect)
        else resolve(samples)
      }
      requestAnimationFrame(collect)
    })`)
    const first = frames[0]
    const unique = (key) => [...new Set(frames.map((frame) => JSON.stringify(frame[key])))]
    results.push({
      frameCount: frames.length,
      translationClientWidths: unique('translationClientWidth'),
      translationClientHeights: unique('translationClientHeight'),
      translationScrollWidths: unique('translationScrollWidth'),
      translationScrollHeights: unique('translationScrollHeight'),
      translationScrollTops: unique('translationScrollTop'),
      translationHasVerticalOverflows: unique('translationHasVerticalOverflow'),
      pageWidths: unique('pageWidths'),
      scales: unique('scales'),
      pageNodeStates: unique('pageNodeStates'),
      pageNodeIds: unique('pageNodeIds'),
      tableNodeStates: unique('tableNodeState'),
      tableWidths: unique('tableWidth'),
      tableHeights: unique('tableHeight'),
      sourcePageWidths: unique('sourcePageWidth'),
      sourceCanvasWidths: unique('sourceCanvasWidth'),
      sourceRenderedStates: unique('sourceRendered'),
      bodyTexts: unique('bodyText'),
      tableCellTexts: unique('tableCellText'),
      first
    })
    previousNode = first?.pageNodeStates?.join(',') ?? 'missing'
  }
  console.log(JSON.stringify({ scenario, results, finalNodeState: previousNode }, null, 2))
  win.destroy()
  app.quit()
}).catch((error) => { console.error(error); app.exit(1) })
