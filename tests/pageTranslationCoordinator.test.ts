import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtractedWebTextUnit } from '../src/shared/webPageTranslation.ts'
import {
  aggregatePageTranslationUnits,
  PageTranslationCoordinator,
  type PageTranslationJob
} from '../src/main/pageTranslationCoordinator.ts'

function unit(id: string, text: string, category: 'body' | 'isolated' = 'body'): ExtractedWebTextUnit {
  return {
    id,
    blockId: `block-${id}`,
    sourceText: text,
    text,
    category,
    anchor: { parentSelector: `#${id}`, textNodeIndex: 0, sourceFingerprint: id }
  }
}

const job: PageTranslationJob = {
  readerId: 'reader-1', pageRevision: 3, jobId: 'job-1', scope: 'body', maxCharsPerSegment: 500,
  sourceLang: 'EN', targetLang: 'ZH'
}

test('协调器按范围过滤、限制并发并报告完成结果', async () => {
  let running = 0
  let peak = 0
  const results: string[] = []
  const coordinator = new PageTranslationCoordinator({
    concurrency: 2,
    translate: async (text, sourceLang, targetLang) => {
      assert.equal(sourceLang, 'EN')
      assert.equal(targetLang, 'ZH')
      running += 1; peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, text === '慢' ? 8 : 1))
      running -= 1
      return { translation: `译:${text}` }
    }
  })
  const progress: number[] = []
  const output = await coordinator.run(job, [unit('a', '快'), unit('b', '慢'), unit('nav', '菜单', 'isolated')], (event) => {
    progress.push(event.done)
  })
  assert.equal(peak, 2)
  assert.equal(output.partial, false)
  assert.deepEqual(output.results.map((item) => item.translation), ['译:快', '译:慢'])
  assert.deepEqual(progress, [1, 2])
  assert.equal(output.progress.failed, 0)
  results.push(...output.results.map((item) => item.unitId))
  assert.deepEqual(results, ['a', 'b'])
})

test('全部范围应翻译导航、按钮、列表等孤立可见文本，避免网页标签遗漏', async () => {
  const coordinator = new PageTranslationCoordinator({
    translate: async (text) => ({ translation: `译:${text}` })
  })
  const output = await coordinator.run(
    { ...job, jobId: 'job-all', scope: 'all' },
    [unit('article', '正文'), unit('nav', '话题', 'isolated'), unit('button', '更多', 'isolated')]
  )
  assert.deepEqual(output.results.map((item) => item.unitId), ['article', 'nav', 'button'])
})

test('协调器保留已完成结果，失败块可标记且代次失效时丢弃迟到结果', async () => {
  let resolveLate: ((value: { translation: string }) => void) | undefined
  const coordinator = new PageTranslationCoordinator({
    concurrency: 1,
    translate: async (text) => {
      if (text === '迟到') return new Promise((resolve) => { resolveLate = resolve })
      throw new Error('通道失败')
    }
  })
  const events: string[] = []
  const promise = coordinator.run(job, [unit('late', '迟到'), unit('bad', '失败')], (event) => {
    events.push(`${event.done}/${event.failed}`)
  })
  coordinator.invalidate('reader-1', 3, 'job-1')
  resolveLate?.({ translation: '不应写入' })
  const output = await promise
  assert.equal(output.results.length, 0)
  assert.equal(output.progress.cancelled, true)
  assert.equal(output.progress.failed, 0)
  assert.deepEqual(events, [])
})

test('协调器取消未开始任务并标记部分翻译', async () => {
  const controller = new AbortController()
  let calls = 0
  const coordinator = new PageTranslationCoordinator({
    concurrency: 1,
    translate: async (text) => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { translation: text }
    }
  })
  const promise = coordinator.run({ ...job, jobId: 'job-cancel' }, [unit('a', '一'), unit('b', '二'), unit('c', '三')], undefined, controller.signal)
  setTimeout(() => controller.abort(), 1)
  const output = await promise
  assert.ok(calls < 3)
  assert.equal(output.progress.cancelled, true)
  assert.equal(output.partial, true)
})

test('任务代次应包含语言方向，旧目标语言迟到结果不得进入新任务', async () => {
  let resolveLate: ((value: { translation: string }) => void) | undefined
  const coordinator = new PageTranslationCoordinator({
    concurrency: 1,
    translate: async () => new Promise((resolve) => { resolveLate = resolve })
  })
  const oldJob = { ...job, jobId: 'same-job', targetLang: 'ZH' }
  const oldRun = coordinator.run(oldJob, [unit('a', 'Hello')])
  coordinator.invalidate('reader-1', 3, 'same-job', 'EN', 'ZH')
  resolveLate?.({ translation: '中文' })
  const oldOutput = await oldRun
  assert.equal(oldOutput.results.length, 0)
  assert.equal(oldOutput.progress.cancelled, true)
})

test('分段译文应按文本单元和原顺序聚合，任一分段失败则保留原文', () => {
  const units = [unit('long', 'First. Second.'), unit('bad', 'Broken')]
  const aggregated = aggregatePageTranslationUnits(units, [
    { unitId: 'long', blockId: 'block-long', segmentId: 'long:1', index: 1, text: 'Second.', translation: '第二。' },
    { unitId: 'long', blockId: 'block-long', segmentId: 'long:0', index: 0, text: 'First. ', translation: '第一。' },
    { unitId: 'bad', blockId: 'block-bad', segmentId: 'bad:0', index: 0, text: 'Broken', error: '失败' }
  ])
  assert.equal(aggregated[0].translation, '第一。第二。')
  assert.equal(aggregated[1].translation, undefined)
  assert.equal(aggregated[1].error, '失败')
})

test('文本单元的全部分段完成后应立即触发增量回调', async () => {
  const completed: Array<{ unitId: string; resultCount: number }> = []
  const coordinator = new PageTranslationCoordinator({
    concurrency: 1,
    translate: async (text) => ({ translation: `译:${text}` })
  })
  const output = await coordinator.run(
    { ...job, jobId: 'job-unit-callback', maxCharsPerSegment: 4 },
    [unit('long', '第一句。第二句。'), unit('later', '后续')],
    undefined,
    undefined,
    (result, unitComplete, results) => {
      if (unitComplete) completed.push({ unitId: result.unitId, resultCount: results.filter((item) => item.unitId === result.unitId).length })
    }
  )
  assert.deepEqual(completed.map((item) => item.unitId), ['long', 'later'])
  assert.equal(completed[0]?.resultCount, 2)
  assert.equal(output.results.length, 3)
})
