import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  adaptDocumentWorkerTranslationRpcClientPort,
  startDocumentWorkerProductionEntry,
  type DocumentWorkerProductionEntryDependencies
} from '../src/main/documentWorkerProductionEntry.ts'
import type { DocumentWorkerProductionDependencyOptions } from '../src/main/documentWorkerProductionDependencies.ts'
import { DOCUMENT_PARSER_VERSION } from '../src/shared/documentParserVersion.ts'
import type { DocumentTranslationCacheEntry } from '../src/shared/documentTranslation.ts'
import { normalizeDocumentGlossary } from '../src/shared/settingsDefaults.ts'

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

/**
 * 创建合法 worker 启动选项，供新增生产接线测试复用。
 * @param overrides 需要覆盖的字段。
 * @returns 合法启动选项。
 * @author zhenghq
 */
function validStartOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ocrConcurrency: 2,
    ...overrides
  }
}

/** 创建合法文档翻译缓存条目。 */
const cacheEntry: DocumentTranslationCacheEntry = {
  sourceSha256: 'source-hash',
  translationProtocolVersion: 'document-translation-protocol-v3',
  languagePair: { sourceLang: 'EN', targetLang: 'ZH' },
  glossaryVersion: 'none',
  protectionRulesVersion: 'protection-v1',
  status: 'completed',
  translation: '你好'
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

test('生产入口应接受动态文件、页数与 OCR 图片预算', async () => {
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
      ocrConcurrency: 1,
      maxFileBytes: 2 * 1024 * 1024 * 1024,
      maxPages: 5000,
      maxOcrImages: 2000
    }
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(created, 1)
  stop()
})

test('生产入口应拒绝越界或非整数的动态预算', async () => {
  const invalidBudgets = [
    { maxFileBytes: 0 },
    { maxFileBytes: 2 * 1024 * 1024 * 1024 + 1 },
    { maxFileBytes: 1024.5 },
    { maxPages: 0 },
    { maxPages: 5001 },
    { maxPages: 1.5 },
    { maxOcrImages: 0 },
    { maxOcrImages: 2001 },
    { maxOcrImages: 2.5 }
  ]
  for (const budget of invalidBudgets) {
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
        ocrConcurrency: 1,
        ...budget
      }
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(created, 0, JSON.stringify(budget))
    stop()
  }
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

test('生产入口必须独立解包缓存 RPC、隔离翻译监听并完整清理', async () => {
  const workerPort = port()
  const cacheMessages: unknown[] = []
  const translationMessages: unknown[] = []
  const cleaned: string[] = []
  const stop = startDocumentWorkerProductionEntry(workerPort, {
    createRuntime() {
      return () => cleaned.push('runtime')
    },
    createTranslationRpc(translationPort) {
      translationPort.on('message', (message) => translationMessages.push(message))
      return {
        async translate() {
          return ''
        },
        getModelFingerprint: () => 'model',
        getTranslationConcurrency: () => 1,
        dispose() {
          cleaned.push('translation-rpc')
        }
      }
    },
    createCacheRpc(port) {
      port.on('message', (message) => cacheMessages.push(message))
      return {
        async read() {
          return null
        },
        async write() {
          return true
        },
        dispose() {
          cleaned.push('cache-rpc')
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
    type: 'cache-read-result',
    requestId: 'cache-request',
    responseToken: 'cache-token',
    value: null
  })
  workerPort.emit({
    type: 'translation-result',
    requestId: 'translation-request',
    translation: '你好'
  })

  assert.deepEqual(cacheMessages, [{
    type: 'cache-read-result',
    requestId: 'cache-request',
    responseToken: 'cache-token',
    value: null
  }])
  assert.deepEqual(translationMessages, [{
    type: 'translation-result',
    requestId: 'translation-request',
    translation: '你好'
  }])

  stop()
  stop()
  assert.deepEqual(cleaned, ['runtime', 'cache-rpc', 'translation-rpc'])
  assert.equal(workerPort.listenerCount(), 0)
})

test('生产入口必须把术语表、解析器版本和真实任务缓存键接入生产依赖', async () => {
  const workerPort = port()
  const capturedOptions: DocumentWorkerProductionDependencyOptions[] = []
  const cacheReads: Array<{ jobId: string; generation: number; key: string }> = []
  const cacheWrites: Array<{
    jobId: string
    generation: number
    key: string
    value: DocumentTranslationCacheEntry
  }> = []
  const glossary = {
    ...normalizeDocumentGlossary({
      entries: [{ source: 'hello', target: '你好', sourceLang: 'EN', targetLang: 'ZH' }]
    })
  }
  const stop = startDocumentWorkerProductionEntry(workerPort, {
    createRuntime() {
      return () => undefined
    },
    createCacheRpc() {
      return {
        async read(jobId, generation, key) {
          cacheReads.push({ jobId, generation, key })
          return cacheEntry
        },
        async write(jobId, generation, key, value) {
          cacheWrites.push({ jobId, generation, key, value })
          return true
        },
        dispose() {
          // 本测试只验证缓存依赖接线，清理顺序由上一测试覆盖。
        }
      }
    },
    createProductionDependencies(options) {
      capturedOptions.push(options)
      return {
        async parse() {
          throw new Error('not-used')
        },
        async loadAssetBytes() {
          return null
        },
        async recognizeImage() {
          return { text: '', lines: [], engine: 'system' }
        },
        async translate() {
          return ''
        },
        async loadFontBytes() {
          return null
        },
        async exportPdf() {
          return { bytes: new Uint8Array(), warnings: [] }
        }
      }
    }
  })

  workerPort.emit({
    type: 'worker-start',
    options: validStartOptions({ glossary, parserVersion: 'parser-v9' })
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(capturedOptions.length, 1)
  const options = capturedOptions[0]!
  assert.deepEqual(options.glossary?.(), glossary)
  assert.equal(options.getParserVersion?.(), 'parser-v9')
  assert.deepEqual(
    await options.readTranslationCache?.('job-production', 7, 'cache-key'),
    cacheEntry
  )
  await options.writeTranslationCache?.('job-production', 7, 'cache-key', cacheEntry)
  assert.deepEqual(cacheReads, [{ jobId: 'job-production', generation: 7, key: 'cache-key' }])
  assert.deepEqual(cacheWrites, [{
    jobId: 'job-production',
    generation: 7,
    key: 'cache-key',
    value: cacheEntry
  }])
  stop()
})

test('生产入口未提供解析器版本时必须使用共享默认版本', async () => {
  const workerPort = port()
  const capturedOptions: DocumentWorkerProductionDependencyOptions[] = []
  const stop = startDocumentWorkerProductionEntry(workerPort, {
    createRuntime() {
      return () => undefined
    },
    createProductionDependencies(options) {
      capturedOptions.push(options)
      return {
        async parse() {
          throw new Error('not-used')
        },
        async loadAssetBytes() {
          return null
        },
        async recognizeImage() {
          return { text: '', lines: [], engine: 'system' }
        },
        async translate() {
          return ''
        },
        async loadFontBytes() {
          return null
        },
        async exportPdf() {
          return { bytes: new Uint8Array(), warnings: [] }
        }
      }
    }
  })

  workerPort.emit({ type: 'worker-start', options: validStartOptions() })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(capturedOptions[0]?.getParserVersion?.(), DOCUMENT_PARSER_VERSION)
  stop()
})

test('生产入口必须拒绝未知字段、非法术语表和非法解析器版本', async () => {
  const validGlossary = normalizeDocumentGlossary({
    entries: [{ source: 'hello', target: '你好', sourceLang: 'EN', targetLang: 'ZH' }]
  })
  const invalidOptions: Record<string, unknown>[] = [
    { unexpected: true },
    { glossary: { ...validGlossary, extra: true } },
    { glossary: { ...validGlossary, version: 'glossary-wrong' } },
    { glossary: { ...validGlossary, entries: [{ ...validGlossary.entries[0], extra: true }] } },
    { glossary: { ...validGlossary, entries: [{ ...validGlossary.entries[0], source: ' hello ' }] } },
    { glossary: { ...validGlossary, entries: [{ ...validGlossary.entries[0], source: '' }] } },
    { glossary: { ...validGlossary, entries: [{ ...validGlossary.entries[0], source: 'x'.repeat(257) }] } },
    { glossary: { ...validGlossary, entries: [{ ...validGlossary.entries[0], sourceLang: 'E'.repeat(33) }] } },
    { glossary: { ...validGlossary, entries: Array.from({ length: 501 }, () => validGlossary.entries[0]) } },
    { parserVersion: '' },
    { parserVersion: 'p'.repeat(129) },
    { parserVersion: 1 }
  ]

  for (const invalid of invalidOptions) {
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
      options: validStartOptions({
        glossary: validGlossary,
        ...invalid
      })
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(created, 0, JSON.stringify(invalid))
    stop()
  }
})

test('生产入口必须拒绝启动消息中的未知顶层字段', async () => {
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
    options: validStartOptions(),
    unexpected: true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(created, 0)
  stop()
})

test('生产顶层入口应显式启动运行时且不在导入时自动执行', async () => {
  const source = await readFile('src/main/documentWorkerRuntimeEntry.ts', 'utf8')
  assert.match(source, /startDocumentWorkerProductionEntry/u)
  assert.match(source, /process\.parentPort/u)
  assert.doesNotMatch(source, /from ['"]electron['"]/u)
  assert.doesNotMatch(source, /^startDocumentWorkerProductionEntry\(/mu)
})
