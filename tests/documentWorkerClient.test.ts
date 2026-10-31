import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DOCUMENT_WORKER_PROTOCOL_VERSION,
  createDocumentWorkerAssetRequestMessage,
  createDocumentWorkerAssetResultMessage,
  createDocumentWorkerCancelledMessage,
  createDocumentWorkerProgressMessage,
  createDocumentWorkerResultMessage,
  createDocumentWorkerTranslationSnapshotMessage,
  createDocumentWorkerTranslationUpdateMessage,
  type DocumentWorkerRequestMessage,
  type DocumentWorkerResponseMessage
} from '../src/shared/documentWorkerProtocol.ts'
import {
  DocumentWorkerClient,
  type DocumentWorkerProcess
} from '../src/main/documentWorkerClient.ts'
import {
  DocumentWorkerTranslationRpcHost
} from '../src/main/documentWorkerTranslationRpc.ts'

/**
 * 创建可注入的 utility process 替身。
 * @returns 记录消息与生命周期的进程替身。
 * @author zhenghq
 */
function fakeProcess(): DocumentWorkerProcess & {
  sent: DocumentWorkerRequestMessage[]
  emitMessage(message: unknown): void
  emitExit(code: number): void
  listenerCount(): number
  killCalls: number
} {
  const messageListeners = new Set<(message: unknown) => void>()
  const exitListeners = new Set<(code: number) => void>()
  return {
    sent: [],
    killCalls: 0,
    postMessage(message) {
      this.sent.push(message)
    },
    on(event, listener) {
      if (event === 'message') messageListeners.add(listener)
      else exitListeners.add(listener)
    },
    off(event, listener) {
      if (event === 'message') messageListeners.delete(listener)
      else exitListeners.delete(listener)
    },
    kill() {
      this.killCalls += 1
      return true
    },
    emitMessage(message) {
      for (const listener of messageListeners) listener(message)
    },
    emitExit(code) {
      for (const listener of exitListeners) listener(code)
    },
    listenerCount() {
      return messageListeners.size + exitListeners.size
    }
  }
}

test('worker 客户端应校验响应并只转发当前代际消息', () => {
  const process = fakeProcess()
  const received: DocumentWorkerResponseMessage[] = []
  const errors: string[] = []
  const client = new DocumentWorkerClient(process, {
    onMessage: (message) => received.push(message),
    onError: (code) => errors.push(code)
  })

  client.send({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'run',
    jobId: 'job-1',
    generation: 1,
    request: { path: '/tmp/sample.pdf', generation: 1 }
  })
  process.emitMessage(createDocumentWorkerProgressMessage('job-1', 1, {
    percent: 20,
    phase: 'parse',
    completed: 1,
    total: 5
  }))
  process.emitMessage(createDocumentWorkerProgressMessage('job-1', 2, {
    percent: 80,
    phase: 'translate',
    completed: 8,
    total: 10
  }))
  process.emitMessage({ version: 1, type: 'unknown', jobId: 'job-1', generation: 1, payload: {} })

  assert.equal(process.sent.length, 1)
  assert.equal(received.length, 1)
  assert.equal(received[0]?.type, 'progress')
  assert.deepEqual(errors, ['invalid-response'])
})

test('worker 客户端应忽略终态后的迟到进度并转发一次终态', () => {
  const process = fakeProcess()
  const received: DocumentWorkerResponseMessage[] = []
  const client = new DocumentWorkerClient(process, { onMessage: (message) => received.push(message) })

  client.send({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'run',
    jobId: 'job-1',
    generation: 1,
    request: { path: '/tmp/sample.pdf', generation: 1 }
  })
  process.emitMessage(createDocumentWorkerResultMessage('job-1', 1, {
    status: 'completed',
    percent: 100
  }))
  process.emitMessage(createDocumentWorkerProgressMessage('job-1', 1, {
    percent: 90,
    phase: 'translate',
    completed: 9,
    total: 10
  }))
  process.emitMessage(createDocumentWorkerResultMessage('job-1', 1, {
    status: 'completed',
    percent: 100
  }))

  assert.equal(received.length, 1)
  assert.equal(received[0]?.type, 'result')
})

test('worker 客户端必须把块增量视为非终态并过滤旧代际与终态后增量', () => {
  const process = fakeProcess()
  const received: DocumentWorkerResponseMessage[] = []
  const client = new DocumentWorkerClient(process, { onMessage: (message) => received.push(message) })

  client.send({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'run',
    jobId: 'job-1',
    generation: 1,
    request: { path: '/tmp/sample.pdf', generation: 1 }
  })
  const update = createDocumentWorkerTranslationUpdateMessage('job-1', 1, {
    pageId: 'page-1',
    blockId: 'block-1',
    block: {
      kind: 'text',
      blockId: 'block-1',
      readingOrder: 0,
      translatable: true,
      role: 'paragraph',
      runs: [{ runId: 'run-1', text: '你好' }]
    },
    completed: 1,
    total: 2
  })
  process.emitMessage(update)
  process.emitMessage({ ...update, generation: 2 })
  process.emitMessage(createDocumentWorkerResultMessage('job-1', 1, {
    status: 'completed',
    percent: 100
  }))
  process.emitMessage(update)

  assert.deepEqual(received.map((message) => message.type), ['translation-update', 'result'])
  assert.deepEqual(received[0], update)
})

test('worker 客户端必须把翻译骨架视为非终态并继续接收后续终态', () => {
  const process = fakeProcess()
  const received: DocumentWorkerResponseMessage[] = []
  const client = new DocumentWorkerClient(process, { onMessage: (message) => received.push(message) })
  client.send({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'run',
    jobId: 'job-1',
    generation: 1,
    request: { path: '/tmp/sample.pdf', generation: 1 }
  })
  const source = {
    schemaVersion: 1,
    documentId: 'document-1',
    source: {
      path: '/tmp/sample.txt',
      fileName: 'sample.txt',
      format: 'txt',
      sha256: 'fixture',
      size: 5
    },
    metadata: { direction: 'auto' },
    pages: [],
    assets: [],
    warnings: []
  }
  process.emitMessage(createDocumentWorkerTranslationSnapshotMessage('job-1', 1, {
    source,
    translation: structuredClone(source)
  }))
  process.emitMessage(createDocumentWorkerResultMessage('job-1', 1, {
    status: 'completed',
    percent: 100
  }))

  assert.deepEqual(received.map((message) => message.type), ['translation-snapshot', 'result'])
})

test('worker 客户端不得把翻译 RPC 消息误报为非法响应', async () => {
  const process = fakeProcess()
  const errors: string[] = []
  const rpcMessages: string[] = []
  const client = new DocumentWorkerClient(process, {
    onMessage: () => undefined,
    onError: (code) => errors.push(code)
  })
  const host = new DocumentWorkerTranslationRpcHost(process, {
    isCurrent: (jobId, generation) => jobId === 'job-1' && generation === 1,
    translate: async () => {
      rpcMessages.push('translated')
      return '你好'
    }
  })
  client.send({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'run',
    jobId: 'job-1',
    generation: 1,
    request: { path: '/tmp/sample.pdf', generation: 1 }
  })

  process.emitMessage({
    type: 'translation-request',
    requestId: 'request-1',
    jobId: 'job-1',
    generation: 1,
    text: 'hello',
    languagePair: { sourceLang: 'EN', targetLang: 'ZH' }
  })
  process.emitMessage({
    type: 'translation-cancel',
    requestId: 'request-1'
  })
  process.emitMessage({
    type: 'translation-delta',
    requestId: 'request-1',
    delta: '你'
  })
  process.emitMessage({
    type: 'translation-result',
    requestId: 'request-1',
    translation: '你好'
  })
  process.emitMessage({
    type: 'translation-failure',
    requestId: 'request-1',
    code: 'translation-failed'
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(rpcMessages, ['translated'])
  assert.deepEqual(errors, [])
  host.dispose()
})

test('worker 客户端取消应发送取消消息并允许之后的新代际任务', () => {
  const process = fakeProcess()
  const received: DocumentWorkerResponseMessage[] = []
  const client = new DocumentWorkerClient(process, { onMessage: (message) => received.push(message) })
  client.send({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'run',
    jobId: 'job-1',
    generation: 1,
    request: { path: '/tmp/sample.pdf', generation: 1 }
  })
  assert.equal(client.cancel('job-1', 1), true)
  assert.equal(client.cancel('job-1', 1), false)
  assert.deepEqual(process.sent.at(-1), {
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'cancel',
    jobId: 'job-1',
    generation: 1
  })

  process.emitMessage(createDocumentWorkerCancelledMessage('job-1', 1))
  assert.equal(received.length, 1)
  assert.equal(received[0]?.type, 'cancelled')

  client.send({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'retry',
    jobId: 'job-1',
    generation: 2,
    request: { path: '/tmp/sample.pdf', generation: 2 }
  })
  assert.equal(process.sent.at(-1)?.generation, 2)
})

test('worker 客户端进程退出应报告稳定错误并拒绝后续发送', () => {
  const process = fakeProcess()
  const errors: string[] = []
  const client = new DocumentWorkerClient(process, {
    onMessage: () => undefined,
    onError: (code) => errors.push(code)
  })
  process.emitExit(1)
  assert.deepEqual(errors, ['worker-crashed'])
  assert.equal(client.send({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'cancel',
    jobId: 'job-1',
    generation: 1
  }), false)
  client.dispose()
  assert.equal(process.killCalls, 1)
})

test('worker 客户端资源请求不得重置活动任务，终态后仍可请求并接收资源结果', () => {
  const process = fakeProcess()
  const received: DocumentWorkerResponseMessage[] = []
  const errors: string[] = []
  const client = new DocumentWorkerClient(process, {
    onMessage: (message) => received.push(message),
    onError: (code) => errors.push(code)
  })
  client.send({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'run',
    jobId: 'job-1',
    generation: 1,
    request: { path: '/tmp/sample.pdf', generation: 1 }
  })
  process.emitMessage(createDocumentWorkerResultMessage('job-1', 1, {
    status: 'completed',
    percent: 100
  }))

  assert.equal(client.send(createDocumentWorkerAssetRequestMessage(
    'job-1',
    1,
    'asset-request-1',
    'asset-1'
  )), true)
  assert.equal(process.sent.at(-1)?.type, 'asset-request')

  process.emitMessage(createDocumentWorkerAssetResultMessage(
    'job-1',
    1,
    'asset-request-1',
    'asset-1',
    { bytes: new Uint8Array([1, 2, 3]) }
  ))
  assert.equal(received.length, 1)
  assert.equal(received[0]?.type, 'result')
  assert.deepEqual(errors, [])
  client.dispose()
})

test('worker 客户端不得把终态后的迟到进度当成有效响应，但资源请求仍保持当前代际', () => {
  const process = fakeProcess()
  const received: DocumentWorkerResponseMessage[] = []
  const errors: string[] = []
  const client = new DocumentWorkerClient(process, {
    onMessage: (message) => received.push(message),
    onError: (code) => errors.push(code)
  })
  client.send({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'run',
    jobId: 'job-1',
    generation: 1,
    request: { path: '/tmp/sample.pdf', generation: 1 }
  })
  process.emitMessage(createDocumentWorkerResultMessage('job-1', 1, {
    status: 'completed',
    percent: 100
  }))
  assert.equal(client.send(createDocumentWorkerAssetRequestMessage(
    'job-1',
    1,
    'asset-request-1',
    'asset-1'
  )), true)
  process.emitMessage(createDocumentWorkerProgressMessage('job-1', 1, {
    percent: 90,
    phase: 'translate',
    completed: 9,
    total: 10
  }))
  assert.equal(received.length, 1)
  assert.deepEqual(errors, [])
  client.dispose()
})

test('worker 客户端释放必须幂等、注销监听器、终止进程并拒绝迟到消息', () => {
  const process = fakeProcess()
  const received: DocumentWorkerResponseMessage[] = []
  const errors: string[] = []
  const client = new DocumentWorkerClient(process, {
    onMessage: (message) => received.push(message),
    onError: (code) => errors.push(code)
  })
  client.send({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'run',
    jobId: 'job-1',
    generation: 1,
    request: { path: '/tmp/sample.pdf', generation: 1 }
  })

  client.dispose()
  client.dispose()

  assert.equal(process.listenerCount(), 0)
  assert.equal(process.killCalls, 1)
  assert.equal(client.send(createDocumentWorkerProgressMessage('job-1', 1, {
    percent: 50,
    phase: 'parse',
    completed: 1,
    total: 2
  })), false)

  // 即使底层进程错误地保留了监听器，释放后的客户端也不得转发迟到消息。
  process.emitMessage(createDocumentWorkerResultMessage('job-1', 1, {
    status: 'completed',
    percent: 100
  }))
  process.emitExit(1)
  assert.deepEqual(received, [])
  assert.deepEqual(errors, [])
})
