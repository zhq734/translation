import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isWebImageKind,
  isWebImageOverlayPlacement,
  type WebImageCandidate
} from '../src/shared/webPageTranslation.ts'
import {
  buildWebImageId,
  createWebImageAnchor,
  filterWebImageCandidates,
  isWebImageCandidate,
  resolveWebImageRenderDecision,
  selectWebImageSourceStrategy,
  summarizeWebImageProgress
} from '../src/shared/webImageOcr.ts'

/**
 * 创建可复用的图片候选。
 * @param patch 需要覆盖的字段。
 * @returns 完整图片候选。
 * @author zhenghq
 */
function candidate(patch: Partial<WebImageCandidate> = {}): WebImageCandidate {
  return {
    imageId: 'image-1',
    kind: 'img',
    selector: 'body > img:nth-child(1)',
    rect: { x: 10, y: 20, width: 400, height: 300 },
    naturalWidth: 800,
    naturalHeight: 600,
    sourceFingerprint: 'abcd1234',
    ...patch
  }
}

test('图片候选类型与来源类型应只接受约定值', () => {
  assert.equal(isWebImageKind('img'), true)
  assert.equal(isWebImageKind('canvas'), true)
  assert.equal(isWebImageKind('background'), true)
  assert.equal(isWebImageKind('video'), false)
  assert.equal(isWebImageOverlayPlacement('below'), true)
  assert.equal(isWebImageOverlayPlacement('overlay'), true)
  assert.equal(isWebImageOverlayPlacement('above'), false)
  assert.equal(isWebImageCandidate(candidate()), true)
  assert.equal(isWebImageCandidate({}), false)
  assert.equal(isWebImageCandidate({ ...candidate(), rect: { x: 0, y: 0, width: 0, height: 0 } }), false)
})

test('图片标识应稳定且对锚点变化敏感', () => {
  const first = buildWebImageId(candidate())
  assert.equal(first, buildWebImageId(candidate()))
  assert.notEqual(first, buildWebImageId(candidate({ selector: 'body > img:nth-child(2)' })))
  assert.notEqual(first, buildWebImageId(candidate({ sourceFingerprint: 'ffffffff' })))
  assert.notEqual(first, buildWebImageId(candidate({ rect: { x: 11, y: 20, width: 400, height: 300 } })))
})

test('创建图片锚点应保留矩形并派生指纹', () => {
  const anchor = createWebImageAnchor(candidate({ sourceFingerprint: undefined }))
  assert.deepEqual(anchor.rect, { x: 10, y: 20, width: 400, height: 300 })
  assert.equal(typeof anchor.sourceFingerprint, 'string')
  assert.ok((anchor.sourceFingerprint ?? '').length > 0)
})

test('图片候选过滤应排除微小、装饰与重复图片', () => {
  const options = { minSize: 64, maxImages: 3 }
  const result = filterWebImageCandidates([
    candidate({ imageId: 'a' }),
    candidate({ imageId: 'b', rect: { x: 0, y: 0, width: 32, height: 32 } }),
    candidate({ imageId: 'c', decorative: true }),
    candidate({ imageId: 'd' }),
    candidate({ imageId: 'e' }),
    candidate({ imageId: 'f' })
  ], options)
  assert.deepEqual(result.accepted.map((item) => item.imageId), ['a', 'd', 'e'])
  assert.equal(result.skipped, 3)
})

test('图片取图策略应优先会话请求并在必要时回退截图', () => {
  assert.equal(selectWebImageSourceStrategy(candidate({ src: 'https://example.com/a.png' })), 'session')
  assert.equal(selectWebImageSourceStrategy(candidate()), 'capture')
  assert.equal(selectWebImageSourceStrategy(candidate({ kind: 'canvas' })), 'capture')
  assert.equal(selectWebImageSourceStrategy(candidate({ inline: true })), 'capture')
  assert.equal(selectWebImageSourceStrategy(candidate({ requestBlocked: true })), 'capture')
})

test('图片渲染决策应区分模式与展示位置', () => {
  const withTranslation = candidate({ ocrText: 'Hello', translation: '你好' })
  assert.equal(resolveWebImageRenderDecision(withTranslation, 'target', 'below'), 'below')
  assert.equal(resolveWebImageRenderDecision(withTranslation, 'bilingual', 'below'), 'bilingual')
  assert.equal(resolveWebImageRenderDecision(withTranslation, 'target', 'overlay'), 'overlay')
  assert.equal(resolveWebImageRenderDecision(withTranslation, 'source', 'below'), 'none')
  assert.equal(resolveWebImageRenderDecision(candidate({ ocrText: 'Hello' }), 'target', 'below'), 'none')
  assert.equal(resolveWebImageRenderDecision(candidate({ translation: '你好' }), 'target', 'below'), 'none')
})

test('图片进度汇总应区分已处理、跳过与失败', () => {
  const summary = summarizeWebImageProgress([
    candidate({ imageId: 'a', translation: '你好' }),
    candidate({ imageId: 'b', skippedReason: 'too-small' }),
    candidate({ imageId: 'c', error: 'ocr-failed' }),
    candidate({ imageId: 'd' })
  ])
  assert.deepEqual(summary, {
    imageCandidates: 4,
    imageProcessed: 1,
    imageSkipped: 1,
    imageFailed: 1
  })
})
