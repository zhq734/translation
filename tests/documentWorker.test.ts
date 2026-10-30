import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DOCUMENT_WORKER_PROTOCOL_VERSION,
  createDocumentWorkerAssetRequestMessage,
  createDocumentWorkerAssetResultMessage,
  type DocumentWorkerRequestMessage,
  type DocumentWorkerResponseMessage
} from '../src/shared/documentWorkerProtocol.ts'
import {
  DocumentWorkerHost,
  createDocumentWorkerExecutor,
  type DocumentWorkerExecutor,
  type DocumentWorkerProductionDependencies
} from '../src/main/documentWorker.ts'
import { DOCUMENT_MODEL_SCHEMA_VERSION, type DocumentModel } from '../src/shared/documentTypes.ts'

/**
 * 创建测试用 worker 请求。
 * @param jobId 任务标识。
 * @param generation 任务代际。
 * @param type 请求类型。
 * @returns worker 请求消息。
 * @author zhenghq
 */
function request(
  jobId: string,
  generation: number,
  type: DocumentWorkerRequestMessage['type'] = 'run',
  path = '/tmp/sample.txt'
): DocumentWorkerRequestMessage {
  if (type === 'cancel') {
    return {
      version: DOCUMENT_WORKER_PROTOCOL_VERSION,
      type,
      jobId,
      generation
    }
  }
  return {
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type,
    jobId,
    generation,
    request: { path, generation }
  }
}

/**
 * 创建记录请求与取消信号的执行器。
 * @param responses 响应收集数组。
 * @param waitUntilAbort 是否让执行器等待取消信号。
 * @returns 可注入执行器。
 * @author zhenghq
 */
function executor(
  responses: DocumentWorkerResponseMessage[],
  waitUntilAbort = false
): DocumentWorkerExecutor & { calls: number; aborted: number } {
  const result = {
    calls: 0,
    aborted: 0,
    async execute(
      message: DocumentWorkerRequestMessage,
      signal: AbortSignal,
      emit: (response: DocumentWorkerResponseMessage) => void
    ): Promise<void> {
      this.calls += 1
      emit({
        version: DOCUMENT_WORKER_PROTOCOL_VERSION,
        type: 'progress',
        jobId: message.jobId,
        generation: message.generation,
        payload: { percent: 50, phase: 'parse', completed: 1, total: 2 }
      })
      if (waitUntilAbort) {
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
  return result
}

test('worker 宿主应拒绝非法请求且不启动执行器', async () => {
  const responses: DocumentWorkerResponseMessage[] = []
  const run = executor(responses)
  const host = new DocumentWorkerHost(run, (message) => responses.push(message))

  await host.handle({ type: 'cancel', jobId: 'job-1', generation: 1 } as never)

  assert.equal(run.calls, 0)
  assert.equal(responses.length, 1)
  assert.equal(responses[0]?.type, 'failure')
  if (responses[0]?.type === 'failure') {
    assert.equal(responses[0].payload.code, 'invalid-request')
  }
})

test('worker 宿主应只接受匹配当前任务代际的取消请求', async () => {
  const responses: DocumentWorkerResponseMessage[] = []
  const run = executor(responses, true)
  const host = new DocumentWorkerHost(run, (message) => responses.push(message))

  const running = host.handle(request('job-1', 1))
  await new Promise((resolve) => setImmediate(resolve))
  await host.handle(request('job-1', 2, 'cancel'))
  assert.equal(run.aborted, 0)
  await host.handle(request('job-1', 1, 'cancel'))
  await host.handle(request('job-1', 1, 'cancel'))
  await running

  assert.equal(responses.filter((message) => message.type === 'failure').length, 0)
  assert.equal(run.aborted, 1)
  assert.equal(responses.filter((message) => message.type === 'cancelled').length, 1)
})

test('worker 宿主应丢弃旧代际迟到响应并只发送一次终态', async () => {
  const responses: DocumentWorkerResponseMessage[] = []
  let release: (() => void) | undefined
  let started = 0
  const run = {
    calls: 0,
    async execute(
      message: DocumentWorkerRequestMessage,
      _signal: AbortSignal,
      emit: (response: DocumentWorkerResponseMessage) => void
    ): Promise<void> {
      this.calls += 1
      started += 1
      if (started === 1) await new Promise<void>((resolve) => { release = resolve })
      emit({
        version: DOCUMENT_WORKER_PROTOCOL_VERSION,
        type: 'progress',
        jobId: message.jobId,
        generation: message.generation,
        payload: { percent: 90, phase: 'translate', completed: 9, total: 10 }
      })
      emit({
        version: DOCUMENT_WORKER_PROTOCOL_VERSION,
        type: 'result',
        jobId: message.jobId,
        generation: message.generation,
        payload: { status: 'completed', percent: 100 }
      })
    }
  }
  const host = new DocumentWorkerHost(run, (message) => responses.push(message))

  const oldRun = host.handle(request('job-old', 1))
  await new Promise((resolve) => setImmediate(resolve))
  const newRun = host.handle(request('job-new', 2))
  await new Promise((resolve) => setImmediate(resolve))
  release?.()
  await Promise.all([oldRun, newRun])

  assert.equal(responses.filter((message) => message.type === 'progress' && message.jobId === 'job-old').length, 0)
  assert.equal(responses.filter((message) => message.type === 'result' && message.jobId === 'job-old').length, 0)
  assert.equal(responses.filter((message) => message.type === 'result' && message.jobId === 'job-new').length, 1)
})

test('worker 宿主应把执行异常转换为脱敏失败终态', async () => {
  const responses: DocumentWorkerResponseMessage[] = []
  const run: DocumentWorkerExecutor = {
    async execute(): Promise<void> {
      throw new Error('/Users/alice/private.pdf 正文泄露')
    }
  }
  const host = new DocumentWorkerHost(run, (message) => responses.push(message))

  await host.handle(request('job-1', 1))

  assert.equal(responses.length, 1)
  assert.equal(responses[0]?.type, 'failure')
  if (responses[0]?.type === 'failure') {
    assert.equal(responses[0].payload.code, 'worker-failed')
    assert.equal(responses[0].payload.message, 'worker operation failed')
  }
})

/**
 * 创建一个可通过 worker 执行的最小文本文档模型。
 * @param documentId 文档标识。
 * @param text 源文文本。
 * @returns 单页单文本块模型。
 * @author zhenghq
 */
/** 测试期间创建的临时目录，用于满足生产 worker 的真实文件校验。 */
const workerFixtureDirectory = mkdtempSync(join(tmpdir(), 'document-worker-test-'))
process.once('exit', () => rmSync(workerFixtureDirectory, { recursive: true, force: true }))

/**
 * 写入一个可被 worker 识别的最小 TXT 夹具。
 * @param name 夹具文件名前缀。
 * @param text 文件正文。
 * @returns 夹具绝对路径。
 * @author zhenghq
 */
function workerFixture(name: string, text = 'hello'): string {
  const path = join(workerFixtureDirectory, `${name}.txt`)
  writeFileSync(path, text, 'utf8')
  return path
}

/**
 * 创建一个可通过 worker 执行的最小文本文档模型。
 * @param documentId 文档标识。
 * @param text 源文文本。
 * @returns 单页单文本块模型。
 * @author zhenghq
 */
function workerModel(documentId: string, text: string): DocumentModel {
  return {
    schemaVersion: DOCUMENT_MODEL_SCHEMA_VERSION,
    documentId,
    source: {
      path: '/tmp/source.txt',
      fileName: 'source.txt',
      format: 'txt',
      sha256: 'source-hash',
      size: 1
    },
    pages: [{
      pageId: `${documentId}-page`,
      index: 0,
      width: 600,
      height: 800,
      blocks: [{
        blockId: `${documentId}-block`,
        kind: 'text',
        bbox: { x: 20, y: 20, width: 400, height: 40 },
        runs: [{ runId: `${documentId}-run`, text, style: {} }],
        translatable: true
      }]
    }],
    assets: [],
    warnings: [],
    metadata: { title: 'source', direction: 'ltr' }
  }
}

/**
 * 创建生产执行器测试依赖。
 * @param source 解析后的源文档。
 * @param translate 翻译函数。
 * @param exportPdf PDF 导出函数。
 * @returns 可注入依赖。
 * @author zhenghq
 */
function productionDependencies(
  source: DocumentModel,
  translate: DocumentWorkerProductionDependencies['translate'],
  exportPdf: DocumentWorkerProductionDependencies['exportPdf'] = async () => ({
    bytes: new Uint8Array([1, 2, 3]),
    warnings: []
  })
): DocumentWorkerProductionDependencies {
  return {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate,
    loadFontBytes: async () => null,
    exportPdf,
    getModelFingerprint: () => 'provider:test-model',
    getTranslationConcurrency: () => 1
  }
}

/**
 * 创建可观察翻译上下文的生产依赖。
 * @param source 解析后的源文档。
 * @param translate 翻译函数。
 * @returns 可注入依赖。
 * @author zhenghq
 */
function productionDependenciesWithContext(
  source: DocumentModel,
  translate: DocumentWorkerProductionDependencies['translate']
): DocumentWorkerProductionDependencies {
  return productionDependencies(source, translate)
}

/**
 * 创建带一张图片资源的最小文档模型。
 * @param documentId 文档标识。
 * @param text 源文文本。
 * @returns 包含图片区块与资源描述的单页模型。
 * @author zhenghq
 */
function workerModelWithAsset(documentId: string, text: string): DocumentModel {
  const base = workerModel(documentId, text)
  return {
    ...base,
    pages: [{
      ...base.pages[0]!,
      blocks: [
        ...base.pages[0]!.blocks,
        {
          blockId: `${documentId}-image`,
          kind: 'image',
          bbox: { x: 20, y: 80, width: 100, height: 100 },
          assetId: `${documentId}-asset`
        }
      ]
    }],
    assets: [{
      assetId: `${documentId}-asset`,
      kind: 'image',
      mimeType: 'image/png',
      byteLength: 3
    }]
  }
}

test('生产执行器应回传完整终态、语言方向与完成报告', async () => {
  const source = workerModel('doc-complete', 'hello')
  const responses: DocumentWorkerResponseMessage[] = []
  const executor = createDocumentWorkerExecutor(productionDependencies(
    source,
    async (text) => `译:${text}`
  ))

  await executor.execute(request('job-complete', 1, 'run', workerFixture('complete')), new AbortController().signal, (message) => {
    responses.push(message)
  })

  const result = responses.find((message) => message.type === 'result')
  assert.ok(result)
  if (result?.type !== 'result') return
  assert.equal(result.payload.status, 'completed')
  assert.equal(result.payload.source?.documentId, 'doc-complete')
  assert.equal(result.payload.translation?.pages[0]?.blocks[0]?.kind, 'text')
  assert.equal(result.payload.languageResolution?.languagePair.targetLang, 'ZH')
  assert.equal(result.payload.completionReport?.status, 'completed')
  assert.equal(result.payload.percent, 100)
  assert.deepEqual(result.payload.retryableTargetIds, [])
  assert.ok(responses.some((message) => message.type === 'progress'))
})

test('生产执行器应在每个目标成功后发送块级增量消息且终态仍包含完整译文', async () => {
  const source = workerModel('doc-incremental', 'hello')
  const responses: DocumentWorkerResponseMessage[] = []
  const executor = createDocumentWorkerExecutor(productionDependencies(
    source,
    async (text) => `译:${text}`
  ))

  await executor.execute(
    request('job-incremental', 4, 'run', workerFixture('incremental')),
    new AbortController().signal,
    (message) => responses.push(message)
  )

  const snapshotIndex = responses.findIndex((message) => message.type === 'translation-snapshot')
  assert.ok(snapshotIndex >= 0)
  const snapshot = responses[snapshotIndex]
  assert.ok(snapshot && snapshot.type === 'translation-snapshot')
  if (!snapshot || snapshot.type !== 'translation-snapshot') return
  assert.equal(snapshot.jobId, 'job-incremental')
  assert.equal(snapshot.generation, 4)
  assert.equal(snapshot.payload.source.documentId, 'doc-incremental')
  assert.equal(snapshot.payload.translation.documentId, 'doc-incremental')
  assert.equal(snapshot.payload.completed, 0, '首个骨架完成数应为 0')
  assert.equal(snapshot.payload.total, 0, '翻译阶段尚未上报目标数时骨架总数为 0')

  const updates = responses.filter((message) => message.type === 'translation-update')
  assert.ok(updates.length > 0)
  assert.ok(responses.indexOf(updates[0]!) > snapshotIndex, '块增量必须晚于翻译骨架')
  const firstUpdate = updates[0]
  assert.ok(firstUpdate && firstUpdate.type === 'translation-update')
  if (!firstUpdate || firstUpdate.type !== 'translation-update') return
  assert.equal(firstUpdate.jobId, 'job-incremental')
  assert.equal(firstUpdate.generation, 4)
  assert.equal(firstUpdate.payload.pageId, 'doc-incremental-page')
  assert.equal(firstUpdate.payload.blockId, 'doc-incremental-block')
  assert.equal(firstUpdate.payload.block.kind, 'text')
  assert.equal(firstUpdate.payload.block.kind === 'text'
    ? firstUpdate.payload.block.runs[0]?.text
    : undefined, '译:hello')
  assert.equal(firstUpdate.payload.completed, 1)
  assert.equal(firstUpdate.payload.total, 1)

  const result = responses.find((message) => message.type === 'result')
  assert.ok(result && result.type === 'result')
  if (!result || result.type !== 'result') return
  assert.equal(result.payload.translation?.pages[0]?.blocks[0]?.kind, 'text')
  assert.equal(result.payload.translation?.pages[0]?.blocks[0]?.kind === 'text'
    ? result.payload.translation.pages[0].blocks[0].runs[0]?.text
    : undefined, '译:hello')
})

test('worker 宿主必须在终态后丢弃迟到的翻译骨架与块级增量消息', async () => {
  const responses: DocumentWorkerResponseMessage[] = []
  const run: DocumentWorkerExecutor = {
    async execute(_message, _signal, emit): Promise<void> {
      emit({
        version: DOCUMENT_WORKER_PROTOCOL_VERSION,
        type: 'translation-snapshot',
        jobId: 'job-1',
        generation: 1,
        payload: {
          source: workerModel('doc-stale-snapshot', 'hello'),
          translation: workerModel('doc-stale-snapshot', 'hello'),
          completed: 0,
          total: 1
        }
      })
      emit({
        version: DOCUMENT_WORKER_PROTOCOL_VERSION,
        type: 'translation-update',
        jobId: 'job-1',
        generation: 1,
        payload: {
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
          total: 1
        }
      })
      emit({
        version: DOCUMENT_WORKER_PROTOCOL_VERSION,
        type: 'result',
        jobId: 'job-1',
        generation: 1,
        payload: { status: 'completed', percent: 100 }
      })
      emit({
        version: DOCUMENT_WORKER_PROTOCOL_VERSION,
        type: 'translation-snapshot',
        jobId: 'job-1',
        generation: 1,
        payload: {
          source: workerModel('doc-late-snapshot', 'late'),
          translation: workerModel('doc-late-snapshot', 'late'),
          completed: 1,
          total: 1
        }
      })
      emit({
        version: DOCUMENT_WORKER_PROTOCOL_VERSION,
        type: 'translation-update',
        jobId: 'job-1',
        generation: 1,
        payload: {
          pageId: 'page-1',
          blockId: 'block-1',
          block: {
            kind: 'text',
            blockId: 'block-1',
            readingOrder: 0,
            translatable: true,
            role: 'paragraph',
            runs: [{ runId: 'run-1', text: '迟到译文' }]
          },
          completed: 1,
          total: 1
        }
      })
    }
  }
  const host = new DocumentWorkerHost(run, (message) => responses.push(message))

  await host.handle(request('job-1', 1, 'run', workerFixture('stale-update')))

  assert.equal(responses.filter((message) => message.type === 'translation-snapshot').length, 1)
  assert.equal(responses.filter((message) => message.type === 'translation-update').length, 1)
  assert.equal(responses.filter((message) => message.type === 'result').length, 1)
  assert.equal(JSON.stringify(responses).includes('doc-late-snapshot'), false)
  assert.equal(JSON.stringify(responses).includes('迟到译文'), false)
})

test('生产执行器应把真实任务标识和代际传给翻译依赖', async () => {
  const source = workerModel('doc-context', 'hello')
  const calls: Array<{
    text: string
    jobId: string
    generation: number
    sourceLang: string
    targetLang: string
  }> = []
  const executor = createDocumentWorkerExecutor(productionDependenciesWithContext(
    source,
    async (text, _signal, languagePair, _onDelta, context) => {
      calls.push({
        text,
        jobId: context.jobId,
        generation: context.generation,
        sourceLang: languagePair.sourceLang,
        targetLang: languagePair.targetLang
      })
      return `译:${text}`
    }
  ))

  await executor.execute(
    request('job-context', 7, 'run', workerFixture('context')),
    new AbortController().signal,
    () => undefined
  )

  assert.ok(calls.length > 0)
  assert.ok(calls.every((call) => call.jobId === 'job-context' && call.generation === 7))
  assert.ok(calls.every((call) => call.targetLang === 'ZH'))
})

test('生产执行器重试应把新代际传给翻译依赖且保留冻结语言对', async () => {
  const source = workerModel('doc-context-retry', 'hello')
  const calls: Array<{ generation: number; sourceLang: string; targetLang: string }> = []
  let translateCalls = 0
  const executor = createDocumentWorkerExecutor(productionDependenciesWithContext(
    source,
    async (text, _signal, languagePair, _onDelta, context) => {
      calls.push({
        generation: context.generation,
        sourceLang: languagePair.sourceLang,
        targetLang: languagePair.targetLang
      })
      translateCalls += 1
      if (translateCalls === 1) throw new Error('provider failed')
      return `译:${text}`
    }
  ))
  const responses: DocumentWorkerResponseMessage[] = []
  const emit = (message: DocumentWorkerResponseMessage): void => {
    responses.push(message)
  }

  await executor.execute(request('job-context-retry', 2, 'run', workerFixture('context-retry')), new AbortController().signal, emit)
  await executor.execute(request('job-context-retry', 3, 'retry', workerFixture('context-retry')), new AbortController().signal, emit)

  assert.ok(calls.length >= 2)
  assert.equal(calls[0]?.generation, 2)
  assert.ok(calls.slice(1).every((call) => call.generation === 3))
  assert.ok(calls.every((call) => call.sourceLang === calls[0]?.sourceLang))
  assert.ok(calls.every((call) => call.targetLang === calls[0]?.targetLang))
})

test('生产执行器翻译异常不得把原始异常文本写入 worker 终态', async () => {
  const source = workerModel('doc-error', 'hello')
  const responses: DocumentWorkerResponseMessage[] = []
  const executor = createDocumentWorkerExecutor(productionDependencies(source, async () => {
    throw new Error('/private/secret/source.txt provider-token=abc')
  }))

  await executor.execute(request('job-error', 1, 'run', workerFixture('error')), new AbortController().signal, (message) => {
    responses.push(message)
  })

  assert.equal(responses.some((message) => message.type === 'failure'), false)
  assert.equal(responses.some((message) => message.type === 'result'), true)
  assert.equal(JSON.stringify(responses).includes('secret'), false)
})

test('生产执行器重试应复用缓存源文与冻结语言方向且不重新解析或 OCR', async () => {
  const source = workerModel('doc-retry', 'hello')
  let translateCalls = 0
  let parseCalls = 0
  let ocrCalls = 0
  const dependencies = productionDependencies(source, async (text) => {
    translateCalls += 1
    if (translateCalls === 1) throw new Error('provider failed')
    return `译:${text}`
  })
  dependencies.parse = async () => {
    parseCalls += 1
    return source
  }
  dependencies.recognizeImage = async () => {
    ocrCalls += 1
    return { text: '', lines: [], engine: 'system' }
  }
  const executor = createDocumentWorkerExecutor(dependencies)
  const responses: DocumentWorkerResponseMessage[] = []
  const emit = (message: DocumentWorkerResponseMessage): void => {
    responses.push(message)
  }

  await executor.execute(request('job-retry', 1, 'run', workerFixture('retry')), new AbortController().signal, emit)
  const initial = responses.find((message) => message.type === 'result')
  assert.ok(initial && initial.type === 'result')
  if (!initial || initial.type !== 'result') return
  assert.equal(initial.payload.status, 'failed')
  assert.equal(initial.payload.retryableTargetIds?.length, 1)

  await executor.execute(request('job-retry', 2, 'retry', workerFixture('retry')), new AbortController().signal, emit)
  const retryStart = responses.findIndex((message) => message.type === 'result')
  const retrySnapshots = responses
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.type === 'translation-snapshot')
  assert.equal(retrySnapshots.length, 2)
  const retrySnapshot = retrySnapshots.at(-1)
  assert.ok(retrySnapshot && retrySnapshot.index > retryStart)
  if (!retrySnapshot || retrySnapshot.message.type !== 'translation-snapshot') return
  assert.equal(retrySnapshot.message.generation, 2)
  assert.equal(retrySnapshot.message.payload.source.documentId, 'doc-retry')
  assert.equal(retrySnapshot.message.payload.translation.documentId, 'doc-retry')
  assert.deepEqual(retrySnapshot.message.payload.languageResolution?.languagePair, initial.payload.languageResolution?.languagePair)

  const retryUpdateIndex = responses.findIndex((message, index) =>
    index > retrySnapshot.index && message.type === 'translation-update')
  assert.ok(retryUpdateIndex > retrySnapshot.index, '重试块增量必须晚于重试骨架')
  const retried = responses.filter((message) => message.type === 'result').at(-1)
  assert.ok(retried && retried.type === 'result')
  if (!retried || retried.type !== 'result') return
  assert.equal(retried.payload.status, 'completed')
  assert.equal(parseCalls, 1)
  assert.equal(ocrCalls, 0)
  assert.equal(retried.payload.languageResolution?.sourcePreference, initial.payload.languageResolution?.sourcePreference)
  assert.deepEqual(retried.payload.languageResolution?.languagePair, initial.payload.languageResolution?.languagePair)
})

test('生产执行器导出应拒绝旧代际与未确认的部分导出', async () => {
  const source = workerModel('doc-export-gate', 'hello')
  let translateCalls = 0
  let exportCalls = 0
  const executor = createDocumentWorkerExecutor(productionDependencies(
    source,
    async (text) => {
      translateCalls += 1
      if (translateCalls === 1) throw new Error('provider failed')
      return `译:${text}`
    },
    async () => {
      exportCalls += 1
      return { bytes: new Uint8Array([1]), warnings: [] }
    }
  ))
  const responses: DocumentWorkerResponseMessage[] = []
  const emit = (message: DocumentWorkerResponseMessage): void => {
    responses.push(message)
  }
  await executor.execute(request('job-export-gate', 1, 'run', workerFixture('export-gate')), new AbortController().signal, emit)
  const runResult = responses.find((message) => message.type === 'result')
  assert.ok(runResult && runResult.type === 'result')
  if (!runResult || runResult.type !== 'result') return
  assert.equal(runResult.payload.status, 'failed')
  assert.equal(runResult.payload.percent, 100)

  await executor.execute(request('job-export-gate', 2, 'retry', workerFixture('export-gate')), new AbortController().signal, emit)
  const retryResult = responses.filter((message) => message.type === 'result').at(-1)
  assert.ok(retryResult && retryResult.type === 'result')
  if (!retryResult || retryResult.type !== 'result') return
  assert.equal(retryResult.payload.status, 'completed')
  assert.equal(retryResult.payload.percent, 100)

  const exportRequest = (generation: number, mode: 'complete' | 'partial'): DocumentWorkerRequestMessage => ({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'export',
    jobId: 'job-export-gate',
    generation,
    request: {
      mode,
      ...(runResult.payload.completionReport ? { completionReport: runResult.payload.completionReport } : {})
    }
  })
  await assert.rejects(
    executor.execute(exportRequest(1, 'complete'), new AbortController().signal, emit),
    { code: 'completion-mismatch' }
  )
  await assert.rejects(
    executor.execute(exportRequest(2, 'partial'), new AbortController().signal, emit),
    { code: 'partial-export-not-confirmed' }
  )
  assert.equal(exportCalls, 0)
})

test('生产执行器应缓存资源字节并在重试与导出时复用', async () => {
  const source = workerModelWithAsset('doc-asset', 'hello')
  let loadAssetCalls = 0
  const exportAssetBytes: Array<Uint8Array | null> = []
  const dependencies = productionDependencies(
    source,
    async (text) => `译:${text}`,
    async (_model, exportDependencies) => {
      exportAssetBytes.push(await exportDependencies.loadAssetBytes('doc-asset-asset'))
      return { bytes: new Uint8Array([1]), warnings: [] }
    }
  )
  dependencies.loadAssetBytes = async () => {
    loadAssetCalls += 1
    return new Uint8Array([7, 8, 9])
  }
  const executor = createDocumentWorkerExecutor(dependencies)
  const responses: DocumentWorkerResponseMessage[] = []
  const emit = (message: DocumentWorkerResponseMessage): void => {
    responses.push(message)
  }

  await executor.execute(request('job-asset', 1, 'run', workerFixture('asset')), new AbortController().signal, emit)
  const runResult = responses.find((message) => message.type === 'result')
  assert.ok(runResult && runResult.type === 'result')
  if (!runResult || runResult.type !== 'result') return
  assert.equal(loadAssetCalls, 1)

  await executor.execute({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'export',
    jobId: 'job-asset',
    generation: 1,
    request: {
      mode: 'complete',
      ...(runResult.payload.completionReport
        ? { completionReport: runResult.payload.completionReport }
        : {})
    }
  }, new AbortController().signal, emit)

  assert.equal(loadAssetCalls, 1)
  assert.deepEqual(exportAssetBytes, [new Uint8Array([7, 8, 9])])
})

test('OCR 原文 PDF 导出必须把原始 PDF 字节传给导出器', async () => {
  const source = workerModel('doc-ocr-source', 'hello')
  source.source = {
    ...source.source,
    fileName: 'scan.pdf',
    format: 'pdf',
    pageCount: 1
  }
  const pdfBytes = new TextEncoder().encode('%PDF-1.7\n%%EOF')
  const fixturePath = join(workerFixtureDirectory, 'ocr-source.pdf')
  writeFileSync(fixturePath, pdfBytes)
  let exportedSourceBytes: Uint8Array | undefined
  let exportCalls = 0
  const dependencies = productionDependencies(
    source,
    async (text) => `译:${text}`,
    async (_model, exportDependencies) => {
      exportCalls += 1
      exportedSourceBytes = exportDependencies.sourcePdfBytes
      return { bytes: new Uint8Array([1]), warnings: [] }
    }
  )
  const executor = createDocumentWorkerExecutor(dependencies)
  const responses: DocumentWorkerResponseMessage[] = []
  const emit = (message: DocumentWorkerResponseMessage): void => responses.push(message)
  const runMessage: DocumentWorkerRequestMessage = {
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'run',
    jobId: 'job-ocr-source',
    generation: 1,
    request: { path: fixturePath, generation: 1, mode: 'ocr' }
  }

  await executor.execute(runMessage, new AbortController().signal, emit)
  const runResult = responses.find((message) => message.type === 'result')
  assert.ok(runResult && runResult.type === 'result')
  if (!runResult || runResult.type !== 'result') return

  await executor.execute({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'export',
    jobId: 'job-ocr-source',
    generation: 1,
    request: {
      mode: 'complete',
      textLayer: true,
      ...(runResult.payload.completionReport
        ? { completionReport: runResult.payload.completionReport }
        : {})
    }
  }, new AbortController().signal, emit)

  assert.equal(exportCalls, 1)
  assert.deepEqual(exportedSourceBytes, pdfBytes)
})

test('生产执行器必须把 OCR 并发配置传递到文档流水线', async () => {
  const source = workerModel('doc-ocr-concurrency', 'hello')
  const images = Array.from({ length: 4 }, (_, index) => ({
    blockId: `ocr-image-${index + 1}`,
    assetId: `ocr-asset-${index + 1}`
  }))
  source.pages[0]!.blocks = images.map((image, index) => ({
    blockId: image.blockId,
    kind: 'image' as const,
    readingOrder: index,
    bbox: { x: 20, y: 20 + index * 100, width: 100, height: 100 },
    assetId: image.assetId
  }))
  source.assets = images.map((image, index) => ({
    assetId: image.assetId,
    kind: 'image' as const,
    mimeType: 'image/png',
    sha256: `ocr-hash-${index + 1}`,
    byteLength: 3
  }))
  const dependencies = productionDependencies(source, async (text) => `译:${text}`)
  dependencies.getOcrConcurrency = () => 3
  dependencies.loadAssetBytes = async () => new Uint8Array([1, 2, 3])
  let inFlight = 0
  let maxInFlight = 0
  dependencies.recognizeImage = async () => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise<void>((resolve) => setTimeout(resolve, 8))
    inFlight -= 1
    return { text: '图片文字', lines: [], engine: 'system' }
  }
  const responses: DocumentWorkerResponseMessage[] = []
  const executor = createDocumentWorkerExecutor(dependencies)

  await executor.execute(
    request('job-ocr-concurrency', 1, 'run', workerFixture('ocr-concurrency')),
    new AbortController().signal,
    (message) => responses.push(message)
  )

  const result = responses.find((message) => message.type === 'result')
  assert.ok(result && result.type === 'result')
  assert.equal(maxInFlight, 3)
  assert.equal(result.payload.status, 'completed')
})

test('生产执行器应缓存解析器登记的图片资源供导出复用', async () => {
  const source = workerModelWithAsset('doc-registered-asset', 'hello')
  const exportAssetBytes: Array<Uint8Array | null> = []
  const dependencies = productionDependencies(
    source,
    async (text) => `译:${text}`,
    async (_model, exportDependencies) => {
      exportAssetBytes.push(await exportDependencies.loadAssetBytes('doc-registered-asset-asset'))
      return { bytes: new Uint8Array([1]), warnings: [] }
    }
  )
  dependencies.parse = async (_input, _signal, registerAssetBytes) => {
    registerAssetBytes?.('doc-registered-asset-asset', new Uint8Array([4, 5, 6]))
    return source
  }
  const executor = createDocumentWorkerExecutor(dependencies)
  const responses: DocumentWorkerResponseMessage[] = []
  const emit = (message: DocumentWorkerResponseMessage): void => {
    responses.push(message)
  }

  await executor.execute(request('job-registered-asset', 1, 'run', workerFixture('registered-asset')), new AbortController().signal, emit)
  const runResult = responses.find((message) => message.type === 'result')
  assert.ok(runResult && runResult.type === 'result')
  if (!runResult || runResult.type !== 'result') return

  await executor.execute({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'export',
    jobId: 'job-registered-asset',
    generation: 1,
    request: {
      mode: 'complete',
      ...(runResult.payload.completionReport
        ? { completionReport: runResult.payload.completionReport }
        : {})
    }
  }, new AbortController().signal, emit)

  assert.deepEqual(exportAssetBytes, [new Uint8Array([4, 5, 6])])
})

test('生产执行器部分导出应保留未完成目标原文并返回 PDF 字节', async () => {
  const source = workerModel('doc-partial', 'hello')
  let translateCalls = 0
  const executor = createDocumentWorkerExecutor(productionDependencies(
    source,
    async (text) => {
      translateCalls += 1
      if (translateCalls === 1) throw new Error('provider failed')
      return `译:${text}`
    },
    async (model) => ({
      bytes: new TextEncoder().encode(JSON.stringify(model.pages[0]?.blocks[0])),
      warnings: []
    })
  ))
  const responses: DocumentWorkerResponseMessage[] = []
  const emit = (message: DocumentWorkerResponseMessage): void => {
    responses.push(message)
  }
  await executor.execute(request('job-partial', 1, 'run', workerFixture('partial')), new AbortController().signal, emit)
  const runResult = responses.find((message) => message.type === 'result')
  assert.ok(runResult && runResult.type === 'result')
  if (!runResult || runResult.type !== 'result') return
  const report = runResult.payload.completionReport
  assert.ok(report)
  if (!report) return
  assert.equal(report.status, 'failed')

  await executor.execute({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'export',
    jobId: 'job-partial',
    generation: 1,
    request: {
      mode: 'partial',
      completionReport: report,
      confirmPartialExport: true
    }
  }, new AbortController().signal, emit)
  const exported = responses.filter((message) => message.type === 'result').at(-1)
  assert.ok(exported && exported.type === 'result')
  if (!exported || exported.type !== 'result') return
  assert.ok(exported.payload.export?.bytes)
  assert.equal(new TextDecoder().decode(exported.payload.export?.bytes), JSON.stringify({
    blockId: 'doc-partial-block',
    kind: 'text',
    bbox: { x: 20, y: 20, width: 400, height: 40 },
    runs: [{ runId: 'doc-partial-run', text: 'hello', style: {} }],
    translatable: true
  }))
  assert.equal(exported.payload.export?.partial?.reverted, 1)
})

test('worker 宿主应独立读取当前任务已声明资源且不启动新的执行任务', async () => {
  const responses: DocumentWorkerResponseMessage[] = []
  const source = workerModelWithAsset('doc-host-asset', 'hello')
  let executeCalls = 0
  let readCalls = 0
  const executor: DocumentWorkerExecutor = {
    async execute(message, _signal, emit) {
      executeCalls += 1
      emit({
        version: DOCUMENT_WORKER_PROTOCOL_VERSION,
        type: 'result',
        jobId: message.jobId,
        generation: message.generation,
        payload: {
          status: 'completed',
          percent: 100,
          source,
          translation: source
        }
      })
    },
    async readAsset(jobId, generation, assetId) {
      readCalls += 1
      assert.equal(jobId, 'job-host-asset')
      assert.equal(generation, 1)
      assert.equal(assetId, 'doc-host-asset-asset')
      return { ok: true, mimeType: 'image/png', bytes: new Uint8Array([4, 5, 6]) }
    }
  }
  const host = new DocumentWorkerHost(executor, (message) => responses.push(message))

  await host.handle(request('job-host-asset', 1, 'run', workerFixture('host-asset')))
  await host.handle(createDocumentWorkerAssetRequestMessage(
    'job-host-asset',
    1,
    'asset-request-1',
    'doc-host-asset-asset'
  ))

  assert.equal(executeCalls, 1)
  assert.equal(readCalls, 1)
  const assetResult = responses.find((message) => message.type === 'asset-result')
  assert.ok(assetResult && assetResult.type === 'asset-result')
  if (!assetResult || assetResult.type !== 'asset-result') return
  assert.equal(assetResult.requestId, 'asset-request-1')
  assert.deepEqual(assetResult.bytes, new Uint8Array([4, 5, 6]))
})

test('worker 宿主应忽略资源结果并拒绝非当前代际或未声明的资源请求', async () => {
  const responses: DocumentWorkerResponseMessage[] = []
  const source = workerModelWithAsset('doc-host-asset-gate', 'hello')
  let readCalls = 0
  const executor: DocumentWorkerExecutor = {
    async execute(message, _signal, emit) {
      emit({
        version: DOCUMENT_WORKER_PROTOCOL_VERSION,
        type: 'result',
        jobId: message.jobId,
        generation: message.generation,
        payload: { status: 'completed', percent: 100, source, translation: source }
      })
    },
    async readAsset(_jobId, _generation, assetId) {
      readCalls += 1
      assert.equal(assetId, 'doc-host-asset-gate-asset')
      return { ok: true, bytes: new Uint8Array([7]) }
    }
  }
  const host = new DocumentWorkerHost(executor, (message) => responses.push(message))
  await host.handle(request('job-host-asset-gate', 1, 'run', workerFixture('host-asset-gate')))

  await host.handle(createDocumentWorkerAssetRequestMessage(
    'job-host-asset-gate',
    2,
    'asset-request-2',
    'doc-host-asset-gate-asset'
  ))
  await host.handle(createDocumentWorkerAssetRequestMessage(
    'job-host-asset-gate',
    1,
    'asset-request-3',
    'not-declared'
  ))
  await host.handle(createDocumentWorkerAssetResultMessage(
    'job-host-asset-gate',
    1,
    'asset-request-1',
    'doc-host-asset-gate-asset',
    { bytes: new Uint8Array([1]) }
  ))

  assert.equal(readCalls, 0)
  const assetResults = responses.filter((message) => message.type === 'asset-result')
  assert.equal(assetResults.length, 2)
  assert.ok(assetResults.every((message) => message.type === 'asset-result' && message.code === 'asset-not-found'))
  assert.equal(responses.some((message) => message.type === 'failure'), false)
  assert.equal(responses.filter((message) => message.type === 'result').length, 1)
})
