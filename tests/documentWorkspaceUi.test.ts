import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { parseMarkdownDocument } from '../src/main/documentTextParser.ts'

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

test('文档工作台必须提供单文件上传态与禁用的批量页签', () => {
  const html = read('src/renderer/document.html')
  const source = read('src/renderer/src/document.ts')
  assert.match(html, /role="tablist"/u)
  assert.match(html, /id="document-tab-single"[^>]*role="tab"[^>]*aria-selected="true"/u)
  assert.match(html, /id="document-tab-batch"[^>]*role="tab"[^>]*aria-disabled="true"[^>]*disabled/u)
  assert.match(html, /id="document-drop-zone"/u)
  assert.match(html, /id="document-file-input"[^>]*type="file"[^>]*accept=/u)
  assert.match(html, /id="document-start-button"[^>]*disabled/u)
  assert.match(html, /data-i18n="document\.upload\.dropHint"/u)
  assert.match(html, /data-i18n="document\.upload\.formats"/u)
  assert.match(html, /data-i18n="document\.upload\.privacy"/u)
  assert.match(html, /data-i18n="document\.upload\.batchComingSoon"/u)
  assert.match(html, /id="document-history-button"/u)
  assert.match(html, /id="document-workbench-replace"[^>]*data-i18n="document\.upload\.replace"/u)
  assert.match(source, /documentWorkbenchReplaceButton\.addEventListener\('click'/u)
  assert.match(source, /async function replaceDocumentFromWorkbench\(/u)
  assert.match(source, /await window\.api\.cancelDocument\(/u)
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
  assert.match(source, /retryButton\.disabled = status !== 'partial' \|\|[\s\S]{0,120}phaseCompleted[\s\S]{0,120}retryableFailedBlocks/u)
  assert.match(source, /retryButton\.addEventListener\('click',\s*\(\)\s*=>\s*void retryFailedDocumentTranslation\(\)\)/u)
  assert.match(source, /async function retryFailedDocumentTranslation\(/u)
  assert.match(source, /await window\.api\.retryFailedDocument\(/u)
  assert.match(zh, /'document\.retryFailed': '重新翻译失败项'/u)
  assert.match(zh, /'document\.retryStarted': '正在重新翻译失败项…'/u)
  assert.match(en, /'document\.retryFailed': 'Retry failed items'/u)
  assert.match(en, /'document\.retryStarted': 'Retrying failed items…'/u)
})

test('文档翻译顶部栏必须提供与页面翻译一致的源语言和目标语言切换', () => {
  const html = read('src/renderer/document.html')
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')
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

test('文档翻译目标语言必须默认自动并在主进程按分段文本解析实际语言对', () => {
  const source = read('src/renderer/src/document.ts')
  const main = read('src/main/index.ts')
  const serviceStart = main.indexOf('function createDocumentWorkspaceTaskService')
  const serviceEnd = main.indexOf('/**', serviceStart + 1)
  const serviceSource = main.slice(serviceStart, serviceEnd)

  assert.match(source, /targetLanguageSelect\.value = selectedTarget \|\| 'auto'/u)
  assert.match(source, /populateDocumentLanguages\(\{ sourceLang: 'auto', targetLang: 'auto' \} as Settings\)/u)
  assert.match(serviceSource, /const pair = resolveLanguagePair\(text, sourcePreference, targetPreference\)/u)
  assert.match(serviceSource, /sourceLang: pair\.sourceLang/u)
  assert.match(serviceSource, /targetLang: pair\.targetLang/u)
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
  const start = source.indexOf('async function startDocumentTranslation')
  const end = source.indexOf('async function cancelDocumentTranslation')
  const startSource = source.slice(start, end)

  assert.match(source, /async function retranslateDocumentAfterLanguageChange\(/u)
  assert.match(source, /await window\.api\.cancelDocument\(activeJobId, generation\)/u)
  assert.match(source, /await startDocumentTranslation\(\)/u)
  assert.equal((startSource.match(/sourceLang:\s*sourceLanguageSelect\.value/gu) ?? []).length, 2)
  assert.equal((startSource.match(/targetLang:\s*targetLanguageSelect\.value/gu) ?? []).length, 2)
  assert.match(startSource, /appliedLanguagePair = `\$\{sourceLanguageSelect\.value\}\\u0000\$\{targetLanguageSelect\.value\}`/u)
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
  assert.match(source, /window\.api\.selectDocumentFile\(\)/u)
  assert.match(source, /window\.api\.approveDocumentFile\(/u)
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
  assert.match(types, /selectDocumentFile\(\): Promise<DocumentFileSelectionResult>/u)
  assert.match(preload, /ipcRenderer\.send\('document:open'\)/u)
  assert.match(preload, /ipcRenderer\.invoke\('document:select-file'\)/u)
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
  assert.match(main, /document:select-file/u)
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

test('生产 PDF 导出必须直接打印译文预览而不是重新排版模型', () => {
  const main = read('src/main/index.ts')

  assert.match(main, /import \{ printDocumentPreviewToPdf \} from '\.\/documentPdfPrint'/u)
  assert.match(
    main,
    /exportPdf:\s*\(model\)\s*=>\s*\{[\s\S]*?documentWorkspace\?\.getWindow\(\)[\s\S]*?printDocumentPreviewToPdf\(window\.webContents,\s*model\)/u
  )
  assert.doesNotMatch(main, /from '\.\/documentPdfExport'/u)
  assert.doesNotMatch(main, /exportDocumentToPdf\(/u)
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
  assert.match(source, /syncScroll\(sourceContent, translationContent\)/u)
  assert.match(source, /syncScroll\(translationContent, sourceContent\)/u)
  assert.match(source, /expectedJobId !== null/u)
  assert.match(source, /runDocument\(/u)
  assert.match(source, /function documentPreviewIdentity\(/u)
  assert.match(source, /pdf:\$\{model\.source\.sha256\}/u)
  assert.match(source, /renderedSourcePreviewIdentity/u)
  assert.match(source, /renderedTranslationSignature/u)
  assert.doesNotMatch(source, /renderedSource !== snapshot\.source/u)
  assert.doesNotMatch(source, /renderedTranslation !== snapshot\.translation/u)
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
  assert.match(flowSource, /article\.append\(renderPage\(page, side\)\)/u)
  assert.match(translationRule, /height:\s*auto\s*!important/u)
  assert.match(translationRule, /min-height:\s*0\s*!important/u)
  assert.match(translationRule, /overflow:\s*visible/u)
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
  const start = source.indexOf('async function startDocumentTranslation')
  const end = source.indexOf('async function cancelDocumentTranslation')
  const startSource = source.slice(start, end)
  const current = source.indexOf('function isCurrentSnapshot')
  const currentEnd = source.indexOf('/**', current + 1)
  const currentSource = source.slice(current, currentEnd)

  assert.match(startSource, /let jobGeneration = nextGeneration\(\)/u)
  assert.match(startSource, /let result: DocumentRunResult = await window\.api\.runDocument/u)
  assert.match(startSource, /if \(generation !== jobGeneration\) return/u)
  assert.match(startSource, /result\.code === 'generation-conflict'/u)
  assert.match(startSource, /result\.suggestedGeneration/u)
  assert.match(startSource, /expectedJobId === null/u)
  assert.match(startSource, /latestSnapshot === null/u)
  assert.match(startSource, /adoptSuggestedGeneration\(result\.suggestedGeneration\)/u)
  assert.match(currentSource, /snapshot\.generation !== generation/u)
  assert.match(currentSource, /expectedJobId/u)
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
  assert.match(source, /getDocumentSource\(\)/u)
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

test('PDF 原文 Canvas 必须显式使用白色背景，避免空白页被合成成黑色', () => {
  const source = read('src/renderer/src/document.ts')
  const renderStart = source.indexOf('async function renderPdfPages(')
  const renderEnd = source.indexOf('/**', renderStart + 1)
  const renderSource = source.slice(renderStart, renderEnd)

  assert.match(renderSource, /getContext\('2d',\s*\{\s*alpha:\s*false\s*\}\)/u)
  assert.match(renderSource, /background:\s*'#ffffff'/u)
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

test('PDF 居中与右对齐译文必须沿用原文本块宽度，不能按整页正文宽度重新换行', () => {
  const source = read('src/renderer/src/document.ts')
  const geometryStart = source.indexOf('function applyTranslationBlockGeometry(')
  const geometryEnd = source.indexOf('/**', geometryStart + 1)
  const geometrySource = source.slice(geometryStart, geometryEnd)

  assert.match(
    geometrySource,
    /block\.textAlign === 'center'\s*\|\|\s*block\.textAlign === 'right'[\s\S]*?\?\s*blockWidth/su
  )
  assert.match(
    geometrySource,
    /block\.textAlign === 'center'[\s\S]*?\?\s*left\s*:\s*block\.textAlign === 'right'\s*\?\s*right - flowWidth/su
  )
})

test('PDF 左对齐译文扩展宽度时必须保留原左边距且不得越过页面右边界', () => {
  const source = read('src/renderer/src/document.ts')
  const geometryStart = source.indexOf('function applyTranslationBlockGeometry(')
  const geometryEnd = source.indexOf('/**', geometryStart + 1)
  const geometrySource = source.slice(geometryStart, geometryEnd)

  assert.match(geometrySource, /const rightInset = Math\.max\(0, pageWidth - right\)/u)
  assert.match(
    geometrySource,
    /Math\.max\(blockWidth, pageWidth - left - rightInset\)/u
  )
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
    /function renderImageBlock\(\s*block: DocumentImageBlock,\s*side: DocumentRenderSide,\s*pageWidth: number\s*\)/u
  )
  assert.match(source, /case 'image': return renderImageBlock\(block, side, pageWidth\)/u)
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
  // 图片资源是原页面 bbox 的栅格化结果，必须完整铺满该 bbox；contain 会在比例有微小误差时留下黑底或白边。
  assert.match(
    css,
    /\.document-page\[data-layout='translation-flow'\] \.document-image-block\[data-geometry='source'\]\s+\.document-page-image[\s\S]*?object-fit:\s*fill/u
  )
})

test('PDF 译文图片必须锚定原文纵向坐标，但不得回退覆盖已排版的译文', () => {
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
  // 前文译文变高越过原图锚点时，图片必须从实际文字底边继续下推，不能用负间距覆盖文字。
  assert.match(normalizeSource, /gapPx = Math\.max\(0, anchoredTop - previousBottom\)/u)
  assert.doesNotMatch(normalizeSource, /gapPx = anchoredTop - previousBottom/u)
  assert.match(renderPageSource, /dataset\.sourceY/u)
  assert.match(source, /normalizeTranslationFlowLayout\(page\)/u)
  assert.match(
    imageRule,
    /margin-top:\s*calc\(\s*var\(--document-image-flow-gap-before,\s*var\(--document-flow-gap-before,\s*0px\)\)[^;]*var\(--document-page-scale/su
  )
})

test('PDF 图片异步资源在节点插入页面前解析完成时不得被丢弃', () => {
  const source = read('src/renderer/src/document.ts')
  const renderStart = source.indexOf('function renderImageBlock(')
  const renderEnd = source.indexOf('/**', renderStart + 1)
  const imageRenderSource = source.slice(renderStart, renderEnd)

  assert.match(imageRenderSource, /void resolveAssetUrl\(block\.assetId\)\.then\(\(url\) => \{/u)
  assert.doesNotMatch(imageRenderSource, /image\.isConnected/u)
  assert.match(imageRenderSource, /if \(!url\) return\s+image\.src = url/u)
})

test('PDF 源预览必须按文件身份复用并把告警层与画布分离', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')

  assert.match(source, /function documentPreviewIdentity\(/u)
  assert.match(source, /model\.source\.format === 'pdf'/u)
  assert.match(source, /return `pdf:\$\{model\.source\.sha256\}`/u)
  assert.match(source, /const sourceChanged = renderedSourcePreviewIdentity !== sourcePreviewIdentity/u)
  assert.match(source, /if \(sourceChanged\) revokeAssetUrls\(\)/u)
  assert.doesNotMatch(source, /if \(sourceChanged \|\| translationChanged\) revokeAssetUrls\(\)/u)
  assert.match(source, /function renderDocumentWarnings\(/u)
  assert.match(source, /className = 'document-preview-host'/u)
  assert.match(source, /className = 'document-warning-list'/u)
  assert.match(source, /\.document-preview-host/u)
  assert.match(source, /renderPdfPages\(previewHost, generation\)/u)
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

test('HTML 源文预览必须使用隔离 webview 原样加载文件，并允许远程资源', () => {
  const source = read('src/renderer/src/document.ts')
  const manager = read('src/main/documentWorkspaceWindow.ts')
  const html = read('src/renderer/document.html')
  const css = read('src/renderer/src/document.css')

  assert.match(source, /function renderHtmlSourcePreview/u)
  assert.match(source, /document\.createElement\('webview'\)/u)
  assert.match(source, /webview\.src\s*=\s*toFileUrl\(/u)
  assert.match(source, /side === 'source' && model\.source\.format === 'html'/u)
  assert.match(manager, /webviewTag:\s*true/u)
  assert.match(manager, /on\('will-attach-webview'/u)
  assert.match(manager, /delete webPreferences\.preload/u)
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
    'unsafe-package-path',
    'unsafe-epub-chapter',
    'missing-epub-chapter',
    'ocr-required',
    'embedded-image-ocr-required',
    'ocr-failed',
    'ocr-no-text',
    'invalid-json',
    'unclosed-code-fence',
    'invalid-subtitle',
    'translation-partial',
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
  assert.match(source, /snapshot\.translation\?\.warnings/u)
  assert.match(css, /\.document-warning-list/u)
})

test('文档双栏预览必须在源文隐藏 OCR 文本层，译文按阅读顺序流式避让且不裁切', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')

  assert.match(source, /type DocumentRenderSide = 'source' \| 'translation'/u)
  assert.match(source, /function renderOcrRegion\([^)]*side: DocumentRenderSide/u)
  assert.match(source, /if \(side !== 'translation'\) return null/u)
  assert.match(source, /const translatedText = region\.translatedText\?\.trim\(\)/u)
  assert.match(source, /if \(!translatedText\) return null/u)
  assert.match(
    source,
    /function renderPage\(\s*page: DocumentPage,\s*side: DocumentRenderSide\s*\): HTMLElement/u
  )
  assert.match(source, /function renderBlock\(block: DocumentBlock, side: DocumentRenderSide, pageWidth: number\)/u)
  assert.match(source, /renderPage\(\s*page,\s*side\s*\)/u)
  assert.match(source, /renderBlock\(block, side, page\.width\)/u)
  assert.match(source, /renderTableCellBlock\(child, side\)/u)
  assert.match(source, /--document-ocr-font-size-pt/u)
  assert.match(source, /resolveOcrRegionFontSize\(region, imageHeight\)/u)
  assert.match(source, /region\.textAlign/u)
  assert.match(source, /textAlign = block\.textAlign/u)
  assert.match(source, /style: region\.style/u)
  assert.match(source, /textAlign: region\.textAlign/u)
  assert.match(source, /document-ocr-translation-layer/u)
  assert.match(source, /--document-ocr-gap-before/u)
  assert.match(source, /resolveOcrRegionFontSize/u)
  assert.match(source, /resolveOcrRegionLineHeight/u)
  assert.match(source, /resolveOcrRegionPadding/u)
  assert.match(source, /resolveOcrRegionGapBefore/u)
  assert.match(source, /pdfPreviewFontFamily\(region\.style\?\.fontFamily/u)
  assert.match(source, /dataset\.ocrTranslation = 'true'/u)
  assert.match(css, /\.document-ocr-region\s*\{[^}]*background:\s*var\(--document-paper-bg\)/su)
  assert.match(css, /\.document-ocr-region\s*\{[^}]*color:\s*var\(--document-paper-text\)/su)
  assert.match(css, /\.document-ocr-region\s*\{[^}]*var\(--document-ocr-font-size-pt[^;]*\*\s*var\(--document-page-scale[^;]*\*\s*1px/su)
  assert.match(css, /\.document-ocr-region\s*\{[^}]*overflow:\s*visible/su)
  assert.match(css, /\.document-ocr-region\s*\{[^}]*height:\s*auto/su)
  assert.match(
    css,
    /\.document-ocr-region\s*\{[^}]*line-height:\s*var\(--document-ocr-line-height,\s*1\.15\)/su
  )
  assert.doesNotMatch(css, /\.document-ocr-region\s*\{[^}]*--document-ocr-min-height/su)
  assert.match(css, /\.document-ocr-original-mask\s*\{[^}]*position:\s*absolute/su)
  assert.match(css, /\.document-ocr-original-mask-layer\s*\{[^}]*pointer-events:\s*none/su)
  assert.match(css, /@font-face\s*\{[^}]*font-family:\s*'Noto Sans SC'/su)
  assert.match(css, /assets\/fonts\/NotoSansSC-Regular\.ttf/u)
  assert.match(
    css,
    /\.document-page\[data-layout='translation-flow'\] \.document-image-block\[data-ocr-translation='true'\][\s\S]*?overflow:\s*visible/su
  )
  assert.match(
    css,
    /\.document-ocr-translation-layer\s*\{[\s\S]*?display:\s*flex[\s\S]*?flex-direction:\s*column/su
  )
})

test('文档预览必须按文件格式分派并为 Markdown 使用语义渲染', () => {
  const source = read('src/renderer/src/document.ts')
  const css = read('src/renderer/src/document.css')

  assert.match(source, /type DocumentPreviewKind = 'paged' \| 'markdown' \| 'table' \| 'subtitle' \| 'flow'/u)
  assert.match(source, /function resolvePreviewKind\(model: DocumentModel, side: DocumentRenderSide\): DocumentPreviewKind/u)
  assert.match(source, /format === 'markdown'/u)
  assert.match(source, /format === 'csv'/u)
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
