import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { parseMarkdownDocument } from '../src/main/documentTextParser.ts'
import {
  occupiesDocumentTranslationFlow,
  resolveTranslationFlowDecorationTop,
  resolveTranslationFlowGroupGeometry,
  resolveTranslationWatermarkHorizontalOffset
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

test('文档工作台上传面板必须提供可访问的主操作、隐私边界与主题化自适应布局', () => {
  const html = read('src/renderer/document.html')
  const css = read('src/renderer/src/document.css')

  assert.match(
    html,
    /id="document-start-button"[^>]*class="[^"]*document-primary-button[^"]*"[^>]*data-i18n="document\.upload\.start"[^>]*disabled/u
  )
  assert.match(html, /id="document-upload-panel"[^>]*role="tabpanel"[^>]*aria-labelledby="document-tab-single"/u)
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
  assert.match(source, /const retryableTerminal = status === 'partial' \|\|[\s\S]{0,160}status === 'failed'[\s\S]{0,160}retryableFailedBlocks/u)
  assert.match(source, /retryButton\.disabled = !retryableTerminal \|\|[\s\S]{0,120}phaseCompleted[\s\S]{0,120}retryableFailedBlocks/u)
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
  assert.match(serviceSource, /translate: async \(text, signal, _request, languagePair, onDelta\)/u)
  assert.match(serviceSource, /sourceLang: languagePair\.sourceLang/u)
  assert.match(serviceSource, /targetLang: languagePair\.targetLang/u)
  assert.match(pipeline, /resolveDocumentLanguagePair\(/u)
  assert.match(pipeline, /languageResolution: DocumentLanguageResolution/u)
  assert.match(pipeline, /deps\.translate\(item\.batch\.text, signal, languagePair, \(delta\)/u)
  assert.match(pipeline, /deps\.translate\(segment\.text, signal, languagePair\)/u)
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
    /id="document-actual-language"[^>]*data-i18n="document\.actualLanguage"[^>]*aria-live="polite"/u
  )
  assert.match(source, /const actualLanguage = document\.getElementById\('document-actual-language'\) as HTMLElement/u)
  assert.match(source, /function renderActualLanguage\(languagePair\?: DocumentWorkspaceSnapshot\['languagePair'\]\)/u)
  assert.match(source, /langLabel\(languagePair\.sourceLang, localeRuntime\.locale\)/u)
  assert.match(source, /langLabel\(languagePair\.targetLang, localeRuntime\.locale\)/u)
  assert.match(source, /t\('document\.actualLanguage', \{ direction \}\)/u)
  assert.match(source, /actualLanguage\.textContent = t\('document\.actualLanguageAuto'\)/u)
  assert.match(source, /snapshot\.languagePair/u)
  assert.match(source, /sourceLanguageSelect\.value = selectedSource \|\| 'auto'/u)
  assert.match(source, /targetLanguageSelect\.value = selectedTarget \|\| 'auto'/u)
  assert.doesNotMatch(source, /sourceLanguageSelect\.value = snapshot\.languagePair/u)
  assert.doesNotMatch(source, /targetLanguageSelect\.value = snapshot\.languagePair/u)
  assert.match(source, /actualLanguage\.textContent = t\('document\.actualLanguageAuto'\)/u)
  const resetStart = source.indexOf('function resetWorkbenchPreview()')
  const resetSource = source.slice(resetStart, source.indexOf('/**', resetStart + 1))
  const replaceStart = source.indexOf('async function replaceDocumentFromWorkbench()')
  const replaceSource = source.slice(replaceStart, source.indexOf('/**', replaceStart + 1))
  const startStart = source.indexOf('async function startDocumentTranslation()')
  const startSource = source.slice(startStart, source.indexOf('async function cancelDocumentTranslation', startStart))
  const localeStart = source.indexOf('localeRuntime.onLocaleChanged(')
  const localeSource = source.slice(localeStart, source.indexOf('\n  })', localeStart) + 4)
  assert.match(resetSource, /actualLanguage\.textContent = t\('document\.actualLanguageAuto'\)/u)
  assert.match(replaceSource, /resetWorkbenchPreview\(\)/u)
  assert.match(startSource, /actualLanguage\.textContent = t\('document\.actualLanguageAuto'\)/u)
  assert.match(localeSource, /renderSnapshot\(latestSnapshot\)/u)
  assert.match(css, /\.document-actual-language\b/u)
  assert.match(css, /var\(--text-secondary\)/u)
  assert.match(css, /flex-wrap:\s*wrap/u)
  assert.match(zh, /'document\.actualLanguage': '实际方向：\{\{direction\}\}'/u)
  assert.match(zh, /'document\.actualLanguageAuto': '自动'/u)
  assert.match(en, /'document\.actualLanguage': 'Actual direction: \{\{direction\}\}'/u)
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

test('文件翻译流式更新必须原位更新变化内容，不能重建整份译文 DOM', () => {
  const source = read('src/renderer/src/document.ts')

  assert.match(source, /let renderedTranslationPreviewKind/u)
  assert.match(source, /function patchTranslationPreview\(/u)
  assert.match(source, /function patchTranslationTextBlock\(/u)
  assert.match(source, /function patchTranslationOcrLayer\(/u)
  assert.match(source, /patchTranslationPreview\(translationContent, snapshot\.translation\)/u)
  assert.match(source, /existingRun\.textContent = run\.text/u)
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
  const mutateIndex = patchSource.indexOf('patchTranslationBlock(block')
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
    /for \(const page of model\.pages\)[\s\S]*const pageScale = side === 'translation'\s*\? initialTranslationPageScale\(container, page\.width\)\s*: 1[\s\S]*previewHost\.append\(renderPage\(page, side, pageScale\)\)/u,
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
    /exportPdf:\s*\(model,\s*_dependencies,\s*partialExport\)\s*=>\s*\{[\s\S]*?documentWorkspace\?\.getWindow\(\)[\s\S]*?printDocumentPreviewToPdf\(window\.webContents,\s*model,\s*partialExport\)/u
  )
  assert.doesNotMatch(main, /from '\.\/documentPdfExport'/u)
  assert.doesNotMatch(main, /exportDocumentToPdf\(/u)
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
  assert.match(source, /pdf:\$\{model\.source\.sha256\}/u)
  assert.match(source, /renderedSourcePreviewIdentity/u)
  assert.match(source, /renderedTranslationSignature/u)
  assert.doesNotMatch(source, /renderedSource !== snapshot\.source/u)
  assert.doesNotMatch(source, /renderedTranslation !== snapshot\.translation/u)
})

test('文档终态与导出前必须同步刷新最新译文快照，不能停留在流式部分译文', () => {
  const source = read('src/renderer/src/document.ts')
  const flushStart = source.indexOf('function flushSnapshotRender(')
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
  assert.match(flushSource, /renderSnapshot\(snapshot\)/u)
  assert.match(flushSource, /renderTaskState\(snapshot\)/u)
  assert.match(completedSource, /flushSnapshotRender\(snapshot\)/u)
  assert.match(exportSource, /flushSnapshotRender\(latestSnapshot\)/u)
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

test('终态完成后迟到的进度快照不得覆盖最终译文', () => {
  const source = read('src/renderer/src/document.ts')
  const progressStart = source.indexOf('window.api.onDocumentProgress(')
  const progressEnd = source.indexOf('window.api.onDocumentCompleted(', progressStart)
  const progressSource = source.slice(progressStart, progressEnd)

  assert.ok(progressStart > -1, '必须订阅文档进度事件')
  assert.match(progressSource, /canApplyProgressSnapshot\(snapshot\)/u)
  assert.match(source, /canApplyDocumentTaskEvent\(/u)
  assert.match(source, /latestSnapshot\.task/u)
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
    /async function renderPdfPages\(\s*container: HTMLElement,\s*generationAtStart: number,\s*model: DocumentModel\s*\)/u
  )
  assert.match(renderSource, /model\.source\.format === 'pdf' && side === 'source'/u)
  assert.match(renderSource, /void renderPdfPages\(previewHost, generation, model\)/u)
  assert.match(renderSource, /for \(const page of model\.pages\)[\s\S]*const pageScale = side === 'translation'/u)
  assert.match(renderSource, /renderPage\(page, side, pageScale\)/u)
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
  assert.match(patchSource, /patchTranslationBlock\(block/u)
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
  assert.match(renderSource, /renderPage\(page, side, pageScale\)/u,
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
  assert.match(source, /renderPdfPages\(previewHost, generation, model\)/u)
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
  assert.match(source, /getDocumentSource\(\)/u)
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
    /function renderPage\(\s*page: DocumentPage,\s*side: DocumentRenderSide,\s*translationInitialScale = 1\s*\): HTMLElement/u
  )
  assert.match(
    source,
    /function renderBlock\(\s*block: DocumentBlock,\s*side: DocumentRenderSide,\s*pageWidth: number(?:,\s*contentArea\?: DocumentContentArea)?\s*\)/u
  )
  assert.match(source, /renderPage\(\s*page,\s*side(?:,\s*translationInitialScale)?\s*\)/u)
  assert.match(source, /renderBlock\(block, side, page\.width, page\.contentArea\)/u)
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
  assert.match(css, /\.document-ocr-original-mask-layer\s*\{[^}]*height:\s*calc\(/su)
  assert.match(css, /\.document-ocr-original-mask-layer\s*\{[^}]*var\(--document-image-height,\s*0px\)\s*\*\s*var\(--document-page-scale,\s*1\)/su)
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

  assert.match(tableCellSource, /renderTableCellImageBlock\(block, side\)/u)
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
