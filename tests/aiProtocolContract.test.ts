import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAiTranslationRequest, parseAiTranslationResponse, normalizeAiBaseUrl } from '../src/main/aiProtocol.ts'
import type { AiProtocol } from '../src/shared/types.ts'

/**
 * 构造一个最小可用响应对象，用于协议响应解析测试。
 * @param body 响应体。
 * @param status HTTP 状态码。
 * @returns 可供协议适配器解析的 Response。
 * @author zhenghq
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

test('normalizeAiBaseUrl 应去除末尾斜杠', () => {
  assert.equal(normalizeAiBaseUrl('https://api.example.com/'), 'https://api.example.com')
  assert.equal(normalizeAiBaseUrl('https://api.example.com///'), 'https://api.example.com')
  assert.equal(normalizeAiBaseUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434')
})

test('Ollama 请求应使用 /api/chat、stream=false 并携带 system/user messages', () => {
  const req = buildAiTranslationRequest({
    protocol: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'llama3',
    apiKey: null,
    text: 'hello',
    sourceLang: 'EN',
    targetLang: 'ZH'
  })
  assert.equal(req.method, 'POST')
  assert.equal(req.url, 'http://127.0.0.1:11434/api/chat')
  assert.equal(req.headers.get('Content-Type'), 'application/json')
  const body = JSON.parse(req.body as string)
  assert.equal(body.model, 'llama3')
  assert.equal(body.stream, false)
  assert.ok(body.messages.some((m: { role: string }) => m.role === 'system'))
  assert.ok(body.messages.some((m: { role: string }) => m.role === 'user'))
})

test('OpenAI 请求应使用 /chat/completions、Bearer 鉴权和非流式参数', () => {
  const req = buildAiTranslationRequest({
    protocol: 'openai',
    baseUrl: 'https://api.example.com',
    model: 'gpt-4o',
    apiKey: 'sk-test',
    text: 'hello',
    sourceLang: 'EN',
    targetLang: 'ZH'
  })
  assert.equal(req.method, 'POST')
  assert.equal(req.url, 'https://api.example.com/chat/completions')
  assert.equal(req.headers.get('Authorization'), 'Bearer sk-test')
  assert.equal(req.headers.get('Content-Type'), 'application/json')
  const body = JSON.parse(req.body as string)
  assert.equal(body.model, 'gpt-4o')
  assert.equal(body.stream, false)
  assert.equal(body.temperature, 0)
  assert.ok(body.messages.some((m: { role: string }) => m.role === 'system'))
})

test('Claude Code 请求应使用 /v1/messages、x-api-key 和 anthropic-version 头', () => {
  const req = buildAiTranslationRequest({
    protocol: 'claude-code',
    baseUrl: 'https://api.example.com',
    model: 'claude-3',
    apiKey: 'sk-claude',
    text: 'hello',
    sourceLang: 'EN',
    targetLang: 'ZH'
  })
  assert.equal(req.method, 'POST')
  assert.equal(req.url, 'https://api.example.com/v1/messages')
  assert.equal(req.headers.get('x-api-key'), 'sk-claude')
  assert.equal(req.headers.get('anthropic-version'), '2023-06-01')
  assert.equal(req.headers.get('Content-Type'), 'application/json')
  const body = JSON.parse(req.body as string)
  assert.equal(body.model, 'claude-3')
  assert.equal(body.max_tokens > 0, true)
  assert.ok(body.messages.some((m: { role: string }) => m.role === 'user'))
})

test('Ollama 响应应读取 message.content', () => {
  const text = parseAiTranslationResponse('ollama', { message: { content: '你好' } })
  assert.equal(text, '你好')
})

test('OpenAI 响应应读取 choices[0].message.content', () => {
  const text = parseAiTranslationResponse('openai', { choices: [{ message: { content: '你好' } }] })
  assert.equal(text, '你好')
})

test('Claude Code 响应应拼接所有 type=text 内容块', () => {
  const text = parseAiTranslationResponse('claude-code', { content: [{ type: 'text', text: '你' }, { type: 'text', text: '好' }] })
  assert.equal(text, '你好')
})

test('翻译 Prompt 应包含源语言和目标语言并要求只输出译文', () => {
  const req = buildAiTranslationRequest({
    protocol: 'openai',
    baseUrl: 'https://api.example.com',
    model: 'gpt-4o',
    apiKey: 'sk-test',
    text: 'hello world',
    sourceLang: 'EN',
    targetLang: 'ZH'
  })
  const body = JSON.parse(req.body as string)
  const system = body.messages.find((m: { role: string }) => m.role === 'system')
  assert.match(system.content as string, /EN/u)
  assert.match(system.content as string, /ZH/u)
  assert.match(system.content as string, /译文/u)
})
