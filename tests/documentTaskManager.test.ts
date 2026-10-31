import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DocumentTaskManager,
  type DocumentTaskSession,
  type DocumentTaskSessionContext,
  type DocumentTaskSessionFactory
} from '../src/main/documentTaskManager.ts'
import type {
  DocumentExportRequest,
  DocumentExportResult,
  DocumentRunRequest,
  DocumentRunResult,
  DocumentWorkspaceSnapshot,
  DocumentWorkspaceTranslationUpdate
} from '../src/shared/documentWorkspace.ts'

/** 测试会话记录所有生命周期调用。 */
interface SessionRecord {
  /** 会话标识，用于验证切换文件时创建了新会话。 */
  id: number
  /** 当前会话收到的运行请求。 */
  runs: DocumentRunRequest[]
  /** 当前会话收到的取消调用。 */
  cancels: Array<{ jobId: string; generation: number }>
  /** 当前会话收到的重试代际。 */
  retries: number[]
  /** 当前会话是否已释放。 */
  disposed: boolean
  /** 当前会话取消调用是否成功。 */
  cancelResult: boolean
  /** 当前会话的运行结果；可替换以模拟拒绝。 */
  runResult: DocumentRunResult
  /** 当前会话的重试结果；可替换以模拟拒绝。 */
  retryResult: DocumentRunResult
  /** 当前会话的导出结果。 */
  exportResult: DocumentExportResult
  /** 当前会话向任务管理器上报事件的上下文。 */
  context: DocumentTaskSessionContext | null
}

/** 可注入的会话工厂，返回记录型会话。 */
function createFixture(): {
  sessions: SessionRecord[]
  factory: DocumentTaskSessionFactory
  progress: DocumentWorkspaceSnapshot[]
  completed: DocumentWorkspaceSnapshot[]
  updates: DocumentWorkspaceTranslationUpdate[]
} {
  const sessions: SessionRecord[] = []
  const progress: DocumentWorkspaceSnapshot[] = []
  const completed: DocumentWorkspaceSnapshot[] = []
  const updates: DocumentWorkspaceTranslationUpdate[] = []
  let nextId = 1
  const factory: DocumentTaskSessionFactory = (context) => {
    const record: SessionRecord = {
      id: nextId++,
      runs: [],
      cancels: [],
      retries: [],
      disposed: false,
      cancelResult: true,
      runResult: { accepted: true, jobId: `job-${nextId - 1}` },
      retryResult: { accepted: true, jobId: `job-${nextId - 1}` },
      exportResult: { status: 'cancelled' },
      context
    }
    sessions.push(record)
    const session: DocumentTaskSession = {
      run: async (request) => {
        record.runs.push(request)
        return record.runResult
      },
      retryFailed: (generation) => {
        record.retries.push(generation)
        return record.retryResult
      },
      cancel: (jobId, generation) => {
        record.cancels.push({ jobId, generation })
        return record.cancelResult
      },
      exportPdf: async (_request: DocumentExportRequest) => record.exportResult,
      getAsset: async () => ({ ok: false, code: 'asset-not-found' }),
      getSource: async () => ({ ok: false, code: 'source-not-found' }),
      dispose: () => {
        record.disposed = true
      }
    }
    return session
  }
  return { sessions, factory, progress, completed, updates }
}

/** 创建任务管理器，并把会话事件记录到夹具。 */
function createManager(fixture: ReturnType<typeof createFixture>): DocumentTaskManager {
  return new DocumentTaskManager({
    createSession: fixture.factory,
    sendProgress: (snapshot) => fixture.progress.push(snapshot),
    sendCompleted: (snapshot) => fixture.completed.push(snapshot),
    sendTranslationUpdate: (update) => fixture.updates.push(update)
  })
}

/** 创建指定任务与代际的最小快照。 */
function snapshot(jobId: string, generation: number, percent: number): DocumentWorkspaceSnapshot {
  return {
    jobId,
    generation,
    percent,
    task: {
      jobId,
      generation,
      phase: 'parse',
      status: 'parsing',
      progress: { completed: percent, total: 100 },
      phaseCompleted: false,
      failedBlocks: 0,
      warningCount: 0,
      cancellationRequested: false
    }
  }
}

/** 创建最小运行请求。 */
function runRequest(path: string, generation: number): DocumentRunRequest {
  return { path, generation }
}

/** 创建指定任务与代际的最小块增量。 */
function translationUpdate(
  jobId: string,
  generation: number,
  blockId = 'block-1'
): DocumentWorkspaceTranslationUpdate {
  return {
    jobId,
    generation,
    pageId: 'page-1',
    blockId,
    block: {
      kind: 'text',
      blockId,
      readingOrder: 0,
      translatable: true,
      role: 'paragraph',
      runs: [{ runId: `run-${blockId}`, text: '你好' }]
    },
    completed: 1,
    total: 2
  }
}

test('任务管理器必须创建会话、转发运行请求并记录 jobId 与代际', async () => {
  const fixture = createFixture()
  const manager = createManager(fixture)

  const result = await manager.run(runRequest('/tmp/a.txt', 1))

  assert.deepEqual(result, { accepted: true, jobId: 'job-1' })
  assert.equal(fixture.sessions.length, 1)
  assert.deepEqual(fixture.sessions[0]?.runs, [runRequest('/tmp/a.txt', 1)])
  assert.deepEqual(manager.currentTask(), { jobId: 'job-1', generation: 1 })
  manager.dispose()
})

test('任务管理器必须拒绝同代际重复启动，并在拒绝时不创建新会话', async () => {
  const fixture = createFixture()
  const manager = createManager(fixture)

  assert.equal((await manager.run(runRequest('/tmp/a.txt', 1))).accepted, true)
  const duplicate = await manager.run(runRequest('/tmp/a.txt', 1))
  const stale = await manager.run(runRequest('/tmp/a.txt', 0))

  assert.deepEqual(duplicate, { accepted: false, code: 'busy' })
  assert.deepEqual(stale, { accepted: false, code: 'invalid-request' })
  assert.equal(fixture.sessions.length, 1)
  assert.equal(fixture.sessions[0]?.runs.length, 1)
  manager.dispose()
})

test('任务管理器切换文件必须先取消旧会话、释放旧会话并使用新代际启动', async () => {
  const fixture = createFixture()
  const manager = createManager(fixture)

  const first = await manager.run(runRequest('/tmp/a.txt', 1))
  const second = await manager.run(runRequest('/tmp/b.txt', 2))

  assert.equal(first.accepted, true)
  assert.equal(second.accepted, true)
  assert.equal(fixture.sessions.length, 2)
  assert.deepEqual(fixture.sessions[0]?.cancels, [{
    jobId: 'job-1',
    generation: 1
  }])
  assert.equal(fixture.sessions[0]?.disposed, true)
  assert.deepEqual(fixture.sessions[1]?.runs, [runRequest('/tmp/b.txt', 2)])
  assert.deepEqual(manager.currentTask(), { jobId: 'job-2', generation: 2 })
  manager.dispose()
})

test('任务管理器必须只向当前 jobId 与代际转发取消，且重复取消幂等', async () => {
  const fixture = createFixture()
  const manager = createManager(fixture)
  await manager.run(runRequest('/tmp/a.txt', 1))

  assert.equal(manager.cancel('other-job', 1), false)
  assert.equal(manager.cancel('job-1', 2), false)
  assert.equal(manager.cancel('job-1', 1), true)
  assert.equal(manager.cancel('job-1', 1), false)
  assert.deepEqual(fixture.sessions[0]?.cancels, [{ jobId: 'job-1', generation: 1 }])
  manager.dispose()
})

test('任务管理器取消失败时不得标记为已取消，后续仍可重试取消', async () => {
  const fixture = createFixture()
  const manager = createManager(fixture)
  await manager.run(runRequest('/tmp/a.txt', 1))
  fixture.sessions[0]!.cancelResult = false

  assert.equal(manager.cancel('job-1', 1), false)
  assert.equal(manager.cancel('job-1', 1), false)
  fixture.sessions[0]!.cancelResult = true
  assert.equal(manager.cancel('job-1', 1), true)
  assert.equal(manager.cancel('job-1', 1), false)
  assert.deepEqual(fixture.sessions[0]?.cancels, [
    { jobId: 'job-1', generation: 1 },
    { jobId: 'job-1', generation: 1 },
    { jobId: 'job-1', generation: 1 }
  ])
  manager.dispose()
})

test('任务管理器重试必须使用更高代际并更新当前代际', async () => {
  const fixture = createFixture()
  const manager = createManager(fixture)
  await manager.run(runRequest('/tmp/a.txt', 1))

  const stale = manager.retryFailed(1)
  const retried = manager.retryFailed(2)

  assert.deepEqual(stale, {
    accepted: false,
    code: 'generation-conflict',
    suggestedGeneration: 2
  })
  assert.deepEqual(retried, { accepted: true, jobId: 'job-1' })
  assert.deepEqual(fixture.sessions[0]?.retries, [2])
  assert.deepEqual(manager.currentTask(), { jobId: 'job-1', generation: 2 })
  manager.dispose()
})

test('任务管理器关闭窗口必须取消并释放会话、清空任务并忽略迟到调用', async () => {
  const fixture = createFixture()
  const manager = createManager(fixture)
  await manager.run(runRequest('/tmp/a.txt', 1))

  manager.dispose()
  manager.dispose()

  assert.deepEqual(fixture.sessions[0]?.cancels, [{ jobId: 'job-1', generation: 1 }])
  assert.equal(fixture.sessions[0]?.disposed, true)
  assert.equal(manager.currentTask(), null)
  assert.equal(manager.cancel('job-1', 1), false)
  assert.deepEqual(await manager.run(runRequest('/tmp/b.txt', 2)), {
    accepted: false,
    code: 'service-disposed'
  })
  assert.equal(fixture.sessions.length, 1)
})

test('任务管理器释放后必须拒绝并丢弃迟到的进度、终态与块增量', async () => {
  const fixture = createFixture()
  const manager = createManager(fixture)
  await manager.run(runRequest('/tmp/a.txt', 1))
  const context = fixture.sessions[0]?.context
  assert.ok(context)

  manager.dispose()
  context.sendProgress(snapshot('job-1', 1, 50))
  context.sendCompleted(snapshot('job-1', 1, 100))
  context.sendTranslationUpdate(translationUpdate('job-1', 1))

  assert.equal(manager.handleProgress(snapshot('job-1', 1, 60)), false)
  assert.equal(manager.handleCompleted(snapshot('job-1', 1, 100)), false)
  assert.equal(manager.handleTranslationUpdate(translationUpdate('job-1', 1)), false)
  assert.deepEqual(fixture.progress, [])
  assert.deepEqual(fixture.completed, [])
  assert.deepEqual(fixture.updates, [])
})

test('任务管理器在启动等待期间关闭时只释放会话一次且不重复取消', async () => {
  let release: ((result: DocumentRunResult) => void) | null = null
  const record = { disposed: 0, cancels: 0 }
  const manager = new DocumentTaskManager({
    createSession: () => ({
      run: () => new Promise<DocumentRunResult>((resolve) => { release = resolve }),
      retryFailed: () => ({ accepted: false, code: 'not-ready' }),
      cancel: () => {
        record.cancels += 1
        return true
      },
      exportPdf: async () => ({ status: 'cancelled' }),
      getAsset: async () => ({ ok: false, code: 'asset-not-found' }),
      getSource: async () => ({ ok: false, code: 'source-not-found' }),
      dispose: () => { record.disposed += 1 }
    })
  })

  const pending = manager.run(runRequest('/tmp/a.txt', 1))
  await Promise.resolve()
  manager.dispose()
  manager.dispose()
  release!({ accepted: true, jobId: 'job-1' })

  assert.deepEqual(await pending, { accepted: false, code: 'service-disposed' })
  assert.deepEqual(record, { disposed: 1, cancels: 0 })
})

test('任务管理器必须丢弃旧会话迟到快照，只转发当前会话事件', async () => {
  const fixture = createFixture()
  const manager = createManager(fixture)
  await manager.run(runRequest('/tmp/a.txt', 1))
  const firstContext = fixture.sessions[0]?.context
  await manager.run(runRequest('/tmp/b.txt', 2))
  const currentContext = fixture.sessions[1]?.context

  assert.ok(firstContext)
  assert.ok(currentContext)
  firstContext.sendProgress(snapshot('job-1', 1, 30))
  firstContext.sendCompleted(snapshot('job-1', 1, 100))
  assert.equal(manager.handleProgress(snapshot('job-1', 1, 40)), false)
  assert.equal(manager.handleCompleted(snapshot('job-1', 1, 100)), false)
  assert.equal(fixture.progress.length, 0)
  assert.equal(fixture.completed.length, 0)

  currentContext.sendProgress(snapshot('job-2', 2, 50))
  currentContext.sendCompleted(snapshot('job-2', 2, 100))
  assert.deepEqual(fixture.progress.map((item) => [item.jobId, item.generation]), [['job-2', 2]])
  assert.deepEqual(fixture.completed.map((item) => [item.jobId, item.generation]), [['job-2', 2]])
  manager.dispose()
})

test('任务管理器必须只转发当前任务与代际的块增量', async () => {
  const fixture = createFixture()
  const manager = createManager(fixture)
  await manager.run(runRequest('/tmp/a.txt', 1))
  const context = fixture.sessions[0]?.context
  assert.ok(context)

  context.sendTranslationUpdate(translationUpdate('job-1', 1))
  assert.equal(manager.handleTranslationUpdate(translationUpdate('job-1', 1, 'block-2')), true)
  assert.equal(manager.handleTranslationUpdate(translationUpdate('job-old', 1)), false)
  assert.equal(manager.handleTranslationUpdate(translationUpdate('job-1', 2)), false)

  assert.deepEqual(
    fixture.updates.map((item) => [item.jobId, item.generation, item.blockId]),
    [['job-1', 1, 'block-1'], ['job-1', 1, 'block-2']]
  )
  manager.dispose()
})

test('任务管理器必须丢弃切换任务后旧会话的块增量', async () => {
  const fixture = createFixture()
  const manager = createManager(fixture)
  await manager.run(runRequest('/tmp/a.txt', 1))
  const oldContext = fixture.sessions[0]?.context
  await manager.run(runRequest('/tmp/b.txt', 2))
  const currentContext = fixture.sessions[1]?.context
  assert.ok(oldContext)
  assert.ok(currentContext)

  oldContext.sendTranslationUpdate(translationUpdate('job-1', 1))
  assert.equal(manager.handleTranslationUpdate(translationUpdate('job-1', 1)), false)
  currentContext.sendTranslationUpdate(translationUpdate('job-2', 2))

  assert.deepEqual(
    fixture.updates.map((item) => [item.jobId, item.generation]),
    [['job-2', 2]]
  )
  manager.dispose()
})

test('任务管理器必须在会话接受前缓存进度，并在接受后仅转发匹配事件', async () => {
  const fixture = createFixture()
  const factory: DocumentTaskSessionFactory = (context) => {
    const session = fixture.factory(context)
    const record = fixture.sessions.at(-1)!
    session.run = async (request) => {
      record.runs.push(request)
      context.sendProgress(snapshot('job-1', request.generation, 10))
      context.sendProgress(snapshot('stale-job', request.generation, 20))
      return record.runResult
    }
    return session
  }
  const manager = new DocumentTaskManager({
    createSession: factory,
    sendProgress: (item) => fixture.progress.push(item),
    sendCompleted: (item) => fixture.completed.push(item)
  })

  assert.equal((await manager.run(runRequest('/tmp/a.txt', 1))).accepted, true)
  assert.deepEqual(fixture.progress.map((item) => item.jobId), ['job-1'])
  manager.dispose()
})

test('任务管理器必须在会话接受前暂存块增量，并在接受后仅转发匹配事件', async () => {
  const fixture = createFixture()
  const factory: DocumentTaskSessionFactory = (context) => {
    const session = fixture.factory(context)
    const record = fixture.sessions.at(-1)!
    session.run = async (request) => {
      record.runs.push(request)
      context.sendTranslationUpdate(translationUpdate('job-1', request.generation, 'block-current'))
      context.sendTranslationUpdate(translationUpdate('stale-job', request.generation, 'block-stale'))
      context.sendTranslationUpdate(translationUpdate('job-1', request.generation + 1, 'block-future'))
      return record.runResult
    }
    return session
  }
  const manager = new DocumentTaskManager({
    createSession: factory,
    sendTranslationUpdate: (item) => fixture.updates.push(item)
  })

  assert.equal((await manager.run(runRequest('/tmp/a.txt', 1))).accepted, true)
  assert.deepEqual(fixture.updates.map((item) => item.blockId), ['block-current'])
  manager.dispose()
})

test('任务管理器必须释放启动被拒绝的新会话且不留下当前任务', async () => {
  const rejectedFixture = createFixture()
  const factory: DocumentTaskSessionFactory = (context) => {
    const session = rejectedFixture.factory(context)
    rejectedFixture.sessions.at(-1)!.runResult = { accepted: false, code: 'worker-unavailable' }
    return session
  }
  const rejectedManager = new DocumentTaskManager({ createSession: factory })

  assert.deepEqual(await rejectedManager.run(runRequest('/tmp/a.txt', 1)), {
    accepted: false,
    code: 'worker-unavailable'
  })
  assert.equal(rejectedFixture.sessions[0]?.disposed, true)
  assert.equal(rejectedManager.currentTask(), null)
  rejectedManager.dispose()
})

test('任务管理器必须拒绝并发启动，且较晚完成的旧启动不得覆盖新任务', async () => {
  const releases: Array<(result: DocumentRunResult) => void> = []
  const sessions: Array<{ id: number; disposed: boolean; cancels: number }> = []
  let nextId = 1
  const manager = new DocumentTaskManager({
    createSession: () => {
      const record = { id: nextId++, disposed: false, cancels: 0 }
      sessions.push(record)
      return {
        run: () => new Promise<DocumentRunResult>((resolve) => releases.push(resolve)),
        retryFailed: () => ({ accepted: false, code: 'not-ready' }),
        cancel: () => {
          record.cancels += 1
          return true
        },
        exportPdf: async () => ({ status: 'cancelled' }),
        getAsset: async () => ({ ok: false, code: 'asset-not-found' }),
        getSource: async () => ({ ok: false, code: 'source-not-found' }),
        dispose: () => { record.disposed = true }
      }
    }
  })

  const first = manager.run(runRequest('/tmp/a.txt', 1))
  await Promise.resolve()
  assert.deepEqual(await manager.run(runRequest('/tmp/b.txt', 2)), {
    accepted: false,
    code: 'busy'
  })
  releases[0]!({ accepted: true, jobId: 'job-1' })
  assert.deepEqual(await first, { accepted: true, jobId: 'job-1' })
  assert.equal(sessions.length, 1)
  assert.deepEqual(manager.currentTask(), { jobId: 'job-1', generation: 1 })
  manager.dispose()
})

test('任务管理器在启动等待期间关闭时也必须取消并释放新会话', async () => {
  let release: ((result: DocumentRunResult) => void) | null = null
  const record = { disposed: false, cancels: 0 }
  const manager = new DocumentTaskManager({
    createSession: () => ({
      run: () => new Promise<DocumentRunResult>((resolve) => { release = resolve }),
      retryFailed: () => ({ accepted: false, code: 'not-ready' }),
      cancel: () => {
        record.cancels += 1
        return true
      },
      exportPdf: async () => ({ status: 'cancelled' }),
      getAsset: async () => ({ ok: false, code: 'asset-not-found' }),
      getSource: async () => ({ ok: false, code: 'source-not-found' }),
      dispose: () => { record.disposed = true }
    })
  })

  const pending = manager.run(runRequest('/tmp/a.txt', 1))
  await Promise.resolve()
  manager.dispose()
  release!({ accepted: true, jobId: 'job-1' })

  assert.deepEqual(await pending, { accepted: false, code: 'service-disposed' })
  assert.equal(record.disposed, true)
  assert.equal(manager.currentTask(), null)
})

test('任务管理器必须拒绝旧任务导出，并把资源调用转发给当前会话', async () => {
  const fixture = createFixture()
  const manager = createManager(fixture)
  await manager.run(runRequest('/tmp/a.txt', 1))

  assert.deepEqual(await manager.exportPdf({
    jobId: 'old-job',
    generation: 1,
    mode: 'complete'
  }), { status: 'rejected', code: 'completion-mismatch' })
  assert.deepEqual(await manager.exportPdf({
    jobId: 'job-1',
    generation: 1,
    mode: 'complete'
  }), { status: 'cancelled' })
  assert.deepEqual(await manager.getAsset('../asset'), { ok: false, code: 'asset-not-found' })
  assert.deepEqual(await manager.getSource(), { ok: false, code: 'source-not-found' })
  manager.dispose()
})
