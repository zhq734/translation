import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtractedWebTextUnit } from '../src/shared/webPageTranslation.ts'
import {
  aggregatePageTranslationUnits,
  PageTranslationCoordinator,
  type PageTranslationJob
} from '../src/main/pageTranslationCoordinator.ts'

/**
 * 创建跨块合并测试用文本单元。
 * @param id 单元标识。
 * @param blockId 块标识。
 * @param text 原文。
 * @returns 可直接参与翻译的文本单元。
 * @author zhenghq
 */
function unit(id: string, blockId: string, text: string): ExtractedWebTextUnit {
  return {
    id,
    blockId,
    sourceText: text,
    text,
    category: 'body',
    anchor: { parentSelector: `#${id}`, textNodeIndex: 0, sourceFingerprint: id }
  }
}

/**
 * 创建跨块合并测试任务。
 * @returns 固定语言方向与保护上限的翻译任务。
 * @author zhenghq
 */
function job(): PageTranslationJob {
  return {
    readerId: 'reader-merge',
    pageRevision: 1,
    jobId: 'job-merge',
    scope: 'all',
    maxCharsPerSegment: 5000,
    sourceLang: 'EN',
    targetLang: 'ZH'
  }
}

test('开启跨块合并后相邻短段落只发一次请求', async () => {
  const calls: string[] = []
  const coordinator = new PageTranslationCoordinator({
    concurrency: 1,
    translate: async (text) => {
      calls.push(text)
      return { translation: text.replace(/First\./u, '第一。').replace(/Second\./u, '第二。').replace(/Third\./u, '第三。') }
    }
  })
  const units = [
    unit('a', 'pa', 'First.'),
    unit('b', 'pb', 'Second.'),
    unit('c', 'pc', 'Third.')
  ]
  const output = await coordinator.run({ ...job(), mergeAcrossBlocks: true }, units)

  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes('[[[ST-SEG-0]]]'))
  assert.equal(output.progress.total, 1)
  assert.equal(output.progress.done, 1)

  const aggregated = aggregatePageTranslationUnits(units, output.results)
  assert.deepEqual(aggregated.map((item) => item.translation), ['第一。', '第二。', '第三。'])
})

test('关闭跨块合并时保持逐段请求的既有行为', async () => {
  const calls: string[] = []
  const coordinator = new PageTranslationCoordinator({
    concurrency: 1,
    translate: async (text) => {
      calls.push(text)
      return { translation: `译:${text}` }
    }
  })
  const units = [unit('a', 'pa', 'First.'), unit('b', 'pb', 'Second.')]
  const output = await coordinator.run(job(), units)

  assert.deepEqual(calls, ['First.', 'Second.'])
  assert.equal(output.progress.total, 2)
})

test('模型丢弃分隔标记时应逐段回退，保证每段译文都完整', async () => {
  const calls: string[] = []
  const coordinator = new PageTranslationCoordinator({
    concurrency: 1,
    translate: async (text) => {
      calls.push(text)
      if (text.includes('[[[ST-SEG-0]]]')) return { translation: '第一。第二。' }
      return { translation: `译:${text}` }
    }
  })
  const units = [unit('a', 'pa', 'First.'), unit('b', 'pb', 'Second.')]
  const output = await coordinator.run({ ...job(), mergeAcrossBlocks: true }, units)

  assert.equal(calls.length, 3)
  const aggregated = aggregatePageTranslationUnits(units, output.results)
  assert.deepEqual(aggregated.map((item) => item.translation), ['译:First.', '译:Second.'])
})

test('单个合并批次请求失败时该批全部段落标记失败且不产生译文', async () => {
  const coordinator = new PageTranslationCoordinator({
    concurrency: 1,
    translate: async () => { throw new Error('服务不可用') }
  })
  const units = [unit('a', 'pa', 'First.'), unit('b', 'pb', 'Second.')]
  const output = await coordinator.run({ ...job(), mergeAcrossBlocks: true }, units)

  assert.equal(output.partial, true)
  assert.equal(output.progress.failed, 2)
  const aggregated = aggregatePageTranslationUnits(units, output.results)
  assert.deepEqual(aggregated.map((item) => item.error), ['服务不可用', '服务不可用'])
  assert.equal(aggregated[0].translation, undefined)
})

test('跨块合并不得让单次请求超过字符上限', async () => {
  const calls: string[] = []
  const coordinator = new PageTranslationCoordinator({
    concurrency: 1,
    translate: async (text) => {
      calls.push(text)
      return { translation: text }
    }
  })
  const units = [
    unit('a', 'pa', 'A'.repeat(300)),
    unit('b', 'pb', 'B'.repeat(300)),
    unit('c', 'pc', 'C'.repeat(300))
  ]
  await coordinator.run({ ...job(), maxCharsPerSegment: 700, mergeAcrossBlocks: true }, units)

  assert.ok(calls.length > 1)
  assert.ok(calls.every((text) => text.length <= 700))
})

test('合并批次内的分段必须保持原文顺序，不得因并发而错位', async () => {
  const coordinator = new PageTranslationCoordinator({
    concurrency: 8,
    // 模拟模型不稳定：随机延迟且回显标记，顺序完全依赖本地拆分结果
    translate: async (text) => {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.random() * 5))
      return { translation: text.replace(/First\./u, '第一。').replace(/Second\./u, '第二。') }
    }
  })
  const units = [unit('a', 'pa', 'First.'), unit('b', 'pb', 'Second.')]
  const output = await coordinator.run({ ...job(), mergeAcrossBlocks: true }, units)
  const aggregated = aggregatePageTranslationUnits(units, output.results)
  assert.equal(aggregated[0].translation, '第一。')
  assert.equal(aggregated[1].translation, '第二。')
})

test('同一批次结果应携带相同的翻译通道信息', async () => {
  const coordinator = new PageTranslationCoordinator({
    concurrency: 1,
    translate: async (text) => ({ translation: text, channel: 'AI 翻译', provider: 'ai' })
  })
  const units = [unit('a', 'pa', 'First.'), unit('b', 'pb', 'Second.')]
  const output = await coordinator.run({ ...job(), mergeAcrossBlocks: true }, units)
  assert.equal(output.results.length, 2)
  assert.ok(output.results.every((item) => item.channel === 'AI 翻译' && item.provider === 'ai'))
})

test('拆分结果出现空译文时应回退逐段，不得写入空译文', async () => {
  const calls: string[] = []
  const coordinator = new PageTranslationCoordinator({
    concurrency: 1,
    translate: async (text) => {
      calls.push(text)
      if (text.includes('[[[ST-SEG-0]]]')) return { translation: '第一。\n[[[ST-SEG-0]]]\n' }
      return { translation: `译:${text}` }
    }
  })
  const units = [unit('a', 'pa', 'First.'), unit('b', 'pb', 'Second.')]
  const output = await coordinator.run({ ...job(), mergeAcrossBlocks: true }, units)
  const aggregated = aggregatePageTranslationUnits(units, output.results)
  assert.deepEqual(aggregated.map((item) => item.translation), ['译:First.', '译:Second.'])
})

test('非 AI 通道不支持分隔标记时，后续批次不再重复尝试合并', async () => {
  const calls: string[] = []
  const coordinator = new PageTranslationCoordinator({
    concurrency: 1,
    translate: async (text) => {
      calls.push(text)
      // 模拟 Google 等通道：不会保留标记，只会把标记一起翻掉
      return { translation: text.replace(/\[\[\[ST-SEG-\d+\]\]\]/gu, '（分隔）'), provider: 'google' }
    }
  })
  const units = [
    unit('a', 'pa', 'A'.repeat(200)),
    unit('b', 'pb', 'B'.repeat(200)),
    unit('c', 'pc', 'C'.repeat(200)),
    unit('d', 'pd', 'D'.repeat(200))
  ]
  const output = await coordinator.run(
    { ...job(), maxCharsPerSegment: 500, mergeAcrossBlocks: true, maxSegmentsPerBatch: 2 },
    units
  )

  // 首个合并批次 1 次无效请求 + 2 次回退；后续批次直接逐段，不再发合并请求
  const markerCalls = calls.filter((text) => text.includes('ST-SEG')).length
  assert.equal(markerCalls, 1)
  const aggregated = aggregatePageTranslationUnits(units, output.results)
  assert.ok(aggregated.every((item) => item.translation && !item.translation.includes('ST-SEG')))
})
