import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const selectionHtml = readFileSync('src/renderer/selection.html', 'utf8')
const selectionRenderer = readFileSync('src/renderer/src/selection.ts', 'utf8')
const selectionCss = readFileSync('src/renderer/src/selection.css', 'utf8')

/** 六种标注工具按钮的 DOM id 与中文无障碍名称。 */
const annotationTools: ReadonlyArray<[string, string]> = [
  ['ocr-tool-rect', '矩形'],
  ['ocr-tool-ellipse', '椭圆'],
  ['ocr-tool-arrow', '箭头'],
  ['ocr-tool-brush', '画笔'],
  ['ocr-tool-text', '文字'],
  ['ocr-tool-mosaic', '马赛克']
]

/**
 * 校验截图工具栏提供六种标注工具按钮及中文无障碍属性。
 * @returns 无返回值。
 * @author zhenghq
 */
test('截图工具栏应提供六种标注工具按钮', () => {
  for (const [id, label] of annotationTools) {
    const pattern = new RegExp(`id="${id}"[^>]*`, 'u')
    const match = selectionHtml.match(pattern)
    assert.ok(match, `缺少标注按钮 ${id}`)
    const tag = match[0]
    assert.match(tag, new RegExp(`title="${label}[^"]*"`, 'u'))
    assert.match(tag, new RegExp(`aria-label="${label}[^"]*"`, 'u'))
    assert.match(tag, /aria-pressed="false"/u)
    assert.match(tag, new RegExp(`data-annotation-tool="${id.replace('ocr-tool-', '')}"`, 'u'))
  }
  // 标注按钮与截图动作按钮分组展示
  assert.match(selectionHtml, /class="ocr-toolbar-group"[^>]*data-group="annotation-tools"/u)
  assert.match(selectionHtml, /class="ocr-toolbar-group"[^>]*data-group="annotation-style"/u)
  assert.match(selectionHtml, /class="ocr-toolbar-group"[^>]*data-group="screenshot-actions"/u)
})

/**
 * 校验颜色与粗细等样式控件、撤销/重做/清空按钮存在且具备中文无障碍名称。
 * @returns 无返回值。
 * @author zhenghq
 */
test('截图工具栏应提供样式控件与编辑历史按钮', () => {
  // 颜色选择：预置颜色面板 + 浏览器自定义颜色输入
  assert.match(selectionHtml, /id="ocr-color-toggle"[^>]*aria-label="标注颜色"/u)
  assert.match(selectionHtml, /id="ocr-color-panel"/u)
  assert.match(selectionHtml, /id="ocr-color-custom"[^>]*type="color"/u)
  assert.match(selectionHtml, /id="ocr-color-custom"[^>]*aria-label="自定义标注颜色"/u)
  assert.match(selectionHtml, /id="ocr-color-indicator"/u)

  // 线宽 / 字号 / 粗体 / 马赛克笔刷与像素块大小
  assert.match(selectionHtml, /id="ocr-stroke-width"[^>]*type="range"/u)
  assert.match(selectionHtml, /id="ocr-stroke-width"[^>]*aria-label="线条粗细"/u)
  assert.match(selectionHtml, /id="ocr-font-size"[^>]*type="range"/u)
  assert.match(selectionHtml, /id="ocr-font-size"[^>]*aria-label="文字字号"/u)
  assert.match(selectionHtml, /id="ocr-text-bold"[^>]*aria-label="文字加粗"/u)
  assert.match(selectionHtml, /id="ocr-mosaic-brush"[^>]*aria-label="马赛克笔刷大小"/u)
  assert.match(selectionHtml, /id="ocr-mosaic-intensity"[^>]*aria-label="马赛克强度"/u)

  // 撤销 / 重做 / 清空标注
  assert.match(selectionHtml, /id="ocr-undo"[^>]*aria-label="撤销"/u)
  assert.match(selectionHtml, /id="ocr-redo"[^>]*aria-label="重做"/u)
  assert.match(selectionHtml, /id="ocr-clear-annotations"[^>]*aria-label="清空标注"/u)
})

/**
 * 校验双 Canvas 标注层与文字内联编辑框存在于截图覆盖层中。
 * @returns 无返回值。
 * @author zhenghq
 */
test('截图覆盖层应提供标注画布与文字编辑框', () => {
  assert.match(selectionHtml, /id="ocr-annotation-canvas"[^>]*aria-hidden="true"/u)
  assert.match(selectionHtml, /id="ocr-annotation-preview"[^>]*aria-hidden="true"/u)
  assert.match(selectionHtml, /<canvas[^>]*id="ocr-annotation-canvas"/u)
  assert.match(selectionHtml, /<canvas[^>]*id="ocr-annotation-preview"/u)
  assert.match(selectionHtml, /id="ocr-text-input"[^>]*aria-label="标注文字内容"/u)
})

/**
 * 校验标注相关样式使用主题变量，未在样式中硬编码颜色值。
 * @returns 无返回值。
 * @author zhenghq
 */
test('标注样式应使用主题变量而非硬编码颜色', () => {
  for (const selector of [
    '.ocr-annotation-canvas',
    '.ocr-annotation-preview',
    '.ocr-toolbar-group',
    '.ocr-color-panel',
    '.ocr-style-panel',
    '.ocr-text-input'
  ]) {
    assert.ok(selectionCss.includes(selector), `缺少标注样式 ${selector}`)
  }
  const annotationStart = selectionCss.indexOf('.ocr-annotation-canvas')
  const annotationSource = selectionCss.slice(annotationStart)
  assert.doesNotMatch(annotationSource, /#[0-9a-fA-F]{3,8}\b/u)
  // 工具栏在窄屏下允许换行，保证按钮全部可见
  assert.match(selectionCss, /\.ocr-toolbar\s*\{[^}]*flex-wrap:\s*wrap/su)
  // 预览层位于正式标注层之上，且都不拦截选区指针事件之外的元素
  assert.match(selectionCss, /\.ocr-annotation-preview\s*\{[^}]*z-index/su)
})

/**
 * 校验普通划词模式下不显示截图标注工具。
 * @returns 无返回值。
 * @author zhenghq
 */
test('普通划词模式不应显示截图标注工具', () => {
  // 标注按钮全部位于 OCR 覆盖层内部，普通划词只保留“译”按钮
  const overlayStart = selectionHtml.indexOf('<main id="ocr-overlay"')
  const overlayEnd = selectionHtml.indexOf('</main>')
  assert.ok(overlayStart > -1 && overlayEnd > overlayStart)
  const overlaySource = selectionHtml.slice(overlayStart, overlayEnd)
  for (const [id] of annotationTools) {
    assert.ok(overlaySource.includes(`id="${id}"`), `${id} 必须位于 OCR 覆盖层内`)
  }
  const translateStart = selectionHtml.indexOf('<button id="translate"')
  assert.ok(translateStart > -1 && translateStart < overlayStart)
  // 退出截图模式时标注状态被清理，普通“译”按钮行为不变
  assert.match(selectionRenderer, /function leaveOcrSelectionMode\(/u)
  const leaveStart = selectionRenderer.indexOf('function leaveOcrSelectionMode(')
  const leaveEnd = selectionRenderer.indexOf('/**', leaveStart + 1)
  const leaveSource = selectionRenderer.slice(leaveStart, leaveEnd)
  assert.match(leaveSource, /resetAnnotationSession\(\)/u)
})

/**
 * 校验截图会话重置时会同时清除当前激活工具，避免复制后下次截图无法框选。
 * @returns 无返回值。
 * @author zhenghq
 */
test('截图会话重置应清除激活标注工具', () => {
  assert.match(selectionRenderer, /function resetAnnotationSession\(\)[\s\S]*?resetForNewSession\(\)/u)
  assert.match(selectionRenderer, /function enterOcrSelectionMode\([\s\S]*?resetAnnotationSession\(\)/u)
})
