import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const main = readFileSync('src/main/index.ts', 'utf8')
const popup = readFileSync('src/main/popup.ts', 'utf8')
const popupRenderer = readFileSync('src/renderer/src/popup.ts', 'utf8')
const webReader = readFileSync('src/main/webReaderWindow.ts', 'utf8')

test('手动翻译快捷键应复用固定弹窗入口并通知渲染进程聚焦原文输入框', () => {
  assert.match(main, /manualTranslationHotkey[\s\S]{0,80}openManualTranslation\(\)/u)
  assert.match(main, /function openManualTranslation[\s\S]*?setPopupPinned\(true\)[\s\S]*?showManualTranslationPopup\(\)/u)
  assert.match(popup, /function showManualTranslationPopup[\s\S]*?manual-translate:open/u)
  assert.match(popupRenderer, /onManualTranslateOpen\(handleManualOpen\)/u)
  assert.match(popupRenderer, /function handleManualOpen[\s\S]*?manualSourceEl\.focus\(\)/u)
})

test('手动翻译快捷键不应重置已有草稿或译文状态', () => {
  const openStart = main.indexOf('function openManualTranslation')
  const openEnd = main.indexOf('/**\n * 计算覆盖所有显示器的 OCR 框选窗口边界', openStart)
  const openSource = main.slice(openStart, openEnd)
  assert.ok(openStart >= 0)
  assert.ok(openEnd > openStart)
  assert.doesNotMatch(openSource, /clearManualTranslation|manualState\s*=|manualSourceEl\.value\s*=/u)
})

test('网页阅读器快捷键应复用空白打开与已存在窗口聚焦，不读取当前浏览器地址', () => {
  assert.match(main, /webReaderHotkey[\s\S]{0,80}openWebReaderFromShortcut\(\)/u)
  assert.match(main, /function openWebReaderFromShortcut[\s\S]*?focusOrOpenExistingWindow\(\)[\s\S]*?reader\.open\(\)/u)
  const start = main.indexOf('function openWebReaderFromShortcut')
  const end = main.indexOf('// ---- 自建 DeepLX 集成 ----', start)
  const source = main.slice(start, end)
  assert.ok(start >= 0)
  assert.ok(end > start)
  assert.doesNotMatch(source, /lastSelected|selection|clipboard|activeWindow|url\s*=/u)
  assert.match(webReader, /focusExistingWindow\(\): boolean/u)
  assert.match(webReader, /if \(this\.window\.isMinimized\(\)\) this\.window\.restore\(\)/u)
})

test('已可见但被遮挡的网页阅读器窗口也应重新获得焦点', () => {
  const webReader = readFileSync('src/main/webReaderWindow.ts', 'utf8')
  const start = webReader.indexOf('focusOrOpenExistingWindow(): boolean {')
  const end = webReader.indexOf('/**\n   * 返回阅读器窗口当前可见的屏幕区域', start)
  const source = webReader.slice(start, end)

  assert.ok(start >= 0)
  assert.ok(end > start)
  // 显式用户入口不复用内部 activate 的“已可见即返回”，会真正重新 show()+focus()。
  assert.doesNotMatch(source, /isVisible\(\).*return true/u)
  assert.match(source, /this\.window\.show\(\)/u)
  assert.match(source, /this\.window\.focus\(\)/u)
})
