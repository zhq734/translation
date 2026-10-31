import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentWorkerProcess } from '../src/main/documentWorkerClient.ts'
import {
  DocumentWorkerSession,
  type DocumentWorkerSessionDependencies
} from '../src/main/documentWorkerSession.ts'
import type { DocumentWorkerStartOptions } from '../src/main/documentWorkerProductionEntry.ts'
import type { DocumentLanguagePair } from '../src/shared/documentLanguageDirection.ts'
import type { DocumentModel } from '../src/shared/documentTypes.ts'
import {
  createDocumentWorkerAssetRequestMessage,
  createDocumentWorkerAssetResultMessage,
  createDocumentWorkerCancelledMessage,
  createDocumentWorkerExportProgressMessage,
  createDocumentWorkerProgressMessage,
  createDocumentWorkerResultMessage,
  createDocumentWorkerTranslationSnapshotMessage,
  createDocumentWorkerTranslationUpdateMessage,
} from '../src/shared/documentWorkerProtocol.ts'
import type {
  DocumentWorkspaceSnapshot,
  DocumentWorkspaceTranslationUpdate
} from '../src/shared/documentWorkspace.ts'

/**
 * 创建 utility process 替身并记录生命周期。
 * @returns 可注入的进程与消息记录。
 * @author zhenghq
 */
function workerProcess(): DocumentWorkerProcess & {
  sent: unknown[]
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

/**
 * 创建不包含凭据的启动配置。
 * @returns 测试启动配置。
 * @author zhenghq
 */
function startOptions(): DocumentWorkerStartOptions {
  return {
    userDataPath: '/tmp/user-data',
    appPath: '/tmp/app',
    resourcesPath: '/tmp/resources',
    isPackaged: false,
    ocrLang: 'eng',
    ocrEnginePreference: 'system',
    ocrScale: 1,
    ocrTesseractEnabled: false,
    modelFingerprint: 'model-fingerprint',
    translationConcurrency: 2,
    ocrConcurrency: 2
  }
}

/**
 * 创建最小文档模型。
 * @param path 源文件路径。
 * @returns 文档模型。
 * @author zhenghq
 */
function model(path: string): DocumentModel {
  return {
    schemaVersion: 1,
    documentId: 'document-1',
    source: {
      path,
      fileName: 'sample.txt',
      format: 'txt',
      sha256: 'fixture',
      size: 5
    },
    metadata: { direction: 'auto' },
    pages: [{
      pageId: 'page-1',
      index: 0,
      width: 600,
      height: 800,
      blocks: [{
        kind: 'text',
        blockId: 'block-1',
        readingOrder: 0,
        translatable: true,
        role: 'paragraph',
        runs: [{ runId: 'run-1', text: 'Hello' }]
      }]
    }],
    assets: [],
    warnings: []
  }
}

/**
 * 向测试 worker 发送成功终态，供资源与导出生命周期测试复用。
 * @param process worker 进程替身。
 * @param jobId 当前任务标识。
 * @param source 已完成解析的源模型。
 * @returns 无返回值。
 * @author zhenghq
 */
function emitCompletedResult(
  process: ReturnType<typeof workerProcess>,
  jobId: string,
  source: DocumentModel
): void {
  process.emitMessage(createDocumentWorkerResultMessage(jobId, 1, {
    status: 'completed',
    percent: 100,
    source,
    translation: source,
    languageResolution: {
      sourcePreference: 'auto',
      targetPreference: 'auto',
      languagePair: { sourceLang: 'auto', targetLang: 'ZH' }
    },
    completionReport: {
      jobId,
      generation: 1,
      documentId: 'document-1',
      modelFingerprint: 'model-fingerprint',
      status: 'completed',
      total: 1,
      translated: 1,
      unchanged: 0,
      failed: 0,
      pending: 0,
      suspectUntranslated: 0,
      failedTargetIds: [],
      pendingTargetIds: [],
      suspectUntranslatedTargetIds: [],
      failureReasons: {},
      sourcePreference: 'auto',
      targetPreference: 'auto',
      languagePair: { sourceLang: 'auto', targetLang: 'ZH' }
    },
    retryableTargetIds: [],
    runMode: 'translation'
  }))
}

/**
 * 创建 session 依赖并记录事件。
 * @returns 可注入依赖与记录数组。
 * @author zhenghq
 */
function dependencies(process: ReturnType<typeof workerProcess>): {
  dependencies: DocumentWorkerSessionDependencies
  progress: DocumentWorkspaceSnapshot[]
  completed: DocumentWorkspaceSnapshot[]
  written: Array<{ path: string; bytes: Uint8Array }>
  renamed: Array<{ source: string; target: string }>
  unlinked: string[]
  exportProgress: Array<{ jobId: string; generation: number; phase: string; percent: number }>
  openedFolders: string[]
  translated: Array<{ text: string; languagePair: DocumentLanguagePair }>
} {
  const progress: DocumentWorkspaceSnapshot[] = []
  const completed: DocumentWorkspaceSnapshot[] = []
  const written: Array<{ path: string; bytes: Uint8Array }> = []
  const renamed: Array<{ source: string; target: string }> = []
  const unlinked: string[] = []
  const exportProgress: Array<{ jobId: string; generation: number; phase: string; percent: number }> = []
  const openedFolders: string[] = []
  const translated: Array<{ text: string; languagePair: DocumentLanguagePair }> = []
  return {
    progress,
    completed,
    written,
    renamed,
    unlinked,
    exportProgress,
    openedFolders,
    translated,
    dependencies: {
      isApprovedPath: (path) => path === '/tmp/sample.txt',
      createProcess: () => process,
      startOptions: () => startOptions(),
      sendProgress: (snapshot) => progress.push(snapshot),
      sendCompleted: (snapshot) => completed.push(snapshot),
      sendExportProgress: (progressEvent) => exportProgress.push(progressEvent),
      openExportFolder: async (filePath) => openedFolders.push(filePath),
      translate: async (request, _signal, onDelta) => {
        translated.push({ text: request.text, languagePair: request.languagePair })
        onDelta('你')
        return '你好'
      },
      showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/out.pdf' }),
      writeFile: async (path, bytes) => written.push({ path, bytes }),
      rename: async (source, target) => renamed.push({ source, target }),
      unlink: async (path) => unlinked.push(path),
      getAssetBytes: async (assetId) => assetId === 'asset-1'
        ? new Uint8Array([1, 2, 3])
        : null,
      getSourceBytes: async () => ({
        ok: true,
        mimeType: 'text/plain',
        bytes: new Uint8Array([72, 101, 108, 108, 111])
      })
    }
  }
}

test('session 必须 fork documentWorker.js 且只发送一次不含凭据的启动配置', () => {
  const process = workerProcess()
  const fixture = dependencies(process)
  const forked: string[] = []
  const session = new DocumentWorkerSession({
    ...fixture.dependencies,
    createProcess: (path) => {
      forked.push(path)
      return process
    }
  })

  assert.equal(forked.length, 1)
  assert.match(forked[0]!, /documentWorker\.js$/u)
  const startMessages = process.sent.filter((message) => (
    message && typeof message === 'object' && (message as { type?: unknown }).type === 'worker-start'
  ))
  assert.equal(startMessages.length, 1)
  const serialized = JSON.stringify(startMessages[0])
  assert.match(serialized, /model-fingerprint/u)
  assert.doesNotMatch(serialized, /apiKey|token|secret|password|credential/iu)
  session.dispose()
})

test('session 必须转发 run、用冻结语言对执行 RPC，并转换进度与终态快照', async () => {
  const process = workerProcess()
  const fixture = dependencies(process)
  const session = new DocumentWorkerSession(fixture.dependencies)
  const accepted = await session.run({
    path: '/tmp/sample.txt',
    generation: 1,
    sourceLang: 'EN',
    targetLang: 'ZH'
  })
  assert.equal(accepted.accepted, true)
  assert.equal(typeof accepted.jobId, 'string')
  const jobId = accepted.jobId!

  process.emitMessage(createDocumentWorkerProgressMessage(jobId, 1, {
    percent: 42,
    phase: 'translate',
    completed: 2,
    total: 4,
    warningCount: 1
  }))
  assert.equal(fixture.progress.at(-1)?.task.phase, 'translate')
  assert.equal(fixture.progress.at(-1)?.percent, 42)
  assert.equal(fixture.progress.at(-1)?.task.warningCount, 1)

  process.emitMessage({
    type: 'translation-request',
    requestId: 'request-1',
    jobId,
    generation: 1,
    text: 'Hello',
    languagePair: { sourceLang: 'EN', targetLang: 'ZH' }
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(fixture.translated, [{
    text: 'Hello',
    languagePair: { sourceLang: 'EN', targetLang: 'ZH' }
  }])
  assert.deepEqual(process.sent.filter((message) => (
    message && typeof message === 'object' && (message as { type?: unknown }).type === 'translation-result'
  )).map((message) => (message as { translation?: unknown }).translation), ['你好'])

  const source = model('/tmp/sample.txt')
  process.emitMessage(createDocumentWorkerResultMessage(jobId, 1, {
    status: 'completed',
    percent: 100,
    source,
    translation: source,
    languageResolution: {
      sourcePreference: 'EN',
      targetPreference: 'ZH',
      languagePair: { sourceLang: 'EN', targetLang: 'ZH' }
    },
    completionReport: {
      jobId,
      generation: 1,
      documentId: 'document-1',
      modelFingerprint: 'model-fingerprint',
      status: 'completed',
      total: 1,
      translated: 1,
      unchanged: 0,
      failed: 0,
      pending: 0,
      suspectUntranslated: 0,
      failedTargetIds: [],
      pendingTargetIds: [],
      suspectUntranslatedTargetIds: [],
      failureReasons: {},
      sourcePreference: 'EN',
      targetPreference: 'ZH',
      languagePair: { sourceLang: 'EN', targetLang: 'ZH' }
    },
    retryableTargetIds: [],
    runMode: 'translation'
  }))
  assert.equal(fixture.completed.at(-1)?.task.status, 'completed')
  assert.equal(fixture.completed.at(-1)?.source?.documentId, 'document-1')
  assert.deepEqual(fixture.completed.at(-1)?.languagePair, { sourceLang: 'EN', targetLang: 'ZH' })
  session.dispose()
})

test('session 导出必须使用当前完成报告、保存 worker 字节并拒绝部分导出缺少确认', async () => {
  const process = workerProcess()
  const fixture = dependencies(process)
  const session = new DocumentWorkerSession(fixture.dependencies)
  const accepted = await session.run({ path: '/tmp/sample.txt', generation: 1 })
  const jobId = accepted.jobId!
  const source = model('/tmp/sample.txt')
  const completionReport = {
    jobId,
    generation: 1,
    documentId: 'document-1',
    modelFingerprint: 'model-fingerprint',
    status: 'completed' as const,
    total: 1,
    translated: 1,
    unchanged: 0,
    failed: 0,
    pending: 0,
    suspectUntranslated: 0,
    failedTargetIds: [],
    pendingTargetIds: [],
    suspectUntranslatedTargetIds: [],
    failureReasons: {},
    sourcePreference: 'auto',
    targetPreference: 'auto',
    languagePair: { sourceLang: 'auto', targetLang: 'ZH' }
  }
  process.emitMessage(createDocumentWorkerResultMessage(jobId, 1, {
    status: 'completed',
    percent: 100,
    source,
    translation: source,
    languageResolution: {
      sourcePreference: 'auto',
      targetPreference: 'auto',
      languagePair: { sourceLang: 'auto', targetLang: 'ZH' }
    },
    completionReport,
    retryableTargetIds: [],
    runMode: 'translation'
  }))

  const pending = session.exportPdf({
    jobId,
    generation: 1,
    mode: 'complete',
    layout: 'bilingual'
  })
  const exportRequest = process.sent.findLast((message) => (
    message && typeof message === 'object' && (message as { type?: unknown }).type === 'export'
  )) as { request?: { completionReport?: unknown; layout?: unknown } } | undefined
  assert.deepEqual(exportRequest?.request?.completionReport, completionReport)
  assert.equal(exportRequest?.request?.layout, 'bilingual')
  process.emitMessage(createDocumentWorkerResultMessage(jobId, 1, {
    status: 'completed',
    percent: 100,
    export: {
      bytes: new Uint8Array([37, 80, 68, 70]),
      warnings: []
    }
  }))
  assert.deepEqual(await pending, { status: 'saved', filePath: '/tmp/out.pdf' })
  const written = fixture.written[0]
  assert.ok(written)
  assert.match(written.path, /^\/tmp\/out\.pdf\..+\.tmp$/u)
  assert.deepEqual([...written.bytes], [37, 80, 68, 70])
  assert.deepEqual(fixture.renamed, [{ source: written.path, target: '/tmp/out.pdf' }])
  assert.deepEqual(fixture.unlinked, [])
  session.dispose()
})

test('session 必须转发合法导出进度并拒绝旧代际事件', async () => {
  const process = workerProcess()
  const fixture = dependencies(process)
  const session = new DocumentWorkerSession(fixture.dependencies)
  const accepted = await session.run({ path: '/tmp/sample.txt', generation: 1 })
  const jobId = accepted.jobId!
  emitCompletedResult(process, jobId, model('/tmp/sample.txt'))

  const pending = session.exportPdf({ jobId, generation: 1, mode: 'complete' })
  process.emitMessage(createDocumentWorkerExportProgressMessage(jobId, 1, {
    phase: 'composing',
    percent: 40,
    completedPages: 2,
    totalPages: 5,
    warningCount: 1
  }))
  process.emitMessage(createDocumentWorkerExportProgressMessage(jobId, 2, {
    phase: 'writing',
    percent: 90
  }))

  assert.deepEqual(fixture.exportProgress, [{
    jobId,
    generation: 1,
    phase: 'composing',
    percent: 40,
    completedPages: 2,
    totalPages: 5,
    warningCount: 1
  }])
  assert.equal(fixture.completed.at(-1)?.task.status, 'completed')

  process.emitMessage(createDocumentWorkerResultMessage(jobId, 1, {
    status: 'completed',
    percent: 100,
    export: { bytes: new Uint8Array([37, 80, 68, 70]), warnings: [] }
  }))
  assert.equal((await pending).status, 'saved')
  session.dispose()
})

test('session 取消导出必须发送取消请求且不得把已完成任务改成 cancelled', async () => {
  const process = workerProcess()
  const fixture = dependencies(process)
  const session = new DocumentWorkerSession(fixture.dependencies)
  const accepted = await session.run({ path: '/tmp/sample.txt', generation: 1 })
  const jobId = accepted.jobId!
  emitCompletedResult(process, jobId, model('/tmp/sample.txt'))
  const terminal = fixture.completed.at(-1)
  const pending = session.exportPdf({ jobId, generation: 1, mode: 'complete' })

  assert.equal(session.cancelExport(jobId, 1), true)
  const cancelMessage = process.sent.findLast((message) => (
    message && typeof message === 'object' && (message as { type?: unknown }).type === 'cancel'
  ))
  assert.deepEqual(cancelMessage, {
    version: 1,
    type: 'cancel',
    jobId,
    generation: 1
  })
  process.emitMessage(createDocumentWorkerCancelledMessage(jobId, 1))

  assert.deepEqual(await pending, { status: 'cancelled' })
  assert.deepEqual(fixture.completed.at(-1), terminal)
  assert.equal(session.cancelExport(jobId, 2), false)
  session.dispose()
})

test('session 打开导出目录只能使用本会话成功保存的路径', async () => {
  const process = workerProcess()
  const fixture = dependencies(process)
  const session = new DocumentWorkerSession(fixture.dependencies)
  const accepted = await session.run({ path: '/tmp/sample.txt', generation: 1 })
  const jobId = accepted.jobId!
  emitCompletedResult(process, jobId, model('/tmp/sample.txt'))

  assert.equal(await session.openExportFolder(jobId, 1), false)
  const pending = session.exportPdf({ jobId, generation: 1, mode: 'complete' })
  process.emitMessage(createDocumentWorkerResultMessage(jobId, 1, {
    status: 'completed',
    percent: 100,
    export: { bytes: new Uint8Array([37, 80, 68, 70]), warnings: [] }
  }))
  assert.equal((await pending).status, 'saved')
  assert.equal(await session.openExportFolder(jobId, 2), false)
  assert.equal(await session.openExportFolder('unknown-job', 1), false)
  assert.equal(await session.openExportFolder(jobId, 1), true)
  assert.deepEqual(fixture.openedFolders, ['/tmp/out.pdf'])
  session.dispose()
})

test('session 关闭时必须拒绝等待中的资源请求且不留下悬挂 Promise', async () => {
  const process = workerProcess()
  const fixture = dependencies(process)
  const session = new DocumentWorkerSession({
    ...fixture.dependencies,
    getAssetBytes: async () => null
  })
  const accepted = await session.run({ path: '/tmp/sample.txt', generation: 1 })
  const jobId = accepted.jobId!
  const source = model('/tmp/sample.txt')
  source.assets = [{
    assetId: 'asset-1',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'asset-hash',
    byteLength: 3
  }]
  emitCompletedResult(process, jobId, source)

  const pending = session.getAsset('asset-1')
  const assetRequest = process.sent.findLast((message) => (
    message && typeof message === 'object' && (message as { type?: unknown }).type === 'asset-request'
  )) as ReturnType<typeof createDocumentWorkerAssetRequestMessage> | undefined
  assert.ok(assetRequest)
  session.dispose()

  assert.deepEqual(await pending, { ok: false, code: 'asset-unavailable' })
  assert.equal(process.killCalls, 1)
  assert.equal(process.listenerCount(), 0)
})

test('session 关闭时必须拒绝等待中的导出请求', async () => {
  const process = workerProcess()
  const fixture = dependencies(process)
  const session = new DocumentWorkerSession(fixture.dependencies)
  const accepted = await session.run({ path: '/tmp/sample.txt', generation: 1 })
  const jobId = accepted.jobId!
  emitCompletedResult(process, jobId, model('/tmp/sample.txt'))

  const pending = session.exportPdf({ jobId, generation: 1, mode: 'complete' })
  session.dispose()

  assert.deepEqual(await pending, { status: 'rejected', code: 'service-disposed' })
  assert.deepEqual(fixture.written, [])
  assert.deepEqual(fixture.renamed, [])
  assert.deepEqual(fixture.unlinked, [])
})

test('session 保存取消时不得创建或清理临时文件', async () => {
  const process = workerProcess()
  const fixture = dependencies(process)
  const session = new DocumentWorkerSession({
    ...fixture.dependencies,
    showSaveDialog: async () => ({ canceled: true })
  })
  const accepted = await session.run({ path: '/tmp/sample.txt', generation: 1 })
  const jobId = accepted.jobId!
  emitCompletedResult(process, jobId, model('/tmp/sample.txt'))

  const pending = session.exportPdf({ jobId, generation: 1, mode: 'complete' })
  process.emitMessage(createDocumentWorkerResultMessage(jobId, 1, {
    status: 'completed',
    percent: 100,
    export: { bytes: new Uint8Array([37, 80, 68, 70]), warnings: [] }
  }))

  assert.deepEqual(await pending, { status: 'cancelled' })
  assert.deepEqual(fixture.written, [])
  assert.deepEqual(fixture.renamed, [])
  assert.deepEqual(fixture.unlinked, [])
  session.dispose()
})

test('session 原子替换失败时必须清理临时文件并返回稳定错误', async () => {
  const process = workerProcess()
  const fixture = dependencies(process)
  const session = new DocumentWorkerSession({
    ...fixture.dependencies,
    rename: async () => {
      throw new Error('rename failed')
    }
  })
  const accepted = await session.run({ path: '/tmp/sample.txt', generation: 1 })
  const jobId = accepted.jobId!
  emitCompletedResult(process, jobId, model('/tmp/sample.txt'))

  const pending = session.exportPdf({ jobId, generation: 1, mode: 'complete' })
  process.emitMessage(createDocumentWorkerResultMessage(jobId, 1, {
    status: 'completed',
    percent: 100,
    export: { bytes: new Uint8Array([37, 80, 68, 70]), warnings: [] }
  }))

  assert.deepEqual(await pending, { status: 'rejected', code: 'write-failed' })
  assert.equal(fixture.written.length, 1)
  assert.deepEqual(fixture.renamed, [])
  assert.deepEqual(fixture.unlinked, [fixture.written[0]!.path])
  session.dispose()
})

test('session 资源桥接必须拒绝任意资源标识并返回 worker 已登记资源', async () => {
  const process = workerProcess()
  const fixture = dependencies(process)
  const session = new DocumentWorkerSession(fixture.dependencies)
  const accepted = await session.run({ path: '/tmp/sample.txt', generation: 1 })
  const jobId = accepted.jobId!
  const source = model('/tmp/sample.txt')
  source.assets = [{
    assetId: 'asset-1',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'asset-hash',
    byteLength: 3
  }]
  process.emitMessage(createDocumentWorkerResultMessage(jobId, 1, {
    status: 'completed',
    percent: 100,
    source,
    translation: source,
    languageResolution: {
      sourcePreference: 'auto',
      targetPreference: 'auto',
      languagePair: { sourceLang: 'auto', targetLang: 'ZH' }
    },
    completionReport: {
      jobId,
      generation: 1,
      documentId: 'document-1',
      modelFingerprint: 'model-fingerprint',
      status: 'completed',
      total: 1,
      translated: 1,
      unchanged: 0,
      failed: 0,
      pending: 0,
      suspectUntranslated: 0,
      failedTargetIds: [],
      pendingTargetIds: [],
      suspectUntranslatedTargetIds: [],
      failureReasons: {},
      sourcePreference: 'auto',
      targetPreference: 'auto',
      languagePair: { sourceLang: 'auto', targetLang: 'ZH' }
    },
    retryableTargetIds: [],
    runMode: 'translation'
  }))

  const asset = await session.getAsset('asset-1')
  assert.equal(asset.ok, true)
  assert.deepEqual(asset.bytes && [...asset.bytes], [1, 2, 3])
  assert.deepEqual(await session.getAsset('../escape'), { ok: false, code: 'asset-not-found' })
  session.dispose()
})

test('session 资源缓存未命中时应向 worker 请求并只匹配对应 requestId 的结果', async () => {
  const process = workerProcess()
  const fixture = dependencies(process)
  const assetReads: string[] = []
  const session = new DocumentWorkerSession({
    ...fixture.dependencies,
    getAssetBytes: async (assetId) => {
      assetReads.push(assetId)
      return null
    }
  })
  const accepted = await session.run({ path: '/tmp/sample.txt', generation: 1 })
  const jobId = accepted.jobId!
  const source = model('/tmp/sample.txt')
  source.assets = [{
    assetId: 'asset-1',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'asset-hash',
    byteLength: 3
  }]
  process.emitMessage(createDocumentWorkerResultMessage(jobId, 1, {
    status: 'completed',
    percent: 100,
    source,
    translation: source,
    languageResolution: {
      sourcePreference: 'auto',
      targetPreference: 'auto',
      languagePair: { sourceLang: 'auto', targetLang: 'ZH' }
    },
    completionReport: {
      jobId,
      generation: 1,
      documentId: 'document-1',
      modelFingerprint: 'model-fingerprint',
      status: 'completed',
      total: 1,
      translated: 1,
      unchanged: 0,
      failed: 0,
      pending: 0,
      suspectUntranslated: 0,
      failedTargetIds: [],
      pendingTargetIds: [],
      suspectUntranslatedTargetIds: [],
      failureReasons: {},
      sourcePreference: 'auto',
      targetPreference: 'auto',
      languagePair: { sourceLang: 'auto', targetLang: 'ZH' }
    },
    retryableTargetIds: [],
    runMode: 'translation'
  }))

  const pending = session.getAsset('asset-1')
  const assetRequest = process.sent.findLast((message) => (
    message && typeof message === 'object' && (message as { type?: unknown }).type === 'asset-request'
  )) as ReturnType<typeof createDocumentWorkerAssetRequestMessage> | undefined
  assert.ok(assetRequest)
  if (!assetRequest) return
  assert.equal(assetRequest.jobId, jobId)
  assert.equal(assetRequest.generation, 1)
  assert.equal(assetRequest.assetId, 'asset-1')
  assert.equal(typeof assetRequest.requestId, 'string')

  process.emitMessage(createDocumentWorkerAssetResultMessage(
    jobId,
    1,
    'other-request',
    'asset-1',
    { bytes: new Uint8Array([9]) }
  ))
  process.emitMessage(createDocumentWorkerAssetResultMessage(
    jobId,
    1,
    assetRequest.requestId,
    'asset-1',
    { mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }
  ))

  assert.deepEqual(await pending, {
    ok: true,
    mimeType: 'image/png',
    bytes: new Uint8Array([1, 2, 3])
  })
  assert.deepEqual(assetReads, ['asset-1'])
  session.dispose()
})

test('session 资源路径片段不得向 worker 发送请求，资源错误结果返回稳定分类', async () => {
  const process = workerProcess()
  const fixture = dependencies(process)
  const session = new DocumentWorkerSession({
    ...fixture.dependencies,
    getAssetBytes: async () => null
  })
  const accepted = await session.run({ path: '/tmp/sample.txt', generation: 1 })
  const jobId = accepted.jobId!
  const source = model('/tmp/sample.txt')
  source.assets = [{
    assetId: 'asset-1',
    kind: 'image',
    sha256: 'asset-hash',
    byteLength: 1
  }]
  process.emitMessage(createDocumentWorkerResultMessage(jobId, 1, {
    status: 'completed',
    percent: 100,
    source,
    translation: source,
    completionReport: {
      jobId,
      generation: 1,
      documentId: 'document-1',
      modelFingerprint: 'model-fingerprint',
      status: 'completed',
      total: 1,
      translated: 1,
      unchanged: 0,
      failed: 0,
      pending: 0,
      suspectUntranslated: 0,
      failedTargetIds: [],
      pendingTargetIds: [],
      suspectUntranslatedTargetIds: [],
      failureReasons: {},
      sourcePreference: 'auto',
      targetPreference: 'auto',
      languagePair: { sourceLang: 'auto', targetLang: 'ZH' }
    },
    retryableTargetIds: [],
    runMode: 'translation'
  }))
  const sentBefore = process.sent.length
  assert.deepEqual(await session.getAsset('../asset-1'), { ok: false, code: 'asset-not-found' })
  assert.equal(process.sent.length, sentBefore)

  const pending = session.getAsset('asset-1')
  const assetRequest = process.sent.findLast((message) => (
    message && typeof message === 'object' && (message as { type?: unknown }).type === 'asset-request'
  )) as ReturnType<typeof createDocumentWorkerAssetRequestMessage> | undefined
  assert.ok(assetRequest)
  if (!assetRequest) return
  process.emitMessage(createDocumentWorkerAssetResultMessage(
    jobId,
    1,
    assetRequest.requestId,
    'asset-1',
    { code: 'asset-unavailable' }
  ))
  assert.deepEqual(await pending, { ok: false, code: 'asset-unavailable' })
  session.dispose()
})

test('session 取消与清理必须幂等，迟到消息不得覆盖终态', async () => {
  const process = workerProcess()
  const fixture = dependencies(process)
  const session = new DocumentWorkerSession(fixture.dependencies)
  const accepted = await session.run({ path: '/tmp/sample.txt', generation: 1 })
  const jobId = accepted.jobId!
  const source = model('/tmp/sample.txt')
  process.emitMessage(createDocumentWorkerResultMessage(jobId, 1, {
    status: 'failed',
    percent: 20,
    errorCode: 'parse-failed',
    source,
    translation: source,
    languageResolution: {
      sourcePreference: 'auto',
      targetPreference: 'auto',
      languagePair: { sourceLang: 'auto', targetLang: 'ZH' }
    },
    completionReport: {
      jobId,
      generation: 1,
      documentId: 'document-1',
      modelFingerprint: 'model-fingerprint',
      status: 'failed',
      total: 1,
      translated: 0,
      unchanged: 0,
      failed: 1,
      pending: 0,
      suspectUntranslated: 0,
      failedTargetIds: ['target-1'],
      pendingTargetIds: [],
      suspectUntranslatedTargetIds: [],
      failureReasons: { 'target-1': 'translation-failed' },
      sourcePreference: 'auto',
      targetPreference: 'auto',
      languagePair: { sourceLang: 'auto', targetLang: 'ZH' }
    },
    retryableTargetIds: ['target-1'],
    runMode: 'translation'
  }))
  process.emitMessage(createDocumentWorkerProgressMessage(jobId, 1, {
    percent: 90,
    phase: 'translate',
    completed: 9,
    total: 10
  }))
  assert.equal(fixture.completed.at(-1)?.task.status, 'failed')
  assert.equal(fixture.progress.at(-1)?.percent, 0)

  session.dispose()
  session.dispose()
  const progressCount = fixture.progress.length
  const completedCount = fixture.completed.length
  process.emitMessage(createDocumentWorkerProgressMessage(jobId, 1, {
    percent: 100,
    phase: 'export',
    completed: 10,
    total: 10
  }))
  process.emitMessage(createDocumentWorkerResultMessage(jobId, 1, {
    status: 'completed',
    percent: 100
  }))
  assert.equal(fixture.progress.length, progressCount)
  assert.equal(fixture.completed.length, completedCount)
  assert.equal(process.killCalls, 1)
  assert.equal(process.listenerCount(), 0)
})

test('session 必须原位合并当前代际块增量，并让终态完整覆盖增量结果', async () => {
  const process = workerProcess()
  const fixture = dependencies(process)
  const updates: DocumentWorkspaceTranslationUpdate[] = []
  const session = new DocumentWorkerSession({
    ...fixture.dependencies,
    sendTranslationUpdate: (update) => updates.push(update)
  })
  const accepted = await session.run({ path: '/tmp/sample.txt', generation: 1 })
  const jobId = accepted.jobId!
  const source = model('/tmp/sample.txt')

  process.emitMessage(createDocumentWorkerTranslationSnapshotMessage(jobId, 1, {
    source,
    translation: structuredClone(source),
    completed: 0,
    total: 2
  }))

  process.emitMessage(createDocumentWorkerTranslationUpdateMessage(jobId, 1, {
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
  }))

  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.blockId, 'block-1')
  assert.equal(fixture.progress.at(-1)?.translation?.pages[0]?.blocks[0]?.kind, 'text')
  const progressBlock = fixture.progress.at(-1)?.translation?.pages[0]?.blocks[0]
  assert.equal(progressBlock?.kind === 'text' ? progressBlock.runs[0]?.text : undefined, '你好')
  assert.deepEqual(fixture.progress.at(-1)?.task.progress, { completed: 1, total: 2 })

  const terminalTranslation = model('/tmp/sample.txt')
  terminalTranslation.pages[0]!.blocks[0] = {
    kind: 'text',
    blockId: 'block-1',
    readingOrder: 0,
    translatable: true,
    role: 'paragraph',
    runs: [{ runId: 'run-1', text: '最终译文' }]
  }
  process.emitMessage(createDocumentWorkerResultMessage(jobId, 1, {
    status: 'completed',
    percent: 100,
    source,
    translation: terminalTranslation,
    languageResolution: {
      sourcePreference: 'auto',
      targetPreference: 'auto',
      languagePair: { sourceLang: 'auto', targetLang: 'ZH' }
    },
    completionReport: {
      jobId,
      generation: 1,
      documentId: 'document-1',
      modelFingerprint: 'model-fingerprint',
      status: 'completed',
      total: 1,
      translated: 1,
      unchanged: 0,
      failed: 0,
      pending: 0,
      suspectUntranslated: 0,
      failedTargetIds: [],
      pendingTargetIds: [],
      suspectUntranslatedTargetIds: [],
      failureReasons: {},
      sourcePreference: 'auto',
      targetPreference: 'auto',
      languagePair: { sourceLang: 'auto', targetLang: 'ZH' }
    },
    retryableTargetIds: [],
    runMode: 'translation'
  }))
  const completedBlock = fixture.completed.at(-1)?.translation?.pages[0]?.blocks[0]
  assert.equal(completedBlock?.kind === 'text' ? completedBlock.runs[0]?.text : undefined, '最终译文')

  process.emitMessage(createDocumentWorkerTranslationUpdateMessage(jobId, 1, {
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
    completed: 2,
    total: 2
  }))
  assert.equal(updates.length, 1)
  session.dispose()
})

test('session 必须丢弃旧代际、取消后和未知页面的块增量', async () => {
  const process = workerProcess()
  const fixture = dependencies(process)
  const updates: DocumentWorkspaceTranslationUpdate[] = []
  const session = new DocumentWorkerSession({
    ...fixture.dependencies,
    sendTranslationUpdate: (update) => updates.push(update)
  })
  const accepted = await session.run({ path: '/tmp/sample.txt', generation: 1 })
  const jobId = accepted.jobId!
  const source = model('/tmp/sample.txt')
  process.emitMessage(createDocumentWorkerTranslationSnapshotMessage(jobId, 1, {
    source,
    translation: structuredClone(source)
  }))
  const initial = createDocumentWorkerTranslationUpdateMessage(jobId, 1, {
    pageId: 'page-1',
    blockId: 'block-1',
    block: source.pages[0]!.blocks[0]!,
    completed: 1,
    total: 2
  })

  process.emitMessage({ ...initial, generation: 2 })
  process.emitMessage({
    ...initial,
    payload: { ...initial.payload, pageId: 'page-missing' }
  })
  process.emitMessage({
    ...initial,
    payload: { ...initial.payload, blockId: 'block-missing' }
  })
  assert.equal(updates.length, 0)

  assert.equal(session.cancel(jobId, 1), true)
  process.emitMessage(initial)
  assert.equal(updates.length, 0)
  session.dispose()
})

test('session 必须用翻译骨架建立增量基线并保留语言元数据', async () => {
  const process = workerProcess()
  const fixture = dependencies(process)
  const updates: DocumentWorkspaceTranslationUpdate[] = []
  const session = new DocumentWorkerSession({
    ...fixture.dependencies,
    sendTranslationUpdate: (update) => updates.push(update)
  })
  const accepted = await session.run({ path: '/tmp/sample.txt', generation: 1 })
  const jobId = accepted.jobId!
  const source = model('/tmp/sample.txt')

  process.emitMessage(createDocumentWorkerTranslationSnapshotMessage(jobId, 1, {
    source,
    translation: structuredClone(source),
    languageResolution: {
      sourcePreference: 'EN',
      targetPreference: 'ZH',
      languagePair: { sourceLang: 'EN', targetLang: 'ZH' }
    },
    completed: 0,
    total: 1
  }))

  const snapshot = fixture.progress.at(-1)!
  assert.equal(snapshot.source?.documentId, 'document-1')
  assert.equal(snapshot.translation?.pages[0]?.blocks[0]?.blockId, 'block-1')
  assert.deepEqual(snapshot.languagePair, { sourceLang: 'EN', targetLang: 'ZH' })
  assert.equal(snapshot.sourcePreference, 'EN')
  assert.equal(snapshot.targetPreference, 'ZH')
  assert.deepEqual(snapshot.task.progress, { completed: 0, total: 1 })

  process.emitMessage(createDocumentWorkerTranslationUpdateMessage(jobId, 1, {
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
  }))
  assert.equal(updates.length, 1)
  assert.deepEqual(fixture.progress.at(-1)?.task.progress, { completed: 1, total: 1 })
  session.dispose()
})
