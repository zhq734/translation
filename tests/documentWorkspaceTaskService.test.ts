import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import {
  DocumentWorkspaceTaskService,
  type DocumentWorkspaceTaskServiceDependencies
} from '../src/main/documentWorkspaceTaskService.ts'
import type { DocumentModel } from '../src/shared/documentTypes.ts'
import type { DocumentWorkspaceSnapshot } from '../src/shared/documentWorkspace.ts'

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
    assert.equal(completed.translation?.pages[0]?.blocks[0]?.kind, 'text')
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
  deps.parse = async () => {
    parseCalls += 1
    return model(path)
  }
  deps.translate = async (text) => {
    translatedTexts.push(text)
    if (!retrying) throw new Error('provider failed')
    return `译:${text}`
  }
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    const partial = await waitForTerminal(events)
    assert.equal(partial.task.status, 'partial')
    assert.equal(partial.retryableFailedBlocks, 1)

    retrying = true
    translatedTexts.length = 0
    const accepted = await service.retryFailed(2)
    assert.equal(accepted.accepted, true)
    const completed = await waitForTerminal(events, 2)
    assert.equal(completed.task.status, 'completed')
    assert.equal(completed.task.generation, 2)
    assert.equal(completed.retryableFailedBlocks ?? 0, 0)
    assert.equal(parseCalls, 1)
    assert.deepEqual(translatedTexts, ['Hello'])
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
  deps.translate = async (text, signal, _request, onDelta) => {
    assert.equal(typeof onDelta, 'function', '文件翻译必须接收流式增量回调')
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

test('任务服务导出必须写出 PDF 且只允许已批准任务资源', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const path = join(directory, 'sample.txt')
  await writeFile(path, 'Hello')
  const events: DocumentWorkspaceSnapshot[] = []
  const output = join(directory, 'out.pdf')
  const deps = dependencies(path, events)
  deps.showSaveDialog = async () => ({ canceled: false, filePath: output })
  deps.writeFile = async (target, bytes) => writeFile(target, bytes)
  const service = new DocumentWorkspaceTaskService(deps)
  try {
    await service.run({ path, generation: 1 })
    await waitForTerminal(events)
    const result = await service.exportPdf()
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
    await waitForTerminal(events)
    const result = await service.exportPdf()
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

test('任务服务允许 PDF 与 HTML 读取原始源文件字节', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'document-task-'))
  const pdfPath = join(directory, 'sample.pdf')
  const textPath = join(directory, 'sample.txt')
  const htmlPath = join(directory, 'sample.html')
  const pdfBytes = await readFile('tests/fixtures/document/sample.pdf')
  await writeFile(pdfPath, pdfBytes)
  await writeFile(textPath, 'Hello')
  await writeFile(htmlPath, '<html><body>Hello</body></html>')

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
    assert.deepEqual(source.bytes, new TextEncoder().encode('<html><body>Hello</body></html>'))
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
