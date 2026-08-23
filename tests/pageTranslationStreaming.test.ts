import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtractedWebTextUnit } from '../src/shared/webPageTranslation.ts'
import {
  PageTranslationCoordinator,
  type PageTranslationJob,
  type PageTranslationProgress
} from '../src/main/pageTranslationCoordinator.ts'

/**
 * 创建流式翻译测试文本单元。
 * @param id 单元标识。
 * @param text 待翻译文本。
 * @returns 可直接加入协调器的文本单元。
 * @author zhenghq
 */
function unit(id: string, text: string): ExtractedWebTextUnit {
  return {
    id,
    blockId: `block-${id}`,
    sourceText: text,
    text,
    category: 'body',
    anchor: { parentSelector: `#${id}`, textNodeIndex: 0, sourceFingerprint: `fp-${id}` }
  }
}

/**
 * 创建流式翻译测试任务。
 * @returns 使用固定语言方向和保护上限的测试任务。
 * @author zhenghq
 */
function job(): PageTranslationJob {
  return {
    readerId: 'reader-stream',
    pageRevision: 2,
    jobId: 'job-stream',
    scope: 'all',
    maxCharsPerSegment: 500,
    maxBlocks: 10,
    maxChars: 1000,
    sourceLang: 'auto',
    targetLang: 'ZH'
  }
}

test('流式任务应立即处理首批输入，并在运行中接受新增批次', async () => {
  const translated: string[] = []
  const progress: PageTranslationProgress[] = []
  const coordinator = new PageTranslationCoordinator({
    concurrency: 1,
    translate: async (text) => {
      translated.push(text)
      return { translation: `译:${text}` }
    }
  })

  const stream = coordinator.createStream(job(), (snapshot) => progress.push(snapshot))
  assert.equal(stream.enqueue([unit('one', '第一段')]).accepted, 1)
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(translated, ['第一段'])

  assert.equal(stream.enqueue([unit('two', '第二段')]).accepted, 1)
  stream.closeInput()
  const result = await stream.result

  assert.deepEqual(translated, ['第一段', '第二段'])
  assert.equal(result.progress.discovered, 2)
  assert.equal(result.progress.queued, 0)
  assert.equal(result.progress.done, 2)
  assert.ok(progress.every((item, index) => index === 0 || item.done >= progress[index - 1].done))
})

test('流式任务应去重、遵守容量上限，并等待输入关闭和队列清空后完成', async () => {
  let settled = false
  const coordinator = new PageTranslationCoordinator({
    translate: async (text) => ({ translation: text })
  })
  const stream = coordinator.createStream({ ...job(), maxBlocks: 2, maxChars: 6 })
  stream.result.then(() => { settled = true })

  assert.deepEqual(stream.enqueue([unit('one', 'abc'), unit('one', 'abc')]), {
    accepted: 1,
    duplicate: 1,
    truncated: 0
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  assert.equal(settled, false)
  assert.deepEqual(stream.enqueue([unit('two', 'def'), unit('three', 'g')]), {
    accepted: 1,
    duplicate: 0,
    truncated: 1
  })
  stream.closeInput()

  const result = await stream.result
  assert.equal(result.results.length, 2)
  assert.equal(result.partial, true)
  assert.equal(result.progress.total, 2)
})

test('流式任务去重键应区分 Shadow DOM 路径和同一元素的不同语义属性', async () => {
  const coordinator = new PageTranslationCoordinator({
    translate: async (text) => ({ translation: text })
  })
  const base = unit('shared', 'Same text')
  const stream = coordinator.createStream(job())
  const result = stream.enqueue([
    { ...base, id: 'shadow-one', anchor: { ...base.anchor, shadowPath: [0, 1] } },
    { ...base, id: 'shadow-two', anchor: { ...base.anchor, shadowPath: [0, 2] } },
    { ...base, id: 'placeholder', anchor: { ...base.anchor, semanticAttribute: 'placeholder' } },
    { ...base, id: 'aria-label', anchor: { ...base.anchor, semanticAttribute: 'aria-label' } }
  ])
  stream.closeInput()
  await stream.result

  assert.deepEqual(result, { accepted: 4, duplicate: 0, truncated: 0 })
})

test('流式任务取消后不得处理后续输入或提交迟到结果', async () => {
  let release: (() => void) | undefined
  const controller = new AbortController()
  const coordinator = new PageTranslationCoordinator({
    concurrency: 1,
    translate: async (text) => {
      await new Promise<void>((resolve) => { release = resolve })
      return { translation: text }
    }
  })
  const stream = coordinator.createStream(job(), undefined, controller.signal)
  stream.enqueue([unit('one', '第一段')])
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  controller.abort()
  assert.equal(stream.enqueue([unit('two', '第二段')]).accepted, 0)
  release?.()
  stream.closeInput()

  const result = await stream.result
  assert.equal(result.results.length, 0)
  assert.equal(result.progress.cancelled, true)
})
