import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const html = readFileSync('src/renderer/settings.html', 'utf8')
const source = readFileSync('src/renderer/src/settings.ts', 'utf8')

test('设置页应提供系统和 Edge 两种语音引擎并默认系统语音', () => {
  assert.match(html, /id="speech-provider"/u)
  assert.match(html, /option value="system">系统内置语音（默认）/u)
  assert.match(html, /option value="edge">Edge 在线神经网络语音/u)
  assert.match(source, /speechProvider\.value = settings\.speechProvider/u)
  assert.match(source, /save\(\{ speechProvider: provider \}\)/u)
})

test('Edge 设置说明应明确联网、隐私、非官方风险和系统回退', () => {
  assert.match(source, /需要网络/u)
  assert.match(source, /朗读文本会发送到微软在线服务/u)
  assert.match(source, /非官方接口/u)
  assert.match(source, /自动回退系统语音/u)
})
