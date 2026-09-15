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
    { unitId: 'long', unitIds: ['long'], blockId: 'block-long', segmentId: 'long:1', segmentTotal: 2, index: 1, text: 'Second.', translation: '第二。' },
    { unitId: 'long', unitIds: ['long'], blockId: 'block-long', segmentId: 'long:0', segmentTotal: 2, index: 0, text: 'First. ', translation: '第一。' },
    { unitId: 'bad', unitIds: ['bad'], blockId: 'block-bad', segmentId: 'bad:0', segmentTotal: 1, index: 0, text: 'Broken', error: '失败' }
  ])
  assert.equal(aggregated[0].translation, '第一。第二。')
  assert.equal(aggregated[1].translation, undefined)
  assert.equal(aggregated[1].error, '失败')
})

test('同一段落的多个文本单元只发起一次翻译，并将整段译文聚合到首个单元', async () => {
  const calls: string[] = []
  const coordinator = new PageTranslationCoordinator({
    translate: async (text) => {
      calls.push(text)
      return { translation: `译:${text}` }
    }
  })
  const units: ExtractedWebTextUnit[] = [
    { ...unit('u1', 'Hello '), blockId: 'paragraph-1' },
    { ...unit('u2', 'world'), blockId: 'paragraph-1' },
    { ...unit('u3', '!'), blockId: 'paragraph-1' }
  ]
  const output = await coordinator.run({ ...job, jobId: 'job-paragraph' }, units)

  assert.deepEqual(calls, ['Hello world!'])
  assert.equal(output.results.length, 1)
  assert.deepEqual(output.results[0].unitIds, ['u1', 'u2', 'u3'])
  assert.equal(output.results[0].segmentTotal, 1)
  const aggregated = aggregatePageTranslationUnits(units, output.results)
  assert.equal(aggregated[0].translation, '译:Hello world!')
  assert.equal(aggregated[1].translation, '')
  assert.equal(aggregated[2].translation, '')
})

test('超长段落应在 5000 字以内拆分请求，并按分段顺序合并为完整译文', async () => {
  const source = `${'A'.repeat(4999)}。${'B'.repeat(2)}`
  const calls: string[] = []
  const coordinator = new PageTranslationCoordinator({
    translate: async (text) => {
      calls.push(text)
      return { translation: `[${text.length}]` }
    }
  })
  const units: ExtractedWebTextUnit[] = [{ ...unit('long-paragraph', source), blockId: 'paragraph-long' }]
  const output = await coordinator.run(
    { ...job, jobId: 'job-long-paragraph', maxCharsPerSegment: 5000 },
    units
  )

  assert.ok(calls.length > 1)
  assert.ok(calls.every((text) => text.length <= 5000))
  assert.equal(output.results[0].segmentTotal, calls.length)
  const aggregated = aggregatePageTranslationUnits(units, output.results)
  assert.equal(aggregated[0].translation, calls.map((text) => `[${text.length}]`).join(''))
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

test('并发上限支持动态读取，设置调低后新分段立即受新上限约束', { timeout: 3000 }, async () => {
  let running = 0
  let peak = 0
  const coordinator = new PageTranslationCoordinator({
    concurrency: () => 2,
    translate: async (text) => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 3))
      running -= 1
      return { translation: `译:${text}` }
    }
  })
  const output = await coordinator.run(
    { ...job, jobId: 'job-dynamic-concurrency' },
    [unit('a', '一'), unit('b', '二'), unit('c', '三'), unit('d', '四')]
  )
  assert.equal(peak, 2)
  assert.equal(output.results.length, 4)
})

test('慢速增量写回不应占用翻译并发槽位，网络请求仍按并发上限推进', async () => {
  let translateCalls = 0
  let releaseWriteBack: (() => void) | undefined
  const writeBackGate = new Promise<void>((resolve) => { releaseWriteBack = resolve })
  const coordinator = new PageTranslationCoordinator({
    concurrency: 2,
    translate: async (text) => {
      translateCalls += 1
      return { translation: `译:${text}` }
    }
  })
  const runPromise = coordinator.run(
    { ...job, jobId: 'job-writeback-decoupled' },
    [unit('a', '一'), unit('b', '二'), unit('c', '三'), unit('d', '四')],
    undefined,
    undefined,
    async () => { await writeBackGate }
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(translateCalls, 4)
  releaseWriteBack?.()
  const output = await runPromise
  assert.equal(output.results.length, 4)
})
