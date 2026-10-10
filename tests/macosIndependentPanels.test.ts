import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const indexSource = readFileSync('src/main/index.ts', 'utf8')
const popupSource = readFileSync('src/main/popup.ts', 'utf8')
const macForegroundSource = readFileSync('src/main/macForeground.ts', 'utf8')
const popupForegroundSource = readFileSync('src/shared/popupForeground.ts', 'utf8')
const selectionInteractionSource = readFileSync('src/shared/selectionInteraction.ts', 'utf8')
const selectionButtonSource = readFileSync('src/main/selectionButton.ts', 'utf8')

/**
 * 截取源码中指定函数的完整片段。
 * @param source 待检索源码。
 * @param signature 函数签名起始片段。
 * @returns 从签名到函数结束的源码。
 * @author zhenghq
 */
function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `应存在函数 ${signature}`)
  const end = source.indexOf('\n}', start)
  assert.ok(end > start, `函数 ${signature} 应有结束边界`)
  return source.slice(start, end + 2)
}

/**
 * 去掉源码注释，避免注释里的历史函数名干扰“不得调用”断言。
 * @param source 源码。
 * @returns 移除注释后的源码。
 * @author zhenghq
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

test('内部窗口置前路径不得调用应用级 app.focus', () => {
  const createSource = stripComments(extractFunction(indexSource, 'async function createSettingsWindow('))
  const helperSource = stripComments(
    extractFunction(indexSource, 'function showOwnWindowForInteraction(')
  )

  // macOS 上窗口层级单位是应用：app.focus() 会把同应用所有可见窗口一起提到最前。
  // 设置窗口改为 nonactivating panel 后，只允许提升目标窗口自身。
  assert.doesNotMatch(createSource, /app\.focus\(/u, '创建/复用设置窗口不得激活整个应用')
  assert.match(createSource, /showOwnWindowForInteraction\(/u, '设置窗口必须走统一窗口级置前入口')
  assert.doesNotMatch(helperSource, /app\.focus\(/u, '统一置前入口不得调用 app.focus')
})

test('统一窗口级置前入口必须用 moveTop 越过其它应用窗口', () => {
  const helperSource = stripComments(
    extractFunction(indexSource, 'function showOwnWindowForInteraction(')
  )

  // nonactivating panel 的 show()/focus() 不会激活应用；启动首开或用户显式打开时，
  // 目标窗口可能仍排在当前前台应用之后。moveTop() 只调整目标窗口自身 z-order，
  // 不激活应用、不改变同应用其它窗口层级，正好补齐该语义。
  const showIndex = helperSource.indexOf('win.show()')
  const moveTopIndex = helperSource.indexOf('win.moveTop()')
  const focusIndex = helperSource.indexOf('win.focus()')
  assert.ok(showIndex >= 0, '统一置前入口必须先显示目标窗口')
  assert.ok(moveTopIndex > showIndex, '显示目标窗口后必须用 moveTop 将其提到 z-order 最前')
  assert.ok(focusIndex > moveTopIndex, '目标窗口置前后必须获得键盘焦点')
  assert.match(
    helperSource,
    /const moveTop = options\.moveTop \?\? true/u,
    '统一入口必须允许内部 activate 新建窗口时关闭 moveTop'
  )
})

test('设置窗口与翻译弹窗在 macOS 上都是 nonactivating panel', () => {
  const createSource = extractFunction(indexSource, 'async function createSettingsWindow(')
  const popupCreateSource = extractFunction(popupSource, 'export function createPopup(')

  assert.match(createSource, /isMac\s*\?\s*\{\s*type:\s*'panel'\s*\}/u)
  assert.match(popupCreateSource, /process\.platform\s*===\s*'darwin'\s*\?\s*\{\s*type:\s*'panel'\s*\}/u)
})

test('选区“译”按钮在 macOS 上必须是非激活 panel，点击不得激活应用', () => {
  const createSource = extractFunction(
    selectionButtonSource,
    'export function createSelectionButton('
  )

  // “译”按钮是划词取词的入口。若它是普通窗口，点击会让本应用短暂成为最前应用，
  // macOS 随即把同应用内可聚焦的可见设置页提升为 key window 并带到最前。
  // 设置页与翻译弹窗已改为 nonactivating panel，按钮也必须使用同一语义，
  // 否则 Phase 2 删除设置窗口焦点挂起机制后，该回归会再次出现。
  assert.match(
    createSource,
    /process\.platform\s*===\s*'darwin'\s*\?\s*\{\s*type:\s*'panel'\s*\}/u,
    'macOS 选区“译”按钮必须使用 nonactivating panel'
  )
})

test('点击可见设置页或阅读器区域不得关闭翻译弹窗', () => {
  const pointerSource = stripComments(
    extractFunction(indexSource, 'function handleSelectionPointerDown(')
  )
  const internalHitIndex = pointerSource.indexOf('isPointInsideVisibleSettingsWindow(point)')
  assert.ok(internalHitIndex >= 0, '全局按下必须识别可见设置页矩形')

  const branchStart = pointerSource.indexOf(
    'if (isPopupVisible() && isPointInsideVisibleSettingsWindow(point))'
  )
  if (branchStart >= 0) {
    const branchEnd = pointerSource.indexOf('\n    }', branchStart)
    const branch = pointerSource.slice(branchStart, branchEnd)
    assert.doesNotMatch(branch, /hidePopup|hidePopupForInternalWindowSwitch/u,
      '点击应用内设置页不属于外部点击，不得关闭翻译弹窗')
  }
  // 阅读器同样必须只忽略本次按下。
  const readerBranchStart = pointerSource.indexOf(
    'if (isPopupVisible() && isPointInsideVisibleWebReaderWindow(point))'
  )
  if (readerBranchStart >= 0) {
    const readerBranchEnd = pointerSource.indexOf('\n    }', readerBranchStart)
    const readerBranch = pointerSource.slice(readerBranchStart, readerBranchEnd)
    assert.doesNotMatch(readerBranch, /hidePopup|hidePopupForInternalWindowSwitch/u,
      '点击应用内阅读器不属于外部点击，不得关闭翻译弹窗')
  }
  assert.match(pointerSource, /dismissPopupOnExternalPointerDown\(point\)/u,
    '真正的外部点击必须走全局按下兜底入口')
})

test('翻译弹窗隐藏必须直接隐藏，不得再交还前台或隐藏整个应用', () => {
  const hideSource = stripComments(extractFunction(popupSource, 'export function hidePopup(): void {'))

  assert.match(hideSource, /win\.hide\(\)/u, '隐藏弹窗必须直接调用 win.hide()')
  assert.doesNotMatch(hideSource, /handBackFrontmostThen|yieldFrontmostAppThen|app\.hide\(\)/u,
    'panel 落地后隐藏弹窗不得走前台交还或整应用隐藏')
  assert.doesNotMatch(hideSource, /hidingAfterFrontReturn|beginInternalWindowTeardown/u,
    '隐藏弹窗不得再维护前台交还收尾状态')
})

test('翻译弹窗不得再维护补偿性前台交还状态', () => {
  const code = stripComments(popupSource)

  for (const removed of [
    'hidingAfterFrontReturn',
    'restoringForegroundUntil = Date.now()',
    'resultActivationSettleUntil',
    'resultActivationBlurAbsorbed',
    'captureForegroundRestoreActive',
    'beginInternalWindowTeardown',
    'endInternalWindowTeardown',
    'handBackFrontmostThen',
    'yieldFrontmostAppThen',
    'isPopupHandingBackFront'
  ]) {
    assert.ok(!code.includes(removed), `popup.ts 不应再包含 ${removed}`)
  }
})

test('macOS 前台交还模块不得再导出补偿性 API', () => {
  const code = stripComments(macForegroundSource)

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
  // OCR/阅读器/原生对话框仍需保留非补偿链路。
  assert.match(code, /export function handBackFrontmostThen\(/u)
  assert.match(code, /export function handBackFrontmostApp\(/u)
  assert.match(code, /export function isMacAppActiveByEvents\(/u)
})

test('设置窗口只保留最小焦点挂起机制，复杂补偿链必须删除', () => {
  const code = stripComments(indexSource)

  // nonactivating panel 无法阻止系统在应用内部把可聚焦的设置页选为 key window，
  // 因此最小焦点挂起机制必须保留；上一版为补偿应用级激活而引入的显式打开标记、
  // 代际号、延迟恢复定时器与内部激活租约仍必须删除，避免与新机制竞态。
  for (const removed of [
    'settingsWindowExplicitlyOpened',
    'settingsWindowFocusResumeTimer',
    'clearSettingsWindowFocusResume',
    'finishSettingsWindowFocusSuspension',
    'scheduleSettingsWindowFocusResume',
    'internalActivationLeaseUntil',
    'renewInternalActivationLease',
    'releaseSelectionInteractionAfterPopupHidden',
    'pendingPopupReleaseToken'
  ]) {
    assert.ok(!code.includes(removed), `index.ts 不应再包含 ${removed}`)
  }
})

test('Dock 激活判定不得再依赖内部激活租约等补偿条件', () => {
  const guardSource = stripComments(
    extractFunction(indexSource, 'function shouldTreatActivateAsDockLaunch(): boolean {')
  )
  assert.doesNotMatch(guardSource, /internalActivationLease|internalWindowTeardown|popupHandingBackFront/u)
  assert.doesNotMatch(selectionInteractionSource, /internalActivationLeaseUntil/u)
  assert.doesNotMatch(selectionInteractionSource, /popupHandingBackFront/u)
  assert.doesNotMatch(selectionInteractionSource, /internalWindowTeardown/u)
})

test('共享前台策略只保留 Windows 语义', () => {
  const code = stripComments(popupForegroundSource)
  assert.doesNotMatch(code, /POPUP_RESULT_ACTIVATION_SETTLE_MS/u)
  assert.doesNotMatch(code, /POPUP_RESULT_ACTIVATION_REFOCUS_DELAY_MS/u)
  assert.doesNotMatch(code, /shouldDeactivatePopupBeforeMacCapture/u)
  assert.match(code, /shouldRestoreForegroundBeforeCapture/u)
})
