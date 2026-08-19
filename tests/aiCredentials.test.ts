import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AiCredentialStore, type SafeStorageAdapter } from '../src/main/aiCredentials.ts'

/**
 * 创建仅用于测试的可逆安全存储实现。
 * @param available 是否允许执行安全加密。
 * @returns 可注入凭证存储的假 safeStorage。
 * @author zhenghq
 */
function createFakeSafeStorage(available = true): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value: Buffer) => {
      const text = value.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('decrypt failed')
      return text.slice(4)
    }
  }
}

test('首次保存非空 API Key 应加密写入并返回已配置状态', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-cred-'))
  try {
    const path = join(dir, 'ai-credentials.json')
    const store = new AiCredentialStore(path, createFakeSafeStorage())
    store.saveApiKey('sk-test-key')
    const disk = readFileSync(path, 'utf8')
    const loaded = store.readApiKey()

    assert.equal(disk.includes('sk-test-key'), false)
    assert.equal(loaded.configured, true)
    assert.equal(loaded.apiKey, 'sk-test-key')
    assert.equal('apiKey' in (loaded as Record<string, unknown>), false || loaded.apiKey === 'sk-test-key')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('空字符串 API Key 应保留旧密钥', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-cred-'))
  try {
    const path = join(dir, 'ai-credentials.json')
    const store = new AiCredentialStore(path, createFakeSafeStorage())
    store.saveApiKey('sk-old')
    const before = readFileSync(path, 'utf8')
    store.saveApiKey('   ')
    assert.equal(readFileSync(path, 'utf8'), before)
    assert.equal(store.readApiKey().configured, true)
    assert.equal(store.readApiKey().apiKey, 'sk-old')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('显式清除 API Key 应删除凭证并返回未配置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-cred-'))
  try {
    const path = join(dir, 'ai-credentials.json')
    const store = new AiCredentialStore(path, createFakeSafeStorage())
    store.saveApiKey('sk-to-clear')
    store.clearApiKey()
    assert.equal(existsSync(path), false)
    assert.deepEqual(store.readApiKey(), { configured: false, apiKey: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('安全存储不可用时应拒绝保存且不产生明文文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-cred-'))
  try {
    const path = join(dir, 'ai-credentials.json')
    const store = new AiCredentialStore(path, createFakeSafeStorage(false))
    assert.throws(() => store.saveApiKey('sk-test'), /安全存储不可用/u)
    assert.throws(() => readFileSync(path, 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('密文损坏时应返回脱敏错误且视为未配置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-cred-'))
  try {
    const path = join(dir, 'ai-credentials.json')
    writeFileSync(path, JSON.stringify({ version: 1, aiApiKey: Buffer.from('broken').toString('base64') }))
    const store = new AiCredentialStore(path, createFakeSafeStorage())
    const loaded = store.readApiKey()
    assert.equal(loaded.configured, false)
    assert.equal(loaded.apiKey, null)
    assert.match(loaded.error || '', /无法读取已保存的 AI 凭证/u)
    assert.equal((loaded.error || '').includes('sk-'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('无凭证文件时读取应返回未配置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-cred-'))
  try {
    const store = new AiCredentialStore(join(dir, 'ai-credentials.json'), createFakeSafeStorage())
    assert.deepEqual(store.readApiKey(), { configured: false, apiKey: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
