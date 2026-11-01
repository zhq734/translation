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

test('长截图应以 90ms 串行采样并仅在独立预览窗存在时节流发布预览', () => {
  const manager = source('src/main/screenshotLongCaptureWindow.ts')
  assert.match(manager, /LONG_CAPTURE_SAMPLE_INTERVAL_MS\s*=\s*90/u)
  assert.match(manager, /LONG_CAPTURE_PREVIEW_INTERVAL_MS\s*=\s*250/u)
  assert.match(manager, /resizeLongCapturePreview\(result\.data, current\.pixelWidth, result\.height\)/u)
  assert.match(manager, /width:\s*previewImage\.width[\s\S]*?height:\s*previewImage\.height/u)
  assert.match(manager, /if \(current\.appended\) schedulePreview\(current\)/u)
  assert.match(manager, /!current\.previewWin\s*\|\|\s*current\.previewWin\.isDestroyed\(\)/u)
  assert.match(
    manager,
    /setTimeout\([\s\S]*?publishPreview\(current\)[\s\S]*?LONG_CAPTURE_PREVIEW_INTERVAL_MS/u
  )
  assert.doesNotMatch(manager, /\n\s+send\('screenshot-long-capture:preview'/u)
})

test('长截图完成前应等待当前采样并强制补抓最后一帧', () => {
  const manager = source('src/main/screenshotLongCaptureWindow.ts')
  assert.match(manager, /await waitForSamplingToFinish\(current\)/u)
  assert.match(manager, /await sample\([^,]+\.sessionId, \{ force: true \}\)/u)
})

test('长截图应在目标应用获得焦点时注册全局完成、取消和撤销快捷键', () => {
  const manager = source('src/main/screenshotLongCaptureWindow.ts')
  const main = source('src/main/index.ts')
  assert.match(manager, /registerGlobalShortcut/u)
  assert.match(manager, /unregisterGlobalShortcut/u)
  assert.match(manager, /CommandOrControl\+Z/u)
  assert.match(manager, /Return/u)
  assert.match(manager, /Escape/u)
  assert.match(main, /registerGlobalShortcut:\s*\(accelerator, callback\)/u)
  assert.match(main, /unregisterGlobalShortcut:\s*\(accelerator\)/u)
})

test('长截图取消或窗口关闭时必须统一注销快捷键并清理预览定时器', () => {
  const manager = source('src/main/screenshotLongCaptureWindow.ts')
  assert.match(
    manager,
    /const endSession[\s\S]*?clearTimer\(current\)[\s\S]*?clearPreviewTimer\(current\)[\s\S]*?unregisterSessionShortcuts\(current\)/u
  )
  assert.match(
    manager,
    /win\.on\('closed',[\s\S]*?endSession\(current, true\)/u
  )
})

test('长截图保存取消或失败后应恢复自动采样', () => {
  const manager = source('src/main/screenshotLongCaptureWindow.ts')
  assert.match(manager, /const startTimer\s*=/u)
  assert.match(manager, /save\.canceled[\s\S]*?startTimer\(current\)/u)
  assert.match(manager, /catch \(error\)[\s\S]*?startTimer\(current\)/u)
})

test('长截图连续定位失败时应通过状态链路提示放慢滚动', () => {
  const types = source('src/shared/types.ts')
  const manager = source('src/main/screenshotLongCaptureWindow.ts')
  const renderer = source('src/renderer/src/longCapture.ts')
  const zh = source('src/shared/i18n/catalog.zh-CN.base.ts')
  const en = source('src/shared/i18n/catalog.en-US.base.ts')

  assert.match(types, /locateFailures:\s*number/u)
  assert.match(manager, /locateFailures:\s*current\.stitcher\?\.locateFailures\s*\?\?\s*0/u)
  assert.match(renderer, /state\.locateFailures\s*>=\s*2/u)
  assert.match(renderer, /screenshot\.longCapture\.slowDown/u)
  assert.match(zh, /'screenshot\.longCapture\.slowDown'/u)
  assert.match(en, /'screenshot\.longCapture\.slowDown'/u)
})

test('macOS 长截图 helper 失败后应熔断并直接使用系统抓屏回退', () => {
  const main = source('src/main/index.ts')
  assert.match(main, /let macosLongCaptureHelperUnavailable\s*=\s*false/u)
  assert.match(main, /!macosLongCaptureHelperUnavailable/u)
  assert.match(main, /macosLongCaptureHelperUnavailable\s*=\s*true/u)
})

test('每个新长截图会话都应重置 macOS helper 熔断并重新尝试常驻抓帧', () => {
  const main = source('src/main/index.ts')
  assert.match(
    main,
    /function startScreenshotLongCapture[\s\S]*?macosLongCaptureHelperUnavailable\s*=\s*false[\s\S]*?manager\.start\(sessionId, bounds\)/u
  )
})

test('长截图完成失败时必须回传动作结果而不能让按钮永久等待', () => {
  const manager = source('src/main/screenshotLongCaptureWindow.ts')
  assert.match(
    manager,
    /if \(current\.stopped\)[\s\S]*?publishAction\(\{[\s\S]*?ok:\s*false/u
  )
  assert.match(
    manager,
    /!current\.stitcher \|\| current\.stitcher\.height <= 0[\s\S]*?publishAction\(\{[\s\S]*?ok:\s*false/u
  )
})

test('长截图动作失败提示不得被旧状态覆盖', () => {
  const renderer = source('src/renderer/src/longCapture.ts')
  assert.match(
    renderer,
    /latestState\s*=\s*\{[\s\S]*?\.\.\.latestState,[\s\S]*?error:\s*result\.error\s*\?\?\s*t\('screenshot\.longCapture\.finishFailed'\)/u
  )
  assert.match(renderer, /renderState\(latestState\)/u)
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
    /const endSession[\s\S]*?dependencies\.onSessionEnded\?\.\(\)/u
  )
  assert.match(manager, /ended:\s*boolean/u)
  assert.match(manager, /if \(current\.ended\) return/u)
  assert.match(manager, /win\.on\('closed',[\s\S]*?endSession\(current, true\)/u)
})

test('macOS 长截图 helper 应声明 ScreenCaptureKit 所需的最低系统版本', () => {
  const buildScript = source('scripts/build-macos-long-capture.mjs')
  assert.match(buildScript, /'-mmacosx-version-min=15\.2'/u)
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
