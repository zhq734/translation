import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { TranslationRuntime } from '../src/main/translate.ts'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'

/**
 * 创建 JSON 响应，供翻译通道优先级测试使用。
 * @param body JSON 响应体。
 * @param status HTTP 状态码。
 * @returns 可供翻译运行时解析的响应。
 * @author zhenghq
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

test('旧设置升级后应默认自动选择翻译 API，并仅保留合法首选项', () => {
  const legacy = normalizeSettings({ schemaVersion: 7 })
  const preferred = normalizeSettings({
    schemaVersion: 9,
    preferredTranslationProvider: 'google'
  })
  const invalid = normalizeSettings({
    schemaVersion: 9,
    preferredTranslationProvider: 'unknown-api' as 'google'
  })

  assert.equal(legacy.schemaVersion, 11)
  assert.equal(legacy.preferredTranslationProvider, 'auto')
  assert.equal(preferred.preferredTranslationProvider, 'google')
  assert.equal(invalid.preferredTranslationProvider, 'auto')
})

test('切换首选 API 后相同文本应优先请求新 API，而不是复用其他通道缓存', async () => {
  const calls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      calls.push(value)
      if (value.includes('api.deeplx.org')) {
        return jsonResponse({ code: 200, data: '公共结果', source_lang: 'EN' })
      }
      if (value.includes('translate.googleapis.com')) {
        return jsonResponse([[['谷歌结果']], null, 'en'])
      }
      throw new Error(`不应请求其他通道：${value}`)
    }
  })
  const automatic = normalizeSettings({
    schemaVersion: 9,
    sourceLang: 'EN',
    targetLang: 'ZH'
  })
  const googlePreferred = normalizeSettings({
    ...automatic,
    preferredTranslationProvider: 'google'
  })

  const first = await runtime.translate('same text', automatic)
  const second = await runtime.translate('same text', googlePreferred)

  assert.equal(first.channel, '公共 DeepLX')
  assert.equal(first.provider, 'deeplx-public')
  assert.equal(second.translation, '谷歌结果')
  assert.equal(second.channel, 'Google')
  assert.equal(second.provider, 'google')
  assert.deepEqual(calls.map((url) => url.includes('api.deeplx.org') ? 'public' : 'google'), [
    'public',
    'google'
  ])
})

test('首选 API 失败熔断后应自动切换后备 API，冷却期内继续跳过首选项', async () => {
  const calls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      calls.push(value)
      if (value.includes('api.deeplx.org')) {
        return jsonResponse({ code: 500, message: '公共服务暂不可用' }, 503)
      }
      if (value.includes('translate.googleapis.com')) {
        return jsonResponse([[['后备结果']], null, 'en'])
      }
      throw new Error(`不应请求其他通道：${value}`)
    }
  })
  const settings = normalizeSettings({
    schemaVersion: 9,
    sourceLang: 'EN',
    targetLang: 'ZH',
    preferredTranslationProvider: 'deeplx-public'
  })

  const first = await runtime.translate('first text', settings)
  const second = await runtime.translate('second text', settings)

  assert.equal(first.channel, 'Google')
  assert.equal(first.provider, 'google')
  assert.equal(second.channel, 'Google')
  assert.equal(second.provider, 'google')
  assert.equal(calls.filter((url) => url.includes('api.deeplx.org')).length, 1)
  assert.equal(calls.filter((url) => url.includes('translate.googleapis.com')).length, 2)
})

test('首选 API 熔断恢复后相同文本应重新尝试首选项，而不是沿用后备缓存', async () => {
  let now = 0
  let preferredShouldFail = true
  const calls: string[] = []
  const runtime = new TranslationRuntime({
    now: () => now,
    fetch: async (url) => {
      const value = String(url)
      calls.push(value)
      if (value.includes('api.deeplx.org')) {
        return preferredShouldFail
          ? jsonResponse({ code: 500, message: '首选服务暂不可用' }, 503)
          : jsonResponse({ code: 200, data: '首选恢复结果', source_lang: 'EN' })
      }
      if (value.includes('translate.googleapis.com')) {
        return jsonResponse([[['临时后备结果']], null, 'en'])
      }
      throw new Error(`不应请求其他通道：${value}`)
    }
  })
  const settings = normalizeSettings({
    schemaVersion: 9,
    sourceLang: 'EN',
    targetLang: 'ZH',
    preferredTranslationProvider: 'deeplx-public'
  })

  assert.equal((await runtime.translate('same text', settings)).channel, 'Google')
  now = 120_001
  preferredShouldFail = false
  const recovered = await runtime.translate('same text', settings)

  assert.equal(recovered.translation, '首选恢复结果')
  assert.equal(recovered.channel, '公共 DeepLX')
  assert.equal(recovered.provider, 'deeplx-public')
  assert.deepEqual(calls.map((url) => url.includes('api.deeplx.org') ? 'public' : 'google'), [
    'public',
    'google',
    'public'
  ])
})

test('悬浮窗底部应提供翻译 API 下拉框，并在切换后持久化和重新翻译', () => {
  const html = readFileSync('src/renderer/index.html', 'utf8')
  const source = readFileSync('src/renderer/src/popup.ts', 'utf8')
  const css = readFileSync('src/renderer/src/style.css', 'utf8')

  assert.match(html, /<select id="translation-provider"[^>]*aria-label="翻译 API"/u)
  assert.match(source, /preferredTranslationProvider/u)
  assert.match(source, /window\.api\.setSettings\(\{\s*preferredTranslationProvider:/u)
  assert.match(source, /translationProviderEl\.addEventListener\('change'/u)
  assert.match(source, /retranslateWithCurrentLanguages/u)
  assert.match(css, /#translation-provider/u)
  assert.match(css, /var\(--(?:text|bg|border|control|button)-/u)
})
