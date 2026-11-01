import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { resolveScreenshotOcrPanelAutoSize } from '../src/renderer/src/screenshotOcrPanelSize.ts'

const selectionRenderer = readFileSync('src/renderer/src/selection.ts', 'utf8')
const selectionCss = readFileSync('src/renderer/src/selection.css', 'utf8')

/**
 * 校验 OCR 结果侧栏会按内容自然尺寸扩展，同时保留基础内边距。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 结果侧栏应按内容自然尺寸自适应', () => {
  const size = resolveScreenshotOcrPanelAutoSize({
    contentWidth: 260,
    contentHeight: 60,
    chromeWidth: 20,
    chromeHeight: 40,
    viewportWidth: 1200,
    viewportHeight: 800
  })

  assert.deepEqual(size, { width: 280, height: 100 })
})

/**
 * 校验超长识别文本不会让侧栏超出视口允许的最大尺寸。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 结果侧栏内容过长时应收敛到最大尺寸', () => {
  const size = resolveScreenshotOcrPanelAutoSize({
    contentWidth: 2000,
    contentHeight: 1000,
    chromeWidth: 20,
    chromeHeight: 40,
    viewportWidth: 1200,
    viewportHeight: 800
  })

  assert.deepEqual(size, { width: 520, height: 420 })
})

/**
 * 校验极短内容仍保留可用尺寸，窄小视口下则优先服从可视区域。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 结果侧栏应兼顾最小可用尺寸与窄小视口', () => {
  const compact = resolveScreenshotOcrPanelAutoSize({
    contentWidth: 0,
    contentHeight: 0,
    chromeWidth: 30,
    chromeHeight: 40,
    viewportWidth: 900,
    viewportHeight: 700
  })
  const narrow = resolveScreenshotOcrPanelAutoSize({
    contentWidth: 10,
    contentHeight: 10,
    chromeWidth: 10,
    chromeHeight: 10,
    viewportWidth: 100,
    viewportHeight: 100
  })

  assert.deepEqual(compact, { width: 180, height: 84 })
  assert.deepEqual(narrow, { width: 84, height: 84 })
})

/**
 * 校验渲染进程按文本自然宽度和换行后的高度自动设置侧栏尺寸。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 结果侧栏渲染时应接入内容测量并尊重手动尺寸', () => {
  assert.match(selectionRenderer, /resolveScreenshotOcrPanelAutoSize/u)
  assert.match(selectionRenderer, /function syncOcrPanelAutoSize\(/u)
  assert.match(selectionRenderer, /getComputedStyle\(ocrPanelText\)/u)
  assert.match(selectionRenderer, /ocrPanelText\.scrollHeight/u)
  assert.match(selectionRenderer, /ocrPanelUserSize/u)
  const layoutStart = selectionRenderer.indexOf('function layoutOcrPanel')
  const layoutEnd = selectionRenderer.indexOf('/**', layoutStart + 1)
  const layoutSource = selectionRenderer.slice(layoutStart, layoutEnd)
  assert.match(layoutSource, /syncOcrPanelAutoSize\(/u)
  assert.match(layoutSource, /ocrPanel\.getBoundingClientRect\(\)/u)
  assert.match(layoutSource, /panelRect\.width/u)
  assert.match(layoutSource, /panelRect\.height/u)
})

/**
 * 校验文本区不再依赖固定最小高度，允许随识别内容缩短并填满手动调整后的面板。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 结果文本区应随内容伸缩并支持面板高度变化', () => {
  const textStart = selectionCss.indexOf('.ocr-panel-text {')
  const textEnd = selectionCss.indexOf('}', textStart)
  const textSource = selectionCss.slice(textStart, textEnd)

  assert.match(textSource, /flex:\s*1/u)
  assert.match(textSource, /min-height:\s*0/u)
  assert.doesNotMatch(textSource, /min-height:\s*96px/u)
  assert.doesNotMatch(textSource, /max-height:\s*320px/u)
})
