import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const indexSource = readFileSync('src/main/index.ts', 'utf8')
const popupSource = readFileSync('src/main/popup.ts', 'utf8')
const macForegroundSource = readFileSync('src/main/macForeground.ts', 'utf8')
const popupForegroundSource = readFileSync('src/shared/popupForeground.ts', 'utf8')
const selectionInteractionSource = readFileSync('src/shared/selectionInteraction.ts', 'utf8')

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

test('设置窗口与翻译弹窗在 macOS 上都是 nonactivating panel', () => {
  const createSource = extractFunction(indexSource, 'async function createSettingsWindow(')
  const popupCreateSource = extractFunction(popupSource, 'export function createPopup(')

  assert.match(createSource, /isMac\s*\?\s*\{\s*type:\s*'panel'\s*\}/u)
  assert.match(popupCreateSource, /process\.platform\s*===\s*'darwin'\s*\?\s*\{\s*type:\s*'panel'\s*\}/u)
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

test('设置窗口焦点挂起与恢复补偿机制必须整体删除', () => {
  const code = stripComments(indexSource)

  for (const removed of [
    'settingsWindowFocusSuspendedForSelection',
    'settingsWindowExplicitlyOpened',
    'settingsWindowFocusSuspensionOwnerToken',
    'settingsWindowFocusResumeTimer',
    'suspendSettingsWindowFocusForSelection',
    'resumeSettingsWindowFocusAfterSelection',
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
