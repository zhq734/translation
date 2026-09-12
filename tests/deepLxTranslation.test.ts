import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDeepLxUrls, TranslationRuntime } from '../src/main/translate.ts'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'

/**
 * 构造 JSON Response。
 * @param body 响应对象。
 * @returns Fetch 兼容响应。
 * @author zhenghq
 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

test('DeepLX 多地址解析应支持中英文逗号、去空白和去重', () => {
  assert.deepEqual(parseDeepLxUrls(' https://a/translate,https://b/translate， https://a/translate ,, '), [
    'https://a/translate',
    'https://b/translate'
  ])
})

test('并发翻译应轮询分散到多个 DeepLX 地址', async () => {
  const calls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      calls.push(String(url))
      return jsonResponse({ code: 200, data: `result-${calls.length}`, source_lang: 'EN' })
    }
  })
  const settings = normalizeSettings({
    deepLxUrl: 'https://a.example/translate,https://b.example/translate',
    sourceLang: 'EN',
    targetLang: 'ZH'
  })

  await Promise.all([
    runtime.translate('first', settings),
    runtime.translate('second', settings)
  ])

  assert.deepEqual(calls, [
    'https://a.example/translate',
    'https://b.example/translate'
  ])
})

test('自建地址失败应继续尝试下一个并最终回退公共 DeepLX', async () => {
  const calls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      calls.push(value)
      if (value.includes('a.example') || value.includes('b.example')) {
        return jsonResponse({ code: 500, message: 'failed' })
      }
      if (value.includes('api.deeplx.org')) return jsonResponse({ code: 200, data: 'public', source_lang: 'EN' })
      throw new Error('不应调用后续通道')
    }
  })
  const settings = normalizeSettings({
    deepLxUrl: 'https://a.example/translate,https://b.example/translate',
    sourceLang: 'EN',
    targetLang: 'ZH'
  })

  const result = await runtime.translate('text', settings)
  assert.equal(result.provider, 'deeplx-public')
  assert.deepEqual(calls.slice(0, 2), [
    'https://a.example/translate',
    'https://b.example/translate'
  ])
  assert.match(calls[2], /^https:\/\/api\.deeplx\.org\/.+\/translate$/u)
})

test('DeepLX 运行时重置应清除缓存、轮询位置和每地址熔断', async () => {
  const calls: string[] = []
  let failA = true
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      calls.push(value)
      if (value.includes('a.example') && failA) return jsonResponse({ code: 500, message: 'failed' })
      return jsonResponse({ code: 200, data: value, source_lang: 'EN' })
    }
  })
  const settings = normalizeSettings({
    deepLxUrl: 'https://a.example/translate,https://b.example/translate',
    sourceLang: 'EN',
    targetLang: 'ZH'
  })

  await runtime.translate('same', settings)
  failA = false
  runtime.resetDeepLxRuntime()
  const result = await runtime.translate('same', settings)
  assert.equal(result.translation, 'https://a.example/translate')
  assert.equal(calls.at(-1), 'https://a.example/translate')
})
