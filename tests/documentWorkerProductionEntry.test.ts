import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  adaptDocumentWorkerTranslationRpcClientPort,
  startDocumentWorkerProductionEntry,
  type DocumentWorkerProductionEntryDependencies
} from '../src/main/documentWorkerProductionEntry.ts'

/** 创建最小 worker 父端口替身。 */
function port() {
  const listeners = new Set<(event: { data: unknown }) => void>()
  return {
    sent: [] as unknown[],
    on(_event: 'message', listener: (event: { data: unknown }) => void): void {
      listeners.add(listener)
    },
    off(_event: 'message', listener: (event: { data: unknown }) => void): void {
      listeners.delete(listener)
    },
    postMessage(message: unknown): void {
      this.sent.push(message)
    },
    emit(data: unknown): void {
      for (const listener of listeners) listener({ data })
    },
    listenerCount(): number {
      return listeners.size
    }
  }
}

test('生产入口应等待启动配置后创建依赖并启动 worker', async () => {
  const workerPort = port()
  const created: unknown[] = []
  const stopped: string[] = []
  const dependencies: DocumentWorkerProductionEntryDependencies = {
    createRuntime(dependencies) {
      created.push(dependencies)
      return () => stopped.push('runtime')
    }
  }
  const stop = startDocumentWorkerProductionEntry(workerPort, dependencies)
  assert.equal(created.length, 0)
  assert.equal(workerPort.listenerCount(), 1)

  workerPort.emit({
    type: 'worker-start',
    options: {
      userDataPath: '/tmp/user-data',
      appPath: '/tmp/app',
      resourcesPath: '/tmp/resources',
      isPackaged: false,
      ocrLang: 'eng',
      ocrEnginePreference: 'system',
      ocrScale: 1,
      ocrTesseractEnabled: false,
      modelFingerprint: 'model',
      translationConcurrency: 1,
      ocrConcurrency: 2
    }
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(created.length, 1)
  stop()
  assert.deepEqual(stopped, ['runtime'])
  assert.equal(workerPort.listenerCount(), 0)
})

test('生产入口应拒绝非法启动配置且不回显路径', async () => {
  const workerPort = port()
  let created = 0
  const stop = startDocumentWorkerProductionEntry(workerPort, {
    createRuntime() {
      created += 1
      return () => undefined
    }
  })

  workerPort.emit({
    type: 'worker-start',
    options: { userDataPath: '/private/secret', appPath: '' }
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(created, 0)
  assert.equal(workerPort.sent.length, 1)
  assert.equal(JSON.stringify(workerPort.sent).includes('secret'), false)
  stop()
})

test('生产入口应把 OCR 并发限制在 1 到 4', async () => {
  const valid = [1, 2, 3, 4]
  for (const ocrConcurrency of valid) {
    const workerPort = port()
    let created = 0
    const stop = startDocumentWorkerProductionEntry(workerPort, {
      createRuntime() {
        created += 1
        return () => undefined
      }
    })
    workerPort.emit({
      type: 'worker-start',
      options: {
        userDataPath: '/tmp/user-data',
        appPath: '/tmp/app',
        resourcesPath: '/tmp/resources',
        isPackaged: false,
        ocrLang: 'eng',
        ocrEnginePreference: 'system',
        ocrScale: 1,
        ocrTesseractEnabled: false,
        modelFingerprint: 'model',
        translationConcurrency: 1,
        ocrConcurrency
      }
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(created, 1)
    stop()
  }

  for (const ocrConcurrency of [0, 5, 1.5]) {
    const workerPort = port()
    let created = 0
    const stop = startDocumentWorkerProductionEntry(workerPort, {
      createRuntime() {
        created += 1
        return () => undefined
      }
    })
    workerPort.emit({
      type: 'worker-start',
      options: {
        userDataPath: '/tmp/user-data',
        appPath: '/tmp/app',
        resourcesPath: '/tmp/resources',
        isPackaged: false,
        ocrLang: 'eng',
        ocrEnginePreference: 'system',
        ocrScale: 1,
        ocrTesseractEnabled: false,
        modelFingerprint: 'model',
        translationConcurrency: 1,
        ocrConcurrency
      }
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(created, 0)
    stop()
  }
})

test('生产入口清理时应释放翻译 RPC 客户端', async () => {
  const workerPort = port()
  const stopped: string[] = []
  let disposed = 0
  const stop = startDocumentWorkerProductionEntry(workerPort, {
    createRuntime() {
      return () => stopped.push('runtime')
    },
    createTranslationRpc() {
      return {
        async translate() {
          return ''
        },
        getModelFingerprint: () => 'model',
        getTranslationConcurrency: () => 1,
        dispose() {
          disposed += 1
        }
      }
    }
  })

  workerPort.emit({
    type: 'worker-start',
    options: {
      userDataPath: '/tmp/user-data',
      appPath: '/tmp/app',
      resourcesPath: '/tmp/resources',
      isPackaged: false,
      ocrLang: 'eng',
      ocrEnginePreference: 'system',
      ocrScale: 1,
      ocrTesseractEnabled: false,
      modelFingerprint: 'model',
      translationConcurrency: 1,
      ocrConcurrency: 2
    }
  })
  await new Promise((resolve) => setImmediate(resolve))

  stop()
  stop()
  assert.deepEqual(stopped, ['runtime'])
  assert.equal(disposed, 1)
})

test('翻译 RPC 端口适配器必须解包 utility process 消息事件并可注销同一包装', () => {
  const workerPort = port()
  const received: unknown[] = []
  const adapter = adaptDocumentWorkerTranslationRpcClientPort(workerPort)
  const listener = (message: unknown): void => received.push(message)
  adapter.on('message', listener)

  workerPort.emit({ type: 'translation-result', requestId: 'request-1', translation: '你好' })
  assert.deepEqual(received, [{
    type: 'translation-result',
    requestId: 'request-1',
    translation: '你好'
  }])

  adapter.off('message', listener)
  assert.equal(workerPort.listenerCount(), 0)
  workerPort.emit({ type: 'translation-result', requestId: 'request-2', translation: '迟到' })
  assert.equal(received.length, 1)
})

test('生产入口默认翻译 RPC 必须解包 utility process 消息事件', async () => {
  const workerPort = port()
  const received: unknown[] = []
  let released = 0
  const stop = startDocumentWorkerProductionEntry(workerPort, {
    createRuntime() {
      return () => undefined
    },
    createTranslationRpc(translationPort) {
      translationPort.on('message', (message) => received.push(message))
      return {
        async translate() {
          return ''
        },
        getModelFingerprint: () => 'model',
        getTranslationConcurrency: () => 1,
        dispose() {
          released += 1
        }
      }
    }
  })

  workerPort.emit({
    type: 'worker-start',
    options: {
      userDataPath: '/tmp/user-data',
      appPath: '/tmp/app',
      resourcesPath: '/tmp/resources',
      isPackaged: false,
      ocrLang: 'eng',
      ocrEnginePreference: 'system',
      ocrScale: 1,
      ocrTesseractEnabled: false,
      modelFingerprint: 'model',
      translationConcurrency: 1,
      ocrConcurrency: 2
    }
  })
  await new Promise((resolve) => setImmediate(resolve))
  workerPort.emit({
    type: 'translation-result',
    requestId: 'request-1',
    translation: '你好'
  })

  assert.deepEqual(received.filter((message) => (message as { type?: unknown }).type !== 'worker-start'), [{
    type: 'translation-result',
    requestId: 'request-1',
    translation: '你好'
  }])
  stop()
  assert.equal(released, 1)
  assert.equal(workerPort.listenerCount(), 0)
})

test('生产顶层入口应显式启动运行时且不在导入时自动执行', async () => {
  const source = await readFile('src/main/documentWorkerRuntimeEntry.ts', 'utf8')
  assert.match(source, /startDocumentWorkerProductionEntry/u)
  assert.match(source, /process\.parentPort/u)
  assert.doesNotMatch(source, /from ['"]electron['"]/u)
  assert.doesNotMatch(source, /^startDocumentWorkerProductionEntry\(/mu)
})
