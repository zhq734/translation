import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createRealtimeSubtitleViewModel,
  type RealtimeSubtitleSnapshot
} from '../src/shared/subtitleSession.ts'

/**
 * 创建字幕视图测试用快照。
 * @param patch 需要覆盖的快照字段。
 * @returns 完整字幕快照。
 * @author zhenghq
 */
function snapshot(patch: Partial<RealtimeSubtitleSnapshot> = {}): RealtimeSubtitleSnapshot {
  return {
    state: 'running',
    audioSource: 'system',
    displayMode: 'bilingual',
    windowVisible: true,
    sourceText: 'Hello',
    translatedText: '你好',
    audioActivity: 'speech-detected',
    segments: [],
    ...patch
  }
}

/**
 * 校验三种显示模式只暴露各自需要的文本。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕显示模式应裁剪原文与译文', () => {
  assert.deepEqual(
    createRealtimeSubtitleViewModel(snapshot({ displayMode: 'source' })),
    {
      state: 'running',
      displayMode: 'source',
      segmentId: null,
      sourceText: 'Hello',
      translatedText: '',
      status: 'partial',
      audioActivity: 'speech-detected',
      empty: false,
      error: '',
      committed: null,
      live: null
    }
  )
  assert.equal(createRealtimeSubtitleViewModel(snapshot({ displayMode: 'target' })).sourceText, '')
  assert.equal(
    createRealtimeSubtitleViewModel(snapshot({ displayMode: 'bilingual' })).translatedText,
    '你好'
  )
})

/**
 * 校验没有文本时返回空态，并优先使用最新段落的译文。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕视图应处理空态和最新段落回退', () => {
  const empty = createRealtimeSubtitleViewModel(snapshot({
    sourceText: '',
    translatedText: '',
    audioActivity: 'speech-pending'
  }))
  assert.equal(empty.empty, true)
  assert.equal(empty.status, 'empty')
  assert.equal(empty.audioActivity, 'speech-pending')

  const fallback = createRealtimeSubtitleViewModel(snapshot({
    sourceText: '',
    translatedText: '',
    segments: [{
      id: '1',
      sourceText: 'Latest',
      translatedText: '最新',
      status: 'translated',
      updatedAt: 1
    }]
  }))
  assert.equal(fallback.sourceText, 'Latest')
  assert.equal(fallback.translatedText, '最新')
  assert.equal(fallback.status, 'translated')
  assert.equal(fallback.segmentId, '1')
})

/**
 * 校验新草稿出现时仍保留上一句已确认字幕作为上下文。
 * @returns 无返回值。
 * @author zhenghq
 */
test('新草稿出现时应同时暴露上一句历史和当前实时轨', () => {
  const viewModel = createRealtimeSubtitleViewModel(snapshot({
    sourceText: '第二句',
    translatedText: '',
    segments: [
      {
        id: 'segment-1',
        sourceText: '第一句',
        translatedText: '第一句译文',
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
  }))

  assert.equal(viewModel.segmentId, 'segment-2')
  assert.equal(viewModel.sourceText, '第二句')
  assert.deepEqual(viewModel.committed, {
    segmentId: 'segment-1',
    sourceText: '第一句',
    translatedText: '第一句译文',
    status: 'translated'
  })
  assert.equal(viewModel.live, null)
})

/**
 * 校验展示锁固定上一句时，新到达的实时草稿仍通过独立轨道暴露。
 * @returns 无返回值。
 * @author zhenghq
 */
test('展示锁固定历史句时应同时暴露最新实时轨', () => {
  const viewModel = createRealtimeSubtitleViewModel(snapshot({
    sourceText: 'Next sentence',
    translatedText: '',
    displaySegmentId: 'segment-1',
    segments: [
      {
        id: 'segment-1',
        sourceText: 'First',
        translatedText: '第一句译文',
        status: 'translated',
        updatedAt: 1
      },
      {
        id: 'segment-2',
        sourceText: 'Next sentence',
        translatedText: '',
        status: 'partial',
        updatedAt: 2
      }
    ]
  }))

  assert.equal(viewModel.segmentId, 'segment-1')
  assert.equal(viewModel.sourceText, 'First')
  assert.equal(viewModel.translatedText, '第一句译文')
  assert.deepEqual(viewModel.committed, {
    segmentId: 'segment-1',
    sourceText: 'First',
    translatedText: '第一句译文',
    status: 'translated'
  })
  assert.deepEqual(viewModel.live, {
    segmentId: 'segment-2',
    sourceText: 'Next sentence',
    translatedText: '',
    status: 'partial'
  })
})

/**
 * 校验历史轨同样遵守原文、译文和双语显示模式。
 * @returns 无返回值。
 * @author zhenghq
 */
test('历史轨文本应遵守当前显示模式', () => {
  const segments: RealtimeSubtitleSnapshot['segments'] = [
    {
      id: 'segment-1',
      sourceText: 'First',
      translatedText: '第一句译文',
      status: 'translated',
      updatedAt: 1
    },
    {
      id: 'segment-2',
      sourceText: 'Second',
      translatedText: '',
      status: 'partial',
      updatedAt: 2
    }
  ]

  assert.deepEqual(
    createRealtimeSubtitleViewModel(snapshot({
      displayMode: 'source',
      segments
    })).committed,
    {
      segmentId: 'segment-1',
      sourceText: 'First',
      translatedText: '',
      status: 'translated'
    }
  )
  assert.deepEqual(
    createRealtimeSubtitleViewModel(snapshot({
      displayMode: 'target',
      segments
    })).committed,
    {
      segmentId: 'segment-1',
      sourceText: '',
      translatedText: '第一句译文',
      status: 'translated'
    }
  )
})
