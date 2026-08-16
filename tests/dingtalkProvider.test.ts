import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDingTalkLanguagePair } from '../src/main/dingtalkLanguage.ts'
import { DingTalkTokenManager } from '../src/main/dingtalkTokenManager.ts'
import {
  DingTalkError,
  toDingTalkCheckStatus
} from '../src/main/dingtalkErrors.ts'
import type { DingTalkCredentials } from '../src/main/dingtalkConfig.ts'

const credentials: DingTalkCredentials = {
  corpId: 'corp-test',
  clientId: 'client-test',
  clientSecret: 'secret-test'
}

/**
 * 创建 JSON Response，供钉钉网络契约测试使用。
 * @param body JSON 响应体。
 * @param status HTTP 状态码。
 * @returns 可供 fetch 调用方解析的 Response。
 * @author zhenghq
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

test('钉钉语言适配应覆盖自动中英互译和显式受支持语言对', () => {
  assert.deepEqual(resolveDingTalkLanguagePair('这是中文', 'auto', 'EN'), {
    supported: true,
    sourceLanguage: 'zh',
    targetLanguage: 'en'
  })
  assert.deepEqual(resolveDingTalkLanguagePair('English text', 'auto', 'ZH'), {
    supported: true,
    sourceLanguage: 'en',
    targetLanguage: 'zh'
  })
  assert.deepEqual(resolveDingTalkLanguagePair('Bonjour', 'FR', 'DE'), {
    supported: true,
    sourceLanguage: 'fr',
    targetLanguage: 'de'
  })
})

test('钉钉语言适配遇到不支持语言对时应返回可跳过结果', () => {
  assert.deepEqual(resolveDingTalkLanguagePair('Olá', 'PT', 'EN'), { supported: false })
  assert.deepEqual(resolveDingTalkLanguagePair('text', 'auto', 'FR'), { supported: false })
})

test('Token 请求应使用 OAuth2 路径、JSON 契约和注入的代理 fetch', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const manager = new DingTalkTokenManager({
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse({ access_token: 'token-test', expires_in: 7200 })
    }
  })

  const token = await manager.getToken(credentials)

  assert.equal(token, 'token-test')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, 'https://api.dingtalk.com/v1.0/oauth2/corp-test/token')
  assert.equal(calls[0]?.init?.method, 'POST')
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    client_id: 'client-test',
    client_secret: 'secret-test',
    grant_type: 'client_credentials'
  })
})

test('Token 应在安全有效期内复用并在剩余不足 60 秒时刷新', async () => {
  let now = 1_000_000
  let calls = 0
  const manager = new DingTalkTokenManager({
    now: () => now,
    fetch: async () => {
      calls += 1
      return jsonResponse({ access_token: `token-${calls}`, expires_in: 120 })
    }
  })

  assert.equal(await manager.getToken(credentials), 'token-1')
  now += 50_000
  assert.equal(await manager.getToken(credentials), 'token-1')
  now += 11_000
  assert.equal(await manager.getToken(credentials), 'token-2')
  assert.equal(calls, 2)
})

test('并发 Token 请求应合并，重置后应获取新 Token', async () => {
  let calls = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const manager = new DingTalkTokenManager({
    fetch: async () => {
      calls += 1
      await gate
      return jsonResponse({ access_token: `token-${calls}`, expires_in: 7200 })
    }
  })

  const first = manager.getToken(credentials)
  const second = manager.getToken(credentials)
  release?.()
  assert.deepEqual(await Promise.all([first, second]), ['token-1', 'token-1'])
  assert.equal(calls, 1)

  manager.reset()
  assert.equal(await manager.getToken(credentials), 'token-2')
  assert.equal(calls, 2)
})

test('Token 获取失败不应缓存，后续调用可以重新请求', async () => {
  let calls = 0
  const manager = new DingTalkTokenManager({
    fetch: async () => {
      calls += 1
      if (calls === 1) return jsonResponse({ code: 'invalid_client', message: 'secret-test' }, 401)
      return jsonResponse({ access_token: 'token-test', expires_in: 7200 })
    }
  })

  await assert.rejects(() => manager.getToken(credentials), (error: Error) => {
    assert.equal(error.message.includes('secret-test'), false)
    assert.equal(error.message.includes('token-test'), false)
    return true
  })
  assert.equal(await manager.getToken(credentials), 'token-test')
  assert.equal(calls, 2)
})

test('钉钉错误应分类并生成不含 Secret、Token 或完整鉴权 URL 的公开状态', () => {
  const raw = new Error(
    'secret-test token-test https://oapi.dingtalk.com/topapi/ai/mt/translate?access_token=token-test'
  )
  const error = new DingTalkError('authentication', '钉钉鉴权失败', {
    cause: raw,
    authenticationInvalid: true
  })
  const status = toDingTalkCheckStatus(error)

  assert.deepEqual(status, {
    ok: false,
    code: 'authentication',
    message: '钉钉鉴权失败，请检查 CorpId、ClientId 和 ClientSecret'
  })
  const serialized = JSON.stringify(status)
  assert.equal(serialized.includes('secret-test'), false)
  assert.equal(serialized.includes('token-test'), false)
  assert.equal(serialized.includes('access_token='), false)
})
