import assert from 'node:assert/strict'
import test from 'node:test'
import { BoundedLruCache } from '../src/main/boundedLruCache.ts'
import {
  createWebPageContentFingerprint,
  WebPageTranslationCache,
  type WebPageTranslationCacheContext
} from '../src/main/webPageTranslationCache.ts'
import type { ExtractedWebTextUnit } from '../src/shared/webPageTranslation.ts'

/**
 * 创建页面缓存测试上下文。
 * @param overrides 需要覆盖的上下文字段。
 * @returns 页面缓存上下文。
 * @author zhenghq
 */
function context(overrides: Partial<WebPageTranslationCacheContext> = {}): WebPageTranslationCacheContext {
  return {
    url: 'https://example.com/article#section',
    pageFingerprint: 'page-v1',
    scope: 'all',
    sourceLang: 'auto',
    targetLang: 'ZH',
    translationContext: 'google|ai:off',
    ...overrides
  }
}

/**
 * 创建当前页面快照中的文本单元。
 * @param id 当前单元标识。
 * @param sourceText 当前原文。
 * @param fingerprint 原文指纹。
 * @returns 当前页面文本单元。
 * @author zhenghq
 */
function currentUnit(id: string, sourceText: string, fingerprint: string): ExtractedWebTextUnit {
  return {
    id,
    blockId: `block-${id}`,
    sourceText,
    text: sourceText.trim(),
    category: 'body',
    anchor: { parentSelector: `#current-${id}`, textNodeIndex: 2, sourceFingerprint: fingerprint }
  }
}

test('通用 LRU 命中应刷新顺序，并按条目数与估算容量淘汰', () => {
  const cache = new BoundedLruCache<string, string>({
    maxEntries: 2,
    maxBytes: 6,
    sizeOf: (key, value) => key.length + value.length
  })
  cache.set('a', '1')
  cache.set('b', '2')
  assert.equal(cache.get('a'), '1')
  cache.set('c', '3')
  assert.equal(cache.has('b'), false)
  assert.equal(cache.has('a'), true)
  cache.set('long', 'value')
  assert.equal(cache.has('long'), false)
  assert.equal(cache.size, 2)
  assert.ok(cache.estimatedBytes <= 6)
})

test('页面缓存应按 URL、指纹、范围、语言方向与配置上下文隔离', () => {
  const cache = new WebPageTranslationCache()
  cache.put(context(), [{ sourceText: 'Hello', sourceFingerprint: 'fp-hello', translation: '你好' }])

  assert.equal(cache.match(context(), [currentUnit('new', 'Hello', 'fp-hello')]).length, 1)
  assert.equal(cache.match(context({ targetLang: 'JA' }), [currentUnit('new', 'Hello', 'fp-hello')]).length, 0)
  assert.equal(cache.match(context({ pageFingerprint: 'page-v2' }), [currentUnit('new', 'Hello', 'fp-hello')]).length, 0)
  assert.equal(cache.match(context({ translationContext: 'ai:model-v2' }), [currentUnit('new', 'Hello', 'fp-hello')]).length, 0)
})

test('页面缓存命中必须使用当前快照锚点且只保存成功译文', () => {
  const cache = new WebPageTranslationCache()
  cache.put(context(), [
    { sourceText: ' Hello ', sourceFingerprint: 'fp-hello', translation: '你好' },
    { sourceText: 'Failed', sourceFingerprint: 'fp-failed', error: '失败' }
  ])
  const current = currentUnit('current', ' Hello ', 'fp-hello')
  const matched = cache.match(context(), [current])

  assert.equal(matched.length, 1)
  assert.equal(matched[0].id, 'current')
  assert.deepEqual(matched[0].anchor, current.anchor)
  assert.equal(matched[0].translation, '你好')
})

test('页面缓存应限制页面数和每页语言方向数并使用 LRU 淘汰', () => {
  const cache = new WebPageTranslationCache({ maxPages: 2, maxDirectionsPerPage: 2, maxUnits: 10, maxBytes: 1000 })
  const entry = [{ sourceText: 'Hello', sourceFingerprint: 'fp', translation: '你好' }]
  cache.put(context({ url: 'https://a.example/', targetLang: 'ZH' }), entry)
  cache.put(context({ url: 'https://a.example/', targetLang: 'JA' }), entry)
  cache.put(context({ url: 'https://a.example/', targetLang: 'KO' }), entry)
  assert.equal(cache.match(context({ url: 'https://a.example/', targetLang: 'ZH' }), [currentUnit('u', 'Hello', 'fp')]).length, 0)

  cache.put(context({ url: 'https://b.example/' }), entry)
  cache.put(context({ url: 'https://c.example/' }), entry)
  assert.equal(cache.pageCount, 2)
})

test('页面内容指纹应忽略当前选择器变化并感知原文变化', () => {
  const original = currentUnit('original', 'Hello', 'fp-hello')
  const relocated = {
    ...currentUnit('relocated', 'Hello', 'fp-hello'),
    anchor: { parentSelector: '#relocated', textNodeIndex: 9, sourceFingerprint: 'fp-hello' }
  }
  const changed = currentUnit('changed', 'Hello again', 'fp-changed')

  assert.equal(createWebPageContentFingerprint([original]), createWebPageContentFingerprint([relocated]))
  assert.notEqual(createWebPageContentFingerprint([original]), createWebPageContentFingerprint([changed]))
})
