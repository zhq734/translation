import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('网页阅读器应提供原位翻译工具栏、原生 View 占位和自适应主题样式', () => {
  const html = readFileSync('src/renderer/web-reader.html', 'utf8')
  const renderer = readFileSync('src/renderer/src/webReader.ts', 'utf8')
  const css = readFileSync('src/renderer/src/webReader.css', 'utf8')
  const vite = readFileSync('electron.vite.config.ts', 'utf8')

  for (const id of ['web-address', 'web-back', 'web-forward', 'web-reload', 'web-source-lang', 'web-target-lang', 'web-translate', 'web-cancel', 'web-mode', 'web-view-slot']) {
    assert.match(html, new RegExp(`id="${id}"`, 'u'))
  }
  assert.match(html, /value="source"/u)
  assert.match(html, /value="target"/u)
  assert.match(renderer, /new ResizeObserver/u)
  assert.match(renderer, /webViewSetBounds/u)
  assert.match(renderer, /sourceLang/u)
  assert.match(renderer, /targetLang/u)
  assert.match(renderer, /translationGeneration/u)
  assert.match(renderer, /webTranslateCancel\(\)/u)
  const stateRenderer = renderer.slice(
    renderer.indexOf('function renderReaderState'),
    renderer.indexOf('/**\n * 根据翻译进度刷新状态栏')
  )
  assert.match(stateRenderer, /if \(translating\) return/u)
  assert.ok(stateRenderer.indexOf('if (translating) return') < stateRenderer.indexOf("setStatus('正在加载网页…')"))
  assert.doesNotMatch(html, /web-sidebar|web-sidebar-toggle|web-blocks/u)
  assert.doesNotMatch(renderer, /webTranslateScrollToBlock|sidebarBlocks/u)
  assert.match(css, /display:\s*(?:flex|grid)/u)
  assert.match(css, /min-height:\s*0/u)
  assert.match(css, /var\(--/u)
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}|rgb\(/u)
  assert.match(vite, /['"]web-reader['"]:\s*resolve\('src\/renderer\/web-reader\.html'\)/u)
})

test('网页翻译 IPC、preload 与托盘入口应完整且受限', () => {
  const main = readFileSync('src/main/index.ts', 'utf8')
  const manager = readFileSync('src/main/webReaderWindow.ts', 'utf8')
  const preload = readFileSync('src/preload/index.ts', 'utf8')
  const types = readFileSync('src/shared/types.ts', 'utf8')
  const popup = readFileSync('src/renderer/index.html', 'utf8')
  for (const channel of [
    'webview:open', 'webview:close', 'webview:back', 'webview:forward', 'webview:reload',
    'webview:set-bounds', 'web-translate:extract', 'web-translate:run', 'web-translate:cancel',
    'web-translate:set-mode', 'web-translate:page-updated'
  ]) {
    assert.match(`${main}\n${manager}`, new RegExp(channel, 'u'))
    assert.match(preload, new RegExp(channel, 'u'))
  }
  assert.match(preload, /web-translate:progress/u)
  assert.match(preload, /onWebTranslatePageUpdated/u)
  assert.match(types, /openWebReader/u)
  assert.match(popup, /id="open-web-reader"/u)
  assert.match(main, /打开网页翻译/u)
})

test('网页阅读器应支持恢复并聚焦尚未关闭的窗口', () => {
  const manager = readFileSync('src/main/webReaderWindow.ts', 'utf8')
  const focusMethod = manager.slice(
    manager.indexOf('focusExistingWindow(): boolean'),
    manager.indexOf('/** 关闭阅读器并取消任务。')
  )

  assert.match(focusMethod, /if \(!this\.window \|\| this\.window\.isDestroyed\(\)\) return false/u)
  assert.match(focusMethod, /if \(this\.window\.isMinimized\(\)\) this\.window\.restore\(\)/u)
  assert.match(focusMethod, /this\.window\.show\(\)/u)
  assert.match(focusMethod, /this\.window\.focus\(\)/u)
  assert.match(focusMethod, /return true/u)
})

test('网页提取应等待主文档可交互，而不是被全局 loading 状态误拦截', () => {
  const manager = readFileSync('src/main/webReaderWindow.ts', 'utf8')
  const extractMethod = manager.slice(manager.indexOf('async extract('), manager.indexOf('/** 按语言方向翻译'))
  assert.match(extractMethod, /waitForWebDocumentReady/u)
  assert.ok(extractMethod.indexOf('waitForWebDocumentReady') < extractMethod.indexOf('restoreSource'))
  assert.doesNotMatch(extractMethod, /if \(this\.state\.loading/u)
})

test('网页翻译语言切换应先失效旧任务并拒绝自动目标语言', () => {
  const manager = readFileSync('src/main/webReaderWindow.ts', 'utf8')
  const runMethod = manager.slice(manager.indexOf('async run('), manager.indexOf('/** 取消当前任务'))
  assert.ok(runMethod.indexOf('this.invalidateActiveJob()') < runMethod.indexOf('await this.restoreSource()'))
  assert.match(runMethod, /configuredTarget/u)
  assert.match(runMethod, /toLowerCase\(\) !== 'auto'/u)
})

test('网页翻译增量写回应串行执行，并基于最新结果快照聚合', () => {
  const manager = readFileSync('src/main/webReaderWindow.ts', 'utf8')
  const runMethod = manager.slice(manager.indexOf('async run('), manager.indexOf('/** 取消当前任务'))
  assert.match(runMethod, /let applyQueue = Promise\.resolve\(\)/u)
  assert.match(runMethod, /applyQueue = applyQueue\.then\(/u)
  assert.match(runMethod, /await applyQueue/u)
  assert.match(runMethod, /latestResults\.set\(segmentResult\.segmentId, segmentResult\)/u)
  assert.match(runMethod, /this\.mergeTranslatedUnits\(latestResults, cachedTranslations\)/u)
  assert.match(manager, /aggregatePageTranslationUnits\([\s\S]*this\.extractedUnits,[\s\S]*Array\.from\(latestResults\.values\(\)\)/u)
  assert.match(runMethod, /isCurrentJob\(\)\s*&&\s*this\.mode === 'target'/u)
})

test('网页翻译应管理有限增量窗口并允许首批文本为空', () => {
  const manager = readFileSync('src/main/webReaderWindow.ts', 'utf8')
  const runMethod = manager.slice(manager.indexOf('async run('), manager.indexOf('/** 取消当前任务'))
  const drainMethod = manager.slice(
    manager.indexOf('private drainIncrementalUnits('),
    manager.indexOf('/**\n   * 页面停止加载后安排静默期结束增量窗口。')
  )
  const quietStopMethod = manager.slice(
    manager.indexOf('private scheduleIncrementalQuietStop('),
    manager.indexOf('/**\n   * 结束增量收集器并关闭翻译流输入')
  )
  assert.match(manager, /WEB_INCREMENTAL_STOP_QUIET_MS\s*=\s*1500/u)
  assert.match(manager, /WEB_INCREMENTAL_WINDOW_MAX_MS\s*=\s*30_000/u)
  assert.match(manager, /hasExtractedSnapshot/u)
  assert.doesNotMatch(runMethod, /this\.extractedUnits\.length === 0/u)
  assert.match(manager, /buildWebIncrementalCollectorDrainScript/u)
  assert.match(manager, /buildWebIncrementalCollectorStopScript/u)
  assert.match(manager, /startIncrementalWindow/u)
  assert.match(manager, /finishIncrementalWindow/u)
  assert.match(drainMethod, /batch\.snapshots[\s\S]*?scheduleIncrementalQuietStop\(revision\)/u)
  assert.match(quietStopMethod, /this\.drainIncrementalUnits\(revision\)/u)
  assert.ok(
    quietStopMethod.indexOf('this.drainIncrementalUnits(revision)') <
      quietStopMethod.indexOf('this.finishIncrementalWindow(revision)'),
    '静默期到期后应先排空最后一批增量内容，再决定是否结束窗口'
  )
})

test('网页阅读器界面应展示动态发现进度、窗口状态和缓存命中', () => {
  const renderer = readFileSync('src/renderer/src/webReader.ts', 'utf8')
  const progressMethod = renderer.slice(
    renderer.indexOf('function renderProgress'),
    renderer.indexOf('/**\n * 执行当前网页的提取')
  )
  assert.match(progressMethod, /progress\.discovered/u)
  assert.match(progressMethod, /progress\.inputClosed/u)
  assert.match(progressMethod, /边加载边翻译/u)
  assert.match(progressMethod, /缓存命中/u)
  assert.match(renderer, /初始加载收集已结束/u)
  assert.match(renderer, /再次点击补译/u)
})

test('网页翻译界面应净化 IPC 错误前缀', () => {
  const renderer = readFileSync('src/renderer/src/webReader.ts', 'utf8')
  assert.match(renderer, /normalizeWebTranslationError/u)
  assert.match(renderer, /normalizeWebTranslationError\(error, '网页翻译失败'\)/u)
})

test('远程 frame 导航销毁时增量写回应安全跳过', () => {
  const manager = readFileSync('src/main/webReaderWindow.ts', 'utf8')
  const applyMethod = manager.slice(manager.indexOf('private async applyUnits('), manager.indexOf('/**\n   * 恢复当前快照原文'))
  assert.match(applyMethod, /isDisposedWebFrameError/u)
  assert.match(applyMethod, /catch \(error\)/u)
  assert.match(applyMethod, /skipped: operations\.length/u)
})

test('关闭网页阅读器时所有壳窗口消息都应安全跳过已销毁的 WebContents', () => {
  const manager = readFileSync('src/main/webReaderWindow.ts', 'utf8')
  const emitStateMethod = manager.slice(
    manager.indexOf('private emitState()'),
    manager.indexOf('/**\n   * 广播网页翻译进度。')
  )
  const emitProgressMethod = manager.slice(
    manager.indexOf('private emitProgress('),
    manager.indexOf('/**\n   * 清理已关闭窗口的引用与任务。')
  )
  const sendToRendererMethod = manager.slice(
    manager.indexOf('private sendToRenderer('),
    manager.indexOf('/**\n   * 清理已关闭窗口的引用与任务。')
  )
  const disposeMethod = manager.slice(
    manager.indexOf('private disposeWindow('),
    manager.indexOf('/**\n   * 要求远程网页已经加载。')
  )

  assert.match(manager, /private sendToRenderer\(/u)
  assert.match(emitStateMethod, /this\.sendToRenderer\('web-reader:state'/u)
  assert.match(emitProgressMethod, /this\.sendToRenderer\('web-translate:progress'/u)
  assert.match(manager, /this\.sendToRenderer\('web-translate:page-updated'/u)
  assert.match(sendToRendererMethod, /sendToAliveWebContents/u)
  assert.ok(
    disposeMethod.indexOf('this.window = null') < disposeMethod.indexOf('this.invalidateActiveJob(true)'),
    '窗口关闭回调中应先断开壳窗口引用，再取消任务，避免取消流程继续向已销毁窗口发送状态'
  )
})

test('单个文本节点失配不应中断整页翻译或显示全部重译提示', () => {
  const renderer = readFileSync('src/renderer/src/webReader.ts', 'utf8')
  const manager = readFileSync('src/main/webReaderWindow.ts', 'utf8')
  const translateMethod = renderer.slice(renderer.indexOf('async function translatePage('), renderer.indexOf('/**\n * 切换远程网页原文或译文'))
  const applyMethod = manager.slice(manager.indexOf('private async applyUnits('), manager.indexOf('/**\n   * 恢复当前快照原文'))

  assert.match(translateMethod, /已完成译文仍保留/u)
  assert.doesNotMatch(translateMethod, /result\.apply\.mismatched > 0\) setStatus\('页面内容已更新，请重新翻译'/u)
  assert.match(applyMethod, /if \(result\.mismatched > 0\) this\.markPageUpdated\(\)/u)
  assert.doesNotMatch(applyMethod, /invalidateActiveJob/u)
})

test('设置页应提供网页翻译分组并明确显式提取的隐私边界', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const renderer = readFileSync('src/renderer/src/settings.ts', 'utf8')
  for (const id of [
    'web-translation-enabled',
    'web-translation-scope',
    'web-translation-max-blocks',
    'web-translation-max-chars',
    'web-translation-default-mode'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`, 'u'))
  }
  assert.match(html, /显式点击提取\/翻译/u)
  assert.match(html, /不会读取系统浏览器/u)
  assert.match(renderer, /saveWebTranslationSettings/u)
})
