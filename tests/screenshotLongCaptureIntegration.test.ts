import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/** 读取源码文件。 */
function source(path: string): string {
  return readFileSync(path, 'utf8')
}

test('长截图应注册独立 Renderer 入口并保留本地化与主题启动脚本', () => {
  const vite = source('electron.vite.config.ts')
  const html = source('src/renderer/long-capture.html')
  assert.match(vite, /'long-capture':\s*resolve\('src\/renderer\/long-capture\.html'\)/u)
  assert.match(html, /localeBootstrap\.js/u)
  assert.match(html, /themeBootstrap\.js/u)
  assert.match(html, /src\/theme\.css/u)
  assert.match(html, /src\/longCapture\.ts/u)
})

test('长截图应暴露完整 IPC 契约并校验请求来源', () => {
  const types = source('src/shared/types.ts')
  const preload = source('src/preload/index.ts')
  const main = source('src/main/index.ts')
  for (const method of [
    'startScreenshotLongCapture',
    'sampleScreenshotLongCapture',
    'undoScreenshotLongCapture',
    'finishScreenshotLongCapture',
    'cancelScreenshotLongCapture',
    'onScreenshotLongCaptureState',
    'onScreenshotLongCapturePreview',
    'onScreenshotLongCaptureAction'
  ]) {
    assert.match(types, new RegExp(`\\b${method}\\b`, 'u'), `Api 缺少 ${method}`)
    assert.match(preload, new RegExp(`\\b${method}\\b`, 'u'), `preload 缺少 ${method}`)
  }
  assert.match(preload, /ocr-selection:start-long-capture/u)
  assert.match(preload, /screenshot-long-capture:sample/u)
  assert.match(main, /ipcMain\.on\('ocr-selection:start-long-capture'/u)
  assert.match(main, /ipcMain\.on\('screenshot-long-capture:sample'/u)
  assert.match(main, /isLongCaptureSender/u)
})

test('长截图窗口应在目标选区旁无焦点显示并使用统一跨工作区选项', () => {
  const main = source('src/main/index.ts')
  const manager = source('src/main/screenshotLongCaptureWindow.ts')
  assert.match(main, /createScreenshotLongCaptureWindowManager/u)
  assert.match(manager, /showInactive\(\)/u)
  assert.match(manager, /setVisibleOnAllWorkspaces\(true, ALL_WORKSPACES_VISIBILITY_OPTIONS\)/u)
  assert.match(manager, /new LongCaptureStitcher/u)
  assert.match(manager, /captureOcrSelectionPng/u)
  assert.match(manager, /encodePng/u)
})

test('长截图应以 90ms 串行采样并发布降采样后的实时预览', () => {
  const manager = source('src/main/screenshotLongCaptureWindow.ts')
  assert.match(manager, /LONG_CAPTURE_SAMPLE_INTERVAL_MS\s*=\s*90/u)
  assert.match(manager, /resizeLongCapturePreview\(result\.data, current\.pixelWidth, result\.height\)/u)
  assert.match(manager, /width:\s*previewImage\.width[\s\S]*?height:\s*previewImage\.height/u)
  assert.match(manager, /if \(current\.appended\) publishPreview\(current\)/u)
})

test('长截图完成前应等待当前采样并强制补抓最后一帧', () => {
  const manager = source('src/main/screenshotLongCaptureWindow.ts')
  assert.match(manager, /await waitForSamplingToFinish\(current\)/u)
  assert.match(manager, /await sample\(sessionId, \{ force: true \}\)/u)
})

test('长截图后续抓帧尺寸变化时应停止拼接并提示重新框选', () => {
  const manager = source('src/main/screenshotLongCaptureWindow.ts')
  assert.match(manager, /image\.width\s*!==\s*current\.pixelWidth/u)
  assert.match(manager, /image\.height\s*!==\s*current\.pixelHeight/u)
  assert.match(manager, /screenshot\.longCapture\.dimensionsChanged/u)
})

test('长截图控制窗应为紧凑状态条并配置独立点击穿透预览', () => {
  const manager = source('src/main/screenshotLongCaptureWindow.ts')
  assert.match(manager, /LONG_CAPTURE_STATUS_BAR_HEIGHT\s*=\s*48/u)
  assert.match(manager, /placeLongCaptureStatusBar/u)
  assert.match(manager, /placeLongCapturePreview/u)
  assert.match(manager, /setIgnoreMouseEvents\(true/u)
})

test('长截图控制窗被外部关闭时应恢复划词监听', () => {
  const main = source('src/main/index.ts')
  const manager = source('src/main/screenshotLongCaptureWindow.ts')
  assert.match(main, /onSessionEnded:\s*restoreSelectionListenerAfterOcr/u)
  assert.match(
    manager,
    /win\.on\('closed',\s*\(\)\s*=>\s*\{[\s\S]*?dependencies\.onSessionEnded\?\.\(\)/u
  )
})

test('截图工具栏应提供长截图与贴图入口并复用标注合成结果', () => {
  const html = source('src/renderer/selection.html')
  const selection = source('src/renderer/src/selection.ts')
  assert.match(html, /id="ocr-long-capture"/u)
  assert.match(html, /id="ocr-pin-image"/u)
  assert.match(selection, /startScreenshotLongCapture/u)
  assert.match(selection, /createScreenshotPin/u)
  assert.match(selection, /buildAnnotatedExportPayload/u)
})
