import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MicrosoftConfigurationService } from '../src/main/microsoftConfig.ts'
import {
  MicrosoftCredentialStore,
  type MicrosoftSafeStorageAdapter
} from '../src/main/microsoftCredentials.ts'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'
import type { Settings } from '../src/shared/types.ts'

/**
 * 创建仅用于测试的可逆微软安全存储实现。
 * @param available 是否允许执行安全加密。
 * @returns 可注入凭证存储的假 safeStorage。
 * @author zhenghq
 */
function createFakeSafeStorage(available = true): MicrosoftSafeStorageAdapter {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value) => {
      const decoded = value.toString('utf8')
      if (!decoded.startsWith('encrypted:')) throw new Error('damaged microsoft-key-test')
      return decoded.slice('encrypted:'.length)
    }
  }
}

test('schema v5 设置升级后应默认关闭微软翻译并保留既有设置', () => {
  const settings = normalizeSettings({
    schemaVersion: 5,
    targetLang: 'DE',
    sourceLang: 'FR',
    dingTalkEnabled: true,
    dingTalkCorpId: 'corp-test',
    dingTalkClientId: 'client-test',
    dingTalkSecretConfigured: true
  })

  assert.equal(settings.schemaVersion, 6)
  assert.equal(settings.microsoftEnabled, false)
  assert.equal(settings.microsoftRegion, '')
  assert.equal(settings.microsoftSubscriptionKeyConfigured, false)
  assert.equal(settings.dingTalkEnabled, true)
  assert.equal(settings.targetLang, 'DE')
})

test('微软公开字段应严格规范化且普通设置不得包含明文订阅密钥', () => {
  const settings = normalizeSettings({
    schemaVersion: 6,
    microsoftEnabled: 'true' as unknown as boolean,
    microsoftRegion: '  eastasia  ',
    microsoftSubscriptionKeyConfigured: true,
    microsoftSubscriptionKey: 'microsoft-key-test'
  } as Partial<Settings> & { microsoftSubscriptionKey: string })

  assert.equal(settings.microsoftEnabled, false)
  assert.equal(settings.microsoftRegion, 'eastasia')
  assert.equal(settings.microsoftSubscriptionKeyConfigured, true)
  assert.equal('microsoftSubscriptionKey' in settings, false)
  assert.equal(JSON.stringify(settings).includes('microsoft-key-test'), false)
})

test('微软订阅密钥应加密保存、留空保留并支持显式清除', () => {
  const directory = mkdtempSync(join(tmpdir(), 'microsoft-credentials-'))
  try {
    const path = join(directory, 'microsoft-credentials.json')
    const store = new MicrosoftCredentialStore(path, createFakeSafeStorage())

    store.saveKey('microsoft-key-test')
    const before = readFileSync(path, 'utf8')
    assert.equal(before.includes('microsoft-key-test'), false)
    assert.deepEqual(store.readKey(), {
      configured: true,
      subscriptionKey: 'microsoft-key-test'
    })

    store.saveKey('   ')
    assert.equal(readFileSync(path, 'utf8'), before)

    store.clearKey()
    assert.deepEqual(store.readKey(), { configured: false, subscriptionKey: null })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('安全存储不可用时微软凭证不得写入磁盘', () => {
  const directory = mkdtempSync(join(tmpdir(), 'microsoft-credentials-unavailable-'))
  try {
    const path = join(directory, 'microsoft-credentials.json')
    const store = new MicrosoftCredentialStore(path, createFakeSafeStorage(false))

    assert.throws(() => store.saveKey('microsoft-key-test'), /安全存储不可用/u)
    assert.equal(existsSync(path), false)
    assert.equal(existsSync(`${path}.tmp`), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('微软配置服务保存成功后只广播脱敏设置并重置翻译运行时', () => {
  let settings = normalizeSettings({ schemaVersion: 6 })
  let subscriptionKey: string | null = null
  let resetCount = 0
  const broadcasts: Settings[] = []
  const service = new MicrosoftConfigurationService({
    getSettings: () => settings,
    saveSettings: (patch) => {
      settings = normalizeSettings({ ...settings, ...patch })
      return settings
    },
    credentialStore: {
      readKey: () => ({ configured: subscriptionKey != null, subscriptionKey }),
      saveKey: (value) => { subscriptionKey = value },
      clearKey: () => { subscriptionKey = null }
    },
    onSettingsChanged: (next) => broadcasts.push(next),
    resetTranslationRuntime: () => { resetCount += 1 }
  })

  service.initialize()
  const result = service.applyPatch({
    enabled: true,
    region: ' eastasia ',
    subscriptionKey: 'microsoft-key-test'
  })

  assert.equal(result.microsoftEnabled, true)
  assert.equal(result.microsoftRegion, 'eastasia')
  assert.equal(result.microsoftSubscriptionKeyConfigured, true)
  assert.deepEqual(service.getCredentialsSnapshot(), {
    subscriptionKey: 'microsoft-key-test',
    region: 'eastasia'
  })
  assert.equal(JSON.stringify(result).includes('microsoft-key-test'), false)
  assert.equal(JSON.stringify(broadcasts).includes('microsoft-key-test'), false)
  assert.equal(resetCount, 1)
})

test('微软公开设置保存失败时应回滚新订阅密钥且不广播配置', () => {
  let settings = normalizeSettings({
    schemaVersion: 6,
    microsoftEnabled: true,
    microsoftSubscriptionKeyConfigured: true
  })
  let subscriptionKey: string | null = 'old-key'
  let broadcastCount = 0
  let resetCount = 0
  const service = new MicrosoftConfigurationService({
    getSettings: () => settings,
    saveSettings: () => {
      throw new Error('settings write failed')
    },
    credentialStore: {
      readKey: () => ({ configured: true, subscriptionKey }),
      saveKey: (value) => { subscriptionKey = value },
      clearKey: () => { subscriptionKey = null }
    },
    onSettingsChanged: () => { broadcastCount += 1 },
    resetTranslationRuntime: () => { resetCount += 1 }
  })

  service.initialize()
  assert.throws(() => service.applyPatch({ subscriptionKey: 'new-key' }), /settings write failed/u)

  assert.equal(subscriptionKey, 'old-key')
  assert.equal(service.getCredentialsSnapshot()?.subscriptionKey, 'old-key')
  assert.equal(broadcastCount, 0)
  assert.equal(resetCount, 0)
})
