import assert from 'node:assert/strict'
import test from 'node:test'
import { GeminiLiveConfigurationService } from '../src/main/geminiLiveConfig.ts'
import type { Settings } from '../src/shared/types.ts'
import { normalizeSettings, SETTINGS_SCHEMA_VERSION } from '../src/shared/settingsDefaults.ts'

/**
 * 构造内存态 Gemini Live 配置依赖。
 * @param initial 初始公开设置。
 * @returns 服务依赖与观察方法。
 * @author zhenghq
 */
function createHarness(initial: Settings = normalizeSettings({ schemaVersion: SETTINGS_SCHEMA_VERSION })) {
  let settings = initial
  let apiKey: string | null = null
  let failSave = false
  let resetCount = 0
  const broadcasts: Settings[] = []
  const dependencies = {
    getSettings: () => settings,
    saveSettings: (patch: Partial<Settings>): Settings => {
      if (failSave) throw new Error('settings write failed')
      settings = normalizeSettings({ ...settings, ...patch })
      return settings
    },
    credentialStore: {
      readApiKey: () => ({ configured: apiKey != null, apiKey }),
      saveApiKey: (value: string) => { apiKey = value },
      clearApiKey: () => { apiKey = null }
    },
    onSettingsChanged: (next: Settings) => broadcasts.push(next),
    resetRealtimeSubtitleRuntime: () => { resetCount += 1 }
  }
  return {
    dependencies,
    apiKey: () => apiKey,
    broadcasts,
    resetCount: () => resetCount,
    setFailSave: (value: boolean) => { failSave = value }
  }
}

test('Gemini Live 初始化应同步脱敏配置标记', () => {
  const harness = createHarness()
  harness.dependencies.credentialStore.saveApiKey('gemini-existing')
  const service = new GeminiLiveConfigurationService(harness.dependencies)
  const result = service.initialize()
  assert.equal(result.realtimeSubtitleGeminiApiKeyConfigured, true)
  assert.equal(JSON.stringify(result).includes('gemini-existing'), false)
})

test('Gemini Live 保存地址、模型和密钥应广播脱敏设置并重启运行时', () => {
  const harness = createHarness()
  const service = new GeminiLiveConfigurationService(harness.dependencies)
  service.initialize()
  const result = service.configure({
    url: 'wss://gemini.example.com/live',
    model: 'gemini-custom-live',
    apiKey: 'gemini-new'
  })
  assert.equal(result.realtimeSubtitleGeminiUrl, 'wss://gemini.example.com/live')
  assert.equal(result.realtimeSubtitleGeminiModel, 'gemini-custom-live')
  assert.equal(result.realtimeSubtitleGeminiApiKeyConfigured, true)
  assert.equal(harness.apiKey(), 'gemini-new')
  assert.equal(JSON.stringify(result).includes('gemini-new'), false)
  assert.equal(harness.broadcasts.length, 1)
  assert.equal(harness.resetCount(), 1)
})

test('Gemini Live 空密钥应保留旧值', () => {
  const harness = createHarness()
  const service = new GeminiLiveConfigurationService(harness.dependencies)
  service.initialize()
  service.configure({ apiKey: 'gemini-old' })
  const result = service.configure({ apiKey: '   ' })
  assert.equal(harness.apiKey(), 'gemini-old')
  assert.equal(result.realtimeSubtitleGeminiApiKeyConfigured, true)
})

test('Gemini Live 清除密钥后应保留地址和模型并恢复未配置状态', () => {
  const harness = createHarness()
  const service = new GeminiLiveConfigurationService(harness.dependencies)
  service.initialize()
  service.configure({
    url: 'wss://gemini.example.com/live',
    model: 'gemini-custom-live',
    apiKey: 'gemini-clear'
  })
  const result = service.clearApiKey()
  assert.equal(harness.apiKey(), null)
  assert.equal(result.realtimeSubtitleGeminiApiKeyConfigured, false)
  assert.equal(result.realtimeSubtitleGeminiUrl, 'wss://gemini.example.com/live')
  assert.equal(result.realtimeSubtitleGeminiModel, 'gemini-custom-live')
})

test('Gemini Live 设置保存失败时应回滚凭证且不广播', () => {
  const harness = createHarness()
  const service = new GeminiLiveConfigurationService(harness.dependencies)
  service.initialize()
  harness.setFailSave(true)
  assert.throws(
    () => service.configure({ apiKey: 'gemini-fail' }),
    /settings write failed/u
  )
  assert.equal(harness.apiKey(), null)
  assert.equal(harness.broadcasts.length, 0)
})
