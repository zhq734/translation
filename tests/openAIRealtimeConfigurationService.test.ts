import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenAIRealtimeConfigurationService } from '../src/main/openAIRealtimeConfig.ts'
import type { Settings } from '../src/shared/types.ts'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'

/**
 * 构造内存态 OpenAI Realtime 配置依赖。
 * @param initial 初始公开设置。
 * @returns 服务依赖与观察方法。
 * @author zhenghq
 */
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
    apiKey: () => apiKey,
    broadcasts,
    resetCount: () => resetCount,
    setFailSave: (value: boolean) => { failSave = value }
  }
}

test('OpenAI Realtime 初始化应同步脱敏配置标记', () => {
  const harness = createHarness()
  harness.dependencies.credentialStore.saveApiKey('openai-existing')
  const service = new OpenAIRealtimeConfigurationService(harness.dependencies)
  const result = service.initialize()
  assert.equal(result.realtimeSubtitleOpenAIRealtimeApiKeyConfigured, true)
  assert.equal(JSON.stringify(result).includes('openai-existing'), false)
})

test('OpenAI Realtime 保存地址、模型和密钥应广播脱敏设置并重启运行时', () => {
  const harness = createHarness()
  const service = new OpenAIRealtimeConfigurationService(harness.dependencies)
  service.initialize()
  const result = service.configure({
    url: 'wss://realtime.example.com/v1/realtime',
    model: 'gpt-4o-transcribe',
    apiKey: 'openai-new'
  })
  assert.equal(result.realtimeSubtitleOpenAIRealtimeUrl, 'wss://realtime.example.com/v1/realtime')
  assert.equal(result.realtimeSubtitleOpenAIRealtimeModel, 'gpt-4o-transcribe')
  assert.equal(result.realtimeSubtitleOpenAIRealtimeApiKeyConfigured, true)
  assert.equal(harness.apiKey(), 'openai-new')
  assert.equal(JSON.stringify(result).includes('openai-new'), false)
  assert.equal(harness.broadcasts.length, 1)
  assert.equal(harness.resetCount(), 1)
})

test('OpenAI Realtime 空密钥应保留旧值', () => {
  const harness = createHarness()
  const service = new OpenAIRealtimeConfigurationService(harness.dependencies)
  service.initialize()
  service.configure({ apiKey: 'openai-old' })
  const result = service.configure({ apiKey: '   ' })
  assert.equal(harness.apiKey(), 'openai-old')
  assert.equal(result.realtimeSubtitleOpenAIRealtimeApiKeyConfigured, true)
})

test('OpenAI Realtime 清除密钥后应保留地址和模型并恢复未配置状态', () => {
  const harness = createHarness()
  const service = new OpenAIRealtimeConfigurationService(harness.dependencies)
  service.initialize()
  service.configure({
    url: 'wss://realtime.example.com/v1/realtime',
    model: 'gpt-4o-transcribe',
    apiKey: 'openai-clear'
  })
  const result = service.clearApiKey()
  assert.equal(harness.apiKey(), null)
  assert.equal(result.realtimeSubtitleOpenAIRealtimeApiKeyConfigured, false)
  assert.equal(result.realtimeSubtitleOpenAIRealtimeUrl, 'wss://realtime.example.com/v1/realtime')
  assert.equal(result.realtimeSubtitleOpenAIRealtimeModel, 'gpt-4o-transcribe')
})

test('OpenAI Realtime 设置保存失败时应回滚凭证且不广播', () => {
  const harness = createHarness()
  const service = new OpenAIRealtimeConfigurationService(harness.dependencies)
  service.initialize()
  harness.setFailSave(true)
  assert.throws(
    () => service.configure({ apiKey: 'openai-fail' }),
    /settings write failed/u
  )
  assert.equal(harness.apiKey(), null)
  assert.equal(harness.broadcasts.length, 0)
})
