import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  BILIBILI_INDEX_BASE_URL,
  BILIBILI_INDEX_DEFAULT_MODEL,
  BILIBILI_INDEX_MODELS,
  BILIBILI_INDEX_USER_AGENT,
  BilibiliIndexError,
  BilibiliIndexTranslationClient,
  isBilibiliIndexModel,
  toBilibiliIndexCheckStatus
} from '../src/main/bilibiliIndexTranslation.ts'
import { TranslationRuntime } from '../src/main/translate.ts'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'
import { tForTest } from './helpers/i18n.ts'

/**
 * 创建 JSON 响应。
 * @param body JSON 响应体。
 * @param status HTTP 状态码。
 * @returns 可供客户端解析的响应。
 * @author zhenghq
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

test('Bilibili Index-Translate 客户端应发送浏览器 UA、无 Origin 且关闭思考模式', async () => {
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  const client = new BilibiliIndexTranslationClient({
    fetch: async (url, init) => {
      capturedUrl = String(url)
      capturedInit = init
      return jsonResponse({
        choices: [{ message: { content: '今日はお疲れ様でした！' } }]
      })
    }
  })

  const translation = await client.translate({
    text: '今天辛苦了！',
    sourceLang: 'ZH',
    targetLang: 'JP',
    model: BILIBILI_INDEX_DEFAULT_MODEL
  })

  assert.equal(translation, '今日はお疲れ様でした！')
  assert.equal(capturedUrl, `${BILIBILI_INDEX_BASE_URL}/chat/completions`)
  const headers = new Headers(capturedInit?.headers)
  assert.equal(headers.get('user-agent'), BILIBILI_INDEX_USER_AGENT)
  assert.equal(headers.has('origin'), false)
  assert.equal(headers.has('authorization'), false)
  const body = JSON.parse(String(capturedInit?.body)) as {
    model?: string
    messages?: Array<{ role?: string; content?: string }>
    chat_template_kwargs?: { enable_thinking?: boolean }
  }
  assert.equal(body.model, 'index-mt-9b')
  assert.equal(body.chat_template_kwargs?.enable_thinking, false)
  assert.equal(body.messages?.[1]?.role, 'user')
  assert.equal(body.messages?.[1]?.content, '今天辛苦了！')
})

test('Bilibili Index-Translate 应支持三个公开模型并拒绝未知模型', () => {
  assert.deepEqual([...BILIBILI_INDEX_MODELS], [
    'index-mt-2b',
    'index-mt-9b',
    'index-mt-35b'
  ])
  assert.equal(isBilibiliIndexModel('index-mt-2b'), true)
  assert.equal(isBilibiliIndexModel('index-mt-9b'), true)
  assert.equal(isBilibiliIndexModel('index-mt-35b'), true)
  assert.equal(isBilibiliIndexModel('index-mt-unknown'), false)
})

test('Bilibili Index-Translate 检测应使用注入 fetch 且不污染普通缓存', async () => {
  let calls = 0
  const runtime = new TranslationRuntime({
    fetch: async () => {
      calls += 1
      return jsonResponse({ choices: [{ message: { content: 'Hello' } }] })
    }
  })

  const status = await runtime.checkBilibiliIndex()

  assert.deepEqual(status, {
    ok: true,
    code: 'available',
    message: tForTest('en-US', 'translate.check.biliIndexAvailable')
  })
  assert.equal(calls, 1)
})

test('Bilibili Index-Translate 的 HTTP 412 应返回明确且脱敏的错误', async () => {
  const client = new BilibiliIndexTranslationClient({
    fetch: async () => jsonResponse({ error: { message: 'blocked-secret-origin' } }, 412)
  })

  await assert.rejects(
    client.translate({
      text: '不应泄露的原文',
      sourceLang: 'ZH',
      targetLang: 'EN',
      model: 'index-mt-9b'
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /412/u)
      assert.equal(error.message.includes('blocked-secret-origin'), false)
      assert.equal(error.message.includes('不应泄露的原文'), false)
      return true
    }
  )
})

test('Bilibili Index-Translate 空响应应给出稳定错误', async () => {
  const client = new BilibiliIndexTranslationClient({
    fetch: async () => jsonResponse({ choices: [{ message: { content: '   ' } }] })
  })

  await assert.rejects(
    client.translate({
      text: 'hello',
      sourceLang: 'EN',
      targetLang: 'ZH',
      model: 'index-mt-9b'
    }),
    /empty/u
  )
})

test('Bilibili Index-Translate 检测状态应依据稳定错误分类而非本地化文本', () => {
  assert.deepEqual(toBilibiliIndexCheckStatus(
    new BilibiliIndexError('timeout', 'localized timeout message')
  ), {
    ok: false,
    code: 'network',
    message: tForTest('en-US', 'translate.biliIndex.timeout')
  })
  assert.deepEqual(toBilibiliIndexCheckStatus(
    new BilibiliIndexError('network', 'localized network message')
  ), {
    ok: false,
    code: 'network',
    message: tForTest('en-US', 'translate.biliIndex.network')
  })
  assert.deepEqual(toBilibiliIndexCheckStatus(
    new BilibiliIndexError('blocked', 'localized blocked message')
  ), {
    ok: false,
    code: 'service',
    message: tForTest('en-US', 'translate.biliIndex.blocked')
  })
})

test('Bilibili Index-Translate 请求超时和网络异常应返回稳定分类', async () => {
  const timeoutClient = new BilibiliIndexTranslationClient({
    timeoutMs: 1,
    fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    })
  })
  await assert.rejects(
    timeoutClient.translate({
      text: 'hello',
      sourceLang: 'EN',
      targetLang: 'ZH',
      model: 'index-mt-9b'
    }),
    (error: unknown) => error instanceof BilibiliIndexError && error.kind === 'timeout'
  )

  const networkClient = new BilibiliIndexTranslationClient({
    fetch: async () => {
      throw new TypeError('fetch failed')
    }
  })
  await assert.rejects(
    networkClient.translate({
      text: 'hello',
      sourceLang: 'EN',
      targetLang: 'ZH',
      model: 'index-mt-9b'
    }),
    (error: unknown) => error instanceof BilibiliIndexError && error.kind === 'network'
  )
})

test('Bilibili Index-Translate 默认启用并排在 AI 之后、钉钉之前', async () => {
  const calls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      calls.push(value)
      if (value.includes('index-translate.bilibili.com')) {
        return jsonResponse({ choices: [{ message: { content: 'B站结果' } }] })
      }
      throw new Error(`不应请求后续通道：${value}`)
    }
  })
  const settings = normalizeSettings({ sourceLang: 'EN', targetLang: 'ZH' })

  const result = await runtime.translate('hello', settings)

  assert.equal(settings.biliIndexTranslateEnabled, true)
  assert.equal(settings.biliIndexTranslateModel, BILIBILI_INDEX_DEFAULT_MODEL)
  assert.equal(result.provider, 'bili-index')
  assert.equal(result.translation, 'B站结果')
  assert.equal(calls.length, 1)
  assert.match(calls[0] || '', /index-translate\.bilibili\.com\/v1\/chat\/completions$/u)
})

test('Bilibili Index-Translate 失败后应熔断并降级到后续通道', async () => {
  let now = 0
  const calls: string[] = []
  const runtime = new TranslationRuntime({
    now: () => now,
    fetch: async (url) => {
      const value = String(url)
      calls.push(value)
      if (value.includes('index-translate.bilibili.com')) {
        return jsonResponse({ error: 'blocked' }, 412)
      }
      if (value.includes('api.deeplx.org')) {
        return jsonResponse({ code: 200, data: '降级结果', source_lang: 'EN' })
      }
      throw new Error(`不应请求后续通道：${value}`)
    }
  })
  const settings = normalizeSettings({ sourceLang: 'EN', targetLang: 'ZH' })

  assert.equal((await runtime.translate('first', settings)).provider, 'deeplx-public')
  now = 1
  assert.equal((await runtime.translate('second', settings)).provider, 'deeplx-public')
  assert.equal(calls.filter((url) => url.includes('index-translate.bilibili.com')).length, 1)
})

test('Bilibili Index-Translate 模型变化后不得复用旧缓存', async () => {
  const models: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string }
      models.push(body.model)
      return jsonResponse({ choices: [{ message: { content: body.model } }] })
    }
  })
  const base = normalizeSettings({ sourceLang: 'EN', targetLang: 'ZH' })

  assert.equal((await runtime.translate('same', base)).translation, 'index-mt-9b')
  assert.equal((await runtime.translate('same', {
    ...base,
    biliIndexTranslateModel: 'index-mt-35b'
  })).translation, 'index-mt-35b')
  assert.deepEqual(models, ['index-mt-9b', 'index-mt-35b'])
})

test('Bilibili Index-Translate 设置页应提供默认启用开关、模型选择和检测入口', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const renderer = readFileSync('src/renderer/src/settings.ts', 'utf8')
  const preload = readFileSync('src/preload/index.ts', 'utf8')

  assert.match(html, /id="translation-service-bili-index"[^>]+data-service-anchor="bili-index"/u)
  assert.match(html, /id="bili-index-enabled"[^>]+type="checkbox"[^>]+checked/u)
  assert.match(html, /id="bili-index-model"/u)
  assert.match(html, /value="index-mt-2b"/u)
  assert.match(html, /value="index-mt-9b"[^>]+selected/u)
  assert.match(html, /value="index-mt-35b"/u)
  assert.match(html, /id="bili-index-check"/u)
  assert.match(html, /id="bili-index-status"/u)
  assert.match(renderer, /biliIndexTranslateEnabled/u)
  assert.match(renderer, /biliIndexTranslateModel/u)
  assert.match(renderer, /window\.api\.checkBiliIndexTranslate/u)
  assert.match(preload, /checkBiliIndexTranslate[\s\S]*bili-index:check/u)
})
