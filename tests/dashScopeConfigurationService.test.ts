import assert from 'node:assert/strict'
import test from 'node:test'
import { DashScopeConfigurationService } from '../src/main/dashScopeConfig.ts'
import type { Settings } from '../src/shared/types.ts'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'

/**
 * 构造内存态 DashScope 配置依赖。
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

test('DashScope 初始化应同步脱敏配置标记', () => {
  const harness = createHarness()
  harness.dependencies.credentialStore.saveApiKey('dashscope-existing')
  const service = new DashScopeConfigurationService(harness.dependencies)
  const result = service.initialize()
  assert.equal(result.realtimeSubtitleDashScopeApiKeyConfigured, true)
  assert.equal(JSON.stringify(result).includes('dashscope-existing'), false)
})

test('DashScope 保存地址、模型和密钥应广播脱敏设置并重启运行时', () => {
  const harness = createHarness()
  const service = new DashScopeConfigurationService(harness.dependencies)
  service.initialize()
  const result = service.configure({
    url: 'wss://dashscope.example.com/api-ws/v1/inference',
    model: 'qwen-audio-custom',
    apiKey: 'dashscope-new'
  })
  assert.equal(
    result.realtimeSubtitleDashScopeUrl,
    'wss://dashscope.example.com/api-ws/v1/inference'
  )
  assert.equal(result.realtimeSubtitleDashScopeModel, 'qwen-audio-custom')
  assert.equal(result.realtimeSubtitleDashScopeApiKeyConfigured, true)
  assert.equal(harness.apiKey(), 'dashscope-new')
  assert.equal(JSON.stringify(result).includes('dashscope-new'), false)
  assert.equal(harness.broadcasts.length, 1)
  assert.equal(harness.resetCount(), 1)
})

test('DashScope 空密钥应保留旧值', () => {
  const harness = createHarness()
  const service = new DashScopeConfigurationService(harness.dependencies)
  service.initialize()
  service.configure({ apiKey: 'dashscope-old' })
  const result = service.configure({ apiKey: '   ' })
  assert.equal(harness.apiKey(), 'dashscope-old')
  assert.equal(result.realtimeSubtitleDashScopeApiKeyConfigured, true)
})

test('DashScope 清除密钥后应保留地址和模型并恢复未配置状态', () => {
  const harness = createHarness()
  const service = new DashScopeConfigurationService(harness.dependencies)
  service.initialize()
  service.configure({
    url: 'wss://dashscope.example.com/api-ws/v1/inference',
    model: 'qwen-audio-custom',
    apiKey: 'dashscope-clear'
  })
  const result = service.clearApiKey()
  assert.equal(harness.apiKey(), null)
  assert.equal(result.realtimeSubtitleDashScopeApiKeyConfigured, false)
  assert.equal(result.realtimeSubtitleDashScopeUrl, 'wss://dashscope.example.com/api-ws/v1/inference')
  assert.equal(result.realtimeSubtitleDashScopeModel, 'qwen-audio-custom')
})

test('DashScope 设置保存失败时应回滚凭证且不广播', () => {
  const harness = createHarness()
  const service = new DashScopeConfigurationService(harness.dependencies)
  service.initialize()
  harness.setFailSave(true)
  assert.throws(
    () => service.configure({ apiKey: 'dashscope-fail' }),
    /settings write failed/u
  )
  assert.equal(harness.apiKey(), null)
  assert.equal(harness.broadcasts.length, 0)
})
