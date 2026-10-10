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
  const end = source.indexOf('\n}', start)
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

test('设置窗口与翻译弹窗在 macOS 上都是 nonactivating panel', () => {
  const createSource = extractFunction(mainSource, 'async function createSettingsWindow(')
  const popupCreateSource = extractFunction(popupSource, 'export function createPopup(')

  // panel 的 show()/focus() 只让目标窗口自身成为 key window，不激活整个应用；
  // 这是消除「打开一个窗口把同应用其它窗口一起带到最前」闪现的根因修复。
  assert.match(createSource, /isMac\s*\?\s*\{\s*type:\s*'panel'\s*\}/u)
  assert.match(popupCreateSource, /process\.platform\s*===\s*'darwin'\s*\?\s*\{\s*type:\s*'panel'\s*\}/u)
})

test('设置窗口只保留最小焦点挂起机制，复杂补偿链必须删除', () => {
  const code = stripComments(mainSource)

  // 真机验证表明 nonactivating panel 只阻止激活整个应用，并不能阻止系统在
  // 应用内部把可聚焦的设置页选为 key window。因此必须保留最小焦点挂起机制：
  // 划词期间关闭设置页可聚焦性，结果弹窗隐藏后再恢复。以下为上一版补偿性
  // 实现遗留的定时器、代际号与显式打开标记，必须继续删除，避免与新机制竞态。
  for (const removed of [
    'settingsWindowExplicitlyOpened',
    'settingsWindowFocusResumeTimer',
    'clearSettingsWindowFocusResume',
    'finishSettingsWindowFocusSuspension',
    'scheduleSettingsWindowFocusResume',
    'logSettingsWindowFocusDiagnostic',
    'SETTINGS_WINDOW_FOCUS_RESUME_FALLBACK_MS'
  ]) {
    assert.ok(!code.includes(removed), `index.ts 不应再包含 ${removed}`)
  }
  assert.match(code, /function suspendSettingsWindowFocusForSelection\(/u,
    '划词期间必须提供设置页焦点挂起入口')
  assert.match(code, /function resumeSettingsWindowFocusAfterSelection\(/u,
    '交互收尾或显式打开设置页时必须提供恢复入口')
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

test('取词流程必须挂起设置窗口可聚焦性，但不得恢复内部激活租约', () => {
  const translateSource = stripComments(
    extractFunction(mainSource, 'async function translateSelectionButton(')
  )

  assert.match(translateSource, /suspendSettingsWindowFocusForSelection\(interactionToken\)/u,
    '按钮取词开始前必须挂起设置页焦点，避免其被选为 key window')
  assert.doesNotMatch(translateSource, /renewInternalActivationLease/u)
  assert.doesNotMatch(translateSource, /waitForFrontmostAppReturn/u)
  assert.doesNotMatch(translateSource, /restoreFrontmostAppForCapture/u)
  // 释放交互状态不再需要等弹窗隐藏收尾。
  assert.doesNotMatch(translateSource, /pendingPopupReleaseToken/u)
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

test('翻译弹窗隐藏必须直接隐藏，不得再交还前台或隐藏整个应用', () => {
  const hideSource = stripComments(extractFunction(popupSource, 'export function hidePopup(): void {'))

  assert.match(hideSource, /win\.hide\(\)/u, '隐藏弹窗必须直接调用 win.hide()')
  assert.doesNotMatch(hideSource, /handBackFrontmostThen|yieldFrontmostAppThen|app\.hide\(\)/u,
    'panel 落地后隐藏弹窗不得走前台交还或整应用隐藏')
  assert.doesNotMatch(hideSource, /hidingAfterFrontReturn|beginInternalWindowTeardown/u,
    '隐藏弹窗不得再维护前台交还收尾状态')
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

test('设置窗口创建与复用路径不得激活整个应用', () => {
  const createSource = stripComments(
    extractFunction(mainSource, 'async function createSettingsWindow(')
  )

  assert.doesNotMatch(createSource, /app\.focus\(/u, '创建/复用设置窗口不得激活整个应用')
  assert.match(createSource, /showOwnWindowForInteraction\(/u, '设置窗口必须走统一窗口级置前入口')
})
