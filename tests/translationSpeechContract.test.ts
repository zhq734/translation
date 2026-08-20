import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const html = readFileSync('src/renderer/index.html', 'utf8')
const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')
const styles = readFileSync('src/renderer/src/style.css', 'utf8')

test('顶部应使用统一的手动、朗读和钉住图标按钮顺序', () => {
  const manualIndex = html.indexOf('id="manual-mode"')
  const speakIndex = html.indexOf('id="speak"')
  const pinIndex = html.indexOf('id="pin"')

  assert.ok(manualIndex >= 0)
  assert.ok(speakIndex > manualIndex)
  assert.ok(pinIndex > speakIndex)
  assert.match(html, /id="manual-mode"[^>]*class="header-action-button"[^>]*>[\s\S]*?<svg[^>]+class="header-action-icon manual-icon"/u)
  assert.match(html, /id="speak"[^>]*class="header-action-button"[^>]*>[\s\S]*?<svg[^>]+class="header-action-icon speak-icon"/u)
  assert.doesNotMatch(html, /id="manual-mode"[\s\S]*?>\s*手动\s*<\/button>/u)
})

test('语音按钮应复用统一图标尺寸和主题样式', () => {
  assert.match(styles, /\.header-action-button\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;[^}]*border-radius:\s*9px;/su)
  assert.match(styles, /\.header-action-icon\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px;[^}]*stroke:\s*currentColor;/su)
  assert.match(styles, /#speak\[disabled\]/u)
  assert.match(styles, /#speak\[aria-pressed=['"]true['"]\]/u)
})

test('Renderer 应统一处理两种模式的有效译文和朗读状态', () => {
  assert.match(renderer, /speechController/u)
  assert.match(renderer, /manualState\.translation/u)
  assert.match(renderer, /manualState\.stale/u)
  assert.match(renderer, /function syncSpeechButton/u)
  assert.match(renderer, /function stopSpeech/u)
  assert.match(renderer, /speakBtn\.disabled/u)
  assert.match(renderer, /voiceschanged/u)
  assert.match(renderer, /window\.api\.hide\(\)/u)
})
