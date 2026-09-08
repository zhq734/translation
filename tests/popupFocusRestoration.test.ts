import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const indexSource = readFileSync('src/main/index.ts', 'utf8')
const popupSource = readFileSync('src/main/popup.ts', 'utf8')

/**
 * 提取 showSelectionReadingPopup 函数体源码片段。
 * @returns 函数体源码字符串。
 * @author zhenghq
 */
function showSelectionReadingPopupSource(): string {
  const start = indexSource.indexOf('function showSelectionReadingPopup')
  const end = indexSource.indexOf('/**\n * 捕获当前选中文字', start)
  assert.ok(start >= 0, 'showSelectionReadingPopup 函数应存在')
  assert.ok(end > start, 'showSelectionReadingPopup 函数应有结束边界')
  return indexSource.slice(start, end)
}

/**
 * 提取 showPopup 函数体源码片段。
 * @returns 函数体源码字符串。
 * @author zhenghq
 */
function showPopupSource(): string {
  const start = popupSource.indexOf('export function showPopup')
  const end = popupSource.indexOf('/**\n * 显示手动翻译界面', start)
  assert.ok(start >= 0, 'showPopup 函数应存在')
  assert.ok(end > start, 'showPopup 函数应有结束边界')
  return popupSource.slice(start, end)
}

/**
 * 校验 showSelectionReadingPopup 在弹窗已可见且已激活时先 hidePopup 归还焦点再 showPopup(activate=false) 重显。
 * @returns 无返回值。
 * @author zhenghq
 */
test('弹窗已可见且已激活时 showSelectionReadingPopup 应先 hidePopup 再以非激活方式重显', () => {
  const src = showSelectionReadingPopupSource()
  // 必须在 showPopup 之前检查 isPopupVisible 并调用 hidePopup
  assert.match(src, /isPopupVisible\(\)/u, '应检查弹窗是否已可见')
  assert.match(src, /hidePopup\(\)/u, '弹窗已可见时应先调用 hidePopup 归还焦点')
  // hidePopup 必须在 showPopup 之前
  const hideIdx = src.indexOf('hidePopup()')
  const showIdx = src.indexOf('showPopup(')
  assert.ok(hideIdx >= 0 && showIdx >= 0 && hideIdx < showIdx, 'hidePopup 必须在 showPopup 之前调用')
  // showPopup 必须以 activate=false 调用
  assert.match(src, /showPopup\([\s\S]*?,\s*false\s*\)/u, 'showPopup 必须以 activate=false 调用')
})

/**
 * 校验弹窗已可见且已被激活（shownInactive=false）时，showSelectionReadingPopup 会触发 hidePopup，
 * 随后 showPopup 以 activate=false 走 !alreadyVisible 分支调用 win.showInactive 而非 win.show。
 * @returns 无返回值。
 * @author zhenghq
 */
test('弹窗已激活时 showSelectionReadingPopup 应触发 hide 使 showPopup 走 showInactive 分支', () => {
  const popupSrc = showPopupSource()
  // showPopup 的 !alreadyVisible 分支必须根据 activate 选择 show 或 showInactive
  assert.match(
    popupSrc,
    /if \(!alreadyVisible\) \{[\s\S]*?activate \? win\.show\(\) : win\.showInactive\(\)/u,
    'showPopup 首次显示分支必须根据 activate 选择 show/showInactive'
  )
  // showSelectionReadingPopup 必须在弹窗可见且已激活时先 hidePopup
  const src = showSelectionReadingPopupSource()
  assert.match(src, /isPopupVisible\(\)\s*&&\s*isPopupActivated\(\)/u,
    '应在弹窗可见且已激活时才 hidePopup')
})

/**
 * 校验 popup.ts 导出 isPopupActivated 函数，用于外部查询弹窗是否已激活（非 showInactive）。
 * @returns 无返回值。
 * @author zhenghq
 */
test('popup.ts 应导出 isPopupActivated 供外部查询弹窗激活状态', () => {
  assert.match(popupSource, /export function isPopupActivated\(\)/u,
    '应导出 isPopupActivated 函数')
  // isPopupActivated 必须在弹窗可见且 shownInactive=false 时返回 true
  const fnStart = popupSource.indexOf('export function isPopupActivated()')
  const fnEnd = popupSource.indexOf('\n}', fnStart)
  const fnBody = popupSource.slice(fnStart, fnEnd + 2)
  assert.match(fnBody, /isVisible|win\.isVisible/u, '必须检查弹窗可见性')
  assert.match(fnBody, /shownInactive/u, '必须检查 shownInactive 标记')
})

/**
 * 校验弹窗已可见且未激活（shownInactive=true）时，showSelectionReadingPopup 不调用 hidePopup，
 * 仅更新内容，焦点保持在源应用。
 * @returns 无返回值。
 * @author zhenghq
 */
test('弹窗已可见且未激活时 showSelectionReadingPopup 不应调用 hidePopup', () => {
  const src = showSelectionReadingPopupSource()
  // hidePopup 必须在 isPopupVisible() && isPopupActivated() 条件内
  // 这样弹窗可见但未激活（isPopupActivated 返回 false）时不会执行 hidePopup
  assert.match(src, /if\s*\(isPopupVisible\(\)\s*&&\s*isPopupActivated\(\)\)\s*\{[\s\S]*?hidePopup\(\)/u,
    'hidePopup 必须在 isPopupVisible && isPopupActivated 条件内，确保未激活时不隐藏')
})

/**
 * 校验弹窗不可见时 showSelectionReadingPopup 不调用 hidePopup，直接 showPopup(activate=false)。
 * @returns 无返回值。
 * @author zhenghq
 */
test('弹窗不可见时 showSelectionReadingPopup 应直接 showPopup 且不 hidePopup', () => {
  const src = showSelectionReadingPopupSource()
  assert.match(src, /showPopup\([\s\S]*?,\s*false\s*\)/u, '应以 activate=false 调用 showPopup')
  // hidePopup 应只在弹窗可见且已激活的条件分支内，不在无条件路径
  assert.match(src, /if\s*\(isPopupVisible\(\)\s*&&\s*isPopupActivated\(\)\)/u,
    'hidePopup 应仅在弹窗可见且已激活时执行')
})
