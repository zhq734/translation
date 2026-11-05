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
  assert.equal(SETTINGS_SCHEMA_VERSION, 29)
  assert.equal(defaults.realtimeSubtitleAudioSource, 'system')
  assert.equal(defaults.realtimeSubtitleRecognitionLang, 'auto')
  assert.equal(defaults.realtimeSubtitleAsrProvider, 'deepgram')
  assert.equal(defaults.realtimeSubtitleWhisperBaseUrl, 'http://127.0.0.1:8000/v1')
  assert.equal(defaults.realtimeSubtitleWhisperModel, 'whisper-1')
  assert.equal(defaults.realtimeSubtitleWhisperApiKeyConfigured, false)
  assert.equal(defaults.realtimeSubtitleWebSocketUrl, 'ws://127.0.0.1:9092/ws/asr')
  assert.equal(
    defaults.realtimeSubtitleDashScopeUrl,
    'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
  )
  assert.equal(
    defaults.realtimeSubtitleDashScopeModel,
    'qwen-audio-3.0-asr-flash-streaming'
  )
  assert.equal(defaults.realtimeSubtitleDashScopeApiKeyConfigured, false)
  assert.equal(defaults.realtimeSubtitleOpenAIRealtimeUrl, 'wss://api.openai.com/v1/realtime')
  assert.equal(defaults.realtimeSubtitleOpenAIRealtimeModel, 'gpt-4o-mini-transcribe')
  assert.equal(defaults.realtimeSubtitleOpenAIRealtimeApiKeyConfigured, false)
  assert.equal(defaults.realtimeSubtitleDisplayMode, 'bilingual')
  assert.equal(defaults.realtimeSubtitleFontSize, 20)
  assert.equal(defaults.realtimeSubtitleHideAfterMs, 8000)
  assert.equal(defaults.realtimeSubtitleClickThrough, true)
  assert.equal(defaults.realtimeSubtitleHotkey, 'Alt+L')

  const customized = normalizeSettings({
    schemaVersion: 28,
    realtimeSubtitleAudioSource: 'both',
    realtimeSubtitleRecognitionLang: 'ja-JP',
    realtimeSubtitleAsrProvider: 'whisper',
    realtimeSubtitleWhisperBaseUrl: 'http://localhost:9000/v1',
    realtimeSubtitleWhisperModel: 'large-v3',
    realtimeSubtitleWhisperApiKeyConfigured: true,
    realtimeSubtitleWebSocketUrl: 'wss://asr.example.com/ws/asr?language=zh',
    realtimeSubtitleDashScopeUrl: 'wss://dashscope.example.com/api-ws/v1/inference',
    realtimeSubtitleDashScopeModel: 'qwen-audio-custom',
    realtimeSubtitleDashScopeApiKeyConfigured: true,
    realtimeSubtitleOpenAIRealtimeUrl: 'wss://realtime.example.com/v1/realtime',
    realtimeSubtitleOpenAIRealtimeModel: 'gpt-4o-transcribe',
    realtimeSubtitleOpenAIRealtimeApiKeyConfigured: true,
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
    customized.realtimeSubtitleWebSocketUrl,
    'wss://asr.example.com/ws/asr?language=zh'
  )
  assert.equal(
    customized.realtimeSubtitleDashScopeUrl,
    'wss://dashscope.example.com/api-ws/v1/inference'
  )
  assert.equal(customized.realtimeSubtitleDashScopeModel, 'qwen-audio-custom')
  assert.equal(customized.realtimeSubtitleDashScopeApiKeyConfigured, true)
  assert.equal(
    customized.realtimeSubtitleOpenAIRealtimeUrl,
    'wss://realtime.example.com/v1/realtime'
  )
  assert.equal(customized.realtimeSubtitleOpenAIRealtimeModel, 'gpt-4o-transcribe')
  assert.equal(customized.realtimeSubtitleOpenAIRealtimeApiKeyConfigured, true)
  assert.equal(
    normalizeSettings({
      schemaVersion: 28,
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
    schemaVersion: 28,
    realtimeSubtitleAudioSource: 'line-in',
    realtimeSubtitleAsrProvider: 'unknown',
    realtimeSubtitleWhisperBaseUrl: 'file:///tmp/whisper',
    realtimeSubtitleWhisperModel: '   ',
    realtimeSubtitleWebSocketUrl: 'http://127.0.0.1:9092/ws/asr',
    realtimeSubtitleDashScopeUrl: 'ws://remote.example.com/api-ws/v1/inference',
    realtimeSubtitleDashScopeModel: '   ',
    realtimeSubtitleOpenAIRealtimeUrl: 'wss://user:password@realtime.example.com/v1/realtime',
    realtimeSubtitleOpenAIRealtimeModel: 'bad\u0000model',
    realtimeSubtitleDisplayMode: 'hidden',
    realtimeSubtitleFontSize: 999,
    realtimeSubtitleHideAfterMs: -1,
    realtimeSubtitleTextColor: 'red'
  })
  assert.equal(invalid.realtimeSubtitleAudioSource, 'system')
  assert.equal(invalid.realtimeSubtitleAsrProvider, 'deepgram')
  assert.equal(invalid.realtimeSubtitleWhisperBaseUrl, 'http://127.0.0.1:8000/v1')
  assert.equal(invalid.realtimeSubtitleWhisperModel, 'whisper-1')
  assert.equal(invalid.realtimeSubtitleWebSocketUrl, 'ws://127.0.0.1:9092/ws/asr')
  assert.equal(
    invalid.realtimeSubtitleDashScopeUrl,
    'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
  )
  assert.equal(
    invalid.realtimeSubtitleDashScopeModel,
    'qwen-audio-3.0-asr-flash-streaming'
  )
  assert.equal(invalid.realtimeSubtitleOpenAIRealtimeUrl, 'wss://api.openai.com/v1/realtime')
  assert.equal(invalid.realtimeSubtitleOpenAIRealtimeModel, 'gpt-4o-mini-transcribe')
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

  assert.equal(
    normalizeSettings({ realtimeSubtitleAsrProvider: 'websocket' }).realtimeSubtitleAsrProvider,
    'websocket',
    'WebSocket ASR 应作为合法 provider 保留'
  )
  for (const provider of ['alibaba', 'custom-dashscope', 'custom-openai'] as const) {
    assert.equal(
      normalizeSettings({ realtimeSubtitleAsrProvider: provider }).realtimeSubtitleAsrProvider,
      provider,
      `${provider} 应作为合法实时字幕 provider 保留`
    )
  }
  assert.equal(
    normalizeSettings({
      realtimeSubtitleWebSocketUrl: ' ws://127.0.0.1:9092/ws/asr '
    }).realtimeSubtitleWebSocketUrl,
    'ws://127.0.0.1:9092/ws/asr',
    'WebSocket 地址应去除首尾空白'
  )
  assert.equal(
    normalizeSettings({ realtimeSubtitleWebSocketUrl: 'ws://localhost:9092/ws/asr' })
      .realtimeSubtitleWebSocketUrl,
    'ws://localhost:9092/ws/asr',
    '本地明文 WebSocket 仅应允许回环主机'
  )
  assert.equal(
    normalizeSettings({ realtimeSubtitleWebSocketUrl: 'ws://192.168.1.2:9092/ws/asr' })
      .realtimeSubtitleWebSocketUrl,
    'ws://127.0.0.1:9092/ws/asr',
    '非回环主机不得使用明文 ws'
  )
  assert.equal(
    normalizeSettings({ realtimeSubtitleWebSocketUrl: 'wss://example.com/path#secret' })
      .realtimeSubtitleWebSocketUrl,
    'ws://127.0.0.1:9092/ws/asr',
    'WebSocket 地址不得包含 fragment'
  )
  assert.equal(
    normalizeSettings({ realtimeSubtitleDashScopeModel: ' model-name ' })
      .realtimeSubtitleDashScopeModel,
    'model-name',
    '实时 ASR 模型名应去除首尾空白'
  )
  assert.equal(
    normalizeSettings({ realtimeSubtitleOpenAIRealtimeModel: 'x'.repeat(257) })
      .realtimeSubtitleOpenAIRealtimeModel,
    'gpt-4o-mini-transcribe',
    '超长模型名应回退默认值'
  )
})
