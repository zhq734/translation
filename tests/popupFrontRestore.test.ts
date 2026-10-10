import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { shouldActivatePopupForCaptureFailure } from '../src/shared/popupForeground.ts'

const popupSource = readFileSync('src/main/popup.ts', 'utf8')
const mainSource = readFileSync('src/main/index.ts', 'utf8')
const macForegroundSource = readFileSync('src/main/macForeground.ts', 'utf8')

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
 * 去掉源码中的块注释与行注释，避免注释文本干扰行为断言。
 * @param source 源码。
 * @returns 移除注释后的源码。
 * @author zhenghq
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

/**
 * 截取 handleSelectionCaptureResult 中「未取到文字」提示分支的源码。
 * @returns 从失败分支开始到提示弹窗调用结束的源码片段。
 * @author zhenghq
 */
function selectionCaptureFailureSource(): string {
  const start = mainSource.indexOf('if (!result.text) {')
  const end = mainSource.indexOf('if (shouldAutoRepairHiServices)', start)
  assert.ok(start >= 0, 'handleSelectionCaptureResult 应有取词失败分支')
  assert.ok(end > start, '取词失败分支应有结束边界')
  return mainSource.slice(start, end)
}

test('翻译弹窗隐藏必须直接隐藏，不得再做应用级前台交还', () => {
  const hideSource = stripComments(extractFunction(popupSource, 'export function hidePopup(): void {'))

  // macOS panel 的 show()/focus() 不激活应用，隐藏弹窗不会把同应用其它窗口
  // 提升到最前，因此 hidePopup 只允许直接隐藏窗口自身。
  assert.match(hideSource, /win\.hide\(\)/u, '隐藏弹窗必须直接调用 win.hide()')
  assert.doesNotMatch(hideSource, /handBackFrontmostThen/u, '不得再复用应用级前台交还')
  assert.doesNotMatch(hideSource, /yieldFrontmostAppThen/u, '不得再走整应用安全让出')
  assert.doesNotMatch(hideSource, /hidingAfterFrontReturn/u, '不得再维护交还期间的逻辑关闭标记')
  assert.doesNotMatch(hideSource, /beginInternalWindowTeardown|endInternalWindowTeardown/u,
    '不得再维护前台交还收尾抑制期')
})

test('翻译弹窗不得再维护补偿性前台交还状态', () => {
  const code = stripComments(popupSource)

  for (const removed of [
    'hidingAfterFrontReturn',
    'restoringForegroundUntil',
    'resultActivationSettleUntil',
    'resultActivationBlurAbsorbed',
    'captureForegroundRestoreActive',
    'beginInternalWindowTeardown',
    'endInternalWindowTeardown',
    'handBackFrontmostThen',
    'yieldFrontmostAppThen',
    'rememberFrontmostAppBeforeActivation'
  ]) {
    assert.ok(!code.includes(removed), `popup.ts 不应再包含 ${removed}`)
  }
})

test('弹窗可见性与命中判定必须直接基于窗口状态', () => {
  const visibleSource = stripComments(extractFunction(popupSource, 'export function isPopupVisible(): boolean {'))
  const pointSource = stripComments(extractFunction(popupSource, 'export function isPointInsidePopup('))

  // 旧实现用 hidingAfterFrontReturn 把「交还期间」当作已关闭；panel 直接隐藏后
  // 不需要任何逻辑关闭态，可见性只由 win.isVisible() 决定。
  assert.match(visibleSource, /win\?\.isVisible\(\)/u, '可见状态必须直接读取窗口可见性')
  assert.doesNotMatch(visibleSource, /hidingAfterFrontReturn/u, '不得再引用交还期间标记')
  assert.match(pointSource, /isPopupVisible\(\)/u, '命中判定必须复用统一可见性判断')
})

test('划词弹窗显示前不得再记录应用级交还目标', () => {
  const readingSource = stripComments(
    extractFunction(mainSource, 'function showSelectionReadingPopup(')
  )

  // 公共取词入口只需显示读取弹窗；panel 不激活应用，不存在需要交还的源应用。
  assert.doesNotMatch(readingSource, /rememberFrontmostAppIfInactive/u, '不得再记录源应用交还目标')
  assert.doesNotMatch(readingSource, /restoreFrontmostAppForCapture/u, '不得再走取词前精确交还')
  assert.match(readingSource, /showPopup\(/u, '公共取词入口仍需显示读取弹窗')
})

test('macOS 上取词失败提示必须以非激活方式显示，避免设置页被顶到最前', () => {
  // macOS：失败提示若激活本应用，提示自动隐藏时系统会把设置页提升为 key window 顶到最前。
  assert.equal(shouldActivatePopupForCaptureFailure('darwin'), false)
  // Windows / Linux 保持原有激活行为，避免影响取词焦点时序。
  assert.equal(shouldActivatePopupForCaptureFailure('win32'), true)
  assert.equal(shouldActivatePopupForCaptureFailure('linux'), true)

  const failureSource = selectionCaptureFailureSource()
  assert.match(
    failureSource,
    /result\.anchor,\s*shouldActivatePopupForCaptureFailure\(process\.platform\)/u,
    '取词失败提示的激活方式必须由平台策略决定，不能沿用默认激活'
  )
})

test('原生修复对话框关闭后仍必须交还其记录的源应用', () => {
  const handBackAppSource = extractFunction(
    macForegroundSource,
    'export function handBackFrontmostApp(): Promise<boolean> {'
  )
  // dialog.showMessageBox 是原生对话框而不是 BrowserWindow：对话框存在时
  // BrowserWindow.getFocusedWindow() 返回 null，但本应用仍然处于最前。
  // 若据此判断「无需交还」，对话框关闭后系统会把网页翻译窗口提升到最前。
  // 判定必须使用应用激活事件状态：isMacAppActive() 会因窗口焦点残留误报。
  assert.match(handBackAppSource, /!isMacAppActiveByEvents\(\)/u,
    '必须依据应用激活事件状态判断是否仍需交还前台')
  assert.match(
    handBackAppSource,
    /if \(!isMacAppActiveByEvents\(\)\) \{\s*\n\s*forgetFrontmostApp\(\)/u,
    '本应用确实不在最前时才能放弃交还'
  )
  // 交还过程中同样必须等待应用失活，不能只看 BrowserWindow 焦点。
  assert.match(
    handBackAppSource,
    /if \(!isMacAppActiveByEvents\(\)\) \{\s*\n\s*finish\(true\)/u,
    '必须轮询应用失活后才算交还完成'
  )
  // Electron 33 不提供 app.isActive()，必须通过获得/失去激活事件自行跟踪应用状态。
  assert.match(macForegroundSource, /app\.on\('did-become-active'/u, '必须跟踪应用获得激活')
  assert.match(macForegroundSource, /app\.on\('did-resign-active'/u, '必须跟踪应用失去激活')
  assert.doesNotMatch(handBackAppSource, /app\.isActive\(\)/u, 'Electron 33 不提供 app.isActive()')
})

test('OCR 覆盖层与原生对话框仍保留前台交还链路', () => {
  const handBackThenSource = stripComments(
    extractFunction(macForegroundSource, 'export function handBackFrontmostThen(')
  )
  const handBackAppSource = stripComments(
    extractFunction(macForegroundSource, 'export function handBackFrontmostApp(): Promise<boolean> {')
  )

  // 这两条链路会显示原生对话框 / OCR 覆盖层并真实激活应用，仍必须把前台
  // 交还给用户原本在用的应用；它们不属于本次 panel 删除范围。
  assert.match(handBackThenSource, /activateFrontmostApp/u, '覆盖层收尾必须尝试精确交还源应用')
  assert.match(handBackThenSource, /handBackFrontmostThen|forgetFrontmostApp/u, '必须维护待交还记录生命周期')
  assert.match(handBackAppSource, /activateFrontmostApp/u, '原生对话框收尾必须尝试精确交还源应用')
})

test('原生修复对话框显示期间不得丢弃待交还记录', () => {
  const handBackThenSource = stripComments(
    extractFunction(macForegroundSource, 'export function handBackFrontmostThen(')
  )

  // 修复对话框持有 key window 时 BrowserWindow.getFocusedWindow() 返回 null，
  // 但本应用仍处于最前。失败提示在这期间自动隐藏，若此时丢弃待交还记录，
  // 对话框关闭后就没有目标可以交还，网页翻译窗口会被系统顶到最前。
  assert.match(
    handBackThenSource,
    /focused === null[\s\S]*?isMacAppActiveByEvents\(\)[\s\S]*?run\(\)/u,
    '应用仍在前台（对话框持有 key window）时必须保留待交还记录'
  )
  assert.match(
    handBackThenSource,
    /isMacAppActiveByEvents\(\)[\s\S]*?forgetFrontmostApp\(\)/u,
    '只有应用确实失活时才能丢弃待交还记录'
  )
})

test('macOS 连续取词超时自动修复必须完全静默，不得弹框或置前窗口', () => {
  const repairSource = extractFunction(mainSource, 'async function autoRepairMacHiServices(): Promise<void> {')

  assert.match(
    repairSource,
    /resetCopyTimeoutTracker\(\)[\s\S]*?restartMacHiServices\(\)/u,
    '达到阈值后必须直接重启 hiservices，不再等待用户确认'
  )
  assert.doesNotMatch(
    repairSource,
    /dialog\.showMessageBox|showPopup\(|rememberFrontmostAppIfInactiveAsync|handBackFrontmostApp/u,
    '自动修复不得弹原生对话框、显示结果弹窗或触发应用级前台交还'
  )
})

test('前台交还链路必须输出可诊断日志', () => {
  const handBackSource = stripComments(
    extractFunction(macForegroundSource, 'export function handBackFrontmostThen(')
  )
  const handBackAppSource = stripComments(
    extractFunction(macForegroundSource, 'export function handBackFrontmostApp(): Promise<boolean> {')
  )

  assert.match(handBackSource, /logFrontDiagnostic\(|console\.(log|warn)/u, '覆盖层交还路径必须输出日志')
  assert.match(handBackAppSource, /logFrontDiagnostic\(|console\.(log|warn)/u, '原生对话框交还路径必须输出日志')
  assert.match(macForegroundSource, /\[macForeground\]/u, '日志必须带统一前缀，便于从主进程日志中筛选')
})

test('应用已不在最前时只在真的丢弃了记录才输出日志', () => {
  const handBackSource = stripComments(
    extractFunction(macForegroundSource, 'export function handBackFrontmostThen(')
  )

  const branchStart = handBackSource.indexOf('forgetFrontmostApp()')
  assert.ok(branchStart >= 0, '应存在丢弃过期记录的分支')
  const branchSource = handBackSource.slice(
    Math.max(0, branchStart - 300),
    branchStart + 300
  )
  assert.match(
    branchSource,
    /if \(discarded\)|if \(stale\)|if \(pendingReturnApp\)/u,
    '丢弃日志必须受「确实存在待丢弃记录」的条件保护'
  )
  assert.match(
    branchSource,
    /bundleId=\$\{(?:discarded|stale)\.bundleId\}/u,
    '丢弃日志必须带上被丢弃的目标应用'
  )
})
