import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const main = readFileSync('src/main/index.ts', 'utf8')
const popupMain = readFileSync('src/main/popup.ts', 'utf8')
const preload = readFileSync('src/preload/index.ts', 'utf8')
const types = readFileSync('src/shared/types.ts', 'utf8')
const settingsHtml = readFileSync('src/renderer/settings.html', 'utf8')
const settingsRenderer = readFileSync('src/renderer/src/settings.ts', 'utf8')
const settingsCss = readFileSync('src/renderer/src/settings.css', 'utf8')
const popupRenderer = readFileSync('src/renderer/src/popup.ts', 'utf8')
const selectionHtml = readFileSync('src/renderer/selection.html', 'utf8')
const selectionRenderer = readFileSync('src/renderer/src/selection.ts', 'utf8')
const selectionCss = readFileSync('src/renderer/src/selection.css', 'utf8')
const packageJson = readFileSync('package.json', 'utf8')
const benchmarkDoc = readFileSync('docs/ocr-model-benchmark.md', 'utf8')

/**
 * 校验 OCR 用户入口覆盖截图框选、剪贴板图片和快捷键触发。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 应提供截图、剪贴板图片和独立快捷键入口', () => {
  assert.match(main, /registerOcrShortcut\(settings\.ocrHotkey\)/u)
  assert.match(main, /onOcrHotkey\(\)/u)
  assert.match(main, /label:\s*'截图 OCR 翻译…'/u)
  assert.match(main, /label:\s*'剪贴板图片 OCR 翻译…'/u)
  assert.match(preload, /openOcrSelection/u)
  assert.match(preload, /translateClipboardImage/u)
  assert.match(types, /openOcrSelection\(\): void/u)
  assert.match(types, /translateClipboardImage\(\): void/u)
})

/**
 * 校验剪贴板图片翻译流程区分无图片提示，并复用 OCR 翻译管道。
 * @returns 无返回值。
 * @author zhenghq
 */
test('剪贴板图片翻译应区分无图片并复用 OCR 管线', () => {
  assert.match(main, /readClipboardImage\(clipboard\)/u)
  assert.match(main, /ocrCode:\s*'no-clipboard-image'/u)
  assert.match(main, /function translateClipboardImage/u)
  assert.match(main, /processOcrImageBytes/u)
  assert.match(main, /ipcMain\.on\('ocr-clipboard:translate'/u)
})

/**
 * 校验截图 OCR loading 状态会在弹窗中展示识别中提示，而不是隐藏 OCR 原文区域。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR loading 状态应展示识别中提示和 OCR 原文区域', () => {
  assert.match(main, /loading:\s*true,\s*\n\s*original:\s*'正在识别屏幕区域…'/u)
  assert.match(main, /loading:\s*true,\s*\n\s*original:\s*'正在识别剪贴板图片…'/u)
  assert.match(popupRenderer, /function renderOcrLoading\(payload: TranslatePayload\): void/u)
  assert.match(popupRenderer, /if \(payload\.origin === 'ocr'\) \{\s*\n\s*renderOcrLoading\(payload\)/u)
  assert.match(popupRenderer, /ocrSourceTextEl\.textContent = payload\.original \?\? '正在识别图片文字…'/u)
})

/**
 * 校验 OCR 结果不会被 Renderer 消息分发忽略，错误状态也会刷新 OCR 专用区域。
 * @returns 无返回值。
 * @author zhenghq
 */
test('弹窗应接收 OCR 结果并渲染 OCR 错误状态', () => {
  assert.match(
    popupRenderer,
    /payload\.origin === 'selection' \|\| payload\.origin === 'ocr' \|\| payload\.origin === undefined/u
  )
  assert.match(
    popupRenderer,
    /if \(!payload\.ok\) \{[\s\S]*?if \(payload\.origin === 'ocr'\) \{[\s\S]*?renderOcrSource\(payload\)/u
  )
})

/**
 * 校验普通划词翻译成功时隐藏 OCR 原文区域，保持原有划词弹窗布局。
 * @returns 无返回值。
 * @author zhenghq
 */
test('普通划词翻译成功时不应显示 OCR 原文区域', () => {
  const renderStart = popupRenderer.indexOf('function renderSelection(payload: TranslatePayload): void')
  const renderEnd = popupRenderer.indexOf('/**', renderStart + 1)
  const renderSource = popupRenderer.slice(renderStart, renderEnd)
  const successStart = renderSource.indexOf('const sourceName = payload.detectedLang')
  const successSource = renderSource.slice(successStart)

  assert.match(
    successSource,
    /if \(payload\.origin === 'ocr'\) \{\s*\n\s*renderOcrSource\(payload\)\s*\n\s*\} else \{\s*\n\s*renderOcrSource\(\{\} as TranslatePayload\)\s*\n\s*\}/u
  )
})

/**
 * 校验 OCR 翻译成功时原划词内容区域不重复展示，只展示 OCR 内容区域。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 翻译成功时应显示 OCR 内容并隐藏划词内容区域', () => {
  const renderStart = popupRenderer.indexOf('function renderSelection(payload: TranslatePayload): void')
  const renderEnd = popupRenderer.indexOf('/**', renderStart + 1)
  const renderSource = popupRenderer.slice(renderStart, renderEnd)
  const successStart = renderSource.indexOf('const sourceName = payload.detectedLang')
  const successSource = renderSource.slice(successStart)

  assert.match(
    successSource,
    /originalEl\.textContent = payload\.origin === 'ocr'\s*\?\s*''\s*:\s*payload\.original \?\? ''/u
  )
  assert.match(popupRenderer, /const ocrText = getOcrRawText\(payload\)/u)
  assert.match(popupRenderer, /ocrSourceTextEl\.textContent = ocrText/u)
})

/**
 * 校验 OCR 结果切换翻译语言时使用最近 OCR 文本，而不是普通划词缓存。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 结果切换语言应使用 OCR 文本重新翻译', () => {
  assert.match(popupRenderer, /let currentSelectionOrigin:\s*TranslatePayload\['origin'\]\s*=\s*'selection'/u)
  assert.match(popupRenderer, /currentSelectionOrigin = payload\.origin \?\? 'selection'/u)
  assert.match(popupRenderer, /window\.api\.retranslate\(sourceLangEl\.value,\s*targetLangEl\.value,\s*currentSelectionOrigin\)/u)
  assert.match(popupRenderer, /const currentText = currentSelectionOrigin === 'ocr' \? lastOcrText : lastOriginal/u)
  assert.match(preload, /ipcRenderer\.invoke\('popup:retranslate',\s*sourceLang,\s*targetLang,\s*origin\)/u)
  assert.match(types, /retranslate\(sourceLang: string,\s*targetLang: string,\s*origin\?: TranslationOrigin\): Promise<void>/u)
  assert.match(main, /let lastOcrText = ''/u)
  assert.match(main, /lastOcrText = result\.ocrText/u)
  assert.match(main, /const text = origin === 'ocr' \? lastOcrText : lastSelectedText/u)
})

/**
 * 校验 OCR 结果切换翻译语言时继续携带原 OCR 引擎标识，避免重新翻译后标识消失。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 结果切换语言后应保留 OCR 引擎标识', () => {
  assert.match(main, /let lastOcrEngine: TranslatePayload\['ocrEngine'\]/u)
  assert.match(main, /lastOcrEngine = result\.ocrEngine/u)
  assert.match(
    main,
    /ocrEngine: origin === 'ocr' \? lastOcrEngine : undefined/u
  )
})

/**
 * 校验 OCR 成功结果展示时使用解析后的语言对，而不是继续显示 auto。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 成功结果应使用解析后的语言对展示状态', () => {
  const resultStart = main.indexOf('function showOcrTranslationResult')
  const resultEnd = main.indexOf('/**', resultStart + 1)
  const resultSource = main.slice(resultStart, resultEnd)

  assert.match(resultSource, /resolveLanguagePair\(result\.ocrText,\s*sourcePreference,\s*targetPreference\)/u)
  assert.match(resultSource, /sourceLang:\s*pair\.sourceLang/u)
  assert.match(resultSource, /targetLang:\s*pair\.targetLang/u)
})

/**
 * 校验 OCR 框选期间暂停普通划词监听，避免截图拖拽被误识别为划词翻译。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 框选期间应暂停并屏蔽普通划词监听', () => {
  const openStart = main.indexOf('function openOcrSelection')
  const openEnd = main.indexOf('/**', openStart + 1)
  const openSource = main.slice(openStart, openEnd)
  const cancelStart = main.indexOf('function cancelOcrSelection')
  const cancelEnd = main.indexOf('/**', cancelStart + 1)
  const cancelSource = main.slice(cancelStart, cancelEnd)
  const gestureStart = main.indexOf('function handleSelectionGesture')
  const gestureEnd = main.indexOf('/**', gestureStart + 1)
  const gestureSource = main.slice(gestureStart, gestureEnd)

  // 暂停经由记账函数完成，保证任何收尾路径都能把全局钩子恢复回来
  assert.match(openSource, /suspendSelectionListenerForOcr\(\)/u)
  assert.match(openSource, /selectionCapture\.invalidate\(\)/u)
  assert.match(cancelSource, /restoreSelectionListenerAfterOcr\(\)/u)
  assert.match(gestureSource, /isOcrSelectionVisible\(\)/u)
})

/**
 * 校验框选会话先完成清理，Windows/macOS 隐藏采集快照后再把快照传给 Renderer。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 截图应先清理框选会话，再把隐藏采集的快照传给 Renderer 调整选区', () => {
  const openStart = main.indexOf('async function openOcrSelection')
  const openEnd = main.indexOf('\n}\n', openStart)
  const openSource = main.slice(openStart, openEnd)
  const submitStart = main.indexOf('async function submitOcrSelection')
  const submitEnd = main.indexOf('/**', submitStart + 1)
  const submitSource = main.slice(submitStart, submitEnd)

  assert.match(openSource, /captureOcrPreviewSnapshot\(display\.bounds\)/u)
  // begin 只负责让隐藏的 Renderer 清理旧会话；Windows/macOS 此时不得显示遮罩。
  assert.match(openSource, /sendToOcrSelectionWindow\(win,\s*'ocr-selection:begin'/u)
  assert.match(openSource, /sendToOcrSelectionWindow\(win,\s*'ocr-selection:snapshot'/u)
  assert.match(openSource, /imageDataUrl:\s*preview\.previewDataUrl/u)
  assert.ok(
    openSource.indexOf("'ocr-selection:begin'") < openSource.indexOf('captureOcrPreviewSnapshot('),
    'begin 事件必须早于屏幕采集'
  )
  assert.match(submitSource, /cropOcrSnapshotSelection\(bounds\)/u)
  assert.match(submitSource, /processOcrImageBytes\(imageBytes,\s*settings\)/u)
  assert.doesNotMatch(submitSource, /await sleep\(OCR_CAPTURE_SETTLE_DELAY_MS\)/u)
  assert.doesNotMatch(submitSource, /captureOcrSelectionPng\(bounds,\s*settings\)/u)
})

/**
 * 校验 OCR 框选页基于屏幕快照选择区域，用户可调整选区并显式点击识别。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 框选页应支持快照预览、调整选区和点击识别', () => {
  assert.match(selectionHtml, /id="ocr-snapshot"/u)
  assert.match(selectionHtml, /id="ocr-recognize"/u)
  assert.match(selectionHtml, /data-handle="nw"/u)
  assert.match(selectionRenderer, /function applyOcrSnapshot/u)
  assert.match(selectionRenderer, /function updateResizeHandlePositions/u)
  assert.match(selectionRenderer, /function submitCurrentOcrSelection/u)
  // 截图工具条改造后，“识别”按钮触发窗口内文字识别；Enter/空格仍走翻译提交路径。
  assert.match(selectionRenderer, /function recognizeCurrentOcrSelection/u)
  assert.match(selectionRenderer, /ocrRecognizeButton\.addEventListener\('click',\s*recognizeCurrentOcrSelection\)/u)
  assert.match(selectionRenderer, /ocrTranslateButton\.addEventListener\('click',\s*translateCurrentOcrSelection\)/u)
  assert.match(selectionCss, /\.ocr-snapshot\s*\{[^}]*object-fit:\s*fill;/su)
  assert.match(selectionCss, /\.ocr-resize-handle/u)
  assert.doesNotMatch(selectionRenderer, /window\.api\.submitOcrSelection\(rect\)/u)
})

/**
 * 校验截图预览页允许加载主进程传入的 data URL 快照，避免 CSP 阻止图片后触发加载失败。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 框选页 CSP 应允许 data URL 截图资源', () => {
  assert.match(selectionHtml, /img-src\s+'self'\s+data:/u)
})

/**
 * 校验 OCR 覆盖窗口使用目标显示器外层边界定位，避免内容区域换算造成快照整体下移。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 覆盖窗口应按目标屏幕外层边界对齐', () => {
  const openStart = main.indexOf('async function openOcrSelection')
  const openEnd = main.indexOf('/**', openStart + 1)
  const openSource = main.slice(openStart, openEnd)
  assert.match(openSource, /win\.setBounds\(display\.bounds\)/u)
  assert.doesNotMatch(openSource, /win\.setContentBounds\(display\.bounds\)/u)
  assert.match(openSource, /win\.setSimpleFullScreen\(true\)/u)
})

/**
 * 校验复用 OCR 覆盖窗口隐藏时在 macOS 上退出简单全屏，避免隐藏的全屏窗口
 * 导致后续打开其他窗口时 macOS 自动隐藏 Dock 栏。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 覆盖窗口隐藏时应退出 macOS 简单全屏', () => {
  const hideStart = main.indexOf('function hideOcrSelectionWindow')
  const hideEnd = main.indexOf('\n}\n', hideStart)
  const hideSource = main.slice(hideStart, hideEnd)
  assert.notStrictEqual(hideStart, -1, '应存在 OCR 覆盖窗口隐藏函数')
  assert.match(hideSource, /setSimpleFullScreen\(false\)/u)
})

/**
 * 校验复用 OCR 覆盖窗口时只在尚未进入简单全屏时切换，避免重复触发系统窗口动画。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 覆盖窗口重复打开时不应重复进入简单全屏', () => {
  const openStart = main.indexOf('async function openOcrSelection')
  const openEnd = main.indexOf('/**', openStart + 1)
  const openSource = main.slice(openStart, openEnd)
  assert.match(openSource, /!win\.isSimpleFullScreen\(\)/u)
})

/**
 * 校验截图文字编辑框使用透明多行输入控件，避免空格/回车被截图快捷键吞掉。
 * @returns 无返回值。
 * @author zhenghq
 */
test('截图文字编辑框应支持透明多行输入', () => {
  assert.match(selectionHtml, /<textarea[^>]*id="ocr-text-input"/u)
  assert.match(selectionRenderer, /const ocrTextInput = document\.getElementById\('ocr-text-input'\) as HTMLTextAreaElement/u)
  assert.match(selectionCss, /\.ocr-text-input[\s\S]*?background:\s*transparent/u)
  assert.match(selectionCss, /\.ocr-text-input[\s\S]*?resize:\s*none/u)
  assert.match(selectionRenderer, /if \(event\.target === ocrTextInput\) return/u)
  assert.match(selectionRenderer, /ocrTextInput\.addEventListener\('input',/u)
  assert.match(selectionRenderer, /scrollHeight/u)
  assert.match(selectionCss, /\.ocr-tip[\s\S]*?margin-top:\s*64px/u)
})

/**
 * 校验工具栏布局会避让右侧 OCR 识别内容区域，避免两个浮层相互遮挡。
 * @returns 无返回值。
 * @author zhenghq
 */
test('截图工具栏应避让 OCR 识别内容区域', () => {
  assert.match(selectionRenderer, /function avoidOcrToolbarPanelOverlap\(/u)
  assert.match(selectionRenderer, /avoidOcrToolbarPanelOverlap\(\)/u)
  assert.match(selectionRenderer, /toolbarRight <= panelRect\.left/u)
  assert.match(selectionRenderer, /toolbarBottom <= panelRect\.top/u)
})

/**
 * 校验截图采集发生在弹窗 loading 展示之前，避免截到弹窗。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 截图应先完成再展示弹窗', () => {
  const submitStart = main.indexOf('async function submitOcrSelection')
  const submitEnd = main.indexOf('/**', submitStart + 1)
  const submitSource = main.slice(submitStart, submitEnd)
  const captureIndex = submitSource.indexOf('cropOcrSnapshotSelection')
  const loadingIndex = submitSource.indexOf("original: '正在识别屏幕区域…'")

  assert.match(submitSource, /hideOcrSelectionWindow\(\)/u)
  assert.ok(captureIndex >= 0, '应裁剪已采集快照')
  assert.ok(loadingIndex >= 0, '应展示 OCR loading')
  assert.ok(captureIndex < loadingIndex, '截图裁剪必须早于弹窗 loading，避免截到弹窗自身')
})

/**
 * 校验 macOS OCR 截图使用系统 screencapture，但不再持久化截图图片。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS OCR 截图应使用原生 screencapture 且不保存诊断图片', () => {
  assert.match(main, /execFileP\('screencapture',\s*\['-x',\s*'-R'/u)
  assert.match(main, /logOcrCaptureDiagnostic\(png,\s*bounds,\s*'macos-screencapture'\)/u)
  assert.doesNotMatch(main, /saveOcrCaptureImage|ocr-captures|writeFile\(path,\s*imageBytes\)/u)
})

/**
 * 校验 OCR 框选预览和最终识别截图都只保存在内存，不再落盘。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 截图不应落盘', () => {
  const previewStart = main.indexOf('async function captureOcrPreviewSnapshot')
  const previewEnd = main.indexOf('/**', previewStart + 1)
  const previewSource = main.slice(previewStart, previewEnd)
  const cropStart = main.indexOf('async function cropOcrSnapshotSelection')
  const cropEnd = main.indexOf('/**', cropStart + 1)
  const cropSource = main.slice(cropStart, cropEnd)

  assert.doesNotMatch(previewSource, /logOcrCaptureDiagnostic/u)
  assert.match(cropSource, /logOcrCaptureDiagnostic\(png,\s*bounds,\s*`\$\{snapshot\.source\}-crop`\)/u)
  assert.doesNotMatch(cropSource, /saveOcrCaptureImage|ocr-captures|writeFile/u)
})

/**
 * 校验弹窗页面未加载完成时不会丢失 OCR loading 或最终结果。
 * @returns 无返回值。
 * @author zhenghq
 */
test('弹窗首次打开时应等待页面加载完成再投递 OCR 结果', () => {
  assert.match(popupMain, /function deliverPopupPayload\(payload: TranslatePayload\): void/u)
  assert.match(popupMain, /win\.webContents\.isLoadingMainFrame\(\)/u)
  assert.match(popupMain, /win\.webContents\.once\('did-finish-load'/u)
  assert.match(popupMain, /deliverPopupPayload\(payload\)/u)
})

/**
 * 校验设置页提供 OCR 分组、模型资产状态和对应设置保存逻辑。
 * @returns 无返回值。
 * @author zhenghq
 */
test('设置页应提供 OCR 分组和模型资产状态', () => {
  assert.match(settingsHtml, /id="settings-tab-ocr"/u)
  assert.match(settingsHtml, /id="settings-panel-ocr"/u)
  assert.match(settingsHtml, /id="ocr-engine-preference"/u)
  assert.match(settingsHtml, /id="ocr-hotkey"/u)
  assert.match(settingsHtml, /id="ocr-lang"/u)
  assert.match(settingsHtml, /id="ocr-scale"/u)
  assert.match(settingsHtml, /id="ocr-tesseract-enabled"/u)
  assert.match(settingsHtml, /id="ocr-model-status"/u)
  assert.match(settingsRenderer, /type SettingsTabId = 'general' \| 'ai' \| 'ocr'/u)
  assert.match(settingsRenderer, /function saveOcrSettings/u)
  assert.match(settingsRenderer, /window\.api\.getOcrStatus/u)
  assert.match(settingsCss, /\.ocr-model-status/u)
  assert.doesNotMatch(settingsCss, /\.ocr-[^{]*\{[^}]*(?:#[0-9a-fA-F]{3,8}|rgb\()/su)
})

/**
 * 校验 OCR 倍率仅表示低质量回退上限，并保留已有倍率选项和读写方式。
 * @returns 无返回值。
 * @author zhenghq
 */
test('设置页应说明 OCR 最大尝试倍率并保持配置兼容', () => {
  assert.match(settingsHtml, /<label for="ocr-scale">最大尝试倍率<\/label>/u)
  assert.match(settingsHtml, /首轮固定使用 1×/u)
  assert.match(settingsHtml, /仅限制低质量回退/u)
  for (const value of ['1', '1.25', '1.5', '2', '3']) {
    assert.match(settingsHtml, new RegExp(`<option value="${value}">`, 'u'))
  }
  assert.match(settingsRenderer, /ocrScale\.value = String\(settings\.ocrScale\)/u)
  assert.match(settingsRenderer, /ocrScale: Number\(ocrScale\.value\)/u)
})

/**
 * 校验预加载层和共享类型暴露受限 OCR 状态接口，供设置页展示模型版本与许可。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 状态接口应暴露模型版本与许可', () => {
  assert.match(types, /export interface OcrStatus/u)
  assert.match(types, /modelName: string/u)
  assert.match(types, /license: string/u)
  assert.match(types, /getOcrStatus\(\): Promise<OcrStatus>/u)
  assert.match(preload, /ipcRenderer\.invoke\('ocr:get-status'\)/u)
  assert.match(main, /ipcMain\.handle\('ocr:get-status'/u)
})

/**
 * 校验 OCR 运行时依赖已锁定并纳入 Electron 打包白名单。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 运行时依赖应锁定并纳入打包配置', () => {
  const pkg = JSON.parse(packageJson)
  assert.ok(pkg.dependencies['@gutenye/ocr-node'])
  assert.ok(pkg.dependencies['tesseract.js'])
  assert.ok(pkg.build.files.includes('node_modules/@gutenye/**/*'))
  assert.ok(pkg.build.files.includes('assets/ocr/**/*'))
  assert.ok(pkg.build.files.includes('node_modules/onnxruntime-node/**/*'))
  assert.ok(pkg.build.files.includes('node_modules/tesseract.js/**/*'))
  assert.ok(pkg.build.asarUnpack.includes('assets/ocr/**/*'))
  assert.ok(pkg.build.asarUnpack.includes('node_modules/onnxruntime-node/**/*'))
  assert.match(benchmarkDoc, /@gutenye\/ocr-node`\s*\|\s*1\.4\.8/u)
  assert.match(benchmarkDoc, /onnxruntime-node`\s*\|\s*1\.27\.0/u)
  assert.match(benchmarkDoc, /PP-OCRv4 ONNX/u)
  assert.match(benchmarkDoc, /PP-OCRv6_tiny ONNX/u)
})

/**
 * 校验 OCR 框选窗口通过隐藏或关闭等旁路收尾时，全局划词监听仍能恢复。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 框选窗口隐藏或关闭时应兜底恢复划词监听', () => {
  const windowStart = main.indexOf('function getOcrSelectionWindow(): BrowserWindow')
  const windowEnd = main.indexOf('\n}\n', windowStart)
  const windowSource = main.slice(windowStart, windowEnd)

  // 覆盖层被任何旁路收尾时都要恢复钩子，否则划词与双击会静默失效
  assert.match(windowSource, /ocrSelectionWin\.on\('hide',[\s\S]*?restoreSelectionListenerAfterOcr\(\)/u)
  assert.match(windowSource, /ocrSelectionWin\.on\('closed',[\s\S]*?restoreSelectionListenerAfterOcr\(\)/u)
})

/**
 * 校验 Windows 截图走 GDI 原生采集分支，绕开 desktopCapturer/DXGI 缩略图；
 * Linux 仍保留 Electron desktopCapturer 路径。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 截图应走 GDI 原生采集，Linux 保留 desktopCapturer', () => {
  const previewStart = main.indexOf('async function captureOcrPreviewSnapshot')
  const previewEnd = main.indexOf('/**', previewStart + 1)
  const previewSource = main.slice(previewStart, previewEnd)

  // Windows 分支：GDI 直采物理像素后交给 nativeImage，失败回退 PowerShell/helper exe
  assert.match(previewSource, /if \(process\.platform === 'win32'\)/u)
  assert.match(previewSource, /captureWindowsOcrPreview\(bounds\)/u)
  assert.match(previewSource, /\$\{captured\.source\}-preview/u)
  // 预览成功路径把 BGRA 直接交给 Chromium；回退路径只能拿到 PNG，同样不走 JS 解码
  assert.match(previewSource, /nativeImage\.createFromBitmap\(/u)
  assert.match(previewSource, /captured\.kind === 'pixels'/u)
  assert.match(previewSource, /nativeImage\.createFromBuffer\(captured\.png\)/u)
  // 预览路径不得对整屏调用 JS 版 PNG 编码器
  assert.doesNotMatch(previewSource, /encodePng\(/u)

  // Linux / 其他平台：继续使用 Electron desktopCapturer 缩略图路径
  assert.match(previewSource, /captureRegionAsPng\(bounds,\s*\{ ocrScale: 1 \}/u)
  assert.match(previewSource, /electron-desktopCapturer-preview/u)
})

/**
 * 校验 Windows 最终 OCR 选区采集同样走 GDI 分支，并在成功后记录诊断日志。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 最终选区采集应走 GDI 分支并记录诊断日志', () => {
  const start = main.indexOf('async function captureOcrSelectionPng')
  const end = main.indexOf('/**', start + 1)
  const source = main.slice(start, end)

  assert.match(source, /if \(process\.platform === 'win32'\)/u)
  assert.match(source, /captureWindowsOcrRegion\(bounds\)/u)
  assert.match(source, /logOcrCaptureDiagnostic\(captured\.png,\s*bounds,\s*captured\.source\)/u)
  assert.match(source, /electron-desktopCapturer/u)
})

/**
 * 校验 Linux 最终选区采集保持原始倍率，用户倍率只作为统一协调器的回退上限。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Linux 最终选区采集应固定 1 倍率并避免重复缩放', () => {
  const captureStart = main.indexOf('async function captureOcrSelectionPng')
  const captureEnd = main.indexOf('/**', captureStart + 1)
  const captureSource = main.slice(captureStart, captureEnd)
  const processStart = main.indexOf('async function processOcrImageBytes')
  const processEnd = main.indexOf('/**', processStart + 1)
  const processSource = main.slice(processStart, processEnd)

  assert.match(captureSource, /captureRegionAsPng\(bounds,\s*\{ ocrScale: 1 \}/u)
  assert.doesNotMatch(captureSource, /captureRegionAsPng\(bounds,\s*\{ ocrScale: settings\.ocrScale \}/u)
  assert.equal(processSource.match(/recognizeAdaptiveOcr\(/gu)?.length, 1)
  assert.match(processSource, /imageBytes,\s*\n\s*maxScale: settings\.ocrScale/u)
  assert.match(processSource, /recognize:\s*\(preparedImageBytes\)\s*=>\s*\n?\s*dispatcher\.recognize\(/u)
})

/**
 * 校验 Windows 采集辅助函数优先 GDI 并在失败时回退 helper exe / PowerShell。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 采集辅助函数应优先 GDI 并接入回退路径', () => {
  const regionStart = main.indexOf('async function captureWindowsOcrRegion')
  const regionSource = main.slice(regionStart, main.indexOf('\n}\n', regionStart))
  assert.match(regionSource, /captureWindowsOcrPngPreferGdi\(/u)
  assert.match(regionSource, /buildWindowsOcrCaptureDeps\(\)/u)

  // 预览路径与最终选区路径共用同一份回退依赖，避免降级行为分歧
  const previewStart = main.indexOf('async function captureWindowsOcrPreview')
  const previewSource = main.slice(previewStart, main.indexOf('\n}\n', previewStart))
  assert.match(previewSource, /captureWindowsOcrPreviewPreferGdi\(/u)
  assert.match(previewSource, /buildWindowsOcrCaptureDeps\(\)/u)

  const start = main.indexOf('function buildWindowsOcrCaptureDeps')
  const end = main.indexOf('\n}\n', start)
  const source = main.slice(start, end)
  assert.match(source, /captureWindowsRegionAsPng\(/u)
  assert.match(source, /execFile:\s*execFileP/u)
  assert.match(source, /tmpDir:\s*tmpdir/u)
  assert.match(source, /spawn:\s*spawnP/u)
  assert.match(source, /GDI 截屏失败，回退 helper exe \/ PowerShell/u)
})
