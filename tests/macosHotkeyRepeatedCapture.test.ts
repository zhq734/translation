import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  shouldActivatePopupForCaptureFailure,
  shouldRestoreForegroundBeforeCapture
} from '../src/shared/popupForeground.ts'

const indexSource = readFileSync('src/main/index.ts', 'utf8')
const popupSource = readFileSync('src/main/popup.ts', 'utf8')

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
 * 校验 Windows 取词归还前台判定保持原行为，macOS 不再交还应用前台。
 * @returns 无返回值。
 * @author zhenghq
 */
test('取词归还前台判定只保留 Windows 语义', () => {
  assert.equal(shouldRestoreForegroundBeforeCapture('win32', true), true)
  assert.equal(shouldRestoreForegroundBeforeCapture('win32', false), false)
  assert.equal(shouldRestoreForegroundBeforeCapture('darwin', true), false)
  assert.equal(shouldRestoreForegroundBeforeCapture('linux', true), false)
})

/**
 * 校验 macOS 失败提示不需要激活弹窗，避免 panel 下抢键盘焦点。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 失败提示不激活弹窗，Windows 保持原行为', () => {
  assert.equal(shouldActivatePopupForCaptureFailure('darwin'), false)
  assert.equal(shouldActivatePopupForCaptureFailure('win32'), true)
  assert.equal(shouldActivatePopupForCaptureFailure('linux'), true)
})

/**
 * 校验读取弹窗在需要归还前台的平台（Windows）先调用失活，再显示读取弹窗。
 * macOS panel 下该判定返回 false，不会调用失活。
 * @returns 无返回值。
 * @author zhenghq
 */
test('showSelectionReadingPopup 应在需要归还前台时先让弹窗退出前台', () => {
  const src = readingPopupSource()
  assert.match(
    src,
    /shouldRestoreForegroundBeforeCapture\(\s*process\.platform\s*,\s*isPopupActivated\(\)\s*\)/u,
    '必须按平台与弹窗激活状态判定是否需要归还前台'
  )
  const deactivateIndex = src.indexOf('deactivatePopupForCapture()')
  const showIndex = src.indexOf('showPopup(')
  assert.ok(deactivateIndex >= 0, '必须调用 deactivatePopupForCapture')
  assert.ok(showIndex > deactivateIndex, '失活必须发生在显示读取弹窗之前')
})

/**
 * 校验 deactivatePopupForCapture 仅 Windows 生效，macOS panel 直接跳过。
 * @returns 无返回值。
 * @author zhenghq
 */
test('主动失活仅在 Windows 生效', () => {
  const src = deactivateSource()
  assert.match(src, /process\.platform !== 'win32'/u, '必须限定仅 Windows 生效')
  assert.match(src, /foregroundTracker\.restore\(\)/u, 'Windows 必须精确交还前台窗口')
  assert.match(src, /win\.blur\(\)/u, '交还失败时仍应保留 blur 兜底')
})

/**
 * 校验 macOS 二次取词不再等待应用级前台交还，直接取词。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 二次取词不得再等待应用级前台交还', () => {
  const start = indexSource.indexOf('function onHotkey')
  const end = indexSource.indexOf('/**\n * 响应全局 OCR 快捷键', start)
  assert.ok(start >= 0 && end > start, 'onHotkey 应有结束边界')
  const src = indexSource.slice(start, end)
  assert.doesNotMatch(src, /waitForFrontmostAppReturn\(\)/u, 'panel 下不得等待应用级前台交还')
  assert.match(src, /queueSelectionTranslation\(/u, '取词必须继续正常触发')
})
