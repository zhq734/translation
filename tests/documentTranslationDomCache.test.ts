import assert from 'node:assert/strict'
import test from 'node:test'
import { createDocumentTranslationDomCache } from '../src/renderer/src/documentTranslationDomCache.ts'

/**
 * 创建带标记的伪译文内容节点。
 * @param marker 节点标识文本。
 * @returns 伪译文内容元素。
 * @author zhenghq
 */
function createFakeContent(marker: string): HTMLElement {
  const element = {
    marker,
    children: [] as string[]
  } as unknown as HTMLElement
  return element
}

test('同一 Tab 且签名一致时必须复用缓存的译文 DOM', () => {
  const cache = createDocumentTranslationDomCache()
  const content = createFakeContent('tab-a-content')
  cache.remember({
    tabId: 'tab-a',
    sha256: 'sha-a',
    jobId: 'job-a',
    signature: 'sig-1',
    warningSignature: 'warn-1',
    previewKind: 'paged',
    content: [content]
  })
  const hit = cache.take({
    tabId: 'tab-a',
    sha256: 'sha-a',
    jobId: 'job-a',
    signature: 'sig-1',
    warningSignature: 'warn-1'
  })
  assert.deepEqual(hit?.content, [content])
  assert.equal(hit?.previewKind, 'paged')
})

test('内容签名或文件指纹变化时不得复用旧译文 DOM', () => {
  const cache = createDocumentTranslationDomCache()
  cache.remember({
    tabId: 'tab-a',
    sha256: 'sha-a',
    jobId: 'job-a',
    signature: 'sig-1',
    warningSignature: 'warn-1',
    previewKind: 'paged',
    content: [createFakeContent('old')]
  })
  assert.equal(cache.take({
    tabId: 'tab-a',
    sha256: 'sha-a',
    jobId: 'job-a',
    signature: 'sig-2',
    warningSignature: 'warn-1'
  }), null)
  assert.equal(cache.take({
    tabId: 'tab-a',
    sha256: 'sha-b',
    jobId: 'job-a',
    signature: 'sig-1',
    warningSignature: 'warn-1'
  }), null)
})

test('缓存超限时按最近最少使用丢弃译文 DOM 并回报被淘汰的 Tab', () => {
  const cache = createDocumentTranslationDomCache({ capacity: 2 })
  const evicted: string[] = []
  cache.onEvict((tabId) => evicted.push(tabId))
  cache.remember({
    tabId: 'tab-a',
    sha256: 'sha-a',
    jobId: 'job',
    signature: 'sig',
    warningSignature: 'warn',
    previewKind: 'paged',
    content: [createFakeContent('a')]
  })
  cache.remember({
    tabId: 'tab-b',
    sha256: 'sha-b',
    jobId: 'job',
    signature: 'sig',
    warningSignature: 'warn',
    previewKind: 'paged',
    content: [createFakeContent('b')]
  })
  assert.notEqual(cache.take({ tabId: 'tab-a', sha256: 'sha-a', jobId: 'job', signature: 'sig', warningSignature: 'warn' }), null)
  cache.remember({
    tabId: 'tab-c',
    sha256: 'sha-c',
    jobId: 'job',
    signature: 'sig',
    warningSignature: 'warn',
    previewKind: 'paged',
    content: [createFakeContent('c')]
  })
  assert.deepEqual(evicted, ['tab-b'])
  assert.equal(cache.take({ tabId: 'tab-b', sha256: 'sha-b', jobId: 'job', signature: 'sig', warningSignature: 'warn' }), null)
})

test('显式移除 Tab 时必须丢弃其缓存并回报淘汰', () => {
  const cache = createDocumentTranslationDomCache()
  const evicted: string[] = []
  cache.onEvict((tabId) => evicted.push(tabId))
  cache.remember({
    tabId: 'tab-a',
    sha256: 'sha-a',
    jobId: 'job',
    signature: 'sig',
    warningSignature: 'warn',
    previewKind: 'paged',
    content: [createFakeContent('a')]
  })
  cache.remove('tab-a')
  assert.deepEqual(evicted, ['tab-a'])
  assert.equal(cache.take({ tabId: 'tab-a', sha256: 'sha-a', jobId: 'job', signature: 'sig', warningSignature: 'warn' }), null)
})

test('cachedTabIds 必须返回当前仍被缓存的全部 Tab 标识', () => {
  const cache = createDocumentTranslationDomCache()
  cache.remember({
    tabId: 'tab-a',
    sha256: 'sha-a',
    jobId: 'job',
    signature: 'sig',
    warningSignature: 'warn',
    previewKind: 'paged',
    content: [createFakeContent('a')]
  })
  assert.deepEqual([...cache.cachedTabIds()], ['tab-a'])
})
