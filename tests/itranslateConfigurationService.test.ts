import assert from 'node:assert/strict'
import test from 'node:test'
import { ITranslateConfigurationService } from '../src/main/itranslateConfig.ts'
import type { Settings } from '../src/shared/types.ts'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'

/** 构造内存态 iTranslate 配置依赖。 */
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
    resetTranslationRuntime: () => { resetCount += 1 }
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

test('iTranslate 初始化应同步脱敏配置标记', () => {
  const harness = createHarness()
  harness.dependencies.credentialStore.saveApiKey('it-existing')
  const service = new ITranslateConfigurationService(harness.dependencies)
  const result = service.initialize()
  assert.equal(result.itranslateApiKeyConfigured, true)
  assert.equal(JSON.stringify(result).includes('it-existing'), false)
})

test('iTranslate 保存启用状态和密钥应复用翻译运行时重置', () => {
  const harness = createHarness()
  const service = new ITranslateConfigurationService(harness.dependencies)
  service.initialize()
  const result = service.configure({ enabled: true, apiKey: 'it-new' })
  assert.equal(result.itranslateEnabled, true)
  assert.equal(result.itranslateApiKeyConfigured, true)
  assert.equal(harness.apiKey(), 'it-new')
  assert.equal(JSON.stringify(result).includes('it-new'), false)
  assert.equal(harness.broadcasts.length, 1)
  assert.equal(harness.resetCount(), 1)
})

test('iTranslate 空密钥应保留旧值且单独切换开关仍重置运行时', () => {
  const harness = createHarness()
  const service = new ITranslateConfigurationService(harness.dependencies)
  service.initialize()
  service.configure({ enabled: true, apiKey: 'it-old' })
  const before = harness.resetCount()
  const result = service.configure({ enabled: false })
  assert.equal(harness.apiKey(), 'it-old')
  assert.equal(result.itranslateEnabled, false)
  assert.equal(harness.resetCount(), before + 1)
})

test('iTranslate 清除密钥应保持启用状态并广播未配置', () => {
  const harness = createHarness(normalizeSettings({ itranslateEnabled: true }))
  const service = new ITranslateConfigurationService(harness.dependencies)
  service.initialize()
  service.configure({ apiKey: 'it-clear' })
  const result = service.clearApiKey()
  assert.equal(harness.apiKey(), null)
  assert.equal(result.itranslateEnabled, true)
  assert.equal(result.itranslateApiKeyConfigured, false)
})

test('iTranslate 设置保存失败时应回滚凭证', () => {
  const harness = createHarness()
  const service = new ITranslateConfigurationService(harness.dependencies)
  service.initialize()
  harness.setFailSave(true)
  assert.throws(() => service.configure({ enabled: true, apiKey: 'it-fail' }), /settings write failed/u)
  assert.equal(harness.apiKey(), null)
  assert.equal(harness.broadcasts.length, 0)
})
