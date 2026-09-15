import assert from 'node:assert/strict'
import test from 'node:test'
import { WebPageTranslationCache, type WebPageTranslationCacheContext } from '../src/main/webPageTranslationCache.ts'
import type { WebImageCandidate } from '../src/shared/webPageTranslation.ts'

/**
 * 创建图片缓存测试上下文。
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
 * 创建当前页面快照中的图片候选。
 * @param imageId 图片标识。
 * @param sourceFingerprint 图片来源指纹。
 * @param overrides 需要覆盖的字段。
 * @returns 图片候选。
 * @author zhenghq
 */
function candidate(
  imageId: string,
  sourceFingerprint: string,
  overrides: Partial<WebImageCandidate> = {}
): WebImageCandidate {
  return {
    imageId,
    kind: 'img',
    selector: `#image-${imageId}`,
    rect: { x: 10, y: 20, width: 300, height: 200 },
    sourceFingerprint,
    src: `https://cdn.example.com/${imageId}.png`,
    ...overrides
  }
}

test('图片缓存应按页面指纹、图片标识与语言方向隔离', () => {
  const cache = new WebPageTranslationCache()
  cache.putImages(context(), [candidate('img-1', 'fp-1', { ocrText: 'Hello', translation: '你好' })])

  assert.equal(cache.matchImages(context(), [candidate('img-1', 'fp-1')]).length, 1)
  assert.equal(cache.matchImages(context({ pageFingerprint: 'page-v2' }), [candidate('img-1', 'fp-1')]).length, 0)
  assert.equal(cache.matchImages(context({ targetLang: 'JA' }), [candidate('img-1', 'fp-1')]).length, 0)
  assert.equal(cache.matchImages(context(), [candidate('img-2', 'fp-2')]).length, 0)
  assert.equal(cache.matchImages(context(), [candidate('img-1', 'fp-changed')]).length, 0)
})

test('图片缓存命中应复用识别与译文并保留当前快照锚点', () => {
  const cache = new WebPageTranslationCache()
  cache.putImages(context(), [candidate('img-1', 'fp-1', { ocrText: 'Hello', translation: '你好' })])
  const current = candidate('img-1', 'fp-1', {
    selector: '#relocated',
    rect: { x: 99, y: 88, width: 320, height: 210 }
  })
  const matched = cache.matchImages(context(), [current])

  assert.equal(matched.length, 1)
  assert.equal(matched[0].ocrText, 'Hello')
  assert.equal(matched[0].translation, '你好')
  assert.equal(matched[0].selector, '#relocated')
  assert.deepEqual(matched[0].rect, current.rect)
})

test('图片缓存与文本缓存分区互不干扰', () => {
  const cache = new WebPageTranslationCache()
  cache.putImages(context(), [candidate('img-1', 'fp-1', { ocrText: 'Hello', translation: '你好' })])
  cache.put(context(), [{ sourceText: 'Hello', sourceFingerprint: 'fp-text', translation: '你好' }])

  assert.equal(cache.matchImages(context(), [candidate('img-1', 'fp-1')]).length, 1)
  assert.equal(cache.match(context(), [{
    id: 'unit-1',
    blockId: 'block-1',
    sourceText: 'Hello',
    text: 'Hello',
    category: 'body',
    anchor: { parentSelector: '#p', textNodeIndex: 0, sourceFingerprint: 'fp-text' }
  }]).length, 1)

  const imageOnly = new WebPageTranslationCache()
  imageOnly.putImages(context(), [candidate('img-1', 'fp-1', { ocrText: 'Hello', translation: '你好' })])
  assert.equal(imageOnly.match(context(), [{
    id: 'unit-1',
    blockId: 'block-1',
    sourceText: 'Hello',
    text: 'Hello',
    category: 'body',
    anchor: { parentSelector: '#p', textNodeIndex: 0, sourceFingerprint: 'fp-text' }
  }]).length, 0)
})

test('图片缓存只写入成功识别并翻译的结果', () => {
  const cache = new WebPageTranslationCache()
  const stored = cache.putImages(context(), [
    candidate('ok', 'fp-ok', { ocrText: 'Hello', translation: '你好' }),
    candidate('low', 'fp-low', { ocrText: 'noise', skippedReason: 'low-quality' }),
    candidate('failed', 'fp-failed', { ocrText: 'Hello', error: 'translate-failed' }),
    candidate('empty', 'fp-empty', { ocrText: 'Hello' })
  ])

  assert.equal(stored, 1)
  assert.equal(cache.matchImages(context(), [candidate('ok', 'fp-ok')]).length, 1)
  assert.equal(cache.matchImages(context(), [candidate('low', 'fp-low')]).length, 0)
  assert.equal(cache.matchImages(context(), [candidate('failed', 'fp-failed')]).length, 0)
  assert.equal(cache.matchImages(context(), [candidate('empty', 'fp-empty')]).length, 0)
})

test('图片缓存命中应刷新 LRU 顺序并受容量上限保护', () => {
  const cache = new WebPageTranslationCache({ maxPages: 5, maxDirectionsPerPage: 5, maxUnits: 2, maxBytes: 100000 })
  cache.putImages(context({ url: 'https://a.example/' }), [candidate('a', 'fp-a', { ocrText: 'A', translation: '甲' })])
  cache.putImages(context({ url: 'https://b.example/' }), [candidate('b', 'fp-b', { ocrText: 'B', translation: '乙' })])

  assert.equal(cache.matchImages(context({ url: 'https://a.example/' }), [candidate('a', 'fp-a')]).length, 1)
  cache.putImages(context({ url: 'https://c.example/' }), [candidate('c', 'fp-c', { ocrText: 'C', translation: '丙' })])

  assert.equal(cache.matchImages(context({ url: 'https://a.example/' }), [candidate('a', 'fp-a')]).length, 1)
  assert.equal(cache.matchImages(context({ url: 'https://b.example/' }), [candidate('b', 'fp-b')]).length, 0)
})

test('图片缓存超预算条目应被拒绝写入', () => {
  const cache = new WebPageTranslationCache({ maxUnits: 10, maxBytes: 1 })
  const stored = cache.putImages(context(), [candidate('img-1', 'fp-1', { ocrText: 'Hello', translation: '你好' })])

  assert.equal(stored, 0)
  assert.equal(cache.matchImages(context(), [candidate('img-1', 'fp-1')]).length, 0)
})
