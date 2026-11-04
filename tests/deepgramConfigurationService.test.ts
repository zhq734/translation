import assert from 'node:assert/strict'
import test from 'node:test'
import { DeepgramConfigurationService } from '../src/main/deepgramConfig.ts'
import type { Settings } from '../src/shared/types.ts'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'

/** 构造内存态 Deepgram 配置依赖。 */
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

test('Deepgram 初始化应同步脱敏配置标记', () => {
  const harness = createHarness()
  harness.dependencies.credentialStore.saveApiKey('dg-existing')
  const service = new DeepgramConfigurationService(harness.dependencies)
  const result = service.initialize()
  assert.equal(result.realtimeSubtitleDeepgramApiKeyConfigured, true)
  assert.equal(JSON.stringify(result).includes('dg-existing'), false)
})

test('Deepgram 保存密钥应广播脱敏设置并重置实时字幕运行时', () => {
  const harness = createHarness()
  const service = new DeepgramConfigurationService(harness.dependencies)
  service.initialize()
  const result = service.configure({ apiKey: 'dg-new' })
  assert.equal(result.realtimeSubtitleDeepgramApiKeyConfigured, true)
  assert.equal(harness.apiKey(), 'dg-new')
  assert.equal(JSON.stringify(result).includes('dg-new'), false)
  assert.equal(harness.broadcasts.length, 1)
  assert.equal(harness.resetCount(), 1)
})

test('Deepgram 空密钥应保留旧值', () => {
  const harness = createHarness()
  const service = new DeepgramConfigurationService(harness.dependencies)
  service.initialize()
  service.configure({ apiKey: 'dg-old' })
  const result = service.configure({ apiKey: '   ' })
  assert.equal(harness.apiKey(), 'dg-old')
  assert.equal(result.realtimeSubtitleDeepgramApiKeyConfigured, true)
})

test('Deepgram 清除密钥应恢复未配置状态', () => {
  const harness = createHarness()
  const service = new DeepgramConfigurationService(harness.dependencies)
  service.initialize()
  service.configure({ apiKey: 'dg-clear' })
  const result = service.clearApiKey()
  assert.equal(harness.apiKey(), null)
  assert.equal(result.realtimeSubtitleDeepgramApiKeyConfigured, false)
})

test('Deepgram 设置保存失败时应回滚凭证', () => {
  const harness = createHarness()
  const service = new DeepgramConfigurationService(harness.dependencies)
  service.initialize()
  harness.setFailSave(true)
  assert.throws(() => service.configure({ apiKey: 'dg-fail' }), /settings write failed/u)
  assert.equal(harness.apiKey(), null)
  assert.equal(harness.broadcasts.length, 0)
})
