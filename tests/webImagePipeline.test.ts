import assert from 'node:assert/strict'
import test from 'node:test'
import { processWebImageCandidates, type WebImagePipelineDeps } from '../src/main/webImagePipeline.ts'
import type { WebImageCandidate } from '../src/shared/webPageTranslation.ts'
import type { WebImageSource } from '../src/main/webImageSource.ts'

/**
 * 创建图片候选。
 * @param patch 需要覆盖的字段。
 * @returns 图片候选。
 * @author zhenghq
 */
function candidate(patch: Partial<WebImageCandidate> = {}): WebImageCandidate {
  return {
    imageId: 'image-1',
    kind: 'img',
    selector: 'body > img:nth-child(1)',
    rect: { x: 0, y: 0, width: 200, height: 100 },
    src: 'https://example.com/a.png',
    ...patch
  }
}

/**
 * 创建图片取图器桩实现。
 * @param patch 需要覆盖的结果。
 * @returns 取图器。
 * @author zhenghq
 */
function source(patch: Partial<Awaited<ReturnType<WebImageSource['fetch']>>> = {}): WebImageSource {
  return {
    fetch: async () => ({ ok: true, strategy: 'session', bytes: Buffer.from([1, 2, 3]), ...patch })
  }
}

/**
 * 创建管道依赖。
 * @param patch 需要覆盖的依赖。
 * @returns 依赖对象与调用记录。
 * @author zhenghq
 */
function deps(patch: Partial<WebImagePipelineDeps> = {}): {
  deps: WebImagePipelineDeps
  calls: { recognized: number; translated: string[] }
} {
  const calls = { recognized: 0, translated: [] as string[] }
  const value: WebImagePipelineDeps = {
    source: source(),
    recognize: async () => {
      calls.recognized += 1
      return { text: 'Hello world', score: 0.9 }
    },
    translate: async (text) => {
      calls.translated.push(text)
      return { translation: '你好，世界' }
    },
    sourceLang: 'auto',
    targetLang: 'ZH',
    ...patch
  }
  return { deps: value, calls }
}

test('图片管道应完成取图、识别与翻译', async () => {
  const { deps: injected, calls } = deps()
  const result = await processWebImageCandidates([candidate()], injected)
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].ocrText, 'Hello world')
  assert.equal(result.candidates[0].translation, '你好，世界')
  assert.equal(calls.recognized, 1)
  assert.deepEqual(calls.translated, ['Hello world'])
  assert.deepEqual(result.summary, { imageCandidates: 1, imageProcessed: 1, imageSkipped: 0, imageFailed: 0 })
})

test('OCR 为空或噪声时不进入翻译并记为跳过', async () => {
  const { deps: injected, calls } = deps({ recognize: async () => ({ text: '   ', score: 0.1 }) })
  const result = await processWebImageCandidates([candidate()], injected)
  assert.equal(result.candidates[0].skippedReason, 'no-text')
  assert.equal(calls.translated.length, 0)
  assert.equal(result.summary.imageSkipped, 1)
})

test('取图失败记为跳过且不进入 OCR', async () => {
  const { deps: injected, calls } = deps({
    source: source({ ok: false, bytes: undefined, reason: 'capture-failed' })
  })
  const result = await processWebImageCandidates([candidate()], injected)
  assert.equal(result.candidates[0].skippedReason, 'capture-failed')
  assert.equal(calls.recognized, 0)
  assert.equal(result.summary.imageSkipped, 1)
})

test('OCR 失败记为失败且不进入翻译', async () => {
  const { deps: injected, calls } = deps({
    recognize: async () => {
      throw new Error('engine-unavailable')
    }
  })
  const result = await processWebImageCandidates([candidate()], injected)
  assert.equal(result.candidates[0].error, 'ocr-failed')
  assert.equal(calls.translated.length, 0)
  assert.equal(result.summary.imageFailed, 1)
})

test('翻译失败记为失败但保留识别原文', async () => {
  const { deps: injected } = deps({
    translate: async () => {
      throw new Error('translate-failed')
    }
  })
  const result = await processWebImageCandidates([candidate()], injected)
  assert.equal(result.candidates[0].ocrText, 'Hello world')
  assert.equal(result.candidates[0].error, 'translate-failed')
  assert.equal(result.summary.imageFailed, 1)
})

test('取消后剩余候选不再取图或识别', async () => {
  const controller = new AbortController()
  const { deps: injected, calls } = deps({
    signal: controller.signal,
    recognize: async () => {
      calls.recognized += 1
      controller.abort()
      return { text: 'Hello', score: 0.9 }
    }
  })
  const result = await processWebImageCandidates([candidate({ imageId: 'a' }), candidate({ imageId: 'b' })], injected)
  assert.equal(result.candidates[0].translation, '你好，世界')
  assert.equal(result.candidates[1].skippedReason, 'cancelled')
  assert.equal(calls.recognized, 1)
  assert.equal(result.cancelled, true)
})

test('单张图片异常不应中断其他图片', async () => {
  let index = 0
  const { deps: injected } = deps({
    recognize: async () => {
      index += 1
      if (index === 1) throw new Error('boom')
      return { text: 'Second image', score: 0.9 }
    }
  })
  const result = await processWebImageCandidates(
    [candidate({ imageId: 'a' }), candidate({ imageId: 'b' })],
    injected
  )
  assert.equal(result.candidates[0].error, 'ocr-failed')
  assert.equal(result.candidates[1].translation, '你好，世界')
  assert.deepEqual(result.summary, { imageCandidates: 2, imageProcessed: 1, imageSkipped: 0, imageFailed: 1 })
})
