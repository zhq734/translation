import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createRealtimeSubtitleViewModel,
  encodeSubtitleSidecarCommand,
  isRealtimeSubtitleAsrProvider,
  mergeSubtitleSegments,
  parseSubtitleSidecarLine,
  splitSubtitleCue,
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
  assert.equal(isRealtimeSubtitleAsrProvider('alibaba'), true)
  assert.equal(isRealtimeSubtitleAsrProvider('custom-dashscope'), true)
  assert.equal(isRealtimeSubtitleAsrProvider('custom-openai'), true)
  assert.equal(isRealtimeSubtitleAsrProvider('gemini'), true)
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

  const gemini = encodeSubtitleSidecarCommand({
    cmd: 'start',
    source: 'microphone',
    asr: 'gemini',
    lang: 'en-US',
    targetLang: 'zh-CN'
  })
  assert.deepEqual(JSON.parse(gemini), {
    cmd: 'start',
    source: 'microphone',
    asr: 'gemini',
    lang: 'en-US',
    targetLang: 'zh-CN'
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
  assert.deepEqual(parseSubtitleSidecarLine(
    '{"type":"final","text":"Hello","lang":"en","translatedText":"你好","translatedLang":"zh-Hans"}'
  ), {
    type: 'final',
    text: 'Hello',
    lang: 'en',
    translatedText: '你好',
    translatedLang: 'zh-Hans'
  })
  assert.deepEqual(parseSubtitleSidecarLine(
    '{"type":"final","text":"abcdef","pauseBoundaries":[0,2,2,6,7,1.5]}'
  ), {
    type: 'final',
    text: 'abcdef',
    pauseBoundaries: [2]
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
 * 校验字幕切分优先保留句末标点，并把每个完整句子变成独立 cue。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕 cue 应优先按句末标点切分并保留标点', () => {
  assert.deepEqual(
    splitSubtitleCue('第一句。第二句！第三句？', { maxLength: 80 }),
    ['第一句。', '第二句！', '第三句？']
  )
})

/**
 * 校验逗号、顿号等次级边界可在句子仍然过长时继续切分。
 * @returns 无返回值。
 * @author zhenghq
 */
test('过长句应继续按逗号和顿号切分', () => {
  const text = '这是一个比较长的说明，包含第一个信息点、第二个信息点和第三个信息点。'
  const cues = splitSubtitleCue(text, { maxLength: 18 })

  assert.ok(cues.length > 1)
  assert.equal(cues.join(''), text)
  assert.ok(cues.every((cue) => cue.length <= 18), cues.join('|'))
  assert.ok(cues.some((cue) => cue.endsWith('，') || cue.endsWith('、')))
})

/**
 * 校验没有标点时会在语义连接词前切分，避免把整段口播塞进一条字幕。
 * @returns 无返回值。
 * @author zhenghq
 */
test('无标点长句应在语义连接词前切分', () => {
  const text =
    '淋巴结宫的成长通道还可以报考养老服务师也可以走向管理岗位取得养老服务师职业资格证书的' +
    '可以在养老服务机构内就业也可以在相关企业单位包括老年人能力评估机构是老化改造企业' +
    '老年教育培培训机构老年产品用品生产流通企业就业截至二零二五年底全国例如这个有时拆分的是合理的'
  const cues = splitSubtitleCue(text, { maxLength: 32 })

  assert.ok(cues.length > 1)
  assert.equal(cues.join(''), text)
  assert.ok(cues.every((cue) => cue.length <= 32), cues.join('|'))
  assert.ok(cues.some((cue) => cue.startsWith('也可以') || cue.startsWith('包括') || cue.startsWith('截至')))
})

/**
 * 校验没有语义边界的超长文本仍按最大长度兜底，且不会切坏英文单词或日期。
 * @returns 无返回值。
 * @author zhenghq
 */
test('长度兜底应避开英文单词和日期内部', () => {
  const text = 'The quick brown fox jumps over the lazy dog 2026-11-05 and keeps running'
  const cues = splitSubtitleCue(text, { maxLength: 20 })

  assert.ok(cues.length > 1)
  assert.equal(cues.join(''), text)
  assert.ok(cues.every((cue) => cue.length <= 20), cues.join('|'))
  const protectedTokens = text.match(/[A-Za-z0-9]+(?:[._'/-][A-Za-z0-9]+)*/gu) ?? []
  const boundaries = cues.slice(0, -1).reduce<number[]>((offsets, cue) => {
    const previous = offsets.at(-1) ?? 0
    offsets.push(previous + cue.length)
    return offsets
  }, [])
  for (const boundary of boundaries) {
    assert.equal(
      protectedTokens.some((token) => {
        const start = text.indexOf(token)
        return boundary > start && boundary < start + token.length
      }),
      false,
      `cue 边界 ${boundary} 不应切断英文单词、数字或日期`
    )
  }
  assert.ok(cues.some((cue) => cue.includes('2026-11-05')))
})

/**
 * 校验短文本和空文本保持原样，避免无意义地制造空 cue。
 * @returns 无返回值。
 * @author zhenghq
 */
test('短文本不应被切分且空文本应返回空数组', () => {
  assert.deepEqual(splitSubtitleCue('短句'), ['短句'])
  assert.deepEqual(splitSubtitleCue('   '), [])
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
 * 校验 Gemini 原生译文随 partial/final 一起写入段落，原生 final 直接完成翻译。
 * @returns 无返回值。
 * @author zhenghq
 */
test('原生译文应随字幕段落更新并在 final 时直接标记完成', () => {
  let sequence = 0
  const nextId = () => `segment-${++sequence}`
  let state = mergeSubtitleSegments([], {
    type: 'partial',
    text: 'Hello',
    translatedText: '你好'
  }, nextId, 10)
  assert.equal(state.segments[0]?.translatedText, '你好')
  assert.equal(state.segments[0]?.status, 'partial')

  state = mergeSubtitleSegments(state.segments, {
    type: 'final',
    text: 'Hello world.',
    translatedText: '你好，世界。'
  }, nextId, 20)
  assert.equal(state.segments.length, 1)
  assert.equal(state.segments[0]?.sourceText, 'Hello world.')
  assert.equal(state.segments[0]?.translatedText, '你好，世界。')
  assert.equal(state.segments[0]?.status, 'translated')
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

/**
 * 校验超长 partial 在显示层只保留最近一条 cue，宿主草稿仍保持完整。
 * @returns 无返回值。
 * @author zhenghq
 */
test('超长 partial 的视图模型应只显示最近一条 cue', () => {
  const text = '淋巴结宫的成长通道还可以报考养老服务师也可以走向管理岗位取得养老服务师职业资格证书的可以在养老服务机构内就业'
  const viewModel = createRealtimeSubtitleViewModel({
    state: 'running',
    audioSource: 'system',
    displayMode: 'bilingual',
    windowVisible: true,
    sourceText: text,
    translatedText: '',
    audioActivity: 'speech-detected',
    segments: [
      {
        id: 'segment-1',
        sourceText: text,
        translatedText: '',
        status: 'partial',
        updatedAt: 1
      }
    ]
  })

  assert.notEqual(viewModel.sourceText, text)
  assert.ok(Array.from(viewModel.sourceText).length <= 32)
  assert.equal(viewModel.sourceText, splitSubtitleCue(text, { maxLength: 32 }).at(-1))
})

/**
 * 校验 partial 携带译文时，视图模型会展示当前 cue 的实时译文。
 * @returns 无返回值。
 * @author zhenghq
 */
test('partial 视图模型应展示当前 cue 的译文', () => {
  const viewModel = createRealtimeSubtitleViewModel({
    state: 'running',
    audioSource: 'system',
    displayMode: 'bilingual',
    windowVisible: true,
    sourceText: 'Hello',
    translatedText: '你好',
    audioActivity: 'speech-detected',
    segments: [
      {
        id: 'segment-1',
        sourceText: 'Hello',
        translatedText: '你好',
        status: 'partial',
        updatedAt: 1
      }
    ]
  })

  assert.equal(viewModel.sourceText, 'Hello')
  assert.equal(viewModel.translatedText, '你好')
})

/**
 * 校验实时草稿轨中的 partial 只显示最近 cue，并同步展示该 cue 的译文。
 * @returns 无返回值。
 * @author zhenghq
 */
test('实时草稿轨应裁剪 partial 原文并展示译文', () => {
  const text = '第一句已经确认。第二句仍在识别中而且内容已经很长需要只显示最近一段实时草稿文本'
  const viewModel = createRealtimeSubtitleViewModel({
    state: 'running',
    audioSource: 'system',
    displayMode: 'bilingual',
    windowVisible: true,
    sourceText: text,
    translatedText: '',
    audioActivity: 'speech-detected',
    displaySegmentId: 'segment-1',
    segments: [
      {
        id: 'segment-1',
        sourceText: '第一句已经确认。',
        translatedText: '第一句译文。',
        status: 'translated',
        updatedAt: 1
      },
      {
        id: 'segment-2',
        sourceText: text,
        translatedText: '当前草稿译文',
        status: 'partial',
        updatedAt: 2
      }
    ]
  })

  assert.ok(viewModel.live)
  assert.ok(Array.from(viewModel.live.sourceText).length <= 32)
  assert.equal(viewModel.live.translatedText, '当前草稿译文')
})
