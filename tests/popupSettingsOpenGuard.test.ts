import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const popupSource = readFileSync('src/main/popup.ts', 'utf8')
const indexSource = readFileSync('src/main/index.ts', 'utf8')

/**
 * 截取源码中指定函数的完整片段。
 *
 * 约定目标函数为顶层声明，函数结束的 `}` 顶格出现，便于稳定定位边界。
 * @param source 待检索的源码。
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

test('从翻译弹窗打开设置时，弹窗失焦不得自动关闭', () => {
  assert.match(
    popupSource,
    /export function beginPopupSettingsOpenGuard\(/u,
    '必须提供设置打开期间的弹窗失焦保护入口'
  )
  assert.match(
    popupSource,
    /export function endPopupSettingsOpenGuard\(/u,
    '必须提供设置打开期间的弹窗失焦保护解除入口'
  )
  assert.match(
    popupSource,
    /export function isPopupSettingsOpenGuardActive\(/u,
    '必须提供保护状态查询入口，供全局按下判定复用'
  )

  const blurSource = extractFunction(popupSource, 'function handlePopupBlur()')
  const guardIndex = blurSource.indexOf('settingsOpenGuardActive')
  const hideIndex = blurSource.indexOf('hidePopup()')
  assert.ok(guardIndex >= 0, '失焦处理必须识别设置打开保护状态')
  assert.ok(guardIndex < hideIndex, '设置打开保护必须发生在自动关闭判断之前')
})

test('打开设置请求必须先开启失焦保护，失败时立即解除', () => {
  const openSettingsIndex = indexSource.indexOf("ipcMain.on('settings:open'")
  assert.ok(openSettingsIndex >= 0, '必须注册 settings:open IPC')

  const handlerSource = extractFunction(indexSource, 'function openSettingsFromPopup()')
  assert.match(
    handlerSource,
    /beginPopupSettingsOpenGuard\(\)/u,
    '处理打开设置请求时必须先进入弹窗失焦保护'
  )
  assert.match(handlerSource, /openSettings\(\)/u, '打开设置请求必须调用 openSettings')
  assert.ok(
    handlerSource.indexOf('beginPopupSettingsOpenGuard()') <
      handlerSource.indexOf('openSettings()'),
    '必须先开启保护再打开设置窗口'
  )
  // 打开失败时设置窗口不会产生 focus/blur 生命周期事件，保护必须自行解除，
  // 否则弹窗会永久忽略失焦，退回「点外部不消失」。
  assert.match(
    handlerSource,
    /catch[\s\S]*?endPopupSettingsOpenGuard\(\)/u,
    '打开设置失败时必须解除弹窗失焦保护'
  )
})

test('设置窗口生命周期必须正确开关弹窗失焦保护', () => {
  const createSource = extractFunction(indexSource, 'async function createSettingsWindow(')

  const focusIndex = createSource.indexOf("settingsWin.on('focus'")
  const blurIndex = createSource.indexOf("settingsWin.on('blur'")
  const hideIndex = createSource.indexOf("settingsWin.on('hide'")
  const closedIndex = createSource.indexOf("settingsWin.on('closed'")
  assert.ok(focusIndex >= 0 && blurIndex > focusIndex, '必须监听设置窗口 focus 与 blur')
  assert.ok(hideIndex > blurIndex, '必须监听设置窗口 hide')
  assert.ok(closedIndex > hideIndex, '必须监听设置窗口 closed')

  const focusBlock = createSource.slice(focusIndex, blurIndex)
  const blurBlock = createSource.slice(blurIndex, hideIndex)
  const hideBlock = createSource.slice(hideIndex, closedIndex)
  const closedBlock = createSource.slice(closedIndex)

  // 复用已可见窗口时 focus 事件可能不再派发，因此 IPC 入口已提前开启保护；
  // focus 时再次开启用于重置保护，确保随后到来的失焦一定被吸收。
  assert.match(focusBlock, /beginPopupSettingsOpenGuard\(\)/u, '设置窗口获得焦点时必须进入保护')
  assert.match(blurBlock, /endPopupSettingsOpenGuard\(\)/u, '设置窗口失焦时必须解除保护')
  assert.match(hideBlock, /endPopupSettingsOpenGuard\(\)/u, '设置窗口隐藏时必须解除保护')
  assert.match(closedBlock, /endPopupSettingsOpenGuard\(\)/u, '设置窗口销毁时必须解除保护')
})

test('保护期内点击设置窗口不得被判定为弹窗外部点击', () => {
  const pointerSource = extractFunction(indexSource, 'function handleSelectionPointerDown(')

  // 设置窗口 focus 事件可能晚于全局 mousedown 到达，此时 isFocused() 仍为 false，
  // 仅依赖焦点判定会把点击设置页误判为外部点击并关闭翻译弹窗。
  assert.match(
    pointerSource,
    /isPopupSettingsOpenGuardActive\(\)/u,
    '全局按下判定必须识别设置打开保护状态'
  )
  assert.match(
    pointerSource,
    /isPointInsideVisibleSettingsWindow\(/u,
    '保护期内必须按设置窗口可见矩形识别应用内点击'
  )
  assert.match(
    pointerSource,
    /const settingsWindowHit = isPopupSettingsOpenGuardActive\(\)\s*&&\s*isPointInsideVisibleSettingsWindow\(point\)/u,
    '设置窗口命中只能由保护状态与可见矩形决定，不能依赖迟到的应用激活事件'
  )
  // 设置窗口已经获得焦点后，macOS 的 did-become-active 仍可能晚于全局 mousedown；
  // 若在命中判定中叠加应用激活事件门禁，本次点击会被误分类为 track，随后
  // dismissPopupOnExternalPointerDown → hidePopup 会把前台交还给源应用并关掉设置页。
  assert.doesNotMatch(
    pointerSource,
    /resolveAppFrontmostForExclusion\(/u,
    '设置窗口内部按下不得受应用激活事件门禁影响'
  )

  const guardIndex = pointerSource.indexOf('isPopupSettingsOpenGuardActive()')
  const classifyIndex = pointerSource.indexOf('classifySelectionPointerDown(')
  assert.ok(guardIndex >= 0 && classifyIndex > guardIndex, '保护判定必须早于按下分类')
})

test('设置窗口失焦后再次获得焦点必须重新进入保护期', () => {
  const createSource = extractFunction(indexSource, 'async function createSettingsWindow(')
  const focusIndex = createSource.indexOf("settingsWin.on('focus'")
  const blurIndex = createSource.indexOf("settingsWin.on('blur'")
  assert.ok(focusIndex >= 0 && blurIndex > focusIndex, '必须监听设置窗口 focus 与 blur')

  // 用户先点击其它应用让设置窗口失焦（保护解除），随后再次点击仍打开的设置页时，
  // 只会派发 focus 而不会再走 IPC 入口；若不在此重新开启保护，第二次点击设置页
  // 又会被全局按下误判为弹窗外部点击，弹窗被一起关闭，问题复发。
  const focusBlock = createSource.slice(focusIndex, blurIndex)
  assert.match(
    focusBlock,
    /beginPopupSettingsOpenGuard\(\)/u,
    '设置窗口每次获得焦点都必须重新进入保护期'
  )
})
