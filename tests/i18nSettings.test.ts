import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  normalizeSettings
} from '../src/shared/settingsDefaults.ts'

test('新安装默认跟随系统，schema 升级到 20', () => {
  assert.equal(SETTINGS_SCHEMA_VERSION, 20)
  assert.equal(DEFAULT_SETTINGS.schemaVersion, 20)
  assert.equal(DEFAULT_SETTINGS.uiLocale, 'auto')
})

test('合法界面语言值应原样保留', () => {
  assert.equal(normalizeSettings({ schemaVersion: 19, uiLocale: 'zh-CN' }).uiLocale, 'zh-CN')
  assert.equal(normalizeSettings({ schemaVersion: 19, uiLocale: 'en-US' }).uiLocale, 'en-US')
  assert.equal(normalizeSettings({ schemaVersion: 19, uiLocale: 'auto' }).uiLocale, 'auto')
})

test('非法界面语言值应回退 auto', () => {
  for (const value of ['zh_CN', 'en_GB', 'fr-FR', '', null, 42]) {
    assert.equal(
      normalizeSettings({ schemaVersion: 19, uiLocale: value } as never).uiLocale,
      'auto'
    )
  }
})

test('schema 19 迁移到 20 时补齐 uiLocale 且保留其他字段', () => {
  const migrated = normalizeSettings({
    schemaVersion: 19,
    targetLang: 'EN',
    sourceLang: 'ZH',
    hotkey: 'Alt+Y',
    webTranslationMaxBlocks: 321
  } as never)
  assert.equal(migrated.schemaVersion, 20)
  assert.equal(migrated.uiLocale, 'auto')
  assert.equal(migrated.targetLang, 'EN')
  assert.equal(migrated.sourceLang, 'ZH')
  assert.equal(migrated.hotkey, 'Alt+Y')
  assert.equal(migrated.webTranslationMaxBlocks, 321)
})
