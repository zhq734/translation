import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { shouldRestoreForegroundBeforeCapture } from '../src/shared/popupForeground.ts'

const popupSource = readFileSync('src/main/popup.ts', 'utf8')
const mainSource = readFileSync('src/main/index.ts', 'utf8')

/**
 * 截取源码中指定顶层函数的完整片段。
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
 * 去掉源码中的块注释与行注释，避免注释文本干扰行为断言。
 * @param source 源码。
 * @returns 移除注释后的源码。
 * @author zhenghq
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

/**
 * 校验共享前台策略覆盖 Windows 与 macOS：
 * Windows 归还前台窗口，macOS 归还 key window；Linux 不干预。
 * @returns 无返回值。
 * @author zhenghq
 */
test('共享前台策略只保留 Windows 取词归还语义', () => {
  assert.equal(shouldRestoreForegroundBeforeCapture('win32', true), true)
  assert.equal(shouldRestoreForegroundBeforeCapture('win32', false), false)
  assert.equal(shouldRestoreForegroundBeforeCapture('darwin', true), true)
  assert.equal(shouldRestoreForegroundBeforeCapture('darwin', false), false)
  assert.equal(shouldRestoreForegroundBeforeCapture('linux', true), false)
})

/**
 * 校验翻译弹窗已删除结果激活失焦宽限等补偿状态。
 * panel 落地后不存在应用级前台交还与结果激活之间的迟到失焦竞态。
 * @returns 无返回值。
 * @author zhenghq
 */
test('翻译弹窗不得再维护结果激活失焦宽限状态', () => {
  const code = stripComments(popupSource)
  for (const removed of [
    'resultActivationSettleUntil',
    'resultActivationBlurAbsorbed',
    'resultActivationRefocusTimer',
    'armResultActivationSettle',
    'shouldAbsorbResultActivationBlur',
    'scheduleResultActivationRefocus'
  ]) {
    assert.ok(!code.includes(removed), `popup.ts 不应再包含 ${removed}`)
  }
})

/**
 * 校验读取阶段以非激活方式显示的弹窗不会因失焦被误关。
 * 读取弹窗用 showInactive 显示，本就不持有 key window；此时任何 blur
 * 都来自内部动作，若据此关闭会表现为「弹窗一闪即关」。
 * @returns 无返回值。
 * @author zhenghq
 */
test('非激活显示的读取弹窗不得因失焦被关闭', () => {
  const blurStart = popupSource.indexOf('function handlePopupBlur()')
  const blurSource = popupSource.slice(blurStart, blurStart + 1200)
  assert.match(blurSource, /if \(shownInactive\) return/u, '非激活显示期间必须忽略失焦')
  assert.ok(
    blurSource.indexOf('if (shownInactive) return') < blurSource.indexOf('hidePopup('),
    '忽略失焦必须发生在关闭判断之前'
  )
})

/**
 * 校验选区取词加载期间不得因失焦关闭弹窗。
 *
 * 点击“译”后读取弹窗会切换为翻译加载态，此时翻译结果尚未返回；
 * macOS 输入法切换等可能派发迟到失焦，若据此关闭，用户表现为弹窗一闪即关。
 * 真实的外部点击由全局按下兜底关闭，不依赖 blur。
 * @returns 无返回值。
 * @author zhenghq
 */
test('选区取词加载期间失焦不得关闭弹窗', () => {
  assert.match(
    popupSource,
    /selectionCaptureLoading/u,
    '必须记录选区取词加载态，供失焦处理区分内部切换'
  )
  const blurStart = popupSource.indexOf('function handlePopupBlur()')
  const blurSource = popupSource.slice(blurStart, blurStart + 1200)
  assert.match(
    blurSource,
    /if \(selectionCaptureLoading\) return/u,
    '选区取词加载期间必须忽略失焦，避免翻译结果返回前弹窗被关闭'
  )
  assert.ok(
    blurSource.indexOf('if (selectionCaptureLoading) return') < blurSource.indexOf('hidePopup('),
    '加载态短路必须发生在关闭判断之前'
  )
})

/**
 * 校验外部点击关闭主判据落在全局按下兜底。
 * panel 不激活应用后 blur 触发时机不稳定，必须依赖全局鼠标按下。
 * @returns 无返回值。
 * @author zhenghq
 */
test('外部点击关闭必须由全局按下兜底承担', () => {
  assert.match(popupSource, /export function dismissPopupOnExternalPointerDown\(/u,
    '必须导出全局按下兜底入口')
  const dismissStart = popupSource.indexOf('export function dismissPopupOnExternalPointerDown(')
  const dismissSource = popupSource.slice(dismissStart, dismissStart + 1200)
  assert.match(dismissSource, /if \(!isPopupVisible\(\)\) return false/u, '不可见时不得处理')
  assert.match(dismissSource, /if \(pinned \|\| isSuppressedExternalPointerDismiss\(point\)\) return false/u,
    '固定弹窗与迟到按钮按下必须豁免')
  assert.match(dismissSource, /hidePopup\(true, 'external-pointer'\)/u,
    '真正的外部点击必须关闭弹窗')
})

/**
 * 校验同一轮弹窗关闭在异步交还期间具备幂等保护。
 *
 * 真机日志显示外部按下与随后到达的 blur 会在数毫秒内各调用一次 hidePopup()，
 * 从而并发启动两轮前台恢复。关闭流程必须只允许第一入口生效，迟到事件只记录
 * 被忽略的诊断，不得再次清理状态或启动 handBackFrontmostThen()。
 * @returns 无返回值。
 * @author zhenghq
 */
test('同一轮弹窗关闭进行中不得被迟到失焦重复触发', () => {
  const hideSource = stripComments(
    extractFunction(popupSource, 'export function hidePopup(')
  )
  const closingGuardIndex = hideSource.indexOf('popupCloseInFlight')
  const versionIndex = hideSource.indexOf('closeVersion += 1')
  const handBackIndex = hideSource.indexOf('handBackFrontmostThen(')

  assert.match(popupSource, /let popupCloseInFlight = false/u,
    '必须维护弹窗关闭进行中状态')
  assert.ok(closingGuardIndex >= 0, 'hidePopup 必须检查关闭进行中状态')
  assert.ok(closingGuardIndex < versionIndex,
    '重复关闭保护必须早于 closeVersion 自增，避免旧异步结果版本再次失效')
  assert.ok(closingGuardIndex < handBackIndex,
    '重复关闭保护必须早于异步前台交还')
  assert.match(
    hideSource,
    /if \(popupCloseInFlight\)[\s\S]*?ignore duplicate hide[\s\S]*?return/u,
    '关闭进行中必须记录并忽略迟到关闭请求'
  )
})

/**
 * 校验新一轮弹窗显示会释放上一轮关闭状态。
 *
 * 关闭状态不能只依赖异步收尾释放：若上一轮恢复流程异常或新结果在收尾前到达，
 * 后续弹窗将永久无法关闭。每次 showPopup() 都必须显式重置为可关闭状态。
 * @returns 无返回值。
 * @author zhenghq
 */
test('新一轮弹窗显示必须重置关闭进行中状态', () => {
  const showSource = stripComments(
    extractFunction(popupSource, 'export function showPopup(')
  )
  assert.match(showSource, /popupCloseInFlight = false/u,
    'showPopup 必须重置关闭进行中状态，保证下一轮弹窗可以正常关闭')
})

/**
 * 校验真实隐藏完成后释放关闭进行中状态。
 *
 * 关闭状态用于覆盖异步前台交还窗口，窗口真正 hide() 后必须释放，否则后续同一
 * BrowserWindow 的再次显示与关闭会被误判为重复关闭。
 * @returns 无返回值。
 * @author zhenghq
 */
test('弹窗真实隐藏完成后必须释放关闭进行中状态', () => {
  const hideSource = stripComments(
    extractFunction(popupSource, 'export function hidePopup(')
  )
  const hideIndex = hideSource.indexOf('win?.hide()')
  const releaseIndex = hideSource.indexOf('popupCloseInFlight = false', hideIndex)

  assert.ok(hideIndex >= 0, '关闭流程必须保留真实 win.hide()')
  assert.ok(releaseIndex > hideIndex, '关闭状态必须在真实隐藏完成后释放')
})

/**
 * 校验弹窗关闭开始与真实隐藏完成都会通知主进程收尾。
 *
 * 真机日志显示外部点击关闭后，设置页在异步前台交还期间仍可能保留临时
 * screen-saver 层级并被带到最前。关闭入口必须在启动 handBackFrontmostThen()
 * 前回收该层级，真实 hide() 完成后还要再通知一次，覆盖隐藏后派发的迟到 activate。
 * 通知必须同步执行，不能插入 await 改变现有前台交还顺序。
 * @returns 无返回值。
 * @author zhenghq
 */
test('弹窗关闭开始与隐藏完成都必须通知主进程收尾', () => {
  const createSource = stripComments(
    extractFunction(popupSource, 'export function createPopup(')
  )
  const hideSource = stripComments(
    extractFunction(popupSource, 'export function hidePopup(')
  )
  const transitionSource = stripComments(
    extractFunction(mainSource, 'function handlePopupInternalWindowTransition(')
  )
  const handBackIndex = hideSource.indexOf('handBackFrontmostThen(')
  const hideIndex = hideSource.indexOf('win?.hide()')
  const firstNotifyIndex = hideSource.indexOf('onPopupCloseStartCallback?.()')
  const closeEndIndex = hideSource.indexOf('onPopupCloseEndCallback?.()', hideIndex)

  assert.match(popupSource, /onPopupCloseStart\?:\s*\(\)\s*=>\s*void/u,
    'createPopup 必须接收关闭开始回调')
  assert.match(popupSource, /onPopupCloseEnd\?:\s*\(\)\s*=>\s*void/u,
    'createPopup 必须接收真实隐藏完成回调')
  assert.match(createSource, /onPopupCloseStartCallback = options\.onPopupCloseStart \?\? null/u,
    '关闭开始回调必须保存到模块状态')
  assert.match(createSource, /onPopupCloseEndCallback = options\.onPopupCloseEnd \?\? null/u,
    '真实隐藏完成回调必须保存到模块状态')
  assert.ok(firstNotifyIndex >= 0, '关闭开始必须通知主进程')
  assert.ok(firstNotifyIndex < handBackIndex,
    '关闭开始通知必须早于异步前台交还')
  assert.ok(closeEndIndex > hideIndex,
    '真实隐藏完成后必须再次通知主进程，覆盖迟到 activate')
  assert.match(
    hideSource,
    /try\s*\{[\s\S]*?win\?\.hide\(\)[\s\S]*?\}\s*finally\s*\{[\s\S]*?onPopupCloseEndCallback\?\.\(\)[\s\S]*?\}/u,
    '真实隐藏完成回调必须位于 finally 中，确保隐藏异常时也能恢复设置页焦点'
  )
  assert.doesNotMatch(hideSource, /\bawait\b/u,
    '关闭生命周期通知不得引入 await，不能改变现有前台交还顺序')
  assert.match(transitionSource, /suppressSelectionActivationWindowGap\(\)/u,
    '关闭生命周期收尾必须续期划词 activate 抑制')
  assert.match(transitionSource, /lowerSettingsPanelRaiseLevel\(\)/u,
    '关闭生命周期收尾必须回收设置页临时置顶层级')
  assert.match(
    mainSource,
    /createPopup\(\s*\{[\s\S]*?preloadPath:\s*PRELOAD_PATH,[\s\S]*?onWindowShown:\s*suppressSelectionActivationWindowGap,[\s\S]*?onPopupHidden:\s*\(\)\s*=>\s*pronunciationRequests\.cancelAll\(\),[\s\S]*?onPopupCloseStart:\s*handlePopupCloseStart,[\s\S]*?onPopupCloseEnd:\s*handlePopupCloseEnd\s*\}\s*\)/u,
    '主进程必须把关闭生命周期收尾回调注入翻译弹窗'
  )
})
