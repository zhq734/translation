import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  shouldDeactivatePopupBeforeMacCapture,
  shouldRestoreForegroundBeforeCapture
} from '../src/shared/popupForeground.ts'

const indexSource = readFileSync('src/main/index.ts', 'utf8')
const popupSource = readFileSync('src/main/popup.ts', 'utf8')
const macForegroundSource = readFileSync('src/main/macForeground.ts', 'utf8')

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
 * 校验 macOS 弹窗已激活时同样需要在取词前主动归还前台焦点。
 * 第一次取词成功后结果弹窗会用 win.show() 激活本应用，第二次按快捷键时
 * 注入的复制键会打在弹窗上，剪贴板哨兵不变而报取词超时。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 弹窗已激活时取词前必须主动归还前台焦点', () => {
  assert.equal(shouldDeactivatePopupBeforeMacCapture('darwin', true), true)
  assert.equal(shouldDeactivatePopupBeforeMacCapture('darwin', false), false)
  assert.equal(shouldDeactivatePopupBeforeMacCapture('win32', true), false)
  assert.equal(shouldDeactivatePopupBeforeMacCapture('linux', true), false)
})

/**
 * 校验原有 Windows 判定不受影响。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 取词归还前台判定保持原行为', () => {
  assert.equal(shouldRestoreForegroundBeforeCapture('win32', true), true)
  assert.equal(shouldRestoreForegroundBeforeCapture('darwin', true), false)
})

/**
 * 校验读取弹窗在 macOS 弹窗已激活时调用主动失活，把焦点交还给源应用。
 * @returns 无返回值。
 * @author zhenghq
 */
test('showSelectionReadingPopup 应在 macOS 上先让结果弹窗退出前台', () => {
  const src = readingPopupSource()
  assert.match(
    src,
    /shouldDeactivatePopupBeforeMacCapture\(\s*process\.platform\s*,\s*isPopupActivated\(\)\s*\)/u,
    '必须按平台与弹窗激活状态判定是否需要主动失活'
  )
  const deactivateIndex = src.indexOf('deactivatePopupForCapture()')
  const showIndex = src.indexOf('showPopup(')
  assert.ok(deactivateIndex >= 0, '必须调用 deactivatePopupForCapture')
  assert.ok(showIndex > deactivateIndex, '失活必须发生在显示读取弹窗之前')
})

/**
 * 校验 macOS 主动失活走前台交还而非仅 blur：blur 不保证回到源应用。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 主动失活必须优先精确交还前台应用', () => {
  const src = deactivateSource()
  assert.match(src, /restoreFrontmostAppForCapture/u, 'macOS 必须调用前台交还逻辑')
  assert.match(src, /process\.platform === 'darwin'/u, '必须按平台选择交还实现')
  assert.match(src, /win\.blur\(\)/u, '非 macOS 或交还失败时仍应保留 blur 兜底')
})

/**
 * 校验快捷键在交还前台后按应用失活轮询，而不是只等固定延时。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 二次取词必须等前台真正交还后再取词', () => {
  const start = indexSource.indexOf('function onHotkey')
  const end = indexSource.indexOf('/**\n * 响应全局 OCR 快捷键', start)
  assert.ok(start >= 0 && end > start, 'onHotkey 应有结束边界')
  const src = indexSource.slice(start, end)
  assert.match(src, /waitForFrontmostAppReturn\(\)/u, '必须等待前台真正交还')
  assert.ok(
    src.indexOf('waitForFrontmostAppReturn()') < src.indexOf('queueSelectionTranslation(undefined, undefined, false, popupCloseVersion)'),
    '等待必须发生在取词之前'
  )
})

/**
 * 校验前台交还等待按应用失活轮询且带超时兜底，不会永久挂起取词。
 * @returns 无返回值。
 * @author zhenghq
 */
test('前台交还等待必须按应用失活轮询并有超时兜底', () => {
  const start = macForegroundSource.indexOf('export function waitForFrontmostAppReturn')
  assert.ok(start >= 0, 'waitForFrontmostAppReturn 应存在')
  const end = macForegroundSource.indexOf('\n}', start)
  const src = macForegroundSource.slice(start, end + 2)
  assert.match(src, /isMacAppActiveByEvents\(\)/u, '必须依据应用激活事件判断是否已失活')
  assert.match(src, /setTimeout\(poll, FRONT_RETURN_POLL_INTERVAL_MS\)/u, '必须轮询')
  assert.match(src, /resolve\(false\)/u, '超时后必须返回 false 继续取词')
})
