import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { parseMarkdownDocument } from '../src/main/documentTextParser.ts'
import {
  occupiesDocumentTranslationFlow,
  rangesOverlapHorizontally,
  resolveTranslationImageFlowGap,
  resolveTranslationFlowDecorationTop,
  resolveTranslationFlowGroupGeometry,
  resolveTranslationWatermarkHorizontalOffset,
  resolveTranslationTableColumnWidths
} from '../src/renderer/src/documentPdfLayout.ts'
import type { DocumentBlock } from '../src/shared/documentTypes.ts'

/**
 * 读取项目内文本文件。
 * @param path 相对项目根目录的路径。
 * @returns 文件文本。
 * @author zhenghq
 */
function read(path: string): string {
  return readFileSync(path, 'utf8')
}

test('文档翻译必须使用独立入口并由构建配置注册', () => {
  assert.equal(existsSync('src/renderer/document.html'), true)
  assert.equal(existsSync('src/renderer/src/document.ts'), true)
  assert.equal(existsSync('src/renderer/src/document.css'), true)
  assert.match(read('electron.vite.config.ts'), /document:\s*resolve\('src\/renderer\/document\.html'\)/u)
  const html = read('src/renderer/document.html')
  assert.match(html, /<script src="\.\/localeBootstrap\.js"><\/script>/u)
  assert.match(html, /<script src="\.\/themeBootstrap\.js"><\/script>/u)
  assert.match(html, /src\/theme\.css/u)
  assert.match(html, /src\/base\.css/u)
  assert.match(html, /src\/document\.css/u)
})

test('文档工作台必须移除旧模式页签并提供多文件上传入口', () => {
  const html = read('src/renderer/document.html')
  const source = read('src/renderer/src/document.ts')
  assert.match(html, /id="document-file-tabs"[^>]*role="tablist"/u)
  assert.doesNotMatch(html, /id="document-tab-single"/u)
  assert.doesNotMatch(html, /id="document-tab-batch"/u)
  assert.doesNotMatch(html, /id="document-batch-panel"/u)
  assert.doesNotMatch(source, /runDocumentBatch\(/u)
  assert.doesNotMatch(source, /exportDocumentBatchItem\(/u)
  assert.match(source, /selectDocumentFiles\(\)/u)
  assert.match(html, /id="document-drop-zone"/u)
  assert.match(html, /id="document-file-input"[^>]*type="file"[^>]*multiple[^>]*accept=/u)
  assert.match(html, /id="document-start-button"[^>]*disabled/u)
  assert.match(html, /data-i18n="document\.upload\.dropHint"/u)
  assert.match(html, /data-i18n="document\.upload\.formats"/u)
  assert.match(html, /data-i18n="document\.upload\.privacy"/u)
  assert.match(html, /id="document-history-button"/u)
  assert.match(html, /id="document-workbench-replace"[^>]*data-i18n="document\.upload\.addFiles"/u)
  assert.match(source, /documentWorkbenchReplaceButton\.addEventListener\('click'/u)
  assert.match(source, /async function addDocumentFilesFromWorkbench\(/u)
  assert.match(source, /async function createDocumentTab\(/u)
  assert.match(source, /async function activateDocumentTab\(/u)
  assert.match(source, /async function closeDocumentTab\(/u)
})

test('多文件选择必须一次创建独立 Tab，并由主进程按任务隔离授权与资源', () => {
  const source = read('src/renderer/src/document.ts')
  const types = read('src/shared/types.ts')
  const preload = read('src/preload/index.ts')
  const main = read('src/main/index.ts')
  const selectStart = main.indexOf("ipcMain.handle('document:select-files'")
  const selectEnd = main.indexOf('/**', selectStart + 1)
  const selectSource = main.slice(selectStart, selectEnd)

  assert.ok(selectStart > -1)
  assert.match(source, /const results = await window\.api\.selectDocumentFiles\(\)/u)
  assert.match(source, /for \(const result of results\)[\s\S]*?createDocumentTab\(/u)
  assert.match(types, /selectDocumentFiles\(\): Promise<DocumentFileSelectionResult\[\]>/u)
  assert.match(preload, /ipcRenderer\.invoke\('document:select-files'\)/u)
  assert.match(selectSource, /properties: \['openFile', 'multiSelections'\]/u)
  assert.match(selectSource, /Promise\.allSettled/u)
  assert.match(selectSource, /approvedDocumentPaths\.add/u)
  assert.doesNotMatch(selectSource, /approvedDocumentPaths\.clear/u)
  assert.match(main, /const documentWorkspaceTaskServices = new Map<string, DocumentWorkspaceTaskService>\(\)/u)
  assert.match(
    main,
    /service\.run\(normalizedRequest, \(jobId\) => \{\s*acceptedJobId = jobId\s*documentWorkspaceTaskServices\.set\(jobId, service\)/u,
    '任务服务必须在首条进度发出前通过接受回调同步登记'
  )
  assert.match(
    main,
    /documentWorkspaceTaskServices\.get\(acceptedJobId\) === service[\s\S]*?documentWorkspaceTaskServices\.delete\(acceptedJobId\)/u,
    '任务启动异常时必须移除已经登记的服务，避免残留不可达资源'
  )
  assert.match(main, /documentWorkspaceTaskServices\.get\(jobId\)/u)
  assert.match(main, /ipcMain\.handle\('document:release'/u)
  assert.match(types, /retryFailedDocument\(jobId: string, generation: number\)/u)
  assert.match(types, /getDocumentAsset\(jobId: string, assetId: string\)/u)
  assert.match(types, /getDocumentSource\(jobId: string\)/u)
  assert.match(types, /releaseDocumentJob\(jobId: string\)/u)
})

test('多 Tab 栏必须使用主题变量、横向滚动并支持逐个关闭', () => {
  const html = read('src/renderer/document.html')
  const css = read('src/renderer/src/document.css')
  const source = read('src/renderer/src/document.ts')
  const zh = read('src/shared/i18n/catalog.zh-CN.document.ts')
  const en = read('src/shared/i18n/catalog.en-US.document.ts')

  assert.match(css, /\.document-file-tabs\s*\{[^}]*display:\s*flex[^}]*min-width:\s*0[^}]*overflow-x:\s*auto/su)
  assert.match(css, /\.document-file-tab\s*\{[^}]*min-width:\s*0/su)
  assert.match(css, /\.document-file-tab-close\s*\{/u)
  assert.doesNotMatch(css, /\.document-batch-panel/u)
  assert.match(source, /aria-label',\s*t\('document\.tab\.close', \{ name: tab\.selection\.name \}\)/u)
  assert.match(source, /documentWorkspaceTabs\.replaceChildren\(\)/u)
  assert.match(zh, /'document\.upload\.addFiles'/u)
  assert.match(zh, /'document\.tab\.close'/u)
  assert.match(zh, /'document\.files\.invalid'/u)
  assert.match(en, /'document\.upload\.addFiles'/u)
  assert.match(en, /'document\.tab\.close'/u)
  assert.match(en, /'document\.files\.invalid'/u)
})

test('文档翻译顶部两栏必须分层排布并在多文件时保持文件标签可读', () => {
  const html = read('src/renderer/document.html')
  const css = read('src/renderer/src/document.css')
  const toolbar = /<nav class="document-toolbar"[\s\S]*?<\/nav>/u.exec(html)?.[0] ?? ''
  const workbenchHeader = /<div class="document-workbench-header">([\s\S]*?)<div class="document-columns"/u.exec(html)?.[1] ?? ''
  const progressPanel = /<footer id="document-progress-panel"[\s\S]*?<\/footer>/u.exec(html)?.[0] ?? ''

  // 顶部第一栏拆成文件导航主行与语言状态次行，文件 Tab 不再和语言控件争抢宽度。
  assert.match(toolbar, /class="document-toolbar-main"[\s\S]*id="document-file-tabs"[\s\S]*class="document-toolbar-actions"/u)
  assert.match(toolbar, /class="document-toolbar-meta"[\s\S]*class="document-language-controls"[\s\S]*class="document-toolbar-display-controls"[\s\S]*id="document-source-ocr-mode"[\s\S]*id="document-view-mode"[\s\S]*id="document-actual-language"/u)
  assert.match(css, /\.document-toolbar\s*\{[^}]*display:\s*grid[^}]*min-width:\s*0/su)
  assert.match(css, /\.document-toolbar-main\s*\{[^}]*display:\s*flex[^}]*min-width:\s*0/su)
  assert.match(css, /\.document-toolbar-meta\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap[^}]*min-width:\s*0/su)
  assert.match(css, /\.document-toolbar-display-controls\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/su)
  assert.match(css, /\.document-file-tabs\s*\{[^}]*flex:\s*1 1 0[^}]*overflow-x:\s*auto/su)
  assert.match(css, /\.document-file-tab\s*\{[^}]*flex:\s*0 0 clamp\(/su)

  // 工作台头部只保留文件信息与操作，显示模式和结果状态分别归入语言栏与底部进度栏。
  assert.match(workbenchHeader, /class="document-workbench-primary"[\s\S]*class="document-file-identity"[\s\S]*class="document-workbench-actions"/u)
  assert.doesNotMatch(workbenchHeader, /id="document-source-ocr-mode"|id="document-view-mode"|id="document-partial-status"/u)
  assert.match(progressPanel, /class="document-progress-copy"[\s\S]*id="document-partial-status"[\s\S]*class="document-progress-track"/u)
  assert.match(css, /\.document-workbench-header\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/su)
  assert.match(css, /\.document-workbench-primary\s*\{[^}]*display:\s*flex[^}]*min-width:\s*0/su)
  assert.match(css, /\.document-progress-copy\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/su)
  assert.match(css, /\.document-partial-status\s*\{[^}]*text-align:\s*right/su)
})

test('文件翻译历史必须提供可搜索下拉列表并支持快速切换', () => {
  const html = read('src/renderer/document.html')
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const zh = read('src/shared/i18n/catalog.zh-CN.document.ts')
  const en = read('src/shared/i18n/catalog.en-US.document.ts')

  assert.match(html, /id="document-history-button"[^>]*aria-haspopup="listbox"[^>]*aria-expanded="false"[^>]*aria-controls="document-history-popover"/u)
  assert.match(html, /id="document-history-popover"[^>]*hidden/u)
  assert.match(html, /id="document-history-search"[^>]*type="search"[^>]*role="searchbox"/u)
  assert.match(html, /id="document-history-list"[^>]*role="listbox"/u)
  assert.match(html, /id="document-history-empty"[^>]*role="status"/u)
  assert.match(source, /normalizeDocumentFileHistory/u)
  assert.match(source, /recordDocumentFileHistory/u)
  assert.match(source, /filterDocumentFileHistory/u)
  assert.match(source, /window\.api\.approveDocumentFile\(entry\.path\)/u)
  assert.match(source, /let documentHistorySwitchInFlight = false/u)
  assert.match(source, /historyButton\.addEventListener\('click'/u)
  assert.match(source, /documentHistorySearch\.addEventListener\('input'/u)
  assert.match(source, /const existingTab = findDocumentTabByPath\(entry\.path\)/u)
  assert.match(source, /await activateDocumentTab\(existingTab\.id\)/u)
  assert.match(source, /await createDocumentTab\(result, \{ activate: true, start: false \}\)/u)
  assert.match(source, /await startDocumentTabTranslation\(tab\)/u)
  assert.match(source, /event\.key === 'Enter'[\s\S]*visibleDocumentHistory\[0\]/u)
  assert.match(css, /\.document-history-popover\s*\{[^}]*position:\s*absolute/u)
  assert.match(css, /\.document-history-list\s*\{[^}]*overflow-y:\s*auto/u)
  assert.match(css, /\.document-history-list\s*\{[^}]*margin-top:\s*var\(--space-2\)/su)
  assert.match(css, /\.document-history-item\s*\{[^}]*padding:\s*var\(--space-2\)\s+var\(--space-3\)/su)
  assert.match(css, /\.document-history-item-check\s*\{[^}]*display:\s*(?:inline-)?grid[^}]*place-items:\s*center[^}]*width:\s*var\(--control-height\)/su)
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.document-history-popover\s*\{[^}]*position:\s*fixed/u)
  assert.doesNotMatch(css, /\.document-history-popover[^}]*background(?:-color)?:\s*#[0-9a-f]{3,8}\b/iu)
  assert.match(zh, /'document\.historySearch': '搜索历史文件'/u)
  assert.match(zh, /'document\.historyNoResults': '没有匹配的文件。'/u)
  assert.match(en, /'document\.historySearch': 'Search history'/u)
  assert.match(en, /'document\.historyNoResults': 'No matching files\.'/u)
})

test('文件翻译历史切换必须防止重复触发并按目标 Tab 隔离任务', () => {
  const source = read('src/renderer/src/document.ts')
  const switchStart = source.indexOf('async function switchToDocumentHistoryEntry(')
  const switchEnd = source.indexOf('/**', switchStart + 1)
  const switchSource = source.slice(switchStart, switchEnd)
  const startStart = source.indexOf('async function startDocumentTabTranslation(')
  const startEnd = source.indexOf('/**', startStart + 1)
  const startSource = source.slice(startStart, startEnd)

  assert.ok(switchStart > -1)
  assert.ok(startStart > -1)
  assert.match(switchSource, /if \([^\n]*documentHistorySwitchInFlight\) return/u)
  assert.match(switchSource, /documentHistorySwitchInFlight = true/u)
  assert.match(switchSource, /const existingTab = findDocumentTabByPath\(entry\.path\)/u)
  assert.match(switchSource, /if \(existingTab\) \{\s*await activateDocumentTab\(existingTab\.id\)/u)
  assert.match(switchSource, /await createDocumentTab\(result, \{ activate: true, start: false \}\)/u)
  assert.match(switchSource, /if \(tab\) await startDocumentTabTranslation\(tab\)/u)
  assert.match(switchSource, /finally \{\s*documentHistorySwitchInFlight = false/u)

  // 迟到的启动结果必须按发起时的代际取消，不能把旧任务带入已关闭或已切换模式的 Tab。
  assert.match(source, /async function cancelLateDocumentRunResult\(/u)
  assert.match(
    startSource,
    /if \(!documentTabs\.includes\(tab\) \|\| tab\.generation !== jobGeneration\) \{\s*await cancelLateDocumentRunResult\(result, jobGeneration\)\s*return\s*\}/u
  )
})

test('工作台添加文件必须保留现有 Tab 并自动启动本次新文件', () => {
  const source = read('src/renderer/src/document.ts')
  const addStart = source.indexOf('async function addDocumentSelectionResults(')
  const addSource = source.slice(addStart, source.indexOf('/**', addStart + 1))
  const workbenchStart = source.indexOf('async function addDocumentFilesFromWorkbench()')
  const workbenchSource = source.slice(workbenchStart, source.indexOf('/**', workbenchStart + 1))

  assert.ok(addStart > -1)
  assert.ok(workbenchStart > -1)
  assert.match(addSource, /for \(const result of results\)/u)
  assert.match(addSource, /createDocumentTab\(result, \{ activate: false, start: false \}\)/u)
  assert.match(addSource, /if \(existed\) lastActivatedTab = tab/u)
  assert.match(addSource, /if \(!existed \|\| selectionChanged\) newTabs\.push\(tab\)/u)
  assert.match(addSource, /await Promise\.all\(newTabs\.map\(\(tab\) => startDocumentTabTranslation\(tab\)\)\)/u)
  assert.match(workbenchSource, /await window\.api\.selectDocumentFiles\(\)/u)
  assert.match(workbenchSource, /await addDocumentSelectionResults\(results\)/u)
  assert.doesNotMatch(workbenchSource, /workbench\.hidden = true/u)
  assert.doesNotMatch(workbenchSource, /uploadPanel\.hidden = false/u)
})

test('多 Tab 文件内容变化必须重置旧任务身份、阅读状态并重新启动翻译', () => {
  const source = read('src/renderer/src/document.ts')
  const createStart = source.indexOf('async function createDocumentTab(')
  const createSource = source.slice(createStart, source.indexOf('/**', createStart + 1))
  const addStart = source.indexOf('async function addDocumentSelectionResults(')
  const addSource = source.slice(addStart, source.indexOf('/**', addStart + 1))

  assert.ok(createStart > -1)
  assert.ok(addStart > -1)
  assert.match(
    createSource,
    /const selectionChanged = existing\.selection\.sha256 !== result\.sha256 \|\|\s*existing\.selection\.size !== result\.size \|\|\s*existing\.selection\.format !== result\.format/u,
    '复用同一路径 Tab 时必须按内容指纹判断是否仍是同一文件'
  )
  assert.match(createSource, /if \(selectionChanged\) \{[\s\S]*?existing\.snapshot = null/u)
  assert.match(createSource, /existing\.activeJobId = null/u)
  assert.match(createSource, /existing\.expectedJobId = null/u)
  assert.match(createSource, /existing\.startInFlight = false/u)
  assert.match(createSource, /existing\.status = 'idle'/u)
  assert.match(createSource, /existing\.scrollPositions = \{ source: 0, translation: 0 \}/u)
  assert.match(createSource, /existing\.languageRevision \+= 1/u)
  assert.match(createSource, /if \(selectionChanged && options\.start !== false\) await startDocumentTabTranslation\(existing\)/u)
  assert.match(addSource, /const tab = await createDocumentTab\(result, \{ activate: false, start: false \}\)/u)
  assert.match(addSource, /const selectionChanged = Boolean\(previousSelection && \(/u)
  assert.match(addSource, /if \(existed\) lastActivatedTab = tab/u)
  assert.match(addSource, /if \(!existed \|\| selectionChanged\) newTabs\.push\(tab\)/u)
})

test('切换和关闭 Tab 必须清理上一 Tab 的区块高亮、滚动意图与联动侧状态', () => {
  const source = read('src/renderer/src/document.ts')
  const resetStart = source.indexOf('function resetDocumentTabInteractionState(')
  const resetSource = source.slice(resetStart, source.indexOf('/**', resetStart + 1))
  const activateStart = source.indexOf('async function activateDocumentTab(')
  const activateSource = source.slice(activateStart, source.indexOf('/**', activateStart + 1))
  const closeStart = source.indexOf('async function closeDocumentTab(')
  const closeSource = source.slice(closeStart, source.indexOf('/**', closeStart + 1))

  assert.ok(resetStart > -1, '必须集中封装 Tab 交互状态清理')
  assert.match(resetSource, /clearDocumentBlockHighlight\(\)/u)
  assert.match(resetSource, /if \(userScrollIntentTimer !== null\)[\s\S]*?window\.clearTimeout\(userScrollIntentTimer\)[\s\S]*?userScrollIntentTimer = null/u)
  assert.match(resetSource, /userScrollSide = null/u)
  assert.match(resetSource, /documentScrollSyncedSide = null/u)
  assert.match(activateSource, /resetDocumentTabInteractionState\(\)/u)
  assert.match(
    closeSource,
    /if \(wasActive\) \{[\s\S]*?resetDocumentTabInteractionState\(\)[\s\S]*?clearActiveTabPreview\(\)/u,
    '关闭活动 Tab 后不得把旧高亮、滚动意图或联动侧状态带入下一个 Tab'
  )
})

test('关闭 Tab 后必须只持久化剩余 Tab，避免下次恢复已关闭文件', () => {
  const source = read('src/renderer/src/document.ts')
  const closeStart = source.indexOf('async function closeDocumentTab(')
  const closeSource = source.slice(closeStart, source.indexOf('/**', closeStart + 1))
  const removeIndex = closeSource.indexOf('documentTabs = documentTabs.filter(')
  const persistIndex = closeSource.indexOf('persistActiveDocumentViewerState()')

  assert.ok(closeStart > -1)
  assert.ok(removeIndex > -1 && persistIndex > removeIndex,
    '必须先从 Tab 集合删除文件，再持久化剩余集合')
})

test('保存后台 Tab 页面锚点必须使用该 Tab 自身区块并支持嵌套区块', () => {
  const source = read('src/renderer/src/document.ts')
  const pageStart = source.indexOf('function findActiveDocumentPageId(')
  const pageSource = source.slice(pageStart, source.indexOf('/**', pageStart + 1))

  assert.ok(pageStart > -1)
  assert.match(pageSource, /if \(tab\.activeBlockId\)/u,
    '页面锚点必须读取待保存 Tab 自己的区块，不能读取全局激活区块')
  assert.doesNotMatch(pageSource, /if \(activeDocumentBlockId\)/u)
  assert.match(pageSource, /resolveDocumentBlockHighlight\(model, page\.pageId, tab\.activeBlockId as string\)/u,
    '必须使用支持嵌套区块的定位函数')
})

test('页面重新打开恢复活动 Tab 后必须重新应用持久化区块高亮', () => {
  const source = read('src/renderer/src/document.ts')
  const restoreStart = source.indexOf('async function restoreDocumentViewerState(')
  const restoreSource = source.slice(restoreStart, source.indexOf('/**', restoreStart + 1))

  assert.ok(restoreStart > -1)
  assert.match(restoreSource, /renderActiveDocumentTab\(getActiveDocumentTab\(\)!\)[\s\S]*?requestAnimationFrame\(\(\) => highlightDocumentBlock\(activeBlockId\)\)/u,
    '恢复 DOM 后必须按持久化区块恢复高亮')
})

test('切换 Tab 渲染时必须保留该 Tab 的区块锚点并按锚点恢复 DOM 高亮', () => {
  const source = read('src/renderer/src/document.ts')
  const activateStart = source.indexOf('async function activateDocumentTab(')
  const activateSource = source.slice(activateStart, source.indexOf('/**', activateStart + 1))
  const renderStart = source.indexOf('function renderSnapshot(')
  const renderSource = source.slice(renderStart, source.indexOf('/**', renderStart + 1))
  const clearStart = source.indexOf('function clearDocumentBlockHighlight(')
  const clearSource = source.slice(clearStart, source.indexOf('/**', clearStart + 1))

  assert.ok(activateStart > -1)
  assert.match(activateSource, /renderActiveDocumentTab\(tab\)[\s\S]*?if \(tab\.activeBlockId\)[\s\S]*?highlightDocumentBlock\(tab\.activeBlockId\)/u,
    '切换 Tab 后必须使用目标 Tab 自己的区块锚点恢复高亮')
  assert.doesNotMatch(renderSource, /clearDocumentBlockHighlight\(\)/u,
    '快照重绘不能清除 Tab 的持久化区块锚点')
  assert.match(renderSource, /clearDocumentBlockDomHighlight\(\)[\s\S]*?if \(tab\.activeBlockId\)[\s\S]*?highlightDocumentBlock\(tab\.activeBlockId\)/u,
    '快照重绘后必须按当前 Tab 锚点重新标记新 DOM')
  assert.match(clearSource, /clearDocumentBlockDomHighlight\(\)/u,
    '显式清除高亮必须同时清理持久化锚点与 DOM')
})

test('清空 Tab 预览时必须同步失效原文渲染身份，避免恢复态错误复用其他文件 DOM', () => {
  const source = read('src/renderer/src/document.ts')
  const clearStart = source.indexOf('function clearActiveTabPreview(')
  const clearEnd = source.indexOf('/**', clearStart + 1)
  const clearSource = source.slice(clearStart, clearEnd)

  assert.match(clearSource, /renderedSourcePreviewIdentity = ''/u)
  assert.match(clearSource, /renderedSourcePreviewTabId = null/u)
  assert.match(clearSource, /renderedSourcePreviewSha256 = ''/u)
})

test('关闭最后一个 Tab 后必须移除查看器历史状态', () => {
  const source = read('src/renderer/src/document.ts')
  const persistStart = source.indexOf('function persistActiveDocumentViewerState(')
  const persistSource = source.slice(persistStart, source.indexOf('/**', persistStart + 1))

  assert.ok(persistStart > -1)
  assert.match(persistSource, /if \(tabs\.length === 0\) \{[\s\S]*?removeDocumentViewerState\(\)[\s\S]*?return/u,
    '没有可恢复 Tab 时必须删除旧查看器状态，避免重开页面恢复已关闭文件')
})

test('切换和关闭 Tab 必须释放内层 PDF 预览宿主的异步渲染资源', () => {
  const source = read('src/renderer/src/document.ts')
  const cleanupStart = source.indexOf('function cleanupPdfPreview(')
  const cleanupSource = source.slice(cleanupStart, source.indexOf('/**', cleanupStart + 1))
  const clearStart = source.indexOf('function clearActiveTabPreview()')
  const clearSource = source.slice(clearStart, source.indexOf('/**', clearStart + 1))
  const clearTranslationStart = source.indexOf('function clearActiveTabTranslationPreview()')
  const clearTranslationSource = source.slice(
    clearTranslationStart,
    source.indexOf('/**', clearTranslationStart + 1)
  )
  const renderStart = source.indexOf('function renderDocumentModel(')
  const renderSource = source.slice(renderStart, source.indexOf('/**', renderStart + 1))

  assert.ok(cleanupStart > -1, '必须集中封装 PDF 预览资源清理')
  assert.match(cleanupSource, /pdfPreviewCleanups\.get\(container\)\?\.\(\)/u)
  assert.match(cleanupSource, /querySelectorAll<HTMLElement>\('\.document-preview-host'\)/u)
  assert.match(cleanupSource, /pdfPreviewCleanups\.get\(previewHost\)\?\.\(\)/u)
  assert.match(clearSource, /cleanupPdfPreview\(sourceContent\)/u)
  assert.match(clearSource, /cleanupPdfPreview\(translationContent\)/u)
  assert.match(clearTranslationSource, /cleanupPdfPreview\(translationContent\)/u)
  assert.match(renderSource, /cleanupPdfPreview\(container\)/u)
  assert.doesNotMatch(renderSource, /pdfPreviewCleanups\.get\(container\)\?\.\(\)/u,
    'PDF 清理函数登记在内层预览宿主，外层容器直接查找会漏掉真实资源')
})

test('多 Tab 必须分别保存并恢复缩放、页码和滚动联动状态', () => {
  const source = read('src/renderer/src/document.ts')
  const activateStart = source.indexOf('async function activateDocumentTab(')
  const activateSource = source.slice(activateStart, source.indexOf('/**', activateStart + 1))
  const persistStart = source.indexOf('function persistActiveDocumentViewerState(')
  const persistSource = source.slice(persistStart, source.indexOf('/**', persistStart + 1))
  const savedTabStart = source.indexOf('function createPersistedDocumentViewerTab(')
  const savedTabSource = source.slice(savedTabStart, source.indexOf('/**', savedTabStart + 1))

  assert.ok(activateStart > -1)
  assert.ok(persistStart > -1)
  assert.ok(savedTabStart > -1)
  assert.match(source, /interface DocumentWorkspaceTab \{[\s\S]*?zoom: number[\s\S]*?pageNumber: number[\s\S]*?scrollSyncEnabled: boolean/u,
    '每个 Tab 必须拥有独立的阅读状态')
  assert.match(source, /function saveDocumentTabViewerState\(/u)
  assert.match(source, /tab\.zoom = documentZoom/u)
  assert.match(source, /tab\.pageNumber = currentDocumentPageNumber/u)
  assert.match(source, /tab\.scrollSyncEnabled = documentScrollSyncEnabled/u)
  assert.match(source, /function restoreDocumentTabViewerState\(/u)
  assert.match(source, /documentZoom = clampDocumentZoom\(tab\.zoom\)/u)
  assert.match(source, /currentDocumentPageNumber = tab\.pageNumber/u)
  assert.match(source, /documentScrollSyncEnabled = tab\.scrollSyncEnabled/u)
  assert.match(activateSource, /saveDocumentTabViewerState\(currentTab\)/u,
    '切换前必须保存旧 Tab 的阅读状态')
  assert.match(activateSource, /restoreDocumentTabViewerState\(tab\)/u,
    '切换后必须恢复目标 Tab 的阅读状态')
  assert.match(persistSource, /createPersistedDocumentViewerTab\(tab\)/u,
    '持久化必须逐个转换所有 Tab，不能只写入当前激活 Tab')
  assert.match(savedTabSource, /zoom: tab\.zoom/u,
    '持久化必须使用对应 Tab 自己的缩放比例，不能写入其他 Tab 的全局值')
  assert.match(savedTabSource, /activePageId: findActiveDocumentPageId\(tab\)/u,
    '页面锚点必须按待保存 Tab 自身计算')
  assert.match(savedTabSource, /activeBlockId: tab\.activeBlockId/u,
    '区块锚点必须使用待保存 Tab 自身的高亮')
})

test('多 Tab 原文预览身份必须同时绑定 Tab 与文件 SHA-256', () => {
  const source = read('src/renderer/src/document.ts')
  // 从正常渲染器之后查找调用处，避免 indexOf 命中 renderSnapshot 的声明本身。
  const renderStart = source.indexOf('function renderSnapshot(', source.indexOf('function renderDocumentModel('))
  const renderSource = source.slice(renderStart, source.indexOf('/**', renderStart + 1))
  const clearStart = source.indexOf('function clearActiveTabPreview()')
  const clearSource = source.slice(clearStart, source.indexOf('/**', clearStart + 1))

  assert.match(source, /let renderedSourcePreviewTabId: string \| null = null/u)
  assert.match(source, /let renderedSourcePreviewSha256 = ''/u)
  assert.match(
    renderSource,
    /function renderSnapshot\(snapshot: DocumentWorkspaceSnapshot, tab: DocumentWorkspaceTab\): void/u,
    '快照渲染必须显式接收所属 Tab，不能从全局激活状态重新推断'
  )
  assert.match(
    renderSource,
    /const canReuseRenderedSourcePreview =[\s\S]*?renderedSourcePreviewTabId === tab\.id[\s\S]*?renderedSourcePreviewSha256 === tab\.selection\.sha256/u,
    '只有同一 Tab 且文件指纹一致时才允许复用缺失 source 的已渲染原文'
  )
  assert.match(renderSource, /: canReuseRenderedSourcePreview\s*\?\s*renderedSourcePreviewIdentity\s*:\s*''/u)
  assert.match(renderSource, /renderedSourcePreviewTabId = tab\.id/u)
  assert.match(renderSource, /renderedSourcePreviewSha256 = tab\.selection\.sha256/u)
  assert.doesNotMatch(renderSource, /getActiveDocumentTab\(\)/u,
    '异步快照渲染不得读取后来切换到的全局 Tab')
  assert.match(clearSource, /renderedSourcePreviewTabId = null/u)
  assert.match(clearSource, /renderedSourcePreviewSha256 = ''/u)
})

test('恢复态与历史 Tab 的原文必须使用正常格式渲染器，译文栏显示保存的译文', () => {
  const source = read('src/renderer/src/document.ts')
  const snapshotStart = source.indexOf('function renderSnapshot(')
  const snapshotSource = source.slice(snapshotStart, source.indexOf('/**', snapshotStart + 1))
  const modelStart = source.indexOf('function renderDocumentModel(')
  const modelSource = source.slice(modelStart, source.indexOf('/**', modelStart + 1))

  assert.doesNotMatch(modelSource, /renderRestoredDocumentSourcePreview/u,
    '恢复态原文不能绕过 Markdown、CSV、字幕、HTML、PDF 等正常格式渲染器')
  assert.doesNotMatch(source, /function renderRestoredDocumentSourcePreview\(/u,
    '历史与恢复态不得保留统一流式原文预览这一旁路渲染器')
  assert.match(modelSource, /side === 'source' && model\.source\.format === 'html'/u)
  assert.match(modelSource, /const usePdfCanvas = model\.source\.format === 'pdf' && side === 'source'/u)
  assert.match(modelSource, /kind === 'paged'/u)
  assert.match(snapshotSource, /renderDocumentModel\([\s\S]*?snapshot\.source[\s\S]*?tab\s*\)/u)
  assert.match(snapshotSource, /renderDocumentModel\([\s\S]*?translationPaneModel[\s\S]*?tab\s*\)/u)
})

test('快照、任务状态与图片渲染链必须显式绑定快照所属 Tab', () => {
  const source = read('src/renderer/src/document.ts')
  const renderSnapshotStart = source.indexOf('function renderSnapshot(')
  const renderSnapshotSource = source.slice(renderSnapshotStart, source.indexOf('/**', renderSnapshotStart + 1))
  const taskStateStart = source.indexOf('function renderTaskState(')
  const taskStateSource = source.slice(taskStateStart, source.indexOf('/**', taskStateStart + 1))
  const imageStart = source.indexOf('function renderImageBlock(')
  const imageSource = source.slice(imageStart, source.indexOf('/**', imageStart + 1))
  const cellImageStart = source.indexOf('function renderTableCellImageBlock(')
  const cellImageSource = source.slice(cellImageStart, source.indexOf('/**', cellImageStart + 1))

  assert.match(renderSnapshotSource, /renderDocumentModel\([\s\S]*?tab\s*\)/u)
  assert.match(renderSnapshotSource, /renderOcrDisplayModeControls\(snapshot, tab\)/u)
  assert.doesNotMatch(taskStateSource, /getActiveDocumentTab\(\)/u,
    '任务状态必须使用快照所属 Tab，不能在旧帧中读取新 Tab')
  assert.match(taskStateSource, /isReadOnlyDocumentTab\(tab\)/u)
  assert.doesNotMatch(imageSource, /if \(isReadOnlyDocumentTab\(tab\)/u,
    '只读 Tab 也必须尝试重新读取已授权资源，不能无条件显示 pending 占位')
  assert.match(imageSource, /loadDocumentImageAsset\(wrapper, image, block, jobId, tab\)/u)
  assert.doesNotMatch(imageSource, /getActiveDocumentTab\(\)/u)
  assert.doesNotMatch(cellImageSource, /if \(isReadOnlyDocumentTab\(tab\)/u)
  assert.match(cellImageSource, /loadDocumentImageAsset\(wrapper, image, block, jobId, tab\)/u)
  assert.doesNotMatch(cellImageSource, /getActiveDocumentTab\(\)/u)
})

test('历史与恢复态图片必须重新加载，失败时显示原图不可用而不是 OCR pending', () => {
  const source = read('src/renderer/src/document.ts')
  const resolveStart = source.indexOf('async function resolveAssetUrl(')
  const resolveSource = source.slice(resolveStart, source.indexOf('/**', resolveStart + 1))
  const loadStart = source.indexOf('function loadDocumentImageAsset(')
  const loadSource = source.slice(loadStart, source.indexOf('/**', loadStart + 1))
  const placeholderStart = source.indexOf('function renderDocumentImagePlaceholder(')
  const placeholderSource = source.slice(placeholderStart, source.indexOf('/**', placeholderStart + 1))

  assert.match(resolveSource, /tab\.id/u)
  assert.match(resolveSource, /sourceSha256/u)
  assert.match(resolveSource, /getApprovedDocumentAsset/u,
    '只读 Tab 必须通过重新授权后的受控资源接口读取图片')
  assert.doesNotMatch(resolveSource, /const cacheKey = `\$\{jobId\}:\$\{assetId\}`/u,
    '恢复态共用固定 jobId 时不能只按 jobId 缓存资源，否则多 Tab 会串图')
  assert.doesNotMatch(loadSource, /wrapper\.dataset\.pending = 'true'/u,
    '资源加载失败不是等待 OCR，不能继续显示 pending')
  assert.match(loadSource, /renderDocumentImagePlaceholder\(wrapper, block, 'error'\)/u)
  assert.match(placeholderSource, /document\.imageUnavailable/u)
})

test('HTML 源文预览请求身份必须在释放旧 Blob URL 后设置', () => {
  const source = read('src/renderer/src/document.ts')
  const renderStart = source.indexOf('function renderHtmlSourcePreview(')
  const renderSource = source.slice(renderStart, source.indexOf('/**', renderStart + 1))
  const releaseIndex = renderSource.indexOf('releaseHtmlPreviewUrl()')
  const identityIndex = renderSource.indexOf('htmlPreviewRequestIdentity = requestIdentity')

  assert.ok(releaseIndex > -1)
  assert.ok(identityIndex > releaseIndex, '释放函数会清空请求身份，因此必须在释放之后登记新请求')
})

test('重绘原文不得断开译文页面布局观察器', () => {
  const source = read('src/renderer/src/document.ts')
  const renderStart = source.indexOf('function renderDocumentModel(')
  const renderSource = source.slice(renderStart, source.indexOf('/**', renderStart + 1))
  const guardIndex = renderSource.indexOf('if (container === translationContent) {')
  const observerIndex = renderSource.indexOf('pageScaleObserver?.disconnect()')
  const activeSchedulerIndex = renderSource.indexOf('activePageLayoutScheduler = null')
  const translationGuardEnd = renderSource.indexOf('}', renderSource.indexOf('watermarkResizeObserver = null', guardIndex))

  assert.ok(observerIndex > guardIndex, '译文布局观察器只能在重绘译文容器时断开')
  assert.ok(activeSchedulerIndex > guardIndex, '译文布局调度器只能在重绘译文容器时清空')
  assert.ok(translationGuardEnd > activeSchedulerIndex)
  assert.match(
    renderSource.slice(guardIndex, translationGuardEnd),
    /pageScaleObserver\?\.disconnect\(\)[\s\S]*?activePageLayoutScheduler = null[\s\S]*?watermarkResizeObserver\?\.disconnect\(\)/u
  )
})

test('文件翻译模式切换后必须重置目标 Tab 的 OCR 展示状态', () => {
  const source = read('src/renderer/src/document.ts')
  const resetStart = source.indexOf('function resetDocumentRunForModeSwitch(')
  const resetEnd = source.indexOf('/**', resetStart + 1)
  const resetSource = source.slice(resetStart, resetEnd)

  assert.ok(resetStart > -1)
  assert.match(resetSource, /tab\.snapshot = null/u)
  assert.match(resetSource, /tab\.status = 'starting'/u)
  assert.match(source, /tab\.ocrDisplayMode = nextMode/u)
  assert.match(source, /resetDocumentRunForModeSwitch\(tab\)/u)
  assert.match(source, /await startDocumentTabTranslation\(tab\)/u)
})

test('文档工作台上传面板必须提供可访问的主操作、隐私边界与主题化自适应布局', () => {
  const html = read('src/renderer/document.html')
  const css = read('src/renderer/src/document.css')

  assert.match(
    html,
    /id="document-start-button"[^>]*class="[^"]*document-primary-button[^"]*"[^>]*data-i18n="document\.upload\.start"[^>]*disabled/u
  )
  assert.match(html, /id="document-upload-panel"[^>]*role="tabpanel"[^>]*aria-labelledby="document-upload-title"/u)
  assert.match(html, /id="document-drop-zone"[^>]*role="button"[^>]*aria-describedby="document-upload-formats document-upload-privacy"/u)
  assert.match(html, /id="document-upload-formats"[^>]*data-i18n="document\.upload\.formats"/u)
  assert.match(html, /id="document-upload-privacy"[^>]*data-i18n="document\.upload\.privacy"/u)
  assert.match(html, /id="document-upload-status"[^>]*role="status"[^>]*aria-live="polite"/u)
  assert.match(css, /\.document-upload-panel\s*\{[^}]*display:\s*(?:flex|grid)/u)
  assert.match(css, /\.document-upload-panel\s*\{[^}]*min-height:\s*0/u)
  assert.match(css, /\.document-drop-zone:focus-visible\s*\{[^}]*outline:/u)
  assert.doesNotMatch(css, /(?:^|[;{])\s*color:\s*#[0-9a-f]{3,8}\b/imu)
  assert.doesNotMatch(css, /(?:^|[;{])\s*background(?:-color)?:\s*#[0-9a-f]{3,8}\b/imu)
})

test('文档工作台窗口必须限制为安全本地页面并只允许单实例复用', () => {
  const manager = read('src/main/documentWorkspaceWindow.ts')
  const createStart = manager.indexOf('private async ensureWindow()')
  const createEnd = manager.indexOf('private resolveInitialBounds()', createStart)
  const createSource = manager.slice(createStart, createEnd)

  assert.ok(createStart >= 0 && createEnd > createStart)
  assert.match(createSource, /contextIsolation:\s*true/u)
  assert.match(createSource, /nodeIntegration:\s*false/u)
  assert.match(createSource, /sandbox:\s*true/u)
  assert.match(createSource, /setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'\s*\}\)\)/u)
  assert.match(createSource, /isAllowedDocumentHtmlPreviewUrl\(params\.src \?\? ''\)\) event\.preventDefault\(\)/u)
  assert.match(createSource, /this\.options\.loadRenderer\(window, 'document\.html'\)/u)
  assert.match(manager, /if \(this\.window && !this\.window\.isDestroyed\(\)\) return/u)
})

test('文档翻译顶部栏必须提供仅重试失败项的重新翻译按钮', () => {
  const html = read('src/renderer/document.html')
  const source = read('src/renderer/src/document.ts')
  const zh = read('src/shared/i18n/catalog.zh-CN.document.ts')
  const en = read('src/shared/i18n/catalog.en-US.document.ts')
  const toolbarActions = /<div class="document-toolbar-actions">([\s\S]*?)<\/div>/u.exec(html)?.[1] ?? ''

  assert.match(
    toolbarActions,
    /id="document-retry-button"[^>]*data-i18n="document\.retryFailed"[^>]*disabled/u
  )
  assert.match(source, /const retryButton = document\.getElementById\('document-retry-button'\) as HTMLButtonElement/u)
  assert.match(source, /resolveDocumentRetryActionState/u)
  assert.match(source, /const retryAction = resolveDocumentRetryActionState\(snapshot\)/u)
  assert.match(source, /retryButton\.disabled = retryAction\.retryDisabled/u)
  assert.doesNotMatch(
    source,
    /retryButton\.disabled = [^\n]*phaseCompleted/u,
    '终态仍存在可重试目标时，重试按钮不得因 phaseCompleted 被禁用'
  )
  assert.match(source, /retryButton\.addEventListener\('click',\s*\(\)\s*=>\s*void retryFailedDocumentTranslation\(\)\)/u)
  assert.match(source, /async function retryFailedDocumentTranslation\(/u)
  assert.match(source, /const snapshot = tab\?\.snapshot/u)
  assert.match(source, /if \(resolveDocumentRetryActionState\(snapshot\)\.retryDisabled\) return/u)
  assert.match(source, /await window\.api\.retryFailedDocument\(/u)
  assert.match(zh, /'document\.retryFailed': '重新翻译未完成项'/u)
  assert.match(zh, /'document\.retryStarted': '正在重新翻译未完成项…'/u)
  assert.match(en, /'document\.retryFailed': 'Retry incomplete items'/u)
  assert.match(en, /'document\.retryStarted': 'Retrying incomplete items…'/u)
})

test('文档翻译顶部栏必须提供与页面翻译一致的源语言和目标语言切换', () => {
  const html = read('src/renderer/document.html')
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const theme = read('src/renderer/src/theme.css')
  const sourceControl = html.indexOf('id="document-source-lang"')
  const targetControl = html.indexOf('id="document-target-lang"')

  assert.ok(sourceControl > -1)
  assert.ok(targetControl > sourceControl)
  assert.match(html, /id="document-source-lang"[^>]*data-i18n-attr="aria-label:menu\.sourceLanguage"/u)
  assert.match(html, /id="document-target-lang"[^>]*data-i18n-attr="aria-label:menu\.targetLanguage"/u)
  assert.match(html, /data-i18n="menu\.sourceLanguage"/u)
  assert.match(html, /data-i18n="menu\.targetLanguage"/u)
  assert.match(source, /import \{ LANGUAGES, langLabel \} from '\.\.\/\.\.\/shared\/langs'/u)
  assert.match(source, /function populateDocumentLanguages\(/u)
  assert.match(source, /sourceLanguageSelect\.add\(new Option\(t\('popup\.autoDetect'\), 'auto'\)\)/u)
  assert.match(source, /targetLanguageSelect\.add\(new Option\(t\('popup\.autoBilingual'\), 'auto'\)\)/u)
  assert.match(source, /targetLanguageSelect\.add\(new Option\(label, language\.code\)\)/u)
  assert.match(source, /currentSettings = await window\.api\.getSettings\(\)/u)
  assert.match(source, /sourceLanguageSelect\.addEventListener\('change'/u)
  assert.match(source, /targetLanguageSelect\.addEventListener\('change'/u)
  assert.match(source, /let documentStartInFlight = false/u)
  assert.match(source, /pendingLanguageRetranslation = true/u)
  assert.match(css, /\.document-language-controls\b/u)
  assert.match(css, /\.document-language-control\b/u)
})

test('文档翻译语言下拉首次初始化必须沿用设置中的源语言和目标语言', () => {
  const source = read('src/renderer/src/document.ts')

  assert.match(
    source,
    /const selectedSource = sourceValue\?\.trim\(\) \|\| sourceLanguageSelect\.value \|\| settings\.sourceLang \|\| 'auto'/u
  )
  assert.match(
    source,
    /const selectedTarget = targetValue\?\.trim\(\) \|\| targetLanguageSelect\.value \|\| settings\.targetLang \|\| 'auto'/u
  )
})

test('文档翻译必须在文档级解析一次语言对并让任务服务冻结复用', () => {
  const source = read('src/renderer/src/document.ts')
  const main = read('src/main/index.ts')
  const pipeline = read('src/main/documentTranslationPipeline.ts')
  const service = read('src/main/documentWorkspaceTaskService.ts')
  const serviceStart = main.indexOf('function createDocumentWorkspaceTaskService')
  const serviceEnd = main.indexOf('/**', serviceStart + 1)
  const serviceSource = main.slice(serviceStart, serviceEnd)

  assert.match(source, /targetLanguageSelect\.value = selectedTarget \|\| 'auto'/u)
  assert.match(source, /populateDocumentLanguages\(\{ sourceLang: 'auto', targetLang: 'auto' \} as Settings\)/u)
  assert.doesNotMatch(serviceSource, /resolveLanguagePair\(text,/u)
  assert.match(serviceSource, /translate: async \(text, signal, _request, languagePair, onDelta, context\)/u)
  assert.match(serviceSource, /sourceLang: languagePair\.sourceLang/u)
  assert.match(serviceSource, /targetLang: languagePair\.targetLang/u)
  assert.match(pipeline, /resolveDocumentLanguagePair\(/u)
  assert.match(pipeline, /languageResolution: DocumentLanguageResolution/u)
  assert.match(
    pipeline,
    /deps\.translate\(\s*item\.batch\.text,\s*signal,\s*languagePair,\s*\(delta\)/u
  )
  assert.match(
    pipeline,
    /deps\.translate\(\s*segment\.text,\s*signal,\s*languagePair(?:,|\s*\))/u
  )
  assert.match(service, /languageResolution\?: DocumentLanguageResolution/u)
  assert.match(service, /job\.languageResolution = result\.languageResolution/u)
  assert.match(service, /retryFailedDocumentTranslationPipeline\([\s\S]*?languageResolution\s*\)/u)
  assert.match(service, /sourcePreference: job\.languageResolution\.sourcePreference/u)
  assert.match(service, /targetPreference: job\.languageResolution\.targetPreference/u)
  assert.match(service, /languagePair: job\.languageResolution\.languagePair/u)
})

test('文档工作台必须保留语言偏好并单独展示文档级实际语言方向', () => {
  const html = read('src/renderer/document.html')
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const zh = read('src/shared/i18n/catalog.zh-CN.document.ts')
  const en = read('src/shared/i18n/catalog.en-US.document.ts')

  assert.match(
    html,
    /id="document-actual-language"[^>]*data-i18n="document\.actualLanguage"[^>]*aria-live="polite"[^>]*hidden/u
  )
  assert.match(source, /const actualLanguage = document\.getElementById\('document-actual-language'\) as HTMLElement/u)
  assert.match(source, /function renderActualLanguage\(languagePair\?: DocumentWorkspaceSnapshot\['languagePair'\]\)/u)
  assert.match(source, /langLabel\(languagePair\.sourceLang, localeRuntime\.locale\)/u)
  assert.match(source, /langLabel\(languagePair\.targetLang, localeRuntime\.locale\)/u)
  assert.match(source, /t\('document\.actualLanguage', \{ direction \}\)/u)
  assert.match(source, /actualLanguage\.hidden = true/u)
  assert.match(source, /snapshot\.languagePair/u)
  assert.match(source, /sourceLanguageSelect\.value = selectedSource \|\| 'auto'/u)
  assert.match(source, /targetLanguageSelect\.value = selectedTarget \|\| 'auto'/u)
  assert.doesNotMatch(source, /sourceLanguageSelect\.value = snapshot\.languagePair/u)
  assert.doesNotMatch(source, /targetLanguageSelect\.value = snapshot\.languagePair/u)
  assert.match(source, /actualLanguage\.hidden = true/u)
  const clearStart = source.indexOf('function clearActiveTabPreview()')
  const clearSource = source.slice(clearStart, source.indexOf('/**', clearStart + 1))
  const createStart = source.indexOf('async function createDocumentTab(')
  const createSource = source.slice(createStart, source.indexOf('/**', createStart + 1))
  const renderStart = source.indexOf('function renderActiveDocumentTab(')
  const renderSource = source.slice(renderStart, source.indexOf('/**', renderStart + 1))
  const localeStart = source.indexOf('localeRuntime.onLocaleChanged(')
  const localeSource = source.slice(localeStart, source.indexOf('\n  })', localeStart) + 4)
  assert.match(clearSource, /actualLanguage\.hidden = true/u)
  assert.match(createSource, /await activateDocumentTab\(tab\.id\)/u)
  assert.match(renderSource, /syncActiveTabMirror\(tab\)/u)
  assert.match(localeSource, /renderSnapshot\(latestSnapshot, tab\)/u)
  assert.match(css, /\.document-actual-language\b/u)
  assert.match(css, /\.document-actual-language\[hidden\]\s*\{\s*display:\s*none/u)
  assert.match(css, /var\(--text-secondary\)/u)
  assert.match(css, /flex-wrap:\s*wrap/u)
  assert.match(zh, /'document\.actualLanguage': '实际语言：\{\{direction\}\}'/u)
  assert.match(zh, /'document\.actualLanguageAuto': '自动'/u)
  assert.match(en, /'document\.actualLanguage': 'Actual language: \{\{direction\}\}'/u)
  assert.match(en, /'document\.actualLanguageAuto': 'Auto'/u)
})

test('文件翻译必须使用流式翻译通道，并持续展示增量译文', () => {
  const main = read('src/main/index.ts')
  const serviceStart = main.indexOf('function createDocumentWorkspaceTaskService')
  const serviceEnd = main.indexOf('/**', serviceStart + 1)
  const serviceSource = main.slice(serviceStart, serviceEnd)

  assert.match(serviceSource, /const output = await translateStream\(/u)
  assert.match(serviceSource, /onDelta: onDelta \?\? \(\(\) => undefined\)/u)
  assert.match(serviceSource, /signal/u)
})

test('文档任务生产接线必须注入动态限制、缓存和受控翻译上下文', () => {
  const main = read('src/main/index.ts')
  const serviceStart = main.indexOf('function createDocumentWorkspaceTaskService')
  const serviceEnd = main.indexOf('/**', serviceStart + 1)
  const serviceSource = main.slice(serviceStart, serviceEnd)
  const validationStart = main.indexOf('async function validateApprovedDocumentPath')
  const validationEnd = main.indexOf('/**', validationStart + 1)
  const validationSource = main.slice(validationStart, validationEnd)

  assert.match(main, /import \{ DocumentTranslationCacheStore \} from '\.\/documentTranslationCache'/u)
  assert.match(serviceSource, /parse: async \(input, registerAssetBytes, signal, options\)/u)
  assert.match(serviceSource, /parseDocument\(input, \{ registerAssetBytes, \.\.\.options \}\)/u)
  assert.match(serviceSource, /translate: async \(text, signal, _request, languagePair, onDelta, context\)/u)
  assert.match(serviceSource, /maxFileBytes: \(\) => getSettings\(\)\.documentTranslationMaxFileBytes/u)
  assert.match(serviceSource, /maxPages: \(\) => getSettings\(\)\.documentTranslationMaxPages/u)
  assert.match(serviceSource, /maxOcrImages: \(\) => getSettings\(\)\.documentTranslationMaxOcrImages/u)
  assert.match(serviceSource, /getParserVersion: \(\) => 'document-parser-v1'/u)
  assert.match(serviceSource, /glossary: \(\) => undefined/u)
  assert.match(main, /function getDocumentTranslationCacheStore\(\)/u)
  assert.match(main, /new DocumentTranslationCacheStore\(/u)
  assert.match(main, /join\(app\.getPath\('userData'\), 'document-translation-cache'\)/u)
  assert.match(main, /documentTranslationCacheMaxBytes/u)
  assert.match(main, /documentTranslationCacheMaxAgeDays \* 24 \* 60 \* 60 \* 1000/u)
  assert.match(main, /function getDocumentTaskHistoryStore\(\)/u)
  assert.match(main, /join\(app\.getPath\('userData'\), 'document-task-history'\)/u)
  assert.match(serviceSource, /saveHistory: \(snapshot\) => historyStore\.save\(snapshot\)/u)
  assert.match(serviceSource, /updateHistoryExportStatus:/u)
  assert.match(serviceSource, /readTranslationCache: \(key\) => cacheStore\.read\(key\)/u)
  assert.match(serviceSource, /writeTranslationCache: \(key, value\) => cacheStore\.write\(key, value\)/u)
  assert.match(validationSource, /getSettings\(\)\.documentTranslationMaxFileBytes/u)
  assert.match(validationSource, /maxBytes:/u)
})

test('文档翻译功能开关必须控制入口和任务执行', () => {
  const main = read('src/main/index.ts')
  const supportedStart = main.indexOf('function ensureDocumentWorkspaceSupported')
  const supportedEnd = main.indexOf('/**', supportedStart + 1)
  const supportedSource = main.slice(supportedStart, supportedEnd)
  const runStart = main.indexOf("ipcMain.handle('document:run'")
  const runEnd = main.indexOf('/**', runStart + 1)
  const runSource = main.slice(runStart, runEnd)

  assert.match(supportedSource, /documentTranslationEnabled/u)
  assert.match(runSource, /documentTranslationEnabled/u)
})

test('文件翻译流式更新必须原位更新变化内容，不能重建整份译文 DOM', () => {
  const source = read('src/renderer/src/document.ts')

  assert.match(source, /let renderedTranslationPreviewKind/u)
  assert.match(source, /function patchTranslationPreview\(/u)
  assert.match(source, /function patchTranslationTextBlock\(/u)
  assert.match(source, /function patchTranslationOcrLayer\(/u)
  assert.match(source, /patchTranslationPreview\(translationContent, snapshot\.translation,\s*tab\)/u,
    '流式译文补丁必须绑定所属 Tab，避免读取切换后的全局阅读状态')
  assert.match(source, /existingRun\.textContent = run\.text/u)
})

test('PDF 流式译文原位更新必须重算区块宽度并保留表格单元格流式约束', () => {
  const source = read('src/renderer/src/document.ts')
  const patchStart = source.indexOf('function patchTranslationPreview(')
  const patchSource = source.slice(patchStart, source.indexOf('/**', patchStart + 1))
  const textStart = source.indexOf('function patchTranslationTextBlock(')
  const textSource = source.slice(textStart, source.indexOf('/**', textStart + 1))
  const blockStart = source.indexOf('function patchTranslationBlock(')
  const blockSource = source.slice(blockStart, source.indexOf('/**', blockStart + 1))

  assert.ok(patchStart > -1)
  assert.ok(textStart > -1)
  assert.ok(blockStart > -1)
  assert.match(
    textSource,
    /applyTranslationBlockGeometry\(element, block, pageWidth, contentArea\)/u,
    '增量更新文本后必须重新应用页面正文区宽度，否则译文会一直沿用首次渲染的窄宽度'
  )
  assert.match(
    textSource,
    /element\.dataset\.tableCellContent !== 'true'/u,
    '表格单元格内不能套用整页正文区几何'
  )
  assert.match(
    patchSource,
    /patchTranslationBlock\(\s*block,[\s\S]*?page\.width,[\s\S]*?page\.contentArea/u,
    '流式补丁必须把区块所属页面宽度和正文区传给几何计算'
  )
  assert.match(blockSource, /pageWidth/u)
  assert.match(blockSource, /contentArea/u)
})

test('恢复的只读图片必须忽略运行期 renderPending 并立即尝试受控资源加载', () => {
  const source = read('src/renderer/src/document.ts')
  const imageStart = source.indexOf('function renderImageBlock(')
  const imageSource = source.slice(imageStart, source.indexOf('/**', imageStart + 1))
  const cellStart = source.indexOf('function renderTableCellImageBlock(')
  const cellSource = source.slice(cellStart, source.indexOf('/**', cellStart + 1))
  const pendingStart = source.indexOf('function resolveDocumentImageRenderPending(')

  assert.ok(pendingStart > -1, '必须集中解析图片运行期 pending 状态')
  assert.match(
    imageSource,
    /const renderPending = resolveDocumentImageRenderPending\(block, tab\)/u,
    '恢复态不能直接信任持久化的 renderPending'
  )
  assert.match(
    cellSource,
    /const renderPending = resolveDocumentImageRenderPending\(block, tab\)/u,
    '表格图片也必须忽略恢复态的旧 pending 标志'
  )
  assert.match(imageSource, /if \(renderPending\)/u)
  assert.match(cellSource, /if \(renderPending\)/u)
})

test('文件翻译流式滚动同步必须区分用户滚动与程序性滚动，不能形成双向回环', () => {
  const source = read('src/renderer/src/document.ts')

  assert.match(source, /type DocumentScrollSide/u)
  assert.match(source, /from '\.\/documentScrollSync'/u)
  assert.match(source, /const pendingProgrammaticScrollTops = new WeakMap<HTMLElement, number>\(\)/u)
  assert.match(source, /function consumeProgrammaticScroll\(/u)
  assert.match(source, /function markUserScrollIntent\(/u)
  assert.match(source, /function handleDocumentScroll\(/u)
  assert.doesNotMatch(source, /if \(userScrollSide !== side\) return/u)
  assert.match(source, /translationLayoutUpdating/u)
  assert.match(source, /sourceContent\.addEventListener\('wheel'/u)
  assert.match(source, /translationContent\.addEventListener\('wheel'/u)
})

test('文件翻译译文重排前后必须保持双栏滚动位置，避免流式高度变化拖动视口', () => {
  const source = read('src/renderer/src/document.ts')
  const layoutStart = source.indexOf('function observeTranslationPageScale(')
  const layoutEnd = source.indexOf('/**', layoutStart + 1)
  const layoutSource = source.slice(layoutStart, layoutEnd)

  assert.match(source, /function captureDocumentScrollPositions\(/u)
  assert.match(source, /function restoreDocumentScrollPositions\(/u)
  assert.match(layoutSource, /captureDocumentScrollPositions\(\)/u)
  assert.match(layoutSource, /normalizeTranslationFlowLayout\(page\)/u)
  assert.match(layoutSource, /restoreDocumentScrollPositions\(/u)
})

test('文件翻译流式 DOM 更新必须在文本写入前进入滚动保护，并在布局完成后解除', () => {
  const source = read('src/renderer/src/document.ts')
  const layoutStart = source.indexOf('function observeTranslationPageScale(')
  const layoutSource = source.slice(layoutStart, source.indexOf('/**', layoutStart + 1))
  const patchStart = source.indexOf('function patchTranslationPreview(')
  const patchSource = source.slice(patchStart, source.indexOf('/**', patchStart + 1))
  const cancelStart = source.indexOf('function cancelTranslationPageLayout(')
  const cancelSource = source.slice(cancelStart, source.indexOf('/**', cancelStart + 1))
  const restoreStart = source.indexOf('function restoreDocumentScrollPositions(')
  const restoreSource = source.slice(restoreStart, source.indexOf('/**', restoreStart + 1))

  const beginIndex = patchSource.indexOf('beginTranslationLayoutUpdate()')
  const mutateIndex = patchSource.search(/patchTranslationBlock\(\s*block/u)
  assert.ok(beginIndex > -1, '流式更新必须在写入 DOM 前开启布局保护')
  assert.ok(beginIndex < mutateIndex, '布局保护必须早于任何译文区块写入')
  assert.match(patchSource, /cancelTranslationPageLayout\(\)/u, '原位更新失败时必须清理保护状态')

  const restoreIndex = layoutSource.lastIndexOf('restoreDocumentScrollPositions(scrollPositions)')
  const releaseIndex = layoutSource.lastIndexOf('translationLayoutUpdating = false')
  assert.ok(restoreIndex > -1 && releaseIndex > restoreIndex,
    '布局帧必须先恢复视口，再解除流式滚动保护')

  assert.match(cancelSource, /translationLayoutUpdating = false/u)
  assert.match(cancelSource, /pendingTranslationLayoutScrollPositions = null/u)
  assert.match(restoreSource, /userScrollSide !== 'source'/u)
  assert.match(restoreSource, /userScrollSide !== 'translation'/u)
  assert.doesNotMatch(restoreSource, /if \(userScrollSide !== null\) return/u)
})

test('文件翻译流式更新没有页面调度器时也必须恢复视口并解除滚动保护', () => {
  const source = read('src/renderer/src/document.ts')
  const scheduleStart = source.indexOf('function scheduleTranslationPageLayout(')
  const scheduleSource = source.slice(scheduleStart, source.indexOf('/**', scheduleStart + 1))
  const patchStart = source.indexOf('function patchTranslationPreview(')
  const patchSource = source.slice(patchStart, source.indexOf('/**', patchStart + 1))

  assert.match(scheduleSource, /if \(activePageLayoutScheduler\)/u)
  assert.match(scheduleSource, /activePageLayoutScheduler\(recalculateScale\)/u)
  assert.match(scheduleSource, /restoreDocumentScrollPositions\(positions\)/u,
    '没有页面缩放调度器时必须在当前 DOM 更新后立即恢复双栏位置')
  assert.match(scheduleSource, /pendingTranslationLayoutScrollPositions = null/u)
  assert.match(scheduleSource, /translationLayoutUpdating = false/u)
  assert.match(patchSource, /try\s*\{/u, '流式 DOM 更新必须捕获异常')
  assert.match(patchSource, /finally\s*\{/u, '流式 DOM 更新必须通过 finally 清理保护状态')
})

test('文件翻译原位更新成功后不能取消刚登记的页面布局帧', () => {
  const source = read('src/renderer/src/document.ts')
  const patchStart = source.indexOf('function patchTranslationPreview(')
  const patchSource = source.slice(patchStart, source.indexOf('/**', patchStart + 1))

  assert.match(patchSource, /let layoutScheduled = false/u)
  assert.match(patchSource, /scheduleTranslationPageLayout\(\)\s*\n\s*layoutScheduled = true/u,
    '成功登记布局帧后必须标记为已调度')
  assert.match(patchSource, /if \(!layoutScheduled\) cancelTranslationPageLayout\(\)/u,
    '只有未成功调度时才允许清理布局保护状态')
})

test('PDF 页面高度流式增长时不能重复写入页面缩放变量', () => {
  const source = read('src/renderer/src/document.ts')
  const observeStart = source.indexOf('function observeTranslationPageScale(')
  const observeSource = source.slice(observeStart, source.indexOf('/**', observeStart + 1))

  assert.match(observeSource, /recalculateScale\s*=\s*false/u)
  assert.match(observeSource, /recalculateScalePending/u)
  assert.match(observeSource, /entry\.target !== scrollContainer/u,
    '只有译文滚动容器才允许参与页面缩放判断')
  assert.match(observeSource, /entry\.contentRect\.width/u,
    '必须比较实际内容宽度，不能把容器高度变化当作宽度变化')
  assert.match(observeSource, /scheduleLayout\(true\)/u)
  assert.match(observeSource, /scheduleLayout\(false\)/u,
    '页面自身高度变化只能触发流式布局归一化')
  assert.match(observeSource, /lastScaleWidth/u)
  assert.match(observeSource, /Math\.abs\(availableWidth - lastScaleWidth\)/u,
    '可用宽度没有实际变化时不能重复写入缩放变量')
  assert.match(observeSource, /if \(lastScaleWidth === null \|\| shouldRecalculateScale\)\s*\{\s*lastScaleWidth = availableWidth/su,
    '首次布局后必须记录宽度基准，后续高度变化不能再次触发缩放')
})

test('PDF 译文页面高度变化必须与滚动容器宽度变化分开处理', () => {
  const source = read('src/renderer/src/document.ts')
  const observeStart = source.indexOf('function observeTranslationPageScale(')
  const observeSource = source.slice(observeStart, source.indexOf('/**', observeStart + 1))
  const renderStart = source.indexOf('function renderDocumentModel(')
  const renderSource = source.slice(renderStart, source.indexOf('/**', renderStart + 1))

  assert.match(observeSource, /function observeTranslationPageScale\(\s*scrollContainer: HTMLElement,\s*previewHost: HTMLElement\s*\)/u,
    '宽度基准必须来自滚动容器，页面宿主只能参与高度观察')
  assert.match(observeSource, /documentPageContentWidth\(scrollContainer\)/u,
    '缩放宽度必须只从滚动容器测量')
  assert.match(observeSource, /entry\.contentRect\.width/u,
    '滚动容器高度变化不能冒充宽度变化')
  assert.match(observeSource, /lastObservedScrollWidth/u,
    '必须保存实际观察到的容器宽度以过滤高度回调')
  assert.match(observeSource, /observer\.observe\(scrollContainer\)/u)
  assert.match(observeSource, /observer\.observe\(previewHost\)/u)
  assert.match(renderSource, /observeTranslationPageScale\(container, previewHost\)/u)
  assert.doesNotMatch(renderSource, /observeTranslationPageScale\(previewHost\)/u)
})

test('PDF 译文流式页面必须在首次渲染后建立宽度基准，且高度回调不能携带缩放请求', () => {
  const source = read('src/renderer/src/document.ts')
  const renderStart = source.indexOf('function renderDocumentModel(')
  const renderSource = source.slice(renderStart, source.indexOf('/**', renderStart + 1))
  const observeStart = source.indexOf('function observeTranslationPageScale(')
  const observeSource = source.slice(observeStart, source.indexOf('/**', observeStart + 1))

  assert.match(
    renderSource,
    /if \(side === 'translation' && \(kind === 'paged' \|\| model\.source\.format === 'html'\)\)\s*\{\s*observeTranslationPageScale\(container, previewHost\)/su,
    'PDF 分页译文必须建立页面宽度基准，其他流式预览不应注册页面缩放观察器'
  )
  assert.match(observeSource, /scheduleLayout\(false\)/u,
    '页面高度变化只能请求流式归一化，不能携带宽度重算标记')
  assert.doesNotMatch(observeSource, /else\s+scheduleLayout\(true\)/u,
    '高度回调不得被解释为宽度变化')
  assert.match(
    observeSource,
    /const changed = lastObservedScrollWidth !== null &&\s*Math\.abs\(nextWidth - lastObservedScrollWidth\) >= 0\.5/u,
    '首次观察必须只建立容器宽度基准，不能把尚未测量的容器当成宽度变化'
  )
  assert.match(
    observeSource,
    /const sourceWidth = Number\(page\.dataset\.sourceWidth\)[\s\S]*availableWidth \/ sourceWidth/u,
    '宽度变化时必须按每页自身原始宽度重算缩放，不能使用第一页宽度作为统一基准'
  )
})

test('PDF 横竖混排译文必须在每页首次挂载时使用自己的宽度计算缩放', () => {
  const source = read('src/renderer/src/document.ts')
  const renderStart = source.indexOf('function renderDocumentModel(')
  const renderSource = source.slice(renderStart, source.indexOf('/**', renderStart + 1))

  assert.match(
    renderSource,
    /for \(const page of model\.pages\)[\s\S]*const pageScale = side === 'translation'\s*\? initialTranslationPageScale\(container, page\.width\)\s*: 1[\s\S]*const pageRenderSide = tab\.ocrDisplayMode === 'ocr-text' && model\.source\.format === 'image'\s*\? 'source'\s*: side[\s\S]*previewHost\.append\(renderPage\(page, pageRenderSide, pageScale, jobId, tab\)\)/u,
    '每页必须在挂载前按自身原始宽度计算缩放，横竖混排时不能先沿用第一页比例'
  )
  assert.doesNotMatch(renderSource, /initialTranslationPageScale\(container, model\.pages\[0\]/u,
    '不能用第一页宽度作为所有译文页的统一缩放基准')
})

test('PDF 译文流式重排不得重复写入未变化的间距样式', () => {
  const source = read('src/renderer/src/document.ts')
  const helperStart = source.indexOf('function setCssPixelPropertyIfChanged(')
  const normalizeStart = source.indexOf('function normalizeTranslationFlowLayout(')
  const helperSource = source.slice(helperStart, normalizeStart)
  const normalizeSource = source.slice(normalizeStart, source.indexOf('/**', normalizeStart + 1))

  assert.ok(helperStart > -1 && normalizeStart > helperStart)
  assert.match(helperSource, /getPropertyValue\(property\)/u)
  assert.match(helperSource, /Math\.abs\(currentValue - value\) < 0\.01/u,
    '间距值未变化时不能再次触发样式失效')
  assert.match(normalizeSource, /setCssPixelPropertyIfChanged\(child, '--document-flow-gap-before'/u)
  assert.match(normalizeSource, /setCssPixelPropertyIfChanged\(child, '--document-image-flow-gap-before'/u)
  assert.match(normalizeSource, /setCssPixelPropertyIfChanged\(child, '--document-shape-flow-offset'/u)
})

test('文件翻译译文滚动容器必须禁用浏览器滚动锚定', () => {
  const css = read('src/renderer/src/document.css')

  assert.match(
    css,
    /#document-translation-content\s*\{[^}]*overflow-anchor:\s*none/u
  )
})

test('文档扫描页 OCR 必须使用保留原始栅格尺寸的文档预处理配置', () => {
  const main = read('src/main/index.ts')
  const serviceStart = main.indexOf('function createDocumentWorkspaceTaskService')
  const serviceEnd = main.indexOf('/**', serviceStart + 1)
  const serviceSource = main.slice(serviceStart, serviceEnd)

  assert.match(serviceSource, /preprocessingProfile:\s*'document'/u)
})

test('文档翻译请求必须携带顶部栏选择的语言并在切换后重译', () => {
  const source = read('src/renderer/src/document.ts')
  const start = source.indexOf('async function startDocumentTabTranslation')
  const end = source.indexOf('async function startDocumentTranslation', start)
  const startSource = source.slice(start, end)

  assert.match(source, /async function retranslateDocumentAfterLanguageChange\(/u)
  assert.match(source, /await cancelDocumentJob\(jobId, jobGeneration\)/u)
  assert.match(source, /await startDocumentTabTranslation\(tab\)/u)
  assert.match(startSource, /const sourceLang = tab\.sourceLang/u)
  assert.match(startSource, /const targetLang = tab\.targetLang/u)
  assert.match(startSource, /sourceLang,\s*targetLang,\s*mode/u)
})

test('上传态必须通过可键盘操作的拖放区和文件选择器读取文件', () => {
  const html = read('src/renderer/document.html')
  const source = read('src/renderer/src/document.ts')
  assert.match(html, /id="document-drop-zone"[^>]*tabindex="0"[^>]*role="button"/u)
  assert.match(source, /addEventListener\('dragover'/u)
  assert.match(source, /addEventListener\('drop'/u)
  assert.match(source, /addEventListener\('keydown'/u)
  assert.match(source, /documentFileInput\.click\(\)/u)
  assert.match(source, /input\.files/u)
  assert.match(source, /chooseDocumentFiles\(\)/u)
  assert.match(source, /inspectBrowserFiles\(Array\.from\(input\.files \?\? \[\]\)\)/u)
  assert.match(source, /inspectBrowserFiles\(Array\.from\(event\.dataTransfer\?\.files \?\? \[\]\)\)/u)
  assert.match(source, /window\.api\.approveDocumentFiles\(/u)
})

test('文档窗口必须复用单实例并接入窗口控制与 Dock 可见性', () => {
  assert.equal(existsSync('src/main/documentWorkspaceWindow.ts'), true)
  const manager = read('src/main/documentWorkspaceWindow.ts')
  assert.match(manager, /export class DocumentWorkspaceManager/u)
  assert.match(manager, /async open\(/u)
  assert.match(manager, /focusOrOpenExistingWindow/u)
  assert.match(manager, /loadRenderer\(window, 'document\.html'\)/u)
  assert.match(manager, /minWidth/u)
  assert.match(manager, /minHeight/u)
  assert.match(manager, /getDocumentPlatformCapability/u)
  assert.match(manager, /document\.error\.unsupportedPlatform/u)
  const main = read('src/main/index.ts')
  assert.match(main, /new DocumentWorkspaceManager/u)
  assert.match(main, /documentWorkspaceOpen/u)
  assert.match(read('src/main/dockVisibility.ts'), /documentWorkspaceOpen/u)
})

test('文档工作台必须使用主题变量、自适应布局和可访问进度区域', () => {
  const css = read('src/renderer/src/document.css')
  const html = read('src/renderer/document.html')
  assert.match(css, /display:\s*(?:flex|grid)/u)
  assert.match(css, /min-height:\s*0/u)
  assert.match(css, /var\(--[a-z-]+\)/u)
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/iu)
  assert.match(html, /role="progressbar"/u)
  assert.match(html, /aria-live="polite"/u)
  assert.match(html, /aria-valuemin="0"/u)
  assert.match(html, /aria-valuemax="100"/u)
})

test('文档入口必须具备中英文词条和 preload 白名单 API', () => {
  const zh = read('src/shared/i18n/catalog.zh-CN.document.ts')
  const en = read('src/shared/i18n/catalog.en-US.document.ts')
  const types = read('src/shared/types.ts')
  const preload = read('src/preload/index.ts')
  assert.match(zh, /'document\.upload\.dropHint'/u)
  assert.match(en, /'document\.upload\.dropHint'/u)
  assert.match(types, /openDocumentWorkspace\(\): void/u)
  assert.match(types, /selectDocumentFiles\(\): Promise<DocumentFileSelectionResult\[\]>/u)
  assert.match(preload, /ipcRenderer\.send\('document:open'\)/u)
  assert.match(preload, /ipcRenderer\.invoke\('document:select-files'\)/u)
})

test('翻译弹窗、托盘与设置页都必须提供受能力约束的文档入口', () => {
  const popupHtml = read('src/renderer/index.html')
  const popup = read('src/renderer/src/popup.ts')
  const popupCss = read('src/renderer/src/style.css')
  const settingsHtml = read('src/renderer/settings.html')
  const settings = read('src/renderer/src/settings.ts')
  const main = read('src/main/index.ts')

  assert.match(popupHtml, /id="open-document-translation"/u)
  assert.match(
    popupHtml,
    /<button(?=[^>]+id="open-document-translation")(?=[^>]+class="header-action-button")(?=[^>]+data-i18n-attr="[^"]*popup\.openDocumentTranslation[^"]*")[^>]*>[\s\S]*?<svg[^>]+class="header-action-icon document-translation-icon"/u
  )
  assert.doesNotMatch(
    popupHtml,
    /<button(?=[^>]+id="open-document-translation")[^>]+data-i18n="popup\.openDocumentTranslation"/u,
    '文档翻译图标按钮不能绑定 data-i18n，否则国际化会覆盖内部 SVG 并显示文字'
  )
  assert.match(popup, /getDocumentPlatformCapability\(\)/u)
  assert.match(popup, /openDocumentWorkspace\(\)/u)
  assert.match(popupCss, /#open-document-translation:hover/u)

  assert.match(settingsHtml, /data-i18n="settings\.document\.title"/u)
  assert.match(settingsHtml, /id="open-document-translation"/u)
  assert.match(settings, /getDocumentPlatformCapability\(\)/u)
  assert.match(settings, /openDocumentWorkspace\(\)/u)

  assert.match(main, /menu\.openDocumentTranslation/u)
  assert.match(main, /document:open/u)
  assert.match(main, /document:select-files/u)
  assert.match(main, /document:get-platform-capability/u)
})

test('文档窗口必须接入主进程生命周期、窗口控制与状态持久化', () => {
  const main = read('src/main/index.ts')
  const manager = read('src/main/documentWorkspaceWindow.ts')
  assert.match(main, /new DocumentWorkspaceManager/u)
  assert.match(main, /documentWorkspace\.setTitle/u)
  assert.match(main, /documentWorkspace\?\.dispose\(\)/u)
  assert.match(main, /documentWorkspace\?\.ownsWindow/u)
  assert.match(main, /loadDocumentWindowState/u)
  assert.match(main, /saveDocumentWindowState/u)
  assert.match(manager, /setTitle\(/u)
  assert.doesNotMatch(manager, /backgroundColor:\s*['"]#/u)
})

test('文档窗口管理器必须提供受控窗口读取与事件发送入口', () => {
  const manager = read('src/main/documentWorkspaceWindow.ts')
  assert.match(manager, /getWindow\(\): BrowserWindow \| null/u)
  assert.match(manager, /send\(channel: string, payload: unknown\): boolean/u)
  assert.match(manager, /webContents\.send\(channel, payload\)/u)
})

test('文档工作台必须接入运行、取消、导出、进度与资源事件', () => {
  const html = read('src/renderer/document.html')
  const source = read('src/renderer/src/document.ts')
  const types = read('src/shared/types.ts')
  const preload = read('src/preload/index.ts')
  const main = read('src/main/index.ts')

  assert.match(html, /id="document-cancel-button"/u)
  assert.match(html, /id="document-partial-status"/u)
  assert.match(source, /runDocument\(/u)
  assert.match(source, /cancelDocument\(/u)
  assert.match(source, /exportDocumentPdf\(/u)
  assert.match(source, /onDocumentProgress\(/u)
  assert.match(source, /onDocumentCompleted\(/u)
  assert.match(source, /getDocumentAsset\(/u)
  assert.match(source, /requestAnimationFrame\(/u)
  assert.match(source, /createElement\(/u)
  assert.doesNotMatch(source, /innerHTML\s*=\s*[^'"`]*translation/u)
  assert.match(types, /runDocument\(/u)
  assert.match(types, /cancelDocument\(/u)
  assert.match(types, /exportDocumentPdf\(/u)
  assert.match(types, /getDocumentAsset\(/u)
  assert.match(preload, /document:run/u)
  assert.match(preload, /document:cancel/u)
  assert.match(preload, /document:retry-failed/u)
  assert.match(preload, /document:export-pdf/u)
  assert.match(preload, /document:get-asset/u)
  assert.match(main, /document:run/u)
  assert.match(main, /document:cancel/u)
  assert.match(main, /document:retry-failed/u)
  assert.match(main, /document:export-pdf/u)
  assert.match(main, /document:get-asset/u)
  assert.match(types, /approveDocumentFile\(/u)
  assert.match(preload, /document:approve-file/u)
  assert.match(main, /document:approve-file/u)
  assert.match(main, /new DocumentWorkspaceTaskService/u)
})

test('文档块级翻译增量必须通过受控 IPC 原位更新当前任务界面', () => {
  const types = read('src/shared/types.ts')
  const preload = read('src/preload/index.ts')
  const main = read('src/main/index.ts')
  const source = read('src/renderer/src/document.ts')
  const handlerStart = source.indexOf('window.api.onDocumentBlockTranslated(')
  const handlerEnd = source.indexOf('window.api.onDocumentCompleted(', handlerStart)
  const handler = source.slice(handlerStart, handlerEnd)

  assert.match(types, /DocumentWorkspaceTranslationUpdate/u)
  assert.match(
    types,
    /onDocumentBlockTranslated\(\s*callback: \(update: DocumentWorkspaceTranslationUpdate\) => void\s*\): \(\) => void/u
  )
  assert.match(
    preload,
    /onDocumentBlockTranslated\(callback: \(update: DocumentWorkspaceTranslationUpdate\) => void\)/u
  )
  assert.match(preload, /ipcRenderer\.on\('document:block-translated', listener\)/u)
  assert.match(preload, /removeListener\('document:block-translated', listener\)/u)
  assert.match(
    main,
    /sendTranslationUpdate:\s*\(update\) => \{\s*documentWorkspace\?\.send\(DOCUMENT_WORKSPACE_CHANNELS\.blockTranslated, update\)/su
  )
  assert.ok(handlerStart > -1, 'Renderer 必须订阅文档块级翻译增量')
  assert.match(handler, /const tab = findDocumentTabByTranslationUpdate\(update\)/u)
  assert.match(handler, /const snapshot = tab\?\.snapshot/u)
  assert.match(handler, /!tab \|\| !snapshot/u)
  assert.match(handler, /snapshot\.jobId !== update\.jobId/u)
  assert.match(handler, /snapshot\.generation !== update\.generation/u)
  assert.match(handler, /applyDocumentWorkspaceTranslationUpdate\(snapshot, update\)/u)
  assert.match(handler, /next === snapshot/u)
  assert.match(handler, /updateDocumentTabSnapshot\(tab, next\)/u)
  assert.match(handler, /scheduleSnapshotRenderForTab\(tab, next\)/u)
})

test('失败块必须支持单目标重试并显示可定位状态，但不在译文区显示操作角标', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const types = read('src/shared/types.ts')
  const preload = read('src/preload/index.ts')
  const main = read('src/main/index.ts')
  const channels = read('src/shared/documentWorkspace.ts')
  const zh = read('src/shared/i18n/catalog.zh-CN.document.ts')
  const en = read('src/shared/i18n/catalog.en-US.document.ts')

  assert.match(channels, /retryFailedTarget:\s*'document:retry-failed-target'/u)
  assert.match(types, /retryFailedDocumentTarget\(\s*jobId: string,\s*generation: number,\s*targetId: string\s*\): Promise<DocumentRunResult>/u)
  assert.match(preload, /retryFailedDocumentTarget:\s*\(jobId: string, generation: number, targetId: string\)/u)
  assert.match(preload, /ipcRenderer\.invoke\('document:retry-failed-target', jobId, generation, targetId\)/u)
  assert.match(main, /ipcMain\.handle\('document:retry-failed-target'/u)
  assert.match(main, /normalizeDocumentTargetId\(targetId\)/u)
  assert.match(main, /parseDocumentTargetId\(normalizedTargetId\)/u)

  assert.match(source, /function markDocumentTargetStatuses\(/u)
  assert.match(source, /data-translation-status.*failed/su)
  assert.match(source, /function retryFailedDocumentTarget\(/u)
  assert.match(source, /window\.api\.retryFailedDocumentTarget\(/u)
  assert.match(source, /findDocumentTarget\(/u)
  assert.doesNotMatch(source, /document-block-retry/u)
  assert.doesNotMatch(source, /document-block-badge/u)
  assert.doesNotMatch(source, /document\.badge\.(ocr|formula|table|cache)/u)
  assert.doesNotMatch(source, /document\.retryBlock/u)
  assert.match(css, /\.document-translation-failed\b/u)
  assert.doesNotMatch(css, /\.document-block-(?:badge|retry)\b/u)
  assert.match(css, /var\(--status-error\)/u)
  assert.doesNotMatch(zh, /'document\.badge\.(?:ocr|formula|table|cache)'/u)
  assert.doesNotMatch(zh, /'document\.retryBlock'/u)
  assert.doesNotMatch(en, /'document\.badge\.(?:ocr|formula|table|cache)'/u)
  assert.doesNotMatch(en, /'document\.retryBlock'/u)
})

test('生产 PDF 导出必须分流 OCR 原文双层导出与普通译文打印', () => {
  const main = read('src/main/index.ts')

  assert.match(main, /import \{ printDocumentPreviewToPdf \} from '\.\/documentPdfPrint'/u)
  assert.match(main, /import \{ exportDocumentToPdf \} from '\.\/documentPdfExport'/u)
  assert.match(
    main,
    /exportPdf:\s*\(model,\s*dependencies,\s*exportOptions\)\s*=>\s*\{[\s\S]*?if \(exportOptions\.sourceOnly\)[\s\S]*?exportDocumentToPdf\(model,\s*dependencies,\s*\{[\s\S]*?includeOcrTextLayer:\s*exportOptions\.textLayer !== false/u
  )
  assert.match(
    main,
    /documentWorkspace\?\.getWindow\(\)[\s\S]*?printDocumentPreviewToPdf\(\s*window\.webContents,\s*model,\s*exportOptions\.partialExport,\s*exportOptions\.textLayer,\s*exportOptions\.layout,\s*exportOptions\.signal,\s*exportOptions\.onProgress\s*\)/u
  )
})

test('文档工作台必须提供完整导出对话框与导出进度闭环', () => {
  const html = read('src/renderer/document.html')
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const types = read('src/shared/types.ts')
  const preload = read('src/preload/index.ts')
  const main = read('src/main/index.ts')
  const zh = read('src/shared/i18n/catalog.zh-CN.document.ts')
  const en = read('src/shared/i18n/catalog.en-US.document.ts')

  assert.match(html, /<dialog[^>]+id="document-export-dialog"/u)
  assert.match(html, /id="document-export-layout-translation"/u)
  assert.match(html, /id="document-export-layout-bilingual"/u)
  assert.match(html, /id="document-export-incomplete"/u)
  assert.match(html, /id="document-export-warning-count"/u)
  assert.match(html, /id="document-export-retry"/u)
  assert.match(html, /id="document-export-confirm"/u)
  assert.match(html, /id="document-export-cancel"/u)
  assert.match(html, /id="document-export-progress"/u)
  assert.match(html, /id="document-export-progress-stage"/u)
  assert.match(html, /id="document-export-progress-page"/u)
  assert.match(html, /id="document-export-open-folder"/u)

  assert.match(source, /function openDocumentExportDialog\(/u)
  assert.match(source, /function updateDocumentExportProgress\(/u)
  assert.match(source, /layout:\s*selectedDocumentExportLayout/u)
  assert.match(source, /mode:\s*.*partial/su)
  assert.match(source, /onDocumentExportProgress\(/u)
  assert.match(source, /cancelDocumentExport\(/u)
  assert.match(source, /openDocumentExportFolder\(/u)
  assert.match(css, /\.document-export-dialog/u)
  assert.match(css, /\.document-export-progress/u)
  assert.match(css, /var\(--/u)

  assert.match(types, /DocumentExportProgress/u)
  assert.match(types, /cancelDocumentExport\(jobId: string, generation: number\)/u)
  assert.match(types, /openDocumentExportFolder\(jobId: string, generation: number\)/u)
  assert.match(types, /onDocumentExportProgress\(/u)
  assert.match(preload, /document:cancel-export/u)
  assert.match(preload, /document:open-export-folder/u)
  assert.match(preload, /document:export-progress/u)
  assert.match(preload, /removeListener\('document:export-progress', listener\)/u)
  assert.match(main, /ipcMain\.handle\('document:cancel-export'/u)
  assert.match(main, /ipcMain\.handle\('document:open-export-folder'/u)
  assert.match(main, /sendExportProgress:/u)
  assert.match(main, /openExportFolder:/u)

  assert.match(zh, /'document\.export\.layout\.translation'/u)
  assert.match(zh, /'document\.export\.layout\.bilingual'/u)
  assert.match(en, /'document\.export\.layout\.translation'/u)
  assert.match(en, /'document\.export\.layout\.bilingual'/u)
})

test('文档 IPC 必须在主进程规范化请求并只使用已批准路径', () => {
  const main = read('src/main/index.ts')
  const runStart = main.indexOf("ipcMain.handle('document:run'")
  const exportStart = main.indexOf("ipcMain.handle('document:export-pdf'")
  const cancelExportStart = main.indexOf("ipcMain.handle('document:cancel-export'")
  const openFolderStart = main.indexOf("ipcMain.handle('document:open-export-folder'")

  assert.ok(runStart >= 0)
  assert.ok(exportStart > runStart)
  assert.ok(cancelExportStart > exportStart)
  assert.ok(openFolderStart > cancelExportStart)

  const runBlock = main.slice(runStart, exportStart)
  assert.match(runBlock, /normalizeDocumentRunRequest\(request\)/u)
  assert.match(runBlock, /isAbsolute\(normalizedRequest\.path\)/u)
  assert.match(runBlock, /service\.run\(normalizedRequest,/u)
  assert.doesNotMatch(runBlock, /service\.run\(request as DocumentRunRequest/u)

  const exportBlock = main.slice(exportStart, cancelExportStart)
  assert.match(exportBlock, /normalizeDocumentExportRequest\(request\)/u)
  assert.match(exportBlock, /invalid-request/u)
  assert.doesNotMatch(exportBlock, /exportPdf\(request as DocumentExportRequest\)/u)

  const cancelBlock = main.slice(cancelExportStart, openFolderStart)
  assert.match(cancelBlock, /isDocumentWorkspaceSender\(event\.sender\)/u)
  assert.match(cancelBlock, /normalizeDocumentExportCancelRequest/u)
  assert.match(cancelBlock, /cancelExport\(/u)

  const openFolderBlock = main.slice(openFolderStart, main.indexOf("ipcMain.handle('document:list-history'"))
  assert.match(openFolderBlock, /isDocumentWorkspaceSender\(event\.sender\)/u)
  assert.match(openFolderBlock, /normalizeDocumentOpenExportFolderRequest/u)
  assert.match(openFolderBlock, /openExportFolder\(/u)
})

test('文档日志必须只记录稳定分类，ETA 必须固定首次进度时间', () => {
  const source = read('src/renderer/src/document.ts')

  assert.doesNotMatch(source, /console\.error\([^\n]*,\s*(?:pageNumber|error)\)/u)
  assert.doesNotMatch(source, /console\.error\([^\n]*(?:error\.message|String\(error\))/u)
  assert.match(source, /console\.error\('document-pdf-page-render-failed', error instanceof Error \? error\.name : 'unknown'\)/u)
  assert.match(source, /console\.error\('document-pdf-preview-failed', error instanceof Error \? error\.name : 'unknown'\)/u)
  assert.match(source, /console\.error\('document-model-render-failed', error instanceof Error \? error\.name : 'unknown'\)/u)
  assert.match(source, /function routeDocumentSnapshot\([\s\S]*?documentTaskStartedAt/u)
  assert.match(
    source,
    /const taskKey = `\$\{snapshot\.jobId\}:\$\{snapshot\.generation\}`[\s\S]*?documentTaskStartedAt\.has\(taskKey\)/u
  )
})

test('部分导出必须经过原生确认对话框并明确标记部分结果', () => {
  const html = read('src/renderer/document.html')
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const zh = read('src/shared/i18n/catalog.zh-CN.document.ts')
  const en = read('src/shared/i18n/catalog.en-US.document.ts')

  assert.match(html, /<dialog[^>]+id="document-partial-export-dialog"/u)
  assert.match(html, /id="document-partial-export-retry"/u)
  assert.match(html, /id="document-partial-export-confirm"/u)
  assert.match(html, /id="document-partial-export-cancel"/u)
  assert.match(source, /completionReport\.failed/u)
  assert.match(source, /completionReport\.pending/u)
  assert.match(source, /completionReport\.suspectUntranslated/u)
  assert.match(source, /mode:\s*'partial'/u)
  assert.match(source, /mode:\s*'complete'/u)
  assert.match(source, /dataset\.rowId\s*=\s*row\.rowId/u)
  assert.match(source, /document-partial-export-dialog/u)
  assert.match(source, /partialExportRetryButton\.addEventListener\('click'/u)
  assert.match(source, /partialExportConfirmButton\.addEventListener\('click'/u)
  assert.match(source, /partialExportCancelButton\.addEventListener\('click'/u)
  assert.match(css, /\.document-partial-export-dialog/u)
  assert.match(css, /\.document-partial-export-notice/u)
  assert.match(css, /\[data-incomplete-target='true'\]/u)
  assert.doesNotMatch(zh, /'document\.partialSummary':\s*'已完成翻译/u)
  assert.match(zh, /'document\.partialSummary':[^\n]+部分结果/u)
  assert.match(en, /'document\.partialSummary':[^\n]+partial/iu)
})

test('打印前必须通过受控预览接口准备和恢复部分导出标记', () => {
  const source = read('src/renderer/src/document.ts')

  assert.match(source, /__documentPrintPreview/u)
  assert.match(source, /preparePartialExport/u)
  assert.match(source, /restorePrintPreview/u)
  assert.match(source, /document-partial-export-notice/u)
  assert.match(source, /latestSnapshot/u)
})

test('文档工作台初始化必须真正接线任务按钮、进度事件与双栏滚动同步', () => {
  const source = read('src/renderer/src/document.ts')
  assert.match(source, /startButton\.addEventListener\('click',\s*\(\)\s*=>\s*void startDocumentTranslation\(\)\)/u)
  assert.match(source, /cancelButton\.addEventListener\('click',\s*\(\)\s*=>\s*void cancelDocumentTranslation\(\)\)/u)
  assert.match(source, /retryButton\.addEventListener\('click',\s*\(\)\s*=>\s*void retryFailedDocumentTranslation\(\)\)/u)
  assert.match(source, /exportButton\.addEventListener\('click',\s*\(\)\s*=>\s*void exportTranslatedPdf\(\)\)/u)
  assert.match(source, /window\.api\.onDocumentProgress\(/u)
  assert.match(source, /window\.api\.onDocumentCompleted\(/u)
  assert.match(source, /sourceContent\.addEventListener\('scroll'/u)
  assert.match(source, /translationContent\.addEventListener\('scroll'/u)
  assert.match(source, /handleDocumentScroll\('source'\)/u)
  assert.match(source, /handleDocumentScroll\('translation'\)/u)
  assert.match(source, /function handleDocumentScroll\(side: DocumentScrollSide\): void/u)
  assert.match(source, /const target = side === 'source' \? translationContent : sourceContent/u)
  assert.match(source, /syncScroll\(source, target\)/u)
  assert.match(source, /expectedJobId !== null/u)
  assert.match(source, /runDocument\(/u)
  assert.match(source, /function documentPreviewIdentity\(/u)
  assert.match(source, /model\.source\.format === 'pdf' \|\| model\.source\.format === 'image'/u)
  assert.match(source, /return `\$\{model\.source\.format\}:\$\{model\.source\.sha256\}`/u)
  assert.match(source, /renderedSourcePreviewIdentity/u)
  assert.match(source, /renderedTranslationSignature/u)
  assert.doesNotMatch(source, /renderedSource !== snapshot\.source/u)
  assert.doesNotMatch(source, /renderedTranslation !== snapshot\.translation/u)
})

test('文档终态与导出前必须同步刷新最新译文快照，不能停留在流式部分译文', () => {
  const source = read('src/renderer/src/document.ts')
  const flushStart = source.indexOf('function flushSnapshotRenderForTab(')
  const flushEnd = source.indexOf('/**', flushStart + 1)
  const flushSource = source.slice(flushStart, flushEnd)
  const completedStart = source.indexOf("window.api.onDocumentCompleted(")
  const completedEnd = source.indexOf('sourceContent.addEventListener', completedStart)
  const completedSource = source.slice(completedStart, completedEnd)
  const exportStart = source.indexOf('async function exportTranslatedPdf(')
  const exportEnd = source.indexOf('/**', exportStart + 1)
  const exportSource = source.slice(exportStart, exportEnd)

  assert.ok(flushStart > -1, '必须提供可绕过帧合并的同步快照刷新入口')
  assert.match(flushSource, /cancelAnimationFrame\(pendingRenderFrame\)/u)
  assert.match(flushSource, /latestSnapshot = snapshot/u)
  assert.match(flushSource, /renderSnapshot\(snapshot, tab\)/u)
  assert.match(flushSource, /renderTaskState\(snapshot, tab\)/u)
  assert.match(completedSource, /routeDocumentSnapshot\(snapshot, true\)/u)
  assert.match(source, /flushSnapshotRenderForTab\(tab, snapshot\)/u)
  assert.match(exportSource, /flushSnapshotRenderForTab\(tab, snapshot\)/u)
})

test('译文栏首次快照必须立即渲染等待状态，避免初始签名相同导致空白', () => {
  const source = read('src/renderer/src/document.ts')
  const renderStart = source.indexOf('function renderSnapshot(')
  const renderEnd = source.indexOf('/**', renderStart + 1)
  const renderSource = source.slice(renderStart, renderEnd)

  assert.match(source, /let hasRenderedTranslation = false/u)
  assert.match(renderSource, /!hasRenderedTranslation\s*\|\|/u)
  assert.match(renderSource, /hasRenderedTranslation = true/u)
})

test('译文预览缓存必须绑定 Tab 与文件指纹，切换 Tab 后不得复用旧译文', () => {
  const source = read('src/renderer/src/document.ts')
  const renderStart = source.indexOf('function renderSnapshot(')
  const renderSource = source.slice(renderStart, source.indexOf('/**', renderStart + 1))
  const clearStart = source.indexOf('function clearActiveTabPreview()')
  const clearSource = source.slice(clearStart, source.indexOf('/**', clearStart + 1))
  const translationClearStart = source.indexOf('function clearActiveTabTranslationPreview()')
  const translationClearSource = source.slice(
    translationClearStart,
    source.indexOf('/**', translationClearStart + 1)
  )

  assert.match(source, /let renderedTranslationTabId: string \| null = null/u)
  assert.match(source, /let renderedTranslationSha256 = ''/u)
  assert.match(
    renderSource,
    /const canReuseRenderedTranslation =[\s\S]*?renderedTranslationTabId === tab\.id[\s\S]*?renderedTranslationSha256 === tab\.selection\.sha256/u,
    '只有同一 Tab 且文件指纹一致时才允许复用已渲染译文'
  )
  assert.match(
    renderSource,
    /const translationChanged = !hasRenderedTranslation \|\|[\s\S]*?!canReuseRenderedTranslation/u
  )
  assert.match(renderSource, /renderedTranslationTabId = tab\.id/u)
  assert.match(renderSource, /renderedTranslationSha256 = tab\.selection\.sha256/u)
  assert.match(clearSource, /renderedTranslationTabId = null/u)
  assert.match(clearSource, /renderedTranslationSha256 = ''/u)
  assert.match(translationClearSource, /renderedTranslationTabId = null/u)
  assert.match(translationClearSource, /renderedTranslationSha256 = ''/u)
})

test('HTML 非分页译文页面必须按内容自适应高度，不能被文本页默认高度裁切', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const renderPageStart = source.indexOf('function renderPage(')
  const renderPageEnd = source.indexOf('/**', renderPageStart + 1)
  const renderPageSource = source.slice(renderPageStart, renderPageEnd)
  const flowRule = /\.document-page\[data-layout='flow'\]\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''

  assert.match(
    source,
    /element\.dataset\.layout = side === 'translation' && hasGeometry\s*\? 'translation-flow'\s*: hasGeometry \? 'absolute' : 'flow'/u
  )
  assert.match(renderPageSource, /element\.dataset\.layout === 'translation-flow'/u)
  assert.doesNotMatch(renderPageSource, /element\.style\.minHeight\s*=/u)
  assert.match(flowRule, /height:\s*auto\s*!important/u)
  assert.match(flowRule, /min-height:\s*0\s*!important/u)
})

test('HTML 译文模型存在区块却渲染不出可见内容时必须显示明确空状态', () => {
  const source = read('src/renderer/src/document.ts')
  const renderStart = source.indexOf('function renderFlowDocument(')
  const renderEnd = source.indexOf('/**', renderStart + 1)
  const renderSource = source.slice(renderStart, renderEnd)

  assert.match(renderSource, /hasVisibleFlowContent/u)
  assert.match(renderSource, /document\.translationEmpty/u)
})

test('文档模型必须先在离屏节点构建成功，再一次性替换当前预览，避免异常导致译文栏空白', () => {
  const source = read('src/renderer/src/document.ts')
  const renderStart = source.indexOf('function renderDocumentModel(')
  const renderEnd = source.indexOf('/**', renderStart + 1)
  const renderSource = source.slice(renderStart, renderEnd)

  assert.doesNotMatch(renderSource, /^\s*container\.replaceChildren\(\)/mu)
  assert.match(renderSource, /const nextContent = document\.createDocumentFragment\(\)/u)
  assert.match(renderSource, /nextContent\.append\(previewHost\)/u)
  assert.match(renderSource, /container\.replaceChildren\(nextContent\)/u)
  assert.match(renderSource, /catch\s*(?:\([^)]*\))?\s*\{/u)
  assert.match(renderSource, /document\.renderFailed/u)
})

test('文档预览构建失败时必须恢复上一次成功内容，不能留下空白预览宿主', () => {
  const source = read('src/renderer/src/document.ts')
  const renderStart = source.indexOf('function renderDocumentModel(')
  const renderEnd = source.indexOf('/**', renderStart + 1)
  const renderSource = source.slice(renderStart, renderEnd)

  assert.match(renderSource, /const previousContent = document\.createDocumentFragment\(\)/u)
  assert.match(renderSource, /previousContent\.append\(\.\.\.container\.childNodes\)/u)
  assert.match(renderSource, /container\.replaceChildren\(previousContent\)/u)
})

test('HTML 译文必须按内容流式排版，避免译文换行后覆盖后续文本块', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const renderPageStart = source.indexOf('function renderPage(')
  const renderPageEnd = source.indexOf('/**', renderPageStart + 1)
  const renderPageSource = source.slice(renderPageStart, renderPageEnd)
  const flowStart = source.indexOf('function renderFlowDocument(')
  const flowEnd = source.indexOf('/**', flowStart + 1)
  const flowSource = source.slice(flowStart, flowEnd)
  const translationRule = /\.document-page\[data-layout='translation-flow'\]\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const textBlockRule = /\.document-page\[data-layout='translation-flow'\] \.document-text-block\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''

  // HTML 译文仍复用 PDF 的流式页面，但不能再经过固定高度的绝对定位画布。
  assert.doesNotMatch(source, /function renderHtmlTranslationPage/u)
  assert.doesNotMatch(source, /document-html-page-frame/u)
  assert.doesNotMatch(source, /preserveAbsoluteLayout/u)
  assert.match(renderPageSource, /element\.dataset\.layout = side === 'translation' && hasGeometry/u)
  assert.match(renderPageSource, /--document-flow-gap-before/u)
  assert.match(flowSource, /article\.append\(renderPage\(page, side, 1, jobId, tab\)\)/u)
  assert.match(translationRule, /height:\s*auto\s*!important/u)
  assert.match(translationRule, /min-height:\s*0\s*!important/u)
  assert.match(translationRule, /overflow:\s*visible/u)
  // 译文纸张自身不能继承预览卡片的边框，否则页面四周会出现多余外框。
  assert.match(translationRule, /border:\s*0/u)
  // 圆角和投影会在纸张边缘形成可见轮廓，译文纸张必须保持纯白直角边界。
  assert.match(translationRule, /border-radius:\s*0/u)
  assert.match(translationRule, /box-shadow:\s*none/u)
  assert.match(textBlockRule, /height:\s*auto\s*!important/u)
  assert.match(textBlockRule, /margin-top:\s*calc\(\s*var\(--document-flow-gap-before/u)
  assert.match(css, /\.document-page\[data-layout='translation-flow'\] \.document-text-block,[\s\S]*?position:\s*static/u)
  assert.match(css, /\.document-page\[data-layout='translation-flow'\] \.document-text-run[\s\S]*?font-size:\s*calc\([\s\S]*?var\(--document-page-scale/u)
  assert.doesNotMatch(css, /\.document-html-page-frame/u)
  assert.doesNotMatch(css, /\.document-html-page-canvas/u)
  assert.match(source, /availableWidth \/ sourceWidth/u)
})

test('任务启动必须等待 runDocument 返回 jobId，并在代际冲突时安全重试一次', () => {
  const source = read('src/renderer/src/document.ts')
  const start = source.indexOf('async function startDocumentTabTranslation(')
  const end = source.indexOf('/**', start + 1)
  const startSource = source.slice(start, end)
  assert.match(startSource, /let jobGeneration = nextGeneration\(\)/u)
  assert.match(startSource, /let result: DocumentRunResult = await window\.api\.runDocument/u)
  assert.match(startSource, /tab\.generation !== jobGeneration/u)
  assert.match(startSource, /result\.code === 'generation-conflict'/u)
  assert.match(startSource, /result\.suggestedGeneration/u)
  assert.match(startSource, /tab\.expectedJobId === null/u)
  assert.match(startSource, /tab\.snapshot === null/u)
  assert.match(startSource, /adoptSuggestedGeneration\(result\.suggestedGeneration\)/u)
  assert.match(source, /function canApplyDocumentTabProgressSnapshot\(/u)
  assert.match(source, /snapshot\.generation !== tab\.generation/u)
  assert.match(source, /tab\.expectedJobId/u)
})

test('终态完成后迟到的进度快照不得覆盖最终译文', () => {
  const source = read('src/renderer/src/document.ts')
  const progressStart = source.indexOf('window.api.onDocumentProgress(')
  const progressEnd = source.indexOf('window.api.onDocumentCompleted(', progressStart)
  const progressSource = source.slice(progressStart, progressEnd)

  assert.ok(progressStart > -1, '必须订阅文档进度事件')
  assert.match(progressSource, /routeDocumentSnapshot\(snapshot, false\)/u)
  assert.match(source, /canApplyDocumentTabProgressSnapshot\(tab, snapshot\)/u)
  assert.match(source, /canApplyDocumentTaskEvent\(/u)
  assert.match(source, /tab\.snapshot\.task/u)
})

test('PDF 预览必须使用 PDF.js 原生页面渲染而不是重建绝对定位文本', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const html = read('src/renderer/document.html')

  assert.match(source, /from 'pdfjs-dist\/legacy\/build\/pdf\.js'/u)
  assert.match(source, /from 'pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.js\?url'/u)
  assert.match(source, /GlobalWorkerOptions\.workerSrc/u)
  assert.match(source, /async function renderPdfPages/u)
  assert.match(source, /page\.render\(\{/u)
  assert.match(source, /canvasContext/u)
  assert.match(source, /getDocumentSource\(jobId\)/u)
  assert.match(source, /element\.dataset\.layout = side === 'translation' && hasGeometry/u)
  assert.match(css, /\.document-pdf-page\b/u)
  assert.match(css, /\.document-pdf-canvas\b/u)
  assert.match(css, /\.document-page\[data-layout='translation-flow'\]/u)
  assert.match(css, /\.document-page\[data-layout='translation-flow'\][\s\S]*?height:\s*auto\s*!important/u)
  assert.match(css, /\.document-page\[data-layout='translation-flow'\] \.document-text-run[\s\S]*?white-space:\s*normal/u)
  assert.match(source, /new ResizeObserver\(/u)
  assert.match(source, /--document-page-scale/u)
  assert.match(source, /dataset\.sourceWidth/u)
  assert.match(css, /font-size:\s*calc\(\s*var\(--document-run-font-size-px[^;]*var\(--document-page-scale/su)
  // 自定义属性必须自带 px 单位，再与无单位缩放系数相乘；避免依赖隐式单位换算。
  assert.match(source, /--document-run-font-size-px/u)
  assert.match(source, /--document-run-line-height-px/u)
  assert.match(
    css,
    /line-height:\s*calc\(\s*var\(\s*--document-run-line-height-px,[\s\S]*?var\(--document-page-scale/su
  )
  assert.match(css, /--document-run-line-height-px,\s*calc\(var\(--document-run-font-size-px,\s*12px\)\s*\*\s*1\.45\)/su)
  assert.doesNotMatch(css, /--document-run-font-size-pt/u)
  assert.doesNotMatch(css, /--document-run-line-height-pt/u)
  assert.doesNotMatch(css, /line-height:\s*1\.45\s*!important/u)
  assert.match(css, /gap:\s*0/u)
  assert.match(source, /--document-flow-gap-before/u)
  assert.match(source, /block\.bbox\.y - previousBottom/u)
  assert.doesNotMatch(css, /font-size:\s*inherit\s*!important/u)
  assert.doesNotMatch(css, /line-height:\s*inherit\s*!important/u)
  assert.match(html, /id="document-source-content"/u)
})

test('PDF 译文必须按原始区块 y 坐标保留段前距离，不能使用统一 flex gap', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const renderPageStart = source.indexOf('function renderPage(')
  const renderPageEnd = source.indexOf('/**', renderPageStart + 1)
  const renderPageSource = source.slice(renderPageStart, renderPageEnd)
  const translationRule = /\.document-page\[data-layout='translation-flow'\]\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const blockRule = /\.document-page\[data-layout='translation-flow'\] \.document-text-block\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''

  assert.match(renderPageSource, /previousBottom/u)
  assert.match(renderPageSource, /--document-flow-gap-before/u)
  assert.match(renderPageSource, /pdfFlowGapBefore\(block,\s*previousBlock,\s*previousBottom\)/u)
  assert.match(source, /Math\.max\(0,\s*block\.bbox\.y - previousBottom\)/u)
  assert.match(translationRule, /gap:\s*0/u)
  assert.match(blockRule, /margin-top:\s*calc\(\s*var\(--document-flow-gap-before,\s*0px\)[^;]*var\(--document-page-scale/su)
})

test('PDF 译文流式布局应使用基线推进，避免行盒高度与坐标间距重复叠加', () => {
  const source = read('src/renderer/src/document.ts')
  const renderPageStart = source.indexOf('function renderPage(')
  const renderPageEnd = source.indexOf('/**', renderPageStart + 1)
  const renderPageSource = source.slice(renderPageStart, renderPageEnd)

  assert.match(source, /function pdfFlowGapBefore\(/u)
  assert.match(renderPageSource, /pdfFlowGapBefore\(/u)
  assert.match(source, /baseline/u)
  assert.match(source, /lineHeight/u)
})

test('PDF 原文与译文必须共用同一页面可用宽度计算', () => {
  const source = read('src/renderer/src/document.ts')
  assert.match(source, /function documentPageAvailableWidth\(/u)
  assert.match(source, /function documentPageContentWidth\(/u)
  assert.equal((source.match(/documentPageAvailableWidth\(container\)/gu) ?? []).length >= 1, true)
  assert.equal((source.match(/documentPageContentWidth\(container\)/gu) ?? []).length >= 2, true)
  // 统一宽度公式只应封装在 helper 内，其他预览路径不得再直接复制留白计算。
  assert.equal((source.match(/getComputedStyle\(container\)/gu) ?? []).length, 1)
  assert.match(source, /--border-width/u)
  assert.match(source, /paddingLeft/u)
  assert.match(source, /paddingRight/u)
  assert.match(source, /baselineAdvance\s*<=\s*currentSize \* 3(?:\.0)?/u)
  assert.match(source, /applyScalableTextStyle\(span, effectiveTextStyle\(block, run\)\)/u)
  assert.match(source, /style\.lineHeight !== undefined/u)
  assert.match(source, /--document-run-line-height-px/u)
})

test('PDF 译文必须合并区块与 run 样式，保留原文字号、颜色、粗细、斜体、下划线和行高', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const helperStart = source.indexOf('function effectiveTextStyle(')
  const helperEnd = source.indexOf('/**', helperStart + 1)
  const helperSource = source.slice(helperStart, helperEnd)
  const renderTextStart = source.indexOf('function renderTextBlock(')
  const renderTextEnd = source.indexOf('/**', renderTextStart + 1)
  const renderTextSource = source.slice(renderTextStart, renderTextEnd)
  const renderRunsStart = source.indexOf('function renderTextRuns(')
  const renderRunsEnd = source.indexOf('/**', renderRunsStart + 1)
  const renderRunsSource = source.slice(renderRunsStart, renderRunsEnd)
  const gapStart = source.indexOf('function pdfFlowGapBefore(')
  const gapEnd = source.indexOf('/**', gapStart + 1)
  const gapSource = source.slice(gapStart, gapEnd)

  assert.match(helperSource, /\.\.\.block\.style/u)
  assert.match(helperSource, /\.\.\.run\.style/u)
  assert.match(renderTextSource, /effectiveTextStyle\(block, run\)/u)
  assert.match(renderRunsSource, /effectiveTextStyle\(block, run\)/u)
  assert.match(gapSource, /effectiveTextStyle\(block, block\.runs\[0\]\)/u)
  assert.match(gapSource, /effectiveTextStyle\(previousText, previousText\.runs\[0\]\)/u)
})

test('PDF 目录预览必须将标题、引导线和页码拆成不换行的语义元素', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const renderTextStart = source.indexOf('function renderTextBlock(')
  const renderTextEnd = source.indexOf('/**', renderTextStart + 1)
  const renderTextSource = source.slice(renderTextStart, renderTextEnd)

  assert.match(renderTextSource, /block\.toc/u)
  assert.match(renderTextSource, /document-toc-title/u)
  assert.match(renderTextSource, /document-toc-leader/u)
  assert.match(renderTextSource, /document-toc-page/u)
  assert.match(renderTextSource, /block\.toc\.pageNumber/u)
  assert.match(source, /toc:\s*block\.toc/u)
  assert.match(css, /\.document-text-toc\s*\{[^}]*display:\s*flex/su)
  assert.match(css, /\.document-toc-title\s*\{[^}]*min-width:\s*0/su)
  assert.match(css, /\.document-toc-leader\s*\{[^}]*border-bottom:\s*[^;]*dotted/su)
  assert.match(css, /\.document-toc-page\s*\{[^}]*white-space:\s*nowrap/su)
})

test('PDF 原文 Canvas 必须显式使用白色背景，避免空白页被合成成黑色', () => {
  const source = read('src/renderer/src/document.ts')
  const renderStart = source.indexOf('async function renderPdfPages(')
  const renderEnd = source.indexOf('/**', renderStart + 1)
  const renderSource = source.slice(renderStart, renderEnd)

  assert.match(renderSource, /getContext\('2d',\s*\{\s*alpha:\s*false\s*\}\)/u)
  assert.match(renderSource, /background:\s*'#ffffff'/u)
})

test('PDF 原文必须进入视口后再绘制 Canvas，并在替换预览时释放渲染资源', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const renderStart = source.indexOf('async function renderPdfPages(')
  const renderEnd = source.indexOf('/**', renderStart + 1)
  const renderSource = source.slice(renderStart, renderEnd)
  const observerStart = renderSource.indexOf('new IntersectionObserver')
  const renderCall = renderSource.indexOf('page.render({')

  assert.match(source, /pdfPreviewCleanups/u)
  assert.match(source, /pdfPreviewCleanups\.get\(container\)\?\.\(\)/u)
  assert.match(renderSource, /new IntersectionObserver/u)
  assert.match(renderSource, /rootMargin:\s*'[^']+'/u)
  assert.match(renderSource, /entry\.isIntersecting/u)
  assert.match(renderSource, /observer\.observe\(article\)/u)
  assert.ok(observerStart >= 0 && renderCall > observerStart,
    'Canvas 绘制必须发生在可见性回调触发的路径中')
  assert.match(renderSource, /pdfDocument\.destroy\(\)/u)
  assert.match(css, /\.document-pdf-page\s*\{[^}]*content-visibility:\s*auto/su)
  assert.match(css, /\.document-pdf-page\s*\{[^}]*contain-intrinsic-size:/su)
})

test('PDF 初始挂载必须同步建立页面占位，不能逐页等待 getPage 阻塞首屏', () => {
  const source = read('src/renderer/src/document.ts')
  const renderStart = source.indexOf('async function renderPdfPages(')
  const renderEnd = source.indexOf('/**', renderStart + 1)
  const renderSource = source.slice(renderStart, renderEnd)
  const mountStart = renderSource.indexOf('for (let pageNumber = 1')
  const mountEnd = renderSource.indexOf('sourcePageCount.textContent', mountStart)
  const mountSource = renderSource.slice(mountStart, mountEnd)

  assert.ok(mountStart >= 0 && mountEnd > mountStart, '必须存在页面占位挂载循环')
  assert.doesNotMatch(mountSource, /getPage\(/u,
    '页面占位挂载循环不能逐页等待 PDF.js getPage')
  assert.match(mountSource, /model\.pages\[pageNumber - 1\]/u,
    '占位尺寸必须来自已解析模型')
  assert.match(mountSource, /observer\.observe\(article\)/u,
    '挂载后的页面仍必须由可见性观察器按需渲染')
})

test('PDF 只有原文复用 PDF.js Canvas，译文必须重建结构化流式 DOM', () => {
  const source = read('src/renderer/src/document.ts')
  const renderStart = source.indexOf('function renderDocumentModel(')
  const renderEnd = source.indexOf('/**', renderStart + 1)
  const renderSource = source.slice(renderStart, renderEnd)

  assert.match(
    source,
    /async function renderPdfPages\(\s*container: HTMLElement,\s*model: DocumentModel,\s*jobId: string,\s*tab: DocumentWorkspaceTab\s*\)/u
  )
  assert.match(renderSource, /model\.source\.format === 'pdf' && side === 'source'/u)
  assert.match(renderSource, /void renderPdfPages\(previewHost, model, jobId, tab\)/u)
  assert.match(renderSource, /for \(const page of model\.pages\)[\s\S]*const pageScale = side === 'translation'/u)
  assert.match(renderSource, /renderPage\(page, pageRenderSide, pageScale, jobId, tab\)/u)
  assert.doesNotMatch(source, /createPdfTranslationOverlay/u)
})

test('PDF 译文必须保留真实表格、图片与代码框，不能退化为 Canvas 文本覆盖层', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const tableStart = source.indexOf('function renderTableBlock(')
  const tableSource = source.slice(tableStart, source.indexOf('/**', tableStart + 1))

  assert.match(source, /function renderPage\(/u)
  assert.match(source, /dataset\.layout = side === 'translation' && hasGeometry/u)
  assert.match(tableSource, /createElement\('table'\)/u)
  assert.match(tableSource, /createElement\('tr'\)/u)
  assert.match(tableSource, /createElement\('td'\)/u)
  assert.doesNotMatch(css, /document-pdf-translation-layer/u)
  assert.doesNotMatch(css, /document-pdf-translation-mask/u)
  assert.doesNotMatch(css, /document-pdf-translation-text/u)
  assert.doesNotMatch(css, /document-pdf-translation-copy/u)
})

test('PDF 译文流式增量必须原位更新结构化区块，不能重新加载 PDF 或重绘 Canvas', () => {
  const source = read('src/renderer/src/document.ts')
  const patchStart = source.indexOf('function patchTranslationPreview(')
  const patchEnd = source.indexOf('/**', patchStart + 1)
  const patchSource = source.slice(patchStart, patchEnd)

  assert.match(patchSource, /querySelectorAll<HTMLElement>\('\[data-block-id\]'\)/u)
  assert.match(patchSource, /patchTranslationBlock\(\s*block/u)
  assert.match(patchSource, /beginTranslationLayoutUpdate\(\)/u)
  assert.match(patchSource, /scheduleTranslationPageLayout\(\)/u)
  assert.doesNotMatch(patchSource, /renderPdfPages\(/u)
  assert.doesNotMatch(patchSource, /document-pdf-translation-layer/u)
})

test('PDF 表格必须提供稳定区块标识，流式增量才能原位更新而不整页重建', () => {
  const source = read('src/renderer/src/document.ts')
  const tableStart = source.indexOf('function renderTableBlock(')
  const tableSource = source.slice(tableStart, source.indexOf('/**', tableStart + 1))

  assert.match(
    tableSource,
    /wrapper\.dataset\.blockId\s*=\s*block\.blockId/u,
    '表格顶层容器必须写入 data-block-id，否则流式补丁无法定位表格并会反复整页重建'
  )
})

test('PDF 译文页面初次挂载不能先按 scale=1 排版再跳到实际缩放', () => {
  const source = read('src/renderer/src/document.ts')
  const renderStart = source.indexOf('function renderDocumentModel(')
  const renderSource = source.slice(renderStart, source.indexOf('/**', renderStart + 1))
  const renderPageStart = source.indexOf('function renderPage(')
  const renderPageSource = source.slice(renderPageStart, source.indexOf('/**', renderPageStart + 1))

  assert.match(source, /function initialTranslationPageScale\(/u,
    '译文页面必须使用统一函数计算首次缩放值')
  assert.match(renderSource, /initialTranslationPageScale\(container, page\.width\)/u,
    '渲染译文模型时必须按每页自身宽度计算缩放值')
  assert.match(renderPageSource, /String\(translationInitialScale\)/u,
    'renderPage 必须直接写入调用方计算好的缩放值')
  assert.doesNotMatch(renderPageSource, /--document-page-scale',\s*'1'/u)
  assert.match(renderSource, /renderPage\(page, pageRenderSide, pageScale, jobId, tab\)/u,
    '译文页面创建时必须传入按自身页面宽度计算出的缩放值')
})

test('PDF 译文段落不能覆盖 run 的原始字号与颜色', () => {
  const css = read('src/renderer/src/document.css')
  const blockRule = /\.document-page\[data-layout='translation-flow'\] \.document-text-block\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''

  assert.match(blockRule, /font-size:\s*inherit/u)
  assert.doesNotMatch(blockRule, /color:\s*var\(--document-paper-text\)/u)
})

test('PDF 译文必须按每个文本块自身边界锚定对齐，不能复用整页统一边界', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')

  assert.match(source, /function applyTranslationBlockGeometry\(/u)
  assert.match(source, /--document-block-left/u)
  assert.match(source, /--document-block-width/u)
  assert.match(source, /block\.textAlign === 'center'/u)
  assert.match(source, /block\.textAlign === 'right'/u)
  assert.match(source, /--document-block-right/u)
  assert.doesNotMatch(
    source,
    /element\.style\.setProperty\('--document-block-width', `\$\{Math\.max\(1, page\.width - minX \* 2\)\}px`\)/u
  )
  assert.match(css, /\.document-text-block\[data-align='center'\]/u)
  assert.match(css, /\.document-text-block\[data-align='right'\]/u)
  assert.match(css, /text-align:\s*center\s*!important/u)
  assert.match(css, /text-align:\s*right\s*!important/u)
})

test('PDF 居中译文应扩展到正文区宽度，右对齐译文必须沿用原文本块宽度', () => {
  const source = read('src/renderer/src/document.ts')
  const geometryStart = source.indexOf('function applyTranslationBlockGeometry(')
  const geometryEnd = source.indexOf('/**', geometryStart + 1)
  const geometrySource = source.slice(geometryStart, geometryEnd)

  assert.match(geometrySource, /contentArea\?: DocumentContentArea/u)
  assert.match(
    geometrySource,
    /const contentLeft = Math\.min\(\s*left,\s*Math\.max\(0,\s*contentArea\?\.left\s*\?\?\s*left\)\s*\)/su
  )
  assert.match(
    geometrySource,
    /const contentRight = Math\.max\(\s*right,\s*Math\.min\(pageWidth,\s*contentArea\?\.right\s*\?\?\s*right\)\s*\)/su
  )
  assert.match(
    geometrySource,
    /const centeredWidth = Math\.max\(blockWidth,\s*Math\.min\([\s\S]*?Math\.min\(blockCenter - contentLeft,\s*contentRight - blockCenter\) \* 2/su
  )
  assert.match(
    geometrySource,
    /block\.textAlign === 'center'\s*\?\s*centeredWidth\s*:\s*block\.textAlign === 'right'\s*\?\s*blockWidth/su
  )
  assert.match(
    geometrySource,
    /block\.textAlign === 'center'\s*\?\s*blockCenter - flowWidth \/ 2\s*:\s*block\.textAlign === 'right'\s*\?\s*right - flowWidth\s*:\s*left/su
  )
})

test('PDF 左对齐译文扩展宽度时必须保留原文左右页边距，不能铺到物理页边', () => {
  const source = read('src/renderer/src/document.ts')
  const geometryStart = source.indexOf('function applyTranslationBlockGeometry(')
  const geometryEnd = source.indexOf('/**', geometryStart + 1)
  const geometrySource = source.slice(geometryStart, geometryEnd)

  assert.match(geometrySource, /contentArea\?: DocumentContentArea/u)
  assert.match(
    geometrySource,
    /Math\.min\(pageWidth,\s*contentArea\?\.right\s*\?\?\s*right\)/u
  )
  assert.match(
    geometrySource,
    /Math\.max\(blockWidth, contentRight - left\)/u
  )
  assert.doesNotMatch(geometrySource, /contentArea\?\.right\s*\?\?\s*pageWidth/u)
  assert.doesNotMatch(geometrySource, /pageWidth - left - rightInset/u)
  assert.doesNotMatch(geometrySource, /pageWidth - pageInset \* 2/u)
})

test('PDF 译文必须为内部字体名追加可用的浏览器字体回退', () => {
  const source = read('src/renderer/src/document.ts')

  assert.match(source, /function pdfPreviewFontFamily\(/u)
  assert.match(source, /--document-run-font-family/u)
  assert.match(source, /PingFang SC/u)
  assert.match(source, /Microsoft YaHei/u)
  assert.match(source, /Arial/u)
  assert.match(source, /Times New Roman/u)
  assert.match(source, /Songti SC/u)
  assert.match(source, /Menlo/u)
  assert.match(source, /Noto Serif CJK SC/u)
})

test('PDF 译文必须按真实字体名区分宋体、黑体与等宽字体回退', () => {
  const source = read('src/renderer/src/document.ts')
  const familyStart = source.indexOf('function pdfPreviewFontFamily(')
  const familyEnd = source.indexOf('/**', familyStart + 1)
  const familySource = source.slice(familyStart, familyEnd)

  assert.match(familySource, /song|simsun|serif|times/iu)
  assert.match(familySource, /mono|courier|consolas|menlo/iu)
  assert.match(familySource, /"Times New Roman", "Songti SC", "SimSun", "Noto Serif CJK SC", serif/u)
  assert.match(familySource, /"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif/u)
})

test('PDF 译文图片必须沿用原图边界并按页面比例缩放，不能拉伸为整页宽', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')

  assert.match(source, /function applyTranslationImageGeometry\(/u)
  assert.match(source, /--document-image-left/u)
  assert.match(source, /--document-image-width/u)
  assert.match(source, /--document-image-height/u)
  assert.match(source, /dataset\.geometry = 'source'/u)
  assert.match(
    source,
    /function renderImageBlock\(\s*block: DocumentImageBlock,\s*side: DocumentRenderSide,\s*pageWidth: number,\s*jobId: string,\s*tab: DocumentWorkspaceTab\s*\)/u
  )
  assert.match(source, /case 'image': return renderImageBlock\(block, side, pageWidth, jobId, tab\)/u)
  assert.match(
    css,
    /\.document-page\[data-layout='translation-flow'\] \.document-image-block\[data-geometry='source'\][\s\S]*?width:\s*calc\(\s*var\(--document-image-width[^;]*var\(--document-page-scale/su
  )
  assert.match(
    css,
    /\.document-page\[data-layout='translation-flow'\] \.document-image-block\[data-geometry='source'\][\s\S]*?height:\s*calc\(\s*var\(--document-image-height[^;]*var\(--document-page-scale/su
  )
  assert.match(
    css,
    /\.document-page\[data-layout='translation-flow'\] \.document-image-block\[data-geometry='source'\][\s\S]*?margin-left:\s*calc\(\s*var\(--document-image-left[^;]*var\(--document-page-scale/su
  )
  // 图片必须按自然宽高比缩放到 bbox 内，不能为了铺满 bbox 而改变原始比例。
  assert.match(
    css,
    /\.document-page\[data-layout='translation-flow'\] \.document-image-block\[data-geometry='source'\]\s+\.document-page-image[\s\S]*?object-fit:\s*contain/u
  )
})

test('PDF 译文图片放大必须等比缩放，并与 OCR 层共享居中内容框', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')

  assert.match(source, /resolveDocumentImageContentBox/u)
  assert.match(source, /naturalWidth/u)
  assert.match(source, /naturalHeight/u)
  assert.match(source, /function applyTranslationImageContentGeometry\(/u)
  assert.match(source, /--document-image-content-left/u)
  assert.match(source, /--document-image-content-top/u)
  assert.match(source, /--document-image-content-width/u)
  assert.match(source, /--document-image-content-height/u)

  const imageRule = /\.document-page\[data-layout='translation-flow'\] \.document-image-block\[data-geometry='source'\]\s+\.document-page-image\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  assert.match(imageRule, /left:\s*calc\(\s*var\(--document-image-content-left[^;]*var\(--document-page-scale/su)
  assert.match(imageRule, /top:\s*calc\(\s*var\(--document-image-content-top[^;]*var\(--document-page-scale/su)
  assert.match(imageRule, /width:\s*calc\(\s*var\(--document-image-content-width[^;]*var\(--document-page-scale/su)
  assert.match(imageRule, /height:\s*calc\(\s*var\(--document-image-content-height[^;]*var\(--document-page-scale/su)
  assert.match(imageRule, /object-fit:\s*contain/u)
  assert.doesNotMatch(imageRule, /object-fit:\s*fill/u)
  assert.match(
    css,
    /\.document-page\[data-layout='translation-flow'\][\s\S]*?\.document-ocr-translation-layer\s*\{[^}]*margin-left:\s*calc\(\s*var\(--document-image-content-left[^;]*var\(--document-page-scale/su
  )
  assert.match(
    css,
    /\.document-page\[data-layout='translation-flow'\][\s\S]*?\.document-ocr-text-layer\s*\{[^}]*width:\s*calc\(\s*var\(--document-image-content-width[^;]*var\(--document-page-scale/su
  )
})

test('PDF 译文图片必须锚定原文纵向坐标，并只避让横向相交的前序译文', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const renderPageStart = source.indexOf('function renderPage(')
  const renderPageEnd = source.indexOf('/**', renderPageStart + 1)
  const renderPageSource = source.slice(renderPageStart, renderPageEnd)
  const normalizeStart = source.indexOf('function normalizeTranslationFlowLayout(')
  const normalizeEnd = source.indexOf('/**', normalizeStart + 1)
  const normalizeSource = source.slice(normalizeStart, normalizeEnd)
  const imageRule = /\.document-page\[data-layout='translation-flow'\] \.document-image-block\[data-geometry='source'\]\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''

  assert.match(source, /function normalizeTranslationFlowLayout\(/u)
  assert.match(source, /function measureTranslationFlowBottom\(/u)
  assert.match(source, /--document-image-flow-gap-before/u)
  assert.match(source, /measureTranslationFlowBottom\(child\)/u)
  // 只有横向相交的前序内容才需要避让；横向错开的正文变高时允许图片回填到原文锚点。
  assert.match(normalizeSource, /resolveTranslationImageFlowGap\(/u)
  assert.match(normalizeSource, /flowObstacles/u)
  assert.match(normalizeSource, /measureTranslationFlowObstacle\(child, pageRect\)/u)
  assert.match(source, /classList\.contains\('document-flow-group'\)/u)
  assert.doesNotMatch(normalizeSource, /gapPx = Math\.max\(0, anchoredTop - previousBottom\)/u)
  assert.match(renderPageSource, /dataset\.sourceY/u)
  assert.match(source, /normalizeTranslationFlowLayout\(page\)/u)
  assert.match(
    imageRule,
    /margin-top:\s*calc\(\s*var\(--document-image-flow-gap-before,\s*var\(--document-flow-gap-before,\s*0px\)\)[^;]*var\(--document-page-scale/su
  )
})

test('PDF 译文图片横向避让必须区分左右错开与真实相交', () => {
  assert.equal(
    rangesOverlapHorizontally({ left: 0, right: 100 }, { left: 446, right: 529 }),
    false
  )
  assert.equal(
    rangesOverlapHorizontally({ left: 60, right: 535 }, { left: 446, right: 529 }),
    true
  )
  assert.equal(
    rangesOverlapHorizontally({ left: 446, right: 529 }, { left: 424.5, right: 433.5 }),
    false
  )
})

test('PDF 译文图片无横向碰撞时应回填原文锚点，有碰撞时不得覆盖前文', () => {
  const imageRange = { left: 446.25, right: 528.75 }
  const noCollisionGap = resolveTranslationImageFlowGap({
    anchoredTop: 42,
    previousBottom: 300,
    flowOrigin: 22.5,
    imageRange,
    imageHeight: 37.5,
    obstacles: [{ left: 60, right: 433.5, top: 37.5, bottom: 300 }]
  })
  const collisionGap = resolveTranslationImageFlowGap({
    anchoredTop: 42,
    previousBottom: 300,
    flowOrigin: 22.5,
    imageRange,
    imageHeight: 37.5,
    obstacles: [{ left: 424.5, right: 529, top: 37.5, bottom: 300 }]
  })

  assert.equal(noCollisionGap, -258)
  assert.equal(collisionGap, 0)
})

test('PDF 译文图片碰撞检测必须允许纵向重叠但横向错开的前序内容', () => {
  const gap = resolveTranslationImageFlowGap({
    anchoredTop: 42,
    previousBottom: 90,
    flowOrigin: 22.5,
    imageRange: { left: 446.25, right: 528.75 },
    imageHeight: 37.5,
    obstacles: [{ left: 60, right: 433.5, top: 22.5, bottom: 88 }]
  })

  // 前序内容只占据左侧且与图片纵向重叠时，图片应回填到原文锚点（42 - 90）。
  assert.equal(gap, -48)
})

test('PDF 图片异步资源在节点插入页面前解析完成时不得被丢弃', () => {
  const source = read('src/renderer/src/document.ts')
  const renderStart = source.indexOf('function renderImageBlock(')
  const renderEnd = source.indexOf('/**', renderStart + 1)
  const imageRenderSource = source.slice(renderStart, renderEnd)

  assert.match(imageRenderSource, /loadDocumentImageAsset\(wrapper, image, block, jobId, tab\)/u)
  assert.doesNotMatch(imageRenderSource, /image\.isConnected/u)
  assert.match(source, /assetRequests = new Map<string, Promise<string \| null>>/u)
  assert.match(source, /assetUrlEpoch/u)
  assert.match(source, /for \(let attempt = 0; attempt < 3; attempt \+= 1\)/u)
  assert.match(source, /assetRequests\.set\(cacheKey, request\)/u)
  assert.match(source, /wrapper\.dataset\.assetState = 'loaded'/u)
  assert.match(source, /wrapper\.dataset\.assetState = 'error'/u)
  assert.match(source, /renderDocumentImagePlaceholder\(wrapper, block\)/u)
})

test('图片资源失败占位不得覆盖已经挂载的 OCR 透明文字层', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const loadStart = source.indexOf('function loadDocumentImageAsset(')
  const loadEnd = source.indexOf('/**', loadStart + 1)
  const loadSource = source.slice(loadStart, loadEnd)
  const patchStart = source.indexOf('function patchTranslationOcrLayer(')
  const patchEnd = source.indexOf('/**', patchStart + 1)
  const patchSource = source.slice(patchStart, patchEnd)

  // 图片资源异步失败时，OCR 层可能已经挂载；必须只替换图片本身，不能清空整个区块。
  assert.doesNotMatch(loadSource, /wrapper\.textContent/u)
  assert.match(source, /function renderDocumentImagePlaceholder\(/u)
  assert.match(loadSource, /renderDocumentImagePlaceholder\(wrapper, block, 'error'\)/u)
  assert.match(patchSource, /dataset\.assetState === 'error'/u)
  assert.match(css, /\.document-image-placeholder\s*\{[^}]*color:\s*var\(--text-muted\)/su)
})

test('PDF 源预览必须按文件身份复用并把告警层与画布分离', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')

  assert.match(source, /function documentPreviewIdentity\(/u)
  assert.match(source, /model\.source\.format === 'pdf'/u)
  assert.match(source, /model\.source\.format === 'pdf' \|\| model\.source\.format === 'image'/u)
  assert.match(source, /return `\$\{model\.source\.format\}:\$\{model\.source\.sha256\}`/u)
  assert.match(source, /const sourceChanged = renderedSourcePreviewIdentity !== sourcePreviewIdentity/u)
  assert.match(source, /if \(sourceChanged\) revokeAssetUrls\(\)/u)
  assert.doesNotMatch(source, /if \(sourceChanged \|\| translationChanged\) revokeAssetUrls\(\)/u)
  assert.match(source, /function renderDocumentWarnings\(/u)
  assert.match(source, /className = 'document-preview-host'/u)
  assert.match(source, /className = 'document-warning-list'/u)
  assert.match(source, /\.document-preview-host/u)
  assert.match(source, /renderPdfPages\(previewHost, model, jobId, tab\)/u)
  assert.match(css, /\.document-preview-host/u)
})

test('PDF 双栏必须共享纸张主题并保持一致缩放基准', () => {
  const css = read('src/renderer/src/document.css')
  const theme = read('src/renderer/src/theme.css')
  const source = read('src/renderer/src/document.ts')
  const renderPageStart = source.indexOf('function renderPage(')
  const renderPageEnd = source.indexOf('/**', renderPageStart + 1)
  const renderPageSource = source.slice(renderPageStart, renderPageEnd)

  assert.match(theme, /--document-paper-bg:/u)
  assert.match(theme, /--document-paper-text:/u)
  assert.match(css, /\.document-page\[data-layout='translation-flow'\][\s\S]*?background:\s*var\(--document-paper-bg\)/u)
  assert.match(css, /\.document-page\[data-layout='translation-flow'\][\s\S]*?color:\s*var\(--document-paper-text\)/u)
  assert.match(css, /\.document-pdf-page[\s\S]*?background:\s*var\(--document-paper-bg\)/u)
  assert.match(css, /\.document-page\[data-layout='translation-flow'\] \.document-text-block[\s\S]*?height:\s*auto\s*!important/u)
  assert.match(renderPageSource, /side === 'translation' && hasGeometry/u)
  assert.doesNotMatch(renderPageSource, /hasGeometry && !page\.background/u)
  assert.match(
    css,
    /\.document-page\[data-layout='translation-flow'\] \.document-image-block\s*\{[^}]*background:\s*var\(--document-paper-bg\)/su
  )
})

test('主进程文档 IPC 必须使用可静态审计的字面量通道名', () => {
  const main = read('src/main/index.ts')
  for (const channel of ['document:run', 'document:cancel', 'document:retry-failed', 'document:export-pdf', 'document:get-asset', 'document:get-source']) {
    assert.match(main, new RegExp(`ipcMain\\.(?:handle|on)\\('${channel}'`, 'u'))
  }
})

test('文档工作台必须补齐任务、OCR、导出和页面提示词条', () => {
  const zh = read('src/shared/i18n/catalog.zh-CN.document.ts')
  const en = read('src/shared/i18n/catalog.en-US.document.ts')
  const keys = [
    'document.cancel',
    'document.partial',
    'document.partialSummary',
    'document.waitingSource',
    'document.waitingTranslation',
    'document.run.failed',
    'document.run.failedCode',
    'document.cancelled',
    'document.export.saved',
    'document.export.cancelled',
    'document.export.failed',
    'document.fontMissing',
    'document.imageOcrFailed',
    'document.ocr.pendingRender',
    'document.formulaPreserved',
    'document.pageCount'
  ]
  for (const key of keys) {
    assert.match(zh, new RegExp(`'${key.replaceAll('.', '\\.')}'`, 'u'))
    assert.match(en, new RegExp(`'${key.replaceAll('.', '\\.')}'`, 'u'))
  }
})

test('HTML 源文预览必须加载净化结果，并禁止远程导航、权限与网络请求', () => {
  const source = read('src/renderer/src/document.ts')
  const manager = read('src/main/documentWorkspaceWindow.ts')
  const html = read('src/renderer/document.html')
  const css = read('src/renderer/src/document.css')

  assert.match(source, /function renderHtmlSourcePreview/u)
  assert.match(source, /document\.createElement\('webview'\)/u)
  assert.match(source, /getDocumentSource\(jobId\)/u)
  assert.match(source, /URL\.createObjectURL\(/u)
  assert.match(source, /URL\.revokeObjectURL\(/u)
  assert.match(source, /webview\.src\s*=\s*previewUrl/u)
  assert.doesNotMatch(source, /toFileUrl\(model\.source\.path\)/u)
  assert.match(source, /side === 'source' && model\.source\.format === 'html'/u)
  assert.match(manager, /webviewTag:\s*true/u)
  assert.match(manager, /on\('will-attach-webview'/u)
  assert.match(manager, /delete webPreferences\.preload/u)
  assert.match(manager, /on\('will-navigate'/u)
  assert.match(manager, /setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'\s*\}\)\)/u)
  assert.match(manager, /setPermissionRequestHandler/u)
  assert.match(manager, /setPermissionCheckHandler/u)
  assert.match(manager, /webRequest\.onBeforeRequest/u)
  assert.match(manager, /event\.preventDefault\(\)/u)
  assert.match(html, /document-page-scroll[^>]*id="document-source-content"/u)
  assert.match(
    css,
    /\.document-preview-host\[data-preview-kind='html-source'\][\s\S]*?flex:\s*1 1 auto[\s\S]*?height:\s*100%/u
  )
  assert.match(
    css,
    /\.document-html-preview[\s\S]*?flex:\s*1 1 auto[\s\S]*?height:\s*100%/u
  )
})

test('HTML 原文与译文必须使用独立预览类型，译文保持可滚动流式布局', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')

  assert.match(
    source,
    /type DocumentPreviewKind = 'paged' \| 'markdown' \| 'table' \| 'subtitle' \| 'flow' \| 'html-source'/u
  )
  assert.match(source, /if \(side === 'source' && format === 'html'\) return 'html-source'/u)
  assert.match(source, /const kind = resolvePreviewKind\(model, side\)/u)
  assert.match(source, /function resolvePreviewKind\(model: DocumentModel, side: DocumentRenderSide\)/u)
  assert.match(source, /if \(side === 'source' && format === 'html'\) return 'html-source'/u)
  assert.match(source, /if \(format === 'html'\) return 'flow'/u)
  assert.match(css, /\.document-preview-host\[data-preview-kind='html-source'\]/u)
  assert.doesNotMatch(css, /\.document-preview-host\[data-preview-kind='html'\]/u)
  assert.doesNotMatch(css, /\.document-page-scroll\[data-preview-kind='html'\]/u)
  assert.match(
    css,
    /\.document-page-scroll\[data-preview-kind='html-source'\]\s*\{[\s\S]*?overflow:\s*hidden/u
  )
})

test('HTML 源文预览必须按文件指纹复用，翻译流式更新不得反复重载 webview', () => {
  const source = read('src/renderer/src/document.ts')
  const identityStart = source.indexOf('function documentPreviewIdentity(')
  const identityEnd = source.indexOf('/**', identityStart + 1)
  const identitySource = source.slice(identityStart, identityEnd)

  assert.match(identitySource, /model\.source\.format === 'html'/u)
  assert.match(identitySource, /return `html:\$\{model\.source\.sha256\}`/u)
})

test('解析告警必须按稳定 code 本地化并在双栏中可见', () => {
  const zh = read('src/shared/i18n/catalog.zh-CN.document.ts')
  const en = read('src/shared/i18n/catalog.en-US.document.ts')
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const keys = [
    'page-limit-reached',
    'block-limit-reached',
    'image-limit-reached',
    'image-pixel-limit-reached',
    'unsafe-package-path',
    'unsafe-epub-chapter',
    'missing-epub-chapter',
    'ocr-required',
    'embedded-image-ocr-required',
    'ocr-failed',
    'ocr-no-text',
    'ocr-low-confidence',
    'ocr-limit-reached',
    'pdf-rotated-text',
    'pdf-overlapping-text',
    'pdf-reading-order-uncertain',
    'formula-unrecognized',
    'invalid-json',
    'unclosed-code-fence',
    'invalid-subtitle',
    'translation-partial',
    'ocr-source-text-layer-empty',
    'remote-resource-removed',
    'unsafe-html-removed',
    'unknown'
  ]
  for (const code of keys) {
    const key = `document.warning.${code}`.replaceAll('.', '\\.')
    assert.match(zh, new RegExp(`'${key}'`, 'u'))
    assert.match(en, new RegExp(`'${key}'`, 'u'))
  }
  assert.match(source, /localizeDocumentWarning/u)
  assert.match(source, /document\.warning\.\$\{warning\.code\}/u)
  assert.match(source, /snapshot\.source\?\.warnings/u)
  assert.match(source, /translationPaneModel\?\.warnings/u)
  assert.match(css, /\.document-warning-list/u)
})

test('文档双栏预览必须支持在源文栏切换 OCR 原文与译文覆盖，译文锚定原位置且只在相交时避让', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')

  assert.match(source, /type DocumentRenderSide = 'source' \| 'translation'/u)
  assert.match(source, /function renderOcrRegion\([^)]*side: DocumentRenderSide/u)
  assert.match(source, /const translatedText = region\.translatedText\?\.trim\(\)/u)
  assert.match(source, /if \(!translatedText\) return null/u)
  assert.match(
    source,
    /function renderPage\(\s*page: DocumentPage,\s*side: DocumentRenderSide,\s*translationInitialScale: number,\s*jobId: string,\s*tab: DocumentWorkspaceTab\s*\): HTMLElement/u
  )
  assert.match(
    source,
    /function renderBlock\(\s*block: DocumentBlock,\s*side: DocumentRenderSide,\s*pageWidth: number,\s*contentArea: DocumentContentArea \| undefined,\s*jobId: string,\s*tab: DocumentWorkspaceTab\s*\)/u
  )
  assert.match(source, /renderPage\(page, side, 1, jobId, tab\)/u)
  assert.match(source, /renderBlock\(block, side, page\.width, page\.contentArea, jobId, tab\)/u)
  assert.match(source, /renderTableCellBlock\(child, side, jobId, tab\)/u)
  assert.match(source, /--document-ocr-font-size-pt/u)
  assert.match(source, /resolveOcrRegionFontSize\(region, imageHeight\)/u)
  assert.match(source, /region\.textAlign/u)
  assert.match(source, /textAlign = block\.textAlign/u)
  assert.match(source, /style: region\.style/u)
  assert.match(source, /textAlign: region\.textAlign/u)
  assert.match(source, /document-ocr-translation-layer/u)
  assert.match(source, /appendImageOcrLayers\(wrapper, block, side, tab\)/u)
  assert.match(source, /createOcrTranslationLayer\(block\)/u)
  assert.match(source, /dataset\.ocrText = 'true'/u)
  assert.match(source, /--document-ocr-source-top/u)
  assert.match(source, /resolveOcrRegionFontSize/u)
  assert.match(source, /resolveOcrRegionLineHeight/u)
  assert.match(source, /resolveOcrRegionPadding/u)
  assert.match(source, /resolveOcrRegionGapBefore/u)
  assert.match(source, /resolveDocumentOcrRegionFlowTop/u)
  assert.match(source, /resolveDocumentOcrTranslationHorizontalBounds/u)
  assert.match(
    source,
    /const horizontalBounds = resolveDocumentOcrTranslationHorizontalBounds\([\s\S]*?element\.style\.left = `\$\{horizontalBounds\.x \* 100\}%`[\s\S]*?element\.style\.width = `\$\{horizontalBounds\.width \* 100\}%`/u,
    '可见译文必须使用横向可用宽度，不能继续沿用窄 OCR 原框导致中文逐字换行'
  )
  assert.match(
    source,
    /const sourceWidthRatio = resolveDocumentOcrSourceWidthRatio\(box, horizontalBounds\)[\s\S]*?--document-ocr-source-width[^\n]*sourceWidthRatio \* 100/u,
    'OCR 白底必须按原识别框占扩宽译文框的比例记录宽度，不能覆盖右侧正文'
  )
  assert.match(source, /function normalizeOcrTranslationLayout\(/u)
  assert.match(source, /dataset\.sourceTop = String\(box\.y\)/u)
  assert.match(
    source,
    /--document-ocr-source-height[^\n]*box\.height \* imageHeight/u,
    'OCR 白底必须记录原识别框高度，短译文不能露出扫描原文'
  )
  assert.match(
    source,
    /--document-ocr-source-top-percent[^\n]*box\.y \* 100/u,
    '独立图片会按预览栏缩放，OCR 顶部坐标必须同时提供百分比基准'
  )
  assert.match(source, /pdfPreviewFontFamily\(region\.style\?\.fontFamily/u)
  assert.match(source, /dataset\.ocrTranslation = 'true'/u)
  assert.match(
    css,
    /\.document-ocr-region\s*\{[^}]*background:\s*linear-gradient\([^}]*var\(--document-ocr-source-width/su,
    'OCR 白底只能覆盖原识别框，不能跟随译文可用宽度铺满整行'
  )
  assert.match(css, /\.document-ocr-region\s*\{[^}]*color:\s*var\(--document-paper-text\)/su)
  assert.match(css, /\.document-ocr-region\s*\{[^}]*var\(--document-ocr-font-size-pt[^;]*\*\s*var\(--document-page-scale[^;]*\*\s*1px/su)
  assert.match(css, /\.document-ocr-region\s*\{[^}]*overflow:\s*visible/su)
  assert.match(css, /\.document-ocr-region\s*\{[^}]*height:\s*auto/su)
  assert.match(
    css,
    /\.document-ocr-region\s*\{[^}]*min-height:\s*calc\([\s\S]*?var\(--document-ocr-source-height,[^)]*\)\s*\*\s*var\(--document-page-scale/su,
    'OCR 白底的最小高度必须跟随原识别框并按页面缩放'
  )
  assert.match(
    css,
    /\.document-ocr-region\s*\{[^}]*line-height:\s*var\(--document-ocr-line-height,\s*1\.15\)/su
  )
  assert.doesNotMatch(css, /\.document-ocr-region\s*\{[^}]*--document-ocr-min-height/su)
  assert.doesNotMatch(source, /document-ocr-original-mask-layer/u)
  assert.doesNotMatch(css, /\.document-ocr-original-mask/u)
  assert.match(css, /@font-face\s*\{[^}]*font-family:\s*'Noto Sans SC'/su)
  assert.match(css, /assets\/fonts\/NotoSansSC-Regular\.ttf/u)
  assert.match(
    css,
    /\.document-page\[data-layout='translation-flow'\] \.document-image-block\[data-ocr-translation='true'\][\s\S]*?overflow:\s*visible/su
  )
  assert.match(css, /\.document-ocr-region\s*\{[^}]*position:\s*absolute/su)
  assert.match(
    css,
    /\.document-preview-host\[data-document-format='image'\]\s+\.document-page\[data-layout='absolute'\]\s+\.document-ocr-translation-layer\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0/su,
    '只有独立图片原文页的 OCR 覆盖层必须与图片共享完整矩形，译文流式页不能脱离文档流'
  )
  assert.match(
    css,
    /\.document-preview-host\[data-document-format='image'\]\s+\.document-page\[data-layout='absolute'\]\s+\.document-ocr-region\s*\{[^}]*top:\s*var\(--document-ocr-source-top-percent/su,
    '只有独立图片原文页使用百分比顶部坐标，译文流式页必须继续使用像素坐标'
  )
  assert.doesNotMatch(css, /\.document-ocr-region\s*\{[^}]*margin-top:/su)
  assert.doesNotMatch(css, /\.document-ocr-translation-layer\s*\{[^}]*flex-direction:\s*column/su)
})

test('图片 OCR 原文必须同时作为透明打印文字层注入译文栏并支持屏幕切换显示', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const html = read('src/renderer/document.html')

  // 原文文字层承载透明打印文字层 class，供双层 PDF 导出复用。
  assert.match(source, /document-ocr-text-layer document-ocr-print-text-layer/u)
  // 主图片与表格图片共用 OCR 层挂载逻辑；原文栏不能挂载译文遮罩。
  assert.match(source, /function appendImageOcrLayers\(/u)
  assert.match(source, /appendImageOcrLayers\(wrapper, block, side, tab\)/u)
  assert.match(source, /if \(side === 'source'\) \{[\s\S]*?if \(tab\.ocrDisplayMode !== 'ocr-text'\) return[\s\S]*?createOcrTextLayer\(block\)/u)
  assert.match(source, /createOcrTranslationLayer\(block\)/u)
  assert.match(source, /dataset\.ocrText = 'true'/u)
  assert.match(source, /document-ocr-text-region/u)
  // 译文栏屏幕隐藏打印文字层，只在打印时输出，避免遮挡译文。
  assert.match(css, /#document-translation-content \.document-ocr-print-text-layer\s*\{[^}]*display:\s*none/su)
  // 界面必须在语言选择所在的顶部栏提供 OCR 原文与译文切换。
  const toolbar = /<nav class="document-toolbar"[\s\S]*?<\/nav>/u.exec(html)?.[0] ?? ''
  assert.match(toolbar, /id="document-source-ocr-mode"/u)
  assert.match(toolbar, /data-ocr-mode="ocr-text"/u)
  assert.match(toolbar, /data-ocr-mode="translation"/u)
})

test('文档工作台顶栏必须支持双面与仅译文单面显示，并保持布局自适应', () => {
  const html = read('src/renderer/document.html')
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const zh = read('src/shared/i18n/catalog.zh-CN.document.ts')
  const en = read('src/shared/i18n/catalog.en-US.document.ts')
  const toolbar = /<nav class="document-toolbar"[\s\S]*?<\/nav>/u.exec(html)?.[0] ?? ''

  assert.match(toolbar, /id="document-view-mode"[^>]*role="group"/u)
  assert.match(toolbar, /data-document-view-mode="spread"/u)
  assert.match(toolbar, /data-document-view-mode="translation"/u)
  assert.match(source, /const documentViewModeControl = document\.getElementById\('document-view-mode'\)/u)
  assert.match(source, /const documentColumns = document\.querySelector<HTMLElement>\('\.document-columns'\)/u)
  assert.match(source, /let documentViewMode: DocumentViewMode = readDocumentViewMode\(\)/u)
  assert.match(source, /documentColumns\.dataset\.viewMode = documentViewMode/u)
  assert.match(source, /documentViewModeControl\.querySelectorAll<HTMLButtonElement>\('\[data-document-view-mode\]'\)/u)
  assert.match(source, /documentViewMode = nextMode/u)
  assert.match(source, /documentViewMode === 'translation'/u)
  assert.match(source, /localStorage\.setItem\(DOCUMENT_VIEW_MODE_STORAGE_KEY, mode\)/u)
  assert.match(source, /localStorage\.getItem\(DOCUMENT_VIEW_MODE_STORAGE_KEY\)/u)
  assert.match(css, /\.document-columns\[data-view-mode='translation'\]\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/su)
  assert.match(css, /\.document-columns\[data-view-mode='translation'\]\s+\.document-column:first-child\s*\{[^}]*display:\s*none/su)
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.document-columns\[data-view-mode='translation'\]\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/su)
  assert.doesNotMatch(css, /\.document-columns\[data-view-mode='translation'\][^}]*background(?:-color)?:\s*#[0-9a-f]{3,8}\b/iu)
  assert.match(zh, /'document\.viewMode\.spread': '双面显示'/u)
  assert.match(zh, /'document\.viewMode\.translation': '仅显示译文'/u)
  assert.match(en, /'document\.viewMode\.spread': 'Side by side'/u)
  assert.match(en, /'document\.viewMode\.translation': 'Translation only'/u)
})

test('文档预览必须按文件格式分派并为 Markdown 使用语义渲染', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')

  assert.match(source, /type DocumentPreviewKind = 'paged' \| 'markdown' \| 'table' \| 'subtitle' \| 'flow'/u)
  assert.match(source, /function resolvePreviewKind\(model: DocumentModel, side: DocumentRenderSide\): DocumentPreviewKind/u)
  assert.match(source, /format === 'markdown'/u)
  assert.match(source, /format === 'csv'/u)
  // 图片文档与 PDF 一样按页等比缩放，避免整页图片在窄栏中被压变形。
  assert.match(source, /format === 'image'/u)
  assert.match(source, /format === 'srt' \|\| format === 'vtt'/u)
  assert.match(source, /function renderMarkdownDocument\(/u)
  assert.match(source, /function renderMarkdownBlock\(/u)
  assert.match(source, /createElement\(`h\$\{/u)
  assert.match(source, /createElement\('blockquote'\)/u)
  assert.match(source, /createElement\('pre'\)/u)
  assert.match(source, /createElement\('ul'\)/u)
  assert.match(source, /dataset\.previewKind = kind/u)
  assert.match(source, /renderMarkdownDocument\(/u)
  assert.match(css, /\.document-markdown-preview/u)
  assert.match(css, /\.document-markdown-preview h1/u)
  assert.match(css, /\.document-markdown-preview blockquote/u)
  assert.match(css, /\.document-subtitle-preview/u)
  assert.match(css, /\.document-table-preview/u)
})

test('OCR 原文切换控件必须递归识别表格单元格内的图片', () => {
  const source = read('src/renderer/src/document.ts')
  const start = source.indexOf('function hasOcrSourceText(')
  const end = source.indexOf('/**', start + 1)
  const fn = source.slice(start, end)

  assert.match(fn, /const hasVisibleOcrText = \(block: DocumentBlock\)/u)
  assert.match(fn, /block\.kind === 'table'/u)
  assert.match(fn, /row\.cells\.some\(\(cell\) => cell\.blocks\.some\(hasVisibleOcrText\)\)/u)
  assert.match(fn, /model\.pages\.some\(\(page\) => page\.blocks\.some\(hasVisibleOcrText\)\)/u)
})

test('PDF 与图片任务必须在顶部栏始终显示 OCR 原文切换入口', () => {
  const source = read('src/renderer/src/document.ts')
  const start = source.indexOf('function renderOcrDisplayModeControls(')
  const end = source.indexOf('/**', start + 1)
  const fn = source.slice(start, end)

  assert.match(fn, /const format = snapshot\.source\?\.source\.format/u)
  assert.match(fn, /format === 'pdf' \|\| format === 'image' \|\| hasOcrSourceText\(snapshot\.source\)/u)
  assert.match(fn, /sourceOcrMode\.hidden = !\(/u)
})

test('OCR 切换入口在准备阶段缺少源模型时必须按当前文件格式保持可见', () => {
  const source = read('src/renderer/src/document.ts')
  const start = source.indexOf('function renderOcrDisplayModeControls(')
  const end = source.indexOf('/**', start + 1)
  const fn = source.slice(start, end)

  assert.match(
    fn,
    /const format = snapshot\.source\?\.source\.format \?\? tab\.selection\.format/u,
    '准备中的快照可能尚未包含 source，不能因此丢失当前 Tab 已识别的文件格式'
  )
})

test('Markdown 链接文字必须可翻译而链接目标和 HTML 标签必须保持受保护', () => {
  const model = parseMarkdownDocument({
    path: '/tmp/links.md',
    fileName: 'links.md',
    format: 'markdown',
    sha256: 'links-fixture',
    bytes: new TextEncoder().encode('[docs](https://example.com/path) <kbd>Ctrl</kbd>')
  })
  const block = model.pages[0]!.blocks[0]
  assert.equal(block?.kind, 'text')
  if (block?.kind !== 'text') return
  const docs = block.runs.find((run) => run.text === 'docs')
  const target = block.runs.find((run) => run.text === 'https://example.com/path')
  const htmlTag = block.runs.find((run) => run.text === '<kbd>')
  assert.equal(docs?.protected, undefined)
  assert.equal(target?.protected, true)
  assert.equal(htmlTag?.protected, true)
})

test('Markdown 表格必须渲染语义表头并保持窄屏横向滚动', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')

  assert.match(source, /block\.headerRows/u)
  assert.match(source, /createElement\('thead'\)/u)
  assert.match(source, /createElement\('th'\)/u)
  assert.match(css, /\.document-table-block\s*\{[^}]*overflow-x:\s*auto/su)
  assert.match(css, /\.document-table-block thead th\s*\{[^}]*background:\s*var\(--bg-secondary\)/su)
  assert.match(css, /\.document-table-block th,\s*\.document-table-block td\s*\{/u)
  assert.match(css, /\.document-table-block tbody tr:nth-child\(even\)\s*\{[^}]*background:\s*var\(--bg-secondary\)/su)
})

test('代码区域必须保留主题边框与独立滚动容器', () => {
  const css = read('src/renderer/src/document.css')
  const codeRule = /\.document-text-code\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''

  assert.match(codeRule, /border:\s*var\(--border-width\)\s+solid\s+var\(--border-default\)/u)
  assert.match(codeRule, /overflow-x:\s*auto/u)
  assert.match(codeRule, /background:\s*var\(--bg-secondary\)/u)
})

test('PDF 译文表格必须沿用原列宽，单元格内容和内边距不能继承页面绝对偏移', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const tableRule = /\.document-table-block table\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const cellRule = /\.document-table-block th,\s*\.document-table-block td\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const translationTableRule = /\.document-page\[data-layout='translation-flow'\]\s+\.document-table-block table\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const translationCellLayoutRule = /\.document-page\[data-layout='translation-flow'\]\s+\.document-table-block th,\s*\.document-page\[data-layout='translation-flow'\]\s+\.document-table-block td\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const translationCellRule = /\.document-page\[data-layout='translation-flow'\]\s+\.document-table-block\s+\[data-table-cell-content='true'\]\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const translationRunRule = /\.document-page\[data-layout='translation-flow'\]\s+\.document-table-block\s+\.document-text-run\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''

  assert.match(source, /normalizeTableColumnWidths/u)
  assert.match(source, /tableLayout/u)
  assert.match(source, /renderTableCellBlock/u)
  assert.match(source, /dataset\.tableCellContent\s*=\s*'true'/u)
  assert.match(tableRule, /table-layout:\s*fixed/u)
  assert.match(tableRule, /width:\s*100%/u)
  assert.match(cellRule, /min-width:\s*0/u)
  assert.match(cellRule, /overflow-wrap:\s*anywhere/u)
  assert.match(translationTableRule, /table-layout:\s*fixed/u)
  assert.match(translationCellLayoutRule, /overflow-wrap:\s*break-word/u)
  assert.match(translationCellLayoutRule, /word-break:\s*normal/u)
  assert.match(translationCellRule, /width:\s*100%\s*!important/u)
  assert.match(translationCellRule, /max-width:\s*100%/u)
  assert.match(translationCellRule, /margin-left:\s*0\s*!important/u)
  assert.match(translationCellRule, /margin-top:\s*0\s*!important/u)
  assert.match(translationCellRule, /overflow-wrap:\s*break-word/u)
  assert.match(translationCellRule, /white-space:\s*pre-wrap/u)
  assert.match(translationRunRule, /white-space:\s*pre-wrap/u)
  assert.match(translationCellLayoutRule, /padding:\s*calc\([^;]*var\(--document-page-scale/u)
  assert.match(translationCellRule, /padding:\s*0\s*!important/u)
})

test('PDF 译文窄表必须保持总宽并为窄列重新分配可用宽度', () => {
  const widths = resolveTranslationTableColumnWidths([21.75, 95.25], 117.75)

  assert.equal(widths.length, 2)
  assert.ok(Math.abs(widths.reduce((sum, width) => sum + width, 0) - 117.75) < 0.001)
  assert.ok(widths[0]! >= 36)
  assert.ok(widths[0]! > 21.75)
  assert.ok(widths[1]! < 95.25)
})

test('PDF 译文宽表与主表列宽必须保持不变', () => {
  const mainTable = resolveTranslationTableColumnWidths([80.62, 393], 474.75)
  const wideTable = resolveTranslationTableColumnWidths([160, 220, 260], 640)

  assert.ok(Math.abs(mainTable[0]! / mainTable[1]! - 80.62 / 393) < 0.001)
  assert.ok(Math.abs(mainTable.reduce((sum, width) => sum + width, 0) - 474.75) < 0.001)
  assert.deepEqual(wideTable, [160, 220, 260])
})

test('PDF 译文窄表没有宽列可让位时不得把表格撑出原边界', () => {
  const widths = resolveTranslationTableColumnWidths([18, 18, 18], 54)

  assert.deepEqual(widths, [18, 18, 18])
  assert.equal(widths.reduce((sum, width) => sum + width, 0), 54)
})

test('PDF 译文表格图片必须限制在单元格内，不能继承页面图片的绝对定位和原页尺寸', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const tableCellStart = source.indexOf('function renderTableCellBlock(')
  const tableCellEnd = source.indexOf('/**', tableCellStart + 1)
  const tableCellSource = source.slice(tableCellStart, tableCellEnd)
  const tableCellImageStart = source.indexOf('function renderTableCellImageBlock(')
  const tableCellImageEnd = source.indexOf('/**', tableCellImageStart + 1)
  const tableCellImageSource = source.slice(tableCellImageStart, tableCellImageEnd)
  const cellImageRule = /\.document-page\[data-layout='translation-flow'\]\s+\.document-table-block\s+\.document-image-block\[data-table-cell-image='true'\]\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const cellImageContentRule = /\.document-page\[data-layout='translation-flow'\]\s+\.document-table-block\s+\.document-image-block\[data-table-cell-image='true'\]\s+\.document-page-image\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''

  assert.match(tableCellSource, /renderTableCellImageBlock\(block, side, jobId, tab\)/u)
  assert.doesNotMatch(tableCellSource, /renderBlock\(block, side, 1\)/u)
  assert.match(tableCellImageSource, /createElement\('img'\)/u)
  assert.doesNotMatch(tableCellImageSource, /applyBlockGeometry\(/u)
  assert.doesNotMatch(tableCellImageSource, /applyTranslationImageGeometry\(/u)
  assert.match(source, /dataset\.tableCellImage\s*=\s*'true'/u)
  assert.match(cellImageRule, /position:\s*relative\s*!important/u)
  assert.match(cellImageRule, /left:\s*auto\s*!important/u)
  assert.match(cellImageRule, /top:\s*auto\s*!important/u)
  assert.match(cellImageRule, /width:\s*100%\s*!important/u)
  assert.match(cellImageRule, /height:\s*auto\s*!important/u)
  assert.match(cellImageRule, /margin(?:-left)?:\s*0\s*!important/u)
  assert.match(cellImageContentRule, /width:\s*100%/u)
  assert.match(cellImageContentRule, /height:\s*auto/u)
  assert.match(cellImageContentRule, /object-fit:\s*contain/u)

  const universalCellImageRule = /\.document-table-block\s+\.document-image-block\[data-table-cell-image='true'\]\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const universalCellRule = /\.document-table-block th,\s*\.document-table-block td\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  assert.match(universalCellImageRule, /position:\s*relative\s*!important/u,
    '表格图片归位规则不能只在译文流布局中生效')
  assert.match(universalCellImageRule, /left:\s*auto\s*!important/u)
  assert.match(universalCellImageRule, /top:\s*auto\s*!important/u)
  assert.match(universalCellImageRule, /max-width:\s*100%\s*!important/u)
  assert.match(universalCellRule, /overflow:\s*hidden/u,
    '单元格必须裁切超出列边界的图片和装饰')
})

test('PDF 译文代码框必须使用代码文本块自身的边框并保持原文横向范围', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const translationCodeRule = /\.document-page\[data-layout='translation-flow'\]\s+\.document-text-block\.document-text-code\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''

  assert.match(source, /block\.codeFrame/u)
  assert.match(source, /--document-code-frame-left/u)
  assert.match(source, /--document-code-frame-width/u)
  assert.match(translationCodeRule, /border:\s*var\(--border-width\)\s+solid\s+var\(--border-default\)/u)
  assert.match(translationCodeRule, /margin-left:\s*calc\(\s*var\(--document-code-frame-left/u)
  assert.match(translationCodeRule, /width:\s*calc\(\s*var\(--document-code-frame-width/u)
  assert.match(translationCodeRule, /box-sizing:\s*border-box/u)
})

test('PDF 代码块必须带边框标记，即使解析器只恢复了横向外框', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const renderTextStart = source.indexOf('function renderTextBlock(')
  const renderTextSource = source.slice(renderTextStart, source.indexOf('/**', renderTextStart + 1))
  const codeFrameRule = /\.document-text-block\[data-code-frame='true'\]\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const translationCodeRule = /\.document-page\[data-layout='translation-flow'\]\s+\.document-text-block\.document-text-code\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''

  assert.match(renderTextSource, /dataset\.codeFrame\s*=\s*'true'/u,
    '代码块无论是否识别到完整外框都必须有可样式化的边框标记')
  assert.match(codeFrameRule, /border:\s*var\(--border-width\)\s+solid\s+var\(--border-default\)/u,
    '代码框边框必须覆盖所有布局，不能只在译文流布局中生效')
  assert.match(codeFrameRule, /border-radius:\s*var\(--radius-control\)/u)
  assert.match(codeFrameRule, /background:\s*var\(--bg-secondary\)/u)
  assert.match(translationCodeRule, /border:\s*var\(--border-width\)\s+solid\s+var\(--border-default\)/u)
  assert.match(translationCodeRule, /background:\s*var\(--bg-secondary\)/u)
})

test('译文页面缩放重排必须通过 requestAnimationFrame 合并并清理待执行帧', () => {
  const source = read('src/renderer/src/document.ts')
  const observeStart = source.indexOf('function observeTranslationPageScale(')
  const observeSource = source.slice(observeStart, source.indexOf('/**', observeStart + 1))
  const resetStart = source.indexOf('function renderDocumentModel(')
  const resetSource = source.slice(resetStart, source.indexOf('/**', resetStart + 1))

  assert.match(observeSource, /requestAnimationFrame\(/u)
  assert.match(observeSource, /cancelAnimationFrame\(/u)
  assert.match(observeSource, /pageLayoutFrame/u)
  assert.match(resetSource, /cancelAnimationFrame\(pageLayoutFrame\)/u)
})

test('译文页面缩放重排帧必须绑定创建时的 Tab，切换 Tab 后不得恢复旧页面的滚动位置', () => {
  const source = read('src/renderer/src/document.ts')
  const observeStart = source.indexOf('function observeTranslationPageScale(')
  const observeSource = source.slice(observeStart, source.indexOf('/**', observeStart + 1))

  assert.ok(observeStart > -1)
  assert.match(observeSource, /const layoutTabId = activeDocumentTabId/u,
    '布局调度器必须捕获创建时所属的 Tab，不能只依赖全局滚动容器')
  assert.match(
    observeSource,
    /requestAnimationFrame\(\(\) => \{\s*pageLayoutFrame = null\s*if \(layoutTabId === null \|\| layoutTabId !== activeDocumentTabId\) return/u,
    '旧 Tab 的 RAF 回调必须先校验 Tab 身份，再读取或恢复滚动位置'
  )
})

test('切换显示方式后的延迟重排必须绑定发起时的 Tab，不能在切换 Tab 后重排新页面', () => {
  const source = read('src/renderer/src/document.ts')
  const viewModeStart = source.indexOf('function setDocumentViewMode(')
  const viewModeSource = source.slice(viewModeStart, source.indexOf('/**', viewModeStart + 1))

  assert.ok(viewModeStart > -1)
  assert.match(
    viewModeSource,
    /const layoutTabId = activeDocumentTabId/u,
    '显示方式切换必须捕获发起时的 Tab，不能在 RAF 回调中读取切换后的全局 Tab'
  )
  assert.match(
    viewModeSource,
    /requestAnimationFrame\(\(\) => \{[\s\S]*?if \(layoutTabId === null \|\| layoutTabId !== activeDocumentTabId\) return[\s\S]*?scheduleTranslationPageLayout\(true\)/u,
    '旧 Tab 的延迟重排必须先校验 Tab 身份，避免重排并恢复新 Tab 的滚动位置'
  )
})

test('PDF 译文表格单元格必须显式保留主题边框', () => {
  const css = read('src/renderer/src/document.css')
  const tableRule = /\.document-table-block table\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const translationCellLayoutRule = /\.document-page\[data-layout='translation-flow'\]\s+\.document-table-block th,\s*\.document-page\[data-layout='translation-flow'\]\s+\.document-table-block td\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''

  assert.match(
    tableRule,
    /border:\s*var\(--border-width\)\s+solid\s+var\(--border-default\)/u,
    '表格外框必须显式使用主题边框变量'
  )
  assert.match(tableRule, /border-collapse:\s*collapse/u)
  assert.match(
    translationCellLayoutRule,
    /border:\s*var\(--border-width\)\s+solid\s+var\(--border-default\)/u
  )
})

test('PDF 译文表格最后一行空单元格必须使用高对比外边界', () => {
  const css = read('src/renderer/src/document.css')
  const theme = read('src/renderer/src/theme.css')
  const lastRowCellRule = /\.document-page\[data-layout='translation-flow'\]\s+\.document-table-block\s+tbody\s+tr:last-child\s+td\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const translationTableRule = /\.document-page\[data-layout='translation-flow'\]\s+\.document-table-block\s+table\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''

  assert.match(
    lastRowCellRule,
    /border-bottom:\s*2px\s+solid\s+var\(--document-table-boundary\)/u,
    '最后一行即使右侧单元格为空，也必须使用足够醒目的专用外边界显示表格底边'
  )
  assert.match(
    translationTableRule,
    /border-bottom:\s*2px\s+solid\s+var\(--document-table-boundary\)/u,
    '表格自身也必须绘制同色底边界，避免折叠边框时仅依赖空单元格的边框'
  )
  assert.doesNotMatch(lastRowCellRule, /--border-control/u,
    '普通控件边框色在浅色主题下对比度不足，不能作为表格最终外边界')
  assert.match(
    theme,
    /:root\[data-theme='sakura'\]\[data-theme-mode='light'\]\s*\{[^}]*--document-table-boundary:\s*#[0-9a-f]{6}/isu,
    '樱花浅色主题必须为表格外边界提供高对比语义色'
  )
})

test('PDF 译文表格底边不得被横向滚动容器裁切', () => {
  const css = read('src/renderer/src/document.css')
  const translationTableWrapperRule = /\.document-page\[data-layout='translation-flow'\]\s+\.document-table-block\s*\{([^}]*overflow-x:\s*auto[^}]*)\}/u.exec(css)?.[1] ?? ''

  assert.match(translationTableWrapperRule, /overflow-x:\s*auto/u,
    '表格仍需保留窄窗口横向滚动能力')
  assert.match(translationTableWrapperRule, /overflow-y:\s*clip/u,
    '纵向必须明确裁切，避免纵向滚动条占用布局并把末行底边挤出可视区域')
})

test('PDF 译文代码块必须保留等宽换行、主题边框和横向滚动', () => {
  const css = read('src/renderer/src/document.css')
  const translationCodeRule = /\.document-page\[data-layout='translation-flow'\]\s+\.document-text-block\.document-text-code\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const translationCodeRunRule = /\.document-page\[data-layout='translation-flow'\]\s+\.document-text-block\.document-text-code\s+\.document-text-run\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''

  assert.match(translationCodeRule, /white-space:\s*pre\s*!important/u)
  assert.match(translationCodeRule, /border:\s*var\(--border-width\)\s+solid\s+var\(--border-default\)/u)
  assert.match(translationCodeRule, /background:\s*var\(--bg-secondary\)/u)
  assert.match(translationCodeRule, /overflow-x:\s*auto/u)
  assert.match(translationCodeRunRule, /white-space:\s*pre\s*!important/u)
})

test('PDF 译文普通分隔线必须保留原始宽度和横向位置，不能被流式布局拉伸为整页宽', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const horizontalRule = /\.document-page\[data-layout='translation-flow'\] \.document-shape-block\[data-line-orientation='horizontal'\]\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const verticalRule = /\.document-page\[data-layout='translation-flow'\] \.document-shape-block\[data-line-orientation='vertical'\]\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''

  assert.match(source, /--document-shape-left/u)
  assert.match(source, /--document-shape-width/u)
  assert.match(horizontalRule, /width:\s*calc\(\s*var\(--document-shape-width[^;]*var\(--document-page-scale/u)
  assert.match(horizontalRule, /margin-left:\s*calc\(\s*var\(--document-shape-left[^;]*var\(--document-page-scale/u)
  assert.match(verticalRule, /margin-left:\s*calc\(\s*var\(--document-shape-left[^;]*var\(--document-page-scale/u)
})

test('PDF 译文分隔线必须按原文坐标叠放，不能进入普通流把页眉和正文依次下推', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const shapeRenderStart = source.indexOf('function renderShapeBlock(')
  const shapeRenderEnd = source.indexOf('/**', shapeRenderStart + 1)
  const shapeRenderSource = source.slice(shapeRenderStart, shapeRenderEnd)
  const shapeRule = /\.document-page\[data-layout='translation-flow'\] \.document-shape-block\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const positionedShapeRule = /\.document-page\[data-layout='translation-flow'\] \.document-shape-block\[data-line-orientation='horizontal'\]\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const horizontalRule = /\.document-page\[data-layout='translation-flow'\] \.document-shape-block\[data-line-orientation='horizontal'\]\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const verticalRule = /\.document-page\[data-layout='translation-flow'\] \.document-shape-block\[data-line-orientation='vertical'\]\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''

  assert.match(shapeRenderSource, /--document-shape-top/u)
  assert.match(shapeRenderSource, /--document-shape-height/u)
  assert.match(positionedShapeRule, /position:\s*absolute\s*!important/u)
  assert.match(positionedShapeRule, /top:\s*calc\(\s*var\(--document-shape-top[^;]*var\(--document-page-scale/u)
  assert.match(positionedShapeRule, /pointer-events:\s*none/u)
  assert.match(horizontalRule, /top:\s*calc\(\s*var\(--document-shape-top[^;]*var\(--document-page-scale/u)
  assert.match(verticalRule, /top:\s*calc\(\s*var\(--document-shape-top[^;]*var\(--document-page-scale/u)
})

test('PDF 绝对定位装饰线不得推进译文普通流底边，后续正文仍按原文坐标回到标题位置', () => {
  const source = read('src/renderer/src/document.ts')
  const renderPageStart = source.indexOf('function renderPage(')
  const renderPageEnd = source.indexOf('/**', renderPageStart + 1)
  const renderPageSource = source.slice(renderPageStart, renderPageEnd)
  const normalizeStart = source.indexOf('function normalizeTranslationFlowLayout(')
  const normalizeEnd = source.indexOf('/**', normalizeStart + 1)
  const normalizeSource = source.slice(normalizeStart, normalizeEnd)
  const line = {
    kind: 'shape' as const,
    blockId: 'line',
    readingOrder: 0,
    translatable: false,
    line: { orientation: 'horizontal' as const }
  }
  const shape = { ...line, line: undefined }
  const text = {
    kind: 'text' as const,
    blockId: 'text',
    readingOrder: 1,
    translatable: true,
    role: 'body' as const,
    runs: []
  }

  // 只有装饰线脱离普通流；图片、文本和其他形状仍必须推进真实底边。
  assert.equal(occupiesDocumentTranslationFlow(line), false)
  assert.equal(occupiesDocumentTranslationFlow(shape), true)
  assert.equal(occupiesDocumentTranslationFlow(text), true)
  assert.match(renderPageSource, /occupiesDocumentTranslationFlow\(block\)/u)
  assert.match(renderPageSource, /dataset\.flowOccupiesSpace/u)
  assert.match(normalizeSource, /flowOccupiesSpace\s*===\s*'false'/u)
})

test('PDF 分隔线缺少显式颜色时必须使用纸张前景色兜底，白底不能吞掉线条', () => {
  const source = read('src/renderer/src/document.ts')
  const shapeRenderStart = source.indexOf('function renderShapeBlock(')
  const shapeRenderEnd = source.indexOf('/**', shapeRenderStart + 1)
  const shapeRenderSource = source.slice(shapeRenderStart, shapeRenderEnd)

  assert.match(shapeRenderSource, /block\.line\.color\s*\?\?\s*'var\(--document-paper-text\)'/u)
  assert.doesNotMatch(shapeRenderSource, /block\.line\.color\s*\?\?\s*'var\(--border-default\)'/u)
})

test('PDF 同行图片与文字必须渲染在横向分组中，文字自然占满右侧可用宽度', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const renderPageStart = source.indexOf('function renderPage(')
  const renderPageEnd = source.indexOf('/**', renderPageStart + 1)
  const renderPageSource = source.slice(renderPageStart, renderPageEnd)
  const groupRule = /\.document-page\[data-layout='translation-flow'\] \.document-flow-group\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const groupTextRule = /\.document-page\[data-layout='translation-flow'\]\s+\.document-flow-group \.document-text-block\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const groupImageRule = /\.document-page\[data-layout='translation-flow'\]\s+\.document-flow-group \.document-image-block\[data-geometry='source'\]\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''

  assert.match(renderPageSource, /flowGroupId/u)
  assert.match(renderPageSource, /appendTranslationFlowBlock\(/u)
  assert.match(renderPageSource, /'document-flow-group'/u)
  assert.match(source, /document-flow-group/u)
  assert.match(source, /--document-flow-group-left/u)
  assert.match(source, /--document-flow-group-width/u)
  assert.match(source, /--document-flow-group-gap/u)
  assert.match(source, /--document-flow-group-text-top/u)
  assert.match(source, /resolveTranslationFlowGroupGeometry/u)
  assert.match(source, /flowGroupBlocks\.get\(block\.flowGroupId\)/u)
  assert.match(groupRule, /display:\s*flex/u)
  assert.match(groupRule, /align-items:\s*flex-start/u)
  assert.match(groupRule, /min-height:\s*calc\(\s*var\(--document-flow-group-height/u)
  assert.match(groupRule, /min-width:\s*0/u)
  assert.match(groupRule, /width:\s*calc\(\s*var\(--document-flow-group-width[^;]*var\(--document-page-scale/u)
  assert.match(groupRule, /margin-left:\s*calc\(\s*var\(--document-flow-group-left[^;]*var\(--document-page-scale/u)
  assert.match(groupTextRule, /flex:\s*1\s+1\s+auto/u)
  assert.match(groupTextRule, /min-width:\s*0/u)
  assert.match(groupTextRule, /width:\s*auto\s*!important/u)
  assert.match(groupTextRule, /max-width:\s*none\s*!important/u)
  assert.match(groupTextRule, /height:\s*auto\s*!important/u)
  assert.match(groupTextRule, /line-height:\s*normal\s*!important/u)
  assert.match(groupTextRule, /margin-left:\s*calc\(\s*var\(--document-flow-group-gap[^;]*var\(--document-page-scale/u)
  assert.match(groupTextRule, /margin-top:\s*calc\(\s*var\(--document-flow-group-text-top[^;]*var\(--document-page-scale/u)
  assert.match(groupImageRule, /flex:\s*0\s+0\s+auto/u)
  assert.match(groupImageRule, /margin-left:\s*0\s*!important/u)
})

test('PDF 页眉分组必须选择最近内框线并保留文字原始纵向偏移', () => {
  const headerImage: DocumentBlock = {
    kind: 'image',
    blockId: 'header-image',
    readingOrder: 0,
    translatable: false,
    flowGroupId: 'header-flow',
    bbox: { x: 367.8, y: 42.6, width: 18.6, height: 18.6 },
    assetId: 'header-image'
  }
  const headerText: DocumentBlock = {
    kind: 'text',
    blockId: 'header-text',
    readingOrder: 1,
    translatable: true,
    flowGroupId: 'header-flow',
    role: 'paragraph',
    bbox: { x: 397.32, y: 46.13, width: 108, height: 9 },
    runs: [{ runId: 'header-run', text: '友虹（北京）科技有限公司', style: { fontSize: 9 } }]
  }
  const pageBlocks: DocumentBlock[] = [
    {
      kind: 'shape',
      blockId: 'page-frame-right',
      readingOrder: 2,
      translatable: false,
      bbox: { x: 594.8, y: 0, width: 1, height: 841.9 },
      line: { orientation: 'vertical', thickness: 1 }
    },
    {
      kind: 'shape',
      blockId: 'header-frame-right',
      readingOrder: 3,
      translatable: false,
      bbox: { x: 510.25, y: 42.55, width: 1, height: 24.5 },
      line: { orientation: 'vertical', thickness: 1 }
    },
    {
      kind: 'shape',
      blockId: 'header-frame-top',
      readingOrder: 4,
      translatable: false,
      bbox: { x: 362.45, y: 42.05, width: 148.3, height: 1 },
      line: { orientation: 'horizontal', thickness: 1 }
    }
  ]

  const geometry = resolveTranslationFlowGroupGeometry(
    [headerImage, headerText],
    pageBlocks,
    595.3,
    { left: 132, right: 511.319, center: 321.6595 }
  )

  assert.equal(geometry.left, 367.8)
  assert.equal(geometry.width, 143.45)
  assert.ok(Math.abs(geometry.textTop - 3.53) < 0.0001)
})

test('PDF 表格增高后的装饰线必须跟随最近前序流式锚点', () => {
  const anchors = [{
    sourceTop: 100.5,
    sourceBottom: 614.25,
    actualTop: 100.5,
    actualBottom: 750
  }]

  assert.equal(resolveTranslationFlowDecorationTop(616.25, anchors, 1), 752)
  assert.equal(resolveTranslationFlowDecorationTop(670, anchors, 1), 805.75)
  assert.equal(resolveTranslationFlowDecorationTop(70, anchors, 1), undefined)
})

test('PDF 装饰线纵向与锚点重叠时必须保留相对锚点顶部的原始偏移', () => {
  const anchors = [{
    sourceTop: 100,
    sourceBottom: 300,
    actualTop: 120,
    actualBottom: 360
  }]

  assert.equal(resolveTranslationFlowDecorationTop(150, anchors, 1), 170)
})

test('PDF 装饰线必须选择最近前序锚点并应用页面缩放比例', () => {
  const anchors = [{
    sourceTop: 50,
    sourceBottom: 100,
    actualTop: 75,
    actualBottom: 150
  }, {
    sourceTop: 200,
    sourceBottom: 260,
    actualTop: 300,
    actualBottom: 390
  }]

  assert.equal(resolveTranslationFlowDecorationTop(270, anchors, 0.5), 395)
})

test('译文水印必须按容器宽度调整横向起点以均衡左右留白', () => {
  assert.equal(resolveTranslationWatermarkHorizontalOffset(800), -100)
  assert.equal(resolveTranslationWatermarkHorizontalOffset(900), -50)
  assert.equal(resolveTranslationWatermarkHorizontalOffset(960), -20)
  assert.equal(resolveTranslationWatermarkHorizontalOffset(1000), 0)
  assert.equal(resolveTranslationWatermarkHorizontalOffset(1200), 0)
})

test('译文水印横向起点必须忽略非法尺寸并保持非正偏移', () => {
  assert.equal(resolveTranslationWatermarkHorizontalOffset(Number.NaN), 0)
  assert.equal(resolveTranslationWatermarkHorizontalOffset(-20), 0)
})

test('PDF 译文装饰线必须按最近前序流式锚点动态重定位并观察页面自身高度', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const renderPageStart = source.indexOf('function renderPage(')
  const normalizeStart = source.indexOf('function normalizeTranslationFlowLayout(')
  const observeStart = source.indexOf('function observeTranslationPageScale(')
  const renderPageSource = source.slice(renderPageStart, observeStart)
  const normalizeSource = source.slice(normalizeStart, observeStart)
  const observeSource = source.slice(observeStart, source.indexOf('/**', observeStart + 1))
  const horizontalRule = /\.document-page\[data-layout='translation-flow'\] \.document-shape-block\[data-line-orientation='horizontal'\]\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const verticalRule = /\.document-page\[data-layout='translation-flow'\] \.document-shape-block\[data-line-orientation='vertical'\]\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''

  assert.match(renderPageSource, /dataset\.sourceTop/u)
  assert.match(renderPageSource, /dataset\.sourceBottom/u)
  assert.match(normalizeSource, /resolveTranslationFlowDecorationTop/u)
  assert.match(normalizeSource, /--document-shape-flow-offset/u)
  assert.match(normalizeSource, /flowDecorationAnchors/u)
  assert.match(observeSource, /observer\.observe\(page\)/u)
  assert.match(horizontalRule, /--document-shape-flow-offset/u)
  assert.match(verticalRule, /--document-shape-flow-offset/u)
})

test('设置页文档翻译入口必须使用自适应双列布局并重置说明缩进', () => {
  const html = read('src/renderer/settings.html')
  const css = read('src/renderer/src/settings.css')

  assert.match(html, /class="row document-settings-row"/u)
  assert.match(html, /class="document-settings-copy"/u)
  assert.match(html, /class="field-hint document-settings-description"/u)
  assert.match(css, /\.document-settings-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/su)
  assert.match(css, /\.document-settings-copy\s*\{[^}]*min-width:\s*0/su)
  assert.match(css, /\.document-settings-row \.document-settings-description\s*\{[^}]*margin:\s*4px 0 0/su)
  assert.match(css, /\.document-settings-row \.document-settings-description\s*\{[^}]*max-width:\s*64ch/su)
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*?\.document-settings-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/u)
})

test('文档译文界面必须显示真实品牌 logo、中英文产品名组成的黑白斜向重复水印且不阻挡交互', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const theme = read('src/renderer/src/theme.css')
  const watermarkStart = source.indexOf('function createTranslationWatermarkLogo(')
  const watermarkAppendStart = source.indexOf('function appendTranslationWatermark(')
  const watermarkAppendEnd = source.indexOf('/**', watermarkAppendStart + 1)
  const watermarkSource = source.slice(watermarkStart, watermarkAppendEnd)
  const watermarkRule = /\.document-translation-watermark\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''
  const tileRule = /\.document-translation-watermark-tile\s*\{([^}]*)\}/u.exec(css)?.[1] ?? ''

  assert.ok(watermarkStart > -1 && watermarkAppendStart > -1, '必须提供译文水印挂载函数')
  assert.match(watermarkSource, /className = 'document-translation-watermark'/u)
  assert.match(watermarkSource, /aria-hidden', 'true'/u)
  assert.match(watermarkSource, /document-translation-watermark-logo/u)
  assert.match(watermarkSource, /document-translation-watermark-text/u)
  assert.match(watermarkSource, /createTranslationWatermarkText\('划词翻译'/u)
  assert.match(watermarkSource, /createTranslationWatermarkText\(\s*'Selection Translator'/u)
  assert.match(watermarkSource, /rounded-yi-glyph/u)
  assert.match(watermarkSource, /data-font-family/u)
  assert.match(watermarkSource, /tile\.setAttribute\('width', '320'\)/u)
  assert.match(watermarkSource, /tile\.setAttribute\('height', '180'\)/u)
  assert.match(watermarkSource, /tile\.setAttribute\('x'/u)
  assert.match(watermarkSource, /resolveTranslationWatermarkHorizontalOffset/u)
  assert.match(source, /new ResizeObserver/u)
  assert.match(source, /watermarkResizeObserver/u)
  assert.match(source, /watermarkResizeObserver\?\.disconnect\(\)/u)
  assert.match(watermarkSource, /content\.setAttribute\('transform', 'rotate\(-45 160 90\)'\)/u)
  assert.doesNotMatch(watermarkSource, /setAttribute\(['"]patternTransform['"]/u)
  assert.match(watermarkSource, /createTranslationWatermarkPattern\(/u)
  assert.match(watermarkSource, /fill', 'currentColor'/u)
  assert.match(watermarkSource, /stroke', 'currentColor'/u)
  assert.match(watermarkSource, /side !== 'translation'/u)
  assert.match(watermarkSource, /content\.append\(logo, chineseText, englishText\)/u)
  assert.match(watermarkSource, /logo\.setAttribute\('x', '74'\)/u)
  assert.match(watermarkSource, /logo\.setAttribute\('y', '96'\)/u)
  assert.match(watermarkSource, /logo\.setAttribute\('width', '24'\)/u)
  assert.match(watermarkSource, /chineseText\.setAttribute\('x', '106'\)/u)
  assert.match(watermarkSource, /chineseText\.setAttribute\('y', '107'\)/u)
  assert.match(watermarkSource, /englishText\.setAttribute\('x', '108'\)/u)
  assert.match(watermarkSource, /englishText\.setAttribute\('y', '127'\)/u)
  assert.match(source, /appendTranslationWatermark\(/u)
  assert.match(watermarkRule, /position:\s*absolute/u)
  assert.match(watermarkRule, /inset:\s*0/u)
  assert.match(watermarkRule, /pointer-events:\s*none/u)
  assert.match(tileRule, /color:\s*var\(--document-watermark-ink-strong\)/u)
  assert.match(css, /\.document-translation-watermark-pattern\s*\{[^}]*width:\s*100%/su)
  assert.match(css, /\.document-translation-watermark-logo path\s*\{[^}]*fill:\s*currentColor/su)
  assert.match(css, /\.document-translation-watermark-logo path\s*\{[^}]*stroke:\s*currentColor/su)
  assert.match(theme, /--document-watermark-ink:/u)
  assert.match(theme, /--document-watermark-ink-strong:/u)
  assert.match(css, /\.document-translation-watermark-text--english\s*\{[^}]*font-size:\s*14px/su)
  assert.doesNotMatch(watermarkSource, /#[0-9a-f]{3,8}\b/iu)
})

test('PDF 与图片顶部栏必须立即显示 OCR 原文/译文切换，并动态切换右侧标题和内容', () => {
  const html = read('src/renderer/document.html')
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')

  assert.match(html, /id="document-source-ocr-mode"[^>]*hidden/u)
  assert.match(html, /data-ocr-mode="ocr-text"[^>]*data-i18n="document\.ocr\.source"/u)
  assert.match(html, /data-ocr-mode="translation"[^>]*data-i18n="document\.ocr\.translation"/u)
  assert.match(html, /id="document-translation-heading"[^>]*data-i18n="document\.translation"/u)
  assert.match(source, /const translationHeading = document\.getElementById\('document-translation-heading'\)/u)
  assert.match(source, /translationHeading\.textContent = t\(\s*displayMode === 'ocr-text'/u)
  assert.match(source, /const translationPaneModel = displayMode === 'ocr-text' \? snapshot\.source : snapshot\.translation/u)
  assert.match(source, /const format = snapshot\.source\?\.source\.format/u)
  assert.match(source, /format === 'pdf' \|\| format === 'image'/u)
  assert.match(css, /#document-translation-content\[data-ocr-display-mode='ocr-text'\][\s\S]*?\.document-ocr-print-text-layer\s*\{[^}]*display:\s*block/su)
})

test('PDF OCR 原文必须使用 Canvas 底图并叠加可缩放的透明文字层', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')

  assert.match(source, /if \(model\.source\.format === 'pdf' && side === 'source'\)/u)
  assert.match(source, /else if \(model\.source\.format === 'pdf' && tab\.ocrDisplayMode === 'ocr-text'\)/u)
  assert.match(source, /const textLayer = createPdfOcrTextLayer\(modelPage\)/u)
  assert.match(source, /if \(textLayer\) article\.append\(textLayer\)/u)
  assert.match(source, /--document-pdf-page-width/u)
  assert.match(source, /--document-pdf-page-height/u)
  assert.match(source, /--document-pdf-source-width/u)
  assert.match(source, /--document-pdf-source-height/u)
  assert.match(css, /\.document-pdf-page\s*\{[^}]*position:\s*relative/su)
  assert.match(css, /\.document-pdf-page\s*\{[^}]*overflow:\s*hidden/su)
  assert.match(css, /\.document-pdf-page\s*\{[^}]*width:\s*var\(--document-pdf-page-width/su)
  assert.match(css, /\.document-pdf-page\s*\{[^}]*height:\s*var\(--document-pdf-page-height/su)
  assert.match(css, /\.document-pdf-canvas\s*\{[^}]*height:\s*100%/su)
})

test('图片预览必须按原始宽高比完整显示，不能被容器拉伸变形', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')

  assert.match(source, /previewHost\.dataset\.documentFormat = model\.source\.format/u)
  assert.match(
    source,
    /--document-page-aspect-ratio[\s\S]{0,160}?\$\{Math\.max\(1, page\.width\)\}\s*\/\s*\$\{Math\.max\(1, page\.height\)\}/u
  )
  assert.match(
    css,
    /\.document-preview-host\[data-document-format='image'\]\s+\.document-page\[data-layout='absolute'\]\s*\{[^}]*width:\s*100%\s*!important[^}]*aspect-ratio:\s*var\(--document-page-aspect-ratio\)/su
  )
  assert.match(
    css,
    /\.document-preview-host\[data-document-format='image'\][\s\S]*?\.document-page\[data-layout='absolute'\] \.document-image-block\s*\{[^}]*height:\s*100%\s*!important/su
  )
  assert.match(
    css,
    /\.document-preview-host\[data-document-format='image'\][\s\S]*?\.document-page-image\s*\{[^}]*object-fit:\s*contain/su
  )
})

test('图片预览身份必须只跟随源文件指纹，OCR 流式更新不得撤销原图资源', () => {
  const source = read('src/renderer/src/document.ts')
  const identityStart = source.indexOf('function documentPreviewIdentity(')
  const identityEnd = source.indexOf('/**', identityStart + 1)
  const identitySource = source.slice(identityStart, identityEnd)

  assert.match(
    identitySource,
    /model\.source\.format === 'pdf' \|\| model\.source\.format === 'image'/u
  )
  assert.match(identitySource, /return `\$\{model\.source\.format\}:\$\{model\.source\.sha256\}`/u)
  assert.match(
    identitySource,
    /model\.source\.format === 'image'\)\s*\{\s*return `\$\{model\.source\.format\}:\$\{model\.source\.sha256\}`\s*\}/u
  )
})

test('图片异步加载完成时只能更新仍然挂载的当前图片节点', () => {
  const source = read('src/renderer/src/document.ts')
  const loadStart = source.indexOf('function loadDocumentImageAsset(')
  const loadEnd = source.indexOf('/**', loadStart + 1)
  const loadSource = source.slice(loadStart, loadEnd)

  assert.match(loadSource, /const isCurrentImage = \(\): boolean =>/u)
  assert.match(loadSource, /wrapper\.isConnected/u)
  assert.match(loadSource, /image\.parentElement === wrapper/u)
  assert.match(loadSource, /querySelector\(':scope > img\.document-page-image'\) === image/u)
  assert.match(loadSource, /if \(!url\) \{\s*if \(!isCurrentImage\(\)\) return/u)
  assert.match(loadSource, /addEventListener\('load', \(\) => \{\s*if \(!isCurrentImage\(\)\) return/u)
  assert.match(loadSource, /addEventListener\('error', \(\) => \{\s*if \(!isCurrentImage\(\)\) return/u)
})

test('图片资源与源文件预览必须显式携带当前任务标识', () => {
  const source = read('src/renderer/src/document.ts')
  const assetStart = source.indexOf('async function resolveAssetUrl(')
  const assetEnd = source.indexOf('/**', assetStart + 1)
  const assetSource = source.slice(assetStart, assetEnd)

  assert.match(
    assetSource,
    /window\.api\.getDocumentAsset\(jobId, assetId\)/u,
    '图片资源必须按任务读取，不能依赖启动返回前可能为空的 activeJobId'
  )
  assert.match(source, /renderPage\(page, pageRenderSide, pageScale, jobId, tab\)/u)
  assert.match(source, /window\.api\.getDocumentSource\(jobId\)/u)
  assert.match(source, /renderDocumentModel\([\s\S]*?'source',[\s\S]*?snapshot\.jobId,/u)
  assert.match(source, /renderDocumentModel\([\s\S]*?'translation',[\s\S]*?snapshot\.jobId,/u)
  assert.match(source, /window\.api\.retryFailedDocument\(snapshot\.jobId, jobGeneration\)/u)
})

test('OCR 原文模式必须允许直接选择透明文字层', () => {
  const css = read('src/renderer/src/document.css')
  const source = read('src/renderer/src/document.ts')

  assert.match(
    css,
    /#document-translation-content\[data-ocr-display-mode='ocr-text'\]\s+\.document-ocr-text-layer\s*\{[^}]*pointer-events:\s*auto[^}]*user-select:\s*text/su
  )
  // 图片文字层必须显式建立高于底图的命中层，不能只依赖父容器继承 pointer-events。
  assert.match(
    css,
    /\.document-image-block\[data-ocr-text='true'\]\s*>\s*\.document-ocr-text-layer\s*\{[^}]*z-index:\s*2[^}]*pointer-events:\s*auto[^}]*user-select:\s*text/su
  )
  const tableCellStart = source.indexOf('function renderTableCellImageBlock(')
  const tableCellEnd = source.indexOf('/**', tableCellStart + 1)
  assert.match(source.slice(tableCellStart, tableCellEnd), /appendImageOcrLayers\(wrapper, block, side, tab\)/u)
})

test('图片 OCR 原文必须复用源页绝对布局并让透明文字层优先接收指针', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const renderStart = source.indexOf('function renderDocumentModel(')
  const renderEnd = source.indexOf('/**', renderStart + 1)
  const renderSource = source.slice(renderStart, renderEnd)

  assert.match(
    renderSource,
    /const pageRenderSide = tab\.ocrDisplayMode === 'ocr-text' && model\.source\.format === 'image'\s*\? 'source'\s*: side/u
  )
  assert.match(renderSource, /renderPage\(page, pageRenderSide, pageScale, jobId, tab\)/u)
  assert.match(
    css,
    /\.document-preview-host\[data-document-format='image'\][\s\S]*?\.document-image-block > \.document-page-image\s*\{[^}]*pointer-events:\s*none/su
  )
})

test('PDF OCR 文字层必须包含原生文本、表格文本和公式原文', () => {
  const source = read('src/renderer/src/document.ts')
  const start = source.indexOf('function createPdfOcrTextLayer(')
  const collectorStart = source.indexOf('function collectOcrImageBlocks(')
  const end = source.indexOf('/**', start + 1)
  const fn = source.slice(collectorStart, end)

  assert.match(fn, /collectPdfTextBlocks/u)
  assert.match(fn, /block\.runs/u)
  assert.match(fn, /cell\.blocks/u)
  assert.match(fn, /sourceText/u)
  assert.match(fn, /pdfPagePercent\(box\.x, page\.width\)/u)
  assert.match(fn, /normalizeDocumentOcrRegionBox\(region\.bbox\)/u)
})

test('切换 OCR 原文/译文必须取消旧任务、清空进度并按新模式重新执行', () => {
  const source = read('src/renderer/src/document.ts')
  const start = source.indexOf("button.addEventListener('click'")
  const end = source.indexOf('syncOcrDisplayModeControls()\n  window.api.onDocumentProgress', start)
  const handler = source.slice(start, end)

  assert.match(handler, /button\.addEventListener\('click', async \(\) => \{/u)
  assert.match(handler, /const nextMode = button\.dataset\.ocrMode === 'ocr-text' \? 'ocr-text' : 'translation'/u)
  assert.match(handler, /const tab = getActiveDocumentTab\(\)/u)
  assert.match(handler, /if \(!tab \|\| tab\.ocrDisplayMode === nextMode\) return/u)
  assert.doesNotMatch(handler, /if \(!tab \|\| ocrDisplayMode === nextMode\) return/u)
  assert.match(handler, /ocrDisplayMode = nextMode/u)
  assert.match(handler, /tab\.ocrDisplayMode = nextMode/u)
  assert.match(handler, /syncOcrDisplayModeControls\(\)/u)
  assert.match(handler, /const jobId = tab\.activeJobId \?\? tab\.expectedJobId\s*const jobGeneration = tab\.generation/u)
  assert.match(handler, /const jobId = tab\.activeJobId \?\? tab\.expectedJobId/u)
  assert.match(handler, /await cancelDocumentJob\(jobId, jobGeneration\)/u)
  assert.match(source, /async function cancelDocumentJob\(jobId: string \| null, jobGeneration: number\): Promise<void> \{\s*if \(!jobId\) return\s*try \{\s*await window\.api\.cancelDocument\(jobId, jobGeneration\)/su)
  assert.match(handler, /resetDocumentRunForModeSwitch\(tab\)/u)
  assert.match(handler, /if \(jobId\) await releaseDocumentJob\(jobId\)/u)
  assert.match(
    source,
    /function resetDocumentRunForModeSwitch\(tab: DocumentWorkspaceTab \| null = getActiveDocumentTab\(\)\): void \{\s*[\s\S]*?tab\.snapshot = null[\s\S]*?latestSnapshot = null[\s\S]*?progressbar\.style\.width = '0%'/u
  )
  assert.match(handler, /await startDocumentTabTranslation\(tab\)/u)
})

test('切换 OCR 原文/译文只能重建右侧内容并保留左侧原文预览', () => {
  const source = read('src/renderer/src/document.ts')
  const resetStart = source.indexOf('function resetDocumentRunForModeSwitch(')
  const resetEnd = source.indexOf('/**', resetStart + 1)
  const resetSource = source.slice(resetStart, resetEnd)
  const startStart = source.indexOf('async function startDocumentTabTranslation(')
  const startEnd = source.indexOf('/**', startStart + 1)
  const startSource = source.slice(startStart, startEnd)
  const renderStart = source.indexOf('function renderSnapshot(')
  const renderEnd = source.indexOf('/**', renderStart + 1)
  const renderSource = source.slice(renderStart, renderEnd)

  assert.match(source, /function clearActiveTabTranslationPreview\(\): void/u)
  assert.match(resetSource, /clearActiveTabTranslationPreview\(\)/u)
  assert.doesNotMatch(resetSource, /sourceContent\.replaceChildren\(\)/u)
  assert.doesNotMatch(resetSource, /renderedSourcePreviewIdentity = ''/u)
  assert.match(startSource, /clearActiveTabTranslationPreview\(\)/u)
  assert.doesNotMatch(startSource, /clearActiveTabPreview\(\)/u)
  assert.match(
    renderSource,
    /const canReuseRenderedSourcePreview = renderedSourcePreviewTabId === tab\.id &&\s*renderedSourcePreviewSha256 === tab\.selection\.sha256/u,
    '新任务准备阶段缺少 source 时，只有同一 Tab 与同一文件指纹才能沿用左侧原文'
  )
})

test('启动请求期间切换 OCR 模式必须立即清空旧进度并隔离旧任务事件', () => {
  const source = read('src/renderer/src/document.ts')
  const start = source.indexOf("button.addEventListener('click'")
  const end = source.indexOf('syncOcrDisplayModeControls()\n  window.api.onDocumentProgress', start)
  const handler = source.slice(start, end)
  const pendingBranch = handler.slice(
    handler.indexOf('if (tab.startInFlight || tab.pendingOcrModeRestart)'),
    handler.indexOf('// reset 会清空 expectedJobId；正常切换也必须先保存旧任务标识')
  )

  assert.match(source, /function resetDocumentRunForModeSwitch\(tab: DocumentWorkspaceTab \| null/u)
  assert.match(pendingBranch, /tab\.pendingOcrModeRestart = true/u)
  assert.match(pendingBranch, /tab\.pendingLanguageRetranslation = false/u)
  assert.match(pendingBranch, /const jobId = tab\.activeJobId \?\? tab\.expectedJobId\s*const jobGeneration = tab\.generation/u)
  assert.match(pendingBranch, /resetDocumentRunForModeSwitch\(tab\)/u)
  assert.match(pendingBranch, /cancelDocumentJob\(jobId, jobGeneration\)/u)
  assert.match(pendingBranch, /return/u)
  assert.match(source, /window\.api\.onDocumentProgress\(\(snapshot\) => \{\s*routeDocumentSnapshot\(snapshot, false\)/su)
  assert.match(source, /window\.api\.onDocumentCompleted\(\(snapshot\) => \{\s*routeDocumentSnapshot\(snapshot, true\)/su)
  assert.match(source, /if \(tab\.pendingOcrModeRestart\) return false/u)
  assert.match(source, /!tab\.pendingOcrModeRestart &&\s*tab\.generation === snapshot\.generation/u)
})

test('文件入口必须调用多文件预检并允许选择图片原文和 OCR 文字层', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')

  assert.match(source, /async function chooseDocumentFiles\(\): Promise<void>/u)
  assert.match(source, /function inspectBrowserFiles\(files: readonly File\[\]\): Promise<void>/u)
  assert.match(source, /void inspectBrowserFiles\(Array\.from\(input\.files \?\? \[\]\)\)/u)
  assert.match(source, /void inspectBrowserFiles\(Array\.from\(event\.dataTransfer\?\.files \?\? \[\]\)\)/u)
  assert.match(source, /async function addDocumentFilesFromWorkbench\(\): Promise<void>/u)
  assert.match(source, /const results = await window\.api\.selectDocumentFiles\(\)/u)
  assert.match(source, /await window\.api\.approveDocumentFiles\(validatedPaths\)/u)
  assert.match(source, /documentWorkbenchReplaceButton\.addEventListener\('click', \(\) => void addDocumentFilesFromWorkbench\(\)\)/u)
  assert.match(source, /window\.api\.onDocumentProgress\(\(snapshot\) => \{\s*routeDocumentSnapshot\(snapshot, false\)/su)
  assert.match(source, /window\.api\.onDocumentCompleted\(\(snapshot\) => \{\s*routeDocumentSnapshot\(snapshot, true\)/su)
  assert.match(source, /function findDocumentTabByTranslationUpdate\(/u)
  assert.match(source, /updateDocumentTabSnapshot\(tab, next\)/u)
  assert.match(source, /tab\.ocrDisplayMode = nextMode/u)
  assert.match(source, /tab\.pendingOcrModeRestart = true/u)
  assert.match(source, /await startDocumentTabTranslation\(tab\)/u)
  assert.doesNotMatch(source, /function chooseDocumentFile\(\)/u)
  assert.doesNotMatch(source, /function inspectBrowserFile\(file: File\)/u)
  assert.doesNotMatch(source, /function replaceDocumentFromWorkbench\(\)/u)
  assert.match(css, /aspect-ratio:\s*var\(--document-page-aspect-ratio\)/u)
  assert.match(css, /object-fit:\s*contain/u)
})

test('文档工作台必须提供三模式、同步、页码、目录与缩放控件', () => {
  const html = read('src/renderer/document.html')
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const zh = read('src/shared/i18n/catalog.zh-CN.document.ts')
  const en = read('src/shared/i18n/catalog.en-US.document.ts')

  assert.match(html, /data-document-view-mode="source"/u)
  assert.match(html, /data-document-view-mode="translation"/u)
  assert.match(html, /data-document-view-mode="spread"/u)
  assert.match(html, /id="document-sync-scroll"[^>]*role="switch"[^>]*aria-checked="true"/u)
  assert.match(html, /id="document-page-input"[^>]*inputmode="numeric"/u)
  assert.match(html, /id="document-page-previous"/u)
  assert.match(html, /id="document-page-next"/u)
  assert.match(html, /id="document-toc-button"[^>]*aria-haspopup="listbox"/u)
  assert.match(html, /id="document-toc-list"[^>]*role="listbox"/u)
  assert.match(html, /id="document-zoom-out"/u)
  assert.match(html, /id="document-zoom-value"[^>]*aria-live="polite"/u)
  assert.match(html, /id="document-zoom-in"/u)
  assert.match(html, /id="document-zoom-reset"/u)
  assert.match(html, /id="document-zoom-fit"/u)
  assert.match(source, /resolveDocumentPageJump/u)
  assert.match(source, /resolveDocumentTocTarget/u)
  assert.match(source, /resolveDocumentBlockHighlight/u)
  assert.match(source, /resolveFitDocumentZoom/u)
  assert.match(source, /clampDocumentZoom/u)
  assert.match(source, /function scrollToDocumentTarget\(/u)
  assert.match(source, /function highlightDocumentBlock\(/u)
  assert.match(source, /function setDocumentScrollSync\(/u)
  assert.match(source, /function setDocumentZoom\(/u)
  assert.match(source, /data-active-block["']\s*,\s*["']true["']/u)
  assert.match(css, /\.document-block-active/u)
  assert.match(css, /\.document-page-scroll\s*\{[^}]*scroll-behavior:/su)
  assert.match(zh, /'document\.viewMode\.source'/u)
  assert.match(en, /'document\.viewMode\.source'/u)
  assert.match(zh, /'document\.syncScroll'/u)
  assert.match(en, /'document\.syncScroll'/u)
  assert.match(zh, /'document\.zoom\.fit'/u)
  assert.match(en, /'document\.zoom\.fit'/u)
})

test('文档历史必须通过受控 IPC 列出、打开、删除并清空缓存', () => {
  const types = read('src/shared/types.ts')
  const preload = read('src/preload/index.ts')
  const main = read('src/main/index.ts')
  const protocol = read('src/shared/documentWorkspace.ts')
  const listStart = main.indexOf("ipcMain.handle('document:list-history'")
  const openStart = main.indexOf("ipcMain.handle('document:open-history'")
  const deleteStart = main.indexOf("ipcMain.handle('document:delete-history'")
  const clearStart = main.indexOf("ipcMain.handle('document:clear-cache'")
  const clearEnd = main.indexOf('/**', clearStart + 1)
  const deleteSource = main.slice(deleteStart, clearStart)
  const clearSource = main.slice(clearStart, clearEnd)

  assert.match(protocol, /listHistory:\s*'document:list-history'/u)
  assert.match(protocol, /openHistory:\s*'document:open-history'/u)
  assert.match(protocol, /deleteHistory:\s*'document:delete-history'/u)
  assert.match(protocol, /clearCache:\s*'document:clear-cache'/u)
  assert.match(types, /DocumentHistoryEntry/u)
  assert.match(types, /listDocumentHistory\(\): Promise<DocumentHistoryEntry\[\]>/u)
  assert.match(types, /openDocumentHistory\(jobId: string\): Promise<\{ snapshot: DocumentWorkspaceSnapshot \} \| null>/u)
  assert.match(types, /deleteDocumentHistory\(jobId: string\): Promise<boolean>/u)
  assert.match(types, /clearDocumentCache\(\): Promise<void>/u)
  assert.match(preload, /ipcRenderer\.invoke\('document:list-history'\)/u)
  assert.match(preload, /ipcRenderer\.invoke\('document:open-history', jobId\)/u)
  assert.match(preload, /ipcRenderer\.invoke\('document:delete-history', jobId\)/u)
  assert.match(preload, /ipcRenderer\.invoke\('document:clear-cache'\)/u)
  assert.ok(listStart > -1 && openStart > -1 && deleteStart > -1 && clearStart > -1)
  for (const start of [listStart, openStart, deleteStart, clearStart]) {
    const handler = main.slice(start, main.indexOf('/**', start + 1))
    assert.match(handler, /isDocumentWorkspaceSender\(event\.sender\)/u)
  }
  assert.match(deleteSource, /getSourceSha256\(jobId\)/u)
  assert.match(deleteSource, /deleteBySourceSha256\(sourceSha256\)/u)
  assert.match(clearSource, /documentTranslationCache\.clear\(\)/u)
  assert.match(clearSource, /documentTaskHistory\.clear\(\)/u)
  assert.doesNotMatch(clearSource, /saveSettings\(/u)
})

test('文档历史列表必须展示完整摘要并使用对话框确认删除和清空', () => {
  const html = read('src/renderer/document.html')
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
  const zh = read('src/shared/i18n/catalog.zh-CN.document.ts')
  const en = read('src/shared/i18n/catalog.en-US.document.ts')

  assert.match(html, /id="document-history-confirm-dialog"/u)
  assert.match(html, /id="document-history-confirm-delete"/u)
  assert.match(html, /id="document-history-clear"/u)
  assert.match(source, /async function loadDocumentTaskHistory\(/u)
  assert.match(source, /window\.api\.listDocumentHistory\(\)/u)
  assert.match(source, /window\.api\.openDocumentHistory\(entry\.jobId\)/u)
  assert.match(source, /window\.api\.deleteDocumentHistory\(jobId\)/u)
  assert.match(source, /window\.api\.clearDocumentCache\(\)/u)
  assert.match(source, /sourceKind:\s*'history'/u)
  assert.match(source, /function isReadOnlyDocumentTab\(/u)
  assert.match(source, /if \(isReadOnlyDocumentTab\(tab\)\) return/u)
  assert.match(source, /revokeAssetUrls\(\)[\s\S]*releaseHtmlPreviewUrl\(\)/u)
  assert.match(css, /\.document-history-item-actions/u)
  assert.match(css, /\.document-history-confirm-dialog/u)
  assert.doesNotMatch(css, /\.document-history-confirm-dialog[^}]*#[0-9a-f]{3,8}\b/iu)
  for (const key of [
    'historyClear',
    'historyOpen',
    'historyDelete',
    'historyReadOnly',
    'historyExported',
    'historyNotExported',
    'historyDeleteTitle',
    'historyDeleteDescription',
    'historyClearTitle',
    'historyClearDescription',
    'historyCancel',
    'historyConfirmDelete',
    'historyConfirmClear',
    'historyDeleted',
    'historyCleared',
    'historyLoadFailed'
  ]) {
    assert.match(zh, new RegExp(`['"]document\\.${key}['"]\\s*:`, 'u'), `中文词条缺少 ${key}`)
    assert.match(en, new RegExp(`['"]document\\.${key}['"]\\s*:`, 'u'), `英文词条缺少 ${key}`)
  }
})

test('统一历史列表必须支持打开、删除确认、清空确认与完整键盘导航', () => {
  const source = read('src/renderer/src/document.ts')
  const html = read('src/renderer/document.html')
  const initStart = source.indexOf('async function initializeDocumentWorkspace()')
  const initSource = source.slice(initStart, source.indexOf('/**', initStart + 1))

  assert.ok(initStart > -1)
  assert.match(initSource, /await restoreDocumentViewerState\(\)\s*await loadDocumentTaskHistory\(\)/u)
  assert.match(source, /visibleDocumentHistory\[0\]/u)
  assert.match(source, /openDocumentHistoryEntry\(entry\)/u)
  assert.match(source, /data-history-action/u)
  assert.match(source, /data-history-target-id/u)
  assert.match(source, /setDocumentHistoryConfirmation\(\{ kind: 'delete', entry: entry\.task \}, actionButton\)/u)
  assert.match(source, /setDocumentHistoryConfirmation\(\{ kind: 'clear' \}/u)
  assert.match(source, /documentHistoryConfirmDelete\.addEventListener\('click'/u)
  assert.match(source, /documentHistoryConfirmCancel\.addEventListener\('click'/u)
  assert.match(source, /function closeDocumentHistoryConfirmation\(restoreFocus = true\)/u)
  assert.match(source, /documentHistoryConfirmDialog\.addEventListener\('cancel'/u)
  assert.match(source, /documentHistoryConfirmDialog\.addEventListener\('close'/u)
  assert.match(source, /event\.key === 'Home'/u)
  assert.match(source, /event\.key === 'End'/u)
  assert.match(source, /event\.key === 'Escape'/u)
  assert.match(
    source,
    /documentHistoryList\.querySelectorAll<HTMLButtonElement>\('\[data-history-action\]'\)/u
  )
  assert.match(
    source,
    /event\.key === 'Escape' &&[\s\S]*?!historyPopover\.hidden[\s\S]*?!documentHistoryConfirmDialog\.open/u
  )
  assert.match(html, /role="alertdialog"/u)
})

test('历史操作必须支持窄屏、减少动画、可见焦点与文本复制', () => {
  const css = read('src/renderer/src/document.css')

  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.document-history-confirm-dialog\s*\{[^}]*width:\s*calc\(100vw - var\(--space-6\)\)/u)
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.document-progressbar\s*\{[^}]*transition:\s*none/u)
  assert.match(css, /#document-source-content,\s*#document-translation-content\s*\{[^}]*user-select:\s*text/u)
  assert.match(css, /\.document-history-action:focus-visible/u)
})

test('历史任务必须以真实任务标识只读打开，关闭时不得取消或释放活动任务', () => {
  const source = read('src/renderer/src/document.ts')
  const openStart = source.indexOf('async function openDocumentHistoryTask(')
  const openSource = source.slice(openStart, source.indexOf('/**', openStart + 1))
  const closeStart = source.indexOf('async function closeDocumentTab(')
  const closeSource = source.slice(closeStart, source.indexOf('/**', closeStart + 1))
  const imageStart = source.indexOf('function renderImageBlock(')
  const imageSource = source.slice(imageStart, source.indexOf('/**', imageStart + 1))

  assert.ok(openStart > -1)
  assert.match(openSource, /window\.api\.openDocumentHistory\(entry\.jobId\)/u)
  assert.doesNotMatch(openSource, /runDocument\(/u)
  assert.match(openSource, /snapshot:\s*result\.snapshot/u)
  assert.match(openSource, /activeJobId:\s*null/u)
  assert.match(openSource, /expectedJobId:\s*null/u)
  assert.match(openSource, /sourceKind:\s*'history'/u)
  assert.match(closeSource, /if \(isReadOnlyDocumentTab\(tab\)\) return/u)
  assert.match(imageSource, /loadDocumentImageAsset\(wrapper, image, block, jobId, tab\)/u)
  assert.match(source, /if \(isReadOnlyDocumentTab\(tab\)\) return/u)
})

test('工作台状态恢复必须先重新授权文件，并以内容指纹拒绝不一致的旧模型', () => {
  const source = read('src/renderer/src/document.ts')
  const types = read('src/shared/types.ts')
  const main = read('src/main/index.ts')
  const restoreStart = source.indexOf('async function restoreDocumentViewerState(')
  const restoreEnd = source.indexOf('/**', restoreStart + 1)
  const restoreSource = source.slice(restoreStart, restoreEnd)
  const validationStart = main.indexOf('async function validateApprovedDocumentPath')
  const validationEnd = main.indexOf('/**', validationStart + 1)
  const validationSource = main.slice(validationStart, validationEnd)

  assert.ok(restoreStart > -1)
  assert.match(types, /interface DocumentFileSelectionSuccess[\s\S]*?sha256: string/u)
  assert.match(validationSource, /createHash\('sha256'\)/u)
  assert.match(validationSource, /createReadStream\(\)/u)
  assert.match(validationSource, /sha256/u)
  assert.match(source, /readDocumentViewerState\(\)/u)
  assert.match(restoreSource, /for \(const savedTab of state\.tabs\)/u,
    '恢复时必须逐个重新授权持久化 Tab，不能只恢复首个文件')
  assert.match(restoreSource, /window\.api\.approveDocumentFile\(savedTab\.selection\.path\)/u)
  assert.match(restoreSource, /validateRestoredDocumentViewerFile\(savedTab\.selection, authorized\)/u)
  assert.match(restoreSource, /createRestoredDocumentWorkspaceTab\(savedTab\)/u)
  assert.match(source, /function createRestoredDocumentWorkspaceTab\([\s\S]*?createRestoredDocumentWorkspaceSnapshot\(savedTab\)/u)
  assert.match(source, /restoreDocumentViewerState\(\)/u)
})

test('关闭页面后恢复首个历史 Tab 时，必须串行恢复并使用正常格式渲染原文', () => {
  const source = read('src/renderer/src/document.ts')
  const restoreStart = source.indexOf('async function restoreDocumentViewerState(')
  const restoreSource = source.slice(restoreStart, source.indexOf('/**', restoreStart + 1))
  const restoredTabStart = source.indexOf('function createRestoredDocumentWorkspaceTab(')
  const restoredTabSource = source.slice(restoredTabStart, source.indexOf('/**', restoredTabStart + 1))
  const initStart = source.indexOf('async function initializeDocumentWorkspace()')
  const initSource = source.slice(initStart, source.indexOf('/**', initStart + 1))
  const renderStart = source.indexOf('function renderSnapshot(')
  const renderBodyStart = source.indexOf('{', renderStart)
  const renderSource = source.slice(renderBodyStart, source.indexOf('/**', renderStart + 1))
  const modelStart = source.indexOf('function renderDocumentModel(')
  const modelSource = source.slice(modelStart, source.indexOf('/**', modelStart + 1))

  assert.ok(restoreStart > -1)
  assert.ok(initStart > -1)
  assert.match(restoredTabSource, /sourceKind:\s*'restored'/u)
  assert.match(restoreSource, /documentTabs = restoredTabs/u,
    '恢复时必须按原顺序建立全部恢复 Tab，不能让历史列表提前成为活动 Tab')
  assert.match(restoreSource, /activeDocumentTabId = restoredActiveTabId \?\? restoredTabs\[0\]!\.id/u,
    '恢复时必须优先激活持久化的活动 Tab')
  assert.match(restoreSource, /renderActiveDocumentTab\(getActiveDocumentTab\(\)!\)/u)
  assert.match(initSource, /await restoreDocumentViewerState\(\)\s*await loadDocumentTaskHistory\(\)/u,
    '历史列表必须等待恢复流程完成后再加载，避免恢复前打开历史第一个 Tab')
  assert.match(renderSource, /renderDocumentModel\([\s\S]*?snapshot\.source[\s\S]*?tab\s*\)/u,
    '原文栏必须使用快照自带的源模型和所属 Tab 渲染')
  assert.match(renderSource, /renderDocumentModel\([\s\S]*?translationPaneModel[\s\S]*?tab\s*\)/u,
    '译文栏必须使用快照自带的译文模型和所属 Tab 渲染')
  assert.doesNotMatch(modelSource, /renderRestoredDocumentSourcePreview/u,
    '恢复态原文必须复用正常格式渲染器，不能统一降级为流式预览')
  assert.match(modelSource, /side === 'source' && model\.source\.format === 'html'/u)
  assert.match(modelSource, /model\.source\.format === 'pdf' && side === 'source'/u)
})

test('恢复快照不得复用旧任务身份，且必须禁用旧任务操作与资源预览', () => {
  const source = read('src/renderer/src/document.ts')
  const renderStart = source.indexOf('function renderDocumentModel(')
  const renderEnd = source.indexOf('/**', renderStart + 1)
  const renderSource = source.slice(renderStart, renderEnd)
  const taskStart = source.indexOf('function renderTaskState(')
  const taskEnd = source.indexOf('/**', taskStart + 1)
  const taskSource = source.slice(taskStart, taskEnd)
  const exportStart = source.indexOf('async function exportTranslatedPdf(')
  const exportEnd = source.indexOf('/**', exportStart + 1)
  const exportSource = source.slice(exportStart, exportEnd)
  const retryStart = source.indexOf('async function retryFailedDocumentTranslation(')
  const retryEnd = source.indexOf('/**', retryStart + 1)
  const retrySource = source.slice(retryStart, retryEnd)

  assert.match(source, /const RESTORED_DOCUMENT_JOB_ID = 'restored-viewer-state'/u)
  assert.match(source, /function isRestoredDocumentTab\(/u)
  const restoredTabStart = source.indexOf('function createRestoredDocumentWorkspaceTab(')
  const restoredTabSource = source.slice(restoredTabStart, source.indexOf('/**', restoredTabStart + 1))
  assert.match(restoredTabSource, /activeJobId: null/u)
  assert.match(restoredTabSource, /expectedJobId: null/u)
  assert.match(restoredTabSource, /generation: 0/u)
  assert.match(restoredTabSource, /startInFlight: false/u)
  assert.doesNotMatch(renderSource, /renderRestoredDocumentSourcePreview/u)
  assert.match(renderSource, /renderHtmlSourcePreview\(previewHost, model, jobId, tab\)/u)
  assert.match(renderSource, /renderPdfPages\(previewHost, model, jobId, tab\)/u)
  assert.match(taskSource, /isRestoredDocumentTab\(/u)
  assert.match(taskSource, /exportButton\.disabled = true/u)
  assert.match(taskSource, /retryButton\.disabled = true/u)
  assert.match(taskSource, /cancelButton\.hidden = true/u)
  assert.match(exportSource, /isRestoredDocumentTab\(tab\)/u)
  assert.match(retrySource, /isRestoredDocumentTab\(tab\)/u)
})

test('打开历史任务必须重新授权源文件并校验路径、格式、大小和 SHA-256', () => {
  const source = read('src/renderer/src/document.ts')
  const openStart = source.indexOf('async function openDocumentHistoryTask(')
  const openSource = source.slice(openStart, source.indexOf('/**', openStart + 1))

  assert.ok(openStart > -1)
  assert.match(openSource, /snapshot\.source\?\.source/u)
  assert.match(openSource, /window\.api\.approveDocumentFile\(/u,
    '历史任务必须重新授权快照指向的源文件，旧任务释放后仍能读取图片、PDF 与 HTML')
  assert.match(openSource, /sha256/u)
  assert.match(openSource, /authorized\.size/u)
  assert.match(openSource, /authorized\.format/u)
  assert.match(openSource, /sourceAuthorized/u,
    '授权失败时仍应回放已保存译文，但资源读取必须明确失败')
  assert.match(openSource, /sourceKind:\s*'history'/u)
})

test('工作台必须在滚动、缩放、模式、语言与译文变化后节流保存状态', () => {
  const source = read('src/renderer/src/document.ts')

  assert.match(source, /function persistActiveDocumentViewerState\(/u)
  assert.match(source, /function scheduleDocumentViewerStatePersist\(/u)
  assert.match(source, /function readDocumentViewerState\(/u)
  assert.match(source, /function writeDocumentViewerState\(/u)
  assert.match(source, /serializeDocumentViewerState/u)
  assert.match(source, /parseDocumentViewerState/u)
  assert.match(source, /sourceContent\.addEventListener\('scroll',[\s\S]*?scheduleDocumentViewerStatePersist/u)
  assert.match(source, /translationContent\.addEventListener\('scroll',[\s\S]*?scheduleDocumentViewerStatePersist/u)
  assert.match(source, /function setDocumentZoom\([\s\S]*?scheduleDocumentViewerStatePersist/u)
  assert.match(source, /function setDocumentViewMode\([\s\S]*?scheduleDocumentViewerStatePersist/u)
  assert.match(source, /function retranslateDocumentAfterLanguageChange\([\s\S]*?scheduleDocumentViewerStatePersist/u)
  assert.match(source, /function routeDocumentSnapshot\([\s\S]*?scheduleDocumentViewerStatePersist/u)
  assert.match(source, /window\.addEventListener\('beforeunload',[\s\S]*?persistActiveDocumentViewerState/u)
})
