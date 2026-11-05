import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createRealtimeSubtitleViewModel,
  encodeSubtitleSidecarCommand,
  isRealtimeSubtitleAsrProvider,
  mergeSubtitleSegments,
  parseSubtitleSidecarLine,
  type RealtimeSubtitleSegment
} from '../src/shared/subtitleSession.ts'

/**
 * 校验 WebSocket ASR 是受支持的实时字幕提供商。
 * @returns 无返回值。
 * @author zhenghq
 */
test('WebSocket ASR 应是合法的实时字幕提供商', () => {
  assert.equal(isRealtimeSubtitleAsrProvider('websocket'), true)
  assert.equal(isRealtimeSubtitleAsrProvider('deepgram'), true)
  assert.equal(isRealtimeSubtitleAsrProvider('whisper'), true)
  assert.equal(isRealtimeSubtitleAsrProvider('web-socket'), false)
})

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
  assert.deepEqual(parseSubtitleSidecarLine('{"type":"status","state":"stopped"}'), {
    type: 'status',
    state: 'idle'
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
 * 校验服务端按句末标点拆分的多条 final 会各自成为独立段落，不再粘成一段。
 * @returns 无返回值。
 * @author zhenghq
 */
test('连续 final 应按句拆成独立段落且只展示最后一句', () => {
  let sequence = 0
  const nextId = () => `segment-${++sequence}`
  const sentences = [
    '蔡永嘉,你听明白了吗?',
    '听明白了,一会儿行政大队就去忍。',
    '你们把李小交接,是。'
  ]
  let state = mergeSubtitleSegments(
    [],
    { type: 'partial', text: sentences.join('') },
    nextId,
    10
  )

  sentences.forEach((sentence, index) => {
    state = mergeSubtitleSegments(
      state.segments,
      { type: 'final', text: sentence },
      nextId,
      20 + index
    )
  })

  assert.equal(state.segments.length, 3)
  assert.deepEqual(
    state.segments.map((segment) => segment.sourceText),
    sentences
  )
  assert.deepEqual(
    state.segments.map((segment) => segment.status),
    ['translating', 'translating', 'translating']
  )

  const viewModel = createRealtimeSubtitleViewModel({
    state: 'running',
    audioSource: 'system',
    displayMode: 'bilingual',
    windowVisible: true,
    sourceText: sentences.join(''),
    translatedText: '上一句译文',
    audioActivity: 'speech-detected',
    segments: state.segments
  })
  assert.equal(viewModel.sourceText, sentences[2])
  assert.equal(viewModel.translatedText, '')
})

/**
 * 校验新 partial 只能落到最后一个未定稿段落，不得回头覆盖历史 partial。
 * @returns 无返回值。
 * @author zhenghq
 */
test('新 partial 不得复用历史 partial 段落', () => {
  let sequence = 0
  const nextId = () => `segment-${++sequence}`
  const segments: RealtimeSubtitleSegment[] = [
    {
      id: 'segment-old',
      sourceText: '旧句',
      translatedText: '旧译文',
      status: 'partial',
      updatedAt: 10
    },
    {
      id: 'segment-current',
      sourceText: '当前句',
      translatedText: '',
      status: 'translating',
      updatedAt: 20
    }
  ]

  const result = mergeSubtitleSegments(
    segments,
    { type: 'partial', text: '新句' },
    nextId,
    30
  )

  assert.equal(result.segments.length, 3)
  assert.equal(result.segments[0]?.sourceText, '旧句')
  assert.equal(result.segments[0]?.status, 'partial')
  assert.equal(result.segments[1]?.sourceText, '当前句')
  assert.equal(result.segments[2]?.sourceText, '新句')
  assert.equal(result.activeId, 'segment-1')
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

/**
 * 校验视图模型只展示最新段落的译文，避免旧段落译文残留在新句下方。
 * @returns 无返回值。
 * @author zhenghq
 */
test('视图模型应只展示最新段落的译文', () => {
  const viewModel = createRealtimeSubtitleViewModel({
    state: 'running',
    audioSource: 'system',
    displayMode: 'bilingual',
    windowVisible: true,
    sourceText: '第二句',
    translatedText: '上一句译文',
    audioActivity: 'speech-detected',
    segments: [
      {
        id: 'segment-1',
        sourceText: '第一句',
        translatedText: '上一句译文',
        status: 'translated',
        updatedAt: 1
      },
      {
        id: 'segment-2',
        sourceText: '第二句',
        translatedText: '',
        status: 'partial',
        updatedAt: 2
      }
    ]
  })

  assert.equal(viewModel.sourceText, '第二句')
  assert.equal(viewModel.translatedText, '')
})
