import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOcrCacheKey, OcrResultCache } from '../src/main/ocrCache.ts'
import type { OcrEngineId } from '../src/shared/types.ts'

const bytesA = new TextEncoder().encode('png-bytes-a')
const bytesB = new TextEncoder().encode('png-bytes-b')

/**
 * 校验相同图片字节、语言与引擎生成相同缓存键。
 * @returns 无返回值。
 * @author zhenghq
 */
test('相同输入应生成相同缓存键', () => {
  assert.equal(
    buildOcrCacheKey(bytesA, 'zh-CN', 'paddle'),
    buildOcrCacheKey(new Uint8Array(bytesA), 'zh-CN', 'paddle')
  )
})

/**
 * 校验图片字节、语言或引擎任一不同都会得到不同缓存键。
 * @returns 无返回值。
 * @author zhenghq
 */
test('任一输入不同应生成不同缓存键', () => {
  const base = buildOcrCacheKey(bytesA, 'zh-CN', 'paddle')
  assert.notEqual(buildOcrCacheKey(bytesB, 'zh-CN', 'paddle'), base)
  assert.notEqual(buildOcrCacheKey(bytesA, 'en', 'paddle'), base)
  assert.notEqual(buildOcrCacheKey(bytesA, 'zh-CN', 'tesseract'), base)
})

/**
 * 校验缓存键包含引擎与语言前缀，便于排查。
 * @returns 无返回值。
 * @author zhenghq
 */
test('缓存键应包含引擎与语言前缀', () => {
  const key = buildOcrCacheKey(bytesA, 'zh-CN', 'system')
  assert.ok(key.startsWith('system|zh-CN|'))
  assert.equal(key.split('|').length, 3)
})

/**
 * 校验缓存读写与不存在键返回 null。
 * @returns 无返回值。
 * @author zhenghq
 */
test('缓存应支持读写并处理缺失键', () => {
  const cache = new OcrResultCache(10, () => 1234)
  assert.equal(cache.get('missing'), null)
  const entry = { text: 'hello', engine: 'paddle' as OcrEngineId, score: 12 }
  cache.set('k1', entry)
  assert.equal(cache.has('k1'), true)
  assert.deepEqual(cache.get('k1'), { ...entry, createdAt: 1234 })
})

/**
 * 校验缓存超过容量时按最近最少使用顺序淘汰。
 * @returns 无返回值。
 * @author zhenghq
 */
test('缓存超容量应按 LRU 淘汰最旧条目', () => {
  const cache = new OcrResultCache(2)
  const entry = { text: 't', engine: 'paddle' as OcrEngineId, score: 1 }
  cache.set('a', entry)
  cache.set('b', entry)
  cache.set('c', entry)
  assert.equal(cache.has('a'), false)
  assert.equal(cache.has('b'), true)
  assert.equal(cache.has('c'), true)
  assert.equal(cache.size, 2)
})

/**
 * 校验读取条目会刷新其 LRU 位置。
 * @returns 无返回值。
 * @author zhenghq
 */
test('读取条目应刷新 LRU 位置', () => {
  const cache = new OcrResultCache(2)
  const entry = { text: 't', engine: 'paddle' as OcrEngineId, score: 1 }
  cache.set('a', entry)
  cache.set('b', entry)
  cache.get('a')
  cache.set('c', entry)
  assert.equal(cache.has('a'), true)
  assert.equal(cache.has('b'), false)
})

/**
 * 校验清空操作移除全部条目。
 * @returns 无返回值。
 * @author zhenghq
 */
test('清空操作应移除全部条目', () => {
  const cache = new OcrResultCache(4)
  cache.set('a', { text: 't', engine: 'paddle' as OcrEngineId, score: 1 })
  cache.clear()
  assert.equal(cache.size, 0)
  assert.equal(cache.get('a'), null)
})
