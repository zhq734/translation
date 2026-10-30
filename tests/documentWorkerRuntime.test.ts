import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  DOCUMENT_WORKER_PROTOCOL_VERSION,
  type DocumentWorkerRequestMessage,
  type DocumentWorkerResponseMessage
} from '../src/shared/documentWorkerProtocol.ts'
import type { DocumentWorkerExecutor } from '../src/main/documentWorker.ts'
import {
  runDocumentWorkerRuntime,
  type DocumentWorkerRuntimeDependencies,
  type DocumentWorkerRuntimePort
} from '../src/main/documentWorkerRuntime.ts'

/**
 * 创建可注入的 utility process 父端口替身。
 * @returns 记录监听器与已发送消息的端口。
 * @author zhenghq
 */
function fakePort(): DocumentWorkerRuntimePort & {
  emitMessage(data: unknown): void
  sent: DocumentWorkerResponseMessage[]
  listenerCount(): number
} {
  const listeners = new Set<(event: { data: unknown }) => void>()
  return {
    sent: [],
    on(_event, listener) {
      listeners.add(listener)
    },
    off(_event, listener) {
      listeners.delete(listener)
    },
    postMessage(message) {
      this.sent.push(message)
    },
    emitMessage(data) {
      for (const listener of listeners) listener({ data })
    },
    listenerCount() {
      return listeners.size
    }
  }
}

/**
 * 创建可观察调用次数的 worker 执行器。
 * @returns 执行器替身。
 * @author zhenghq
 */
function executor(): DocumentWorkerExecutor & { calls: number } {
  return {
    calls: 0,
    async execute(message: DocumentWorkerRequestMessage, _signal, emit): Promise<void> {
      this.calls += 1
      emit({
        version: DOCUMENT_WORKER_PROTOCOL_VERSION,
        type: 'result',
        jobId: message.jobId,
        generation: message.generation,
        payload: { status: 'completed', percent: 100 }
      })
    }
  }
}

/**
 * 创建合法的 worker 运行请求。
 * @returns 运行请求消息。
 * @author zhenghq
 */
function runRequest(): DocumentWorkerRequestMessage {
  return {
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'run',
    jobId: 'job-runtime-1',
    generation: 1,
    request: { path: '/tmp/document.pdf', generation: 1 }
  }
}

test('worker 运行时应在注入父端口后启动，并在清理时注销监听', async () => {
  const port = fakePort()
  const run = executor()
  const dependencies: DocumentWorkerRuntimeDependencies = {
    resolveParentPort: () => port,
    createExecutor: () => run
  }
  const stop = runDocumentWorkerRuntime(dependencies)

  port.emitMessage(runRequest())
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(run.calls, 1)
  assert.deepEqual(port.sent.map((message) => message.type), ['result'])
  assert.equal(port.listenerCount(), 1)
  stop()
  assert.equal(port.listenerCount(), 0)
})

test('worker 运行时缺少父端口时应抛出稳定错误', () => {
  assert.throws(
    () => runDocumentWorkerRuntime({
      resolveParentPort: () => null,
      createExecutor: () => executor()
    }),
    (error: unknown) => error instanceof Error &&
      error.message === 'document-worker-parent-port-unavailable'
  )
})

test('worker 运行时模块被普通导入时不得自动启动', async () => {
  const source = await readFile('src/main/documentWorkerRuntime.ts', 'utf8')

  assert.doesNotMatch(source, /^runDocumentWorkerRuntime\(\)/mu)
  assert.match(source, /export function runDocumentWorkerRuntime\(/u)
  assert.match(source, /process\.parentPort/u)
})
