import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { isPointInPopupDragRegion } from '../src/shared/popupDragBehavior.ts'

const popupHtml = readFileSync('src/renderer/index.html', 'utf8')
const popupStyles = readFileSync('src/renderer/src/style.css', 'utf8')
const popupMain = readFileSync('src/main/popup.ts', 'utf8')

test('翻译弹窗应提供独立且足够宽的顶部拖动区域', () => {
  const dragHandleIndex = popupHtml.indexOf('class="drag-handle"')
  const headerIndex = popupHtml.indexOf('class="header"')

  assert.ok(dragHandleIndex >= 0, '弹窗应包含独立拖动区域')
  assert.ok(dragHandleIndex < headerIndex, '拖动区域应位于交互控件上方，避免被控件覆盖')
  assert.match(
    popupStyles,
    /\.drag-handle\s*\{[^}]*width:\s*100%;[^}]*min-height:\s*20px;[^}]*-webkit-app-region:\s*drag;/su
  )
  assert.match(popupMain, /movable:\s*true/u)
  assert.match(popupMain, /acceptFirstMouse:\s*true/u)
})

test('翻译弹窗控件应保持非拖动区域且拖动能力不依赖固定状态', () => {
  assert.match(
    popupStyles,
    /\.language-picker,\s*\.header-actions,[^}]*\{[^}]*-webkit-app-region:\s*no-drag;/su
  )
  assert.doesNotMatch(popupStyles, /\[aria-pressed=['"]true['"]\][^{]*\.drag-handle/su)
})

/**
 * 校验未固定弹窗在原生拖拽区域失焦时不会被误判为外部点击。
 * @returns 无返回值。
 * @author zhenghq
 */
test('未固定弹窗的顶部拖拽区域应能识别正在进行的窗口拖拽', () => {
  const bounds = { x: 100, y: 200, width: 460, height: 360 }

  assert.equal(isPointInPopupDragRegion({ x: 200, y: 205 }, bounds), true)
  assert.equal(isPointInPopupDragRegion({ x: 200, y: 220 }, bounds), true)
  assert.equal(isPointInPopupDragRegion({ x: 200, y: 240 }, bounds), false)
  assert.equal(isPointInPopupDragRegion({ x: 80, y: 205 }, bounds), false)
})

/**
 * 校验弹窗失焦处理会在拖拽区域读取鼠标屏幕坐标，避免未固定弹窗被拖拽时关闭。
 * @returns 无返回值。
 * @author zhenghq
 */
test('弹窗失焦处理应排除顶部原生拖拽区域', () => {
  assert.match(popupMain, /screen\.getCursorScreenPoint\(\)/u)
  assert.match(popupMain, /isPointInPopupDragRegion\(/u)
})

/**
 * 校验 showInactive 只用于弹窗首次显示，已经显示后的普通结果更新不会重复执行首次显示分支。
 * @returns 无返回值。
 * @author zhenghq
 */
test('翻译结果更新不应在已显示弹窗上重复执行非激活首次显示', () => {
  const start = popupMain.indexOf('export function showPopup(')
  const end = popupMain.indexOf('export function hidePopup(', start)
  const showPopupSource = popupMain.slice(start, end)
  assert.match(
    showPopupSource,
    /if \(!alreadyVisible\) \{[\s\S]*?win\.showInactive\(\)[\s\S]*?\} else if \(activate && shownInactive\) \{[\s\S]*?win\.show\(\)/u
  )
})
