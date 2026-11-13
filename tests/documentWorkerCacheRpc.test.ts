import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DocumentWorkerCacheRpcClient,
  DocumentWorkerCacheRpcHost,
  type DocumentWorkerCacheRpcClientPort,
  type DocumentWorkerCacheRpcHostPort,
  type DocumentWorkerCacheRpcReadRequest
} from '../src/main/documentWorkerCacheRpc.ts'
import type { DocumentTranslationCacheEntry } from '../src/shared/documentTranslation.ts'

/**
 * 创建可双向发送消息的缓存 RPC 测试端口。
 * @returns worker 与主进程端口及消息记录。
 * @author zhenghq
 */
function createPair(): {
  workerPort: DocumentWorkerCacheRpcClientPort & { sent: unknown[] }
  hostPort: DocumentWorkerCacheRpcHostPort & { sent: unknown[] }
  workerListeners: Set<(message: unknown) => void>
  hostListeners: Set<(message: unknown) => void>
} {
  const workerListeners = new Set<(message: unknown) => void>()
  const hostListeners = new Set<(message: unknown) => void>()
  const workerPort = {
    sent: [] as unknown[],
    postMessage(message: unknown): void {
      this.sent.push(message)
      for (const listener of hostListeners) listener(message)
    },
    on(_event: 'message', listener: (message: unknown) => void): void {
      workerListeners.add(listener)
    },
    off(_event: 'message', listener: (message: unknown) => void): void {
      workerListeners.delete(listener)
    }
  }
  const hostPort = {
    sent: [] as unknown[],
    postMessage(message: unknown): void {
      this.sent.push(message)
      for (const listener of workerListeners) listener(message)
    },
    on(_event: 'message', listener: (message: unknown) => void): void {
      hostListeners.add(listener)
    },
    off(_event: 'message', listener: (message: unknown) => void): void {
      hostListeners.delete(listener)
    }
  }
  return { workerPort, hostPort, workerListeners, hostListeners }
}

/** 创建合法缓存条目。 */
const cacheEntry: DocumentTranslationCacheEntry = {
  sourceSha256: 'source-sha256',
  translationProtocolVersion: 'document-translation-protocol-v3',
  languagePair: { sourceLang: 'EN', targetLang: 'ZH' },
  glossaryVersion: 'glossary-v1',
  protectionRulesVersion: 'protection-v1',
  status: 'completed',
  translation: '你好'
}

test('缓存 RPC 应按 requestId 关联并发读写并保持代际隔离', async () => {
  const { workerPort, hostPort } = createPair()
  const reads: Array<{ jobId: string; generation: number; key: string }> = []
  const writes: Array<{ jobId: string; generation: number; key: string; value: unknown }> = []
  const host = new DocumentWorkerCacheRpcHost(hostPort, {
    isCurrent: (jobId, generation) => jobId === 'job-1' && generation === 2,
    read: async (request) => {
      reads.push({ jobId: request.jobId, generation: request.generation, key: request.key })
      return request.key === 'hit' ? cacheEntry : null
    },
    write: async (request) => {
      writes.push({
        jobId: request.jobId,
        generation: request.generation,
        key: request.key,
        value: request.value
      })
    }
  })
  const client = new DocumentWorkerCacheRpcClient(workerPort)

  const [hit, miss] = await Promise.all([
    client.read('job-1', 2, 'hit'),
    client.read('job-1', 2, 'miss')
  ])
  await client.write('job-1', 2, 'write-key', cacheEntry)

  assert.deepEqual(hit, cacheEntry)
  assert.equal(miss, null)
  assert.deepEqual(reads.map(({ key }) => key).sort(), ['hit', 'miss'])
  assert.deepEqual(writes, [{
    jobId: 'job-1',
    generation: 2,
    key: 'write-key',
    value: cacheEntry
  }])
  client.dispose()
  host.dispose()
})

test('缓存 RPC 应拒绝非当前代际、未知字段和超限载荷且不回显内容', async () => {
  const { workerPort, hostPort } = createPair()
  let reads = 0
  let writes = 0
  const host = new DocumentWorkerCacheRpcHost(hostPort, {
    isCurrent: () => true,
    read: async () => {
      reads += 1
      return cacheEntry
    },
    write: async () => {
      writes += 1
    }
  })
  workerPort.postMessage({
    type: 'cache-read-result',
    requestId: 'request-1',
    responseToken: 'forged-token',
    value: cacheEntry,
    leaked: '/private/path'
  })
  workerPort.postMessage({
    type: 'cache-read-request',
    requestId: 'request-1',
    responseToken: 'token-1',
    jobId: 'job-1',
    generation: 1,
    key: 'k'.repeat(4097)
  })
  workerPort.postMessage({
    type: 'cache-write-request',
    requestId: 'request-2',
    responseToken: 'token-2',
    jobId: 'job-1',
    generation: 1,
    key: 'key',
    value: { ...cacheEntry, rawSource: 'secret' }
  })
  workerPort.postMessage({
    type: 'cache-read-request',
    requestId: 'x'.repeat(129),
    responseToken: 'token-3',
    jobId: 'job-1',
    generation: 1,
    key: 'key'
  })
  workerPort.postMessage({
    type: 'cache-write-request',
    requestId: 'request-oversized',
    responseToken: 'token-4',
    jobId: 'job-1',
    generation: 1,
    key: 'key',
    value: { ...cacheEntry, translation: 'secret'.repeat(2 * 1024 * 1024) }
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(reads, 0)
  assert.equal(writes, 0)
  assert.doesNotMatch(JSON.stringify(hostPort.sent), /private|secret|k{100}/u)
  host.dispose()
})

test('缓存 RPC 宿主应拒绝旧代际读写请求并只返回稳定失败结果', async () => {
  const { workerPort, hostPort } = createPair()
  let reads = 0
  let writes = 0
  const host = new DocumentWorkerCacheRpcHost(hostPort, {
    isCurrent: (jobId, generation) => jobId === 'job-2' && generation === 3,
    read: async () => {
      reads += 1
      return cacheEntry
    },
    write: async () => {
      writes += 1
    }
  })
  const client = new DocumentWorkerCacheRpcClient(workerPort)
  const writeResult = client.write('job-1', 2, 'key', cacheEntry)
  workerPort.postMessage({
    type: 'cache-read-request',
    requestId: 'manual-read',
    responseToken: 'manual-token',
    jobId: 'job-1',
    generation: 2,
    key: 'key'
  } as DocumentWorkerCacheRpcReadRequest)

  assert.equal(await writeResult, false)
  assert.equal(reads, 0)
  assert.equal(writes, 0)
  assert.deepEqual(hostPort.sent.map((message) => (
    message && typeof message === 'object' ? (message as { type?: unknown }).type : undefined
  )), ['cache-write-result', 'cache-read-result'])
  assert.doesNotMatch(JSON.stringify(hostPort.sent), /secret|private/u)
  client.dispose()
  host.dispose()
})

test('缓存 RPC 读异常必须视为 miss，写异常必须返回失败而不抛错', async () => {
  const { workerPort, hostPort } = createPair()
  const host = new DocumentWorkerCacheRpcHost(hostPort, {
    isCurrent: () => true,
    read: async () => {
      throw new Error('disk read failed: /private/cache')
    },
    write: async () => {
      throw new Error('disk write failed: /private/cache')
    }
  })
  const client = new DocumentWorkerCacheRpcClient(workerPort)

  assert.equal(await client.read('job-1', 1, 'key'), null)
  assert.equal(await client.write('job-1', 1, 'key', cacheEntry), false)
  assert.doesNotMatch(JSON.stringify(hostPort.sent), /private\/cache/u)
  client.dispose()
  host.dispose()
})

test('缓存 RPC 必须丢弃迟到响应和重复 requestId', async () => {
  const { workerPort, hostPort } = createPair()
  let resolveRead: ((value: DocumentTranslationCacheEntry | null) => void) | undefined
  const host = new DocumentWorkerCacheRpcHost(hostPort, {
    isCurrent: () => true,
    read: async () => new Promise((resolve) => {
      resolveRead = resolve
    }),
    write: async () => undefined
  })
  const client = new DocumentWorkerCacheRpcClient(workerPort)
  const pending = client.read('job-1', 1, 'key')
  await new Promise((resolve) => setImmediate(resolve))

  hostPort.postMessage({
    type: 'cache-read-result',
    requestId: 'unknown',
    responseToken: 'unknown-token',
    value: cacheEntry
  })
  const request = workerPort.sent.find((message) => (
    message && typeof message === 'object' && (message as { type?: unknown }).type === 'cache-read-request'
  )) as { requestId: string; responseToken: string } | undefined
  assert.ok(request)
  hostPort.postMessage({
    type: 'cache-read-result',
    requestId: request.requestId,
    responseToken: 'forged-token',
    value: { ...cacheEntry, translation: '迟到' }
  })
  resolveRead?.(cacheEntry)

  assert.deepEqual(await pending, cacheEntry)
  hostPort.postMessage({
    type: 'cache-read-result',
    requestId: request.requestId,
    responseToken: request.responseToken,
    value: { ...cacheEntry, translation: '重复' }
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(workerPort.sent.filter((message) => (
    message && typeof message === 'object' && (message as { type?: unknown }).type === 'cache-read-result'
  )).length, 0)
  client.dispose()
  host.dispose()
})

test('缓存 RPC dispose 必须拒绝全部未完成请求且之后不再发送', async () => {
  const { workerPort, hostPort } = createPair()
  const host = new DocumentWorkerCacheRpcHost(hostPort, {
    isCurrent: () => true,
    read: async () => new Promise(() => undefined),
    write: async () => new Promise(() => undefined)
  })
  const client = new DocumentWorkerCacheRpcClient(workerPort)
  const pendingRead = client.read('job-1', 1, 'read')
  const pendingWrite = client.write('job-1', 1, 'write', cacheEntry)
  await new Promise((resolve) => setImmediate(resolve))
  const sentCount = workerPort.sent.length

  client.dispose()
  await assert.rejects(pendingRead, { name: 'AbortError' })
  await assert.rejects(pendingWrite, { name: 'AbortError' })
  assert.equal(await client.write('job-1', 1, 'after-dispose', cacheEntry), false)
  assert.equal(workerPort.sent.length, sentCount)
  host.dispose()
})
