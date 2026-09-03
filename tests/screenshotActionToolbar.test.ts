import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const main = readFileSync('src/main/index.ts', 'utf8')
const preload = readFileSync('src/preload/index.ts', 'utf8')
const types = readFileSync('src/shared/types.ts', 'utf8')
const selectionHtml = readFileSync('src/renderer/selection.html', 'utf8')
const selectionRenderer = readFileSync('src/renderer/src/selection.ts', 'utf8')
const selectionCss = readFileSync('src/renderer/src/selection.css', 'utf8')
const toastHtml = readFileSync('src/renderer/toast.html', 'utf8')
const toastRenderer = readFileSync('src/renderer/src/toast.ts', 'utf8')

/**
 * 校验截图工具条提供五个图标按钮，并带有中文提示与无障碍名称。
 * @returns 无返回值。
 * @author zhenghq
 */
test('截图工具条应提供文字识别、翻译、复制图片、保存到本地和取消五个图标按钮', () => {
  const toolbarStart = selectionHtml.indexOf('id="ocr-toolbar"')
  assert.notEqual(toolbarStart, -1)
  const toolbarEnd = selectionHtml.indexOf('</div>', toolbarStart)
  const toolbarSource = selectionHtml.slice(toolbarStart, toolbarEnd)

  // 五个按钮齐全且均提供中文 title 与 aria-label
  assert.match(toolbarSource, /id="ocr-recognize"[^>]*title="文字识别"[^>]*aria-label="文字识别"/u)
  assert.match(toolbarSource, /id="ocr-translate"[^>]*title="翻译"[^>]*aria-label="翻译"/u)
  assert.match(toolbarSource, /id="ocr-copy-image"[^>]*title="复制图片"[^>]*aria-label="复制图片"/u)
  assert.match(toolbarSource, /id="ocr-save-image"[^>]*title="保存到本地"[^>]*aria-label="保存到本地"/u)
  assert.match(toolbarSource, /id="ocr-cancel"[^>]*title="取消"[^>]*aria-label="取消"/u)

  // 按钮使用内联 SVG 图标表达，不再依赖第三方图标库
  const svgCount = (toolbarSource.match(/<svg/gu) ?? []).length
  assert.equal(svgCount, 5)
})

/**
 * 校验普通划词旁的“译”按钮保持现有行为，不混入截图动作工具条。
 * @returns 无返回值。
 * @author zhenghq
 */
test('普通划词“译”按钮行为应保持不变', () => {
  assert.match(selectionHtml, /<button[^>]+id="translate"[^>]*>译<\/button>/u)
  assert.match(selectionRenderer, /window\.api\.translateSelection\(\)/u)
  // 普通划词模式下不显示截图动作工具条
  assert.match(selectionRenderer, /if \(!ocrMode \|\| !currentRect\) return null/u)
})

/**
 * 校验共享类型定义截图动作请求、识别结果与动作反馈模型。
 * @returns 无返回值。
 * @author zhenghq
 */
test('共享类型应定义截图动作、OCR 识别结果与动作反馈模型', () => {
  assert.match(types, /export type ScreenshotOcrAction\s*=\s*'recognize'\s*\|\s*'translate'\s*\|\s*'copy-image'\s*\|\s*'save-image'/u)
  assert.match(types, /export interface ScreenshotOcrActionRequest/u)
  assert.match(types, /requestId:\s*string/u)
  assert.match(types, /bounds:\s*OcrSelectionBounds/u)
  assert.match(types, /export interface ScreenshotOcrRecognizeResult/u)
  assert.match(types, /ok:\s*boolean/u)
  assert.match(types, /export interface ScreenshotOcrActionResult/u)
  assert.match(types, /action:\s*'copy-image'\s*\|\s*'save-image'/u)
  assert.match(types, /export type ScreenshotOcrErrorCode/u)
})

/**
 * 校验 preload 暴露截图动作请求与结果订阅 API，不暴露 Node 能力。
 * @returns 无返回值。
 * @author zhenghq
 */
test('preload 应暴露截图识别、翻译、复制图片、保存图片请求和结果订阅 API', () => {
  assert.match(preload, /ipcRenderer\.send\('ocr-selection:recognize',\s*request\)/u)
  assert.match(preload, /ipcRenderer\.send\('ocr-selection:translate',\s*request\)/u)
  assert.match(preload, /ipcRenderer\.send\('ocr-selection:copy-image',\s*request\)/u)
  assert.match(preload, /ipcRenderer\.send\('ocr-selection:save-image',\s*request\)/u)
  assert.match(preload, /ipcRenderer\.on\('ocr-selection:recognize-result',\s*listener\)/u)
  assert.match(preload, /ipcRenderer\.on\('ocr-selection:action-result',\s*listener\)/u)
  assert.match(types, /recognizeOcrSelection\(request:\s*ScreenshotOcrActionRequest\):\s*void/u)
  assert.match(types, /translateOcrSelection\(request:\s*ScreenshotOcrActionRequest\):\s*void/u)
  assert.match(types, /copyOcrSelectionImage\(request:\s*ScreenshotOcrActionRequest\):\s*void/u)
  assert.match(types, /saveOcrSelectionImage\(request:\s*ScreenshotOcrActionRequest\):\s*void/u)
  assert.match(types, /onOcrRecognizeResult\(cb:\s*\(result:\s*ScreenshotOcrRecognizeResult\)\s*=>\s*void\):\s*\(\)\s*=>\s*void/u)
  assert.match(types, /onOcrActionResult\(cb:\s*\(result:\s*ScreenshotOcrActionResult\)\s*=>\s*void\):\s*\(\)\s*=>\s*void/u)
})

/**
 * 校验主进程从快照裁剪当前选区，识别/复制/保存共用同一裁剪入口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('主进程应提供统一的当前快照选区裁剪函数', () => {
  assert.match(main, /function cropCurrentOcrSelectionPng\(/u)
  const cropStart = main.indexOf('function cropCurrentOcrSelectionPng(')
  const cropEnd = main.indexOf('/**', cropStart + 1)
  const cropSource = main.slice(cropStart, cropEnd)

  // 统一校验：选区、快照与最小尺寸
  assert.match(cropSource, /normalizeOcrSelectionBounds/u)
  assert.match(cropSource, /latestOcrSnapshot/u)
  assert.match(cropSource, /computeCropRect/u)
})

/**
 * 校验主进程实现截图文字识别：只返回文本、引擎与错误状态，不关闭窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('主进程应实现截图文字识别并通过结果事件回传文本', () => {
  assert.match(main, /async function recognizeOcrSelectionAction\(/u)
  const start = main.indexOf('async function recognizeOcrSelectionAction(')
  const end = main.indexOf('/**', start + 1)
  const source = main.slice(start, end)

  assert.match(source, /cropCurrentOcrSelectionPng/u)
  assert.match(source, /dispatcher\.recognize\(/u)
  assert.match(source, /sendScreenshotRecognizeResult\(/u)
  assert.match(main, /webContents\.send\('ocr-selection:recognize-result'/u)
  // 识别结果写回前校验 OCR 会话与请求版本
  assert.match(source, /activeScreenshotOcrRequests/u)
  // 识别不隐藏截图窗口
  assert.doesNotMatch(source, /hideOcrSelectionWindow\(\)/u)
  assert.match(main, /ipcMain\.on\('ocr-selection:recognize'/u)
})

/**
 * 校验主进程实现截图复制图片：主进程写剪贴板，成功后退出截图。
 * @returns 无返回值。
 * @author zhenghq
 */
test('主进程应实现截图复制图片并反馈成功或失败', () => {
  assert.match(main, /async function copyOcrSelectionImageAction\(/u)
  const start = main.indexOf('async function copyOcrSelectionImageAction(')
  const end = main.indexOf('/**', start + 1)
  const source = main.slice(start, end)

  // 复制图片走原生裁剪快速路径，不做 OCR 放大预处理，避免主线程卡顿
  assert.match(source, /cropCurrentOcrSelectionPngFast/u)
  assert.doesNotMatch(source, /resizeRgbaForOcr/u)
  assert.match(source, /clipboard\.writeImage\(nativeImage\.createFromBuffer\(png\)\)/u)
  assert.match(source, /sendScreenshotActionResult\(/u)
  assert.match(main, /webContents\.send\('ocr-selection:action-result'/u)
  // 复制不触发 OCR，成功后结束截图会话（由 Renderer 展示完成提示后隐藏窗口）
  assert.doesNotMatch(source, /dispatcher\.recognize\(/u)
  assert.match(source, /finishScreenshotSession\(\)/u)
  // 复制成功后 toast 窗口显示期间暂停划词监听，隐藏后再恢复
  assert.match(main, /selectionListenerController\.pause\('ocr'\)/u)
  assert.match(main, /selectionListenerController\.resume\('ocr'\)/u)
  assert.match(main, /ipcMain\.on\('ocr-selection:copy-image'/u)
})

/**
 * 校验主进程实现截图保存到本地：保存对话框取消不算错误，确认后才写文件并退出截图。
 * @returns 无返回值。
 * @author zhenghq
 */
test('主进程应实现截图保存到本地，取消对话框不视为错误', () => {
  assert.match(main, /async function saveOcrSelectionImageAction\(/u)
  const start = main.indexOf('async function saveOcrSelectionImageAction(')
  const end = main.indexOf('/**', start + 1)
  const source = main.slice(start, end)

  // 保存图片走原生裁剪快速路径，不做 OCR 放大预处理，避免主线程卡顿
  assert.match(source, /cropCurrentOcrSelectionPngFast/u)
  assert.doesNotMatch(source, /resizeRgbaForOcr/u)
  assert.match(source, /dialog\.showSaveDialog\(/u)
  assert.match(source, /result\.canceled/u)
  assert.match(source, /writeFile/u)
  assert.match(source, /sendScreenshotActionResult\(/u)
  // 保存对话框必须先于同步图片裁剪，避免路径框出现前被大图编码阻塞。
  const dialogIndex = source.indexOf('dialog.showSaveDialog(')
  const cropIndex = source.indexOf('cropCurrentOcrSelectionPngFast(')
  assert.ok(dialogIndex >= 0 && cropIndex > dialogIndex)
  // 保存成功后结束截图会话（由 Renderer 展示完成提示后隐藏窗口）
  assert.match(source, /finishScreenshotSession\(\)/u)
  assert.match(main, /ipcMain\.on\('ocr-selection:save-image'/u)
})

/**
 * 校验截图翻译动作沿用现有 OCR 翻译流程并隐藏截图窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('截图翻译动作应复用现有 OCR 翻译流程', () => {
  assert.match(main, /async function translateOcrSelectionAction\(/u)
  assert.match(main, /ipcMain\.on\('ocr-selection:translate'/u)
  // 翻译继续走既有 submitOcrSelection 核心路径（隐藏窗口并打开翻译弹窗）
  assert.match(main, /cropOcrSnapshotSelection\(bounds,\s*settings\)/u)
})

/**
 * 校验 Renderer 接入截图动作与 OCR 结果事件，防止重复提交。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Renderer 应接入五个截图动作并防止识别重复提交', () => {
  assert.match(selectionRenderer, /window\.api\.recognizeOcrSelection\(/u)
  assert.match(selectionRenderer, /window\.api\.translateOcrSelection\(/u)
  assert.match(selectionRenderer, /window\.api\.copyOcrSelectionImage\(/u)
  assert.match(selectionRenderer, /window\.api\.saveOcrSelectionImage\(/u)
  assert.match(selectionRenderer, /window\.api\.onOcrRecognizeResult\(/u)
  assert.match(selectionRenderer, /window\.api\.onOcrActionResult\(/u)
  assert.match(selectionRenderer, /window\.api\.cancelOcrSelection\(\)/u)
  // 识别期间禁用识别按钮防止重复提交
  assert.match(selectionRenderer, /screenshotRecognizePending/u)
})

/**
 * 校验主进程实现独立的截图动作提示窗口：与截图覆盖层解耦，
 * 复制/保存成功后展示，到时间后自行隐藏。
 * @returns 无返回值。
 * @author zhenghq
 */
test('主进程应实现独立的截图动作提示窗口', () => {
  assert.match(main, /function getScreenshotToastWindow\(\)/u)
  assert.match(main, /function showScreenshotToast\(/u)
  assert.match(main, /function handleScreenshotToastShowWindow\(/u)
  assert.match(main, /ipcMain\.on\('screenshot-toast:show'/u)
  assert.match(main, /ipcMain\.on\('screenshot-toast:show-window'/u)
  // 复制/保存成功后通过独立 toast 窗口展示提示
  assert.match(main, /showScreenshotToast\('已添加到剪贴板', 1500\)/u)
  assert.match(main, /showScreenshotToast\('已保存到本地', 1500\)/u)
  // 提示窗口注册为独立渲染入口
  assert.match(toastHtml, /id="toast"/u)
  assert.match(toastRenderer, /window\.api\.onShowScreenshotToast/u)
  assert.match(toastRenderer, /window\.api\.showScreenshotToastWindow/u)
  // 提示窗口由主进程控制隐藏，与截图窗口生命周期解耦
  assert.match(main, /screenshotToastHideTimer/u)
  assert.match(main, /screenshotToastWin\.hide\(\)/u)
})

/**
 * 校验截图 Toast 使用独立的监听暂停原因，避免截图窗口收尾提前恢复划词监听。
 * @returns 无返回值。
 * @author zhenghq
 */
test('截图 Toast 应使用独立暂停原因并在隐藏后恢复', () => {
  const showStart = main.indexOf('function showScreenshotToast')
  const showSource = main.slice(showStart, main.indexOf('/**', showStart + 1))
  const toastSource = main.slice(
    main.indexOf('function handleScreenshotToastShowWindow'),
    main.indexOf('/**', main.indexOf('function handleScreenshotToastShowWindow') + 1)
  )

  // 必须在异步 Toast 渲染前立即暂停，避免截图窗口先关闭造成“译”图标闪现。
  assert.match(showSource, /selectionListenerController\.pause\('screenshot-toast'\)/u)
  assert.match(toastSource, /selectionListenerController\.resume\('screenshot-toast'\)/u)
  assert.doesNotMatch(toastSource, /selectionListenerController\.pause\(/u)
  assert.doesNotMatch(toastSource, /selectionListenerController\.resume\('ocr'\)/u)
})

/**
 * 校验截图覆盖层关闭动画期间不会恢复共用页面中的普通“译”按钮。
 * @returns 无返回值。
 * @author zhenghq
 */
test('截图覆盖层关闭动画期间不得恢复普通“译”按钮', () => {
  const leaveStart = selectionRenderer.indexOf('function leaveOcrSelectionMode')
  const leaveEnd = selectionRenderer.indexOf('/**', leaveStart + 1)
  const leaveSource = selectionRenderer.slice(leaveStart, leaveEnd)

  // OCR 窗口仍可见时恢复按钮会让“译”图标在淡出期间闪现；普通按钮窗口本身无需走该收尾逻辑。
  assert.doesNotMatch(leaveSource, /translateButton\.hidden\s*=\s*false/u)
})

/**
 * 校验 Renderer 复制/保存成功后不再本地展示 toast，
 * 仅负责让覆盖窗口快速淡出关闭；失败时经主进程独立提示窗口展示错误。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Renderer 应在复制/保存成功后仅关闭窗口，失败时经独立窗口提示错误', () => {
  // 截图窗口内不再持有 toast DOM 元素
  assert.doesNotMatch(selectionRenderer, /showOcrToast/u)
  assert.doesNotMatch(selectionHtml, /id="ocr-toast"/u)
  assert.doesNotMatch(selectionCss, /\.ocr-toast/u)
  // 失败时通过主进程独立提示窗口展示错误
  assert.match(selectionRenderer, /window\.api\.showScreenshotToast\(\{ message: result\.error \|\| '复制图片失败'/u)
  assert.match(selectionRenderer, /window\.api\.showScreenshotToast\(\{ message: '已保存到本地'/u)
  assert.match(selectionRenderer, /function scheduleScreenshotAutoClose\(\)/u)
  assert.match(selectionRenderer, /ocrOverlay\.classList\.add\('closing'\)/u)
})

/**
 * 校验复制/保存裁剪快速路径基于 Chromium 原生 nativeImage 实现。
 * @returns 无返回值。
 * @author zhenghq
 */
test('复制/保存裁剪快速路径应使用原生 nativeImage 实现', () => {
  const start = main.indexOf('function cropCurrentOcrSelectionPngFast(')
  assert.notStrictEqual(start, -1)
  const end = main.indexOf('/**', start + 1)
  const source = main.slice(start, end)
  assert.match(source, /nativeImage\.createFromBuffer\(snapshot\.png\)/u)
  assert.match(source, /fullImage\.crop\(cropRect\)\.toPNG\(\)/u)
  assert.match(source, /computeCropRect/u)
  // 快速路径不做 JS 版 PNG 解码与 OCR 双线性缩放
  assert.doesNotMatch(source, /decodePng/u)
  assert.doesNotMatch(source, /resizeRgbaForOcr/u)
})

/**
 * 校验截图动作提示窗口采用微信截图风格：屏幕中央黑底胶囊、淡入淡出动画，
 * 且由独立窗口承载而非截图窗口内嵌 DOM。
 * @returns 无返回值。
 * @author zhenghq
 */
test('截图动作提示应为独立窗口内的黑底样式并支持淡入淡出', () => {
  const toastCss = readFileSync('src/renderer/src/toast.css', 'utf8')
  assert.match(toastCss, /\.screenshot-toast\s*\{[^}]*transition:\s*opacity\s+150ms/u)
  assert.match(toastCss, /\.screenshot-toast\.visible/u)
  assert.match(toastCss, /background:\s*var\(--toast-bg\)/u)
  // 关闭动画：覆盖层淡出而非直接消失
  assert.match(selectionCss, /\.ocr-overlay\.closing/u)
  assert.match(selectionCss, /\.ocr-overlay\s*\{[^}]*transition:\s*opacity/u)
})

/**
 * 校验 Renderer 提供 OCR 结果侧栏，支持只读可选择文本与状态展示。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Renderer 应提供 OCR 结果侧栏并支持选取复制', () => {
  assert.match(selectionHtml, /id="ocr-panel"/u)
  assert.match(selectionHtml, /id="ocr-panel-text"/u)
  // 只读可选择文本区域
  assert.match(selectionHtml, /<textarea[^>]*id="ocr-panel-text"[^>]*readonly/u)
  assert.match(selectionRenderer, /function renderOcrPanel\(/u)
  // 处理中、成功、空结果与错误状态
  assert.match(selectionRenderer, /'正在识别选区文字…'/u)
  assert.match(selectionRenderer, /'未识别到文字'/u)
  // 侧栏定位：优先选区右侧，空间不足时回退左侧或覆盖层内部
  assert.match(selectionRenderer, /function layoutOcrPanel\(/u)
})

/**
 * 校验截图工具条与 OCR 侧栏样式使用主题变量，避免硬编码颜色。
 * @returns 无返回值。
 * @author zhenghq
 */
test('截图工具条与 OCR 侧栏样式应使用主题变量并支持焦点态', () => {
  assert.match(selectionCss, /\.ocr-panel/u)
  assert.match(selectionCss, /\.ocr-toolbar button:focus-visible/u)
  // 新增面板样式不允许出现硬编码十六进制颜色
  const panelStart = selectionCss.indexOf('.ocr-panel')
  assert.notEqual(panelStart, -1)
  const panelSource = selectionCss.slice(panelStart)
  assert.doesNotMatch(panelSource, /#[0-9a-fA-F]{3,8}\b/u)
})

/**
 * 校验截图动作绑定请求版本，旧回调不会覆盖新会话状态。
 * @returns 无返回值。
 * @author zhenghq
 */
test('截图动作应通过请求 ID 隔离旧回调', () => {
  // Renderer 仅处理当前请求的识别结果
  assert.match(selectionRenderer, /pendingScreenshotRequestId/u)
  // 主进程在完成、取消、关闭路径清理动作请求
  assert.match(main, /activeScreenshotOcrRequests/u)
  assert.match(main, /activeScreenshotOcrRequests\.delete/u)
})

/**
 * 校验识别、复制和保存路径不把原始 PNG 发送给 Renderer。
 * @returns 无返回值。
 * @author zhenghq
 */
test('截图动作结果事件不应携带原始 PNG 字节', () => {
  const resultStart = types.indexOf('export interface ScreenshotOcrRecognizeResult')
  assert.notEqual(resultStart, -1)
  const resultEnd = types.indexOf('}', resultStart)
  const resultSource = types.slice(resultStart, resultEnd)
  assert.doesNotMatch(resultSource, /png|Buffer|Uint8Array|dataUrl|base64/iu)
})

/**
 * 校验点击 OCR 侧栏或反馈提示不会触发重新框选。
 * @returns 无返回值。
 * @author zhenghq
 */
test('点击 OCR 侧栏不应触发重新框选', () => {
  const downStart = selectionRenderer.indexOf('function handleOcrMouseDown')
  assert.notEqual(downStart, -1)
  const downEnd = selectionRenderer.indexOf('/**', downStart + 1)
  const downSource = selectionRenderer.slice(downStart, downEnd)

  // mousedown 在工具条和 OCR 侧栏上都必须直接返回，不进入绘制分支
  assert.match(downSource, /target\.closest\('#ocr-toolbar'\)/u)
  assert.match(downSource, /target\.closest\('#ocr-panel'\)/u)
})

/**
 * 校验工具条按钮在截图窗口内提供自定义悬停提示，
 * 避免透明窗口下系统原生 title 提示被裁剪。
 * @returns 无返回值。
 * @author zhenghq
 */
test('工具条按钮应在窗口内提供自定义悬停提示', () => {
  assert.match(selectionHtml, /id="ocr-tooltip"/u)
  assert.match(selectionRenderer, /function showOcrTooltip\(/u)
  assert.match(selectionRenderer, /function hideOcrTooltip\(/u)
  // 悬停与聚焦均展示提示，移出/失焦/点击后隐藏
  assert.match(selectionRenderer, /addEventListener\('mouseover', handleOcrTooltipHover\)/u)
  assert.match(selectionRenderer, /addEventListener\('focusin', handleOcrTooltipHover\)/u)
  assert.match(selectionRenderer, /addEventListener\('mouseout', handleOcrTooltipLeave\)/u)
  assert.match(selectionRenderer, /addEventListener\('focusout', hideOcrTooltip\)/u)
  assert.match(selectionRenderer, /addEventListener\('mousedown', hideOcrTooltip\)/u)
  // 提示内容取自按钮的 aria-label
  assert.match(selectionRenderer, /aria-label/u)
  assert.match(selectionCss, /\.ocr-tooltip/u)
})

/**
 * 校验 OCR 结果侧栏支持手动拖拽调整大小。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 结果侧栏应支持手动调整大小', () => {
  // 侧栏右下角提供可拖拽的调整手柄，具备无障碍名称
  assert.match(selectionHtml, /id="ocr-panel-resize"/u)
  assert.match(selectionHtml, /id="ocr-panel-resize"[^>]*aria-label="调整识别结果区域大小"/u)
  // Renderer 实现手柄拖拽调整：更新用户自定义尺寸并在移动中实时应用
  assert.match(selectionRenderer, /function handleOcrPanelResizeStart\(/u)
  assert.match(selectionRenderer, /function handleOcrPanelResizeMove\(/u)
  assert.match(selectionRenderer, /function handleOcrPanelResizeEnd\(/u)
  assert.match(selectionRenderer, /ocrPanelUserSize/u)
  // 调整大小属于面板交互，不得触发重新框选
  const downStart = selectionRenderer.indexOf('function handleOcrMouseDown')
  const downEnd = selectionRenderer.indexOf('/**', downStart + 1)
  const downSource = selectionRenderer.slice(downStart, downEnd)
  assert.match(downSource, /target\.closest\('#ocr-panel'\)/u)
  // 布局时尊重用户手动调整的尺寸
  const layoutStart = selectionRenderer.indexOf('function layoutOcrPanel')
  const layoutEnd = selectionRenderer.indexOf('/**', layoutStart + 1)
  const layoutSource = selectionRenderer.slice(layoutStart, layoutEnd)
  assert.match(layoutSource, /ocrPanelUserSize/u)
  // 样式禁用手柄原生拖拽并提供缩放手型光标，不出现硬编码颜色
  assert.match(selectionCss, /\.ocr-panel-resize/u)
  assert.match(selectionCss, /\.ocr-panel-resize\s*\{[^}]*cursor:\s*nwse-resize/su)
  const resizeStart = selectionCss.indexOf('.ocr-panel-resize')
  const resizeSource = selectionCss.slice(resizeStart)
  assert.doesNotMatch(resizeSource, /#[0-9a-fA-F]{3,8}\b/u)
})

/**
 * 校验空白处单击不会清除当前选区与识别结果框，
 * 只有拖出新选区时才一起替换旧选区和 OCR 侧栏。
 * @returns 无返回值。
 * @author zhenghq
 */
test('空白处单击不应清除当前选区与识别结果框', () => {
  const downStart = selectionRenderer.indexOf('function handleOcrMouseDown')
  assert.notEqual(downStart, -1)
  const downEnd = selectionRenderer.indexOf('/**', downStart + 1)
  const downSource = selectionRenderer.slice(downStart, downEnd)

  // 空白处按下时不再立即把选区渲染为 0x0，单击（无拖动）保留旧选区
  assert.doesNotMatch(downSource, /renderSelectionRect\(/u)

  const moveStart = selectionRenderer.indexOf('function handleOcrMouseMove')
  assert.notEqual(moveStart, -1)
  const moveEnd = selectionRenderer.indexOf('/**', moveStart + 1)
  const moveSource = selectionRenderer.slice(moveStart, moveEnd)

  // 只有拖动距离超过阈值才真正开始绘制新选区
  assert.match(moveSource, /OCR_DRAW_THRESHOLD/u)
  // 拖出新选区时同步丢弃旧 OCR 侧栏，避免选区消失但识别框残留
  assert.match(selectionRenderer, /function discardOcrPanelForNewSelection\(/u)
  assert.match(moveSource, /discardOcrPanelForNewSelection\(\)/u)
})
