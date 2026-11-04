import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSettings, SETTINGS_SCHEMA_VERSION } from '../src/shared/settingsDefaults.ts'

/**
 * 校验实时字幕设置默认值、合法值保留与非法值回退。
 * @returns 无返回值。
 * @author zhenghq
 */
test('实时字幕设置应完成默认值与非法值迁移', () => {
  const defaults = normalizeSettings({ schemaVersion: 24 })
  assert.equal(SETTINGS_SCHEMA_VERSION, 26)
  assert.equal(defaults.realtimeSubtitleAudioSource, 'system')
  assert.equal(defaults.realtimeSubtitleRecognitionLang, 'auto')
  assert.equal(defaults.realtimeSubtitleDisplayMode, 'bilingual')
  assert.equal(defaults.realtimeSubtitleFontSize, 20)
  assert.equal(defaults.realtimeSubtitleHideAfterMs, 8000)
  assert.equal(defaults.realtimeSubtitleClickThrough, true)
  assert.equal(defaults.realtimeSubtitleHotkey, 'Alt+L')

  const customized = normalizeSettings({
    schemaVersion: 26,
    realtimeSubtitleAudioSource: 'both',
    realtimeSubtitleRecognitionLang: 'ja-JP',
    realtimeSubtitleDisplayMode: 'target',
    realtimeSubtitleFontSize: 32,
    realtimeSubtitleHideAfterMs: 12000,
    realtimeSubtitleTextColor: '#12ab34',
    realtimeSubtitleClickThrough: false,
    realtimeSubtitleHotkey: ''
  })
  assert.equal(customized.realtimeSubtitleAudioSource, 'both')
  assert.equal(customized.realtimeSubtitleRecognitionLang, 'ja-JP')
  assert.equal(customized.realtimeSubtitleDisplayMode, 'target')
  assert.equal(customized.realtimeSubtitleFontSize, 32)
  assert.equal(customized.realtimeSubtitleHideAfterMs, 12000)
  assert.equal(customized.realtimeSubtitleTextColor, '#12ab34')
  assert.equal(customized.realtimeSubtitleClickThrough, false)
  assert.equal(customized.realtimeSubtitleHotkey, '')

  const invalid = normalizeSettings({
    schemaVersion: 26,
    realtimeSubtitleAudioSource: 'line-in',
    realtimeSubtitleDisplayMode: 'hidden',
    realtimeSubtitleFontSize: 999,
    realtimeSubtitleHideAfterMs: -1,
    realtimeSubtitleTextColor: 'red'
  })
  assert.equal(invalid.realtimeSubtitleAudioSource, 'system')
  assert.equal(invalid.realtimeSubtitleDisplayMode, 'bilingual')
  assert.equal(invalid.realtimeSubtitleFontSize, 40)
  assert.equal(invalid.realtimeSubtitleHideAfterMs, 8000)
  assert.equal(invalid.realtimeSubtitleTextColor, '#ffffff')

  assert.equal(
    normalizeSettings({ realtimeSubtitleHideAfterMs: 0 }).realtimeSubtitleHideAfterMs,
    0,
    '0 应作为关闭自动隐藏的显式设置保留'
  )
  assert.equal(
    normalizeSettings({ realtimeSubtitleHideAfterMs: 600_000 }).realtimeSubtitleHideAfterMs,
    120_000,
    '自动隐藏时长应限制在安全上限内'
  )
})
