import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

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
})

test('翻译弹窗控件应保持非拖动区域且拖动能力不依赖固定状态', () => {
  assert.match(
    popupStyles,
    /\.language-picker,\s*\.header-actions,[^}]*\{[^}]*-webkit-app-region:\s*no-drag;/su
  )
  assert.doesNotMatch(popupStyles, /\[aria-pressed=['"]true['"]\][^{]*\.drag-handle/su)
})
