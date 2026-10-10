import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/shared/settingsDefaults.ts'
import { tForTest } from './helpers/i18n.ts'

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
  assert.match(html, new RegExp(`data-i18n="settings\\.launch\\.showDock">${tForTest('en-US', 'settings.launch.showDock')}`, 'u'))
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

test('复用设置窗口先刷新策略再置前，新建设置窗口先置前再刷新策略', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const settingsWindowBlock = source.match(
    /async function createSettingsWindow\([\s\S]*?\): Promise<BrowserWindow> \{([\s\S]*?)\n\}/u
  )

  assert.ok(settingsWindowBlock)
  const createdWindowIndex = settingsWindowBlock[1].indexOf('const createdWindow = new BrowserWindow')
  assert.ok(createdWindowIndex > 0)
  const reusePath = settingsWindowBlock[1].slice(0, createdWindowIndex)
  const createPath = settingsWindowBlock[1].slice(createdWindowIndex)

  assert.match(settingsWindowBlock[1], /show:\s*false/u)
  // 复用路径：窗口已经存在，先刷新 Dock 策略再走统一窗口级置前入口。
  assert.match(
    reusePath,
    /await refreshMacOSDockVisibility\(\)[\s\S]*?showOwnWindowForInteraction\(/u
  )
  // 新建路径：窗口仍处于 show:false，必须先显示再刷新 Dock 策略，
  // 否则 accessory/dock.hide() 会吞掉尚未上屏的首帧窗口。
  assert.match(
    createPath,
    /showOwnWindowForInteraction\(settingsWin,[\s\S]*?await refreshMacOSDockVisibility\(\)/u
  )
  for (const path of [reusePath, createPath]) {
    // 置前一律走统一入口，不得激活整个应用。
    assert.doesNotMatch(path, /app\.focus\(/u)
  }
  // 用户显式入口默认请求把设置页带到最前，内部 activate 才显式传 false 复用。
  assert.match(source, /async function openSettings\(options[\s\S]*?await createSettingsWindow\(options\.bringToFront \?\? true\)/u)
  const openSettingsBlock = source.match(
    /async function openSettings\([\s\S]*?\): Promise<void> \{([\s\S]*?)\n\}/u
  )
  assert.ok(openSettingsBlock)
  assert.doesNotMatch(openSettingsBlock[1], /app\.focus/u)
})

test('设置页关闭 Dock 图标后只恢复可见性，不得把设置页置前', () => {
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
    /await app\.dock\?\.hide\(\)[\s\S]*?settingsWin\s*===\s*settingsWindowToPreserve[\s\S]*?settingsWindowToPreserve\.showInactive\(\)/u
  )
  // Dock 切换会重排窗口层级，但这是内部刷新，不是用户显式打开设置页。
  // 只能恢复可见性，不得通过统一入口 moveTop()/focus() 把设置页拉到最前。
  assert.doesNotMatch(
    applyBlock,
    /showOwnWindowForInteraction\(settingsWindowToPreserve\)|settingsWindowToPreserve\.focus\(\)/u,
    'Dock 策略切换后的内部保留路径不得置前或聚焦设置页'
  )
})

test('启动首开设置页在 Dock 策略刷新后必须再次置前', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const settingsWindowBlock = source.match(
    /async function createSettingsWindow\([\s\S]*?\): Promise<BrowserWindow> \{([\s\S]*?)\n\}/u
  )

  assert.ok(settingsWindowBlock)
  const createPath = settingsWindowBlock[1].slice(
    settingsWindowBlock[1].indexOf('const createdWindow = new BrowserWindow')
  )
  const firstShowIndex = createPath.indexOf('showOwnWindowForInteraction(settingsWin,')
  const refreshIndex = createPath.indexOf('await refreshMacOSDockVisibility()', firstShowIndex)
  const finalShowIndex = createPath.indexOf('showOwnWindowForInteraction(settingsWin, { raiseLevel: true })', refreshIndex)

  assert.ok(firstShowIndex >= 0, '新建设置窗口必须先显示目标窗口')
  assert.ok(refreshIndex > firstShowIndex, '新建设置窗口显示后必须刷新 Dock 策略')
  assert.ok(
    finalShowIndex > refreshIndex,
    '启动首开在 Dock 策略刷新后必须再次通过统一入口置前，避免窗口被重新压到其它应用之后'
  )
})

test('首次创建设置窗口时不得在窗口显示前用 Dock 切换吞掉首屏', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const settingsWindowBlock = source.match(
    /async function createSettingsWindow\([\s\S]*?\): Promise<BrowserWindow> \{([\s\S]*?)\n\}/u
  )

  assert.ok(settingsWindowBlock)
  const createPath = settingsWindowBlock[1].slice(
    settingsWindowBlock[1].indexOf('const createdWindow = new BrowserWindow')
  )

  // 新建窗口在 show:false 状态下进入 createSettingsWindow；此时 settingsWin 已非空，
  // 若先 refreshMacOSDockVisibility() 触发 accessory/dock.hide()，窗口会被系统吞掉，
  // 后面的 show() 不足以保证启动设置页可见。必须先显示目标窗口，再刷新 Dock 呈现。
  const firstShowIndex = createPath.indexOf('showOwnWindowForInteraction(settingsWin,')
  const firstRefreshIndex = createPath.indexOf('await refreshMacOSDockVisibility()')
  assert.ok(firstShowIndex >= 0, '新建设置窗口必须调用统一显示入口')
  assert.ok(firstRefreshIndex >= 0, '新建设置窗口必须刷新 Dock 呈现')
  assert.ok(
    firstShowIndex < firstRefreshIndex,
    '新建设置窗口必须先 show 再刷新 Dock，避免窗口显示前被 Dock 切换隐藏'
  )
})
