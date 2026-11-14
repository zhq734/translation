import assert from 'node:assert/strict'
import test from 'node:test'
import { createDocumentPdfDocumentCache } from '../src/renderer/src/documentPdfDocumentCache.ts'

/**
 * 创建可断言销毁状态的伪 PDF 文档代理。
 * @returns 带销毁标记的伪 PDF 文档。
 * @author zhenghq
 */
function createFakePdfDocument(): { destroyed: boolean; destroy(): Promise<void> } {
  const fake = {
    destroyed: false,
    destroy: async (): Promise<void> => {
      fake.destroyed = true
    }
  }
  return fake
}

test('同一文件指纹的 PDF 文档必须直接复用，不得重复解析', () => {
  const cache = createDocumentPdfDocumentCache()
  const first = createFakePdfDocument()
  cache.set('sha-a', first)
  assert.equal(cache.get('sha-a'), first)
  const second = createFakePdfDocument()
  cache.set('sha-a', second)
  assert.equal(cache.get('sha-a'), second)
})

test('缓存超限时必须按最近最少使用淘汰并销毁 PDF 文档', () => {
  const cache = createDocumentPdfDocumentCache({ capacity: 2 })
  const docA = createFakePdfDocument()
  const docB = createFakePdfDocument()
  const docC = createFakePdfDocument()
  cache.set('sha-a', docA)
  cache.set('sha-b', docB)
  cache.set('sha-c', docC)
  assert.equal(cache.get('sha-a'), null)
  assert.notEqual(cache.get('sha-b'), null)
  assert.notEqual(cache.get('sha-c'), null)
  assert.equal(docA.destroyed, true, '被淘汰的 PDF 文档必须立即销毁释放内存')
})

test('读取缓存必须刷新最近使用顺序，避免正在使用的文档被淘汰', () => {
  const cache = createDocumentPdfDocumentCache({ capacity: 2 })
  const docA = createFakePdfDocument()
  const docB = createFakePdfDocument()
  const docC = createFakePdfDocument()
  cache.set('sha-a', docA)
  cache.set('sha-b', docB)
  assert.equal(cache.get('sha-a'), docA)
  cache.set('sha-c', docC)
  assert.notEqual(cache.get('sha-a'), null)
  assert.equal(cache.get('sha-b'), null)
  assert.equal(docB.destroyed, true)
})

test('显式删除必须销毁对应 PDF 文档并移出缓存', () => {
  const cache = createDocumentPdfDocumentCache()
  const doc = createFakePdfDocument()
  cache.set('sha-a', doc)
  cache.delete('sha-a')
  assert.equal(cache.get('sha-a'), null)
  assert.equal(doc.destroyed, true)
})
