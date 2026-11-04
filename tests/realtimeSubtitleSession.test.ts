import assert from 'node:assert/strict'
import test from 'node:test'
import {
  encodeSubtitleSidecarCommand,
  mergeSubtitleSegments,
  parseSubtitleSidecarLine,
  type RealtimeSubtitleSegment
} from '../src/shared/subtitleSession.ts'

/**
 * 校验控制命令使用单行 JSON 编码，避免 sidecar 按行读取时发生粘包。
 * @returns 无返回值。
 * @author zhenghq
 */
test('实时字幕控制命令应编码为单行 JSON', () => {
  const encoded = encodeSubtitleSidecarCommand({
    cmd: 'start',
    source: 'system',
    asr: 'deepgram',
    lang: 'zh-CN'
  })
  assert.ok(encoded.endsWith('\n'))
  assert.equal(encoded.trim().split('\n').length, 1)
  assert.deepEqual(JSON.parse(encoded), {
    cmd: 'start',
    source: 'system',
    asr: 'deepgram',
    lang: 'zh-CN'
  })
  assert.deepEqual(JSON.parse(encodeSubtitleSidecarCommand({ cmd: 'stop' })), {
    cmd: 'stop'
  })
})

/**
 * 校验 sidecar 事件解析对合法事件、空行和未知事件保持稳定。
 * @returns 无返回值。
 * @author zhenghq
 */
test('实时字幕事件解析应接受合法负载并忽略非法负载', () => {
  assert.deepEqual(parseSubtitleSidecarLine('{"type":"ready"}'), { type: 'ready' })
  assert.deepEqual(parseSubtitleSidecarLine('{"type":"partial","text":" hello ","lang":"en"}'), {
    type: 'partial',
    text: 'hello',
    lang: 'en'
  })
  assert.deepEqual(parseSubtitleSidecarLine('{"type":"level","rms":2}'), {
    type: 'level',
    rms: 1
  })
  assert.equal(parseSubtitleSidecarLine('{"type":"level","level":0.25}'), null)
  assert.deepEqual(parseSubtitleSidecarLine('{"type":"error","code":"permission-denied","message":"denied"}'), {
    type: 'error',
    code: 'permission-denied',
    message: 'denied'
  })
  assert.deepEqual(parseSubtitleSidecarLine('{"type":"error","code":"unsupported-platform"}'), {
    type: 'error',
    code: 'unsupported-platform'
  })
  assert.deepEqual(parseSubtitleSidecarLine('{"type":"error","code":"invalid-request"}'), {
    type: 'error',
    code: 'invalid-request'
  })
  assert.equal(parseSubtitleSidecarLine(''), null)
  assert.equal(parseSubtitleSidecarLine('not-json'), null)
  assert.equal(parseSubtitleSidecarLine('{"type":"unknown"}'), null)
  assert.equal(parseSubtitleSidecarLine('{"type":"partial","text":"   "}'), null)
})

/**
 * 校验空识别文本不会生成空字幕。
 * @returns 无返回值。
 * @author zhenghq
 */
test('实时字幕事件解析应忽略空识别文本', () => {
  assert.equal(parseSubtitleSidecarLine('{"type":"partial","text":""}'), null)
  assert.equal(parseSubtitleSidecarLine('{"type":"final","text":"  "}'), null)
})

/**
 * 校验连续 partial 覆盖同一条预览，final 固化原文并开启翻译状态。
 * @returns 无返回值。
 * @author zhenghq
 */
test('partial 应覆盖预览且 final 应固化为待翻译段落', () => {
  let sequence = 0
  const nextId = () => `segment-${++sequence}`
  let state = mergeSubtitleSegments([], { type: 'partial', text: 'Hello' }, nextId, 10)
  state = mergeSubtitleSegments(state.segments, { type: 'partial', text: 'Hello world' }, nextId, 20)
  assert.equal(state.segments.length, 1)
  assert.equal(state.segments[0]?.sourceText, 'Hello world')
  assert.equal(state.segments[0]?.status, 'partial')
  assert.equal(state.activeId, 'segment-1')

  state = mergeSubtitleSegments(state.segments, { type: 'final', text: 'Hello world.' }, nextId, 30)
  assert.equal(state.segments.length, 1)
  assert.equal(state.segments[0]?.sourceText, 'Hello world.')
  assert.equal(state.segments[0]?.status, 'translating')
  assert.equal(state.segments[0]?.updatedAt, 30)
  assert.equal(state.activeId, 'segment-1')
})

/**
 * 校验没有预览时 final 会创建新段落，且历史段落最多保留 20 条。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕段落应保持时间顺序并限制为最近 20 条', () => {
  let sequence = 0
  const nextId = () => `segment-${++sequence}`
  let segments: RealtimeSubtitleSegment[] = []
  for (let index = 0; index < 25; index += 1) {
    const result = mergeSubtitleSegments(
      segments,
      { type: 'final', text: `line-${index}` },
      nextId,
      index
    )
    segments = result.segments
  }
  assert.equal(segments.length, 20)
  assert.equal(segments[0]?.sourceText, 'line-5')
  assert.equal(segments[19]?.sourceText, 'line-24')
})
