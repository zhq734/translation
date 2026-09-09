import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  POPUP_FOREGROUND_RESTORE_SETTLE_MS,
  shouldRestoreForegroundBeforeCapture
} from '../src/shared/popupForeground.ts'
import { shouldDismissPopupOnBlur } from '../src/shared/popupBehavior.ts'

const popupSource = readFileSync('src/main/popup.ts', 'utf8')
const indexSource = readFileSync('src/main/index.ts', 'utf8')

/**
 * 截取 index.ts 中 showSelectionReadingPopup 的函数体源码。
 * @returns 函数体源码字符串。
 * @author zhenghq
 */
function readingPopupSource(): string {
  const start = indexSource.indexOf('function showSelectionReadingPopup')
  const end = indexSource.indexOf('/**\n * 捕获当前选中文字', start)
  assert.ok(start >= 0, 'showSelectionReadingPopup 应存在')
  assert.ok(end > start, 'showSelectionReadingPopup 应有结束边界')
  return indexSource.slice(start, end)
}

/**
 * 截取 popup.ts 中 deactivatePopupForCapture 的函数体源码。
 * @returns 函数体源码字符串。
 * @author zhenghq
 */
function deactivateSource(): string {
  const start = popupSource.indexOf('export function deactivatePopupForCapture')
  assert.ok(start >= 0, 'deactivatePopupForCapture 应存在')
  const end = popupSource.indexOf('\n}', start)
  assert.ok(end > start, 'deactivatePopupForCapture 应有结束边界')
  return popupSource.slice(start, end + 2)
}

/**
 * 校验只有 Windows 且弹窗已激活时才需要在取词前归还前台焦点。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 弹窗已激活时取词前必须归还前台焦点', () => {
  assert.equal(shouldRestoreForegroundBeforeCapture('win32', true), true)
  assert.equal(shouldRestoreForegroundBeforeCapture('win32', false), false)
  assert.equal(shouldRestoreForegroundBeforeCapture('darwin', true), false)
  assert.equal(shouldRestoreForegroundBeforeCapture('linux', true), false)
})

/**
 * 校验归还焦点等待时间为正数，保证前台应用能在注入复制键前重新拿到焦点。
 * @returns 无返回值。
 * @author zhenghq
 */
test('归还前台焦点后应保留正数等待时间', () => {
  assert.ok(POPUP_FOREGROUND_RESTORE_SETTLE_MS > 0, '等待时间必须为正数')
})

/**
 * 校验主动归还焦点触发的失焦事件不会关闭弹窗，避免弹窗闪烁消失。
 * @returns 无返回值。
 * @author zhenghq
 */
test('主动归还前台焦点期间的失焦不应关闭弹窗', () => {
  assert.equal(shouldDismissPopupOnBlur(false), true)
  assert.equal(shouldDismissPopupOnBlur(true), false)
  assert.equal(shouldDismissPopupOnBlur(false, true), false)
  assert.equal(shouldDismissPopupOnBlur(true, true), false)
})

/**
 * 校验 popup.ts 导出主动失活函数：调用 win.blur 并把弹窗标记为非激活。
 * @returns 无返回值。
 * @author zhenghq
 */
test('popup.ts 应导出 deactivatePopupForCapture 主动归还前台焦点', () => {
  const src = deactivateSource()
  assert.match(src, /win\.blur\(\)/u, '必须调用 win.blur 让弹窗退出前台')
  assert.match(src, /shownInactive = true/u, '必须把弹窗标记为非激活')
  assert.match(src, /return (true|false)/u, '必须返回是否执行了失活')
})

/**
 * 校验弹窗失焦处理在归还焦点期间被短路，不调用 hidePopup。
 * @returns 无返回值。
 * @author zhenghq
 */
test('弹窗失焦处理应把归还焦点状态传入 shouldDismissPopupOnBlur', () => {
  const start = popupSource.indexOf('function handlePopupBlur')
  const end = popupSource.indexOf('\n}', start)
  const src = popupSource.slice(start, end + 2)
  assert.match(src, /shouldDismissPopupOnBlur\(\s*pinned\s*,\s*\w+/u,
    '失焦判定必须携带归还焦点状态')
})

/**
 * 校验取词前的读取弹窗会先在 Windows 上归还前台焦点，再显示读取状态。
 * @returns 无返回值。
 * @author zhenghq
 */
test('showSelectionReadingPopup 应在取词前归还 Windows 前台焦点', () => {
  const src = readingPopupSource()
  assert.match(src, /shouldRestoreForegroundBeforeCapture\(\s*process\.platform\s*,\s*isPopupActivated\(\)\s*\)/u,
    '必须按平台与弹窗激活状态判定是否归还焦点')
  assert.match(src, /deactivatePopupForCapture\(\)/u, '必须调用 deactivatePopupForCapture')
  const restoreIndex = src.indexOf('deactivatePopupForCapture()')
  const showIndex = src.indexOf('showPopup(')
  assert.ok(restoreIndex >= 0 && showIndex > restoreIndex,
    '归还焦点必须发生在 showPopup 之前')
})

/**
 * 校验按钮取词在归还焦点后等待前台应用重新拿到焦点，再执行复制取词。
 * @returns 无返回值。
 * @author zhenghq
 */
test('按钮取词在归还焦点后应等待前台焦点稳定', () => {
  const start = indexSource.indexOf('async function translateSelectionButton')
  const end = indexSource.indexOf('/**\n * 处理取词结果', start)
  const src = indexSource.slice(start, end)
  assert.match(src, /POPUP_FOREGROUND_RESTORE_SETTLE_MS/u,
    '按钮取词必须等待归还焦点稳定时间')
})

/**
 * 校验弹窗激活前先记录源应用前台窗口，否则取词时无法精确交还焦点。
 * @returns 无返回值。
 * @author zhenghq
 */
test('弹窗激活前必须记录源应用前台窗口', () => {
  const start = popupSource.indexOf('export function showPopup(')
  const end = popupSource.indexOf('export function showManualTranslationPopup', start)
  const src = popupSource.slice(start, end)
  const rememberIndex = src.indexOf('foregroundTracker.remember()')
  const showIndex = src.indexOf('win.show()')
  assert.ok(rememberIndex >= 0, '激活分支必须记录源应用前台窗口')
  assert.ok(showIndex > rememberIndex, '记录必须发生在 win.show() 之前')
})

/**
 * 校验失活优先用记录的窗口精确交还焦点，仅在失败时退回 blur。
 * @returns 无返回值。
 * @author zhenghq
 */
test('失活应优先精确交还焦点并在失败时退回 blur', () => {
  const src = deactivateSource()
  const restoreIndex = src.indexOf('foregroundTracker.restore()')
  const blurIndex = src.indexOf('win.blur()')
  assert.ok(restoreIndex >= 0, '必须尝试精确交还焦点')
  assert.ok(blurIndex > restoreIndex, 'blur 只能作为交还失败后的兜底')
  assert.match(src, /if \(!restored\) win\.blur\(\)/u, 'blur 必须以交还失败为条件')
})
