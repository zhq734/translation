import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  findOpeningTagById,
  readAttributeI18nKey,
  tForTest
} from './helpers/i18n.ts'

const selectionHtml = readFileSync('src/renderer/selection.html', 'utf8')
const selectionRenderer = readFileSync('src/renderer/src/selection.ts', 'utf8')
const selectionCss = readFileSync('src/renderer/src/selection.css', 'utf8')

/** 六种标注工具按钮的 DOM id 与无障碍名称词条 key。 */
const annotationTools: ReadonlyArray<[string, string]> = [
  ['ocr-tool-rect', 'selection.tool.rect'],
  ['ocr-tool-ellipse', 'selection.tool.ellipse'],
  ['ocr-tool-arrow', 'selection.tool.arrow'],
  ['ocr-tool-brush', 'selection.tool.brush'],
  ['ocr-tool-text', 'selection.tool.text'],
  ['ocr-tool-mosaic', 'selection.tool.mosaic']
]

/**
 * 校验指定元素的无障碍属性声明并匹配英文词条文本。
 * @param id 元素 DOM id。
 * @param attribute 需要校验的属性名。
 * @param key 期望的 i18n 词条 key。
 * @returns 无返回值。
 * @author zhenghq
 */
function assertI18nAttribute(id: string, attribute: string, key: string): void {
  const tag = findOpeningTagById(selectionHtml, id)
  assert.ok(tag, `缺少元素 ${id}`)
  assert.equal(readAttributeI18nKey(tag, attribute), key, `${id} 的 ${attribute} i18n key 不匹配`)
  assert.match(tag, new RegExp(`${attribute}="${tForTest('en-US', key)}"`, 'u'))
}

/**
 * 校验截图工具栏提供六种标注工具按钮及本地化无障碍属性。
 * @returns 无返回值。
 * @author zhenghq
 */
test('截图工具栏应提供六种标注工具按钮', () => {
  for (const [id, key] of annotationTools) {
    const tag = findOpeningTagById(selectionHtml, id)
    assert.ok(tag, `缺少标注按钮 ${id}`)
    assert.equal(readAttributeI18nKey(tag, 'title'), key)
    assert.equal(readAttributeI18nKey(tag, 'aria-label'), key)
    assert.match(tag, new RegExp(`title="${tForTest('en-US', key)}"`, 'u'))
    assert.match(tag, new RegExp(`aria-label="${tForTest('en-US', key)}"`, 'u'))
    assert.match(tag, /aria-pressed="false"/u)
    assert.match(tag, new RegExp(`data-annotation-tool="${id.replace('ocr-tool-', '')}"`, 'u'))
  }
  // 标注按钮与截图动作按钮分组展示
  assert.match(selectionHtml, /class="ocr-toolbar-group"[^>]*data-group="annotation-tools"/u)
  assert.match(selectionHtml, /class="ocr-toolbar-group"[^>]*data-group="annotation-style"/u)
  assert.match(selectionHtml, /class="ocr-toolbar-group"[^>]*data-group="screenshot-actions"/u)
})

/**
 * 校验颜色与粗细等样式控件、撤销/重做/清空按钮存在且具备本地化无障碍名称。
 * @returns 无返回值。
 * @author zhenghq
 */
test('截图工具栏应提供样式控件与编辑历史按钮', () => {
  // 颜色选择：预置颜色面板 + 浏览器自定义颜色输入
  assertI18nAttribute('ocr-color-toggle', 'aria-label', 'selection.annotationColor')
  assert.match(selectionHtml, /id="ocr-color-panel"/u)
  assert.match(selectionHtml, /id="ocr-color-custom"[^>]*type="color"/u)
  assertI18nAttribute('ocr-color-custom', 'aria-label', 'selection.customColor')
  assert.match(selectionHtml, /id="ocr-color-indicator"/u)

  // 线宽 / 字号 / 粗体 / 马赛克笔刷与像素块大小
  assert.match(selectionHtml, /id="ocr-stroke-width"[^>]*type="range"/u)
  assertI18nAttribute('ocr-stroke-width', 'aria-label', 'selection.strokeWidth')
  assert.match(selectionHtml, /id="ocr-font-size"[^>]*type="range"/u)
  assertI18nAttribute('ocr-font-size', 'aria-label', 'selection.fontSize')
  assertI18nAttribute('ocr-text-bold', 'aria-label', 'selection.boldText')
  assertI18nAttribute('ocr-mosaic-brush', 'aria-label', 'selection.mosaicBrushSize')
  assertI18nAttribute('ocr-mosaic-intensity', 'aria-label', 'selection.mosaicIntensity')

  // 撤销 / 重做 / 清空标注
  assertI18nAttribute('ocr-undo', 'aria-label', 'selection.undo')
  assertI18nAttribute('ocr-redo', 'aria-label', 'selection.redo')
  assertI18nAttribute('ocr-clear-annotations', 'aria-label', 'selection.clearAnnotations')
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
  assertI18nAttribute('ocr-text-input', 'aria-label', 'selection.annotationText')
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
  assert.match(leaveSource, /resetOcrSessionUi\(\)/u)
  assert.match(selectionRenderer, /function resetOcrSessionUi\(\)[\s\S]*?resetAnnotationSession\(\)/u)
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
