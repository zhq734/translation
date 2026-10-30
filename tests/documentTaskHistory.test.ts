import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DOCUMENT_TASK_HISTORY_SCHEMA_VERSION,
  DocumentTaskHistoryStore
} from '../src/main/documentTaskHistory.ts'
import type { DocumentModel } from '../src/shared/documentTypes.ts'
import type { DocumentWorkspaceSnapshot } from '../src/shared/documentWorkspace.ts'

/**
 * 创建隔离的历史存储目录。
 * @returns 临时目录路径。
 * @author zhenghq
 */
async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'document-task-history-'))
}

/**
 * 构造带源文件元数据、语言偏好与完成报告的终态快照。
 * @param jobId 任务标识。
 * @param updatedAt 用于排序的更新时间。
 * @param status 终态状态。
 * @returns 可写入历史的工作台快照。
 * @author zhenghq
 */
function snapshot(
  jobId: string,
  updatedAt: number,
  status: 'completed' | 'partial' = 'completed'
): DocumentWorkspaceSnapshot {
  const source = model(jobId, 'source')
  const translation = model(jobId, 'translation')
  return {
    jobId,
    generation: 2,
    task: {
      jobId,
      generation: 2,
      phase: 'layout',
      status,
      progress: { completed: 1, total: 1 },
      phaseCompleted: true,
      failedBlocks: status === 'partial' ? 1 : 0,
      warningCount: 0,
      cancellationRequested: false
    },
    percent: 100,
    source,
    translation,
    sourcePreference: 'EN',
    targetPreference: 'ZH',
    languagePair: { sourceLang: 'EN', targetLang: 'ZH' },
    completionReport: {
      jobId,
      generation: 2,
      documentId: source.documentId,
      status,
      total: 1,
      translated: status === 'completed' ? 1 : 0,
      unchanged: 0,
      failed: status === 'partial' ? 1 : 0,
      pending: 0,
      suspectUntranslated: 0,
      failedTargetIds: status === 'partial' ? ['0:0:text:run-source'] : [],
      pendingTargetIds: [],
      suspectUntranslatedTargetIds: []
    },
    ...({ updatedAt } as object)
  }
}

/**
 * 构造带明确正文的文档模型，用于验证历史摘要不泄漏内容。
 * @param jobId 任务标识。
 * @param text 正文前缀。
 * @returns 最小文档模型。
 * @author zhenghq
 */
function model(jobId: string, text: string): DocumentModel {
  return {
    schemaVersion: 1,
    documentId: `document-${jobId}`,
    source: {
      path: `/private/${jobId}/secret.pdf`,
      fileName: `${jobId}.pdf`,
      format: 'pdf',
      sha256: `sha-${jobId}`,
      size: 1024
    },
    metadata: { direction: 'ltr' },
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
        runs: [{ runId: 'run-source', text: `${text}-正文` }]
      }]
    }],
    assets: [],
    warnings: []
  }
}

test('任务历史必须只持久化摘要，并按更新时间倒序限制数量', async () => {
  const directory = await temporaryDirectory()
  try {
    let now = 1000
    const store = new DocumentTaskHistoryStore({
      directory,
      maxEntries: 2,
      now: () => now
    })
    await store.save(snapshot('job-a', 1000))
    now = 2000
    await store.save(snapshot('job-b', 2000, 'partial'))
    now = 3000
    await store.save(snapshot('job-c', 3000))

    const list = await store.list()
    assert.deepEqual(list.map((entry) => entry.jobId), ['job-c', 'job-b'])
    assert.deepEqual(list[1], {
      jobId: 'job-b',
      generation: 2,
      fileName: 'job-b.pdf',
      format: 'pdf',
      sourcePreference: 'EN',
      targetPreference: 'ZH',
      languagePair: { sourceLang: 'EN', targetLang: 'ZH' },
      status: 'partial',
      percent: 100,
      updatedAt: 2000,
      exportStatus: 'not-exported'
    })

    const raw = await readFile(join(directory, 'task-history.json'), 'utf8')
    assert.equal(raw.includes('source-正文'), false)
    assert.equal(raw.includes('translation-正文'), false)
    assert.equal(raw.includes('/private/'), false)
    assert.equal(raw.includes('documentId'), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('打开历史任务必须返回可恢复快照，删除后不可再打开', async () => {
  const directory = await temporaryDirectory()
  try {
    const store = new DocumentTaskHistoryStore({
      directory,
      maxEntries: 10,
      now: () => 1000
    })
    await store.save(snapshot('job-open', 1000))
    const opened = await store.open('job-open')
    assert.equal(opened?.snapshot.source?.pages[0]?.blocks[0]?.kind, 'text')
    assert.equal(opened?.snapshot.translation?.pages[0]?.blocks[0]?.kind, 'text')
    assert.deepEqual(opened?.snapshot.languagePair, { sourceLang: 'EN', targetLang: 'ZH' })

    assert.equal(await store.delete('job-open'), true)
    assert.equal(await store.open('job-open'), null)
    assert.deepEqual(await store.list(), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('清空历史缓存必须删除恢复快照但保留设置文件', async () => {
  const directory = await temporaryDirectory()
  try {
    const settingsPath = join(directory, 'settings.json')
    await writeFile(settingsPath, JSON.stringify({ documentTranslationEnabled: true }), 'utf8')
    const store = new DocumentTaskHistoryStore({
      directory,
      maxEntries: 10,
      now: () => 1000
    })
    await store.save(snapshot('job-clear', 1000))
    await store.clear()
    assert.deepEqual(await store.list(), [])
    assert.equal(await store.open('job-clear'), null)
    assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).documentTranslationEnabled, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('损坏历史 JSON 必须安全回退为空并允许重新保存', async () => {
  const directory = await temporaryDirectory()
  try {
    await writeFile(join(directory, 'task-history.json'), '{broken', 'utf8')
    const store = new DocumentTaskHistoryStore({
      directory,
      maxEntries: 10,
      now: () => 1000
    })
    assert.deepEqual(await store.list(), [])
    await store.save(snapshot('job-recovered', 1000))
    assert.equal((await store.list())[0]?.jobId, 'job-recovered')
    const raw = JSON.parse(await readFile(join(directory, 'task-history.json'), 'utf8')) as {
      schemaVersion: number
    }
    assert.equal(raw.schemaVersion, DOCUMENT_TASK_HISTORY_SCHEMA_VERSION)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('历史导出状态必须只更新匹配任务与代际', async () => {
  const directory = await temporaryDirectory()
  try {
    const store = new DocumentTaskHistoryStore({
      directory,
      maxEntries: 10,
      now: () => 1000
    })
    await store.save(snapshot('job-export', 1000))
    await store.updateExportStatus('job-export', 2, 'saved')
    assert.equal((await store.list())[0]?.exportStatus, 'saved')
    await store.updateExportStatus('job-export', 1, 'saved')
    assert.equal((await store.list())[0]?.exportStatus, 'saved')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
