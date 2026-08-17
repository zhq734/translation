import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'
import {
  DingTalkCredentialStore,
  type SafeStorageAdapter
} from '../src/main/dingtalkCredentials.ts'
import { DingTalkConfigurationService } from '../src/main/dingtalkConfig.ts'
import type { Settings } from '../src/shared/types.ts'

/**
 * 创建仅用于测试的可逆安全存储实现。
 * @param available 是否允许执行安全加密。
 * @returns 可注入凭证存储的假 safeStorage。
 * @author zhenghq
 */
function createFakeSafeStorage(available = true): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value) => {
      const decoded = value.toString('utf8')
      if (!decoded.startsWith('encrypted:')) throw new Error('damaged ciphertext secret-test')
      return decoded.slice('encrypted:'.length)
    }
  }
}

test('schema v4 设置升级后应保留原值并默认关闭钉钉翻译', () => {
  const settings = normalizeSettings({
    schemaVersion: 4,
    targetLang: 'DE',
    sourceLang: 'FR',
    hotkey: 'Alt+Y',
    autoHideMs: 5000,
    deepLxUrl: 'http://127.0.0.1:1189/translate',
    triggerMode: 'hotkey',
    proxyMode: 'custom',
    proxyRules: 'http://127.0.0.1:7890',
    proxyBypassRules: '<local>;localhost'
  })

  assert.equal(settings.schemaVersion, 7)
  assert.equal(settings.dingTalkEnabled, false)
  assert.equal(settings.dingTalkCorpId, '')
  assert.equal(settings.dingTalkClientId, '')
  assert.equal(settings.dingTalkSecretConfigured, false)
  assert.equal(settings.targetLang, 'DE')
  assert.equal(settings.sourceLang, 'FR')
  assert.equal(settings.hotkey, 'Alt+Y')
  assert.equal(settings.autoHideMs, 5000)
  assert.equal(settings.deepLxUrl, 'http://127.0.0.1:1189/translate')
  assert.equal(settings.triggerMode, 'hotkey')
  assert.equal(settings.proxyMode, 'custom')
})

test('更早版本升级后也应初始化脱敏的钉钉公开字段', () => {
  const settings = normalizeSettings({ schemaVersion: 2, autoTrigger: true })

  assert.equal(settings.schemaVersion, 7)
  assert.equal(settings.dingTalkEnabled, false)
  assert.equal(settings.dingTalkCorpId, '')
  assert.equal(settings.dingTalkClientId, '')
  assert.equal(settings.dingTalkSecretConfigured, false)
})

test('钉钉公开字段应严格规范化且普通设置不得读取明文 Secret', () => {
  const settings = normalizeSettings({
    schemaVersion: 5,
    dingTalkEnabled: 'true' as unknown as boolean,
    dingTalkCorpId: '  corp-test  ',
    dingTalkClientId: '  client-test  ',
    dingTalkSecretConfigured: true,
    dingTalkClientSecret: 'secret-test'
  } as Partial<Settings> & { dingTalkClientSecret: string })

  assert.equal(settings.dingTalkEnabled, false)
  assert.equal(settings.dingTalkCorpId, 'corp-test')
  assert.equal(settings.dingTalkClientId, 'client-test')
  assert.equal(settings.dingTalkSecretConfigured, true)
  assert.equal('dingTalkClientSecret' in settings, false)
  assert.equal('clientSecret' in settings, false)
})

test('凭证存储应加密保存并只返回脱敏状态', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dingtalk-credentials-'))
  try {
    const path = join(directory, 'credentials.json')
    const store = new DingTalkCredentialStore(path, createFakeSafeStorage())

    store.saveSecret('secret-test')
    const disk = readFileSync(path, 'utf8')
    const loaded = store.readSecret()

    assert.equal(disk.includes('secret-test'), false)
    assert.equal(loaded.secret, 'secret-test')
    assert.equal(loaded.configured, true)
    assert.equal('ciphertext' in loaded, false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('空 Secret 应保留旧值，显式清除才删除凭证', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dingtalk-credentials-'))
  try {
    const path = join(directory, 'credentials.json')
    const store = new DingTalkCredentialStore(path, createFakeSafeStorage())
    store.saveSecret('secret-test')
    const before = readFileSync(path, 'utf8')

    store.saveSecret('   ')
    assert.equal(readFileSync(path, 'utf8'), before)
    assert.equal(store.readSecret().configured, true)

    store.clearSecret()
    assert.deepEqual(store.readSecret(), { configured: false, secret: null })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('安全存储不可用时应拒绝写入且不产生明文文件', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dingtalk-credentials-'))
  try {
    const path = join(directory, 'credentials.json')
    const store = new DingTalkCredentialStore(path, createFakeSafeStorage(false))

    assert.throws(() => store.saveSecret('secret-test'), /安全存储不可用/u)
    assert.throws(() => readFileSync(path, 'utf8'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('密文损坏时应返回脱敏错误且视为未配置', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dingtalk-credentials-'))
  try {
    const path = join(directory, 'credentials.json')
    writeFileSync(path, JSON.stringify({ version: 1, dingTalkClientSecret: Buffer.from('broken').toString('base64') }))
    const store = new DingTalkCredentialStore(path, createFakeSafeStorage())

    const loaded = store.readSecret()
    assert.equal(loaded.configured, false)
    assert.equal(loaded.secret, null)
    assert.match(loaded.error || '', /无法读取已保存的钉钉凭证/u)
    assert.equal((loaded.error || '').includes('secret-test'), false)
    assert.equal((loaded.error || '').includes('broken'), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('钉钉配置补丁失败时不广播半成品，成功快照不包含 Secret', () => {
  let settings = normalizeSettings({ schemaVersion: 5 })
  let secret: string | null = null
  let failSettingsSave = false
  const broadcasts: Settings[] = []
  let resetCount = 0
  const service = new DingTalkConfigurationService({
    getSettings: () => settings,
    saveSettings: (patch) => {
      if (failSettingsSave) throw new Error('settings write failed')
      settings = normalizeSettings({ ...settings, ...patch })
      return settings
    },
    credentialStore: {
      readSecret: () => ({ configured: secret != null, secret }),
      saveSecret: (value) => { secret = value },
      clearSecret: () => { secret = null }
    },
    onSettingsChanged: (next) => broadcasts.push(next),
    resetTranslationRuntime: () => { resetCount += 1 }
  })
  service.initialize()

  failSettingsSave = true
  assert.throws(() => service.applyPatch({
    enabled: true,
    corpId: 'corp-test',
    clientId: 'client-test',
    clientSecret: 'secret-test'
  }), /settings write failed/u)
  assert.equal(secret, null)
  assert.equal(broadcasts.length, 0)
  assert.equal(resetCount, 0)

  failSettingsSave = false
  const result = service.applyPatch({
    enabled: true,
    corpId: 'corp-test',
    clientId: 'client-test',
    clientSecret: 'secret-test'
  })
  assert.equal(result.dingTalkSecretConfigured, true)
  assert.equal('clientSecret' in result, false)
  assert.equal('dingTalkClientSecret' in result, false)
  assert.equal(JSON.stringify(broadcasts).includes('secret-test'), false)
  assert.equal(resetCount, 1)
})
