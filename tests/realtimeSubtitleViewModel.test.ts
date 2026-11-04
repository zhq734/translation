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
      sourceText: 'Hello',
      translatedText: '',
      status: 'partial',
      audioActivity: 'speech-detected',
      empty: false,
      error: ''
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
})
