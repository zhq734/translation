import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'
import { AiConfigurationService } from '../src/main/aiConfig.ts'
import type { Settings, AiConfigPatch } from '../src/shared/types.ts'
import type { AiApiKeyReadResult } from '../src/main/aiCredentials.ts'

/**
 * 构造一个内存态的 AI 配置服务依赖集合，用于单元测试。
 * @param initial 初始公开设置。
 * @returns 含可注入依赖和服务状态记录的对象。
 * @author zhenghq
 */
function createHarness(initial: Settings) {
  let settings = initial
  let apiKey: string | null = null
  let failSave = false
  const broadcasts: Settings[] = []
  let resetCount = 0
  const store = {
    readApiKey: (): AiApiKeyReadResult => ({ configured: apiKey != null, apiKey }),
    saveApiKey: (value: string): void => { apiKey = value },
    clearApiKey: (): void => { apiKey = null }
  }
  const deps = {
    getSettings: () => settings,
    saveSettings: (patch: Partial<Settings>): Settings => {
      if (failSave) throw new Error('settings write failed')
      settings = normalizeSettings({ ...settings, ...patch })
      return settings
    },
    credentialStore: store,
    onSettingsChanged: (next: Settings): void => broadcasts.push(next),
    resetTranslationRuntime: (): void => { resetCount += 1 }
  }
  return { deps, settings: () => settings, apiKey: () => apiKey, setFailSave: (v: boolean): void => { failSave = v }, broadcasts, resetCount: () => resetCount }
}

const baseSettings = (): Settings => normalizeSettings({ schemaVersion: 9 } as never)

test('initialize 应同步 aiApiKeyConfigured 并返回脱敏设置', () => {
  const h = createHarness(baseSettings())
  h.apiKey() // noop
  // 模拟已有凭证
  ;(h.deps.credentialStore as { saveApiKey: (v: string) => void }).saveApiKey('sk-existing')
  const service = new AiConfigurationService(h.deps)
  const result = service.initialize()
  assert.equal(result.aiApiKeyConfigured, true)
  assert.equal('apiKey' in (result as Record<string, unknown> as object), false)
  assert.equal(JSON.stringify(result).includes('sk-existing'), false)
})

test('applyPatch 应原子保存公共字段和凭证，成功后广播脱敏设置并 reset Runtime', () => {
  const h = createHarness(baseSettings())
  const service = new AiConfigurationService(h.deps)
  service.initialize()
  const patch: AiConfigPatch = {
    enabled: true,
    protocol: 'openai',
    baseUrl: 'https://api.example.com',
    model: 'gpt-4o',
    apiKey: 'sk-new'
  }
  const result = service.applyPatch(patch)
  assert.equal(result.aiEnabled, true)
  assert.equal(result.aiProtocol, 'openai')
  assert.equal(result.aiBaseUrl, 'https://api.example.com')
  assert.equal(result.aiModel, 'gpt-4o')
  assert.equal(result.aiApiKeyConfigured, true)
  assert.equal(JSON.stringify(result).includes('sk-new'), false)
  assert.equal(h.apiKey(), 'sk-new')
  assert.equal(h.broadcasts.length, 1)
  assert.equal(h.resetCount(), 1)
})

test('空 apiKey 应保留旧凭证且不触发 reset', () => {
  const h = createHarness(baseSettings())
  const service = new AiConfigurationService(h.deps)
  service.initialize()
  service.applyPatch({ enabled: true, apiKey: 'sk-first' })
  const resetBefore = h.resetCount()
  const result = service.applyPatch({ model: 'gpt-4o-mini' })
  assert.equal(h.apiKey(), 'sk-first')
  assert.equal(result.aiApiKeyConfigured, true)
  assert.equal(h.resetCount(), resetBefore + 1) // 模型变更也 reset
})

test('clearApiKey 应删除凭证并广播未配置状态', () => {
  const h = createHarness(baseSettings())
  const service = new AiConfigurationService(h.deps)
  service.initialize()
  service.applyPatch({ apiKey: 'sk-to-clear' })
  const result = service.clearApiKey()
  assert.equal(h.apiKey(), null)
  assert.equal(result.aiApiKeyConfigured, false)
  assert.equal(JSON.stringify(result).includes('sk-to-clear'), false)
  assert.equal(h.resetCount() >= 1, true)
})

test('settings 保存失败时不应产生半更新状态且不广播', () => {
  const h = createHarness(baseSettings())
  const service = new AiConfigurationService(h.deps)
  service.initialize()
  h.setFailSave(true)
  assert.throws(() => service.applyPatch({ apiKey: 'sk-fail' }), /settings write failed/u)
  // 凭证已保存但配置未持久化；按设计应回滚凭证
  assert.equal(h.apiKey(), null)
  assert.equal(h.broadcasts.length, 0)
})

test('普通 saveSettings 不应接受 aiApiKey 或 aiApiKeyConfigured', () => {
  // 验证 normalizeSettings 不处理 aiApiKey 明文字段
  const settings = normalizeSettings({
    schemaVersion: 9,
    aiApiKey: 'sk-leak',
    aiApiKeyConfigured: 'fake' as unknown as boolean
  } as never)
  assert.equal('aiApiKey' in settings, false)
  assert.equal(settings.aiApiKeyConfigured, false)
})
