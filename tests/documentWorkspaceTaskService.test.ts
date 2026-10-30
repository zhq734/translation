import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import {
  DocumentWorkspaceTaskService,
  type DocumentWorkspaceTaskServiceDependencies
} from '../src/main/documentWorkspaceTaskService.ts'
import type { DocumentLanguagePair } from '../src/shared/documentLanguageDirection.ts'
import type { DocumentModel } from '../src/shared/documentTypes.ts'
import type {
  DocumentExportRequest,
  DocumentWorkspaceSnapshot,
  DocumentWorkspaceTranslationUpdate
} from '../src/shared/documentWorkspace.ts'

/**
 * 创建测试用文档模型。
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
 * 构造任务服务依赖。
 * @param path 已批准文件路径。
 * @param events 进度快照收集数组。
 * @returns 测试依赖。
 * @author zhenghq
 */
function dependencies(path: string, events: DocumentWorkspaceSnapshot[]): DocumentWorkspaceTaskServiceDependencies {
  return {
    isApprovedPath: (candidate) => candidate === path,
    sendProgress: (snapshot) => events.push(snapshot),
    sendCompleted: (snapshot) => events.push(snapshot),
    showSaveDialog: async () => ({ canceled: false, filePath: join(tmpdir(), 'translated.pdf') }),
    writeFile: async () => undefined,
    rename: async () => undefined,
    unlink: async () => undefined,
    parse: async () => model(path),
    translate: async (text) => `译:${text}`,
    recognizeImage: async () => ({ text: 'OCR', lines: [], engine: 'system' }),
    loadAssetBytes: async () => null,
    loadFontBytes: async () => new Uint8Array([1, 2, 3]),
    exportPdf: async () => ({ bytes: new Uint8Array([37, 80, 68, 70]), warnings: [] })
  }
}

/**
 * 等待任务推送终态快照，避免依赖固定延时造成竞态。
 * @param events 已收集的进度快照。
 * @param generation 需要匹配的任务代际；省略时匹配任意代际。
 * @returns 终态快照。
 * @author zhenghq
 */
async function waitForTerminal(
  events: DocumentWorkspaceSnapshot[],
  generation?: number
): Promise<DocumentWorkspaceSnapshot> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const terminal = events.findLast((event) => (
      (generation === undefined || event.generation === generation) && (
        event.task.status === 'completed' ||
        event.task.status === 'partial' ||
        event.task.status === 'cancelled' ||
        event.task.status === 'failed'
      )
    ))
    if (terminal) return terminal
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for document task')
}

/**
 * 构造与终态快照同代际的导出请求。
 * @param terminal 当前终态快照。
 * @param mode 完整或部分导出模式。
 * @returns 受控导出请求。
 * @author zhenghq
 */
function exportRequest(
  terminal: DocumentWorkspaceSnapshot,
  mode: DocumentExportRequest['mode']
): DocumentExportRequest {
  return {
    jobId: terminal.jobId,
    generation: terminal.generation,
    mode
  }
}

test('任务服务必须重新校验已批准路径并推送完成快照', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  const service = new DocumentWorkspaceTaskService(dependencies(path, events))
  try {
    const accepted = await service.run({ path, generation: 1 })
    assert.equal(accepted.accepted, true)
    assert.equal(typeof accepted.jobId, 'string')
    const completed = await waitForTerminal(events)
    assert.equal(completed.task.status, 'completed')
    assert.equal(completed.percent, 100)
    assert.equal(completed.sourcePreference, 'auto')
    assert.equal(completed.targetPreference, 'auto')
    assert.deepEqual(completed.languagePair, { sourceLang: 'auto', targetLang: 'ZH' })
    assert.equal(completed.translation?.pages[0]?.blocks[0]?.kind, 'text')
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务必须在首条进度发出前通知 jobId 已可登记', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  const deps = dependencies(path, events)
  const acceptedJobIds: string[] = []
  let progressBeforeAccepted = false
  deps.sendProgress = (snapshot) => {
    progressBeforeAccepted ||= !acceptedJobIds.includes(snapshot.jobId)
    events.push(snapshot)
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    const accepted = await service.run(
      { path, generation: 1 },
      (jobId) => acceptedJobIds.push(jobId)
    )
    assert.equal(accepted.accepted, true)
    assert.equal(acceptedJobIds.length, 1)
    assert.equal(acceptedJobIds[0], accepted.jobId)
    assert.equal(progressBeforeAccepted, false)
    await waitForTerminal(events)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('图片资源进度到达时任务必须已完成登记并可立即读取图片', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'clear.png')
  const imageBytes = new Uint8Array(await readFile('tests/fixtures/ocr-scaling/clear.png'))
  await writeFile(path, imageBytes)
  const events: DocumentWorkspaceSnapshot[] = []
  const deps = dependencies(path, events)
  let acceptedJobId: string | null = null
  let progressBeforeAccepted = false
  let assetResult: Awaited<ReturnType<DocumentWorkspaceTaskService['getAsset']>> | null = null
  let service: DocumentWorkspaceTaskService
  deps.parse = async (_input, registerAssetBytes) => {
    registerAssetBytes?.('asset-1', imageBytes)
    const source = model(path)
    source.source = {
      ...source.source,
      fileName: 'clear.png',
      format: 'image',
      size: imageBytes.byteLength
    }
    source.pages[0]!.blocks = [{
      kind: 'image',
      blockId: 'image-1',
      readingOrder: 0,
      translatable: false,
      assetId: 'asset-1',
      bbox: { x: 0, y: 0, width: 600, height: 800 }
    }]
    source.assets = [{
      assetId: 'asset-1',
      kind: 'image',
      mimeType: 'image/png',
      sha256: 'fixture',
      byteLength: imageBytes.byteLength
    }]
    return source
  }
  deps.loadAssetBytes = async () => imageBytes
  deps.sendProgress = (snapshot) => {
    events.push(snapshot)
    if (!snapshot.source?.assets.some((asset) => asset.assetId === 'asset-1') || assetResult) return
    progressBeforeAccepted ||= acceptedJobId !== snapshot.jobId
    // 模拟 Renderer 收到带图片声明的首条快照后立即按 jobId 请求资源。
    assetResult = service.getAsset('asset-1')
  }
  service = new DocumentWorkspaceTaskService(deps)
  try {
    const accepted = await service.run(
      { path, generation: 1 },
      (jobId) => { acceptedJobId = jobId }
    )
    assert.equal(accepted.accepted, true)
    const completed = await waitForTerminal(events)
    assert.equal(completed.task.status, 'completed')
    assert.equal(progressBeforeAccepted, false)
    assert.ok(assetResult)
    const asset = await assetResult
    assert.equal(asset.ok, true)
    assert.equal(asset.mimeType, 'image/png')
    assert.deepEqual(asset.bytes, imageBytes)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务重新翻译失败项时不得重新解析或重跑已成功内容', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  const deps = dependencies(path, events)
  let parseCalls = 0
  let retrying = false
  const translatedTexts: string[] = []
  const languagePairs: DocumentLanguagePair[] = []
  deps.parse = async () => {
    parseCalls += 1
    return model(path)
  }
  deps.translate = async (text, _signal, _request, languagePair) => {
    translatedTexts.push(text)
    languagePairs.push(languagePair)
    if (!retrying) throw new Error('provider failed')
    return `译:${text}`
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const failed = await waitForTerminal(events)
    // 没有成功译文时任务必须保持 failed，不能仅因存在可重试目标而伪装成 partial。
    assert.equal(failed.task.status, 'failed')
    assert.equal(failed.retryableFailedBlocks, 1)
    assert.equal(failed.completionReport?.status, 'failed')
    assert.equal(failed.completionReport?.jobId, failed.jobId)
    assert.equal(failed.completionReport?.generation, 1)
    assert.equal(failed.completionReport?.documentId, 'document-1')
    assert.equal(failed.completionReport?.total, 1)
    assert.deepEqual(failed.completionReport?.failedTargetIds, ['0:0:text:run-1'])
    assert.deepEqual(await service.getHistory(), [{
      jobId: failed.jobId,
      generation: 1,
      completionReport: failed.completionReport
    }])
    const frozenPair = failed.languagePair
    assert.deepEqual(frozenPair, { sourceLang: 'auto', targetLang: 'ZH' })

    retrying = true
    translatedTexts.length = 0
    const accepted = await service.retryFailed(2)
    assert.equal(accepted.accepted, true)
    const completed = await waitForTerminal(events, 2)
    assert.equal(completed.task.status, 'completed')
    assert.equal(completed.task.generation, 2)
    assert.equal(completed.retryableFailedBlocks ?? 0, 0)
    assert.equal(completed.completionReport?.status, 'completed')
    assert.equal(completed.completionReport?.jobId, failed.jobId)
    assert.equal(completed.completionReport?.generation, 2)
    assert.equal(completed.completionReport?.total, 1)
    assert.equal(completed.completionReport?.translated, 1)
    assert.deepEqual(completed.completionReport?.failedTargetIds, [])
    assert.deepEqual(await service.getHistory(), [{
      jobId: failed.jobId,
      generation: 2,
      completionReport: completed.completionReport
    }])
    assert.equal(parseCalls, 1)
    assert.deepEqual(translatedTexts, ['Hello'])
    assert.deepEqual(completed.languagePair, frozenPair)
    assert.equal(languagePairs[0], frozenPair)
    assert.equal(languagePairs[1], frozenPair)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务在部分成功时保持 partial 并记录完整完成报告', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  const deps = dependencies(path, events)
  deps.parse = async () => ({
    ...model(path),
    pages: [{
      ...model(path).pages[0]!,
      blocks: [
        ...model(path).pages[0]!.blocks,
        {
          kind: 'text',
          blockId: 'block-2',
          readingOrder: 1,
          translatable: true,
          role: 'paragraph',
          runs: [{ runId: 'run-2', text: 'World' }]
        }
      ]
    }]
  })
  deps.translate = async (text) => {
    if (text.includes('World')) throw new Error('provider failed')
    return `译:${text}`
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const partial = await waitForTerminal(events)
    assert.equal(partial.task.status, 'partial')
    assert.equal(partial.retryableFailedBlocks, 1)
    assert.equal(partial.completionReport?.status, 'partial')
    assert.equal(partial.completionReport?.translated, 1)
    assert.equal(partial.completionReport?.failed, 1)
    assert.deepEqual(partial.completionReport?.failedTargetIds, ['0:1:text:run-2'])
    assert.deepEqual(await service.getHistory(), [{
      jobId: partial.jobId,
      generation: 1,
      completionReport: partial.completionReport
    }])
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务必须从完成报告派生重试集合，不能因失败块字段缺失而拒绝重试', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  const deps = dependencies(path, events)
  let retrying = false
  const translatedTexts: string[] = []
  deps.parse = async () => ({
    ...model(path),
    pages: [{
      ...model(path).pages[0]!,
      blocks: [
        ...model(path).pages[0]!.blocks,
        {
          kind: 'text',
          blockId: 'block-2',
          readingOrder: 1,
          translatable: true,
          role: 'paragraph',
          runs: [{ runId: 'run-2', text: 'World' }]
        }
      ]
    }]
  })
  deps.translate = async (text) => {
    translatedTexts.push(text)
    if (!retrying && text.includes('World')) throw new Error('provider failed')
    return `译:${text}`
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const partial = await waitForTerminal(events)
    assert.equal(partial.task.status, 'partial')
    assert.equal(partial.completionReport?.failed, 1)
    assert.equal(partial.retryableFailedBlocks, 1)

    // 模拟旧版或迟到状态只保留完成报告、丢失冗余重试集合；服务仍应以报告为唯一真相。
    const internal = service as unknown as {
      active: { retryableTargetIds: string[]; failedTargetIds: string[] } | null
    }
    assert.ok(internal.active)
    internal.active.retryableTargetIds = []
    internal.active.failedTargetIds = []

    retrying = true
    translatedTexts.length = 0
    const accepted = service.retryFailed(2)
    assert.equal(accepted.accepted, true)
    const completed = await waitForTerminal(events, 2)
    assert.equal(completed.task.status, 'completed')
    assert.deepEqual(translatedTexts, ['World'])
    assert.equal(completed.retryableFailedBlocks ?? 0, 0)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务快照必须以同代际完成报告校正矛盾状态并允许重新翻译未完成目标', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  const deps = dependencies(path, events)
  let retrying = false
  deps.parse = async () => ({
    ...model(path),
    pages: [{
      ...model(path).pages[0]!,
      blocks: [
        ...model(path).pages[0]!.blocks,
        {
          kind: 'text',
          blockId: 'block-2',
          readingOrder: 1,
          translatable: true,
          role: 'paragraph',
          runs: [{ runId: 'run-2', text: 'World' }]
        }
      ]
    }]
  })
  deps.translate = async (text) => {
    if (!retrying && text.includes('World')) throw new Error('provider failed')
    return `译:${text}`
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const partial = await waitForTerminal(events)
    assert.equal(partial.task.status, 'partial')
    const active = service as unknown as {
      active?: { task: { status: string } }
    }
    assert.ok(active.active)
    // 模拟迟到的 completed 状态覆盖任务状态，但同代际完成报告仍明确为 partial。
    active.active.task = { ...active.active.task, status: 'completed' }
    const snapshot = (service as unknown as {
      snapshot: (job: NonNullable<typeof active.active>, task: typeof active.active.task) => DocumentWorkspaceSnapshot
    }).snapshot(active.active, active.active.task)
    assert.equal(snapshot.completionReport?.status, 'partial')
    assert.equal(snapshot.task.status, 'partial')

    retrying = true
    const accepted = service.retryFailed(2)
    assert.equal(accepted.accepted, true)
    const completed = await waitForTerminal(events, 2)
    assert.equal(completed.task.status, 'completed')
    assert.equal(completed.completionReport?.status, 'completed')
    assert.equal(completed.retryableFailedBlocks ?? 0, 0)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务必须同时重新翻译失败和疑似未翻译目标并恢复完成状态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  const deps = dependencies(path, events)
  const suspectTexts = Array.from({ length: 16 }, (_, index) =>
    `This is untranslated paragraph ${index + 1} with enough English words.`)
  const source = model(path)
  deps.parse = async () => ({
    ...source,
    pages: [{
      ...source.pages[0]!,
      blocks: [
        ...source.pages[0]!.blocks,
        {
          kind: 'text',
          blockId: 'block-2',
          readingOrder: 1,
          translatable: true,
          role: 'paragraph',
          runs: [{ runId: 'run-2', text: 'Install the application' }]
        },
        ...suspectTexts.map((text, index): DocumentModel['pages'][number]['blocks'][number] => ({
          kind: 'text',
          blockId: `block-suspect-${index + 1}`,
          readingOrder: index + 2,
          translatable: true,
          role: 'paragraph',
          runs: [{ runId: `run-suspect-${index + 1}`, text }]
        }))
      ]
    }]
  })
  let retrying = false
  const translatedTexts: string[] = []
  /**
   * 模拟翻译提供方按合并协议返回译文，保留分段标记并逐段输出中文。
   * @param text 单段原文或带分段标记的合并请求。
   * @returns 保留协议标记的翻译结果。
   * @author zhenghq
   */
  const translateFixtureText = (text: string): string => text
    .split(/(\[\[\[\s*ST-SEG-\d+\s*\]\]\])/u)
    .map((part) => {
      if (/^\[\[\[\s*ST-SEG-\d+\s*\]\]\]$/u.test(part) || !part.trim()) return part
      const leading = /^\s*/u.exec(part)?.[0] ?? ''
      const trailing = /\s*$/u.exec(part)?.[0] ?? ''
      const source = part.slice(leading.length, part.length - trailing.length)
      if (source.startsWith('Install the application')) return `${leading}安装这个应用程序${trailing}`
      if (source.startsWith('This is untranslated paragraph')) {
        return `${leading}这是一段已经完成翻译的中文说明，内容完整且不再包含长段英文原文。${trailing}`
      }
      return `${leading}译:${source}${trailing}`
    })
    .join('')
  deps.translate = async (text) => {
    translatedTexts.push(text)
    if (!retrying) {
      if (text.includes('Install the application')) throw new Error('provider failed')
      if (text.startsWith('This is untranslated paragraph')) return text
    }
    return translateFixtureText(text)
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const partial = await waitForTerminal(events)
    assert.equal(partial.task.status, 'partial')
    assert.equal(partial.completionReport?.failed, 1)
    assert.equal(partial.completionReport?.suspectUntranslated, 16)
    assert.equal(partial.retryableFailedBlocks, 17)

    retrying = true
    translatedTexts.length = 0
    const accepted = service.retryFailed(2)
    assert.equal(accepted.accepted, true)
    const completed = await waitForTerminal(events, 2)
    assert.equal(completed.task.status, 'completed')
    assert.equal(completed.completionReport?.status, 'completed')
    assert.equal(completed.completionReport?.failed, 0)
    assert.equal(completed.completionReport?.suspectUntranslated, 0)
    const retriedText = translatedTexts.join('\n')
    assert.equal(retriedText.includes('Install the application'), true)
    assert.equal(retriedText.includes('This is untranslated paragraph 16'), true)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务仅允许 completed 任务执行完整导出', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  let saveDialogCalls = 0
  let exportCalls = 0
  let writeCalls = 0
  const deps = dependencies(path, events)
  deps.showSaveDialog = async () => {
    saveDialogCalls += 1
    return { canceled: false, filePath: join(directory, 'out.pdf') }
  }
  deps.exportPdf = async () => {
    exportCalls += 1
    return { bytes: new Uint8Array([37, 80, 68, 70]), warnings: [] }
  }
  deps.writeFile = async () => {
    writeCalls += 1
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const completed = await waitForTerminal(events)

    assert.equal(completed.task.status, 'completed')
    assert.equal(completed.completionReport?.status, 'completed')
    assert.deepEqual(
      await service.exportPdf(exportRequest(completed, 'complete')),
      { status: 'saved' }
    )
    assert.equal(saveDialogCalls, 1)
    assert.equal(exportCalls, 1)
    assert.equal(writeCalls, 1)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('普通译文导出不得被识别为 OCR 原文专用导出', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  let exportedSourceOnly: boolean | undefined
  const deps = dependencies(path, events)
  deps.exportPdf = async (_model, _dependencies, _partialExport, _textLayer, sourceOnly) => {
    exportedSourceOnly = sourceOnly
    return { bytes: new Uint8Array([37, 80, 68, 70]), warnings: [] }
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const completed = await waitForTerminal(events)
    assert.deepEqual(
      await service.exportPdf(exportRequest(completed, 'complete')),
      { status: 'saved' }
    )
    assert.equal(exportedSourceOnly, false)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务必须拒绝未确认的部分导出且不得打开保存对话框或写文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  let saveDialogCalls = 0
  let exportCalls = 0
  let writeCalls = 0
  const deps = dependencies(path, events)
  deps.parse = async () => ({
    ...model(path),
    pages: [{
      ...model(path).pages[0]!,
      blocks: [
        ...model(path).pages[0]!.blocks,
        {
          kind: 'text',
          blockId: 'block-2',
          readingOrder: 1,
          translatable: true,
          role: 'paragraph',
          runs: [{ runId: 'run-2', text: 'World' }]
        }
      ]
    }]
  })
  deps.translate = async (text) => {
    if (text.includes('World')) throw new Error('provider failed')
    return `译:${text}`
  }
  deps.showSaveDialog = async () => {
    saveDialogCalls += 1
    return { canceled: false, filePath: join(directory, 'out.pdf') }
  }
  deps.exportPdf = async () => {
    exportCalls += 1
    return { bytes: new Uint8Array([37, 80, 68, 70]), warnings: [] }
  }
  deps.writeFile = async () => {
    writeCalls += 1
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const partial = await waitForTerminal(events)

    assert.equal(partial.task.status, 'partial')
    assert.deepEqual(
      await service.exportPdf(exportRequest(partial, 'complete')),
      { status: 'rejected', code: 'partial-export-not-confirmed' }
    )
    assert.equal(saveDialogCalls, 0)
    assert.equal(exportCalls, 0)
    assert.equal(writeCalls, 0)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务允许已确认的 partial 任务导出部分结果', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  const deps = dependencies(path, events)
  let exportedModel: DocumentModel | undefined
  deps.parse = async () => ({
    ...model(path),
    pages: [{
      ...model(path).pages[0]!,
      blocks: [
        ...model(path).pages[0]!.blocks,
        {
          kind: 'text',
          blockId: 'block-2',
          readingOrder: 1,
          translatable: true,
          role: 'paragraph',
          runs: [{ runId: 'run-2', text: 'World' }]
        }
      ]
    }]
  })
  deps.translate = async (text) => {
    if (text.includes('World')) throw new Error('provider failed')
    return `译:${text}`
  }
  deps.exportPdf = async (exported) => {
    exportedModel = exported
    return { bytes: new Uint8Array([37, 80, 68, 70]), warnings: [] }
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const partial = await waitForTerminal(events)

    assert.equal(partial.task.status, 'partial')
    assert.deepEqual(
      await service.exportPdf(exportRequest(partial, 'partial')),
      { status: 'saved' }
    )
    const exportedBlocks = exportedModel?.pages[0]?.blocks
    assert.equal(exportedBlocks?.[0]?.kind, 'text')
    assert.equal(exportedBlocks?.[1]?.kind, 'text')
    if (exportedBlocks?.[0]?.kind !== 'text' || exportedBlocks[1]?.kind !== 'text') return
    assert.equal(exportedBlocks[0].runs[0]?.text, '译:Hello')
    assert.equal(exportedBlocks[1].runs[0]?.text, 'World')
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务必须在打开保存框前拒绝与源模型不一致的完成报告', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  let saveDialogCalls = 0
  let exportCalls = 0
  let writeCalls = 0
  const deps = dependencies(path, events)
  deps.parse = async () => ({
    ...model(path),
    pages: [{
      ...model(path).pages[0]!,
      blocks: [
        ...model(path).pages[0]!.blocks,
        {
          kind: 'text',
          blockId: 'block-2',
          readingOrder: 1,
          translatable: true,
          role: 'paragraph',
          runs: [{ runId: 'run-2', text: 'World' }]
        }
      ]
    }]
  })
  deps.translate = async (text) => `译:${text}`
  deps.showSaveDialog = async () => {
    saveDialogCalls += 1
    return { canceled: false, filePath: join(directory, 'out.pdf') }
  }
  deps.exportPdf = async () => {
    exportCalls += 1
    return { bytes: new Uint8Array([37, 80, 68, 70]), warnings: [] }
  }
  deps.writeFile = async () => {
    writeCalls += 1
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const completed = await waitForTerminal(events)
    const report = completed.completionReport
    assert.ok(report)
    const active = service as unknown as {
      active?: { completionReport?: typeof report }
    }
    assert.ok(active.active)
    active.active.completionReport = {
      ...report,
      total: report.total + 1,
      translated: report.translated + 1
    }

    assert.deepEqual(
      await service.exportPdf(exportRequest(completed, 'complete')),
      { status: 'rejected', code: 'completion-mismatch' }
    )
    assert.equal(saveDialogCalls, 0)
    assert.equal(exportCalls, 0)
    assert.equal(writeCalls, 0)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务必须拒绝状态为 completed 但报告仍含失败目标的完整导出', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  let saveDialogCalls = 0
  let exportCalls = 0
  let writeCalls = 0
  const deps = dependencies(path, events)
  deps.showSaveDialog = async () => {
    saveDialogCalls += 1
    return { canceled: false, filePath: join(directory, 'out.pdf') }
  }
  deps.exportPdf = async () => {
    exportCalls += 1
    return { bytes: new Uint8Array([37, 80, 68, 70]), warnings: [] }
  }
  deps.writeFile = async () => {
    writeCalls += 1
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const completed = await waitForTerminal(events)
    const report = completed.completionReport
    assert.ok(report)
    const active = service as unknown as {
      active?: { completionReport?: typeof report }
    }
    assert.ok(active.active)
    // 计数保持自洽，仅让 completed 状态与失败计数发生语义冲突。
    active.active.completionReport = {
      ...report,
      status: 'completed',
      translated: 0,
      unchanged: 0,
      failed: 1,
      pending: 0,
      suspectUntranslated: 0,
      failedTargetIds: ['0:0'],
      pendingTargetIds: [],
      suspectUntranslatedTargetIds: [],
      failureReasons: { '0:0': 'translation-failed' }
    }

    assert.deepEqual(
      await service.exportPdf(exportRequest(completed, 'complete')),
      { status: 'rejected', code: 'completion-mismatch' }
    )
    assert.equal(saveDialogCalls, 0)
    assert.equal(exportCalls, 0)
    assert.equal(writeCalls, 0)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务禁止无可用译文的 failed 任务导出', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  let saveDialogCalls = 0
  let exportCalls = 0
  let writeCalls = 0
  const deps = dependencies(path, events)
  deps.translate = async () => {
    throw new Error('provider failed')
  }
  deps.showSaveDialog = async () => {
    saveDialogCalls += 1
    return { canceled: false, filePath: join(directory, 'out.pdf') }
  }
  deps.exportPdf = async () => {
    exportCalls += 1
    return { bytes: new Uint8Array([37, 80, 68, 70]), warnings: [] }
  }
  deps.writeFile = async () => {
    writeCalls += 1
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const failed = await waitForTerminal(events)

    assert.equal(failed.task.status, 'failed')
    assert.equal(failed.completionReport?.translated, 0)
    assert.deepEqual(
      await service.exportPdf(exportRequest(failed, 'partial')),
      { status: 'rejected', code: 'not-ready' }
    )
    assert.equal(saveDialogCalls, 0)
    assert.equal(exportCalls, 0)
    assert.equal(writeCalls, 0)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务拒绝旧任务和旧代际的导出请求', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  let saveDialogCalls = 0
  const deps = dependencies(path, events)
  deps.showSaveDialog = async () => {
    saveDialogCalls += 1
    return { canceled: true }
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const completed = await waitForTerminal(events)

    assert.deepEqual(
      await service.exportPdf({ ...exportRequest(completed, 'complete'), jobId: 'job-old' }),
      { status: 'rejected', code: 'completion-mismatch' }
    )
    assert.deepEqual(
      await service.exportPdf({ ...exportRequest(completed, 'complete'), generation: 0 }),
      { status: 'rejected', code: 'invalid-request' }
    )
    assert.deepEqual(
      await service.exportPdf({ ...exportRequest(completed, 'complete'), generation: 2 }),
      { status: 'rejected', code: 'completion-mismatch' }
    )

    assert.equal(saveDialogCalls, 0)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务必须在导出前复验模型指纹并拒绝已切换的翻译模型', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  let fingerprint = 'provider-a'
  let saveDialogCalls = 0
  let exportCalls = 0
  let writeCalls = 0
  const deps = dependencies(path, events)
  deps.getModelFingerprint = () => fingerprint
  deps.showSaveDialog = async () => {
    saveDialogCalls += 1
    return { canceled: false, filePath: join(directory, 'out.pdf') }
  }
  deps.exportPdf = async () => {
    exportCalls += 1
    return { bytes: new Uint8Array([37, 80, 68, 70]), warnings: [] }
  }
  deps.writeFile = async () => {
    writeCalls += 1
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const completed = await waitForTerminal(events)
    assert.equal(completed.completionReport?.modelFingerprint, 'provider-a')

    fingerprint = 'provider-b'
    assert.deepEqual(
      await service.exportPdf(exportRequest(completed, 'complete')),
      { status: 'rejected', code: 'completion-mismatch' }
    )
    assert.equal(saveDialogCalls, 0)
    assert.equal(exportCalls, 0)
    assert.equal(writeCalls, 0)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('部分导出文件名和打印摘要必须明确包含回退原文数量', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  let suggestedName = ''
  let partialSummary: Parameters<NonNullable<DocumentWorkspaceTaskServiceDependencies['exportPdf']>>[2]
  const deps = dependencies(path, events)
  deps.parse = async () => ({
    ...model(path),
    pages: [{
      ...model(path).pages[0]!,
      blocks: [
        ...model(path).pages[0]!.blocks,
        {
          kind: 'text',
          blockId: 'block-2',
          readingOrder: 1,
          translatable: true,
          role: 'paragraph',
          runs: [{ runId: 'run-2', text: 'World' }]
        }
      ]
    }]
  })
  deps.translate = async (text) => {
    if (text.includes('World')) throw new Error('provider failed')
    return `译:${text}`
  }
  deps.showSaveDialog = async (name) => {
    suggestedName = name
    return { canceled: true }
  }
  deps.exportPdf = async (_model, _dependencies, summary) => {
    partialSummary = summary
    return { bytes: new Uint8Array([37, 80, 68, 70]), warnings: [] }
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const partial = await waitForTerminal(events)
    assert.equal(partial.task.status, 'partial')
    assert.deepEqual(
      await service.exportPdf(exportRequest(partial, 'partial')),
      { status: 'cancelled' }
    )
    assert.match(suggestedName, /sample-partial-1-reverted-translated\.pdf$/u)
    assert.equal(partialSummary, undefined)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务拒绝非法导出模式', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  const service = new DocumentWorkspaceTaskService(dependencies(path, events))
  try {
    await service.run({ path, generation: 1 })
    const completed = await waitForTerminal(events)
    assert.deepEqual(
      await service.exportPdf({
        ...exportRequest(completed, 'complete'),
        mode: 'unknown' as DocumentExportRequest['mode']
      }),
      { status: 'rejected', code: 'invalid-request' }
    )
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务必须在文件翻译完成前推送中间译文快照', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  let releaseFirst: (() => void) | null = null
  const deps = dependencies(path, events)
  deps.translate = async (text, signal, _request, languagePair, onDelta) => {
    assert.equal(typeof onDelta, 'function', '文件翻译必须接收流式增量回调')
    assert.deepEqual(languagePair, { sourceLang: 'auto', targetLang: 'ZH' })
    onDelta?.('译')
    if (text === 'Hello') {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
        signal.addEventListener('abort', resolve, { once: true })
      })
    }
    return `译:${text}`
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const deadline = Date.now() + 2000
    const hasIntermediateTranslation = (event: DocumentWorkspaceSnapshot): boolean => (
      event.translation?.pages[0]?.blocks[0]?.kind === 'text' &&
      event.translation.pages[0].blocks[0].runs[0]?.text === '译' &&
      !['completed', 'partial', 'cancelled', 'failed'].includes(event.task.status)
    )
    while (!events.some((event) => hasIntermediateTranslation(event)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(events.some((event) => hasIntermediateTranslation(event)), true)
    releaseFirst?.()
    const completed = await waitForTerminal(events)
    assert.equal(completed.task.status, 'completed')
    assert.equal(
      (completed.translation!.pages[0]!.blocks[0] as { runs: Array<{ text: string }> }).runs[0]!.text,
      '译:Hello'
    )
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务必须把页面翻译并发配置传递给文档翻译流水线', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  const deps = dependencies(path, events)
  deps.getTranslationConcurrency = () => 5
  let active = 0
  let maxActive = 0
  const source = model(path)
  // 300 个短目标会按每批 50 个形成 6 批，足以区分配置并发 5 与默认并发 3。
  source.pages[0]!.blocks = Array.from({ length: 300 }, (_, index) => ({
    kind: 'text' as const,
    blockId: `block-${index}`,
    readingOrder: index,
    translatable: true,
    role: 'paragraph' as const,
    runs: [{ runId: `run-${index}`, text: `text-${index}` }]
  }))
  deps.parse = async () => source
  deps.translate = async (text) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 10))
    active -= 1
    return text.includes('ST-SEG') ? text : `译:${text}`
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const completed = await waitForTerminal(events)
    assert.equal(completed.task.status, 'completed')
    // 六批同时排队，页面翻译配置的并发上限 5 必须完整传递到文档流水线。
    assert.equal(maxActive, 5)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务必须把 OCR 并发配置传递给文档翻译流水线', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  const deps = dependencies(path, events)
  const source = model(path)
  const images = Array.from({ length: 4 }, (_, index) => ({
    blockId: `ocr-image-${index + 1}`,
    assetId: `ocr-asset-${index + 1}`
  }))
  source.pages[0]!.blocks = images.map((image, index) => ({
    kind: 'image' as const,
    blockId: image.blockId,
    readingOrder: index,
    translatable: false,
    assetId: image.assetId,
    bbox: { x: 20, y: 20 + index * 100, width: 100, height: 100 }
  }))
  source.assets = images.map((image, index) => ({
    assetId: image.assetId,
    kind: 'image' as const,
    mimeType: 'image/png',
    sha256: `ocr-hash-${index + 1}`,
    byteLength: 3
  }))
  deps.parse = async () => source
  deps.loadAssetBytes = async () => new Uint8Array([1, 2, 3])
  deps.getOcrConcurrency = () => 3
  let inFlight = 0
  let maxInFlight = 0
  deps.recognizeImage = async () => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise<void>((resolve) => setTimeout(resolve, 8))
    inFlight -= 1
    return { text: '图片文字', lines: [], engine: 'system' }
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const completed = await waitForTerminal(events)
    assert.equal(completed.task.status, 'completed')
    assert.equal(maxInFlight, 3)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务启动校验必须识别正文条目位于 8KB 之后的 DOCX', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'late-document.docx')
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file('word/media/filler.bin', new Uint8Array(20 * 1024))
  zip.file('word/document.xml', '<w:document/>')
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' })
  await writeFile(path, bytes)
  const events: DocumentWorkspaceSnapshot[] = []
  const deps = dependencies(path, events)
  deps.parse = async () => ({
    ...model(path),
    source: {
      ...model(path).source,
      fileName: 'late-document.docx',
      format: 'docx',
      size: bytes.byteLength
    }
  })
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    const accepted = await service.run({ path, generation: 1 })
    assert.equal(accepted.accepted, true)
    const completed = await waitForTerminal(events)
    assert.equal(completed.task.status, 'completed')
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务必须拒绝未批准路径、代际冲突和文件变更', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  const service = new DocumentWorkspaceTaskService(dependencies(path, events))
  try {
    assert.deepEqual(await service.run({ path: join(directory, 'other.txt'), generation: 1 }), {
      accepted: false,
      code: 'path-not-approved'
    })
    const first = await service.run({ path, generation: 1 })
    const second = await service.run({ path, generation: 1 })
    assert.equal(first.accepted, true)
    assert.deepEqual(second, {
      accepted: false,
      code: 'generation-conflict',
      suggestedGeneration: 2
    })
    await waitForTerminal(events)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务启动期间同代际重复请求必须返回 busy 而不是重复解析', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  const deps = dependencies(path, events)
  let releaseRead: (() => void) | null = null
  let parseCalls = 0
  deps.parse = async () => {
    parseCalls += 1
    await new Promise<void>((resolve) => { releaseRead = resolve })
    return model(path)
  }
  const originalStat = deps.isApprovedPath
  let statStarted: (() => void) | null = null
  const statStartedPromise = new Promise<void>((resolve) => { statStarted = resolve })
  deps.isApprovedPath = (candidate) => {
    statStarted?.()
    return originalStat(candidate)
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    const firstPromise = service.run({ path, generation: 2 })
    // 首个 run 已通过路径批准检查但尚未完成异步文件读取时，再发起同代际重复点击。
    await statStartedPromise
    const duplicate = await service.run({ path, generation: 2 })
    assert.deepEqual(duplicate, { accepted: false, code: 'busy' })
    const first = await firstPromise
    assert.equal(first.accepted, true)
    releaseRead?.()
    await waitForTerminal(events)
    assert.equal(parseCalls, 1)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务取消后必须停止推送成功完成并保留 cancelled 状态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  let releaseTranslation: (() => void) | null = null
  const deps = dependencies(path, events)
  deps.translate = async (text, signal) => {
    await new Promise<void>((resolve) => {
      releaseTranslation = resolve
      signal.addEventListener('abort', resolve, { once: true })
    })
    return text
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    const accepted = await service.run({ path, generation: 1 })
    assert.equal(accepted.accepted, true)
    service.cancel(accepted.jobId!, 1)
    releaseTranslation?.()
    const completed = await waitForTerminal(events)
    assert.equal(completed.task.status, 'cancelled')
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务关闭后必须取消一次且不再转发迟到的进度、终态与块增量', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  const updates: DocumentWorkspaceTranslationUpdate[] = []
  let releaseTranslation: (() => void) | null = null
  let translateSignal: AbortSignal | undefined
  const deps = dependencies(path, events)
  deps.sendTranslationUpdate = (update) => updates.push(update)
  deps.translate = async (text, signal) => {
    translateSignal = signal
    await new Promise<void>((resolve) => {
      releaseTranslation = resolve
      signal.addEventListener('abort', resolve, { once: true })
    })
    return `译:${text}`
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    const accepted = await service.run({ path, generation: 1 })
    assert.equal(accepted.accepted, true)
    const deadline = Date.now() + 2000
    while (!translateSignal && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(translateSignal)
    const beforeDispose = events.length

    service.dispose()
    service.dispose()
    releaseTranslation?.()
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.equal(translateSignal?.aborted, true)
    assert.equal(events.length, beforeDispose)
    assert.deepEqual(updates, [])
    assert.deepEqual(await service.getAsset('asset-1'), { ok: false, code: 'asset-not-found' })
    assert.deepEqual(await service.getSource(), { ok: false, code: 'source-not-found' })
    assert.deepEqual(await service.exportPdf({
      jobId: accepted.jobId!,
      generation: 1,
      mode: 'complete'
    }), { status: 'rejected', code: 'service-disposed' })
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务 PDF 导出必须原子替换目标文件且不残留临时文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  const output = join(directory, 'out.pdf')
  await writeFile(path, 'Hello')
  await writeFile(output, 'original')
  const events: DocumentWorkspaceSnapshot[] = []
  const deps = dependencies(path, events)
  deps.showSaveDialog = async () => ({ canceled: false, filePath: output })
  deps.writeFile = async (target, bytes) => writeFile(target, bytes)
  deps.rename = async (source, target) => rename(source, target)
  deps.unlink = async (target) => unlink(target)
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const completed = await waitForTerminal(events)
    assert.deepEqual(await service.exportPdf(exportRequest(completed, 'complete')), { status: 'saved' })
    assert.deepEqual([...await readFile(output)], [37, 80, 68, 70])
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.tmp')), [])
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务导出替换失败时必须保留原文件并清理临时文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  const output = join(directory, 'out.pdf')
  await writeFile(path, 'Hello')
  await writeFile(output, 'original')
  const events: DocumentWorkspaceSnapshot[] = []
  const written: string[] = []
  const unlinked: string[] = []
  const deps = dependencies(path, events)
  deps.showSaveDialog = async () => ({ canceled: false, filePath: output })
  deps.writeFile = async (target, bytes) => {
    written.push(target)
    await writeFile(target, bytes)
  }
  deps.rename = async () => {
    throw new Error('rename failed')
  }
  deps.unlink = async (target) => {
    unlinked.push(target)
    await unlink(target)
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const completed = await waitForTerminal(events)
    assert.deepEqual(
      await service.exportPdf(exportRequest(completed, 'complete')),
      { status: 'rejected', code: 'export-failed' }
    )
    assert.equal(await readFile(output, 'utf8'), 'original')
    assert.equal(written.length, 1)
    assert.deepEqual(unlinked, written)
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.tmp')), [])
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务导出写入失败时必须清理临时文件且不打开原子替换', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  const output = join(directory, 'out.pdf')
  await writeFile(path, 'Hello')
  await writeFile(output, 'original')
  const events: DocumentWorkspaceSnapshot[] = []
  const written: string[] = []
  const renamed: Array<{ source: string; target: string }> = []
  const unlinked: string[] = []
  const deps = dependencies(path, events)
  deps.showSaveDialog = async () => ({ canceled: false, filePath: output })
  deps.writeFile = async (target) => {
    written.push(target)
    throw new Error('disk full')
  }
  deps.rename = async (source, target) => {
    renamed.push({ source, target })
  }
  deps.unlink = async (target) => {
    unlinked.push(target)
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const completed = await waitForTerminal(events)
    assert.deepEqual(
      await service.exportPdf(exportRequest(completed, 'complete')),
      { status: 'rejected', code: 'export-failed' }
    )
    assert.equal(await readFile(output, 'utf8'), 'original')
    assert.equal(written.length, 1)
    assert.deepEqual(renamed, [])
    assert.deepEqual(unlinked, written)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务保存取消时不得写入、替换或清理文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  let writeCalls = 0
  let renameCalls = 0
  let unlinkCalls = 0
  const deps = dependencies(path, events)
  deps.showSaveDialog = async () => ({ canceled: true })
  deps.writeFile = async () => {
    writeCalls += 1
  }
  deps.rename = async () => {
    renameCalls += 1
  }
  deps.unlink = async () => {
    unlinkCalls += 1
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const completed = await waitForTerminal(events)
    assert.deepEqual(
      await service.exportPdf(exportRequest(completed, 'complete')),
      { status: 'cancelled' }
    )
    assert.deepEqual([writeCalls, renameCalls, unlinkCalls], [0, 0, 0])
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务导出必须写出 PDF 且只允许已批准任务资源', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  const output = join(directory, 'out.pdf')
  const deps = dependencies(path, events)
  deps.showSaveDialog = async () => ({ canceled: false, filePath: output })
  deps.writeFile = async (target, bytes) => writeFile(target, bytes)
  deps.rename = async (source, target) => rename(source, target)
  deps.unlink = async (target) => unlink(target)
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const completed = await waitForTerminal(events)
    const result = await service.exportPdf(exportRequest(completed, 'complete'))
    assert.equal(result.status, 'saved')
    assert.deepEqual([...await readFile(output)], [37, 80, 68, 70])
    assert.deepEqual(await service.getAsset('../escape.png'), { ok: false, code: 'asset-not-found' })
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务导出必须把图片资源告警返回给界面', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  const deps = dependencies(path, events)
  deps.exportPdf = async () => ({
    bytes: new Uint8Array([37, 80, 68, 70]),
    warnings: [{
      code: 'image-asset-unavailable',
      severity: 'warning',
      message: 'An image asset could not be embedded and was replaced with a placeholder.',
      pageId: 'page-1',
      blockId: 'image-1'
    }]
  })
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const completed = await waitForTerminal(events)
    const result = await service.exportPdf(exportRequest(completed, 'complete'))
    assert.deepEqual(result, {
      status: 'saved',
      warnings: [{
        code: 'image-asset-unavailable',
        severity: 'warning',
        message: 'An image asset could not be embedded and was replaced with a placeholder.',
        pageId: 'page-1',
        blockId: 'image-1'
      }]
    })
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务允许 PDF 读取原始字节，但 HTML 只能返回净化预览', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const pdfPath = join(directory, 'sample.pdf')
  const textPath = join(directory, 'sample.txt')
  const htmlPath = join(directory, 'sample.html')
  const pdfBytes = await readFile('tests/fixtures/document/sample.pdf')
  await writeFile(pdfPath, pdfBytes)
  await writeFile(textPath, 'Hello')
  const htmlSource = [
    '<html><head>',
    '<style>p{color:#123456;background:url(https://evil.example/a.png)}</style>',
    '</head><body onload="alert(1)">',
    '<p onclick="alert(1)">Hello</p>',
    '<script>alert(1)</script>',
    '<img src="https://evil.example/a.png">',
    '</body></html>'
  ].join('')
  await writeFile(htmlPath, htmlSource)

  const pdfEvents: DocumentWorkspaceSnapshot[] = []
  const pdfDependencies = dependencies(pdfPath, pdfEvents)
  pdfDependencies.parse = async () => ({
    ...model(pdfPath),
    source: { ...model(pdfPath).source, format: 'pdf', fileName: 'sample.pdf' }
  })
  const pdfService = new DocumentWorkspaceTaskService(pdfDependencies)
  try {
    assert.deepEqual(await pdfService.getSource(), { ok: false, code: 'source-not-found' })
    const accepted = await pdfService.run({ path: pdfPath, generation: 1 })
    assert.equal(accepted.accepted, true)
    const source = await pdfService.getSource()
    assert.equal(source.ok, true)
    assert.equal(source.mimeType, 'application/pdf')
    assert.deepEqual(source.bytes, new Uint8Array(pdfBytes))
    await waitForTerminal(pdfEvents)
  } finally {
    pdfService.dispose()
  }

  const htmlEvents: DocumentWorkspaceSnapshot[] = []
  const htmlDependencies = dependencies(htmlPath, htmlEvents)
  htmlDependencies.parse = async () => ({
    ...model(htmlPath),
    source: { ...model(htmlPath).source, format: 'html', fileName: 'sample.html' }
  })
  const htmlService = new DocumentWorkspaceTaskService(htmlDependencies)
  try {
    await htmlService.run({ path: htmlPath, generation: 1 })
    const source = await htmlService.getSource()
    assert.equal(source.ok, true)
    assert.equal(source.mimeType, 'text/html; charset=utf-8')
    assert.ok(source.bytes)
    const preview = new TextDecoder().decode(source.bytes)
    assert.notDeepEqual(source.bytes, new TextEncoder().encode(htmlSource))
    assert.match(preview, /Hello/u)
    assert.match(preview, /color:\s*#123456/iu)
    assert.doesNotMatch(preview, /<script|onload|onclick|javascript:|evil\.example/iu)
    await waitForTerminal(htmlEvents)
  } finally {
    htmlService.dispose()
  }

  const textEvents: DocumentWorkspaceSnapshot[] = []
  const textService = new DocumentWorkspaceTaskService(dependencies(textPath, textEvents))
  try {
    await textService.run({ path: textPath, generation: 1 })
    assert.deepEqual(await textService.getSource(), { ok: false, code: 'source-not-found' })
    await waitForTerminal(textEvents)
  } finally {
    textService.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('OCR 原文任务必须跳过翻译并在快照中标记 ocr 运行模式', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'scan.pdf')
  await writeFile(path, '%PDF-1.7\n%%EOF')
  const events: DocumentWorkspaceSnapshot[] = []
  const deps = dependencies(path, events)
  let translateCalls = 0
  deps.translate = async (text) => {
    translateCalls += 1
    return `译:${text}`
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    const accepted = await service.run({ path, generation: 1, mode: 'ocr' })
    assert.equal(accepted.accepted, true)
    const completed = await waitForTerminal(events)
    assert.equal(translateCalls, 0)
    assert.equal(completed.runMode, 'ocr')
    assert.equal(completed.task.status, 'completed')
    assert.equal(completed.task.phase, 'export')
    assert.deepEqual(completed.translation, completed.source)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('OCR 原文任务必须显式走源模型双层 PDF 导出，不能按译文部分结果回退源文', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'scan.pdf')
  await writeFile(path, '%PDF-1.7\n%%EOF')
  const events: DocumentWorkspaceSnapshot[] = []
  const deps = dependencies(path, events)
  let suggestedName = ''
  let exportedModel: DocumentModel | undefined
  let exportedTextLayer: boolean | undefined
  let exportedSourceOnly: boolean | undefined
  let exportedSourcePdfBytes: Uint8Array | undefined
  deps.parse = async () => ({
    ...model(path),
    source: { ...model(path).source, format: 'pdf', fileName: 'scan.pdf' }
  })
  const translatedModel = model(path)
  deps.translate = async () => {
    throw new Error('OCR 原文任务不应执行翻译')
  }
  deps.exportPdf = async (exported, exportDependencies, _partialExport, textLayer, sourceOnly) => {
    exportedModel = exported
    exportedSourcePdfBytes = exportDependencies.sourcePdfBytes
    exportedTextLayer = textLayer
    exportedSourceOnly = sourceOnly
    return { bytes: new Uint8Array([37, 80, 68, 70]), warnings: [] }
  }
  deps.showSaveDialog = async (name) => {
    suggestedName = name
    return { canceled: false, filePath: join(directory, 'scan-ocr.pdf') }
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1, mode: 'ocr' })
    const completed = await waitForTerminal(events)
    assert.equal(completed.runMode, 'ocr')
    assert.deepEqual(
      await service.exportPdf({ ...exportRequest(completed, 'complete'), textLayer: true }),
      { status: 'saved' }
    )
    assert.equal(exportedTextLayer, true)
    assert.equal(exportedSourceOnly, true)
    assert.deepEqual(exportedSourcePdfBytes, new TextEncoder().encode('%PDF-1.7\n%%EOF'))
    assert.deepEqual(exportedModel, completed.source)
    assert.notStrictEqual(exportedModel, translatedModel)
    assert.match(suggestedName, /scan-ocr\.pdf$/u)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务必须在翻译块成功时立即推送可原位合并的块增量', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  const updates: DocumentWorkspaceTranslationUpdate[] = []
  let releaseTranslation: (() => void) | null = null
  const deps = dependencies(path, events)
  deps.sendTranslationUpdate = (update) => updates.push(update)
  deps.translate = async (text) => {
    await new Promise<void>((resolve) => {
      releaseTranslation = resolve
    })
    return `译:${text}`
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    const accepted = await service.run({ path, generation: 1 })
    assert.equal(accepted.accepted, true)
    assert.ok(accepted.jobId)
    const startedDeadline = Date.now() + 2000
    while (!releaseTranslation && Date.now() < startedDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(releaseTranslation)
    // 翻译尚未成功返回时不得提前宣称该块已完成。
    assert.equal(updates.length, 0)
    assert.equal(events.some((event) => event.task.status === 'completed'), false)
    releaseTranslation()
    const deadline = Date.now() + 2000
    // 流水线先发布原文骨架，成功写回后第二次发布才应产生块增量。
    while (!updates.some((update) => update.blockId === 'block-1') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(updates.length, 1)
    const update = updates[0]!
    assert.equal(update.jobId, accepted.jobId)
    assert.equal(update.generation, 1)
    assert.equal(update.pageId, 'page-1')
    assert.equal(update.blockId, 'block-1')
    assert.equal(update.block.kind, 'text')
    assert.equal((update.block as { runs: Array<{ text: string }> }).runs[0]?.text, '译:Hello')
    assert.deepEqual([update.completed, update.total], [1, 1])
    await waitForTerminal(events)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('任务服务块增量必须携带当前任务和代际且不覆盖旧终态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  const updates: DocumentWorkspaceTranslationUpdate[] = []
  let releaseFirst: (() => void) | null = null
  let releaseSecond: (() => void) | null = null
  const deps = dependencies(path, events)
  deps.sendTranslationUpdate = (update) => updates.push(update)
  deps.translate = async (text, signal, request) => {
    if (request.generation === 1) {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
        signal.addEventListener('abort', resolve, { once: true })
      })
    } else {
      await new Promise<void>((resolve) => {
        releaseSecond = resolve
      })
    }
    return `译:${text}`
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    const first = await service.run({ path, generation: 1 })
    assert.ok(first.jobId)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const oldGeneration = updates.length
    service.cancel(first.jobId!, 1)
    const second = await service.run({ path, generation: 2 })
    assert.ok(second.jobId)
    releaseFirst?.()

    // 第二任务仍在翻译中；块增量只能携带新任务标识和新代际。
    const releaseDeadline = Date.now() + 2000
    while (!releaseSecond && Date.now() < releaseDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(releaseSecond)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(updates.length, oldGeneration)
    assert.equal(updates.some((update) => update.generation === 1 && update.blockId === 'block-1'), false)
    releaseSecond()
    const deadline = Date.now() + 2000
    while (!updates.some((update) => update.jobId === second.jobId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const current = updates.find((update) => update.jobId === second.jobId)
    assert.ok(current)
    assert.equal(current.generation, 2)
    await waitForTerminal(events, 2)
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
