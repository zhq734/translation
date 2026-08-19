import assert from 'node:assert/strict'
import test from 'node:test'
import { AiModelDiscoveryService, type AiModelFetch } from '../src/main/aiModelDiscovery.ts'
import type { AiProtocol } from '../src/shared/types.ts'

/**
 * 构造一个 JSON 响应。
 * @param body 响应体。
 * @param status HTTP 状态码。
 * @returns 可供模型发现服务解析的 Response。
 * @author zhenghq
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

/**
 * 构造一个可注入网络请求的模型发现服务。
 * @param fetch 可注入的请求函数。
 * @returns 模型发现服务实例。
 * @author zhenghq
 */
function makeService(fetch: AiModelFetch, apiKey: string | null = null): AiModelDiscoveryService {
  return new AiModelDiscoveryService({ fetch, timeoutMs: 500 })
}

test('Ollama 应请求 /api/tags 并读取 models[].name', async () => {
  const calls: string[] = []
  const service = makeService(async (url) => {
    calls.push(String(url))
    assert.equal(url, 'http://127.0.0.1:11434/api/tags')
    return jsonResponse({ models: [{ name: 'llama3' }, { name: 'qwen2' }] })
  })
  const result = await service.listModels({ protocol: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: null })
  assert.equal(result.state, 'success')
  assert.deepEqual(result.models, ['llama3', 'qwen2'])
})

test('OpenAI 应请求 /models 并读取 data[].id', async () => {
  const service = makeService(async (url) => {
    assert.equal(url, 'https://api.example.com/models')
    return jsonResponse({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] })
  }, 'sk-test')
  const result = await service.listModels({ protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: 'sk-test' })
  assert.deepEqual(result.models, ['gpt-4o', 'gpt-4o-mini'])
})

test('Claude Code 应请求 /v1/models 并读取 data[].id', async () => {
  const service = makeService(async (url) => {
    assert.equal(url, 'https://api.example.com/v1/models')
    return jsonResponse({ data: [{ id: 'claude-3' }] })
  }, 'sk-claude')
  const result = await service.listModels({ protocol: 'claude-code', baseUrl: 'https://api.example.com', apiKey: 'sk-claude' })
  assert.deepEqual(result.models, ['claude-3'])
})

test('模型列表应去空、去重、过滤非字符串并稳定排序', async () => {
  const service = makeService(async () => jsonResponse({
    models: [
      { name: 'llama3' }, { name: '' }, { name: 'llama3' }, { name: 'qwen2' }, { name: 123 as unknown as string }, { name: '   ' }
    ]
  }))
  const result = await service.listModels({ protocol: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: null })
  assert.deepEqual(result.models, ['llama3', 'qwen2'])
})

test('模型列表应使用 Bearer 或 x-api-key 鉴权且不泄露 Key', async () => {
  let openaiHeaders: Record<string, string> = {}
  let claudeHeaders: Record<string, string> = {}
  const ofetch: AiModelFetch = async (_url, init) => { openaiHeaders = init?.headers as Record<string, string>; return jsonResponse({ data: [] }) }
  const cfetch: AiModelFetch = async (_url, init) => { claudeHeaders = init?.headers as Record<string, string>; return jsonResponse({ data: [] }) }
  await new AiModelDiscoveryService({ fetch: ofetch, timeoutMs: 500 }).listModels({ protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: 'sk-open' })
  await new AiModelDiscoveryService({ fetch: cfetch, timeoutMs: 500 }).listModels({ protocol: 'claude-code', baseUrl: 'https://api.example.com', apiKey: 'sk-claude' })
  assert.equal(openaiHeaders['Authorization'], 'Bearer sk-open')
  assert.equal(claudeHeaders['x-api-key'], 'sk-claude')
  assert.equal(claudeHeaders['anthropic-version'], '2023-06-01')
})

test('鉴权失败应返回脱敏 error 状态', async () => {
  const service = makeService(async () => jsonResponse({ error: 'invalid api key sk-leak' }, 401))
  const result = await service.listModels({ protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: 'sk-test' })
  assert.equal(result.state, 'error')
  assert.equal((result.message || '').includes('sk-test'), false)
  assert.equal((result.message || '').includes('sk-leak'), false)
})

test('超时应返回脱敏 error 状态', async () => {
  const service = makeService(async () => { await new Promise((r) => setTimeout(r, 1000)); return jsonResponse({ data: [] }) })
  const result = await service.listModels({ protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: null })
  assert.equal(result.state, 'error')
  assert.match(result.message || '', /超时|网络/u)
})

test('网络失败或非 JSON 应返回脱敏 error 状态', async () => {
  const service = makeService(async () => { throw new TypeError('failed for https://api.example.com') })
  const result = await service.listModels({ protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: null })
  assert.equal(result.state, 'error')
  assert.equal((result.message || '').includes('https://api.example.com'), false)
})

test('Claude Code 不支持模型列表时应返回 unsupported 状态', async () => {
  const service = makeService(async () => new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } }))
  const result = await service.listModels({ protocol: 'claude-code', baseUrl: 'https://api.example.com', apiKey: null })
  assert.equal(result.state, 'unsupported')
})

test('协议或 Base URL 变化应使用不同缓存，相同配置命中缓存', async () => {
  let calls = 0
  const service = new AiModelDiscoveryService({
    fetch: async () => { calls += 1; return jsonResponse({ data: [{ id: 'gpt-4o' }] }) },
    timeoutMs: 500
  })
  await service.listModels({ protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: 'sk-1' })
  await service.listModels({ protocol: 'openai', baseUrl: 'https://api.other.com', apiKey: 'sk-1' })
  await service.listModels({ protocol: 'claude-code', baseUrl: 'https://api.example.com', apiKey: 'sk-1' })
  assert.equal(calls, 3)
  // 相同配置命中缓存
  await service.listModels({ protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: 'sk-1' })
  assert.equal(calls, 3)
  // 有无 API Key 视为不同缓存上下文
  await service.listModels({ protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: null })
  assert.equal(calls, 4)
  // clearCache 后重新请求，使用最新凭证
  service.clearCache()
  await service.listModels({ protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: 'sk-new' })
  assert.equal(calls, 5)
})
