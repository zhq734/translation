import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const popup = readFileSync('src/renderer/index.html', 'utf8')
const popupCss = readFileSync('src/renderer/src/style.css', 'utf8')
const reader = readFileSync('src/renderer/web-reader.html', 'utf8')
const readerCss = readFileSync('src/renderer/src/webReader.css', 'utf8')
const selection = readFileSync('src/renderer/selection.html', 'utf8')
const toast = readFileSync('src/renderer/toast.html', 'utf8')
const toastSource = readFileSync('src/renderer/src/toast.ts', 'utf8')
const toastCss = readFileSync('src/renderer/src/toast.css', 'utf8')

test('翻译弹窗应按标题、语言、内容和底部状态操作区组织结构', () => {
  assert.match(popup, /class="drag-handle"[^>]+aria-label="拖动翻译弹窗"/u)
  assert.match(popup, /class="language-picker"[^>]+aria-label="翻译语言工具栏"/u)
  assert.match(popup, /class="footer popup-status-actions"[^>]*aria-label="翻译状态和操作"/u)
  assert.ok(popup.indexOf('class="drag-handle"') < popup.indexOf('class="header"'))
  assert.ok(popup.indexOf('id="selection-view"') < popup.indexOf('class="footer popup-status-actions"'))
  assert.match(popupCss, /#popup\s*\{[\s\S]*box-shadow:\s*var\(--shadow-overlay\)/u)
  assert.match(popupCss, /\.header-action-button\s*\{[\s\S]*min-height:\s*var\(--control-height\)/u)
})

test('网页阅读器应提供独立标题栏、加载进度和状态区域', () => {
  assert.match(reader, /id="web-reader-titlebar"[^>]*class="window-titlebar"/u)
  assert.match(reader, /id="web-loading-progress"[^>]+role="progressbar"/u)
  assert.match(reader, /id="web-status"[^>]+role="status"/u)
  assert.match(readerCss, /\.web-loading-progress\s*\{[\s\S]*height:\s*2px/u)
  assert.match(readerCss, /\.web-view-slot\s*\{[\s\S]*flex:\s*1[\s\S]*min-height:\s*0/u)
})

test('Toast 应以内容自适应尺寸和语义图标表达成功、警告与错误', () => {
  assert.match(toast, /id="toast"[^>]+aria-live="polite"/u)
  assert.match(toast, /id="toast-icon"[^>]+aria-hidden="true"/u)
  assert.match(toast, /id="toast-message"/u)
  assert.match(toastSource, /dataset\.state\s*=\s*isError\s*\?\s*'error'/u)
  assert.match(toastSource, /isWarning\s*\?\s*'warning'/u)
  assert.match(toastSource, /toastIcon\.textContent/u)
  assert.match(toastCss, /width:\s*max-content/u)
  assert.match(toastCss, /background:\s*var\(--hint-pill-bg\)/u)
  assert.match(toastCss, /prefers-reduced-motion:\s*reduce/u)
})

test('截图关键交互应具备语义名称、共享浮层和降低动态效果规则', () => {
  assert.match(selection, /id="ocr-selection-box"[^>]*>/u)
  assert.match(selection, /id="ocr-toolbar"[^>]+class="ocr-toolbar flat-overlay"/u)
  assert.match(selection, /id="ocr-tip"[^>]+role="status"/u)
  const css = readFileSync('src/renderer/src/selection.css', 'utf8')
  assert.match(css, /\.ocr-toolbar\s*\{[\s\S]*max-width:\s*calc\(100vw - 16px\)/u)
  assert.match(css, /box-shadow:\s*var\(--shadow-overlay\)/u)
  assert.match(css, /prefers-reduced-motion/u)
})
