import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, normalizeSettings } from '../src/shared/settingsDefaults'

test('网页翻译设置应提供安全默认值并升级设置版本', () => {
  assert.equal(SETTINGS_SCHEMA_VERSION, 16)
  assert.equal(DEFAULT_SETTINGS.webTranslationEnabled, true)
  assert.equal(DEFAULT_SETTINGS.webTranslationScope, 'all')
  assert.equal(DEFAULT_SETTINGS.webTranslationDefaultMode, 'target')
  assert.equal(DEFAULT_SETTINGS.webTranslationMaxBlocks, 1000)
  assert.equal(DEFAULT_SETTINGS.webTranslationMaxChars, 500000)
})

test('旧设置与非法网页翻译设置应回退默认并限制数值范围', () => {
  const migrated = normalizeSettings({ schemaVersion: 12, hotkey: 'Alt+Y' })
  assert.equal(migrated.hotkey, 'Alt+Y')
  assert.equal(migrated.webTranslationScope, 'all')

  const normalized = normalizeSettings({
    schemaVersion: 15,
    webTranslationScope: 'broken' as never,
    webTranslationDefaultMode: 'broken' as never,
    webTranslationMaxBlocks: -1,
    webTranslationMaxChars: Number.POSITIVE_INFINITY
  })
  assert.equal(normalized.webTranslationScope, 'all')
  assert.equal(normalized.webTranslationDefaultMode, 'target')
  assert.equal(normalized.webTranslationMaxBlocks, 1)
  assert.equal(normalized.webTranslationMaxChars, 500000)
})

test('旧版正文范围配置应迁移为全部可见文本，新版仍允许选择仅正文', () => {
  assert.equal(normalizeSettings({ schemaVersion: 13, webTranslationScope: 'body' }).webTranslationScope, 'all')
  assert.equal(normalizeSettings({ schemaVersion: 15, webTranslationScope: 'body' }).webTranslationScope, 'body')
})

test('容量升级只迁移缺失值或旧默认值，并保留用户自定义限制', () => {
  const missing = normalizeSettings({ schemaVersion: 14 })
  assert.equal(missing.webTranslationMaxBlocks, 1000)
  assert.equal(missing.webTranslationMaxChars, 500000)

  const oldDefaults = normalizeSettings({
    schemaVersion: 14,
    webTranslationMaxBlocks: 300,
    webTranslationMaxChars: 200000
  })
  assert.equal(oldDefaults.webTranslationMaxBlocks, 1000)
  assert.equal(oldDefaults.webTranslationMaxChars, 500000)

  const customized = normalizeSettings({
    schemaVersion: 14,
    webTranslationMaxBlocks: 600,
    webTranslationMaxChars: 350000
  })
  assert.equal(customized.webTranslationMaxBlocks, 600)
  assert.equal(customized.webTranslationMaxChars, 350000)
})

test('旧双语对照设置应迁移为原位译文模式', () => {
  const migrated = normalizeSettings({ webTranslationDefaultMode: 'bilingual' as never })
  assert.equal(migrated.webTranslationDefaultMode, 'target')
})
