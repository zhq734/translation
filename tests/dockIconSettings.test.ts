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

test('主进程应成对切换 macOS 激活策略与 Dock 图标并通过 Dock 激活进入设置', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')

  assert.match(source, /async function applyMacOSDockVisibility\(showDockIcon: boolean\): Promise<void>/u)
  assert.match(source, /resolveMacOSDockPresentation\([\s\S]*?settingsOpen:[\s\S]*?webReaderOpen:/u)
  assert.match(source, /app\.setActivationPolicy\(presentation\.policy\)/u)
  assert.match(source, /if \(presentation\.dockVisible\)[\s\S]*?await app\.dock\?\.show\(\)[\s\S]*?app\.dock\?\.hide\(\)/u)
  assert.doesNotMatch(source, /shouldShowMacOSDockIcon/u)
  assert.match(
    source,
    /configureMacOSMenuBarApplication\([\s\S]*?getSettings\(\)\.showDockIcon,[\s\S]*?openSettingsOnInitialLaunch[\s\S]*?\)/u
  )
  assert.match(source, /patch\.showDockIcon\s*!==\s*undefined[\s\S]*?applyMacOSDockVisibility\(settings\.showDockIcon\)/u)
  assert.match(source, /app\.on\('activate',[\s\S]*?openSettings\(\)/u)
  assert.match(source, /settingsWin\.on\('closed',[\s\S]*?refreshMacOSDockVisibility\(\)/u)
  assert.match(source, /onWindowStateChanged:\s*\(open\)[\s\S]*?refreshMacOSDockVisibility\(\)/u)
})

test('新建与复用设置窗口都必须先刷新策略并激活应用，再显示和聚焦窗口', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const settingsWindowBlock = source.match(
    /async function createSettingsWindow\(\): Promise<BrowserWindow> \{([\s\S]*?)\n\}/u
  )

  assert.ok(settingsWindowBlock)
  const createdWindowIndex = settingsWindowBlock[1].indexOf('const createdWindow = new BrowserWindow')
  assert.ok(createdWindowIndex > 0)
  const reusePath = settingsWindowBlock[1].slice(0, createdWindowIndex)
  const createPath = settingsWindowBlock[1].slice(createdWindowIndex)

  assert.match(settingsWindowBlock[1], /show:\s*false/u)
  for (const path of [reusePath, createPath]) {
    assert.match(
      path,
      /await refreshMacOSDockVisibility\(\)[\s\S]*?if \(isMac\) app\.focus\(\{ steal: true \}\)[\s\S]*?settingsWin\.show\(\)[\s\S]*?settingsWin\.focus\(\)/u
    )
  }
  assert.match(source, /async function openSettings\(\): Promise<void>[\s\S]*?await createSettingsWindow\(\)/u)
  const openSettingsBlock = source.match(
    /async function openSettings\(\): Promise<void> \{([\s\S]*?)\n\}/u
  )
  assert.ok(openSettingsBlock)
  assert.doesNotMatch(openSettingsBlock[1], /app\.focus/u)
})

test('设置页关闭 Dock 图标后应在切换激活策略后恢复窗口可见性和焦点', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const applyStart = source.indexOf('async function applyMacOSDockVisibility')
  const applyEnd = source.indexOf('\nfunction applyAutoLaunch', applyStart)
  const applyBlock = source.slice(applyStart, applyEnd)

  assert.ok(applyStart >= 0 && applyEnd > applyStart)
  assert.match(
    applyBlock,
    /const settingsWindowToPreserve\s*=\s*settingsWin[^\n]*isVisible\(\)/u
  )
  assert.match(
    applyBlock,
    /await app\.dock\?\.hide\(\)[\s\S]*?settingsWin\s*===\s*settingsWindowToPreserve[\s\S]*?settingsWindowToPreserve\.show\(\)[\s\S]*?settingsWindowToPreserve\.focus\(\)/u
  )
})
