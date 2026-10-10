import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

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
 * 去掉源码注释，避免注释中的历史名称干扰断言。
 * @param source 源码。
 * @returns 移除注释后的源码。
 * @author zhenghq
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

const mainSource = readFileSync('src/main/index.ts', 'utf8')

test('设置页临时提升层级后必须有界回收，不能只依赖 blur 事件', () => {
  const helperSource = stripComments(
    extractFunction(mainSource, 'function showOwnWindowForInteraction(')
  )

  // nonactivating panel 的 blur 事件在 macOS 上不保证派发；若只依赖 blur 降级，
  // 设置页会长期保持 screen-saver 层级，划词时便会概率性浮到最前。
  assert.match(
    helperSource,
    /setAlwaysOnTop\(true,\s*'screen-saver'\)/u,
    '显式置前仍应临时提升层级'
  )
  assert.match(
    helperSource,
    /scheduleSettingsPanelRaiseLevelReset\(\)/u,
    '显式置前必须安排有界回收'
  )
  const resetSource = stripComments(
    extractFunction(mainSource, 'function scheduleSettingsPanelRaiseLevelReset(')
  )
  assert.match(resetSource, /setTimeout\(/u, '层级回收必须使用有界定时器')
  assert.match(resetSource, /setAlwaysOnTop\(false\)/u, '定时器到期必须归还普通层级')
})

test('划词手势开始时必须主动把设置页降回普通层级', () => {
  const scheduleSource = stripComments(
    extractFunction(mainSource, 'function scheduleSelectionAction(')
  )
  const gestureSource = stripComments(
    extractFunction(mainSource, 'function handleSelectionGesture(')
  )

  // 划词是纯内部交互，不能受设置页残留的最高层级影响；手势一开始就必须降级，
  // 而不是等按钮/弹窗状态或 blur 事件到达。
  assert.match(
    `${scheduleSource}\n${gestureSource}`,
    /lowerSettingsPanelRaiseLevel\(\)/u,
    '划词开始路径必须主动回收设置页的临时置顶层级'
  )
})

test('划词流程收尾与结果弹窗显示时必须续期 activate 抑制，覆盖翻译耗时', () => {
  const releaseSource = stripComments(
    extractFunction(mainSource, 'function releaseSelectionInteraction(')
  )

  // 翻译结果弹窗通常在划词手势 1~3 秒后才 show()，初始的短抑制窗口早已过期。
  // 若不在释放交互 token 时续期，结果弹窗触发的 activate 会被误判为 Dock 点击，
  // 从而把已打开的设置页重新拉到最前。
  assert.match(
    releaseSource,
    /suppressSelectionActivationWindowGap\(\)/u,
    '释放划词交互后必须续期抑制，覆盖收尾阶段的迟到 activate'
  )
  assert.match(
    mainSource,
    /createPopup\(PRELOAD_PATH,\s*suppressSelectionActivationWindowGap\)/u,
    '翻译弹窗显示时必须回调续期抑制，覆盖异步翻译结果上屏'
  )
})

test('翻译弹窗在显示或聚焦自身时通知调用方，不激活应用其它窗口', () => {
  const popupSource = stripComments(
    readFileSync('src/main/popup.ts', 'utf8')
  )

  assert.match(
    popupSource,
    /createPopup\(\s*preloadPath:\s*string,\s*onWindowShown\?:\s*\(\)\s*=>\s*void\s*\)/u,
    '翻译弹窗创建入口必须接收内部窗口显示回调'
  )
  assert.match(
    popupSource,
    /function notifyInternalWindowShown\(/u,
    '翻译弹窗必须提供内部显示通知函数'
  )
  assert.match(
    popupSource,
    /notifyInternalWindowShown\(\)/u,
    '翻译弹窗每次自身显示时都必须通知调用方续期 activate 抑制'
  )
})

test('结果弹窗显示与关闭都必须续期抑制，防止下一轮划词前误拉设置页', () => {
  const popupSource = stripComments(
    readFileSync('src/main/popup.ts', 'utf8')
  )
  const showSource = extractFunction(popupSource, 'export function showPopup(')
  const hideSource = extractFunction(popupSource, 'export function hidePopup(): void {')

  // 用户现象：翻译结果上屏后点击空白页，下一轮划词就会把设置页拉到最前。
  // 结果弹窗的 show()/hide() 都会让 macOS 派发内部 activate，两处都必须续期。
  assert.match(showSource, /notifyInternalWindowShown\(\)/u,
    '结果弹窗显示后必须续期 activate 抑制')
  assert.match(hideSource, /notifyInternalWindowShown\(\)/u,
    '结果弹窗隐藏后必须续期 activate 抑制')
})

test('划词交互期间设置页必须保持不可聚焦，避免被系统选为 key window', () => {
  const code = stripComments(mainSource)

  // nonactivating panel 只解决“不激活整个应用”，并不能阻止系统在应用内部
  // 选择下一个可聚焦窗口。设置页若在划词期间仍可聚焦，弹窗隐藏或结果上屏时
  // 就会被 macOS 提升为 key window 并排到最前，表现为连续划词时概率性闪现。
  assert.match(
    code,
    /function suspendSettingsWindowFocusForSelection\(/u,
    '划词期间必须提供设置页焦点挂起入口'
  )
  assert.match(
    code,
    /settingsWin\.setFocusable\(false\)|target\.setFocusable\(false\)/u,
    '划词期间必须真正关闭设置页可聚焦性'
  )
  assert.match(
    code,
    /if \(BrowserWindow\.getFocusedWindow\(\) === target\) target\.blur\(\)/u,
    '设置页已是 key window 时必须显式 blur 撤回'
  )
})

test('划词开始时必须挂起设置页焦点，并在交互收尾时恢复', () => {
  const translateSource = stripComments(
    extractFunction(mainSource, 'async function translateSelectionButton(')
  )
  const releaseSource = stripComments(
    extractFunction(mainSource, 'function releaseSelectionInteraction(')
  )

  assert.match(
    translateSource,
    /suspendSettingsWindowFocusForSelection\(interactionToken\)/u,
    '按钮取词开始前必须挂起设置页焦点'
  )
  assert.match(
    releaseSource,
    /resumeSettingsWindowFocusAfterSelection\(token\)/u,
    '交互 token 释放后必须恢复设置页可聚焦性'
  )
})

test('显式打开设置页必须立即解除划词焦点保护', () => {
  const createSource = stripComments(
    extractFunction(mainSource, 'async function createSettingsWindow(')
  )

  assert.match(
    createSource,
    /resumeSettingsWindowFocusAfterSelection\(\)/u,
    '显式打开设置页时必须解除划词期间的焦点保护'
  )
})

test('用户点击可见设置页时必须立即恢复键盘输入能力', () => {
  const pointerSource = stripComments(
    extractFunction(mainSource, 'function handleSelectionPointerDown(')
  )

  // 结果弹窗被钉住时会一直可见，设置页焦点恢复会被推迟；此时用户显式点击
  // 设置页必须立即恢复可聚焦性，否则设置页无法接收键盘输入。
  const settingsHitIndex = pointerSource.indexOf('isPointInsideVisibleSettingsWindow(point)')
  assert.ok(settingsHitIndex >= 0, '全局按下必须识别可见设置页矩形')
  const resumeIndex = pointerSource.indexOf(
    'resumeSettingsWindowFocusAfterSelection()',
    settingsHitIndex
  )
  assert.ok(
    resumeIndex > settingsHitIndex,
    '点击可见设置页时必须解除划词期间的焦点保护，恢复键盘输入能力'
  )
})

test('弹窗仍可见时不得提前恢复设置页可聚焦性', () => {
  const resumeSource = stripComments(
    extractFunction(mainSource, 'function resumeSettingsWindowFocusAfterSelection(')
  )

  // 弹窗隐藏会让系统重新挑选 key window。若在弹窗仍可见时提前恢复设置页
  // 可聚焦性，弹窗一隐藏设置页就会被提升到最前，正是连续划词概率性闪现的根因。
  assert.match(
    resumeSource,
    /if \(!force && isPopupVisible\(\)\) \{[\s\S]*?settingsWindowFocusResumePending = true[\s\S]*?return/u,
    '弹窗可见时必须登记待恢复并立即返回，不能当场恢复'
  )
  assert.match(
    resumeSource,
    /target\.setFocusable\(true\)/u,
    '弹窗隐藏后必须真正恢复设置页可聚焦性'
  )
})
