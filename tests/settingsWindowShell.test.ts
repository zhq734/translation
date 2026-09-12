import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * 获取指定元素的开始标签。
 * @param html HTML 文本。
 * @param id 元素标识。
 * @returns 元素开始标签。
 * @author zhenghq
 */
function getOpeningTag(html: string, id: string): string {
  const match = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`, 'u'))
  assert.ok(match, `缺少元素 #${id}`)
  return match[0]
}

test('设置页应提供统一的可拖动自绘标题栏和固定顺序窗口按钮', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const css = readFileSync('src/renderer/src/settings.css', 'utf8')
  const titlebarIndex = html.indexOf('id="settings-titlebar"')
  const minimizeIndex = html.indexOf('id="window-minimize"')
  const maximizeIndex = html.indexOf('id="window-maximize"')
  const closeIndex = html.indexOf('id="window-close"')

  assert.ok(titlebarIndex >= 0)
  assert.ok(minimizeIndex > titlebarIndex)
  assert.ok(maximizeIndex > minimizeIndex)
  assert.ok(closeIndex > maximizeIndex)
  assert.match(getOpeningTag(html, 'window-minimize'), /aria-label="最小化"/u)
  assert.match(getOpeningTag(html, 'window-maximize'), /aria-label="最大化"/u)
  assert.match(getOpeningTag(html, 'window-close'), /aria-label="关闭"/u)
  assert.match(html, /<svg[^>]+aria-hidden="true"/u)
  assert.match(css, /\.window-titlebar\s*\{[\s\S]*height:\s*40px/u)
  assert.match(css, /\.window-titlebar\s*\{[\s\S]*-webkit-app-region:\s*drag/u)
  assert.match(css, /\.window-controls[\s\S]*-webkit-app-region:\s*no-drag/u)
})

test('设置窗口不应启用 alwaysOnTop，以便其他应用可以正常覆盖', () => {
  const mainSource = readFileSync('src/main/index.ts', 'utf8')
  const settingsWindowBlock = mainSource.match(
    /async function createSettingsWindow\(\): Promise<BrowserWindow> \{([\s\S]*?)\n\}/u
  )
  assert.ok(settingsWindowBlock)
  assert.doesNotMatch(settingsWindowBlock[1], /alwaysOnTop/u)
  assert.doesNotMatch(settingsWindowBlock[1], /setAlwaysOnTop/u)
})

test('设置页标题栏应调用最小窗口 API并同步最大化状态', () => {
  const source = readFileSync('src/renderer/src/settings.ts', 'utf8')
  assert.match(source, /window\.api\.windowMinimize\(\)/u)
  assert.match(source, /window\.api\.windowToggleMaximize\(\)/u)
  assert.match(source, /window\.api\.windowClose\(\)/u)
  assert.match(source, /await window\.api\.windowIsMaximized\(\)/u)
  assert.match(source, /window\.api\.onWindowMaximizedChanged/u)
  assert.match(source, /settingsTitlebar\.addEventListener\('dblclick'/u)
  assert.match(source, /ariaLabel\s*=\s*maximized\s*\?\s*'还原'\s*:\s*'最大化'/u)
  assert.match(source, /document\.documentElement\.dataset\.maximized/u)
})
