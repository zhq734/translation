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
  assert.equal(SETTINGS_SCHEMA_VERSION, 27)
  assert.equal(defaults.realtimeSubtitleAudioSource, 'system')
  assert.equal(defaults.realtimeSubtitleRecognitionLang, 'auto')
  assert.equal(defaults.realtimeSubtitleAsrProvider, 'deepgram')
  assert.equal(defaults.realtimeSubtitleWhisperBaseUrl, 'http://127.0.0.1:8000/v1')
  assert.equal(defaults.realtimeSubtitleWhisperModel, 'whisper-1')
  assert.equal(defaults.realtimeSubtitleWhisperApiKeyConfigured, false)
  assert.equal(defaults.realtimeSubtitleDisplayMode, 'bilingual')
  assert.equal(defaults.realtimeSubtitleFontSize, 20)
  assert.equal(defaults.realtimeSubtitleHideAfterMs, 8000)
  assert.equal(defaults.realtimeSubtitleClickThrough, true)
  assert.equal(defaults.realtimeSubtitleHotkey, 'Alt+L')

  const customized = normalizeSettings({
    schemaVersion: 27,
    realtimeSubtitleAudioSource: 'both',
    realtimeSubtitleRecognitionLang: 'ja-JP',
    realtimeSubtitleAsrProvider: 'whisper',
    realtimeSubtitleWhisperBaseUrl: 'http://localhost:9000/v1',
    realtimeSubtitleWhisperModel: 'large-v3',
    realtimeSubtitleWhisperApiKeyConfigured: true,
    realtimeSubtitleDisplayMode: 'target',
    realtimeSubtitleFontSize: 32,
    realtimeSubtitleHideAfterMs: 12000,
    realtimeSubtitleTextColor: '#12ab34',
    realtimeSubtitleClickThrough: false,
    realtimeSubtitleHotkey: ''
  })
  assert.equal(customized.realtimeSubtitleAudioSource, 'both')
  assert.equal(customized.realtimeSubtitleRecognitionLang, 'ja-JP')
  assert.equal(customized.realtimeSubtitleAsrProvider, 'whisper')
  assert.equal(customized.realtimeSubtitleWhisperBaseUrl, 'http://localhost:9000/v1')
  assert.equal(customized.realtimeSubtitleWhisperModel, 'large-v3')
  assert.equal(customized.realtimeSubtitleWhisperApiKeyConfigured, true)
  assert.equal(
    normalizeSettings({
      schemaVersion: 27,
      realtimeSubtitleWhisperBaseUrl: 'http://127.0.0.1:8080/inference/'
    }).realtimeSubtitleWhisperBaseUrl,
    'http://127.0.0.1:8080/inference',
    'whisper.cpp 的完整 inference 端点应原样保留，只去除尾部斜杠'
  )
  assert.equal(customized.realtimeSubtitleDisplayMode, 'target')
  assert.equal(customized.realtimeSubtitleFontSize, 32)
  assert.equal(customized.realtimeSubtitleHideAfterMs, 12000)
  assert.equal(customized.realtimeSubtitleTextColor, '#12ab34')
  assert.equal(customized.realtimeSubtitleClickThrough, false)
  assert.equal(customized.realtimeSubtitleHotkey, '')

  const invalid = normalizeSettings({
    schemaVersion: 27,
    realtimeSubtitleAudioSource: 'line-in',
    realtimeSubtitleAsrProvider: 'unknown',
    realtimeSubtitleWhisperBaseUrl: 'file:///tmp/whisper',
    realtimeSubtitleWhisperModel: '   ',
    realtimeSubtitleDisplayMode: 'hidden',
    realtimeSubtitleFontSize: 999,
    realtimeSubtitleHideAfterMs: -1,
    realtimeSubtitleTextColor: 'red'
  })
  assert.equal(invalid.realtimeSubtitleAudioSource, 'system')
  assert.equal(invalid.realtimeSubtitleAsrProvider, 'deepgram')
  assert.equal(invalid.realtimeSubtitleWhisperBaseUrl, 'http://127.0.0.1:8000/v1')
  assert.equal(invalid.realtimeSubtitleWhisperModel, 'whisper-1')
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
