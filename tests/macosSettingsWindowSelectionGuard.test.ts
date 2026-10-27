import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * 从源码中截取指定函数的函数体。
 * @param source 源码。
 * @param signature 函数签名起始片段。
 * @returns 从签名到函数结束的源码片段。
 * @author zhenghq
 */
function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `应存在函数 ${signature}`)
  // 顶格闭合花括号才能代表函数结束，避免嵌套块被误判为结束边界。
  const end = source.indexOf('\n}\n', start)
  assert.ok(end > start, `函数 ${signature} 应有结束边界`)
  return source.slice(start, end)
}

/**
 * 去掉源码中的块注释与行注释，避免注释里的历史函数名干扰断言。
 * @param source 源码。
 * @returns 移除注释后的源码。
 * @author zhenghq
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

const mainSource = readFileSync('src/main/index.ts', 'utf8')
const popupSource = readFileSync('src/main/popup.ts', 'utf8')
const macSource = readFileSync('src/main/macForeground.ts', 'utf8')

test('设置窗口保持普通窗口，翻译弹窗保留 nonactivating panel', () => {
  const createSource = extractFunction(mainSource, 'async function createSettingsWindow(')
  const popupCreateSource = extractFunction(popupSource, 'export function createPopup(')

  // 设置窗口曾尝试用 panel 避免激活整个应用，但 Electron 33 的 ElectronNSPanel
  // 强制 CanJoinAllSpaces，导致设置页跑到所有桌面。设置窗口必须改回普通窗口；
  // 翻译弹窗仍需要跨桌面的浮层语义，因此保留 panel。
  assert.doesNotMatch(createSource, /type:\s*'panel'/u)
  assert.match(popupCreateSource, /process\.platform\s*===\s*'darwin'\s*\?\s*\{\s*type:\s*'panel'\s*\}/u)
})

test('划词焦点挂起与恢复机制必须整体移除', () => {
  const code = stripComments(mainSource)

  // setFocusable(false) 会让 macOS 的 BrowserWindow.getFocusedWindow() 返回 null，
  // 弹窗隐藏时会把场景误判为需要整应用让出并触发 app.hide()，用户表现为从 Dock
  // 打开设置页后窗口闪一下消失。该机制已被真机证明无效且有害，必须彻底删除。
  for (const removed of [
    'settingsWindowFocusSuspendedForSelection',
    'settingsWindowFocusResumePending',
    'settingsWindowFocusResumePendingOwnerToken',
    'settingsWindowFocusSuspensionOwnerToken',
    'webReaderFocusResumePending',
    'webReaderFocusResumePendingOwnerToken',
    'webReaderFocusSuspensionOwnerToken',
    'suspendSettingsWindowFocusForSelection',
    'resumeSettingsWindowFocusAfterSelection'
  ]) {
    assert.ok(!code.includes(removed), `index.ts 不应再包含 ${removed}`)
  }
  assert.doesNotMatch(code, /\.setFocusable\(/u, 'index.ts 不得再通过 setFocusable 挂起自有窗口')
})

test('内部激活租约与延迟释放补偿必须整体删除', () => {
  const code = stripComments(mainSource)

  for (const removed of [
    'internalActivationLeaseUntil',
    'renewInternalActivationLease',
    'releaseSelectionInteractionAfterPopupHidden',
    'pendingPopupReleaseToken',
    'INTERNAL_ACTIVATION_LEASE_MS',
    'POPUP_RELEASE_FALLBACK_MS'
  ]) {
    assert.ok(!code.includes(removed), `index.ts 不应再包含 ${removed}`)
  }
})

test('取词流程不得再挂起设置窗口或阅读器焦点', () => {
  const translateSource = stripComments(
    extractFunction(mainSource, 'async function translateSelectionButton(')
  )

  assert.doesNotMatch(translateSource, /suspendSettingsWindowFocusForSelection/u,
    '按钮取词不得再挂起设置页焦点')
  assert.doesNotMatch(translateSource, /setFocusable\(/u,
    '按钮取词不得再直接切换窗口可聚焦性')
  assert.doesNotMatch(translateSource, /renewInternalActivationLease/u)
  assert.doesNotMatch(translateSource, /waitForFrontmostAppReturn/u)
  assert.doesNotMatch(translateSource, /restoreFrontmostAppForCapture/u)
  assert.doesNotMatch(translateSource, /pendingPopupReleaseToken/u)
})

test('快捷键自动取词与自动模式划词也不得挂起窗口焦点', () => {
  const hotkeySource = stripComments(
    extractFunction(mainSource, 'function onHotkey(): void {')
  )
  const scheduleSource = stripComments(
    extractFunction(mainSource, 'function scheduleSelectionAction(')
  )

  // 阅读器与设置页都已是 nonactivating panel，不再需要任何焦点挂起补偿。
  assert.doesNotMatch(hotkeySource, /suspendSettingsWindowFocusForSelection|setFocusable\(/u,
    '快捷键取词不得挂起自有窗口焦点')
  assert.doesNotMatch(scheduleSource, /suspendSettingsWindowFocusForSelection|setFocusable\(/u,
    '自动模式划词不得挂起自有窗口焦点')
})

test('快捷键延迟取词必须在启动旧流程前校验交互 token', () => {
  const hotkeySource = stripComments(
    extractFunction(mainSource, 'function onHotkey(): void {')
  )
  const timeoutStart = hotkeySource.indexOf('setTimeout(')
  const timeoutEnd = hotkeySource.indexOf('captureDelay', timeoutStart)

  // Windows 快捷键取词会先等待 300ms 释放修饰键。等待期间用户可能复制/粘贴、
  // 切换触发模式或开始新一轮划词，旧定时器若仍进入 queueSelectionTranslation()，
  // 会在 token 校验前启动一次取词并干扰新流程。回调必须先确认本次 token 仍是
  // 当前交互，再启动取词。
  assert.ok(timeoutStart >= 0, '快捷键应保留延迟取词定时器')
  assert.ok(timeoutEnd > timeoutStart, '延迟取词定时器应使用 captureDelay')
  const delayedCaptureSource = hotkeySource.slice(timeoutStart, timeoutEnd)
  const currentCheckIndex = delayedCaptureSource.indexOf(
    'selectionInteraction.isCurrent(interactionToken)'
  )
  const queueIndex = delayedCaptureSource.indexOf(
    'queueSelectionTranslation(undefined, interactionToken, true, popupCloseVersion)'
  )
  assert.ok(currentCheckIndex >= 0, '延迟回调必须校验本次交互 token 是否仍有效')
  assert.ok(queueIndex > currentCheckIndex, 'token 校验必须位于延迟取词启动之前')
})

test('macOS 前台交还模块不得再导出补偿性 API', () => {
  const code = stripComments(macSource)

  for (const removed of [
    'isMacAppActive(',
    'isFrontmostAppSelf(',
    'wasFrontmostAppSelf(',
    'isFrontmostHandBackInFlight(',
    'whenFrontmostHandBackSettled(',
    'beginInternalWindowTeardown(',
    'endInternalWindowTeardown(',
    'isInternalWindowTeardownActive(',
    'rememberFrontmostAppBeforeActivation(',
    'refreshFrontmostAppForSelection(',
    'rememberFrontmostAppIfInactive(',
    'restoreFrontmostAppForCapture(',
    'waitForFrontmostAppReturn('
  ]) {
    assert.ok(!code.includes(removed), `macForeground.ts 不应再包含 ${removed}`)
  }
})

test('翻译弹窗隐藏必须交还前台后再隐藏，且不得隐藏整个应用', () => {
  const hideSource = stripComments(
    extractFunction(popupSource, 'export function hidePopup(')
  )

  assert.match(hideSource, /win\?\.hide\(\)/u, '隐藏弹窗必须最终调用 win.hide()')
  assert.match(hideSource, /handBackFrontmostThen\(/u,
    '结果弹窗隐藏前必须复用共享前台交还链路')
  assert.doesNotMatch(hideSource, /yieldFrontmostAppThen|app\.hide\(\)/u,
    '隐藏弹窗不得直接隐藏整个应用')
  assert.doesNotMatch(hideSource, /hidingAfterFrontReturn|beginInternalWindowTeardown/u,
    '隐藏弹窗不得再维护前台交还收尾状态')
})

test('安全让出前台恢复应用后必须保持原本隐藏窗口的隐藏状态', () => {
  const yieldSource = stripComments(
    extractFunction(macSource, 'function yieldFrontmostApp(')
  )

  // app.hide() 会隐藏整个应用，app.show() 又会恢复应用内窗口。若不在隐藏前记录
  // 每个窗口的可见性，原本关闭的弹窗或后台窗口会被重新显示；设置页也可能因此
  // 重新出现在用户当前应用之上。恢复后必须只保留隐藏前已经可见的窗口。
  const snapshotIndex = yieldSource.indexOf('BrowserWindow.getAllWindows()')
  // 注释里也会出现 app.hide()/app.show() 文本，必须从实际调用点开始定位。
  const hideIndex = yieldSource.indexOf('\n    app.hide()', snapshotIndex)
  const showIndex = yieldSource.indexOf('\n      app.show()', snapshotIndex)
  const restoreIndex = yieldSource.indexOf('!snapshot.wasVisible', showIndex)

  assert.ok(snapshotIndex >= 0, '安全让出前必须采集自有窗口可见性快照')
  assert.ok(hideIndex > snapshotIndex, '必须先采集可见性再隐藏应用')
  assert.ok(showIndex > snapshotIndex, '等待失活后仍需恢复应用可见性')
  assert.ok(restoreIndex > showIndex, 'app.show() 后必须恢复隐藏窗口的原状态')
  assert.match(
    yieldSource,
    /if \(!snapshot\.wasVisible[\s\S]*?snapshot\.window\.hide\(\)/u,
    '原本隐藏的窗口不得因 app.show() 被重新显示'
  )
  assert.doesNotMatch(
    yieldSource,
    /\.showInactive\(\)|\.focus\(\)|\.moveTop\(\)/u,
    '安全让出必须依赖 app.show() 整体恢复，不得逐窗口置前'
  )
})

test('共享前台策略只保留 Windows 语义', () => {
  const code = stripComments(readFileSync('src/shared/popupForeground.ts', 'utf8'))

  assert.doesNotMatch(code, /POPUP_RESULT_ACTIVATION_SETTLE_MS/u)
  assert.doesNotMatch(code, /POPUP_RESULT_ACTIVATION_REFOCUS_DELAY_MS/u)
  assert.doesNotMatch(code, /shouldDeactivatePopupBeforeMacCapture/u)
  assert.match(code, /shouldRestoreForegroundBeforeCapture/u)
})

test('Dock 呈现切换等内部刷新不得置前或聚焦设置窗口', () => {
  const applySource = extractFunction(mainSource, 'async function applyMacOSDockVisibility(')

  // 切换激活策略会重排窗口层级。内部刷新可能在交互状态短暂回到 idle 时触发，
  // 因此只能恢复可见性，任何 showOwnWindowForInteraction()/focus()/moveTop()
  // 都可能把设置页越过用户当前应用和翻译弹窗拉到最前。
  assert.match(
    applySource,
    /settingsWindowToPreserve\.showInactive\(\)/u,
    '内部刷新必须用非激活方式恢复设置窗口可见性'
  )
  assert.doesNotMatch(
    stripComments(applySource),
    /showOwnWindowForInteraction\(settingsWindowToPreserve\)|settingsWindowToPreserve\.focus\(\)/u,
    '内部刷新不得置前或聚焦被保留的设置窗口'
  )
})

test('窗口级置前入口不得激活整个应用', () => {
  const helperSource = stripComments(
    extractFunction(mainSource, 'function showOwnWindowForInteraction(')
  )

  // macOS 上窗口层级单位是应用：app.focus() 会把同应用所有可见窗口一起提到最前。
  // 设置窗口改为 nonactivating panel 后，只允许提升目标窗口自身。
  assert.doesNotMatch(helperSource, /app\.focus\(/u, '统一置前入口不得调用 app.focus')
  assert.match(helperSource, /win\.show\(\)/u, '统一置前入口必须显示目标窗口自身')
  assert.match(helperSource, /win\.focus\(\)/u, '统一置前入口必须让目标窗口取得键盘焦点')
})

test('设置窗口创建与复用路径不得激活整个应用或恢复焦点挂起', () => {
  const createSource = stripComments(
    extractFunction(mainSource, 'async function createSettingsWindow(')
  )

  assert.doesNotMatch(createSource, /app\.focus\(/u, '创建/复用设置窗口不得激活整个应用')
  assert.doesNotMatch(createSource, /resumeSettingsWindowFocusAfterSelection|setFocusable\(/u,
    '创建/复用设置窗口不得依赖已删除的焦点恢复机制')
  assert.match(createSource, /showOwnWindowForInteraction\(/u, '设置窗口必须走统一窗口级置前入口')
})

test('Dock 激活路径不得依赖焦点恢复入口', () => {
  const activateSource = stripComments(
    extractFunction(mainSource, 'function activateExistingPageOrOpenSettings(): void {')
  )

  // Dock 是显式用户入口，只需复用并置前已有阅读器或打开设置页；焦点挂起机制
  // 删除后，路径中不得再残留任何恢复调用，避免继续触发 app.hide() 类回归。
  assert.doesNotMatch(activateSource, /resumeSettingsWindowFocusAfterSelection|setFocusable\(/u,
    'Dock 激活路径不得依赖已删除的焦点恢复机制')
  // 已可见且未最小化的阅读器只走 focusExistingWindow()：即便内部 activate 被
  // 误放行，也只返回 true、不重新 show()+focus()，不会把后台阅读器顶到最前。
  assert.match(activateSource, /webReader\?\.focusExistingWindow\(\)/u,
    'Dock 激活已有阅读器时必须走不会强制置前的恢复入口')
  assert.match(activateSource, /openSettings\(\{ bringToFront: true \}\)/u,
    '没有阅读器时 Dock 激活必须置前设置页')
})

test('activate 复用已可见且未最小化的设置页时不得再次强制置前', () => {
  const activateSource = stripComments(
    extractFunction(mainSource, 'function activateExistingPageOrOpenSettings(): void {')
  )

  // 真机日志：6 次 activate 放行全部触发 settings-reuse-raise，且 6 次设置页都已
  // 可见。设置页分支此前与阅读器分支不对称——阅读器用 focusExistingWindow() 对
  // 已可见窗口只返回 true、不重新 show()+focus()，而设置页却对已可见窗口执行
  // show()+moveTop()+focus()，把后台设置页重新顶到划词应用之上。
  // 修复后：已可见且未最小化时，activate 路径必须先短路返回，不得走到强制置前。
  const visibleGuardIndex = activateSource.indexOf('isVisible()')
  const openSettingsIndex = activateSource.indexOf('openSettings(')
  assert.ok(visibleGuardIndex >= 0, 'activate 路径必须显式判断设置页是否已可见')
  assert.ok(
    visibleGuardIndex < openSettingsIndex,
    '已可见设置页短路必须发生在 openSettings() 置前之前'
  )
})
