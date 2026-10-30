import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DOCUMENT_WORKER_PROTOCOL_VERSION,
  createDocumentWorkerAssetRequestMessage,
  createDocumentWorkerAssetResultMessage,
  createDocumentWorkerFailureMessage,
  createDocumentWorkerCancelledMessage,
  createDocumentWorkerProgressMessage,
  createDocumentWorkerResultMessage,
  createDocumentWorkerTranslationSnapshotMessage,
  createDocumentWorkerTranslationUpdateMessage,
  isDocumentWorkerAssetResultMessage,
  isDocumentWorkerRequestMessage,
  isDocumentWorkerResponseMessage,
  parseDocumentWorkerAssetResult,
  parseDocumentWorkerResponse,
  parseDocumentWorkerRequest,
  resolveDocumentWorkerErrorCode,
  sanitizeDocumentWorkerError
} from '../src/shared/documentWorkerProtocol.ts'

test('文档 worker 协议应使用固定版本并校验 jobId、generation 与请求类型', () => {
  assert.equal(DOCUMENT_WORKER_PROTOCOL_VERSION, 1)
  assert.equal(parseDocumentWorkerRequest({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'run',
    jobId: 'job-1',
    generation: 1,
    request: { path: '/tmp/sample.pdf', generation: 1 }
  })?.jobId, 'job-1')
  assert.equal(parseDocumentWorkerRequest({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'run',
    jobId: '',
    generation: 1,
    request: { path: '/tmp/sample.pdf', generation: 1 }
  }), null)
  assert.equal(parseDocumentWorkerRequest({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'cancel',
    jobId: 'job-1',
    generation: 0
  }), null)
  assert.equal(isDocumentWorkerRequestMessage({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'cancel',
    jobId: 'job-1',
    generation: 1
  }), true)
})

test('文档 worker 请求必须拒绝伪造协议版本与未知消息类型', () => {
  assert.equal(parseDocumentWorkerRequest({
    version: 2,
    type: 'cancel',
    jobId: 'job-1',
    generation: 1
  }), null)
  assert.equal(parseDocumentWorkerRequest({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'unknown',
    jobId: 'job-1',
    generation: 1
  }), null)
})

test('worker 响应应保留任务代际并区分进度、成功与失败终态', () => {
  const progress = createDocumentWorkerProgressMessage('job-1', 3, {
    percent: 42,
    phase: 'translate',
    completed: 4,
    total: 10
  })
  const result = createDocumentWorkerResultMessage('job-1', 3, {
    status: 'completed',
    percent: 100
  })
  const failure = createDocumentWorkerFailureMessage('job-1', 3, 'parse-failed')

  assert.equal(progress.type, 'progress')
  assert.equal(progress.generation, 3)
  assert.equal(progress.payload.percent, 42)
  assert.equal(result.type, 'result')
  assert.equal(result.generation, 3)
  assert.equal(failure.type, 'failure')
  assert.equal(failure.payload.code, 'parse-failed')
})

test('worker 错误应映射为稳定分类并脱敏路径、正文与原始错误信息', () => {
  assert.equal(resolveDocumentWorkerErrorCode({ code: 'generation-conflict' }), 'generation-conflict')
  assert.equal(resolveDocumentWorkerErrorCode({ name: 'AbortError' }), 'cancelled')
  assert.equal(resolveDocumentWorkerErrorCode(new Error('boom')), 'worker-failed')

  const sanitized = sanitizeDocumentWorkerError(new Error('/Users/alice/private.pdf 内容解析失败'))
  assert.equal(sanitized, 'worker operation failed')
  assert.equal(sanitizeDocumentWorkerError({ code: 'parse-failed', message: 'secret text' }), 'parse failed')
})

test('worker 响应解析应接受四类合法消息并保留任务代际', () => {
  const progress = createDocumentWorkerProgressMessage('job-1', 3, {
    percent: 42,
    phase: 'translate',
    completed: 4,
    total: 10
  })
  const result = createDocumentWorkerResultMessage('job-1', 3, {
    status: 'completed',
    percent: 100,
    retryableTargetIds: []
  })
  const failure = createDocumentWorkerFailureMessage('job-1', 3, 'parse-failed')
  const cancelled = createDocumentWorkerCancelledMessage('job-1', 3)

  assert.deepEqual(parseDocumentWorkerResponse(progress), progress)
  assert.deepEqual(parseDocumentWorkerResponse(result), result)
  assert.deepEqual(parseDocumentWorkerResponse(failure), failure)
  assert.deepEqual(parseDocumentWorkerResponse(cancelled), cancelled)
  assert.equal(isDocumentWorkerResponseMessage(result), true)
})

test('worker 应支持严格校验的块级增量译文消息', () => {
  const block = {
    kind: 'text' as const,
    blockId: 'block-1',
    readingOrder: 0,
    translatable: true,
    role: 'paragraph' as const,
    runs: [{ runId: 'run-1', text: '你好' }]
  }
  const update = createDocumentWorkerTranslationUpdateMessage('job-1', 3, {
    pageId: 'page-1',
    blockId: 'block-1',
    block,
    completed: 1,
    total: 2
  })

  assert.deepEqual(parseDocumentWorkerResponse(update), update)
  assert.equal(isDocumentWorkerResponseMessage(update), true)
})

test('worker 应支持携带完整骨架的翻译快照消息且保持非终态', () => {
  const source = {
    schemaVersion: 1 as const,
    documentId: 'document-1',
    source: {
      path: '/tmp/sample.txt',
      fileName: 'sample.txt',
      format: 'txt' as const,
      sha256: 'fixture',
      size: 5
    },
    metadata: { direction: 'auto' as const },
    pages: [{
      pageId: 'page-1',
      index: 0,
      width: 600,
      height: 800,
      blocks: [{
        kind: 'text' as const,
        blockId: 'block-1',
        readingOrder: 0,
        translatable: true,
        role: 'paragraph' as const,
        runs: [{ runId: 'run-1', text: 'Hello' }]
      }]
    }],
    assets: [],
    warnings: []
  }
  const message = createDocumentWorkerTranslationSnapshotMessage('job-1', 3, {
    source,
    translation: structuredClone(source),
    languageResolution: {
      sourcePreference: 'EN',
      targetPreference: 'ZH',
      languagePair: { sourceLang: 'EN', targetLang: 'ZH' }
    },
    completed: 0,
    total: 1
  })

  assert.deepEqual(parseDocumentWorkerResponse(message), message)
  assert.equal(isDocumentWorkerResponseMessage(message), true)
  assert.equal(message.type, 'translation-snapshot')
})

test('翻译快照消息必须拒绝畸形模型、非法计数和伪造代际', () => {
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
  const valid = createDocumentWorkerTranslationSnapshotMessage('job-1', 1, {
    source,
    translation: structuredClone(source),
    completed: 0,
    total: 1
  })

  assert.equal(parseDocumentWorkerResponse({ ...valid, version: 2 }), null)
  assert.equal(parseDocumentWorkerResponse({ ...valid, generation: 0 }), null)
  assert.equal(parseDocumentWorkerResponse({ ...valid, jobId: '' }), null)
  assert.equal(parseDocumentWorkerResponse({
    ...valid,
    payload: { ...valid.payload, source: { schemaVersion: 1 } }
  }), null)
  assert.equal(parseDocumentWorkerResponse({
    ...valid,
    payload: { ...valid.payload, translation: { schemaVersion: 1 } }
  }), null)
  assert.equal(parseDocumentWorkerResponse({
    ...valid,
    payload: { ...valid.payload, completed: 2, total: 1 }
  }), null)
  assert.equal(parseDocumentWorkerResponse({
    ...valid,
    payload: { ...valid.payload, languageResolution: 'invalid' }
  }), null)
})

test('块级增量译文消息必须拒绝伪造代际、非法标识与非法区块结构', () => {
  const block = {
    kind: 'text',
    blockId: 'block-1',
    readingOrder: 0,
    translatable: true,
    role: 'paragraph',
    runs: [{ runId: 'run-1', text: '你好' }]
  }
  const valid = createDocumentWorkerTranslationUpdateMessage('job-1', 3, {
    pageId: 'page-1',
    blockId: 'block-1',
    block,
    completed: 1,
    total: 2
  })

  assert.equal(parseDocumentWorkerResponse({ ...valid, version: 2 }), null)
  assert.equal(parseDocumentWorkerResponse({ ...valid, generation: 0 }), null)
  assert.equal(parseDocumentWorkerResponse({ ...valid, jobId: '' }), null)
  assert.equal(parseDocumentWorkerResponse({
    ...valid,
    payload: { ...valid.payload, pageId: '../page-1' }
  }), null)
  assert.equal(parseDocumentWorkerResponse({
    ...valid,
    payload: { ...valid.payload, blockId: '' }
  }), null)
  assert.equal(parseDocumentWorkerResponse({
    ...valid,
    payload: { ...valid.payload, block: { kind: 'unknown', blockId: 'block-1' } }
  }), null)
  assert.equal(parseDocumentWorkerResponse({
    ...valid,
    payload: { ...valid.payload, completed: 3, total: 2 }
  }), null)
})

test('块级增量译文消息不得混入资源结果解析器', () => {
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
    total: 1
  })

  assert.equal(parseDocumentWorkerAssetResult(update), null)
})

test('worker 响应解析必须拒绝伪造版本、非法代际和未知类型', () => {
  assert.equal(parseDocumentWorkerResponse({
    version: 2,
    type: 'cancelled',
    jobId: 'job-1',
    generation: 1,
    payload: { code: 'cancelled' }
  }), null)
  assert.equal(parseDocumentWorkerResponse({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'cancelled',
    jobId: 'job-1',
    generation: 0,
    payload: { code: 'cancelled' }
  }), null)
  assert.equal(parseDocumentWorkerResponse({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'unknown',
    jobId: 'job-1',
    generation: 1,
    payload: {}
  }), null)
  assert.equal(isDocumentWorkerResponseMessage({ type: 'progress' }), false)
})

test('worker 运行请求必须保留 OCR 或翻译模式并拒绝未知模式', () => {
  const request = {
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'run',
    jobId: 'job-ocr',
    generation: 2,
    request: {
      path: '/tmp/scan.pdf',
      generation: 2,
      sourceLang: 'auto',
      targetLang: 'ZH',
      mode: 'ocr'
    }
  }
  const parsed = parseDocumentWorkerRequest(request)
  assert.ok(parsed?.type === 'run')
  assert.equal(parsed.request.mode, 'ocr')
  assert.equal(parseDocumentWorkerRequest({
    ...request,
    request: { ...request.request, mode: 'unknown' }
  }), null)
})

test('worker 响应解析必须拒绝畸形进度、终态与载荷', () => {
  const validProgress = createDocumentWorkerProgressMessage('job-1', 1, {
    percent: 20,
    phase: 'parse',
    completed: 1,
    total: 5
  })
  assert.equal(parseDocumentWorkerResponse({
    ...validProgress,
    payload: { ...validProgress.payload, percent: Number.NaN }
  }), null)
  assert.equal(parseDocumentWorkerResponse({
    ...validProgress,
    payload: { ...validProgress.payload, phase: 'unknown' }
  }), null)
  assert.equal(parseDocumentWorkerResponse({
    ...validProgress,
    payload: { ...validProgress.payload, completed: -1 }
  }), null)
  assert.equal(parseDocumentWorkerResponse({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'result',
    jobId: 'job-1',
    generation: 1,
    payload: { status: 'unknown', percent: 100 }
  }), null)
  assert.equal(parseDocumentWorkerResponse({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'failure',
    jobId: 'job-1',
    generation: 1,
    payload: { code: '', message: 'failure' }
  }), null)
  assert.equal(parseDocumentWorkerResponse({
    version: DOCUMENT_WORKER_PROTOCOL_VERSION,
    type: 'cancelled',
    jobId: 'job-1',
    generation: 1,
    payload: { code: 'other' }
  }), null)
})

test('worker 结果响应必须校验文档模型和导出字节', () => {
  const valid = createDocumentWorkerResultMessage('job-1', 1, {
    status: 'completed',
    percent: 100,
    export: {
      bytes: new Uint8Array([1, 2, 3]),
      warnings: []
    }
  })
  const parsed = parseDocumentWorkerResponse(valid)
  assert.ok(parsed?.type === 'result')
  assert.deepEqual(parsed?.payload.export?.bytes, new Uint8Array([1, 2, 3]))

  assert.equal(parseDocumentWorkerResponse({
    ...valid,
    payload: { ...valid.payload, export: { bytes: 'not-bytes', warnings: [] } }
  }), null)
  assert.equal(parseDocumentWorkerResponse({
    ...valid,
    payload: { ...valid.payload, source: { schemaVersion: 1 } }
  }), null)
})

test('worker 资源协议应校验 requestId 与资源标识并区分请求和结果方向', () => {
  const assetRequest = createDocumentWorkerAssetRequestMessage('job-1', 2, 'request-1', 'asset-1')
  const assetResult = createDocumentWorkerAssetResultMessage('job-1', 2, 'request-1', 'asset-1', {
    mimeType: 'image/png',
    bytes: new Uint8Array([1, 2, 3])
  })

  assert.deepEqual(parseDocumentWorkerRequest(assetRequest), assetRequest)
  assert.deepEqual(parseDocumentWorkerAssetResult(assetResult), assetResult)
  assert.equal(isDocumentWorkerAssetResultMessage(assetResult), true)
  assert.equal(isDocumentWorkerRequestMessage(assetResult), false)
  assert.equal(isDocumentWorkerResponseMessage(assetRequest), false)
  assert.equal(isDocumentWorkerResponseMessage(assetResult), false)
})

test('worker 资源协议必须拒绝空标识、路径片段、非法字节和未知错误分类', () => {
  const validRequest = createDocumentWorkerAssetRequestMessage('job-1', 1, 'request-1', 'asset-1')
  for (const assetId of ['', '../asset', 'folder/asset', 'folder\\asset', 'asset\u0000name', 'a'.repeat(129)]) {
    assert.equal(parseDocumentWorkerRequest({ ...validRequest, assetId }), null)
  }
  for (const requestId of ['', '../request', 'request/1', 'a'.repeat(129)]) {
    assert.equal(parseDocumentWorkerRequest({ ...validRequest, requestId }), null)
  }
  assert.equal(parseDocumentWorkerRequest({ ...validRequest, jobId: '' }), null)
  assert.equal(parseDocumentWorkerRequest({ ...validRequest, generation: 0 }), null)

  const validResult = createDocumentWorkerAssetResultMessage('job-1', 1, 'request-1', 'asset-1', {
    bytes: new Uint8Array([1])
  })
  assert.equal(parseDocumentWorkerAssetResult({
    ...validResult,
    requestId: '../request'
  }), null)
  assert.equal(parseDocumentWorkerAssetResult({
    ...validResult,
    assetId: 'folder/asset'
  }), null)
  assert.equal(parseDocumentWorkerAssetResult({
    ...validResult,
    bytes: 'not-bytes'
  }), null)
  assert.equal(parseDocumentWorkerAssetResult({
    ...validResult,
    code: 'unknown-code'
  }), null)
  assert.equal(parseDocumentWorkerAssetResult({
    ...validResult,
    bytes: undefined,
    code: undefined
  }), null)
  assert.equal(parseDocumentWorkerAssetResult({
    ...validResult,
    bytes: undefined,
    code: 'asset-not-found'
  })?.code, 'asset-not-found')
})
