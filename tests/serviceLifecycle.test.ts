import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

type PackageJson = {
  build?: {
    files?: string[]
    mac?: {
      extendInfo?: {
        LSUIElement?: boolean
      }
    }
  }
}

test('macOS 打包保持菜单栏应用模式，并在启动阶段按设置控制 Dock 图标', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson
  const mainSource = readFileSync('src/main/index.ts', 'utf8')
  const menuBarIndex = mainSource.indexOf('configureMacOSMenuBarApplication(false)')
  const warningIndex = mainSource.indexOf('await confirmMacOSInstalledApplicationLaunch()')
  const trayIndex = mainSource.indexOf('\n  createTray()\n')
  const proxyIndex = mainSource.indexOf('await applyTranslationProxy(')

  assert.equal(packageJson.build?.mac?.extendInfo?.LSUIElement, true)
  assert.ok(packageJson.build?.files?.includes('build/tray*.png'))
  assert.equal(existsSync('build/trayTemplate.png'), true)
  assert.equal(existsSync('build/trayTemplate@2x.png'), true)
  assert.match(mainSource, /shouldShowMacOSDockIcon\([\s\S]*?settingsOpen:[\s\S]*?webReaderOpen:/u)
  assert.match(mainSource, /app\.setActivationPolicy\('regular'\)/u)
  assert.match(mainSource, /app\.setActivationPolicy\('accessory'\)/u)
  assert.match(mainSource, /app\.dock\?\.show\(\)/u)
  assert.match(mainSource, /app\.dock\?\.hide\(\)/u)
  assert.match(mainSource, /Menu\.setApplicationMenu\(null\)/u)
  assert.match(mainSource, /configureMacOSMenuBarApplication\(getSettings\(\)\.showDockIcon\)/u)
  assert.ok(menuBarIndex >= 0 && menuBarIndex < warningIndex)
  assert.ok(trayIndex >= 0 && trayIndex < proxyIndex)
  assert.match(mainSource, /let tray: Tray \| null = null/u)
  assert.match(mainSource, /const filename = isMac \? 'trayTemplate\.png' : 'tray\.png'/u)
  assert.match(mainSource, /if \(icon\.isEmpty\(\)\)[\s\S]*?throw new Error/u)
  assert.match(mainSource, /if \(isMac\) icon\.setTemplateImage\(true\)/u)
  assert.doesNotMatch(mainSource, /tray\.setTitle\(/u)
  assert.match(mainSource, /tray\.setToolTip\('划词翻译'\)/u)
  assert.match(mainSource, /tray\.setContextMenu\(buildTrayMenu\(\)\)/u)
  assert.match(mainSource, /tray\.on\('click', \(\) => openSettings\(\)\)/u)
  assert.match(mainSource, /tray\.on\('double-click', \(\) => openSettings\(\)\)/u)
  assert.match(mainSource, /app\.whenReady\(\)[\s\S]*?\.catch\(handleApplicationInitializationFailure\)/u)
})

test('首次启动和第二实例都应打开设置窗口', () => {
  const mainSource = readFileSync('src/main/index.ts', 'utf8')
  const ipcIndex = mainSource.indexOf('\n  registerIpc()\n')
  const platformSettingsIndex = mainSource.indexOf(
    'if (shouldOpenSettingsOnInitialLaunch(process.platform)) openSettings()',
    ipcIndex
  )

  assert.match(mainSource, /function stopApplicationService\(\): void/u)
  assert.match(
    mainSource,
    /label:\s*'设置',[\s\S]*?click:\s*\(\)\s*=>\s*openSettings\(\)/u
  )
  assert.match(
    mainSource,
    /label:\s*'退出',[\s\S]*?click:\s*\(\)\s*=>\s*stopApplicationService\(\)/u
  )
  assert.ok(ipcIndex >= 0 && platformSettingsIndex > ipcIndex)
  assert.doesNotMatch(mainSource, /function showTrayMenu\(\): void/u)
  assert.match(
    mainSource,
    /app\.on\('second-instance',[\s\S]*?if \(!initialized\) return[\s\S]*?openSettings\(\)/u
  )
})

test('Windows 设置窗口应移除 Electron 默认菜单栏', () => {
  const mainSource = readFileSync('src/main/index.ts', 'utf8')
  const settingsWindowBlock = mainSource.match(
    /function createSettingsWindow\(\): BrowserWindow \{([\s\S]*?)\n\}/u
  )

  assert.ok(settingsWindowBlock)
  assert.match(
    settingsWindowBlock[1],
    /if \(process\.platform === 'win32'\) settingsWin\.removeMenu\(\)/u
  )
})

test('托盘菜单顶部应提供划词按钮快速开关并切换按钮与快捷键触发模式', () => {
  const mainSource = readFileSync('src/main/index.ts', 'utf8')
  const toggleLabel = "label: '划词后自动显示“译”按钮'"
  const toggleIndex = mainSource.indexOf(toggleLabel)
  const targetLanguageIndex = mainSource.indexOf("label: '目标语言'", toggleIndex)

  assert.ok(toggleIndex >= 0 && toggleIndex < targetLanguageIndex)
  assert.match(
    mainSource,
    /label:\s*'划词后自动显示“译”按钮',[\s\S]*?type:\s*'checkbox',[\s\S]*?checked:\s*settings\.triggerMode\s*===\s*'button',[\s\S]*?click:\s*\(menuItem\)\s*=>[\s\S]*?triggerMode:\s*menuItem\.checked\s*\?\s*'button'\s*:\s*'hotkey'/u
  )
})

test('macOS 托盘菜单应提供划词服务修复入口', () => {
  const mainSource = readFileSync('src/main/index.ts', 'utf8')

  assert.match(
    mainSource,
    /\.\.\.\(isMac\s*\?\s*\[\{[\s\S]*?label:\s*'修复 macOS 划词服务…',[\s\S]*?click:\s*\(\)\s*=>\s*promptHiServicesRepair\(\)[\s\S]*?\}\]\s*:\s*\[\]\)/u
  )
})

test('初始化失败和显式退出应关闭应用并清理全部全局资源', () => {
  const mainSource = readFileSync('src/main/index.ts', 'utf8')

  assert.match(
    mainSource,
    /function handleApplicationInitializationFailure\([\s\S]*?dialog\.showErrorBox\([\s\S]*?app\.quit\(\)/u
  )
  assert.match(mainSource, /stopApplicationService\(\)[\s\S]*?app\.quit\(\)/u)
  assert.match(
    mainSource,
    /function cleanupBeforeQuit\(\): void \{[\s\S]*?selectionListenerController\.stop\(\)[\s\S]*?globalShortcut\.unregisterAll\(\)[\s\S]*?tray\?\.destroy\(\)[\s\S]*?tray = null/u
  )
  const cleanupStart = mainSource.indexOf('function cleanupBeforeQuit')
  const cleanupSource = mainSource.slice(cleanupStart, mainSource.indexOf('\n}', cleanupStart))
  assert.doesNotMatch(cleanupSource, /stopAutoTrigger\(\)/u)
  assert.match(mainSource, /app\.on\('before-quit', cleanupBeforeQuit\)/u)
})

test('关闭设置窗口应只释放窗口引用，停止服务必须通过受限 IPC 显式请求', () => {
  const typesSource = readFileSync('src/shared/types.ts', 'utf8')
  const preloadSource = readFileSync('src/preload/index.ts', 'utf8')
  const mainSource = readFileSync('src/main/index.ts', 'utf8')
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const rendererSource = readFileSync('src/renderer/src/settings.ts', 'utf8')
  const css = readFileSync('src/renderer/src/settings.css', 'utf8')
  const closeHandler = mainSource.match(
    /settingsWin\.on\('closed', \(\) => \{([\s\S]*?)\n  \}\)/u
  )

  assert.ok(closeHandler)
  assert.match(closeHandler[1], /settingsWin = null/u)
  assert.doesNotMatch(closeHandler[1], /(?:app\.quit|stopApplicationService)\(\)/u)
  assert.match(typesSource, /stopService\(\): void/u)
  assert.match(preloadSource, /stopService\(\)[\s\S]*?ipcRenderer\.send\('settings:stop-service'\)/u)
  assert.match(mainSource, /ipcMain\.on\('settings:stop-service',[\s\S]*?stopApplicationService\(\)/u)
  assert.match(html, /id="stop-service"[^>]*>关闭并停止服务<\/button>/u)
  assert.match(rendererSource, /window\.confirm\([\s\S]*?window\.api\.stopService\(\)/u)
  assert.match(css, /\.btn\.danger[\s\S]*?var\(--status-error\)/u)
})
