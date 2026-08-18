import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'

test('schema v6 设置升级后应默认关闭免订阅微软翻译并保留既有设置', () => {
  const settings = normalizeSettings({
    schemaVersion: 6,
    targetLang: 'DE',
    sourceLang: 'FR',
    dingTalkEnabled: true,
    dingTalkCorpId: 'corp-test',
    dingTalkClientId: 'client-test',
    dingTalkSecretConfigured: true,
    microsoftRegion: 'eastasia',
    microsoftSubscriptionKeyConfigured: true
  } as Parameters<typeof normalizeSettings>[0] & {
    microsoftRegion: string
    microsoftSubscriptionKeyConfigured: boolean
  })

  assert.equal(settings.schemaVersion, 8)
  assert.equal(settings.microsoftEnabled, false)
  assert.equal('microsoftRegion' in settings, false)
  assert.equal('microsoftSubscriptionKeyConfigured' in settings, false)
  assert.equal(settings.dingTalkEnabled, true)
  assert.equal(settings.targetLang, 'DE')
})

test('微软启用状态应严格按布尔值规范化且公开设置不再包含 Azure 字段', () => {
  const settings = normalizeSettings({
    schemaVersion: 7,
    microsoftEnabled: 'true' as unknown as boolean,
    microsoftRegion: 'eastasia',
    microsoftSubscriptionKeyConfigured: true,
    microsoftSubscriptionKey: 'microsoft-key-test'
  } as Parameters<typeof normalizeSettings>[0] & {
    microsoftRegion: string
    microsoftSubscriptionKeyConfigured: boolean
    microsoftSubscriptionKey: string
  })

  assert.equal(settings.microsoftEnabled, false)
  assert.equal('microsoftRegion' in settings, false)
  assert.equal('microsoftSubscriptionKeyConfigured' in settings, false)
  assert.equal('microsoftSubscriptionKey' in settings, false)
  assert.equal(JSON.stringify(settings).includes('microsoft-key-test'), false)
})

test('微软启用状态为明确布尔值时应保留', () => {
  const settings = normalizeSettings({
    schemaVersion: 7,
    microsoftEnabled: true
  })

  assert.equal(settings.microsoftEnabled, true)
})
