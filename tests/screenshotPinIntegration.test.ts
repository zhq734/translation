import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/** 读取源码文件。 */
function source(path: string): string {
  return readFileSync(path, 'utf8')
}

test('贴图应注册独立 Renderer 入口与主题基础样式', () => {
  const vite = source('electron.vite.config.ts')
  const html = source('src/renderer/pin.html')
  assert.match(vite, /pin:\s*resolve\('src\/renderer\/pin\.html'\)/u)
  assert.match(html, /localeBootstrap\.js/u)
  assert.match(html, /themeBootstrap\.js/u)
  assert.match(html, /src\/pin\.ts/u)
})

test('贴图应暴露创建与窗口交互 IPC，并限制发送窗口', () => {
  const types = source('src/shared/types.ts')
  const preload = source('src/preload/index.ts')
  const main = source('src/main/index.ts')
  for (const method of [
    'createScreenshotPin',
    'dragScreenshotPin',
    'wheelScreenshotPin',
    'closeScreenshotPin',
    'showScreenshotPinContextMenu',
    'onScreenshotPinInit'
  ]) {
    assert.match(types, new RegExp(`\\b${method}\\b`, 'u'), `Api 缺少 ${method}`)
    assert.match(preload, new RegExp(`\\b${method}\\b`, 'u'), `preload 缺少 ${method}`)
  }
  assert.match(main, /ipcMain\.handle\('ocr-selection:create-pin'/u)
  assert.match(main, /isOcrSelectionSender/u)
  assert.match(main, /isScreenshotPinSender/u)
  assert.match(main, /MAX_SCREENSHOT_PINS/u)
})

test('贴图窗口应无边框置顶、支持拖动缩放透明度和右键菜单', () => {
  const manager = source('src/main/screenshotPinWindow.ts')
  assert.match(manager, /frame:\s*false/u)
  assert.match(manager, /transparent:\s*true/u)
  assert.match(manager, /alwaysOnTop:\s*true/u)
  assert.match(manager, /setVisibleOnAllWorkspaces\(true, ALL_WORKSPACES_VISIBILITY_OPTIONS\)/u)
  assert.match(manager, /setPosition\(/u)
  assert.match(manager, /clampPinScale/u)
  assert.match(manager, /clampPinOpacity/u)
  assert.match(manager, /Menu\.buildFromTemplate/u)
})

test('贴图保存失败应捕获异常并显示本地化错误提示', () => {
  const manager = source('src/main/screenshotPinWindow.ts')
  assert.match(manager, /screenshot\.pin\.saveFailed/u)
  assert.match(
    manager,
    /const savePin = async[\s\S]*?try\s*\{[\s\S]*?await writeFile\(result\.filePath, session\.png\)[\s\S]*?catch\s*\(error\)[\s\S]*?showToast/u
  )
})

test('贴图透明度应只由 Renderer 应用，避免窗口与内容透明度叠加', () => {
  const manager = source('src/main/screenshotPinWindow.ts')
  const renderer = source('src/renderer/src/pin.ts')
  assert.match(renderer, /root\.style\.opacity\s*=\s*String\(payload\.opacity\)/u)
  assert.doesNotMatch(manager, /\.setOpacity\(/u)
})

test('贴图会话应使用初始适配倍率，避免大图首次缩放跳变', () => {
  const manager = source('src/main/screenshotPinWindow.ts')
  assert.match(manager, /scale:\s*clampPinScale\(fitPinScale\(request, display\.workArea\)\)/u)
})
