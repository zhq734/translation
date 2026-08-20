import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const html = readFileSync('src/renderer/index.html', 'utf8')
const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')
const popupWindow = readFileSync('src/main/popup.ts', 'utf8')
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
  assert.match(renderer, /systemSpeechController/u)
  assert.match(renderer, /edgeSpeechController/u)
  assert.match(renderer, /manualState\.translation/u)
  assert.match(renderer, /manualState\.stale/u)
  assert.match(renderer, /function syncSpeechButton/u)
  assert.match(renderer, /function stopSpeech/u)
  assert.match(renderer, /speakBtn\.disabled/u)
  assert.match(renderer, /voiceschanged/u)
  assert.match(renderer, /window\.api\.hide\(\)/u)
})

test('Renderer 应按设置选择 Edge 或系统语音，并在 Edge 失败时回退', () => {
  assert.match(renderer, /speechProvider/u)
  assert.match(renderer, /synthesizeEdgeSpeech/u)
  assert.match(renderer, /Edge 在线语音暂不可用[\s\S]*已切换到系统语音/u)
  assert.match(renderer, /speechSynthesis/u)
})

test('Renderer CSP 应允许 Edge 返回的 blob 音频播放', () => {
  assert.match(html, /media-src ['"]self['"] blob:/u)
})

test('翻译弹窗应允许网络合成完成后自动播放 Edge 音频', () => {
  assert.match(popupWindow, /autoplayPolicy:\s*['"]no-user-gesture-required['"]/u)
  assert.match(popupWindow, /setAudioMuted\(false\)/u)
  assert.match(renderer, /document\.createElement\(['"]audio['"]\)/u)
  assert.match(renderer, /audio\.preload\s*=\s*['"]auto['"]/u)
  assert.match(renderer, /document\.body\.append\(audio\)/u)
})

test('Edge 朗读应向用户展示请求、音频返回和播放阶段', () => {
  assert.match(renderer, /正在请求 Edge 语音/u)
  assert.match(renderer, /已收到 Edge 音频/u)
  assert.match(renderer, /正在播放 Edge 语音/u)
  assert.match(renderer, /result\.error/u)
  assert.match(renderer, /function flashStatus\(message: string, durationMs = 1400\): void/u)
  assert.match(renderer, /正在请求 Edge 语音…', 20_000/u)
  assert.match(renderer, /已收到 Edge 音频（\$\{byteLength\} 字节）`, 5000\)/u)
  assert.match(renderer, /正在播放 Edge 语音…', 5000/u)
})
