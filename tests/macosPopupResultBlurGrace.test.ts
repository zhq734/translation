import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  POPUP_RESULT_ACTIVATION_REFOCUS_DELAY_MS,
  POPUP_RESULT_ACTIVATION_SETTLE_MS
} from '../src/shared/popupForeground.ts'

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
 * 校验结果弹窗激活后的失焦宽限常量取值合理。
 * 宽限窗口必须覆盖 macOS 源应用迟到的前台切换（实机采样约 700ms），
 * 重新聚焦延迟则必须足够短，避免弹窗长时间停留在失焦状态。
 * @returns 无返回值。
 * @author zhenghq
 */
test('结果弹窗激活失焦宽限与重新聚焦延迟取值合理', () => {
  assert.ok(POPUP_RESULT_ACTIVATION_SETTLE_MS >= 800, '宽限窗口必须覆盖约 700ms 的迟到失焦')
  assert.ok(POPUP_RESULT_ACTIVATION_SETTLE_MS <= 2000, '宽限窗口不能过长，避免吞掉正常点击外部')
  assert.ok(POPUP_RESULT_ACTIVATION_REFOCUS_DELAY_MS > 0, '重新聚焦延迟必须为正数')
  assert.ok(
    POPUP_RESULT_ACTIVATION_REFOCUS_DELAY_MS <= 200,
    '重新聚焦必须尽快执行，避免弹窗可见但长时间失焦'
  )
})

/**
 * 校验弹窗维护结果激活失焦宽限状态，并在创建与关闭时复位。
 * @returns 无返回值。
 * @author zhenghq
 */
test('弹窗必须维护结果激活失焦宽限状态并在创建关闭时复位', () => {
  assert.match(popupSource, /resultActivationSettleUntil/u, '必须记录结果激活失焦宽限截止时间')
  assert.match(popupSource, /resultActivationBlurAbsorbed/u, '必须记录迟到失焦是否已被吸收一次')
  assert.match(popupSource, /resultActivationRefocusTimer/u, '必须维护重新聚焦定时器')

  const createSource = popupSource.slice(
    popupSource.indexOf('export function createPopup('),
    popupSource.indexOf('export function showPopup(')
  )
  assert.match(createSource, /resultActivationSettleUntil = 0/u, '创建弹窗时必须复位宽限截止时间')
  assert.match(createSource, /resultActivationBlurAbsorbed = false/u, '创建弹窗时必须复位吸收标记')

  const hideStart = popupSource.indexOf('export function hidePopup(')
  const hideSource = popupSource.slice(hideStart, hideStart + 1200)
  assert.match(hideSource, /resultActivationSettleUntil = 0/u, '关闭弹窗时必须复位宽限截止时间')
})

/**
 * 校验程序化激活弹窗时会开启失焦宽限。
 * @returns 无返回值。
 * @author zhenghq
 */
test('程序化激活弹窗时必须开启结果失焦宽限', () => {
  const showSource = popupSource.slice(
    popupSource.indexOf('export function showPopup('),
    popupSource.indexOf('export function showManualTranslationPopup(')
  )
  assert.match(showSource, /armResultActivationSettle\(/u, '激活弹窗时必须开启失焦宽限')
  assert.match(
    showSource,
    /shouldArmResultActivationSettle\(payload\)/u,
    '必须按负载来源决定是否开启宽限，避免影响手动翻译与 OCR'
  )
  assert.ok(
    showSource.indexOf('armResultActivationSettle(') < showSource.lastIndexOf('win.show()'),
    '必须在 win.show() 激活弹窗前开启宽限，避免失焦事件抢先到达'
  )
})

/**
 * 校验迟到失焦在宽限期内可被多次吸收，并触发重新聚焦。
 * 程序化激活结果弹窗后，源应用接管前台与输入法切换可能连续派发多次失焦；
 * 若只吸收一次，后续失焦仍会关闭刚显示的弹窗，表现为「一闪即关」。
 * 若不重新聚焦，弹窗会保持可见但失焦，后续点击外部不再产生 blur，
 * 未固定弹窗将无法再自动关闭；因此吸收迟到失焦后必须重新聚焦一次。
 * @returns 无返回值。
 * @author zhenghq
 */
test('宽限期内迟到失焦必须可多次吸收并重新聚焦', () => {
  const blurStart = popupSource.indexOf('function handlePopupBlur()')
  const blurSource = popupSource.slice(blurStart, blurStart + 1200)
  assert.match(blurSource, /shouldAbsorbResultActivationBlur\(\)/u, '失焦处理必须先判断是否应吸收迟到失焦')
  assert.match(blurSource, /scheduleResultActivationRefocus\(\)/u, '吸收迟到失焦后必须安排重新聚焦')

  const absorbStart = popupSource.indexOf('function shouldAbsorbResultActivationBlur()')
  const absorbSource = popupSource.slice(absorbStart, absorbStart + 600)
  assert.match(absorbSource, /Date\.now\(\) > resultActivationSettleUntil/u, '超过宽限窗口后不得再吸收失焦')
  assert.doesNotMatch(
    absorbSource,
    /if \(resultActivationBlurAbsorbed\) return false/u,
    '宽限期内不得因已吸收过一次而放行后续迟到失焦'
  )

  const refocusStart = popupSource.indexOf('function scheduleResultActivationRefocus()')
  const refocusSource = popupSource.slice(refocusStart, refocusStart + 900)
  assert.match(refocusSource, /win\.show\(\)/u, '重新聚焦必须调用 win.show() 恢复 key window')
  assert.match(refocusSource, /win\.isFocused\(\)/u, '重新聚焦前必须确认弹窗确实已失焦')
})

/**
 * 校验重新聚焦后仍保留迟到失焦宽限，直到窗口自然结束。
 *
 * 重新聚焦只代表弹窗暂时夺回 key window，源应用与输入法切换仍可能在随后
 * 再派发失焦；若 focus 时立即清零宽限截止时间，后续失焦会关闭弹窗。
 * 真实点击外部由全局按下兜底关闭，不依赖 focus 提前结束宽限。
 * @returns 无返回值。
 * @author zhenghq
 */
test('重新聚焦后必须保留迟到失焦宽限', () => {
  const focusStart = popupSource.indexOf('function handlePopupFocus()')
  assert.ok(focusStart >= 0, '必须注册弹窗 focus 处理函数')
  const focusSource = popupSource.slice(focusStart, focusStart + 600)
  assert.match(focusSource, /resultActivationBlurAbsorbed/u, '只有吸收过迟到失焦后的重新聚焦才应结束宽限')
  assert.doesNotMatch(
    focusSource,
    /resultActivationSettleUntil = 0/u,
    '重新聚焦后不得提前结束宽限窗口，否则后续迟到失焦仍会关闭弹窗'
  )
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
 * macOS 的前台交还与输入法切换可能在此阶段派发迟到失焦，若据此关闭，
 * 用户表现为弹窗一闪即关。真实的外部点击由全局按下兜底关闭，不依赖 blur。
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
