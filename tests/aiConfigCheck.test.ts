import assert from 'node:assert/strict'
import test from 'node:test'
import { AiCheckService, type AiCheckFetch } from '../src/main/aiCheck.ts'
import type { Settings } from '../src/shared/types.ts'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'

/**
 * 构造一个 JSON 响应。
 * @param body 响应体。
 * @param status HTTP 状态码。
 * @returns 可供检测服务解析的 Response。
 * @author zhenghq
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

/**
 * 构造一个完整 AI 设置快照。
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
    ...overrides
  } as never)
}

/**
 * 构造可注入网络请求的检测服务。
 * @param fetch 可注入的请求函数。
 * @returns AI 配置检测服务实例。
 * @author zhenghq
 */
function makeService(fetch: AiCheckFetch): AiCheckService {
  return new AiCheckService({ fetch, timeoutMs: 300 })
}

test('配置不完整时应返回 incomplete 且不发网络请求', async () => {
  let called = false
  const service = makeService(async () => { called = true; return jsonResponse({ choices: [{ message: { content: 'x' } }] }) })
  const result = await service.check({
    settings: aiSettings({ aiBaseUrl: '', aiModel: '' }),
    apiKey: 'sk-x'
  })
  assert.equal(result.code, 'incomplete')
  assert.equal(called, false)
})

test('检测成功应返回 available 且不含凭证', async () => {
  const service = makeService(async () => jsonResponse({ choices: [{ message: { content: '你好' } }] }))
  const result = await service.check({ settings: aiSettings(), apiKey: 'sk-secret' })
  assert.equal(result.ok, true)
  assert.equal(result.code, 'available')
  assert.equal(result.message.includes('sk-secret'), false)
})

test('鉴权失败应返回 authentication 分类且不含 API Key', async () => {
  const service = makeService(async () => jsonResponse({ error: 'bad key sk-leak' }, 401))
  const result = await service.check({ settings: aiSettings(), apiKey: 'sk-secret' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'authentication')
  assert.equal(result.message.includes('sk-secret'), false)
  assert.equal(result.message.includes('sk-leak'), false)
})

test('模型不存在应返回 not-found 分类', async () => {
  const service = makeService(async () => jsonResponse({ error: 'model not found' }, 404))
  const result = await service.check({ settings: aiSettings(), apiKey: 'sk-x' })
  assert.equal(result.code, 'not-found')
})

test('超时应返回 timeout 分类', async () => {
  const service = makeService(async () => { await new Promise((r) => setTimeout(r, 1000)); return jsonResponse({ choices: [{ message: { content: 'x' } }] }) })
  const result = await service.check({ settings: aiSettings(), apiKey: 'sk-x' })
  assert.equal(result.code, 'timeout')
})

test('网络错误应返回 network 分类且不含 URL', async () => {
  const service = makeService(async () => { throw new TypeError('failed for https://api.example.com') })
  const result = await service.check({ settings: aiSettings(), apiKey: 'sk-x' })
  assert.equal(result.code, 'network')
  assert.equal(result.message.includes('https://api.example.com'), false)
})

test('限流应返回 rate-limit 分类', async () => {
  const service = makeService(async () => jsonResponse({}, 429))
  const result = await service.check({ settings: aiSettings(), apiKey: 'sk-x' })
  assert.equal(result.code, 'rate-limit')
})

test('空译文应返回 service 分类', async () => {
  const service = makeService(async () => jsonResponse({ choices: [{ message: { content: '   ' } }] }))
  const result = await service.check({ settings: aiSettings(), apiKey: 'sk-x' })
  assert.equal(result.code, 'service')
})
