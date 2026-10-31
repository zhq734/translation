import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DocumentWorkerTranslationRpcClient,
  DocumentWorkerTranslationRpcHost,
  type DocumentWorkerTranslationRpcRequest,
  type DocumentWorkerTranslationRpcResponse
} from '../src/main/documentWorkerTranslationRpc.ts'

/** 创建可观察的 worker 侧消息端口。 */
function workerPort(): {
  sent: DocumentWorkerTranslationRpcRequest[]
  emit(message: unknown): void
  listeners: Set<(message: unknown) => void>
  postMessage(message: DocumentWorkerTranslationRpcRequest): void
  on(event: 'message', listener: (message: unknown) => void): void
  off(event: 'message', listener: (message: unknown) => void): void
} {
  const listeners = new Set<(message: unknown) => void>()
  const sent: DocumentWorkerTranslationRpcRequest[] = []
  return {
    sent,
    listeners,
    postMessage(message): void {
      sent.push(message)
    },
    on(_event, listener): void {
      listeners.add(listener)
    },
    off(_event, listener): void {
      listeners.delete(listener)
    },
    emit(message: unknown): void {
      for (const listener of listeners) listener(message)
    }
  }
}

/** 创建只接受主进程消息的 host 端口。 */
function hostPort(): {
  sent: DocumentWorkerTranslationRpcResponse[]
  emit(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): void
  off(event: 'message', listener: (message: unknown) => void): void
  postMessage(message: DocumentWorkerTranslationRpcResponse): void
} {
  const listeners = new Set<(message: unknown) => void>()
  const sent: DocumentWorkerTranslationRpcResponse[] = []
  return {
    sent,
    emit(message: unknown): void {
      for (const listener of listeners) listener(message)
    },
    postMessage(message): void {
      sent.push(message)
    },
    on(_event: 'message', listener: (message: unknown) => void): void {
      listeners.add(listener)
    },
    off(_event: 'message', listener: (message: unknown) => void): void {
      listeners.delete(listener)
    }
  }
}

test('翻译 RPC 客户端应发送真实任务上下文并接收增量与结果', async () => {
  const port = workerPort()
  const client = new DocumentWorkerTranslationRpcClient(port as never)
  const deltas: string[] = []

  const pending = client.translate({
    requestId: 'request-1',
    jobId: 'job-1',
    generation: 7,
    text: 'hello',
    languagePair: { sourceLang: 'EN', targetLang: 'ZH' }
  }, new AbortController().signal, (delta) => deltas.push(delta))

  assert.equal(port.sent.length, 1)
  assert.equal(port.sent[0]?.jobId, 'job-1')
  assert.equal(port.sent[0]?.generation, 7)
  port.emit({
    type: 'translation-delta',
    requestId: 'request-1',
    delta: '你'
  })
  port.emit({
    type: 'translation-result',
    requestId: 'request-1',
    translation: '你好'
  })

  assert.equal(await pending, '你好')
  assert.deepEqual(deltas, ['你'])
})

test('翻译 RPC 客户端取消后应拒绝迟到结果且不触发增量', async () => {
  const port = workerPort()
  const client = new DocumentWorkerTranslationRpcClient(port as never)
  const controller = new AbortController()
  const deltas: string[] = []
  const pending = client.translate({
    requestId: 'request-2',
    jobId: 'job-2',
    generation: 1,
    text: 'hello',
    languagePair: { sourceLang: 'EN', targetLang: 'ZH' }
  }, controller.signal, (delta) => deltas.push(delta))

  controller.abort()
  await assert.rejects(pending, (error: unknown) => (error as Error).name === 'AbortError')
  port.emit({ type: 'translation-delta', requestId: 'request-2', delta: '迟到' })
  port.emit({ type: 'translation-result', requestId: 'request-2', translation: '迟到结果' })

  assert.deepEqual(deltas, [])
})

test('翻译 RPC 客户端应忽略未知请求并清理监听', async () => {
  const port = workerPort()
  const client = new DocumentWorkerTranslationRpcClient(port as never)
  const pending = client.translate({
    requestId: 'request-3',
    jobId: 'job-3',
    generation: 1,
    text: 'hello',
    languagePair: { sourceLang: 'EN', targetLang: 'ZH' }
  }, new AbortController().signal)
  port.emit({ type: 'translation-delta', requestId: 'other', delta: 'ignored' })
  port.emit({ type: 'translation-result', requestId: 'request-3', translation: 'ok' })
  assert.equal(await pending, 'ok')
  client.dispose()
  assert.equal(port.listeners.size, 0)
})

test('翻译 RPC 主进程应校验当前代际、转发增量并返回脱敏结果', async () => {
  const port = hostPort()
  const calls: Array<{ text: string; jobId: string; generation: number }> = []
  const host = new DocumentWorkerTranslationRpcHost(port as never, {
    isCurrent: (jobId, generation) => jobId === 'job-1' && generation === 4,
    translate: async (request, signal, onDelta) => {
      calls.push({ text: request.text, jobId: request.jobId, generation: request.generation })
      assert.equal(signal.aborted, false)
      onDelta('你')
      return '你好'
    }
  })

  port.emit({
    type: 'translation-request',
    requestId: 'request-4',
    jobId: 'job-1',
    generation: 4,
    text: 'hello',
    languagePair: { sourceLang: 'EN', targetLang: 'ZH' }
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(calls, [{ text: 'hello', jobId: 'job-1', generation: 4 }])
  assert.deepEqual(port.sent.map((message) => message.type), ['translation-delta', 'translation-result'])
  host.dispose()
})

test('翻译 RPC 主进程应拒绝旧代际并不调用翻译', async () => {
  const port = hostPort()
  let calls = 0
  const host = new DocumentWorkerTranslationRpcHost(port as never, {
    isCurrent: () => false,
    translate: async () => {
      calls += 1
      return 'unexpected'
    }
  })

  port.emit({
    type: 'translation-request',
    requestId: 'request-5',
    jobId: 'job-old',
    generation: 1,
    text: 'hello',
    languagePair: { sourceLang: 'EN', targetLang: 'ZH' }
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(calls, 0)
  assert.equal(port.sent.length, 1)
  assert.equal(port.sent[0]?.type, 'translation-failure')
  if (port.sent[0]?.type === 'translation-failure') {
    assert.equal(port.sent[0].code, 'generation-conflict')
  }
  host.dispose()
})

test('翻译 RPC 主进程取消应终止底层翻译并丢弃迟到增量', async () => {
  const port = hostPort()
  let aborted = false
  let release: (() => void) | undefined
  const host = new DocumentWorkerTranslationRpcHost(port as never, {
    isCurrent: () => true,
    translate: async (_request, signal, onDelta) => {
      await new Promise<void>((resolve) => {
        release = resolve
        signal.addEventListener('abort', () => {
          aborted = true
          resolve()
        }, { once: true })
      })
      onDelta('迟到')
      return '迟到结果'
    }
  })

  port.emit({
    type: 'translation-request',
    requestId: 'request-6',
    jobId: 'job-6',
    generation: 1,
    text: 'hello',
    languagePair: { sourceLang: 'EN', targetLang: 'ZH' }
  })
  port.emit({ type: 'translation-cancel', requestId: 'request-6' })
  release?.()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(aborted, true)
  assert.equal(port.sent.some((message) => message.type === 'translation-delta'), false)
  assert.equal(port.sent.some((message) => message.type === 'translation-result'), false)
  host.dispose()
})

test('翻译 RPC 主进程失败时不得泄露原始异常文本', async () => {
  const port = hostPort()
  const host = new DocumentWorkerTranslationRpcHost(port as never, {
    isCurrent: () => true,
    translate: async () => {
      throw new Error('/private/path token=secret')
    }
  })

  port.emit({
    type: 'translation-request',
    requestId: 'request-7',
    jobId: 'job-7',
    generation: 1,
    text: 'hello',
    languagePair: { sourceLang: 'EN', targetLang: 'ZH' }
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(port.sent.length, 1)
  assert.equal(port.sent[0]?.type, 'translation-failure')
  assert.equal(JSON.stringify(port.sent).includes('secret'), false)
  host.dispose()
})

test('翻译 RPC 必须丢弃携带图片、路径或凭据字段的越界请求', async () => {
  const port = hostPort()
  let calls = 0
  const host = new DocumentWorkerTranslationRpcHost(port as never, {
    isCurrent: () => true,
    translate: async () => {
      calls += 1
      return 'unexpected'
    }
  })

  port.emit({
    type: 'translation-request',
    requestId: 'request-boundary',
    jobId: 'job-boundary',
    generation: 1,
    text: 'hello',
    languagePair: { sourceLang: 'EN', targetLang: 'ZH' },
    imageBytes: [1, 2, 3],
    sourcePath: '/private/source.pdf',
    apiKey: 'secret'
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(calls, 0)
  assert.deepEqual(port.sent, [])
  host.dispose()
})
