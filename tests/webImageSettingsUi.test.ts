import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const settingsHtml = readFileSync('src/renderer/settings.html', 'utf8')
const settingsTs = readFileSync('src/renderer/src/settings.ts', 'utf8')
const readerTs = readFileSync('src/renderer/src/webReader.ts', 'utf8')
const readerCss = readFileSync('src/renderer/src/webReader.css', 'utf8')

test('设置页应提供图片 OCR 开关、数量、尺寸与展示方式控件', () => {
  for (const id of [
    'web-translation-image-ocr-enabled',
    'web-translation-image-ocr-max-images',
    'web-translation-image-ocr-min-size',
    'web-translation-image-ocr-overlay'
  ]) {
    assert.match(settingsHtml, new RegExp(`id="${id}"`, 'u'), `缺少控件 ${id}`)
    assert.match(settingsTs, new RegExp(`getElementById\\('${id}'\\)`, 'u'), `未读取控件 ${id}`)
  }
  assert.match(settingsHtml, /id="web-translation-image-ocr-max-images"[^>]*min="1"[^>]*max="200"/u)
  assert.match(settingsHtml, /id="web-translation-image-ocr-min-size"[^>]*min="16"/u)
  assert.match(settingsHtml, /<option value="below"/u)
  assert.match(settingsHtml, /<option value="overlay"/u)
})

test('设置页应加载并保存图片 OCR 设置，且样式不得硬编码颜色', () => {
  assert.match(settingsTs, /webTranslationImageOcrEnabled/u)
  assert.match(settingsTs, /webTranslationImageOcrMaxImages/u)
  assert.match(settingsTs, /webTranslationImageOcrMinSize/u)
  assert.match(settingsTs, /webTranslationImageOcrOverlay/u)
  assert.match(settingsTs, /saveWebTranslationSettings/u)
  const settingsCss = readFileSync('src/renderer/src/settings.css', 'utf8')
  assert.doesNotMatch(settingsCss, /#[0-9a-fA-F]{3,8}\b|rgba?\(/u)
})

test('阅读器状态栏应展示图片识别进度与部分失败提示', () => {
  assert.match(readerTs, /progress\.images/u)
  assert.match(readerTs, /imageProcessed/u)
  assert.match(readerTs, /imageFailed/u)
  assert.match(readerTs, /imageSkipped/u)
  assert.match(readerCss, /var\(--/u)
  assert.doesNotMatch(readerCss, /#[0-9a-fA-F]{3,8}\b|rgba?\(/u)
})
