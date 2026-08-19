import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'

test('AI 启用、协议、Base URL 或模型变化后规范化快照应反映新配置', () => {
  const base = normalizeSettings({
    schemaVersion: 9,
    aiEnabled: false,
    aiProtocol: 'ollama',
    aiBaseUrl: 'http://127.0.0.1:11434',
    aiModel: ''
  } as never)

  const enabled = normalizeSettings({ ...base, aiEnabled: true } as never)
  assert.equal(enabled.aiEnabled, true)
  assert.notEqual(enabled.aiEnabled, base.aiEnabled)

  const switched = normalizeSettings({ ...base, aiProtocol: 'openai', aiBaseUrl: 'https://api.example.com', aiModel: 'gpt-4o' } as never)
  assert.equal(switched.aiProtocol, 'openai')
  assert.equal(switched.aiBaseUrl, 'https://api.example.com')
  assert.equal(switched.aiModel, 'gpt-4o')
})

test('相同 AI 配置规范化结果应稳定且可比较', () => {
  const a = normalizeSettings({ schemaVersion: 9, aiProtocol: 'claude-code', aiBaseUrl: 'https://api.example.com/', aiModel: 'claude-3' } as never)
  const b = normalizeSettings({ schemaVersion: 9, aiProtocol: 'claude-code', aiBaseUrl: 'https://api.example.com', aiModel: 'claude-3' } as never)
  assert.deepEqual({ protocol: a.aiProtocol, baseUrl: a.aiBaseUrl, model: a.aiModel }, { protocol: 'claude-code', baseUrl: 'https://api.example.com', model: 'claude-3' })
  assert.equal(b.aiBaseUrl, a.aiBaseUrl)
})
