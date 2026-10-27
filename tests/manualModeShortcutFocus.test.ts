import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { tForTest } from './helpers/i18n.ts'

const html = readFileSync('src/renderer/index.html', 'utf8')
const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')
const preload = readFileSync('src/preload/index.ts', 'utf8')
const popupMain = readFileSync('src/main/popup.ts', 'utf8')
const types = readFileSync('src/shared/types.ts', 'utf8')

test('划词与 OCR 快捷键应把弹窗切回划词视图', () => {
  // Renderer 必须订阅主进程的模式切换通知，并在非手动视图下重新渲染。
  assert.match(renderer, /window\.api\.onSelectionMode\(/u)
  assert.match(renderer, /function handleSelectionOpen\(\): void/u)
  const openStart = renderer.indexOf('function handleSelectionOpen(): void {')
  assert.ok(openStart >= 0)
  const openSource = renderer.slice(openStart, renderer.indexOf('\n}', openStart))
  assert.match(openSource, /mode = 'selection'/u)
  assert.match(openSource, /renderMode\(\)/u)
  // 固定状态与手动模式按钮的语义保持一致：快捷键切回划词只切换视图，
  // 不得擅自清除 pinned，否则会与 leaveManualMode 的既有语义冲突。
  assert.doesNotMatch(openSource, /setPinned/u)

  // 主进程显示划词 / OCR 弹窗时必须广播该通知。
  assert.match(popupMain, /popup:selection-mode/u)
  const showStart = popupMain.indexOf('export function showPopup(')
  assert.ok(showStart >= 0)
  const showSource = popupMain.slice(showStart, popupMain.indexOf('\n}', showStart))
  assert.match(showSource, /payload\.origin !== 'manual'/u)
  assert.match(showSource, /selection-mode/u)
})

test('手动模式应支持回车提交，避免用户必须移动鼠标点击', () => {
  // 输入框中的 Enter（无修饰键）即提交；Shift+Enter 仍保留换行。
  assert.match(renderer, /function handleManualSourceKeydown\(event: KeyboardEvent\): void/u)
  assert.match(renderer, /manualSourceEl\.addEventListener\('keydown', handleManualSourceKeydown\)/u)
  const keydownStart = renderer.indexOf('function handleManualSourceKeydown(event: KeyboardEvent): void {')
  assert.ok(keydownStart >= 0)
  const keydownSource = renderer.slice(keydownStart, renderer.indexOf('\n}', keydownStart))
  assert.match(keydownSource, /event\.key !== 'Enter'/u)
  // 四类修饰键都必须显式处理：⌘/Ctrl 走组合提交，Shift/Alt 保留换行。
  assert.match(keydownSource, /event\.metaKey \|\| event\.ctrlKey/u)
  assert.match(keydownSource, /event\.shiftKey \|\| event\.altKey/u)
  assert.match(keydownSource, /submitManualTranslation\(\)/u)

  // 快捷键仍可用，方便习惯组合键的用户。
  assert.match(keydownSource, /event\.metaKey \|\| event\.ctrlKey[\s\S]{0,160}submitManualTranslation\(\)/u)
  assert.match(keydownSource, /void submitManualTranslation\(\)[\s\S]{0,160}event\.shiftKey \|\| event\.altKey/u)
  assert.match(keydownSource, /event\.preventDefault\(\)/u)
  // 提交入口应监听输入框自身的 keydown，而非依赖 document 级分发。
  assert.doesNotMatch(renderer, /document\.addEventListener\('keydown', handleManualSourceKeydown\)/u)
})

test('preload 与共享类型应暴露划词模式通知', () => {
  assert.match(preload, /popup:selection-mode/u)
  assert.match(preload, /onSelectionMode\(/u)
  assert.match(types, /onSelectionMode\(cb: \(\) => void\): \(\) => void/u)
})

test('回车提示文案应覆盖两种提交方式', () => {
  assert.equal(tForTest('zh-CN', 'popup.manualHint'), 'Enter / ⌘+Ctrl + Enter 翻译')
  assert.equal(tForTest('en-US', 'popup.manualHint'), 'Enter / ⌘+Ctrl + Enter to translate')
  const zh = readFileSync('src/shared/i18n/catalog.zh-CN.base.ts', 'utf8')
  const en = readFileSync('src/shared/i18n/catalog.en-US.base.ts', 'utf8')
  assert.match(zh, /'popup\.manualHint': 'Enter \/ ⌘\+Ctrl \+ Enter 翻译'/u)
  assert.match(en, /'popup\.manualHint': 'Enter \/ ⌘\+Ctrl \+ Enter to translate'/u)
  const manualHintTag = html.match(/<span id="manual-hint"[^>]*>([^<]*)</u)?.[1] ?? ''
  assert.match(manualHintTag, /Enter/u)
})
