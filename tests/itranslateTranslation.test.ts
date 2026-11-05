import assert from 'node:assert/strict'
import test from 'node:test'
import { TranslationRuntime } from '../src/main/translate.ts'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'

/**
 * 创建 JSON 响应。
 * @param body 响应体。
 * @param status HTTP 状态码。
 * @returns 测试用 Response。
 * @author zhenghq
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

/**
 * 校验 iTranslate 使用官方 v2 请求格式，并作为普通多通道翻译的可选通道。
 * @returns 无返回值。
 * @author zhenghq
 */
test('iTranslate 应按官方协议发送源/目标语言与文本', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const runtime = new TranslationRuntime({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init })
      return jsonResponse({
        translation: '你好',
        times: { total_time: 0.12 }
      })
    }
  })
  const settings = normalizeSettings({
    schemaVersion: 26,
    biliIndexTranslateEnabled: false,
    microsoftEnabled: false,
    itranslateEnabled: true,
    itranslateApiKeyConfigured: true,
    sourceLang: 'EN',
    targetLang: 'ZH'
  })

  const result = await runtime.translate('Hello', settings, null, null, 'itranslate-key')

  assert.equal(result.translation, '你好')
  assert.equal(result.provider, 'itranslate')
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url, 'https://dev-api.itranslate.com/translation/v2/')
  assert.deepEqual(requests[0]?.init?.headers, {
    Authorization: 'Bearer itranslate-key',
    'Content-Type': 'application/json'
  })
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    source: { dialect: 'en', text: 'Hello' },
    target: { dialect: 'zh' }
  })
})

/**
 * 校验未启用或未配置 Key 时绝不请求 iTranslate。
 * @returns 无返回值。
 * @author zhenghq
 */
test('iTranslate 未启用或无 Key 时不应加入翻译通道', async () => {
  const urls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      urls.push(String(url))
      if (String(url).includes('api.deeplx.org')) {
        return jsonResponse({ code: 200, data: '后备结果', source_lang: 'EN' })
      }
      throw new Error(`不应请求：${String(url)}`)
    }
  })
  const disabled = normalizeSettings({
    biliIndexTranslateEnabled: false,
    microsoftEnabled: false,
    itranslateEnabled: false,
    itranslateApiKeyConfigured: true,
    sourceLang: 'EN',
    targetLang: 'ZH'
  })
  const missingKey = normalizeSettings({
    ...disabled,
    itranslateEnabled: true,
    itranslateApiKeyConfigured: false
  })

  await runtime.translate('Hello', disabled, null, null, 'itranslate-key')
  await runtime.translate('World', missingKey, null, null, 'itranslate-key')

  assert.equal(urls.some((url) => url.includes('itranslate.com')), false)
})

/**
 * 校验 iTranslate 失败后仍继续走现有多通道降级。
 * @returns 无返回值。
 * @author zhenghq
 */
test('iTranslate 失败后应自动降级到现有通道', async () => {
  const urls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      urls.push(value)
      if (value.includes('itranslate.com')) return jsonResponse({ message: 'unavailable' }, 503)
      if (value.includes('translate.googleapis.com')) {
        return jsonResponse([[['后备译文']], null, 'auto'])
      }
      if (value.includes('api.deeplx.org')) {
        return jsonResponse({ message: 'unavailable' }, 503)
      }
      throw new Error(`不应请求：${value}`)
    }
  })
  const settings = normalizeSettings({
    schemaVersion: 26,
    biliIndexTranslateEnabled: false,
    microsoftEnabled: false,
    itranslateEnabled: true,
    itranslateApiKeyConfigured: true,
    sourceLang: 'EN',
    targetLang: 'ZH'
  })

  // 使用独立文本，避免同一测试运行时实例缓存前序用例的成功结果。
  const result = await runtime.translate('Hello fallback', settings, null, null, 'itranslate-key')

  assert.notEqual(result.provider, 'itranslate')
  assert.equal(result.translation, '后备译文')
  assert.equal(urls[0]?.includes('itranslate.com'), true, `首个请求应为 iTranslate，实际：${urls.join(', ')}`)
  assert.equal(urls.length >= 2, true, `应发生降级请求，实际：${urls.join(', ')}`)
  assert.equal(
    urls.slice(1).some((url) => !url.includes('itranslate.com')),
    true,
    `应切换到非 iTranslate 通道，实际：${urls.join(', ')}`
  )
})

/**
 * 校验 iTranslate 不支持的源/目标语言对会被跳过，不影响其他通道。
 * @returns 无返回值。
 * @author zhenghq
 */
test('iTranslate 不支持的语言对应直接跳过', async () => {
  const urls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      urls.push(String(url))
      if (String(url).includes('translate.googleapis.com')) {
        return jsonResponse([[['后备译文']], null, 'auto'])
      }
      if (String(url).includes('api.deeplx.org')) {
        return jsonResponse({ message: 'unavailable' }, 503)
      }
      throw new Error(`不应请求：${String(url)}`)
    }
  })
  const settings = normalizeSettings({
    schemaVersion: 26,
    biliIndexTranslateEnabled: false,
    microsoftEnabled: false,
    itranslateEnabled: true,
    itranslateApiKeyConfigured: true,
    sourceLang: 'auto',
    targetLang: 'auto'
  })

  const result = await runtime.translate('Hello', settings, null, null, 'itranslate-key')

  assert.notEqual(result.provider, 'itranslate')
  assert.equal(urls.some((url) => url.includes('itranslate.com')), false)
})

/**
 * 校验 iTranslate 配置变化后的运行时重置会同时清除结果缓存与熔断状态。
 * @returns 无返回值。
 * @author zhenghq
 */
test('iTranslate 运行时重置应清除缓存和熔断状态', async () => {
  const urls: string[] = []
  let failITranslate = true
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      urls.push(value)
      if (value.includes('itranslate.com')) {
        if (failITranslate) return jsonResponse({ message: 'unavailable' }, 503)
        return jsonResponse({ translation: '恢复后的译文', times: { total_time: 0.1 } })
      }
      if (value.includes('translate.googleapis.com')) {
        return jsonResponse([[['后备译文']], null, 'auto'])
      }
      if (value.includes('api.deeplx.org')) {
        return jsonResponse({ message: 'unavailable' }, 503)
      }
      throw new Error(`不应请求：${value}`)
    }
  })
  const settings = normalizeSettings({
    schemaVersion: 26,
    biliIndexTranslateEnabled: false,
    microsoftEnabled: false,
    itranslateEnabled: true,
    itranslateApiKeyConfigured: true,
    sourceLang: 'EN',
    targetLang: 'ZH'
  })

  await runtime.translate('First failure', settings, null, null, 'itranslate-key')
  failITranslate = false
  await runtime.translate('Second text', settings, null, null, 'itranslate-key')
  assert.equal(urls.filter((url) => url.includes('itranslate.com')).length, 1)

  runtime.resetITranslateRuntime()
  const result = await runtime.translate('Third text', settings, null, null, 'itranslate-key')
  assert.equal(result.provider, 'itranslate')
  assert.equal(result.translation, '恢复后的译文')
  assert.equal(urls.filter((url) => url.includes('itranslate.com')).length, 2)
})
