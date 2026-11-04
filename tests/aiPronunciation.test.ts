import assert from 'node:assert/strict'
import test from 'node:test'
import { AiPronunciationLookup } from '../src/main/aiPronunciation.ts'
import { DEFAULT_SETTINGS } from '../src/shared/settingsDefaults.ts'
import type { Settings } from '../src/shared/types.ts'

/**
 * 创建一份启用 OpenAI 协议的测试设置。
 * @param patch 需要覆盖的设置字段。
 * @returns 完整的公开设置快照。
 * @author zhenghq
 */
function createSettings(patch: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    aiEnabled: true,
    aiProtocol: 'openai',
    aiBaseUrl: 'https://api.example.com/v1',
    aiModel: 'gpt-4o-mini',
    ...patch
  }
}

/**
 * 构造 OpenAI 兼容的聊天响应。
 * @param content 模型返回文本。
 * @returns 可供客户端解析的 Response。
 * @author zhenghq
 */
function chatResponse(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }]
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

test('AI 音标查询应发送严格 JSON 约束并解析代码块包裹的响应', async () => {
  let requestUrl = ''
  let requestBody: Record<string, unknown> = {}
  const lookup = new AiPronunciationLookup({
    fetch: async (input, init) => {
      requestUrl = String(input)
      requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return chatResponse('```json\n{"ipa":"/ˈklaʊd nətɪv/","accent":"US","definitions":["adj. 云原生的"]}\n```')
    },
    getSettings: () => createSettings(),
    getApiKey: () => 'sk-test'
  })

  const result = await lookup.lookup('cloud-native')

  assert.equal(requestUrl, 'https://api.example.com/v1/chat/completions')
  const messages = requestBody.messages as Array<{ role: string; content: string }>
  assert.match(messages[0]?.content ?? '', /只输出 JSON/u)
  assert.match(messages[0]?.content ?? '', /IPA/u)
  assert.deepEqual(result, {
    status: 'available',
    word: 'cloud-native',
    language: 'en',
    variants: [{ id: 'ai-us-0', accent: 'US', ipa: '/ˈklaʊd nətɪv/', hasAudio: false }],
    source: 'ai',
    definitions: [{ text: 'adj. 云原生的', language: 'zh', source: 'ai' }]
  })
})

test('AI 未启用或配置不完整时不得发起网络请求', async () => {
  let requests = 0
  const fetch = async (): Promise<Response> => {
    requests += 1
    return chatResponse('{}')
  }

  const disabled = new AiPronunciationLookup({
    fetch,
    getSettings: () => createSettings({ aiEnabled: false }),
    getApiKey: () => null
  })
  const incomplete = new AiPronunciationLookup({
    fetch,
    getSettings: () => createSettings({ aiModel: '' }),
    getApiKey: () => null
  })

  assert.equal(await disabled.lookup('cloud-native'), null)
  assert.equal(await incomplete.lookup('cloud-native'), null)
  assert.equal(requests, 0)
})

test('AI 返回无效 JSON 或缺少有效音标时应安全拒绝', async () => {
  const invalidJson = new AiPronunciationLookup({
    fetch: async () => chatResponse('不是 JSON'),
    getSettings: () => createSettings(),
    getApiKey: () => null
  })
  const missingIpa = new AiPronunciationLookup({
    fetch: async () => chatResponse('{"definitions":["adj. 云的"]}'),
    getSettings: () => createSettings(),
    getApiKey: () => null
  })

  assert.equal(await invalidJson.lookup('cloud'), null)
  assert.equal(await missingIpa.lookup('cloud'), null)
})

test('AI 音标查询应支持取消且不泄露底层错误', async () => {
  const lookup = new AiPronunciationLookup({
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    }),
    getSettings: () => createSettings(),
    getApiKey: () => 'sk-secret'
  })
  const controller = new AbortController()
  const result = lookup.lookup('cloud-native', controller.signal)
  controller.abort()

  assert.equal(await result, null)
})
