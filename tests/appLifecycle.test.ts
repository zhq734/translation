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
  assert.match(source, /detail:\s*t\('dialog\.installFromDiskImage\.detail'\)/u)
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
    /function activateExistingPageOrOpenSettings\(\): void \{[\s\S]*?webReader\?\.focusOrOpenExistingWindow\(\)[\s\S]*?openSettings\(\)/u
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
  // hiservices 自动修复执行期间仍可能有内部 activate，不能当作 Dock 启动。
  assert.match(guardSource, /hiServicesRepairRunning/u)
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

test('Dock 激活时必须在任何早退分支前解除设置页划词焦点挂起', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const activateStart = source.indexOf('function activateExistingPageOrOpenSettings(): void {')
  const activateSource = source.slice(
    activateStart,
    source.indexOf('// ---- 主进程日志层 ----', activateStart)
  )

  // 用户现象：划词后点击 Dock 打开设置页，窗口闪一下便失焦，看起来像自动关闭。
  // 划词期间设置页会被 setFocusable(false) 挂起；Dock 是显式入口，必须最先强制
  // 解除挂起，不能被“阅读器已可见”的提前 return 绕过，否则设置页仍无法接收键盘焦点。
  const resumeIndex = activateSource.indexOf('resumeSettingsWindowFocusAfterSelection()')
  const webReaderIndex = activateSource.indexOf('webReader?.focusOrOpenExistingWindow()')
  assert.ok(resumeIndex >= 0, 'Dock 显式入口必须强制恢复设置页可聚焦性')
  assert.ok(
    webReaderIndex >= 0 && resumeIndex < webReaderIndex,
    '强制恢复必须早于阅读器复用分支，避免早退绕过'
  )
})

test('Dock 激活必须显式置前已有阅读器，并在设置页打开后补一次窗口级置前', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const activateStart = source.indexOf('function activateExistingPageOrOpenSettings(): void {')
  const activateSource = source.slice(
    activateStart,
    source.indexOf('// ---- 主进程日志层 ----', activateStart)
  )

  // Dock 点击是显式入口：已可见阅读器被其它应用遮挡时，仅返回 true 会让用户
  // 觉得“点击 Dock 没反应”；必须走 focusOrOpenExistingWindow() 真正置前。
  assert.match(
    activateSource,
    /webReader\?\.focusOrOpenExistingWindow\(\)/u,
    'Dock 激活已有阅读器时必须显式置前'
  )
  // Dock 点击的激活事件可能晚于第一次 show/focus 到达并覆盖焦点；设置页复用
  // 分支缺少新建分支的最终置前，需在打开完成后让出一轮事件循环再补一次。
  assert.match(
    activateSource,
    /openSettings\(\{ bringToFront: true \}\)[\s\S]*?yieldToEventLoop\(\)[\s\S]*?showOwnWindowForInteraction\(target,\s*\{\s*raiseLevel:\s*true\s*\}\)/u,
    'Dock 打开设置页后必须等待激活事件落定并再次窗口级置前'
  )
})
