import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { shouldRestoreForegroundBeforeCapture } from '../src/shared/popupForeground.ts'

const popupSource = readFileSync('src/main/popup.ts', 'utf8')

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
 * 校验共享前台策略只保留 Windows 取词归还语义。
 * macOS 上翻译弹窗是 nonactivating panel，show()/focus() 不激活应用，
 * 不存在结果弹窗激活后需要交还前台的竞态，因此不应再有 darwin 特判。
 * @returns 无返回值。
 * @author zhenghq
 */
test('共享前台策略只保留 Windows 取词归还语义', () => {
  assert.equal(shouldRestoreForegroundBeforeCapture('win32', true), true)
  assert.equal(shouldRestoreForegroundBeforeCapture('win32', false), false)
  assert.equal(shouldRestoreForegroundBeforeCapture('darwin', true), false)
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
    blurSource.indexOf('if (shownInactive) return') < blurSource.indexOf('hidePopup()'),
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
    blurSource.indexOf('if (selectionCaptureLoading) return') < blurSource.indexOf('hidePopup()'),
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
  assert.match(dismissSource, /hidePopup\(\)/u, '真正的外部点击必须关闭弹窗')
})
