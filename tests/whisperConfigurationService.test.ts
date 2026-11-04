import assert from 'node:assert/strict'
import test from 'node:test'
import { WhisperConfigurationService } from '../src/main/whisperConfig.ts'
import type { Settings } from '../src/shared/types.ts'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'

/** 构造内存态 Whisper 配置依赖。 */
function createHarness(initial: Settings = normalizeSettings({})) {
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
    settings: () => settings,
    apiKey: () => apiKey,
    broadcasts,
    resetCount: () => resetCount,
    setFailSave: (value: boolean) => { failSave = value }
  }
}

test('Whisper 初始化应同步脱敏配置标记', () => {
  const harness = createHarness()
  harness.dependencies.credentialStore.saveApiKey('whisper-existing')
  const service = new WhisperConfigurationService(harness.dependencies)
  const result = service.initialize()
  assert.equal(result.realtimeSubtitleWhisperApiKeyConfigured, true)
  assert.equal(JSON.stringify(result).includes('whisper-existing'), false)
})

test('Whisper 保存本地地址、模型和密钥应广播并重置运行时', () => {
  const harness = createHarness()
  const service = new WhisperConfigurationService(harness.dependencies)
  service.initialize()
  const result = service.configure({
    baseUrl: 'http://127.0.0.1:9000/v1/',
    model: 'large-v3',
    apiKey: 'whisper-new'
  })
  assert.equal(result.realtimeSubtitleWhisperBaseUrl, 'http://127.0.0.1:9000/v1')
  assert.equal(result.realtimeSubtitleWhisperModel, 'large-v3')
  assert.equal(result.realtimeSubtitleWhisperApiKeyConfigured, true)
  assert.equal(harness.apiKey(), 'whisper-new')
  assert.equal(JSON.stringify(result).includes('whisper-new'), false)
  assert.equal(harness.broadcasts.length, 1)
  assert.equal(harness.resetCount(), 1)
})

test('Whisper 空密钥应保留旧值', () => {
  const harness = createHarness()
  const service = new WhisperConfigurationService(harness.dependencies)
  service.initialize()
  service.configure({ apiKey: 'whisper-old' })
  const result = service.configure({ apiKey: '   ' })
  assert.equal(harness.apiKey(), 'whisper-old')
  assert.equal(result.realtimeSubtitleWhisperApiKeyConfigured, true)
})

test('Whisper 清除密钥后仍保留本地无鉴权配置', () => {
  const harness = createHarness()
  const service = new WhisperConfigurationService(harness.dependencies)
  service.initialize()
  service.configure({ baseUrl: 'http://127.0.0.1:8000/v1', model: 'small', apiKey: 'whisper-clear' })
  const result = service.clearApiKey()
  assert.equal(harness.apiKey(), null)
  assert.equal(result.realtimeSubtitleWhisperApiKeyConfigured, false)
  assert.equal(result.realtimeSubtitleWhisperBaseUrl, 'http://127.0.0.1:8000/v1')
  assert.equal(result.realtimeSubtitleWhisperModel, 'small')
})

test('Whisper 设置保存失败时应回滚凭证', () => {
  const harness = createHarness()
  const service = new WhisperConfigurationService(harness.dependencies)
  service.initialize()
  harness.setFailSave(true)
  assert.throws(() => service.configure({ apiKey: 'whisper-fail' }), /settings write failed/u)
  assert.equal(harness.apiKey(), null)
  assert.equal(harness.broadcasts.length, 0)
})
