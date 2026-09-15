import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildWebIncrementalCollectorDrainScript,
  buildWebIncrementalCollectorStartScript,
  buildWebTextExtractionScript
} from '../src/main/webTextExtractionScript.ts'

test('增量收集器应收集新增图片候选并去重', () => {
  const start = buildWebIncrementalCollectorStartScript(300)
  const drain = buildWebIncrementalCollectorDrainScript()

  assert.match(start, /collectImages/u)
  assert.match(start, /pendingImageCandidates/u)
  assert.match(start, /seenImageIds/u)
  assert.match(start, /data-st-image-translation/u)
  assert.match(start, /imageCandidates: initialImages/u)
  assert.match(drain, /pendingImageCandidates\.splice\(0\)/u)
})

test('增量收集器图片过滤应与首次提取保持一致', () => {
  const extraction = buildWebTextExtractionScript()
  const start = buildWebIncrementalCollectorStartScript(300)

  for (const pattern of [/imageMinSize = 64/u, /decorativeSource/u, /imageIgnoredTags/u, /isDecorative/u]) {
    assert.match(extraction, pattern)
    assert.match(start, pattern)
  }
  assert.match(start, /rect\.width \* rect\.height > 20000000/u)
})
