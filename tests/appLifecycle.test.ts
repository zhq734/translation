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

  const activateSource = extractActivateCallback(source)
  assert.match(
    activateSource,
    /if\s*\(!shouldTreatActivateAsDockLaunch\(\{[\s\S]*?\}\)\)\s*return/u,
    'activate 回调必须携带同步指纹调用判定函数'
  )
})

test('“译”按钮窗口不应因激活自身而抢走前台应用焦点', () => {
  const source = readFileSync('src/main/selectionButton.ts', 'utf8')

  // 按钮窗口必须保持不可聚焦并以 showInactive 显示，否则源应用选区会立即失效
  assert.match(source, /focusable:\s*false/u)
  assert.match(source, /win\.showInactive\(\)/u)
  assert.doesNotMatch(source, /win\.focus\(\)/u)
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

/**
 * 从主进程源码中截取 macOS activate 事件回调。
 * @param source 主进程源码。
 * @returns activate 回调源码片段。
 * @author zhenghq
 */
function extractActivateCallback(source: string): string {
  const start = source.indexOf("app.on('activate'")
  assert.ok(start >= 0, '应注册 macOS activate 事件')
  const end = source.indexOf('\n  }\n}', start)
  assert.ok(end > start, 'activate 回调应有结束边界')
  return source.slice(start, end)
}

test('activate 回调必须在任何异步边界之前采集同步调用栈与毫秒时间戳', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const callbackSource = extractActivateCallback(source)

  // 调用栈一旦延迟到 await/then 之后采集，就只剩事件循环帧，无法指认派发者。
  const stackIndex = callbackSource.indexOf('captureSyncStack(')
  const timestampIndex = callbackSource.indexOf('Date.now()')
  const asyncIndex = callbackSource.indexOf('initialization.then(')

  assert.ok(stackIndex >= 0, 'activate 回调必须采集同步调用栈')
  assert.ok(timestampIndex >= 0, 'activate 回调必须采集毫秒时间戳')
  assert.ok(asyncIndex >= 0, 'activate 回调仍应等待初始化完成')
  assert.ok(stackIndex < asyncIndex, '调用栈必须在进入异步边界之前采集')
  assert.ok(timestampIndex < asyncIndex, '时间戳必须在进入异步边界之前采集')
})

test('activate 放行与拦截分支都必须输出含判定、原因与调用栈的取证日志', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const guardStart = source.indexOf('function shouldTreatActivateAsDockLaunch')
  assert.ok(guardStart >= 0, '应存在 activate 判定函数')
  const guardSource = source.slice(guardStart, source.indexOf('\n}', guardStart))

  // 两类判定都要留痕：放行分支此前只有 checks，拦截分支此前没有派发者信息。
  assert.match(guardSource, /decision\.allowed\s*\?\s*'allow'\s*:\s*'ignore'/u,
    '取证记录必须按判定结果写入 allow 或 ignore')
  assert.match(guardSource, /reason:/u, '拦截分支必须记录拦截原因')
  assert.match(guardSource, /stack:\s*probe\.stack/u, '两条分支都必须记录同步调用栈')
  assert.match(guardSource, /hasVisibleWindows/u, '必须记录白名单事件字段')
})
