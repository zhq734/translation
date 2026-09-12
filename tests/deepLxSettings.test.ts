import assert from 'node:assert/strict'
import test from 'node:test'
import { DeepLxConfigurationService } from '../src/main/deepLxConfig.ts'
import { normalizeSettings, SETTINGS_SCHEMA_VERSION } from '../src/shared/settingsDefaults.ts'
import type { Settings } from '../src/shared/types.ts'

test('DeepLX 设置迁移应保留多地址且不包含 Token 状态', () => {
  const settings = normalizeSettings({
    schemaVersion: 16,
    deepLxUrl: ' https://a.example/translate， https://b.example/translate '
  })

  assert.equal(SETTINGS_SCHEMA_VERSION, 17)
  assert.equal(settings.deepLxUrl, 'https://a.example/translate， https://b.example/translate')
  assert.equal('deepLxTokenConfigured' in settings, false)
})

test('DeepLX 配置服务应保存地址，并仅在地址变化时重置运行时', () => {
  let settings = normalizeSettings({})
  let resetCount = 0
  const broadcasts: Settings[] = []
  const service = new DeepLxConfigurationService({
    getSettings: () => settings,
    saveSettings: (patch) => {
      settings = normalizeSettings({ ...settings, ...patch })
      return settings
    },
    onSettingsChanged: (next) => broadcasts.push(next),
    resetTranslationRuntime: () => { resetCount += 1 }
  })

  const saved = service.applyPatch({
    url: ' https://a.example/translate, https://b.example/translate '
  })
  assert.equal(saved.deepLxUrl, 'https://a.example/translate, https://b.example/translate')
  assert.equal(broadcasts.length, 1)
  assert.equal(resetCount, 1)

  service.applyPatch({ url: 'https://a.example/translate, https://b.example/translate' })
  assert.equal(resetCount, 1)
})
