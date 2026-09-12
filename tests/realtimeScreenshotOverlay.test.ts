import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const main = readFileSync('src/main/index.ts', 'utf8')
const preload = readFileSync('src/preload/index.ts', 'utf8')
const types = readFileSync('src/shared/types.ts', 'utf8')
const selectionRenderer = readFileSync('src/renderer/src/selection.ts', 'utf8')
const selectionHtml = readFileSync('src/renderer/selection.html', 'utf8')
const selectionCss = readFileSync('src/renderer/src/selection.css', 'utf8')

/**
 * 截取源码中指定函数的函数体文本。
 * @param source 源码文本。
 * @param signature 函数签名前缀。
 * @returns 函数体文本。
 * @author zhenghq
 */
function sliceFunction(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.notStrictEqual(start, -1, `未找到函数 ${signature}`)
  const end = source.indexOf('\n}\n', start)
  assert.notStrictEqual(end, -1, `未找到函数 ${signature} 的结尾`)
  return source.slice(start, end)
}

/**
 * 校验 Windows 与 macOS 采集时覆盖窗口保持隐藏，避免把应用自身遮罩采进新截图；
 * Linux 保留先显示后采集的低延迟路径。
 * @returns 无返回值。
 * @author zhenghq
 */
test('openOcrSelection 应避免 Windows 与 macOS 覆盖层参与屏幕采集', () => {
  const source = sliceFunction(main, 'async function openOcrSelection')
  const showIndex = source.lastIndexOf('win.show()')
  const beginIndex = source.indexOf("'ocr-selection:begin'")
  const captureIndex = source.indexOf('captureOcrPreviewSnapshot(')
  assert.ok(showIndex >= 0, '应显示覆盖窗口')
  assert.ok(beginIndex >= 0, '应发送 begin 事件')
  assert.ok(captureIndex >= 0, '应采集预览快照')
  assert.ok(beginIndex < captureIndex, 'begin 事件必须早于屏幕采集')
  assert.match(source, /const showBeforeCapture = !\['win32', 'darwin'\]\.includes\(process\.platform\)/u)
  assert.match(source, /if \(showBeforeCapture\) \{[\s\S]*?win\.show\(\)/u)
  assert.match(source, /if \(!showBeforeCapture\) \{[\s\S]*?win\.show\(\)/u)
  assert.ok(showIndex > captureIndex, 'Windows 与 macOS 覆盖窗口必须在采集完成后显示')
  assert.match(source, /win\.setBounds\(display\.bounds\)/u)
})

/**
 * 校验覆盖窗口完成加载后才允许显示、聚焦并开始 OCR 会话，避免空白窗口闪现。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 覆盖窗口 ready 后才能 show、focus 和发送 begin', () => {
  const source = sliceFunction(main, 'async function openOcrSelection')
  const readyIndex = source.indexOf('whenOcrSelectionWindowReady(win)')
  const showIndex = source.indexOf('win.show()')
  const focusIndex = source.indexOf('win.focus()')
  const beginIndex = source.indexOf("'ocr-selection:begin'")
  assert.ok(readyIndex >= 0, 'openOcrSelection 必须等待覆盖窗口 ready')
  assert.ok(showIndex > readyIndex, '窗口 ready 前不得显示覆盖窗口')
  assert.ok(focusIndex > readyIndex, '窗口 ready 前不得聚焦覆盖窗口')
  assert.ok(beginIndex > readyIndex, '窗口 ready 前不得发送 begin')
})

/**
 * 校验复用覆盖窗口时先清空上一轮会话，再让窗口可见，避免旧选区闪现。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 覆盖窗口应在 show 前发送 begin 清理旧会话', () => {
  const source = sliceFunction(main, 'async function openOcrSelection')
  const showIndex = source.indexOf('win.show()')
  const beginIndex = source.indexOf("'ocr-selection:begin'")
  assert.ok(showIndex >= 0, '应显示覆盖窗口')
  assert.ok(beginIndex >= 0, '应发送 begin 事件')
  assert.ok(beginIndex < showIndex, '必须先清理旧会话，再显示覆盖窗口')
  const waitIndex = source.indexOf('waitForOcrSelectionReady(win, ocrSessionId)')
  assert.ok(waitIndex >= 0, '必须建立 Renderer 清理确认等待')
  assert.ok(waitIndex < beginIndex, '必须先登记 ready 等待，再发送 begin，避免同步 ACK 丢失')
})

/**
 * 校验 ready 回执严格绑定当前会话，避免迟到回执放行下一次截图。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR ready 回执应严格校验当前 sessionId', () => {
  const readySource = sliceFunction(main, "ipcMain.on('ocr-selection:ready'")
  assert.match(readySource, /typeof sessionId !== 'number'/u)
  assert.match(readySource, /sessionId !== ocrSelectionSessionSeq/u)
  assert.match(readySource, /resolveOcrSelectionReady\(true\)/u)
})

/**
 * 校验 ready 门禁对已加载窗口立即放行，对加载窗口只建立一组生命周期监听。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 覆盖窗口 ready 门禁应复用单次等待并处理失败与销毁', () => {
  const source = sliceFunction(main, 'function whenOcrSelectionWindowReady(')
  assert.match(source, /webContents\.isLoading\(\)/u)
  assert.match(source, /did-finish-load/u)
  assert.match(source, /did-fail-load/u)
  assert.match(source, /closed/u)
  assert.match(main, /WeakMap<BrowserWindow, Promise<void>>/u)

  const sendSource = sliceFunction(main, 'function sendToOcrSelectionWindow(')
  assert.doesNotMatch(sendSource, /webContents\.once\(['"]did-finish-load/u)
})

/**
 * 校验预热窗口和真实截图入口共用 ready 门禁，保证 Windows/macOS 不分叉。
 * @returns 无返回值。
 * @author zhenghq
 */
test('预热与截图入口应共用跨平台 OCR ready 门禁', () => {
  const prewarmSource = sliceFunction(main, 'function prewarmScreenshotRuntime(')
  const openSource = sliceFunction(main, 'async function openOcrSelection')
  assert.match(prewarmSource, /getOcrSelectionWindow\(\)/u)
  assert.match(main, /whenOcrSelectionWindowReady/u)
  assert.match(openSource, /whenOcrSelectionWindowReady\(win\)/u)
  assert.doesNotMatch(openSource, /process\.platform\s*===\s*['"]win32['"][\s\S]*?whenOcrSelectionWindowReady/u)
  // 旧实现曾在 macOS 上进入简单全屏以对齐菜单栏；该分支会让系统隐藏菜单栏与 Dock 栏，
  // 导致采集到的快照缺失这两个区域。现改为窗口级 enableLargerThanScreen，
  // openOcrSelection 中不应再出现平台专用分支或简单全屏调用。
  assert.doesNotMatch(openSource, /process\.platform\s*===\s*['"]darwin['"]/u)
  assert.doesNotMatch(openSource, /\.setSimpleFullScreen\s*\(/u)
  assert.doesNotMatch(openSource, /\.isSimpleFullScreen\s*\(/u)
})

/**
 * 校验快照就绪后通过 snapshot 事件填图，并校验交互 token。
 * @returns 无返回值。
 * @author zhenghq
 */
test('openOcrSelection 应在采集完成后发送 snapshot 事件', () => {
  const source = sliceFunction(main, 'async function openOcrSelection')
  assert.match(source, /'ocr-selection:snapshot'/u)
  assert.match(source, /isCurrentOcrCapture\(interactionToken\)/u)
})

/**
 * 校验采集失败时发送 failed 事件并保留既有错误弹窗。
 * @returns 无返回值。
 * @author zhenghq
 */
test('采集失败应发送 failed 事件并关闭覆盖窗口', () => {
  const openSource = sliceFunction(main, 'async function openOcrSelection')
  assert.match(openSource, /failOcrSelectionCapture\(/u)
  const failSource = sliceFunction(main, 'function failOcrSelectionCapture(')
  assert.match(failSource, /'ocr-selection:failed'/u)
  assert.match(failSource, /hideOcrSelectionWindow\(\)/u)
  assert.match(failSource, /restoreSelectionListenerAfterOcr\(interactionToken\)/u)
  assert.match(failSource, /showPopup\(/u)
})

/**
 * 校验 begin 之后超过 5 秒未收到快照按采集失败处理。
 * @returns 无返回值。
 * @author zhenghq
 */
test('采集超时应按失败处理', () => {
  assert.match(main, /const OCR_PREVIEW_CAPTURE_TIMEOUT_MS = 5000/u)
  const source = sliceFunction(main, 'async function openOcrSelection')
  assert.match(source, /OCR_PREVIEW_CAPTURE_TIMEOUT_MS/u)
})

/**
 * 校验快照记录分阶段耗时，便于定位延迟来源。
 * @returns 无返回值。
 * @author zhenghq
 */
test('预览采集应记录分阶段耗时', () => {
  const source = sliceFunction(main, 'async function openOcrSelection')
  assert.match(source, /hotkeyToShowMs/u)
  assert.match(source, /captureMs/u)
  assert.match(source, /previewEncodeMs/u)
})

/**
 * 校验主进程快照持有 nativeImage，裁剪不再解码整屏 PNG。
 * @returns 无返回值。
 * @author zhenghq
 */
test('latestOcrSnapshot 应持有 nativeImage 内存图像', () => {
  assert.match(main, /let latestOcrSnapshot:\s*OcrSnapshot \| null = null/u)
  assert.match(main, /interface OcrSnapshot/u)
  assert.match(main, /image:\s*NativeImage/u)
})

/**
 * 校验快速裁剪路径直接使用快照持有的 nativeImage。
 * @returns 无返回值。
 * @author zhenghq
 */
test('快速裁剪应直接使用快照 nativeImage', () => {
  const source = sliceFunction(main, 'function cropCurrentOcrSelectionPngFast')
  assert.match(source, /snapshot\.image/u)
  assert.doesNotMatch(source, /nativeImage\.createFromBuffer\(snapshot\.png\)/u)
  assert.doesNotMatch(source, /decodePng/u)
})

/**
 * 校验 OCR 裁剪先裁选区再编码，不对整屏调用 encodePng。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 选区裁剪不应解码整屏快照', () => {
  const cropSource = sliceFunction(main, 'async function cropOcrSnapshotSelection')
  const currentSource = sliceFunction(main, 'function cropCurrentOcrSelectionPng(')
  for (const source of [cropSource, currentSource]) {
    assert.doesNotMatch(source, /decodePng\(snapshot\.png\)/u)
    assert.match(source, /cropOcrSnapshotToPng|cropSnapshotSelectionPng/u)
  }
})

/**
 * 校验 IPC 契约与预加载层拆成 begin / snapshot / failed 三个事件。
 * @returns 无返回值。
 * @author zhenghq
 */
test('IPC 契约应拆成 begin / snapshot / failed', () => {
  assert.match(types, /export interface OcrSelectionBeginPayload/u)
  assert.match(types, /export interface OcrSelectionSnapshotPayload/u)
  assert.match(types, /export interface OcrSelectionFailedPayload/u)
  assert.match(types, /onOcrSelectionBegin\(cb: \(payload: OcrSelectionBeginPayload\) => void\): \(\) => void/u)
  assert.match(types, /onOcrSelectionSnapshot\(cb: \(payload: OcrSelectionSnapshotPayload\) => void\): \(\) => void/u)
  assert.match(types, /onOcrSelectionFailed\(cb: \(payload: OcrSelectionFailedPayload\) => void\): \(\) => void/u)
  assert.match(preload, /ipcRenderer\.on\('ocr-selection:begin'/u)
  assert.match(preload, /ipcRenderer\.on\('ocr-selection:snapshot'/u)
  assert.match(preload, /ipcRenderer\.on\('ocr-selection:failed'/u)
  assert.doesNotMatch(preload, /'ocr-selection:start'/u)
  assert.doesNotMatch(types, /OcrSelectionStartPayload/u)
})

/**
 * 校验 Renderer 支持采集中态：begin 立即显示遮罩，snapshot 后再启用图像动作。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Renderer 应区分采集中态与快照就绪态', () => {
  assert.match(selectionRenderer, /function enterOcrSelectionMode\(payload: OcrSelectionBeginPayload\): void/u)
  assert.match(selectionRenderer, /function applyOcrSnapshot\(payload: OcrSelectionSnapshotPayload\): void/u)
  assert.match(selectionRenderer, /window\.api\.onOcrSelectionBegin\(enterOcrSelectionMode\)/u)
  assert.match(selectionRenderer, /window\.api\.onOcrSelectionSnapshot\(applyOcrSnapshot\)/u)
  assert.match(selectionRenderer, /window\.api\.onOcrSelectionFailed\(/u)

  const enterSource = sliceFunction(selectionRenderer, 'function enterOcrSelectionMode(')
  // 进入采集中态时不得触碰快照 src，遮罩必须立刻可见
  assert.match(enterSource, /ocrOverlay\.hidden = false/u)
  assert.doesNotMatch(enterSource, /ocrSnapshot\.src =/u)

  const applySource = sliceFunction(selectionRenderer, 'function applyOcrSnapshot(')
  assert.match(applySource, /ocrSnapshot\.src = payload\.imageDataUrl/u)
  // 同会话快照到达后必须保留采集中已经拖出的选区（跨会话由 enterOcrSelectionMode 清理）
  assert.doesNotMatch(applySource, /currentRect\s*=\s*null/u)
})

/**
 * 校验 enterOcrSelectionMode 记录本次会话的 sessionId，用于防串扰。
 * @returns 无返回值。
 * @author zhenghq
 */
test('enterOcrSelectionMode 应记录本次会话的 sessionId', () => {
  const enterSource = sliceFunction(selectionRenderer, 'function enterOcrSelectionMode(')
  assert.match(enterSource, /payload\.sessionId/u, '应读取 begin 负载中的 sessionId')
  assert.match(enterSource, /currentOcrSessionId\s*=\s*payload\.sessionId/u, '应记录当前会话 sessionId')
})

/**
 * 校验 applyOcrSnapshot 通过 sessionId 防串扰：同会话应用，跨会话清理旧选区。
 * @returns 无返回值。
 * @author zhenghq
 */
test('applyOcrSnapshot 应校验 sessionId 防止跨会话串扰', () => {
  const applySource = sliceFunction(selectionRenderer, 'function applyOcrSnapshot(')
  // 必须读取 snapshot 中的 sessionId 并与当前会话比较
  assert.match(applySource, /payload\.sessionId/u, '应读取 snapshot 负载中的 sessionId')
  assert.match(applySource, /currentOcrSessionId/u, '应引用当前会话 sessionId')
  // sessionId 不匹配时静默丢弃，不能复活旧会话或改写当前会话。
  assert.match(applySource, /if \(!ocrMode \|\| payload\.sessionId !== currentOcrSessionId\) return/u)
  assert.doesNotMatch(applySource, /enterOcrSelectionMode/u, '迟到快照不得复活旧会话')
})

/**
 * 校验 OcrSelectionBeginPayload 与 OcrSelectionSnapshotPayload 包含 sessionId 字段。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 框选负载应包含 sessionId 字段', () => {
  assert.match(types, /interface OcrSelectionBeginPayload/u)
  assert.match(types, /interface OcrSelectionSnapshotPayload/u)
  // begin 与 snapshot 都必须携带 sessionId
  const beginIdx = types.indexOf('interface OcrSelectionBeginPayload')
  const beginEnd = types.indexOf('}', beginIdx)
  const beginBody = types.slice(beginIdx, beginEnd)
  assert.match(beginBody, /sessionId/u, 'OcrSelectionBeginPayload 应包含 sessionId')

  const snapIdx = types.indexOf('interface OcrSelectionSnapshotPayload')
  const snapEnd = types.indexOf('}', snapIdx)
  const snapBody = types.slice(snapIdx, snapEnd)
  assert.match(snapBody, /sessionId/u, 'OcrSelectionSnapshotPayload 应包含 sessionId')
})

/**
 * 校验主进程 openOcrSelection 发送 begin 与 snapshot 时携带自增 sessionId。
 * @returns 无返回值。
 * @author zhenghq
 */
test('openOcrSelection 发送 begin 与 snapshot 时应携带 sessionId', () => {
  const openSource = sliceFunction(main, 'async function openOcrSelection')
  // begin 与 snapshot 负载都必须包含 sessionId
  assert.match(openSource, /'ocr-selection:begin'[\s\S]*?sessionId/u, 'begin 负载应包含 sessionId')
  assert.match(openSource, /'ocr-selection:snapshot'[\s\S]*?sessionId/u, 'snapshot 负载应包含 sessionId')
})

/**
 * 校验采集失败事件绑定当前会话，避免旧会话的失败通知关闭新截图窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 采集失败事件应携带并校验 sessionId', () => {
  const failedIdx = types.indexOf('interface OcrSelectionFailedPayload')
  const failedEnd = types.indexOf('}', failedIdx)
  const failedBody = types.slice(failedIdx, failedEnd)
  assert.match(failedBody, /sessionId/u, 'failed 负载应包含 sessionId')

  const failSource = sliceFunction(main, 'function failOcrSelectionCapture(')
  assert.match(failSource, /sessionId/u, '失败处理应生成当前会话 sessionId')

  const handlerSource = sliceFunction(selectionRenderer, 'function handleOcrSelectionFailed(')
  assert.match(handlerSource, /payload\.sessionId/u, 'Renderer 应读取失败事件 sessionId')
  assert.match(handlerSource, /currentOcrSessionId/u, 'Renderer 应校验当前会话 sessionId')
})

/**
 * 校验采集中态禁用依赖图像的按钮，快照就绪后再启用。
 * @returns 无返回值。
 * @author zhenghq
 */
test('采集中态应禁用依赖图像的动作', () => {
  assert.match(selectionRenderer, /function updateOcrImageActionAvailability\(\): void/u)
  const source = sliceFunction(selectionRenderer, 'function updateOcrImageActionAvailability(')
  assert.match(source, /ocrSnapshotState !== 'ready'/u)
  assert.match(source, /ocrCopyImageButton\.disabled/u)
  assert.match(source, /ocrSaveImageButton\.disabled/u)
  assert.match(source, /ocrRecognizeButton\.disabled/u)
  assert.match(source, /ocrTranslateButton\.disabled/u)
})

/**
 * 校验应用就绪后空闲预创建覆盖窗口并预热 GDI。
 * @returns 无返回值。
 * @author zhenghq
 */
test('应用就绪后应空闲预创建覆盖窗口并预热 GDI', () => {
  assert.match(main, /function prewarmScreenshotRuntime\(\): void/u)
  const source = sliceFunction(main, 'function prewarmScreenshotRuntime(')
  assert.match(source, /setTimeout|setImmediate/u)
  assert.match(source, /getOcrSelectionWindow\(\)/u)
  assert.match(source, /warmUpWindowsGdiCapture\(process\.platform\)/u)
  assert.match(main, /prewarmScreenshotRuntime\(\)/u)
})

/**
 * 校验采集中态的键盘路径同样不会提交识别或翻译。
 * @returns 无返回值。
 * @author zhenghq
 */
test('采集中态键盘路径不应提交识别或翻译', () => {
  const recognizeSource = sliceFunction(selectionRenderer, 'function recognizeCurrentOcrSelection(')
  const translateSource = sliceFunction(selectionRenderer, 'function translateCurrentOcrSelection(')
  assert.match(recognizeSource, /ocrSnapshotState !== 'ready'\) return/u)
  assert.match(translateSource, /ocrSnapshotState !== 'ready'\) return/u)
})

/**
 * 校验采集中态仍可通过 Esc 取消框选。
 * @returns 无返回值。
 * @author zhenghq
 */
test('采集中态应仍可 Esc 取消', () => {
  const source = sliceFunction(selectionRenderer, 'function handleKeyDown(')
  assert.match(source, /if \(event\.key === 'Escape'\) cancelOcrSelection\(\)/u)
  const cancelSource = sliceFunction(selectionRenderer, 'function cancelOcrSelection(')
  // 取消不依赖快照状态，任何时候都要通知主进程收尾
  assert.doesNotMatch(cancelSource, /ocrSnapshotState/u)
  assert.match(cancelSource, /window\.api\.cancelOcrSelection\(\)/u)
})

/**
 * 校验取消后完成的旧采集不会写入快照，也不会弹出超时错误。
 * @returns 无返回值。
 * @author zhenghq
 */
test('取消后完成的旧采集应被丢弃', () => {
  assert.match(main, /function isCurrentOcrCapture\(token: number\): boolean/u)
  const guardSource = sliceFunction(main, 'function isCurrentOcrCapture(')
  // 取消会把 ocrInteractionToken 清空，因此所有权判定必须同时看它
  assert.match(guardSource, /ocrInteractionToken === token/u)
  assert.match(guardSource, /selectionInteraction\.isCurrent\(token\)/u)

  const openSource = sliceFunction(main, 'async function openOcrSelection')
  assert.match(openSource, /isCurrentOcrCapture\(interactionToken\)/u)
  const failSource = sliceFunction(main, 'function failOcrSelectionCapture(')
  assert.match(failSource, /isCurrentOcrCapture\(interactionToken\)/u)
})

/**
 * 校验采集中态给出等待提示，快照就绪后切回操作提示。
 * @returns 无返回值。
 * @author zhenghq
 */
test('采集中态应提示正在获取屏幕画面', () => {
  assert.match(selectionHtml, /id="ocr-tip"/u)
  assert.match(selectionRenderer, /const ocrTip = document\.getElementById\('ocr-tip'\) as HTMLElement/u)
  assert.match(selectionRenderer, /function renderOcrTip\(message\?: string\): void/u)
  const source = sliceFunction(selectionRenderer, 'function renderOcrTip(')
  assert.match(source, /正在获取屏幕画面/u)
  assert.match(source, /ocrSnapshotState/u)
  const enterSource = sliceFunction(selectionRenderer, 'function enterOcrSelectionMode(')
  assert.match(enterSource, /renderOcrTip\(\)/u)
  // 提示样式必须走主题变量，不硬编码颜色；配色复用覆盖层提示胶囊 Token
  assert.doesNotMatch(selectionCss, /\.ocr-tip[^}]*(?:#[0-9a-fA-F]{3,8}|rgb\()/su)
  assert.match(selectionCss, /\.ocr-tip[^}]*var\(--hint-pill-bg\)/su)
})

/**
 * 校验 OCR 会话重置覆盖所有可复用 UI 和异步资源，避免取消后重开残留旧状态。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 会话重置应清理选区、面板、标注、图片、按钮和延迟任务', () => {
  const resetSource = sliceFunction(selectionRenderer, 'function resetOcrSessionUi(')
  for (const expression of [
    /clearTimeout/u,
    /ocrSnapshotLoadToken \+=\s*1/u,
    /currentRect = null/u,
    /pendingScreenshotRequestId = null/u,
    /screenshotActionPending = null/u,
    /resetAnnotationSession\(\)/u,
    /ocrSnapshot\.removeAttribute\('src'\)/u,
    /ocrOverlay\.classList\.remove\('closing'\)/u,
    /updateOcrImageActionAvailability\(\)/u
  ]) {
    assert.match(resetSource, expression)
  }
  const enterSource = sliceFunction(selectionRenderer, 'function enterOcrSelectionMode(')
  assert.match(enterSource, /resetOcrSessionUi\(\)/u)
})

/**
 * 校验背景图 load/error 回调同时受会话 ID 和加载令牌保护，旧资源不能污染新会话。
 * @returns 无返回值。
 * @author zhenghq
 */
test('旧背景图 load/error 回调不得更新新截图会话', () => {
  for (const signature of ['function handleOcrSnapshotLoad(', 'function handleOcrSnapshotError(']) {
    const source = sliceFunction(selectionRenderer, signature)
    assert.match(source, /ocrSnapshot\.dataset\.sessionId/u)
    assert.match(source, /ocrSnapshot\.dataset\.loadToken/u)
    assert.match(source, /ocrSnapshotLoadToken/u)
  }
})

/**
 * 校验完成动画绑定创建会话，旧会话定时器不能关闭新会话窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('截图完成延迟关闭应再次校验 sessionId', () => {
  const source = sliceFunction(selectionRenderer, 'function scheduleScreenshotAutoClose(')
  assert.match(source, /const sessionId = currentOcrSessionId/u)
  assert.match(source, /currentOcrSessionId !== sessionId/u)
  assert.match(source, /clearTimeout/u)
})

/**
 * 校验取消（Esc / 取消按钮）在通知主进程隐藏窗口前，先让清空后的画面真正上屏。
 * 窗口被复用且隐藏后不再绘制，若带着旧选区的那一帧被隐藏，下次显示会先闪出旧画面。
 * @returns 无返回值。
 * @author zhenghq
 */
test('取消截图应等清空画面上屏后再通知主进程隐藏窗口', () => {
  const cancelSource = sliceFunction(selectionRenderer, 'function cancelOcrSelection(')
  const leaveIndex = cancelSource.indexOf('leaveOcrSelectionMode()')
  const deferIndex = cancelSource.indexOf('afterOverlayCleared(')
  const notifyIndex = cancelSource.indexOf('window.api.cancelOcrSelection()')
  assert.ok(leaveIndex >= 0, '取消必须先清空本轮截图会话 UI')
  assert.ok(deferIndex >= 0, '取消必须等待清空后的画面上屏')
  assert.ok(leaveIndex < deferIndex, '必须先清空再等待上屏')
  assert.ok(deferIndex < notifyIndex, '通知主进程隐藏窗口必须发生在等待之后')

  const deferSource = sliceFunction(selectionRenderer, 'function afterOverlayCleared(')
  // 双帧等待：第一帧提交 DOM 变更，第二帧确认清空后的画面已经合成上屏。
  assert.match(deferSource, /requestAnimationFrame\([\s\S]*?requestAnimationFrame\(/u)
  // 窗口隐藏或渲染被节流时 rAF 可能不触发，必须有超时兜底，避免主进程收不到取消通知。
  assert.match(deferSource, /setTimeout\(/u)
  // 兜底与正常路径只能执行一次，避免重复发送取消 IPC。
  assert.match(deferSource, /if \(done\) return/u)
})
