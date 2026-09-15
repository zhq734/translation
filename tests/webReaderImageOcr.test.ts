import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  mergeWebImageResults,
  processWebImageCandidates,
  type WebImagePipelineDeps
} from '../src/main/webImagePipeline.ts'
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
    sourceFingerprint: 'fp-1',
    ...patch
  }
}

/**
 * 创建图片取图器桩实现。
 * @param patch 需要覆盖的取图结果。
 * @returns 取图器。
 * @author zhenghq
 */
function source(patch: Partial<Awaited<ReturnType<WebImageSource['fetch']>>> = {}): WebImageSource {
  return {
    fetch: async () => ({ ok: true, strategy: 'session', bytes: Buffer.from([1, 2, 3]), ...patch })
  }
}

/**
 * 创建图片管道依赖。
 * @param patch 需要覆盖的依赖。
 * @returns 管道依赖。
 * @author zhenghq
 */
function deps(patch: Partial<WebImagePipelineDeps> = {}): WebImagePipelineDeps {
  return {
    source: source(),
    recognize: async () => ({ text: 'Hello world', score: 0.9 }),
    translate: async () => ({ translation: '你好，世界' }),
    sourceLang: 'auto',
    targetLang: 'ZH',
    ...patch
  }
}

test('首批图片结果合并应原位更新且不得重复计数', () => {
  const first = candidate({ imageId: 'a' })
  const second = candidate({ imageId: 'b', selector: 'body > img:nth-child(2)' })
  const merged = mergeWebImageResults(
    [first, second],
    [
      { ...first, ocrText: 'First', translation: '第一张' },
      { ...second, ocrText: 'Second', translation: '第二张' }
    ]
  )

  assert.equal(merged.length, 2)
  assert.deepEqual(merged.map((item) => item.imageId), ['a', 'b'])
  assert.equal(merged[0].translation, '第一张')
  assert.equal(merged[1].translation, '第二张')
})

test('增量图片结果合并应只追加尚未出现的新候选', () => {
  const first = candidate({ imageId: 'a', translation: '第一张' })
  const second = candidate({ imageId: 'b', selector: 'body > img:nth-child(2)' })
  const merged = mergeWebImageResults(
    [first],
    [
      { ...first, ocrText: 'First', translation: '第一张' },
      { ...second, ocrText: 'Second', translation: '第二张' }
    ]
  )

  assert.equal(merged.length, 2)
  assert.deepEqual(merged.map((item) => item.imageId), ['a', 'b'])
})

test('低质量 OCR 结果不进入翻译且图片失败不抛错', async () => {
  let translated = 0
  const result = await processWebImageCandidates([candidate()], deps({
    recognize: async () => ({ text: '噪声', score: 0.05 }),
    translate: async () => {
      translated += 1
      return { translation: '不应发生' }
    }
  }))

  assert.equal(result.candidates[0].skippedReason, 'low-quality')
  assert.equal(translated, 0)
  assert.deepEqual(result.summary, { imageCandidates: 1, imageProcessed: 0, imageSkipped: 1, imageFailed: 0 })
})

test('图片翻译失败应保留识别原文且不阻塞其他图片', async () => {
  let index = 0
  const result = await processWebImageCandidates(
    [candidate({ imageId: 'a' }), candidate({ imageId: 'b' })],
    deps({
      translate: async () => {
        index += 1
        if (index === 1) throw new Error('provider-unavailable')
        return { translation: '第二张' }
      }
    })
  )

  assert.equal(result.candidates[0].ocrText, 'Hello world')
  assert.equal(result.candidates[0].error, 'provider-unavailable')
  assert.equal(result.candidates[1].translation, '第二张')
  assert.equal(result.summary.imageFailed, 1)
  assert.equal(result.summary.imageProcessed, 1)
})

test('阅读器运行时应在任务代次与语言方向变化时丢弃迟到的图片结果', () => {
  const manager = readFileSync('src/main/webReaderWindow.ts', 'utf8')
  const runMethod = manager.slice(manager.indexOf('async run('), manager.indexOf('/** 取消当前任务'))
  const imageBatch = runMethod.slice(runMethod.indexOf('const processImageBatch'), runMethod.indexOf('const enqueueImageBatch'))

  assert.match(runMethod, /const isCurrentJob = \(\): boolean => this\.activeJobId === jobId/u)
  assert.match(imageBatch, /if \(batch\.length === 0 \|\| !isCurrentJob\(\)\) return/u)
  assert.match(imageBatch, /if \(!isCurrentJob\(\)\) return/u)
  assert.match(runMethod, /if \(!isCurrentJob\(\)\) return[\s\S]*?matchImages/u)
})

test('阅读器运行时图片与文本应共享任务取消并串行写回图片结果', () => {
  const manager = readFileSync('src/main/webReaderWindow.ts', 'utf8')
  const runMethod = manager.slice(manager.indexOf('async run('), manager.indexOf('/** 取消当前任务'))

  assert.match(runMethod, /const imagePromise = enqueueImageBatch\(pendingImageCandidates\)/u)
  assert.match(runMethod, /let imageProcessChain = Promise\.resolve\(\)/u)
  assert.match(runMethod, /imageProcessChain = run\.catch\(\(\) => undefined\)/u)
  assert.match(runMethod, /signal: controller\.signal/u)
  assert.ok(
    runMethod.indexOf('const imagePromise = enqueueImageBatch') < runMethod.indexOf('const stream = this.coordinator.createStream'),
    '图片批次应在文本翻译流建立前排队，保证图片与文本并行且图片失败不阻塞文本'
  )
})

test('阅读器运行时图片缓存命中应跳过取图且失败取消结果不写缓存', () => {
  const manager = readFileSync('src/main/webReaderWindow.ts', 'utf8')
  const runMethod = manager.slice(manager.indexOf('async run('), manager.indexOf('/** 取消当前任务'))

  assert.match(runMethod, /this\.pageCache\.matchImages\(cacheContext, imageCandidates\)/u)
  assert.match(runMethod, /pendingImageCandidates = imageCandidates\.filter/u)
  assert.match(runMethod, /if \(!imageCancelled\) this\.pageCache\.putImages\(finalContext, imageCandidatesResult\)/u)
})

test('主进程图片 OCR 应复用 OCR 引擎偏好与语言配置并执行质量门禁', () => {
  const main = readFileSync('src/main/index.ts', 'utf8')
  const webReader = main.slice(main.indexOf('webReader = new WebReaderManager('), main.indexOf('onWindowStateChanged:'))

  assert.match(webReader, /createImageSource: \(view, signal\) => createWebReaderImageSource\(view, signal\)/u)
  assert.match(webReader, /createOcrDispatcher\(settings\)/u)
  assert.match(webReader, /language: settings\.ocrLang/u)
  assert.match(webReader, /settings\.ocrEnginePreference/u)
  assert.match(webReader, /evaluateOcrQuality\(ocr, settings\.ocrLang\)/u)
  assert.match(webReader, /if \(!quality\.valid \|\| quality\.languageMismatch\) return \{ text: '', score: 0 \}/u)
})
