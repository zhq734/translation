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
 * 校验 showSelectionReadingPopup 不调用 hidePopup，直接以 activate=false 调用 showPopup。
 * 弹窗已可见且已激活时，由 showPopup 的降级分支处理焦点归还，不关闭弹窗。
 * @returns 无返回值。
 * @author zhenghq
 */
test('showSelectionReadingPopup 不调用 hidePopup，直接 showPopup(activate=false)', () => {
  const src = showSelectionReadingPopupSource()
  assert.doesNotMatch(src, /hidePopup\(\)/u, '不应调用 hidePopup 关闭弹窗')
  assert.match(src, /showPopup\([\s\S]*?,\s*false\s*\)/u, '应以 activate=false 调用 showPopup')
})

/**
 * 校验 showPopup 新增降级分支：弹窗已可见且已激活，activate=false 时调用 showInactive 归还焦点。
 * @returns 无返回值。
 * @author zhenghq
 */
test('showPopup 应在弹窗已可见且已激活且 activate=false 时降级为 showInactive', () => {
  const src = showPopupSource()
  assert.match(src, /!activate && !shownInactive && alreadyVisible/u,
    '应有降级分支条件：!activate && !shownInactive && alreadyVisible')
  assert.match(src, /win\.showInactive\(\)/u, '降级分支应调用 showInactive')
})

/**
 * 校验翻译结果到达时 showPopup 仍调用 win.show() 激活弹窗（跟 macOS 一致，blur 可触发关闭）。
 * @returns 无返回值。
 * @author zhenghq
 */
test('翻译结果到达时 showPopup 调用 win.show 激活弹窗保持与 macOS 一致', () => {
  const src = showPopupSource()
  assert.match(src, /activate \? win\.show\(\) : win\.showInactive\(\)/u,
    '首次显示应根据 activate 选择 show/showInactive')
  // 激活前会先记录源应用前台窗口，供取词时精确交还焦点，因此允许 win.show 之前存在该调用。
  assert.match(src, /else if \(activate && shownInactive\)\s*\{[\s\S]*?win\.show\(\)/u,
    '弹窗已可见且 shownInactive 时应 win.show() 激活')
})

/**
 * 校验 popup.ts 导出 isPopupActivated 函数。
 * @returns 无返回值。
 * @author zhenghq
 */
test('popup.ts 应导出 isPopupActivated 供外部查询弹窗激活状态', () => {
  assert.match(popupSource, /export function isPopupActivated\(\)/u,
    '应导出 isPopupActivated 函数')
  const fnStart = popupSource.indexOf('export function isPopupActivated()')
  const fnEnd = popupSource.indexOf('\n}', fnStart)
  const fnBody = popupSource.slice(fnStart, fnEnd + 2)
  assert.match(fnBody, /isVisible|win\.isVisible/u, '必须检查弹窗可见性')
  assert.match(fnBody, /shownInactive/u, '必须检查 shownInactive 标记')
})
