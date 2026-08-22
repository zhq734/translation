import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const html = readFileSync('src/renderer/index.html', 'utf8')
const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')
const styles = readFileSync('src/renderer/src/style.css', 'utf8')
const preload = readFileSync('src/preload/index.ts', 'utf8')
const main = readFileSync('src/main/index.ts', 'utf8')
const popup = readFileSync('src/main/popup.ts', 'utf8')

test('悬浮窗应包含手动翻译入口、输入区、计数、提交和复制控件', () => {
  assert.match(html, /id="manual-mode"[^>]*aria-pressed=/u)
  assert.match(html, /textarea[^>]*id="manual-source"[^>]*maxlength="5000"/u)
  assert.match(html, /id="manual-clear"/u)
  assert.match(html, /id="manual-count"[^>]*aria-live=/u)
  assert.match(html, /id="manual-submit"/u)
  assert.match(html, /id="manual-result"[^>]*aria-live=/u)
  assert.match(html, /id="manual-copy"/u)
})

test('Renderer 应支持手动模式快捷提交、显式提交和安全复制', () => {
  assert.match(renderer, /event\.key === 'Enter'.*(event\.metaKey \|\| event\.ctrlKey)/su)
  assert.match(renderer, /window\.api\.translateManual\(/u)
  assert.match(renderer, /manualState\.translation/u)
  assert.match(renderer, /manualState\.loading/u)
  assert.match(
    renderer,
    /if \(!manualState\.translation \|\| manualState\.loading \|\| manualState\.error \|\| manualState\.stale\) return/u
  )
  assert.match(renderer, /window\.api\.copy\(manualState\.translation\)/u)
})

test('划词结果在手动模式下只更新划词会话且不得覆盖手动状态提示', () => {
  assert.match(renderer, /const visible = mode === 'selection'/u)
  assert.match(renderer, /if \(visible\) statusEl\.textContent = selectionStatus/u)
  assert.match(renderer, /copyBtn\.hidden = !visible \|\| !lastTranslation/u)
})

test('手动结果在划词模式下只更新手动会话且不得覆盖划词状态提示', () => {
  assert.match(renderer, /const manualVisible = mode === 'manual'/u)
  assert.match(renderer, /if \(manualVisible\) statusEl\.textContent = '翻译失败'/u)
  assert.match(renderer, /if \(manualVisible\) renderTranslationProviderResult\(payload\.provider\)/u)
})

test('手动请求期间修改原文或设置后，成功结果仍应保持过期标记', () => {
  assert.match(
    renderer,
    /stale:\s*manualState\.stale\s*\|\|\s*manualState\.draft !== manualState\.submittedText/u
  )
})

test('preload 和主进程应使用独立手动翻译 IPC 与来源标识', () => {
  assert.match(preload, /manual-translate:open/u)
  assert.match(preload, /manual-translate:submit/u)
  assert.match(main, /ipcMain\.handle\('manual-translate:submit'/u)
  assert.match(main, /origin:\s*'manual'/u)
  assert.match(main, /origin:\s*TranslationOrigin\s*=\s*'selection'/u)
  assert.match(main, /if \(origin === 'selection'\) \{\s*lastSelectedText = text/su)
  assert.match(main, /validateManualTranslationText\(text\)/u)
})

test('托盘入口和悬浮窗打开流程应自动固定并通知 Renderer', () => {
  assert.match(main, /label:\s*'手动翻译…'/u)
  assert.match(main, /function openManualTranslation/u)
  const start = main.indexOf('function openManualTranslation')
  const source = main.slice(start, main.indexOf('\n}', start) + 2)
  assert.match(source, /setPopupPinned\(true\)/u)
  assert.match(source, /showManualTranslationPopup\(/u)
  assert.match(popup, /manual-translate:open/u)
  assert.match(popup, /win\.focus\(\)/u)
})

test('手动界面样式应使用自适应布局和主题变量', () => {
  assert.match(styles, /\.manual-view\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;/su)
  assert.match(styles, /#manual-source\s*\{[^}]*background:\s*var\(--/su)
  assert.doesNotMatch(styles, /\.manual-[^{]*\{[^}]*(?:#[0-9a-fA-F]{3,8}|rgb\()/su)
})

test('OCR 翻译结果应在弹窗展示 OCR 内容、引擎来源并复用复制和朗读能力', () => {
  assert.match(html, /id="ocr-source"[^>]*hidden/u)
  assert.doesNotMatch(html, /id="ocr-source-tabs"/u)
  assert.doesNotMatch(html, /id="ocr-source-tab-/u)
  assert.match(html, /id="ocr-source-label"[\s\S]*?OCR 内容/u)
  assert.match(html, /id="ocr-source-text"[^>]*aria-live=/u)
  assert.match(html, /id="ocr-engine-badge"[^>]*aria-label="OCR 引擎"/u)
  assert.match(html, /id="ocr-copy"[\s\S]*?复制 OCR 内容/u)
  assert.match(renderer, /function renderOcrSource\(payload: TranslatePayload\): void/u)
  assert.match(renderer, /payload\.ocrRawText \?\? payload\.ocrText/u)
  assert.match(renderer, /const ocrText = getOcrRawText\(payload\)/u)
  assert.match(renderer, /ocrSourceTextEl\.textContent = ocrText/u)
  assert.doesNotMatch(renderer, /renderOcrSourceTabs/u)
  assert.match(renderer, /ocrEngineBadgeEl\.textContent = ocrEngineLabel\(payload\.ocrEngine\)/u)
  assert.match(renderer, /const text = ocrSourceTextEl\.textContent \?\? ''[\s\S]*?if \(text\) window\.api\.copy\(text\)/u)
  assert.match(renderer, /syncSpeechButton\(\)/u)
  assert.match(styles, /\.ocr-source\s*\{[^}]*border-top:\s*1px solid var\(--divider\)[^}]*min-height:\s*0;/su)
  assert.match(styles, /\.ocr-source\[hidden\]\s*\{[^}]*display:\s*none/u)
  assert.match(styles, /\.ocr-source-text\s*\{[^}]*max-height:[^;]+;[^}]*overflow-y:\s*auto;/su)
  assert.doesNotMatch(styles, /\.ocr-source-tabs/u)
})

test('关闭、取消固定和模式切换应沿用明确的固定状态语义', () => {
  assert.match(popup, /export function hidePopup\(\)[\s\S]*?pinned = false/u)
  assert.match(renderer, /function leaveManualMode\(\)[\s\S]*?mode = 'selection'/u)
  const leaveStart = renderer.indexOf('function leaveManualMode')
  const leaveSource = renderer.slice(leaveStart, renderer.indexOf('\n}', leaveStart) + 2)
  assert.doesNotMatch(leaveSource, /setPinned/u)
  assert.match(renderer, /window\.api\.setPinned\(pinned\)/u)
})
