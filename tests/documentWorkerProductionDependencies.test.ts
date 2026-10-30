import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDocumentWorkerProductionDependencies,
  type DocumentWorkerTranslationRpc,
  type DocumentWorkerTranslationRpcRequest
} from '../src/main/documentWorkerProductionDependencies.ts'

/**
 * 创建最小生产依赖选项。
 * @param translationRpc 翻译 RPC 替身。
 * @returns 可创建生产依赖的选项。
 * @author zhenghq
 */
function options(translationRpc: DocumentWorkerTranslationRpc) {
  return {
    userDataPath: '/tmp/document-worker-user-data',
    appPath: '/tmp/document-worker-app',
    resourcesPath: '/tmp/document-worker-resources',
    isPackaged: false,
    ocrLang: 'eng',
    ocrEnginePreference: 'system' as const,
    ocrScale: 1,
    ocrTesseractEnabled: false,
    translationRpc,
    platform: 'darwin' as const,
    isWindows7Runtime: () => false,
    createOcrEngines: () => ({})
  }
}

test('生产依赖应把真实任务上下文、语言对与增量透传到翻译 RPC', async () => {
  const requests: DocumentWorkerTranslationRpcRequest[] = []
  const rpc: DocumentWorkerTranslationRpc = {
    async translate(request, signal, onDelta) {
      requests.push(request)
      assert.equal(signal.aborted, false)
      onDelta('译')
      return '译文'
    },
    getModelFingerprint: () => 'model:test',
    getTranslationConcurrency: () => 3
  }
  const dependencies = createDocumentWorkerProductionDependencies(options(rpc))
  const deltas: string[] = []
  const translation = await dependencies.translate(
    'hello',
    new AbortController().signal,
    { sourceLang: 'EN', targetLang: 'ZH' },
    (delta) => deltas.push(delta),
    { jobId: 'job-production', generation: 9 }
  )

  assert.equal(translation, '译文')
  assert.deepEqual(deltas, ['译'])
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.jobId, 'job-production')
  assert.equal(requests[0]?.generation, 9)
  assert.deepEqual(requests[0]?.languagePair, { sourceLang: 'EN', targetLang: 'ZH' })
  assert.equal(typeof requests[0]?.requestId, 'string')
  assert.ok(requests[0]?.requestId)
})

test('生产依赖应为相同文本在不同任务代际生成不同请求标识', async () => {
  const requestIds: string[] = []
  const rpc: DocumentWorkerTranslationRpc = {
    async translate(request) {
      requestIds.push(request.requestId)
      return '译文'
    },
    getModelFingerprint: () => 'model:test',
    getTranslationConcurrency: () => 1
  }
  const dependencies = createDocumentWorkerProductionDependencies(options(rpc))
  const signal = new AbortController().signal
  const languagePair = { sourceLang: 'EN', targetLang: 'ZH' } as const

  await dependencies.translate('same', signal, languagePair, undefined, { jobId: 'job-a', generation: 1 })
  await dependencies.translate('same', signal, languagePair, undefined, { jobId: 'job-a', generation: 2 })

  assert.equal(new Set(requestIds).size, 2)
})

test('生产依赖应默认以 2 个并发执行文档 OCR', () => {
  const rpc: DocumentWorkerTranslationRpc = {
    async translate() {
      return '译文'
    },
    getModelFingerprint: () => 'model:test',
    getTranslationConcurrency: () => 1
  }
  const dependencies = createDocumentWorkerProductionDependencies(options(rpc))

  assert.equal(dependencies.getOcrConcurrency?.(), 2)
})

test('生产依赖应透传显式文档 OCR 并发配置', () => {
  const rpc: DocumentWorkerTranslationRpc = {
    async translate() {
      return '译文'
    },
    getModelFingerprint: () => 'model:test',
    getTranslationConcurrency: () => 1
  }
  const dependencies = createDocumentWorkerProductionDependencies({
    ...options(rpc),
    ocrConcurrency: 3
  })

  assert.equal(dependencies.getOcrConcurrency?.(), 3)
})
