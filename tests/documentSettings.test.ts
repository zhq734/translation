import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  normalizeSettings
} from '../src/shared/settingsDefaults.ts'

test('文档翻译设置必须提供安全默认值并升级旧配置', () => {
  assert.equal(SETTINGS_SCHEMA_VERSION, 21)
  assert.equal(DEFAULT_SETTINGS.documentTranslationEnabled, true)
  assert.equal(DEFAULT_SETTINGS.documentTranslationMaxFileBytes, 100 * 1024 * 1024)
  assert.equal(DEFAULT_SETTINGS.documentTranslationMaxPages, 500)
  assert.equal(DEFAULT_SETTINGS.documentTranslationMaxOcrImages, 200)
  assert.equal(DEFAULT_SETTINGS.documentTranslationCacheMaxBytes, 1024 * 1024 * 1024)
  assert.equal(DEFAULT_SETTINGS.documentTranslationCacheMaxAgeDays, 30)

  const migrated = normalizeSettings({ schemaVersion: 20 })
  assert.equal(migrated.schemaVersion, SETTINGS_SCHEMA_VERSION)
  assert.equal(migrated.documentTranslationEnabled, true)
  assert.equal(migrated.documentTranslationMaxPages, 500)
})

test('文档翻译设置必须保留显式关闭并裁剪非法限制', () => {
  const disabled = normalizeSettings({
    schemaVersion: 21,
    documentTranslationEnabled: false,
    documentTranslationMaxFileBytes: -1,
    documentTranslationMaxPages: 999999,
    documentTranslationMaxOcrImages: 0,
    documentTranslationCacheMaxBytes: 0,
    documentTranslationCacheMaxAgeDays: 9999
  })
  assert.equal(disabled.documentTranslationEnabled, false)
  assert.equal(disabled.documentTranslationMaxFileBytes, DEFAULT_SETTINGS.documentTranslationMaxFileBytes)
  assert.equal(disabled.documentTranslationMaxPages, 5000)
  assert.equal(disabled.documentTranslationMaxOcrImages, 1)
  assert.equal(disabled.documentTranslationCacheMaxBytes, 64 * 1024 * 1024)
  assert.equal(disabled.documentTranslationCacheMaxAgeDays, 365)
})

test('文档翻译文件大小限制必须限制在 1 MB 到 2 GB', () => {
  assert.equal(normalizeSettings({
    documentTranslationMaxFileBytes: 1024
  }).documentTranslationMaxFileBytes, 1024 * 1024)
  assert.equal(normalizeSettings({
    documentTranslationMaxFileBytes: 3 * 1024 * 1024 * 1024
  }).documentTranslationMaxFileBytes, 2 * 1024 * 1024 * 1024)
})

test('设置页必须提供文档开关、资源限制与缓存保留期控件', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const source = readFileSync('src/renderer/src/settings.ts', 'utf8')
  const zh = readFileSync('src/shared/i18n/catalog.zh-CN.document.ts', 'utf8')
  const en = readFileSync('src/shared/i18n/catalog.en-US.document.ts', 'utf8')

  assert.match(html, /id="document-translation-enabled"/u)
  assert.match(html, /id="document-translation-max-file-mb"[^>]*type="number"[^>]*min="1"[^>]*max="2048"/u)
  assert.match(html, /id="document-translation-max-pages"[^>]*type="number"[^>]*min="1"[^>]*max="5000"/u)
  assert.match(html, /id="document-translation-max-ocr-images"[^>]*type="number"[^>]*min="1"[^>]*max="2000"/u)
  assert.match(html, /id="document-translation-cache-max-mb"[^>]*type="number"[^>]*min="64"[^>]*max="20480"/u)
  assert.match(html, /id="document-translation-cache-max-age-days"[^>]*type="number"[^>]*min="1"[^>]*max="365"/u)
  assert.match(source, /documentTranslationEnabled:\s*documentTranslationEnabled\.checked/u)
  assert.match(source, /documentTranslationMaxFileBytes:\s*Number\(documentTranslationMaxFileMb\.value\)\s*\*\s*1024\s*\*\s*1024/u)
  assert.match(source, /documentTranslationMaxPages:\s*Number\(documentTranslationMaxPages\.value\)/u)
  assert.match(source, /documentTranslationMaxOcrImages:\s*Number\(documentTranslationMaxOcrImages\.value\)/u)
  assert.match(source, /documentTranslationCacheMaxBytes:\s*Number\(documentTranslationCacheMaxMb\.value\)\s*\*\s*1024\s*\*\s*1024/u)
  assert.match(source, /documentTranslationCacheMaxAgeDays:\s*Number\(documentTranslationCacheMaxAgeDays\.value\)/u)
  assert.match(zh, /'settings\.document\.enabled'/u)
  assert.match(zh, /'settings\.document\.limitsHint'/u)
  assert.match(en, /'settings\.document\.enabled'/u)
  assert.match(en, /'settings\.document\.limitsHint'/u)
})
