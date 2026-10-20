import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const indexSource = readFileSync('src/main/index.ts', 'utf8')
const popupSource = readFileSync('src/main/popup.ts', 'utf8')
const selectionButtonSource = readFileSync('src/main/selectionButton.ts', 'utf8')

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
 * 去掉源码注释，避免注释文本干扰接线断言。
 * @param source 源码。
 * @returns 移除注释后的源码。
 * @author zhenghq
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

test('选区按钮创建入口必须接收内部窗口隐藏通知回调', () => {
  const createSource = stripComments(
    extractFunction(selectionButtonSource, 'export function createSelectionButton(')
  )
  assert.match(
    createSource,
    /onInternalWindowHidden\?:\s*\(\)\s*=>\s*void/u,
    'createSelectionButton 必须接收内部窗口隐藏通知回调，与 createPopup 对称'
  )
})

test('隐藏选区按钮必须在真实 win.hide() 处触发隐藏通知回调', () => {
  const hideSource = stripComments(
    extractFunction(selectionButtonSource, 'export function hideSelectionButton(')
  )
  const notifyIndex = hideSource.indexOf('notifyInternalWindowHidden()')
  const hideIndex = hideSource.indexOf('win?.hide()')

  assert.ok(notifyIndex >= 0, '隐藏选区按钮必须调用内部窗口隐藏通知')
  assert.ok(hideIndex >= 0, '隐藏选区按钮必须保留真实 win.hide() 调用')
  // 抑制必须覆盖隐藏之后系统补发的迟到 activate，因此通知不得早于 hide()。
  assert.ok(notifyIndex > hideIndex, '隐藏通知必须发生在 win.hide() 之后')
})

test('主进程创建选区按钮时必须注入 activate 抑制续期回调', () => {
  const readySource = extractFunction(indexSource, 'async function onReady(')
  assert.match(
    readySource,
    /createSelectionButton\(\s*PRELOAD_PATH\s*,\s*suppressSelectionActivationWindowGap\s*\)/u,
    'createSelectionButton 必须注入 suppressSelectionActivationWindowGap，与 createPopup 对称'
  )
})

test('翻译弹窗隐藏必须在真实 win.hide() 后续期 activate 抑制', () => {
  const hideSource = stripComments(
    extractFunction(popupSource, 'export function hidePopup(')
  )
  const notifyIndex = hideSource.indexOf('notifyInternalWindowShown()')
  const hideIndex = hideSource.indexOf('win?.hide()')

  assert.ok(notifyIndex >= 0, '隐藏弹窗必须续期 activate 抑制')
  assert.ok(hideIndex >= 0, '隐藏弹窗必须保留真实 win.hide() 调用')
  assert.ok(notifyIndex > hideIndex, '弹窗续期必须发生在 win.hide() 之后')
})

test('activate 路径复用已可见设置页不得提升到 screen-saver 层级', () => {
  const createStart = indexSource.indexOf('async function createSettingsWindow(')
  const createEnd = indexSource.indexOf('/**\n * 打开设置窗口。', createStart)
  assert.ok(createStart >= 0 && createEnd > createStart)
  const createSource = stripComments(indexSource.slice(createStart, createEnd))

  const visibleIndex = createSource.indexOf('if (settingsWin.isVisible()) {')
  assert.ok(visibleIndex >= 0, '复用分支必须保留可见性判断')
  const visibleBranch = createSource.slice(visibleIndex, visibleIndex + 600)

  // activate 路径复用已可见设置页时，最高层级提升是“把设置页顶到最前”的直接
  // 放大器：它会对普通窗口执行 show()+moveTop()+focus()+screen-saver。该分支
  // 必须改为不提升层级的窗口级置前。
  assert.doesNotMatch(
    visibleBranch,
    /showOwnWindowForInteraction\(settingsWin,\s*\{\s*raiseLevel:\s*true\s*\}\)/u,
    'activate 路径复用已可见设置页不得执行 raiseLevel: true'
  )
  assert.match(
    visibleBranch,
    /showOwnWindowForInteraction\(settingsWin,\s*\{\s*raiseLevel:\s*(?:false|explicitPopupSource)\s*\}\)/u,
    '复用已可见设置页必须改为不提升层级的窗口级置前'
  )
})

test('弹窗内显式点击设置入口仍保留层级提升', () => {
  const createStart = indexSource.indexOf('async function createSettingsWindow(')
  const createEnd = indexSource.indexOf('/**\n * 打开设置窗口。', createStart)
  const createSource = stripComments(indexSource.slice(createStart, createEnd))

  assert.match(createSource, /const explicitPopupSource = source === 'popup'/u,
    '必须显式识别弹窗内点击来源')
  // 显式入口仍可越过层级，保证“点了没反应”不会回归。
  assert.match(
    createSource,
    /raiseLevel:\s*explicitPopupSource/u,
    '弹窗内显式点击设置仍必须保留层级提升'
  )
})
