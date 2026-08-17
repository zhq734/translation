import assert from 'node:assert/strict'
import test from 'node:test'
import type { MicrosoftCredentials } from '../src/main/microsoftConfig.ts'
import { MicrosoftError } from '../src/main/microsoftErrors.ts'
import { resolveMicrosoftLanguagePair } from '../src/main/microsoftLanguage.ts'
import { MicrosoftTranslationClient } from '../src/main/microsoftTranslation.ts'
import { TranslationRuntime } from '../src/main/translate.ts'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'

const credentials: MicrosoftCredentials = {
  subscriptionKey: 'microsoft-key-test',
  region: 'eastasia'
}

/**
 * 创建 JSON Response，供微软翻译网络契约测试使用。
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

test('微软语言适配应支持自动检测、中文代码和显式语言对', () => {
  assert.deepEqual(resolveMicrosoftLanguagePair('auto', 'EN'), {
    supported: true,
    targetLanguage: 'en'
  })
  assert.deepEqual(resolveMicrosoftLanguagePair('ZH', 'EN'), {
    supported: true,
    sourceLanguage: 'zh-Hans',
    targetLanguage: 'en'
  })
  assert.deepEqual(resolveMicrosoftLanguagePair('FR', 'DE'), {
    supported: true,
    sourceLanguage: 'fr',
    targetLanguage: 'de'
  })
  assert.deepEqual(resolveMicrosoftLanguagePair('EN', 'auto'), { supported: false })
})

test('微软文本翻译应发送 Translator v3 契约并转换统一结果', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const client = new MicrosoftTranslationClient({
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse([{
        detectedLanguage: { language: 'zh-Hans', score: 1 },
        translations: [{ text: 'Hello', to: 'en' }]
      }])
    }
  })

  const result = await client.translate('你好', {
    supported: true,
    targetLanguage: 'en'
  }, credentials)

  assert.deepEqual(result, { translation: 'Hello', detectedLang: 'ZH' })
  assert.equal(
    calls[0]?.url,
    'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=en'
  )
  assert.equal(calls[0]?.init?.method, 'POST')
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), [{ Text: '你好' }])
  const headers = calls[0]?.init?.headers as Record<string, string>
  assert.equal(headers['Content-Type'], 'application/json; charset=UTF-8')
  assert.equal(headers['Ocp-Apim-Subscription-Key'], 'microsoft-key-test')
  assert.equal(headers['Ocp-Apim-Subscription-Region'], 'eastasia')
})

test('微软全局资源未配置区域时不应发送空 Region 请求头', async () => {
  let headers: Record<string, string> | undefined
  const client = new MicrosoftTranslationClient({
    fetch: async (_url, init) => {
      headers = init?.headers as Record<string, string>
      return jsonResponse([{ translations: [{ text: '你好', to: 'zh-Hans' }] }])
    }
  })

  await client.translate('hello', {
    supported: true,
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hans'
  }, { subscriptionKey: 'microsoft-key-test', region: '' })

  assert.equal(headers?.['Ocp-Apim-Subscription-Region'], undefined)
})

test('微软错误应按鉴权、权限、限流和网络分类且不得泄露订阅密钥', async () => {
  const scenarios = [
    { status: 401, expected: 'authentication' },
    { status: 403, expected: 'permission' },
    { status: 429, expected: 'rate-limit' },
    { status: 400, expected: 'parameter' }
  ] as const

  for (const scenario of scenarios) {
    const client = new MicrosoftTranslationClient({
      fetch: async () => jsonResponse({
        error: { code: scenario.status, message: 'microsoft-key-test' }
      }, scenario.status)
    })
    await assert.rejects(
      () => client.translate('text', {
        supported: true,
        sourceLanguage: 'en',
        targetLanguage: 'zh-Hans'
      }, credentials),
      (error: Error) => {
        assert.ok(error instanceof MicrosoftError)
        assert.equal((error as MicrosoftError).kind, scenario.expected)
        assert.equal(error.message.includes('microsoft-key-test'), false)
        return true
      }
    )
  }

  const networkClient = new MicrosoftTranslationClient({
    fetch: async () => { throw new Error('network microsoft-key-test') }
  })
  await assert.rejects(
    () => networkClient.translate('text', {
      supported: true,
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hans'
    }, credentials),
    (error: Error) => {
      assert.ok(error instanceof MicrosoftError)
      assert.equal((error as MicrosoftError).kind, 'network')
      assert.equal(error.message.includes('microsoft-key-test'), false)
      return true
    }
  )
})

test('配置完整时应在钉钉之后优先使用微软翻译且不调用免费通道', async () => {
  const calls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      calls.push(String(url))
      if (String(url).includes('cognitive.microsofttranslator.com')) {
        return jsonResponse([{
          detectedLanguage: { language: 'en', score: 1 },
          translations: [{ text: '微软结果', to: 'zh-Hans' }]
        }])
      }
      throw new Error('不应调用免费通道')
    }
  })
  const settings = normalizeSettings({
    schemaVersion: 6,
    sourceLang: 'auto',
    targetLang: 'ZH',
    microsoftEnabled: true,
    microsoftRegion: 'eastasia',
    microsoftSubscriptionKeyConfigured: true
  })

  const result = await runtime.translate('hello', settings, null, credentials)

  assert.deepEqual(result, {
    translation: '微软结果',
    detectedLang: 'EN',
    channel: '微软翻译'
  })
  assert.equal(calls.length, 1)
})

test('微软翻译失败后应自动降级到公共 DeepLX', async () => {
  const calls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      calls.push(value)
      if (value.includes('cognitive.microsofttranslator.com')) {
        return jsonResponse({ error: { code: 401, message: 'invalid key' } }, 401)
      }
      if (value.includes('api.deeplx.org')) {
        return jsonResponse({ code: 200, data: '降级结果', source_lang: 'EN' })
      }
      throw new Error('不应调用更后的免费通道')
    }
  })
  const settings = normalizeSettings({
    schemaVersion: 6,
    sourceLang: 'EN',
    targetLang: 'ZH',
    microsoftEnabled: true,
    microsoftSubscriptionKeyConfigured: true
  })

  const result = await runtime.translate('hello', settings, null, credentials)

  assert.equal(result.translation, '降级结果')
  assert.equal(result.channel, '公共 DeepLX')
  assert.equal(calls.length, 2)
  assert.match(calls[0] || '', /cognitive\.microsofttranslator\.com/u)
  assert.match(calls[1] || '', /api\.deeplx\.org/u)
})

test('微软配置变化后应清理旧降级缓存和微软熔断状态', async () => {
  let microsoftShouldFail = true
  let microsoftCalls = 0
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      if (value.includes('cognitive.microsofttranslator.com')) {
        microsoftCalls += 1
        if (microsoftShouldFail) return jsonResponse({}, 503)
        return jsonResponse([{
          detectedLanguage: { language: 'en', score: 1 },
          translations: [{ text: '微软新结果', to: 'zh-Hans' }]
        }])
      }
      if (value.includes('api.deeplx.org')) {
        return jsonResponse({ code: 200, data: '旧降级结果', source_lang: 'EN' })
      }
      throw new Error('不应调用更后的免费通道')
    }
  })
  const settings = normalizeSettings({
    schemaVersion: 6,
    sourceLang: 'EN',
    targetLang: 'ZH',
    microsoftEnabled: true,
    microsoftSubscriptionKeyConfigured: true
  })

  assert.equal(
    (await runtime.translate('same text', settings, null, credentials)).translation,
    '旧降级结果'
  )
  microsoftShouldFail = false
  runtime.resetMicrosoftRuntime()
  const result = await runtime.translate('same text', settings, null, credentials)

  assert.equal(result.translation, '微软新结果')
  assert.equal(result.channel, '微软翻译')
  assert.equal(microsoftCalls, 2)
})

test('微软配置检测应零缓存执行并返回脱敏结构化状态', async () => {
  let calls = 0
  const runtime = new TranslationRuntime({
    fetch: async () => {
      calls += 1
      return jsonResponse([{
        detectedLanguage: { language: 'zh-Hans', score: 1 },
        translations: [{ text: calls === 1 ? 'check' : 'normal', to: 'en' }]
      }])
    }
  })

  assert.deepEqual(await runtime.checkMicrosoft(null), {
    ok: false,
    code: 'incomplete',
    message: '微软翻译配置不完整，请填写订阅密钥'
  })
  assert.equal(calls, 0)
  assert.deepEqual(await runtime.checkMicrosoft(credentials), {
    ok: true,
    code: 'available',
    message: '微软翻译在线且可用'
  })

  const settings = normalizeSettings({
    schemaVersion: 6,
    sourceLang: 'ZH',
    targetLang: 'EN',
    microsoftEnabled: true,
    microsoftRegion: 'eastasia',
    microsoftSubscriptionKeyConfigured: true
  })
  const result = await runtime.translate('你好', settings, null, credentials)
  assert.equal(result.translation, 'normal')
  assert.equal(calls, 2)
})
