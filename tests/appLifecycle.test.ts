import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  isMacOSDiskImageExecution,
  shouldOpenSettingsOnInitialLaunch
} from '../src/main/appLifecycle.ts'

test('macOS 磁盘镜像路径判断应只识别 Volumes 根目录下的可执行文件', () => {
  assert.equal(
    isMacOSDiskImageExecution('darwin', '/Volumes/划词翻译/划词翻译.app/Contents/MacOS/划词翻译'),
    true
  )
  assert.equal(
    isMacOSDiskImageExecution('darwin', '/Volumes/划词翻译 9/划词翻译.app/Contents/MacOS/划词翻译'),
    true
  )
  assert.equal(
    isMacOSDiskImageExecution('darwin', '/Applications/划词翻译.app/Contents/MacOS/划词翻译'),
    false
  )
  assert.equal(
    isMacOSDiskImageExecution('darwin', '/Users/test/Volumes/划词翻译.app/Contents/MacOS/划词翻译'),
    false
  )
  assert.equal(
    isMacOSDiskImageExecution('win32', '/Volumes/划词翻译/划词翻译.exe'),
    false
  )
})

test('首次启动设置窗口策略应在 macOS、Windows 和 Linux 打开设置', () => {
  assert.equal(shouldOpenSettingsOnInitialLaunch('darwin'), true)
  assert.equal(shouldOpenSettingsOnInitialLaunch('win32'), true)
  assert.equal(shouldOpenSettingsOnInitialLaunch('linux'), true)
})

test('主进程应在初始化全局监听前提示 DMG 启动风险，并由第二实例打开设置窗口', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const warningIndex = source.indexOf('await confirmMacOSInstalledApplicationLaunch()')
  const applyListenerIndex = source.indexOf('\n  applySelectionListener()\n')
  const initializationIndex = source.indexOf('const initialization = app.whenReady()')

  assert.match(source, /dialog\.showMessageBox/u)
  assert.match(source, /请先将“划词翻译”复制到“应用程序”文件夹/u)
  assert.ok(warningIndex >= 0 && warningIndex < applyListenerIndex)
  assert.match(
    source,
    /new SelectionListenerController\(\{[\s\S]*?start:\s*\(\)\s*=>\s*startAutoTrigger\(/u
  )
  assert.ok(initializationIndex >= 0)
  assert.doesNotMatch(source, /function showTrayMenu\(\): void/u)
  assert.match(
    source,
    /app\.on\('second-instance',[\s\S]*?initialization\.then\([\s\S]*?if \(!initialized\) return[\s\S]*?openSettings\(\)/u
  )
})

test('macOS 点击 Dock 图标时应优先恢复网页阅读器，没有可恢复页面才打开设置', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')

  assert.match(
    source,
    /function activateExistingPageOrOpenSettings\(\): void \{[\s\S]*?webReader\?\.focusExistingWindow\(\)[\s\S]*?openSettings\(\)/u
  )
  assert.match(
    source,
    /if \(isMac\) \{[\s\S]*?app\.on\('activate',[\s\S]*?initialization\.then\([\s\S]*?if \(!initialized\) return[\s\S]*?activateExistingPageOrOpenSettings\(\)/u
  )
})

test('划词交互期间的 activate 事件不应打开设置窗口', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')

  // activate 会在“译”按钮等自有窗口被激活时触发，不只是 Dock 点击。
  // 必须先判断是否为真正的 Dock 激活，否则划词过程中会突然弹出设置页并抢走原生选区。
  assert.match(source, /function shouldTreatActivateAsDockLaunch/u)
  const guardStart = source.indexOf('function shouldTreatActivateAsDockLaunch')
  const guardSource = source.slice(guardStart, source.indexOf('\n}', guardStart))
  // 选区按钮或翻译弹窗可见时属于划词交互，不能视为 Dock 激活
  assert.match(guardSource, /isSelectionButtonVisible\(\)/u)
  assert.match(guardSource, /isPopupVisible\(\)/u)
  assert.match(guardSource, /isOcrSelectionVisible\(\)/u)

  const activateStart = source.indexOf("app.on('activate'")
  const activateSource = source.slice(activateStart, source.indexOf('})', activateStart))
  assert.match(activateSource, /if\s*\(!shouldTreatActivateAsDockLaunch\(\)\)\s*return/u)
})

test('“译”按钮窗口不应因激活自身而抢走前台应用焦点', () => {
  const source = readFileSync('src/main/selectionButton.ts', 'utf8')

  // 按钮窗口必须保持不可聚焦并以 showInactive 显示，否则源应用选区会立即失效
  assert.match(source, /focusable:\s*false/u)
  assert.match(source, /win\.showInactive\(\)/u)
  assert.doesNotMatch(source, /win\.focus\(\)/u)
})
