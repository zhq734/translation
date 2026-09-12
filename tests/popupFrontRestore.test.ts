import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { shouldActivatePopupForCaptureFailure } from '../src/shared/popupForeground.ts'

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

const popupSource = readFileSync('src/main/popup.ts', 'utf8')
const mainSource = readFileSync('src/main/index.ts', 'utf8')

test('弹窗隐藏前先把 macOS 前台交还出去', () => {
  const hideSource = extractFunction(popupSource, 'export function hidePopup(): void {')

  // 弹窗通常是应用内最后一个 key window：直接隐藏会让系统把设置页提升为 key window 并顶到最前。
  assert.match(hideSource, /handBackFrontmostThen\(win, \(\) => \{/u, '必须复用共享交还逻辑')
  assert.match(hideSource, /hidingAfterFrontReturn = true/u, '交还期间必须标记为逻辑关闭')
  assert.match(hideSource, /win\?\.hide\(\)/u, '交还完成后才隐藏窗口')
  // 激活源应用会让弹窗失焦，不能被 handlePopupBlur 当成用户点击外部而重复关闭。
  assert.ok(
    hideSource.indexOf('restoringForegroundUntil = Date.now()') <
      hideSource.indexOf('handBackFrontmostThen(win'),
    '必须在交还前台之前标记这段失焦为内部动作'
  )
  // 交还期间再次调用不能重复发起交还，否则会把用户当前在用的应用换掉。
  assert.match(hideSource, /hidingAfterFrontReturn\) return/u, '交还进行中必须短路重复隐藏')
})

test('交还期间的弹窗按已关闭对待，避免复用即将隐藏的窗口', () => {
  const visibleSource = extractFunction(popupSource, 'export function isPopupVisible(): boolean {')
  const activatedSource = extractFunction(popupSource, 'export function isPopupActivated(): boolean {')
  const showSource = extractFunction(popupSource, 'export function showPopup(')
  const createSource = extractFunction(popupSource, 'export function createPopup(preloadPath: string): BrowserWindow {')

  assert.match(visibleSource, /!hidingAfterFrontReturn/u, '可见状态必须排除交还期间')
  assert.match(activatedSource, /!hidingAfterFrontReturn/u, '激活状态必须排除交还期间')
  // 弹窗仍可见但正在交还时，新请求必须按「未显示」处理，否则会复用即将隐藏的窗口。
  assert.match(
    showSource,
    /const alreadyVisible = win\.isVisible\(\) && !hidingAfterFrontReturn/u,
    '显示判定必须排除交还期间'
  )
  // 重建窗口时必须复位，否则新窗口会一直被认为正在交还。
  assert.match(createSource, /hidingAfterFrontReturn = false/u, '创建窗口时必须复位交还标记')
})

test('划词弹窗显示前记录源应用，供最终隐藏时交还', () => {
  const readingSource = extractFunction(mainSource, 'function showSelectionReadingPopup(')

  // 此刻本应用还不是前台应用，读到的就是用户原本在用的应用。
  assert.match(readingSource, /rememberFrontmostAppIfInactive\(\)/u, '必须记录源应用')
  assert.ok(
    readingSource.indexOf('rememberFrontmostAppIfInactive()') <
      readingSource.indexOf('showPopup('),
    '必须在显示弹窗之前记录源应用'
  )
})

/**
 * 截取 handleSelectionCaptureResult 中「未取到文字」提示分支的源码。
 * @returns 从失败分支开始到提示弹窗调用结束的源码片段。
 * @author zhenghq
 */
function selectionCaptureFailureSource(): string {
  const start = mainSource.indexOf('if (!result.text) {')
  const end = mainSource.indexOf('if (shouldPromptHiServicesRepair)', start)
  assert.ok(start >= 0, 'handleSelectionCaptureResult 应有取词失败分支')
  assert.ok(end > start, '取词失败分支应有结束边界')
  return mainSource.slice(start, end)
}

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
