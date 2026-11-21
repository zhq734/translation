import assert from 'node:assert/strict'
import test from 'node:test'
import {
  detectRealtimeSubtitlePlatformCapability,
  getRealtimeSubtitlePlatformCapability
} from '../src/shared/realtimeSubtitlePlatform.ts'

/**
 * 校验实时字幕平台能力：macOS 14.2+、Windows 10+ 与 Linux 启用。
 * @returns 无返回值。
 * @author zhenghq
 */
test('实时字幕平台能力应覆盖 macOS 14.2+、Windows 10+ 与 Linux', () => {
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
    { supported: true, reason: null }
  )
  assert.deepEqual(
    detectRealtimeSubtitlePlatformCapability({ platform: 'win32', release: '10.0.19045' }),
    { supported: true, reason: null }
  )
  assert.deepEqual(
    detectRealtimeSubtitlePlatformCapability({ platform: 'win32', release: '6.3.9600' }),
    { supported: false, reason: 'unsupported-platform' }
  )
  assert.deepEqual(
    detectRealtimeSubtitlePlatformCapability({ platform: 'linux', release: '6.8.0-45-generic' }),
    { supported: true, reason: null }
  )
  assert.equal(typeof getRealtimeSubtitlePlatformCapability().supported, 'boolean')
})
