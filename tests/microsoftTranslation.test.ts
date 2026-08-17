import assert from 'node:assert/strict'
import test from 'node:test'
import { MicrosoftError } from '../src/main/microsoftErrors.ts'
import { resolveMicrosoftLanguagePair } from '../src/main/microsoftLanguage.ts'
import { MicrosoftTranslationClient } from '../src/main/microsoftTranslation.ts'
import { TranslationRuntime } from '../src/main/translate.ts'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'

const BING_AUTH_HTML = `
<html>
<script>params_AbusePreventionHelper = [123456,"bing-token-test",120000];</script>
<script>var page = { IG: "ABCDEF0123456789" };</script>
<div id="tta_outGDCont" data-iid="translator.5028.1"></div>
</html>
`

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

/**
 * 创建 Bing 翻译页面文本响应。
 * @param html 页面 HTML。
 * @param status HTTP 状态码。
 * @param url 跟随重定向后的实际页面地址。
 * @returns 可供 fetch 调用方读取的 Response。
 * @author zhenghq
 */
function htmlResponse(html = BING_AUTH_HTML, status = 200, url = ''): Response {
  const response = new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=UTF-8' }
  })
  if (url) Object.defineProperty(response, 'url', { value: url })
  return response
}

/**
 * 创建标准 Bing 翻译成功响应。
 * @param text 译文。
 * @param detectedLanguage 检测到的源语言。
 * @returns Bing 翻译接口响应。
 * @author zhenghq
 */
function bingTranslationResponse(text: string, detectedLanguage = 'en'): Response {
  return jsonResponse([{
    detectedLanguage: { language: detectedLanguage, score: 1 },
    translations: [{ text, to: 'zh-Hans' }]
  }])
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

test('免订阅微软翻译应从 Bing 页面解析鉴权并发送表单请求', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const client = new MicrosoftTranslationClient({
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url) === 'https://www.bing.com/translator') return htmlResponse()
      return bingTranslationResponse('你好')
    }
  })

  const result = await client.translate('hello', {
    supported: true,
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hans'
  })

  assert.deepEqual(result, { translation: '你好', detectedLang: 'EN' })
  assert.equal(calls[0]?.url, 'https://www.bing.com/translator')
  assert.equal(calls[0]?.init?.method, 'GET')
  assert.equal(
    calls[1]?.url,
    'https://www.bing.com/ttranslatev3?isVertical=1&IG=ABCDEF0123456789&IID=translator.5028.1'
  )
  assert.equal(calls[1]?.init?.method, 'POST')
  const headers = calls[1]?.init?.headers as Record<string, string>
  assert.match(headers['Content-Type'] || '', /application\/x-www-form-urlencoded/u)
  assert.equal(headers['Ocp-Apim-Subscription-Key'], undefined)
  assert.equal(headers['Ocp-Apim-Subscription-Region'], undefined)
  const form = new URLSearchParams(String(calls[1]?.init?.body))
  assert.deepEqual(Object.fromEntries(form), {
    text: 'hello',
    fromLang: 'en',
    to: 'zh-Hans',
    token: 'bing-token-test',
    key: '123456'
  })
})

test('Bing 页面重定向到区域域名后应使用实际域名发送翻译请求', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const client = new MicrosoftTranslationClient({
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url) === 'https://www.bing.com/translator') {
        return htmlResponse(BING_AUTH_HTML, 200, 'https://cn.bing.com/translator')
      }
      return bingTranslationResponse('你好')
    }
  })

  await client.translate('hello', {
    supported: true,
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hans'
  })

  assert.equal(
    calls[1]?.url,
    'https://cn.bing.com/ttranslatev3?isVertical=1&IG=ABCDEF0123456789&IID=translator.5028.1'
  )
  const headers = calls[1]?.init?.headers as Record<string, string>
  assert.equal(headers.Origin, 'https://cn.bing.com')
  assert.equal(headers.Referer, 'https://cn.bing.com/translator')
})

test('Bing 页面重定向到非微软域名时应拒绝发送临时鉴权参数', async () => {
  let translationCalls = 0
  const client = new MicrosoftTranslationClient({
    fetch: async (url) => {
      if (String(url) === 'https://www.bing.com/translator') {
        return htmlResponse(BING_AUTH_HTML, 200, 'https://example.com/translator')
      }
      translationCalls += 1
      return bingTranslationResponse('不应返回')
    }
  })

  await assert.rejects(
    () => client.translate('hello', {
      supported: true,
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hans'
    }),
    (error: Error) => {
      assert.ok(error instanceof MicrosoftError)
      assert.equal((error as MicrosoftError).kind, 'service')
      assert.equal(error.message, '微软翻译网页重定向地址无效')
      return true
    }
  )
  assert.equal(translationCalls, 0)
})

test('微软自动检测源语言时应向 Bing 发送 auto-detect', async () => {
  let form: URLSearchParams | undefined
  const client = new MicrosoftTranslationClient({
    fetch: async (url, init) => {
      if (String(url).endsWith('/translator')) return htmlResponse()
      form = new URLSearchParams(String(init?.body))
      return bingTranslationResponse('Hello', 'zh-Hans')
    }
  })

  const result = await client.translate('你好', {
    supported: true,
    targetLanguage: 'en'
  })

  assert.equal(form?.get('fromLang'), 'auto-detect')
  assert.equal(result.detectedLang, 'ZH')
})

test('Bing 页面鉴权应按 TTL 减去安全窗口缓存', async () => {
  let now = 10_000
  let authCalls = 0
  const client = new MicrosoftTranslationClient({
    now: () => now,
    fetch: async (url) => {
      if (String(url).endsWith('/translator')) {
        authCalls += 1
        return htmlResponse()
      }
      return bingTranslationResponse('结果')
    }
  })
  const pair = { supported: true, sourceLanguage: 'en', targetLanguage: 'zh-Hans' } as const

  await client.translate('one', pair)
  now += 59_999
  await client.translate('two', pair)
  assert.equal(authCalls, 1)

  now += 2
  await client.translate('three', pair)
  assert.equal(authCalls, 2)
})

test('并发翻译获取 Bing 鉴权时应只请求一次网页', async () => {
  let authCalls = 0
  const client = new MicrosoftTranslationClient({
    fetch: async (url) => {
      if (String(url).endsWith('/translator')) {
        authCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 10))
        return htmlResponse()
      }
      return bingTranslationResponse('结果')
    }
  })
  const pair = { supported: true, sourceLanguage: 'en', targetLanguage: 'zh-Hans' } as const

  await Promise.all([
    client.translate('one', pair),
    client.translate('two', pair),
    client.translate('three', pair)
  ])

  assert.equal(authCalls, 1)
})

test('Bing 鉴权页面请求或解析失败后应允许后续重试', async () => {
  let authCalls = 0
  const client = new MicrosoftTranslationClient({
    fetch: async (url) => {
      if (String(url).endsWith('/translator')) {
        authCalls += 1
        if (authCalls === 1) return htmlResponse('', 503)
        if (authCalls === 2) return htmlResponse('<html>missing auth</html>')
        return htmlResponse()
      }
      return bingTranslationResponse('成功')
    }
  })
  const pair = { supported: true, sourceLanguage: 'en', targetLanguage: 'zh-Hans' } as const

  await assert.rejects(() => client.translate('one', pair), MicrosoftError)
  await assert.rejects(() => client.translate('two', pair), MicrosoftError)
  assert.equal((await client.translate('three', pair)).translation, '成功')
  assert.equal(authCalls, 3)
})

test('超过 1000 字符的文本应分块并发翻译后按原顺序合并', async () => {
  const postedChunks: string[] = []
  const client = new MicrosoftTranslationClient({
    fetch: async (url, init) => {
      if (String(url).endsWith('/translator')) return htmlResponse()
      const text = new URLSearchParams(String(init?.body)).get('text') || ''
      postedChunks.push(text)
      const marker = text[0]?.toUpperCase() || ''
      const delay = marker === 'A' ? 20 : marker === 'B' ? 10 : 0
      await new Promise((resolve) => setTimeout(resolve, delay))
      return bingTranslationResponse(marker)
    }
  })
  const text = `${'a'.repeat(1000)}${'b'.repeat(1000)}c`

  const result = await client.translate(text, {
    supported: true,
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hans'
  })

  assert.equal(result.translation, 'ABC')
  assert.deepEqual(postedChunks.map((chunk) => chunk.length).sort((a, b) => a - b), [1, 1000, 1000])
})

test('Bing 鉴权状态失效时应刷新页面参数并重试一次', async () => {
  let authCalls = 0
  let translationCalls = 0
  const client = new MicrosoftTranslationClient({
    fetch: async (url) => {
      if (String(url).endsWith('/translator')) {
        authCalls += 1
        return htmlResponse(BING_AUTH_HTML.replace('bing-token-test', `bing-token-${authCalls}`))
      }
      translationCalls += 1
      if (translationCalls === 1) return jsonResponse({ message: 'expired token' }, 401)
      return bingTranslationResponse('刷新成功')
    }
  })

  const result = await client.translate('hello', {
    supported: true,
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hans'
  })

  assert.equal(result.translation, '刷新成功')
  assert.equal(authCalls, 2)
  assert.equal(translationCalls, 2)
})

test('微软错误应按鉴权、限流、参数和网络分类且不得泄露网页 Token', async () => {
  const scenarios = [
    { status: 401, expected: 'authentication' },
    { status: 403, expected: 'authentication' },
    { status: 429, expected: 'rate-limit' },
    { status: 400, expected: 'parameter' }
  ] as const

  for (const scenario of scenarios) {
    const client = new MicrosoftTranslationClient({
      fetch: async (url) => String(url).endsWith('/translator')
        ? htmlResponse()
        : jsonResponse({ message: 'bing-token-test' }, scenario.status)
    })
    await assert.rejects(
      () => client.translate('text', {
        supported: true,
        sourceLanguage: 'en',
        targetLanguage: 'zh-Hans'
      }),
      (error: Error) => {
        assert.ok(error instanceof MicrosoftError)
        assert.equal((error as MicrosoftError).kind, scenario.expected)
        assert.equal(error.message.includes('bing-token-test'), false)
        return true
      }
    )
  }

  const networkClient = new MicrosoftTranslationClient({
    fetch: async () => { throw new Error('network bing-token-test') }
  })
  await assert.rejects(
    () => networkClient.translate('text', {
      supported: true,
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hans'
    }),
    (error: Error) => {
      assert.ok(error instanceof MicrosoftError)
      assert.equal((error as MicrosoftError).kind, 'network')
      assert.equal(error.message.includes('bing-token-test'), false)
      return true
    }
  )
})

test('只启用微软通道且无需凭证即可在免费通道前翻译', async () => {
  const calls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      calls.push(value)
      if (value.endsWith('/translator')) return htmlResponse()
      if (value.includes('/ttranslatev3')) return bingTranslationResponse('微软结果')
      throw new Error('不应调用后续免费通道')
    }
  })
  const settings = normalizeSettings({
    schemaVersion: 7,
    sourceLang: 'EN',
    targetLang: 'ZH',
    microsoftEnabled: true
  })

  const result = await runtime.translate('hello', settings)

  assert.equal(result.translation, '微软结果')
  assert.equal(result.channel, '微软翻译')
  assert.match(calls[0] || '', /www\.bing\.com\/translator/u)
  assert.match(calls[1] || '', /www\.bing\.com\/ttranslatev3/u)
})

test('微软失败后应自动降级到自建 DeepLX', async () => {
  const calls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      calls.push(value)
      if (value.endsWith('/translator')) return htmlResponse()
      if (value.includes('/ttranslatev3')) return jsonResponse({}, 503)
      if (value === 'https://deeplx.example/translate') {
        return jsonResponse({ code: 200, data: '降级结果', source_lang: 'EN' })
      }
      throw new Error('不应调用更后的免费通道')
    }
  })
  const settings = normalizeSettings({
    schemaVersion: 7,
    sourceLang: 'EN',
    targetLang: 'ZH',
    microsoftEnabled: true,
    deepLxUrl: 'https://deeplx.example/translate'
  })

  const result = await runtime.translate('hello', settings)

  assert.equal(result.translation, '降级结果')
  assert.equal(result.channel, '自建 DeepLX')
  assert.match(calls[0] || '', /www\.bing\.com\/translator/u)
  assert.match(calls[1] || '', /www\.bing\.com\/ttranslatev3/u)
  assert.equal(calls[2], 'https://deeplx.example/translate')
})

test('微软运行时重置后应清理旧降级缓存、熔断和网页鉴权', async () => {
  let microsoftShouldFail = true
  let authCalls = 0
  let microsoftCalls = 0
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      if (value.endsWith('/translator')) {
        authCalls += 1
        return htmlResponse()
      }
      if (value.includes('/ttranslatev3')) {
        microsoftCalls += 1
        if (microsoftShouldFail) return jsonResponse({}, 503)
        return bingTranslationResponse('微软新结果')
      }
      if (value.includes('api.deeplx.org')) {
        return jsonResponse({ code: 200, data: '旧降级结果', source_lang: 'EN' })
      }
      throw new Error('不应调用更后的免费通道')
    }
  })
  const settings = normalizeSettings({
    schemaVersion: 7,
    sourceLang: 'EN',
    targetLang: 'ZH',
    microsoftEnabled: true
  })

  assert.equal((await runtime.translate('same text', settings)).translation, '旧降级结果')
  microsoftShouldFail = false
  runtime.resetMicrosoftRuntime()
  const result = await runtime.translate('same text', settings)

  assert.equal(result.translation, '微软新结果')
  assert.equal(result.channel, '微软翻译')
  assert.equal(microsoftCalls, 2)
  assert.equal(authCalls, 2)
})

test('微软可用性检测应无需凭证且不使用普通翻译结果缓存', async () => {
  let authCalls = 0
  let translationCalls = 0
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      if (String(url).endsWith('/translator')) {
        authCalls += 1
        return htmlResponse()
      }
      translationCalls += 1
      return bingTranslationResponse(translationCalls === 1 ? 'check' : 'normal', 'zh-Hans')
    }
  })

  assert.deepEqual(await runtime.checkMicrosoft(), {
    ok: true,
    code: 'available',
    message: '微软翻译在线且可用'
  })

  const settings = normalizeSettings({
    schemaVersion: 7,
    sourceLang: 'ZH',
    targetLang: 'EN',
    microsoftEnabled: true
  })
  const result = await runtime.translate('你好', settings)

  assert.equal(result.translation, 'normal')
  assert.equal(authCalls, 1)
  assert.equal(translationCalls, 2)
})
