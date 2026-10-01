import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { tForTest } from './helpers/i18n.ts'

const html = readFileSync('src/renderer/settings.html', 'utf8')
const source = readFileSync('src/renderer/src/settings.ts', 'utf8')

test('设置页应提供系统和 Edge 两种语音引擎并默认系统语音', () => {
  assert.match(html, /id="speech-provider"/u)
  assert.ok(html.includes(`<option value="system" data-i18n="settings.speech.system">${tForTest('en-US', 'settings.speech.system')}</option>`))
  assert.ok(html.includes(`<option value="edge" data-i18n="settings.speech.edge">${tForTest('en-US', 'settings.speech.edge')}</option>`))
  assert.match(source, /speechProvider\.value = settings\.speechProvider/u)
  assert.match(source, /save\(\{ speechProvider: provider \}\)/u)
})

test('Edge 设置说明应明确联网、隐私、非官方风险和系统回退', () => {
  const edgeHint = tForTest('en-US', 'settings.speech.hint.edge')
  assert.match(source, /t\(\s*provider === 'edge' \? 'settings\.speech\.hint\.edge'/u)
  assert.match(edgeHint, /Requires network access/u)
  assert.match(edgeHint, /Microsoft online services/u)
  assert.match(edgeHint, /unofficial endpoint/u)
  assert.match(edgeHint, /fall back to system speech/u)
})
