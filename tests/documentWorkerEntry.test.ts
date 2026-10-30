import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  DOCUMENT_WORKER_PROTOCOL_VERSION,
  type DocumentWorkerRequestMessage,
  type DocumentWorkerResponseMessage
} from '../src/shared/documentWorkerProtocol.ts'
import {
  startDocumentWorkerEntry,
  type DocumentWorkerEntryDependencies,
  type DocumentWorkerEntryPort
} from '../src/main/documentWorkerEntry.ts'
import type { DocumentWorkerExecutor } from '../src/main/documentWorker.ts'

/**
 * 创建可注入的 worker 父端口替身。
 * @returns 记录监听器与已发送响应的端口。
 * @author zhenghq
 */
function fakePort(): DocumentWorkerEntryPort & {
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
 * 创建可观察调用与取消状态的 worker 执行器。
 * @param waitForAbort 是否等待取消信号。
 * @returns 执行器替身。
 * @author zhenghq
 */
function executor(waitForAbort = false): DocumentWorkerExecutor & {
  calls: DocumentWorkerRequestMessage[]
  aborted: number
} {
  return {
    calls: [],
    aborted: 0,
    async execute(message, signal, emit): Promise<void> {
      this.calls.push(message)
      emit({
        version: DOCUMENT_WORKER_PROTOCOL_VERSION,
        type: 'progress',
        jobId: message.jobId,
        generation: message.generation,
        payload: { percent: 50, phase: 'parse', completed: 1, total: 2 }
      })
      if (waitForAbort) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            this.aborted += 1
            resolve()
          }, { once: true })
        })
        return
      }
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
    jobId: 'job-entry-1',
    generation: 1,
    request: { path: '/tmp/document.pdf', generation: 1 }
  }
}

test('worker 入口应把父端口消息交给宿主并回送响应', async () => {
  const port = fakePort()
  const run = executor()
  const dependencies: DocumentWorkerEntryDependencies = {
    createExecutor: () => run
  }
  const stop = startDocumentWorkerEntry(port, dependencies)

  port.emitMessage(runRequest())
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(run.calls.length, 1)
  assert.deepEqual(port.sent.map((message) => message.type), ['progress', 'result'])
  stop()
})

test('worker 入口应对非法消息回送脱敏的 invalid-request 终态', async () => {
  const port = fakePort()
  const run = executor()
  const stop = startDocumentWorkerEntry(port, { createExecutor: () => run })

  port.emitMessage({ version: 999, type: 'run', jobId: 'job-entry-1', generation: 1 })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(run.calls.length, 0)
  assert.equal(port.sent.length, 1)
  assert.equal(port.sent[0]?.type, 'failure')
  if (port.sent[0]?.type === 'failure') {
    assert.equal(port.sent[0].payload.code, 'invalid-request')
    assert.equal(port.sent[0].payload.message.includes('/tmp'), false)
  }
  stop()
})

test('worker 入口清理应注销父端口监听并取消活动任务', async () => {
  const port = fakePort()
  const run = executor(true)
  const stop = startDocumentWorkerEntry(port, { createExecutor: () => run })

  port.emitMessage(runRequest())
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(port.listenerCount(), 1)
  stop()
  stop()

  assert.equal(port.listenerCount(), 0)
  assert.equal(run.aborted, 1)
  port.emitMessage(runRequest())
  assert.equal(run.calls.length, 1)
})

test('worker 纯入口不得静态依赖 Electron 或在导入时自动启动', async () => {
  const source = await readFile('src/main/documentWorkerEntry.ts', 'utf8')

  assert.doesNotMatch(source, /from ['"]electron['"]/u)
  assert.doesNotMatch(source, /import\(['"]electron['"]\)/u)
  assert.doesNotMatch(source, /^runDocumentWorkerEntry\(\)/mu)
  assert.match(source, /export function startDocumentWorkerEntry\(/u)
})
