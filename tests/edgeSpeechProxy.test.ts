import assert from 'node:assert/strict'
import test from 'node:test'
import { edgeSpeechProxyUrl } from '../src/main/networkProxy.ts'

test('Edge 语音应复用 Electron 翻译会话解析出的 HTTP 或 HTTPS 代理', () => {
  assert.equal(edgeSpeechProxyUrl('PROXY 127.0.0.1:7890; DIRECT'), 'http://127.0.0.1:7890')
  assert.equal(edgeSpeechProxyUrl('HTTPS proxy.example.com:443'), 'https://proxy.example.com:443')
  assert.equal(edgeSpeechProxyUrl('DIRECT'), null)
})

test('Edge 语音遇到仅 SOCKS 代理时应返回不支持结果而不是绕过代理', () => {
  assert.equal(edgeSpeechProxyUrl('SOCKS5 127.0.0.1:1080'), undefined)
})
