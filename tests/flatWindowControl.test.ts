import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const mainSource = readFileSync('src/main/index.ts', 'utf8')
const webReaderSource = readFileSync('src/main/webReaderWindow.ts', 'utf8')
const preloadSource = readFileSync('src/preload/index.ts', 'utf8')
const apiSource = readFileSync('src/shared/types.ts', 'utf8')
const themeSource = readFileSync('src/renderer/src/theme.css', 'utf8')
const controlsSource = readFileSync('src/main/windowControls.ts', 'utf8')

test('设置页和网页阅读器应使用一致的无边框可调整窗口配置', () => {
  const settingsWindow = mainSource.slice(
    mainSource.indexOf('function createSettingsWindow'),
    mainSource.indexOf('function openSettings')
  )
  const readerWindow = webReaderSource.slice(
    webReaderSource.indexOf('private async ensureWindow'),
    webReaderSource.indexOf('private getSession')
  )

  for (const [name, source] of [['设置页', settingsWindow], ['网页阅读器', readerWindow]] as const) {
    assert.match(source, /frame:\s*false/u, `${name}未关闭原生窗口边框`)
    assert.match(source, /resizable:\s*true/u, `${name}未明确允许调整尺寸`)
    assert.match(source, /maximizable:\s*true/u, `${name}未允许最大化`)
    assert.match(source, /fullscreenable:\s*false/u, `${name}不应开放全屏入口`)
    assert.match(source, /backgroundColor:\s*['"]#[\da-f]{6}['"]/iu, `${name}缺少稳定首帧背景色`)
  }
  assert.match(themeSource, /--titlebar-height:\s*40px/u)
})

test('preload 应只暴露固定窗口控制 API 并提供可清理订阅', () => {
  for (const signature of [
    'windowMinimize(): void',
    'windowToggleMaximize(): void',
    'windowClose(): void',
    'windowIsMaximized(): Promise<boolean>',
    'onWindowMaximizedChanged(cb: (maximized: boolean) => void): () => void'
  ]) {
    assert.ok(apiSource.includes(signature), `Api 缺少 ${signature}`)
  }
  for (const channel of [
    'window:minimize',
    'window:toggle-maximize',
    'window:close',
    'window:is-maximized',
    'window:maximized-changed'
  ]) {
    assert.ok(preloadSource.includes(`'${channel}'`), `preload 缺少固定通道 ${channel}`)
  }
  assert.match(
    preloadSource,
    /onWindowMaximizedChanged[\s\S]*ipcRenderer\.removeListener\('window:maximized-changed',\s*listener\)/u
  )
  assert.doesNotMatch(preloadSource, /windowControl\s*\([^)]*(?:action|channel|windowId)/u)
})

test('主进程应按发送者解析并校验允许控制的窗口', () => {
  assert.match(controlsSource, /BrowserWindow\.fromWebContents\(event\.sender\)/u)
  assert.match(controlsSource, /isAllowedWindow\(window\)/u)
  assert.match(controlsSource, /event\.sender\.isDestroyed\(\)/u)
  assert.match(controlsSource, /window\.isDestroyed\(\)/u)
  assert.doesNotMatch(controlsSource, /BrowserWindow\.fromId/u)
  assert.doesNotMatch(controlsSource, /(?:windowId|action|channel)\s*:\s*(?:string|number)/u)
  assert.match(mainSource, /window === settingsWin/u)
  assert.match(mainSource, /webReader\?\.ownsWindow\(window\)/u)
})

test('主进程应广播最大化状态并在窗口或发送者销毁时清理监听', () => {
  assert.match(controlsSource, /window\.on\('maximize',\s*sendState\)/u)
  assert.match(controlsSource, /window\.on\('unmaximize',\s*sendState\)/u)
  assert.match(controlsSource, /window\.on\('closed',\s*cleanup\)/u)
  assert.match(controlsSource, /webContents\.on\('destroyed',\s*cleanup\)/u)
  assert.match(controlsSource, /window\.removeListener\('maximize',\s*sendState\)/u)
  assert.match(controlsSource, /window\.removeListener\('unmaximize',\s*sendState\)/u)
  assert.match(controlsSource, /webContents\.removeListener\('destroyed',\s*cleanup\)/u)
  assert.match(controlsSource, /webContents\.send\('window:maximized-changed',\s*window\.isMaximized\(\)\)/u)
})
