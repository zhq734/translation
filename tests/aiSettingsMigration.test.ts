import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSettings, SETTINGS_SCHEMA_VERSION, DEFAULT_SETTINGS } from '../src/shared/settingsDefaults.ts'
import { DEFAULT_AI_BASE_URL } from '../src/shared/types.ts'

/**
 * 构造一个省略 AI 字段的旧版设置，用于迁移测试。
 * @param schemaVersion 旧设置结构版本。
 * @returns 缺失 AI 字段的旧设置对象。
 * @author zhenghq
 */
function legacyWithoutAi(schemaVersion: number): Record<string, unknown> {
  return {
    schemaVersion,
    targetLang: 'EN',
    sourceLang: 'ZH',
    hotkey: 'Alt+T',
    autoHideMs: 1000,
    deepLxUrl: '',
    triggerMode: 'button',
    proxyMode: 'system',
    proxyRules: '',
    proxyBypassRules: '<local>;localhost',
    dingTalkEnabled: false,
    dingTalkCorpId: '',
    dingTalkClientId: '',
    dingTalkSecretConfigured: false,
    microsoftEnabled: false,
    preferredTranslationProvider: 'auto'
  }
}

test('schema 8 及更早版本应升级到当前版本并补齐 AI 默认值', () => {
  for (const version of [1, 4, 7, 8]) {
    const settings = normalizeSettings(legacyWithoutAi(version) as never)
    assert.equal(settings.schemaVersion, SETTINGS_SCHEMA_VERSION, `schema ${version} 应升级到当前版本`)
    assert.equal(settings.aiEnabled, false)
    assert.equal(settings.aiProtocol, 'ollama')
    assert.equal(settings.aiBaseUrl, DEFAULT_AI_BASE_URL)
    assert.equal(settings.aiModel, '')
    assert.equal(settings.aiApiKeyConfigured, false)
  }
})

test('默认设置应包含关闭的 AI 通道和本地 Ollama 地址', () => {
  assert.equal(SETTINGS_SCHEMA_VERSION, 17)
  assert.equal(DEFAULT_SETTINGS.aiEnabled, false)
  assert.equal(DEFAULT_SETTINGS.aiProtocol, 'ollama')
  assert.equal(DEFAULT_SETTINGS.aiBaseUrl, DEFAULT_AI_BASE_URL)
  assert.equal(DEFAULT_SETTINGS.aiModel, '')
  assert.equal(DEFAULT_SETTINGS.aiApiKeyConfigured, false)
  assert.equal(DEFAULT_SETTINGS.speechProvider, 'system')
})

test('默认设置应使用天空蓝和跟随系统主题', () => {
  assert.equal(DEFAULT_SETTINGS.themePreset, 'sky')
  assert.equal(DEFAULT_SETTINGS.themeMode, 'system')
})

test('主题设置应保留合法值并将非法值回退到默认值', () => {
  assert.equal(normalizeSettings({ themePreset: 'sakura', themeMode: 'dark' } as never).themePreset, 'sakura')
  assert.equal(normalizeSettings({ themePreset: 'unknown', themeMode: 'invalid' } as never).themePreset, 'sky')
  assert.equal(normalizeSettings({ themePreset: 'unknown', themeMode: 'invalid' } as never).themeMode, 'system')
})

test('旧设置迁移时应补齐主题字段且保留业务设置', () => {
  const settings = normalizeSettings({
    schemaVersion: 1,
    sourceLang: 'EN',
    targetLang: 'ZH',
    triggerMode: 'hotkey'
  } as never)
  assert.equal(settings.themePreset, 'sky')
  assert.equal(settings.themeMode, 'system')
  assert.equal(settings.sourceLang, 'EN')
  assert.equal(settings.targetLang, 'auto')
  assert.equal(settings.triggerMode, 'button')
})

test('语音引擎默认使用系统内置语音', () => {
  assert.equal(normalizeSettings({ schemaVersion: 10 } as never).speechProvider, 'system')
})

test('旧设置缺少语音引擎字段时应迁移为系统内置语音', () => {
  const settings = normalizeSettings(legacyWithoutAi(10) as never)
  assert.equal(settings.speechProvider, 'system')
  assert.equal(settings.schemaVersion, 17)
})

test('Edge 语音引擎设置应保留，非法值应回退系统内置语音', () => {
  assert.equal(normalizeSettings({ schemaVersion: 10, speechProvider: 'edge' } as never).speechProvider, 'edge')
  assert.equal(normalizeSettings({ schemaVersion: 10, speechProvider: 'invalid' } as never).speechProvider, 'system')
})

test('未知协议应回退为默认协议且不写入规范化设置', () => {
  const settings = normalizeSettings({
    schemaVersion: 9,
    aiProtocol: 'unknown-provider' as 'ollama',
    aiBaseUrl: 'http://localhost:11434',
    aiModel: 'llama'
  } as never)
  assert.equal(settings.aiProtocol, 'ollama')
})

test('空白字符串 Base URL 与模型应规范化为空或默认值', () => {
  const settings = normalizeSettings({
    schemaVersion: 9,
    aiProtocol: 'openai',
    aiBaseUrl: '   ',
    aiModel: '   '
  } as never)
  assert.equal(settings.aiProtocol, 'openai')
  assert.equal(settings.aiBaseUrl, '')
  assert.equal(settings.aiModel, '')
})

test('非法 Base URL 在允许范围内应保留为字符串，不做网络校验', () => {
  const settings = normalizeSettings({
    schemaVersion: 9,
    aiProtocol: 'openai',
    aiBaseUrl: 'not-a-url',
    aiModel: 'gpt-4o'
  } as never)
  assert.equal(settings.aiBaseUrl, 'not-a-url')
  assert.equal(settings.aiModel, 'gpt-4o')
})

test('合法 AI 配置应原样保留并规范化空白', () => {
  const settings = normalizeSettings({
    schemaVersion: 9,
    aiEnabled: true,
    aiProtocol: 'claude-code',
    aiBaseUrl: '  https://api.example.com/  ',
    aiModel: '  claude-3  '
  } as never)
  assert.equal(settings.aiEnabled, true)
  assert.equal(settings.aiProtocol, 'claude-code')
  assert.equal(settings.aiBaseUrl, 'https://api.example.com')
  assert.equal(settings.aiModel, 'claude-3')
})

test('aiApiKeyConfigured 仅接受布尔值且不存储明文 Key', () => {
  const settings = normalizeSettings({
    schemaVersion: 9,
    aiApiKeyConfigured: true,
    aiApiKey: 'should-not-persist'
  } as never)
  assert.equal(settings.aiApiKeyConfigured, true)
  assert.equal('aiApiKey' in settings, false)
})

test('ai 应作为合法翻译 Provider 偏好被接受', () => {
  const settings = normalizeSettings({
    schemaVersion: 9,
    preferredTranslationProvider: 'ai'
  } as never)
  assert.equal(settings.preferredTranslationProvider, 'ai')
})
