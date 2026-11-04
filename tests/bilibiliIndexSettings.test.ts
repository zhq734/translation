import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  normalizeSettings
} from '../src/shared/settingsDefaults.ts'
import { TRANSLATION_PROVIDERS, isTranslationProviderAvailable } from '../src/shared/translationProviders.ts'

test('Bilibili Index-Translate 设置应默认启用并使用 9B 均衡模型', () => {
  assert.equal(SETTINGS_SCHEMA_VERSION, 27)
  assert.equal(DEFAULT_SETTINGS.biliIndexTranslateEnabled, true)
  assert.equal(DEFAULT_SETTINGS.biliIndexTranslateModel, 'index-mt-9b')
  assert.equal(normalizeSettings({ schemaVersion: 23 }).biliIndexTranslateEnabled, true)
  assert.equal(normalizeSettings({ schemaVersion: 23 }).biliIndexTranslateModel, 'index-mt-9b')
})

test('Bilibili Index-Translate 合法模型应保留，未知模型应回退 9B', () => {
  for (const model of ['index-mt-2b', 'index-mt-9b', 'index-mt-35b'] as const) {
    assert.equal(normalizeSettings({ biliIndexTranslateModel: model }).biliIndexTranslateModel, model)
  }
  assert.equal(
    normalizeSettings({ biliIndexTranslateModel: 'unknown' as never }).biliIndexTranslateModel,
    'index-mt-9b'
  )
})

test('Bilibili Index-Translate 显式关闭必须保留', () => {
  assert.equal(
    normalizeSettings({ biliIndexTranslateEnabled: false }).biliIndexTranslateEnabled,
    false
  )
})

test('Bilibili Index-Translate 应加入弹窗 API 列表并依据启用状态判断可用性', () => {
  const provider = TRANSLATION_PROVIDERS.find((item) => item.id === 'bili-index')
  assert.ok(provider)
  assert.equal(provider.label, 'Bilibili Index-Translate')
  assert.equal(isTranslationProviderAvailable('bili-index', {
    ...DEFAULT_SETTINGS,
    biliIndexTranslateEnabled: true
  }), true)
  assert.equal(isTranslationProviderAvailable('bili-index', {
    ...DEFAULT_SETTINGS,
    biliIndexTranslateEnabled: false
  }), false)
})
