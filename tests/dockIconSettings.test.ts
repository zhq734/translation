import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/shared/settingsDefaults.ts'

test('Dock 图标显示设置默认关闭并能从旧配置安全迁移', () => {
  assert.equal(DEFAULT_SETTINGS.showDockIcon, false)
  assert.equal(normalizeSettings({ schemaVersion: 9 }).showDockIcon, false)
  assert.equal(normalizeSettings({ schemaVersion: 9, showDockIcon: true }).showDockIcon, true)
  assert.equal(normalizeSettings({ schemaVersion: 9, showDockIcon: 'true' as never }).showDockIcon, false)
})

test('设置页应提供 Dock 图标显示开关并通过普通设置接口保存', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const source = readFileSync('src/renderer/src/settings.ts', 'utf8')

  assert.match(html, /id="show-dock-icon"[^>]+type="checkbox"/u)
  assert.match(html, /for="show-dock-icon"/u)
  assert.match(html, /显示 Dock 栏图标/u)
  assert.match(source, /getElementById\('show-dock-icon'\)/u)
  assert.match(source, /showDockIcon\.checked\s*=\s*settings\.showDockIcon/u)
  assert.match(source, /showDockIcon\.addEventListener\('change', saveDockIconVisibility\)/u)
  assert.match(source, /function saveDockIconVisibility\(\): void[\s\S]*?showDockIcon\.checked/u)
  assert.match(source, /showDockIcon:\s*showDockIcon\.checked/u)
})

test('主进程应根据设置切换 macOS Dock 图标并通过 Dock 激活进入设置', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')

  assert.match(source, /function applyMacOSDockVisibility\(showDockIcon: boolean\)/u)
  assert.match(source, /shouldShowMacOSDockIcon\([\s\S]*?settingsOpen:[\s\S]*?webReaderOpen:/u)
  assert.match(source, /if \(shouldShow\)[\s\S]*?app\.setActivationPolicy\('regular'\)[\s\S]*?app\.dock\?\.show\(\)/u)
  assert.match(source, /app\.setActivationPolicy\('accessory'\)/u)
  assert.match(source, /app\.dock\?\.hide\(\)/u)
  assert.match(source, /configureMacOSMenuBarApplication\(getSettings\(\)\.showDockIcon\)/u)
  assert.match(source, /patch\.showDockIcon\s*!==\s*undefined[\s\S]*?applyMacOSDockVisibility\(settings\.showDockIcon\)/u)
  assert.match(source, /app\.on\('activate',[\s\S]*?openSettings\(\)/u)
  assert.match(source, /settingsWin\.on\('closed',[\s\S]*?refreshMacOSDockVisibility\(\)/u)
  assert.match(source, /onWindowStateChanged:\s*\(open\)[\s\S]*?refreshMacOSDockVisibility\(\)/u)
})
