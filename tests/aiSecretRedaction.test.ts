import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'
import { AiConfigurationService } from '../src/main/aiConfig.ts'
import type { Settings } from '../src/shared/types.ts'

/**
 * 构造一个记录所有广播的内存态 AI 配置服务依赖。
 * @returns 含依赖、状态查询和广播记录的对象。
 * @author zhenghq
 */
function createHarness() {
  let settings = normalizeSettings({ schemaVersion: 9 } as never)
  let apiKey: string | null = null
  let resetCount = 0
  const broadcasts: Settings[] = []
  let secret = ''
  const deps = {
    getSettings: () => settings,
    saveSettings: (patch: Partial<Settings>): Settings => {
      settings = normalizeSettings({ ...settings, ...patch })
      return settings
    },
    credentialStore: {
      readApiKey: () => ({ configured: apiKey != null, apiKey }),
      saveApiKey: (v: string): void => { apiKey = v; secret = v },
      clearApiKey: (): void => { apiKey = null; secret = '' }
    },
    onSettingsChanged: (next: Settings): void => broadcasts.push(next),
    resetTranslationRuntime: (): void => { resetCount += 1 }
  }
  return { deps, broadcasts, resetCount: () => resetCount, secret: () => secret }
}

test('公开 Settings、广播、日志路径均不应包含 API Key 明文', () => {
  const h = createHarness()
  const service = new AiConfigurationService(h.deps)
  service.initialize()
  const result = service.applyPatch({ enabled: true, apiKey: 'sk-super-secret-value' })
  assert.equal(result.aiApiKeyConfigured, true)
  assert.equal(JSON.stringify(result).includes('sk-super-secret-value'), false)
  assert.equal(JSON.stringify(h.broadcasts).includes('sk-super-secret-value'), false)
  assert.equal(h.secret(), 'sk-super-secret-value')
})

test('清除 API Key 后所有公开状态不包含旧 Key', () => {
  const h = createHarness()
  const service = new AiConfigurationService(h.deps)
  service.initialize()
  service.applyPatch({ apiKey: 'sk-clear-me' })
  const result = service.clearApiKey()
  assert.equal(result.aiApiKeyConfigured, false)
  assert.equal(JSON.stringify(result).includes('sk-clear-me'), false)
  assert.equal(JSON.stringify(h.broadcasts).includes('sk-clear-me'), false)
})

test('保存公共配置失败时不应广播或留下半更新凭证', () => {
  const h = createHarness()
  let failOnce = true
  let savedKey: string | null = null
  const deps = {
    getSettings: () => normalizeSettings({ schemaVersion: 9 } as never),
    saveSettings: (patch: Partial<Settings>): Settings => {
      if (failOnce) throw new Error('disk full')
      return normalizeSettings({ schemaVersion: 9, ...patch } as never)
    },
    credentialStore: {
      readApiKey: () => ({ configured: savedKey != null, apiKey: savedKey }),
      saveApiKey: (v: string): void => { savedKey = v },
      clearApiKey: (): void => { savedKey = null }
    },
    onSettingsChanged: (next: Settings): void => { h.broadcasts.push(next) },
    resetTranslationRuntime: (): void => {}
  }
  const service = new AiConfigurationService(deps)
  service.initialize()
  assert.throws(() => service.applyPatch({ enabled: true, apiKey: 'sk-rollback' }), /disk full/u)
  // 凭证应被回滚
  assert.equal(savedKey, null)
  assert.equal(h.broadcasts.length, 0)
  // 第二次正常保存应成功
  failOnce = false
  const ok = service.applyPatch({ enabled: true, apiKey: 'sk-ok' })
  assert.equal(ok.aiApiKeyConfigured, true)
})

test('normalizeSettings 不应持久化明文 aiApiKey 字段', () => {
  const settings = normalizeSettings({
    schemaVersion: 9,
    aiApiKey: 'sk-inject'
  } as never)
  assert.equal('aiApiKey' in settings, false)
})
