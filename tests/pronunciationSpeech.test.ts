import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createPronunciationPlaybackCoordinator } from '../src/renderer/src/pronunciationPlayback.ts'
import { startPronunciationSpeechFallback } from '../src/renderer/src/pronunciationSpeechFallback.ts'

test('原文段落、原文单词和译文播放应共享互斥会话', () => {
  const stopped: string[] = []
  const coordinator = createPronunciationPlaybackCoordinator({
    onStop: (target) => stopped.push(target)
  })

  const translation = coordinator.start('translation')
  const word = coordinator.start('word')
  const source = coordinator.start('source')

  assert.equal(translation.isCurrent(), false)
  assert.equal(word.isCurrent(), false)
  assert.equal(source.isCurrent(), true)
  assert.deepEqual(stopped, ['translation', 'word'])
  assert.equal(coordinator.activeTarget(), 'source')
})

test('重复点击同一播放目标应停止当前会话', () => {
  const stopped: string[] = []
  const coordinator = createPronunciationPlaybackCoordinator({
    onStop: (target) => stopped.push(target)
  })

  const first = coordinator.toggle('word')
  assert.equal(first.action, 'start')
  assert.equal(first.lease?.isCurrent(), true)

  const second = coordinator.toggle('word')
  assert.equal(second.action, 'stop')
  assert.equal(first.lease?.isCurrent(), false)
  assert.equal(coordinator.activeTarget(), null)
  assert.deepEqual(stopped, ['word'])
})

test('新翻译应停止旧会话并使迟到回调失效', () => {
  const stopped: string[] = []
  const coordinator = createPronunciationPlaybackCoordinator({
    onStop: (target) => stopped.push(target)
  })

  const oldWord = coordinator.start('word')
  const newTranslation = coordinator.start('translation')
  assert.equal(oldWord.isCurrent(), false)
  assert.equal(newTranslation.isCurrent(), true)
  assert.deepEqual(stopped, ['word'])
})

test('Renderer 应把三种播放入口接入统一协调器并在关闭时清理', () => {
  const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')

  assert.match(renderer, /createPronunciationPlaybackCoordinator/u)
  assert.match(renderer, /togglePronunciationPlayback\(['"]translation['"]\)/u)
  assert.match(renderer, /togglePronunciationPlayback\(['"]source['"]\)/u)
  assert.match(renderer, /togglePronunciationPlayback\(['"]word['"]\)/u)
  assert.match(renderer, /stopPronunciationPlayback\(\)/u)
  assert.match(renderer, /function closePopup[\s\S]{0,500}stopPronunciationPlayback/u)
})

test('Renderer 应在语音自然结束、模式切换和原文变化时清理旧播放会话', () => {
  const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')

  assert.match(renderer, /finishPronunciationPlayback\(['"]translation['"],\s*lease\)/u)
  assert.match(renderer, /function enterManualMode\(\): void \{[\s\S]{0,220}stopPronunciationPlayback\(\)/u)
  assert.match(renderer, /function leaveManualMode\(\): void \{[\s\S]{0,220}stopPronunciationPlayback\(\)/u)
  assert.match(renderer, /function handleManualOpen\(\): void \{[\s\S]{0,220}stopPronunciationPlayback\(\)/u)
  assert.match(renderer, /function handleSelectionOpen\(\): void \{[\s\S]{0,400}stopPronunciationPlayback\(\)/u)
  assert.match(renderer, /lastOriginal !== payload\.original[\s\S]{0,180}(?:closePronunciation|stopPronunciationPlayback)/u)
})

test('原文朗读应严格使用 detectedLang ?? sourceLang，不读取译文目标语言', () => {
  const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')

  assert.match(renderer, /selectionOriginalSpeechLanguage\s*=\s*payload\.detectedLang\s*\?\?\s*payload\.sourceLang/u)
  assert.match(renderer, /function toggleSourcePlayback\(\)[\s\S]{0,500}const language = selectionOriginalSpeechLanguage/u)
  assert.doesNotMatch(renderer, /function toggleSourcePlayback\(\)[\s\S]{0,500}(?:selectionSpeechLanguage|targetLangEl\.value)/u)
})

test('Edge 语音偏好下，单词 TTS 应优先 Edge 且不重复启动系统语音', async () => {
  const calls: string[] = []
  const result = await startPronunciationSpeechFallback('hello', {
    speechProvider: 'edge',
    edge: {
      start: async () => {
        calls.push('edge')
        return { ok: true }
      },
      isSpeaking: () => true
    },
    system: {
      start: () => {
        calls.push('system')
        return { ok: true }
      },
      isSpeaking: () => true
    }
  })

  assert.deepEqual(result, { status: 'started', provider: 'edge' })
  assert.deepEqual(calls, ['edge'])
})

test('Edge 播放完成返回成功后不得再次启动系统语音', async () => {
  const calls: string[] = []
  const result = await startPronunciationSpeechFallback('hello', {
    speechProvider: 'edge',
    edge: {
      start: async () => {
        calls.push('edge')
        return { ok: true }
      },
      // 真实 Edge 控制器在播放完成时才返回成功，此时播放状态已经结束。
      isSpeaking: () => false
    },
    system: {
      start: () => {
        calls.push('system')
        return { ok: true }
      },
      isSpeaking: () => true
    }
  })

  assert.deepEqual(result, { status: 'started', provider: 'edge' })
  assert.deepEqual(calls, ['edge'])
})

test('单词 TTS 会话取消后不得继续回退系统语音', async () => {
  const calls: string[] = []
  const controller = new AbortController()
  const result = await startPronunciationSpeechFallback('hello', {
    speechProvider: 'edge',
    signal: controller.signal,
    edge: {
      start: async () => {
        calls.push('edge')
        controller.abort()
        return { ok: false, error: 'cancelled' }
      },
      isSpeaking: () => false
    },
    system: {
      start: () => {
        calls.push('system')
        return { ok: true }
      },
      isSpeaking: () => true
    }
  })

  assert.deepEqual(result, { status: 'failed' })
  assert.deepEqual(calls, ['edge'])
})

test('Edge 合成失败时单词 TTS 应回退系统语音', async () => {
  const calls: string[] = []
  const result = await startPronunciationSpeechFallback('hello', {
    speechProvider: 'edge',
    edge: {
      start: async () => {
        calls.push('edge')
        return { ok: false, error: 'unavailable' }
      },
      isSpeaking: () => false
    },
    system: {
      start: () => {
        calls.push('system')
        return { ok: true }
      },
      isSpeaking: () => true
    }
  })

  assert.deepEqual(result, { status: 'started', provider: 'system' })
  assert.deepEqual(calls, ['edge', 'system'])
})

test('系统语音偏好下，单词 TTS 不应发起 Edge 请求', async () => {
  const calls: string[] = []
  const result = await startPronunciationSpeechFallback('hello', {
    speechProvider: 'system',
    edge: {
      start: async () => {
        calls.push('edge')
        return { ok: true }
      },
      isSpeaking: () => true
    },
    system: {
      start: () => {
        calls.push('system')
        return { ok: true }
      },
      isSpeaking: () => true
    }
  })

  assert.deepEqual(result, { status: 'started', provider: 'system' })
  assert.deepEqual(calls, ['system'])
})

test('系统语音启动成功后不得因瞬时 isSpeaking=false 判定失败并取消播放', async () => {
  const result = await startPronunciationSpeechFallback('splendiferousness', {
    speechProvider: 'system',
    edge: {
      start: () => ({ ok: false, error: 'unavailable' }),
      isSpeaking: () => false
    },
    system: {
      start: () => ({ ok: true }),
      // Electron 刚调用 speak 时，状态回调可能短暂回到 false；start 的成功结果才是启动依据。
      isSpeaking: () => false
    }
  })

  assert.deepEqual(result, { status: 'started', provider: 'system' })
})

test('Renderer 在系统语音刚启动时不得用瞬时播放状态停止原文或译文会话', () => {
  const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')
  const startTranslationPlayback =
    renderer.match(/async function startTranslationPlayback[\s\S]*?\n\}/u)?.[0] ?? ''
  const toggleSourcePlayback = renderer.match(/function toggleSourcePlayback[\s\S]*?\n\}/u)?.[0] ?? ''
  const toggleWordPlayback = renderer.match(/async function toggleWordPlayback[\s\S]*?\n\}/u)?.[0] ?? ''

  assert.doesNotMatch(
    startTranslationPlayback,
    /if \(lease\.isCurrent\(\) && !isSpeechPlaying\(\)\) pronunciationPlayback\.stop\(\)/u
  )
  assert.doesNotMatch(
    toggleSourcePlayback,
    /!result\.ok \|\| !lease\.isCurrent\(\) \|\| !systemSpeechController\.isSpeaking\(\)/u
  )
  assert.doesNotMatch(
    toggleWordPlayback,
    /\}\s*if \(!isSpeechPlaying\(\)\) pronunciationPlayback\.stop\(\)/u
  )
})

test('Renderer 单词发音必须通过统一兜底函数选择 Edge 或系统语音', () => {
  const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')
  const toggleWordPlayback = renderer.match(/async function toggleWordPlayback[\s\S]*?\n\}/u)?.[0] ?? ''
  const playWordAudio = renderer.match(/function playWordAudio[\s\S]*?\n\}/u)?.[0] ?? ''

  assert.match(toggleWordPlayback, /startPronunciationSpeechFallback\(/u)
  assert.doesNotMatch(toggleWordPlayback, /systemSpeechController\.start\(/u)
  assert.match(playWordAudio, /fallbackWordSpeech\(/u)
  assert.doesNotMatch(playWordAudio, /systemSpeechController\.start\(/u)
  assert.match(renderer, /async function fallbackWordSpeech[\s\S]{0,700}startPronunciationSpeechFallback\(/u)
})
