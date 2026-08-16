import assert from 'node:assert/strict'
import test from 'node:test'
import type { DingTalkCredentials } from '../src/main/dingtalkConfig.ts'
import { DingTalkError } from '../src/main/dingtalkErrors.ts'
import type { SupportedDingTalkLanguagePair } from '../src/main/dingtalkLanguage.ts'
import { DingTalkTranslationClient } from '../src/main/dingtalkTranslation.ts'
import { TranslationRuntime } from '../src/main/translate.ts'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'

const credentials: DingTalkCredentials = {
  corpId: 'corp-test',
  clientId: 'client-test',
  clientSecret: 'secret-test'
}
const pair: SupportedDingTalkLanguagePair = {
  supported: true,
  sourceLanguage: 'zh',
  targetLanguage: 'en'
}

/**
 * 创建 JSON Response，供钉钉翻译适配器测试使用。
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

test('钉钉文本翻译应发送 TOPAPI 契约并转换统一结果', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const client = new DingTalkTranslationClient({
    tokenManager: {
      getToken: async () => 'token-test',
      reset: () => {}
    },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse({ errcode: 0, result: 'This is a test', request_id: 'request-test' })
    }
  })

  const result = await client.translate('这是一个测试', pair, credentials)

  assert.deepEqual(result, { translation: 'This is a test', detectedLang: 'ZH' })
  assert.equal(
    calls[0]?.url,
    'https://oapi.dingtalk.com/topapi/ai/mt/translate?access_token=token-test'
  )
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    query: '这是一个测试',
    source_language: 'zh',
    target_language: 'en'
  })
})

test('Token 失效时应清理并最多重试一次', async () => {
  let tokenCount = 0
  let resetCount = 0
  let translateCount = 0
  const client = new DingTalkTranslationClient({
    tokenManager: {
      getToken: async () => `token-${++tokenCount}`,
      reset: () => { resetCount += 1 }
    },
    fetch: async () => {
      translateCount += 1
      if (translateCount === 1) return jsonResponse({ errcode: 40014, errmsg: 'invalid token-test' })
      return jsonResponse({ errcode: 0, result: 'ok' })
    }
  })

  assert.equal((await client.translate('测试', pair, credentials)).translation, 'ok')
  assert.equal(tokenCount, 2)
  assert.equal(resetCount, 1)
  assert.equal(translateCount, 2)
})

test('非鉴权错误不应刷新 Token', async () => {
  let resetCount = 0
  let translateCount = 0
  const client = new DingTalkTranslationClient({
    tokenManager: {
      getToken: async () => 'token-test',
      reset: () => { resetCount += 1 }
    },
    fetch: async () => {
      translateCount += 1
      return jsonResponse({ errcode: 60011, errmsg: 'permission denied token-test' })
    }
  })

  await assert.rejects(() => client.translate('测试', pair, credentials), (error: Error) => {
    assert.ok(error instanceof DingTalkError)
    assert.equal((error as DingTalkError).kind, 'permission')
    assert.equal(error.message.includes('token-test'), false)
    return true
  })
  assert.equal(resetCount, 0)
  assert.equal(translateCount, 1)
})

test('配置完整且语言对受支持时应优先使用钉钉且不调用后续通道', async () => {
  const calls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      calls.push(String(url))
      if (String(url).includes('/oauth2/')) {
        return jsonResponse({ access_token: 'token-test', expires_in: 7200 })
      }
      if (String(url).includes('/topapi/ai/mt/translate')) {
        return jsonResponse({ errcode: 0, result: 'DingTalk result' })
      }
      throw new Error('不应调用后续通道')
    }
  })
  const settings = normalizeSettings({
    schemaVersion: 5,
    sourceLang: 'auto',
    targetLang: 'EN',
    dingTalkEnabled: true,
    dingTalkCorpId: 'corp-test',
    dingTalkClientId: 'client-test',
    dingTalkSecretConfigured: true
  })

  const result = await runtime.translate('这是中文', settings, credentials)

  assert.deepEqual(result, {
    translation: 'DingTalk result',
    detectedLang: 'ZH',
    channel: '钉钉翻译'
  })
  assert.equal(calls.length, 2)
})

test('关闭、配置不完整或语言对不支持时不应产生钉钉网络请求', async () => {
  for (const scenario of [
    { enabled: false, credentials },
    { enabled: true, credentials: null },
    { enabled: true, credentials, sourceLang: 'PT', targetLang: 'EN' }
  ]) {
    const calls: string[] = []
    const runtime = new TranslationRuntime({
      fetch: async (url) => {
        calls.push(String(url))
        return jsonResponse({ code: 200, data: 'fallback result', source_lang: 'EN' })
      }
    })
    const settings = normalizeSettings({
      schemaVersion: 5,
      sourceLang: scenario.sourceLang ?? 'auto',
      targetLang: scenario.targetLang ?? 'EN',
      dingTalkEnabled: scenario.enabled,
      dingTalkCorpId: 'corp-test',
      dingTalkClientId: 'client-test',
      dingTalkSecretConfigured: scenario.credentials != null
    })

    const result = await runtime.translate('text', settings, scenario.credentials)
    assert.equal(result.channel, '公共 DeepLX')
    assert.equal(calls.some((url) => url.includes('dingtalk.com')), false)
  }
})

test('钉钉失败后应保持自建 DeepLX、公共 DeepLX、Google、MyMemory 的降级顺序', async () => {
  const calls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      calls.push(value)
      if (value.includes('/oauth2/')) return jsonResponse({ access_token: 'token-test', expires_in: 7200 })
      if (value.includes('/topapi/')) throw new Error('network failed token-test')
      if (value.startsWith('http://127.0.0.1')) return jsonResponse({ code: 500, message: 'self failed' })
      if (value.includes('api.deeplx.org')) return jsonResponse({ code: 500, message: 'public failed' })
      if (value.includes('translate.googleapis.com')) return jsonResponse([])
      if (value.includes('api.mymemory.translated.net')) {
        return jsonResponse({ responseData: { translatedText: 'fallback', detectedLanguage: 'en' } })
      }
      throw new Error('unexpected URL')
    }
  })
  const settings = normalizeSettings({
    schemaVersion: 5,
    sourceLang: 'EN',
    targetLang: 'ZH',
    deepLxUrl: 'http://127.0.0.1:1189/translate',
    dingTalkEnabled: true,
    dingTalkCorpId: 'corp-test',
    dingTalkClientId: 'client-test',
    dingTalkSecretConfigured: true
  })

  const result = await runtime.translate('text', settings, credentials)

  assert.equal(result.channel, 'MyMemory')
  assert.deepEqual(calls.map((url) => {
    if (url.includes('/oauth2/')) return 'token'
    if (url.includes('/topapi/')) return 'dingtalk'
    if (url.startsWith('http://127.0.0.1')) return 'self'
    if (url.includes('api.deeplx.org')) return 'public'
    if (url.includes('translate.googleapis.com')) return 'google'
    return 'mymemory'
  }), ['token', 'dingtalk', 'self', 'public', 'google', 'mymemory'])
})

test('钉钉配置变化重置应清理旧翻译缓存、Token 和熔断状态', async () => {
  let tokenCalls = 0
  let dingTalkCalls = 0
  let shouldFail = true
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      if (value.includes('/oauth2/')) {
        tokenCalls += 1
        return jsonResponse({ access_token: `token-${tokenCalls}`, expires_in: 7200 })
      }
      if (value.includes('/topapi/')) {
        dingTalkCalls += 1
        if (shouldFail) throw new Error('temporary failure')
        return jsonResponse({ errcode: 0, result: 'fresh result' })
      }
      return jsonResponse({ code: 200, data: 'old fallback', source_lang: 'EN' })
    }
  })
  const settings = normalizeSettings({
    schemaVersion: 5,
    sourceLang: 'EN',
    targetLang: 'ZH',
    dingTalkEnabled: true,
    dingTalkCorpId: 'corp-test',
    dingTalkClientId: 'client-test',
    dingTalkSecretConfigured: true
  })

  assert.equal((await runtime.translate('same text', settings, credentials)).translation, 'old fallback')
  shouldFail = false
  runtime.resetDingTalkRuntime()
  const result = await runtime.translate('same text', settings, credentials)

  assert.equal(result.translation, 'fresh result')
  assert.equal(result.channel, '钉钉翻译')
  assert.equal(tokenCalls, 2)
  assert.equal(dingTalkCalls, 2)
})

test('钉钉配置检测应在配置不完整时零请求，成功时不污染普通翻译缓存', async () => {
  let calls = 0
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      calls += 1
      if (String(url).includes('/oauth2/')) {
        return jsonResponse({ access_token: 'token-test', expires_in: 7200 })
      }
      if (String(url).includes('/topapi/')) {
        return jsonResponse({ errcode: 0, result: calls === 2 ? 'check result' : 'normal result' })
      }
      throw new Error('unexpected fallback')
    }
  })

  assert.deepEqual(await runtime.checkDingTalk(null), {
    ok: false,
    code: 'incomplete',
    message: '钉钉配置不完整，请填写 CorpId、ClientId 和 ClientSecret'
  })
  assert.equal(calls, 0)
  assert.equal((await runtime.checkDingTalk(credentials)).ok, true)

  const settings = normalizeSettings({
    schemaVersion: 5,
    sourceLang: 'ZH',
    targetLang: 'EN',
    dingTalkEnabled: true,
    dingTalkCorpId: 'corp-test',
    dingTalkClientId: 'client-test',
    dingTalkSecretConfigured: true
  })
  const result = await runtime.translate('你好', settings, credentials)
  assert.equal(result.translation, 'normal result')
  assert.equal(result.channel, '钉钉翻译')
  assert.equal(calls, 3)
})

test('钉钉配置检测应返回鉴权、权限、限流和网络的脱敏状态', async () => {
  const scenarios = [
    {
      expected: 'authentication',
      fetch: async (url: string | URL) => String(url).includes('/oauth2/')
        ? jsonResponse({ code: 40001, message: 'secret-test' }, 401)
        : jsonResponse({})
    },
    {
      expected: 'permission',
      fetch: async (url: string | URL) => String(url).includes('/oauth2/')
        ? jsonResponse({ access_token: 'token-test', expires_in: 7200 })
        : jsonResponse({ errcode: 60011, errmsg: 'token-test' })
    },
    {
      expected: 'rate-limit',
      fetch: async (url: string | URL) => String(url).includes('/oauth2/')
        ? jsonResponse({ access_token: 'token-test', expires_in: 7200 })
        : jsonResponse({ errcode: 88, errmsg: 'token-test' })
    },
    {
      expected: 'network',
      fetch: async () => { throw new Error('network secret-test token-test access_token=token-test') }
    }
  ]

  for (const scenario of scenarios) {
    const runtime = new TranslationRuntime({ fetch: scenario.fetch })
    const status = await runtime.checkDingTalk(credentials)
    assert.equal(status.code, scenario.expected)
    const serialized = JSON.stringify(status)
    assert.equal(serialized.includes('secret-test'), false)
    assert.equal(serialized.includes('token-test'), false)
    assert.equal(serialized.includes('access_token='), false)
  }
})
