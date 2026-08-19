import assert from 'node:assert/strict'
import test from 'node:test'
import { TranslationRuntime } from '../src/main/translate.ts'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'
import type { Settings } from '../src/shared/types.ts'

/**
 * 构造一个 JSON 响应。
 * @param body 响应体。
 * @param status HTTP 状态码。
 * @returns 可供运行时解析的响应。
 * @author zhenghq
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

/**
 * 构造启用 AI 的设置快照。
 * @param overrides 覆盖字段。
 * @returns 规范化后的设置。
 * @author zhenghq
 */
function aiSettings(overrides: Partial<Settings> = {}): Settings {
  return normalizeSettings({
    schemaVersion: 9,
    aiEnabled: true,
    aiProtocol: 'openai',
    aiBaseUrl: 'https://api.example.com',
    aiModel: 'gpt-4o',
    aiApiKeyConfigured: true,
    sourceLang: 'EN',
    targetLang: 'ZH',
    ...overrides
  } as never)
}

test('配置完整且启用时降级顺序应为 AI -> 钉钉 -> 微软 -> 自建 DeepLX -> 公共 DeepLX -> Google -> MyMemory', async () => {
  const calls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      calls.push(value)
      if (value.includes('chat/completions')) return jsonResponse({ choices: [{ message: { content: 'AI 结果' } }] })
      throw new Error(`不应请求其他通道：${value}`)
    }
  })
  const settings = aiSettings({
    dingTalkEnabled: true, dingTalkCorpId: 'c', dingTalkClientId: 'i', dingTalkSecretConfigured: true,
    microsoftEnabled: true, deepLxUrl: 'https://self.deeplx'
  })
  const result = await runtime.translate('hello', settings, { corpId: 'c', clientId: 'i', clientSecret: 's' }, 'sk-ai')
  assert.equal(result.provider, 'ai')
  assert.equal(result.channel, 'AI 翻译')
  assert.equal(calls.length, 1)
  assert.match(calls[0], /chat\/completions/u)
})

test('AI 未启用时应直接跳过 AI 并尝试后续通道', async () => {
  const calls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      calls.push(value)
      if (value.includes('api.deeplx.org')) return jsonResponse({ code: 200, data: '公共结果', source_lang: 'EN' })
      throw new Error(`不应请求 AI 或其他：${value}`)
    }
  })
  const settings = aiSettings({ aiEnabled: false })
  const result = await runtime.translate('hello', settings, null, null)
  assert.equal(result.provider, 'deeplx-public')
  assert.equal(calls.some((u) => u.includes('chat/completions')), false)
})

test('AI Base URL 或模型缺失时应跳过 AI', async () => {
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      if (String(url).includes('api.deeplx.org')) return jsonResponse({ code: 200, data: '公共结果', source_lang: 'EN' })
      throw new Error('不应请求 AI')
    }
  })
  const noBaseUrl = aiSettings({ aiBaseUrl: '' })
  const noModel = aiSettings({ aiModel: '' })
  assert.equal((await runtime.translate('hello', noBaseUrl, null, 'sk-ai')).provider, 'deeplx-public')
  assert.equal((await runtime.translate('hello', noModel, null, 'sk-ai')).provider, 'deeplx-public')
})

test('AI 请求失败应继续降级到后续通道', async () => {
  const calls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      calls.push(value)
      if (value.includes('chat/completions')) return jsonResponse({ error: 'down' }, 503)
      if (value.includes('api.deeplx.org')) return jsonResponse({ code: 200, data: '公共结果', source_lang: 'EN' })
      throw new Error(`不应请求：${value}`)
    }
  })
  const settings = aiSettings()
  const result = await runtime.translate('hello', settings, null, 'sk-ai')
  assert.equal(result.provider, 'deeplx-public')
  assert.ok(calls.some((u) => u.includes('chat/completions')))
  assert.ok(calls.some((u) => u.includes('api.deeplx.org')))
})

test('AI 独立缓存上下文：协议/Base URL/模型不同不应复用其它 AI 配置结果', async () => {
  let aiCalls = 0
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      if (value.includes('chat/completions')) {
        aiCalls += 1
        return jsonResponse({ choices: [{ message: { content: `AI-${aiCalls}` } }] })
      }
      throw new Error('不应请求其他通道')
    }
  })
  const settingsA = aiSettings({ aiModel: 'gpt-4o' })
  const settingsB = aiSettings({ aiModel: 'gpt-4o-mini' })
  const a = await runtime.translate('same text', settingsA, null, 'sk-ai')
  const b = await runtime.translate('same text', settingsB, null, 'sk-ai')
  assert.equal(a.translation, 'AI-1')
  assert.equal(b.translation, 'AI-2')
  assert.equal(aiCalls, 2)
})

test('AI 熔断后应跳过 AI 并恢复后重新尝试', async () => {
  let now = 0
  let aiFails = true
  const calls: string[] = []
  const runtime = new TranslationRuntime({
    now: () => now,
    fetch: async (url) => {
      const value = String(url)
      calls.push(value)
      if (value.includes('chat/completions')) {
        return aiFails ? jsonResponse({ error: 'down' }, 503) : jsonResponse({ choices: [{ message: { content: 'AI 恢复' } }] })
      }
      if (value.includes('api.deeplx.org')) return jsonResponse({ code: 200, data: '公共结果', source_lang: 'EN' })
      throw new Error(`不应请求：${value}`)
    }
  })
  const settings = aiSettings({ preferredTranslationProvider: 'ai' })
  const first = await runtime.translate('text', settings, null, 'sk-ai')
  assert.equal(first.provider, 'deeplx-public')
  now = 61_000
  aiFails = false
  const recovered = await runtime.translate('text', settings, null, 'sk-ai')
  assert.equal(recovered.provider, 'ai')
  assert.equal(recovered.translation, 'AI 恢复')
})

test('resetAiRuntime 应清除 AI 缓存和熔断状态', async () => {
  let aiCalls = 0
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      if (String(url).includes('chat/completions')) { aiCalls += 1; return jsonResponse({ choices: [{ message: { content: 'AI' } }] }) }
      throw new Error('不应请求其他')
    }
  })
  const settings = aiSettings()
  await runtime.translate('text', settings, null, 'sk-ai')
  // 第二次命中缓存
  await runtime.translate('text', settings, null, 'sk-ai')
  assert.equal(aiCalls, 1)
  ;(runtime as unknown as { resetAiRuntime: () => void }).resetAiRuntime()
  await runtime.translate('text', settings, null, 'sk-ai')
  assert.equal(aiCalls, 2)
})

test('用户指定 AI 为首选 Provider 时应提升到首位但失败后继续降级', async () => {
  const calls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      calls.push(value)
      if (value.includes('chat/completions')) return jsonResponse({ choices: [{ message: { content: 'AI' } }] })
      if (value.includes('api.deeplx.org')) return jsonResponse({ code: 200, data: '公共', source_lang: 'EN' })
      throw new Error('不应请求其他')
    }
  })
  const settings = aiSettings({ preferredTranslationProvider: 'ai' })
  const result = await runtime.translate('hello', settings, null, 'sk-ai')
  assert.equal(result.provider, 'ai')
  assert.match(calls[0], /chat\/completions/u)
})
