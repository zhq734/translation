import assert from 'node:assert/strict'
import test from 'node:test'
import {
  detectRealtimeSubtitlePlatformCapability,
  getRealtimeSubtitlePlatformCapability
} from '../src/shared/realtimeSubtitlePlatform.ts'

/**
 * 校验实时字幕只在 macOS 14.2 及以上启用。
 * @returns 无返回值。
 * @author zhenghq
 */
test('实时字幕平台能力应限制为 macOS 14.2 及以上', () => {
  assert.deepEqual(
    detectRealtimeSubtitlePlatformCapability({ platform: 'darwin', release: '14.2.0' }),
    { supported: true, reason: null }
  )
  assert.deepEqual(
    detectRealtimeSubtitlePlatformCapability({ platform: 'darwin', release: '14.1.9' }),
    { supported: false, reason: 'macos-version-unsupported' }
  )
  assert.deepEqual(
    detectRealtimeSubtitlePlatformCapability({ platform: 'darwin', release: '13.7.6' }),
    { supported: false, reason: 'macos-version-unsupported' }
  )
  assert.deepEqual(
    detectRealtimeSubtitlePlatformCapability({ platform: 'win32', release: '10.0.22631' }),
    { supported: false, reason: 'unsupported-platform' }
  )
  assert.equal(typeof getRealtimeSubtitlePlatformCapability().supported, 'boolean')
})
