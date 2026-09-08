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
 * 校验覆盖窗口在采集之前显示，并先发送 begin 事件。
 * @returns 无返回值。
 * @author zhenghq
 */
test('openOcrSelection 应先显示覆盖窗口再采集快照', () => {
  const source = sliceFunction(main, 'async function openOcrSelection')
  const showIndex = source.indexOf('win.show()')
  const beginIndex = source.indexOf("'ocr-selection:begin'")
  const captureIndex = source.indexOf('captureOcrPreviewSnapshot(')
  assert.ok(showIndex >= 0, '应显示覆盖窗口')
  assert.ok(beginIndex >= 0, '应发送 begin 事件')
  assert.ok(captureIndex >= 0, '应采集预览快照')
  assert.ok(showIndex < captureIndex, '覆盖窗口显示必须早于屏幕采集')
  assert.ok(beginIndex < captureIndex, 'begin 事件必须早于屏幕采集')
  assert.match(source, /win\.setBounds\(display\.bounds\)/u)
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
  // 快照到达后必须保留采集中已经拖出的选区
  assert.doesNotMatch(applySource, /currentRect = null/u)
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
  assert.match(selectionRenderer, /function renderOcrTip\(\): void/u)
  const source = sliceFunction(selectionRenderer, 'function renderOcrTip(')
  assert.match(source, /正在获取屏幕画面/u)
  assert.match(source, /ocrSnapshotState/u)
  const enterSource = sliceFunction(selectionRenderer, 'function enterOcrSelectionMode(')
  assert.match(enterSource, /renderOcrTip\(\)/u)
  // 提示样式必须走主题变量，不硬编码颜色
  assert.doesNotMatch(selectionCss, /\.ocr-tip[^}]*(?:#[0-9a-fA-F]{3,8}|rgb\()/su)
})
