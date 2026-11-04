import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  beginPronunciationLookup,
  closePronunciationCard,
  createPronunciationCardState,
  selectPronunciationVariant,
  settlePronunciationLookup
} from '../src/renderer/src/pronunciationCard.ts'
import {
  createPronunciationClickGate,
  createPronunciationInteractionDeduper,
  shouldLookupPronunciationWord
} from '../src/renderer/src/pronunciationInteraction.ts'

test('单击、拖拽、选区和双击应被正确区分', () => {
  assert.equal(shouldLookupPronunciationWord({
    targetKind: 'word',
    hasSelection: false,
    pointerTravel: 2,
    clickCount: 1
  }), true)
  assert.equal(shouldLookupPronunciationWord({
    targetKind: 'word',
    hasSelection: false,
    pointerTravel: 12,
    clickCount: 1
  }), false)
  assert.equal(shouldLookupPronunciationWord({
    targetKind: 'word',
    hasSelection: true,
    pointerTravel: 2,
    clickCount: 1
  }), false)
  assert.equal(shouldLookupPronunciationWord({
    targetKind: 'word',
    hasSelection: false,
    pointerTravel: 2,
    clickCount: 2
  }), false)
  assert.equal(shouldLookupPronunciationWord({
    targetKind: 'text',
    hasSelection: false,
    pointerTravel: 2,
    clickCount: 1
  }), false)
})

test('音标卡应经历隐藏、加载、成功和关闭状态', () => {
  const hidden = createPronunciationCardState()
  assert.deepEqual(hidden, {
    status: 'hidden', word: '', requestId: 0, variants: [], context: 'source', definitions: []
  })

  const loading = beginPronunciationLookup(hidden, 'hello', 7)
  assert.deepEqual(loading, {
    status: 'loading', word: 'hello', requestId: 7, variants: [], context: 'source', definitions: []
  })

  const available = settlePronunciationLookup(loading, 7, {
    status: 'available',
    word: 'hello',
    language: 'en',
    variants: [{ id: 'us-0', accent: 'US', ipa: '/həˈloʊ/', hasAudio: true }],
    source: 'dictionaryapi'
  })
  assert.equal(available.status, 'available')
  assert.equal(available.variants.length, 1)
  assert.deepEqual(closePronunciationCard(available), createPronunciationCardState())
})

test('迟到音标结果不得覆盖当前单词', () => {
  const first = beginPronunciationLookup(createPronunciationCardState(), 'hello', 1)
  const second = beginPronunciationLookup(first, 'world', 2)
  const staleResult = settlePronunciationLookup(second, 1, {
    status: 'available',
    word: 'hello',
    language: 'en',
    variants: [{ id: 'us-0', accent: 'US', ipa: '/həˈloʊ/', hasAudio: true }],
    source: 'dictionaryapi'
  })

  assert.equal(staleResult, second)
  assert.equal(second.word, 'world')
})

test('Renderer 应复用当前可见音标卡并忽略关闭后的迟到查询', () => {
  const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')

  assert.match(renderer, /pronunciationCard\.word === parsed\.word/u)
  assert.match(renderer, /pronunciationCard\.status !== ['"]hidden['"]/u)
  assert.match(renderer, /pronunciationLookupSequence \+= 1/u)
})

test('发音按钮应提供包含单词、口音和播放状态的可访问名称', () => {
  const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')
  const renderCard = renderer.match(/function renderPronunciationCard\(\): void \{[\s\S]*?\n\}/u)?.[0] ?? ''

  assert.match(renderCard, /aria-pressed/u)
  assert.match(renderCard, /pronunciationPlayVariant[\s\S]{0,260}(?:accent|variant\.accent)/u)
  assert.match(renderer, /pronunciationPlayVariantPlaying/u)
  assert.match(renderer, /activeVariantId/u)
})

test('普通发音按钮的无障碍名称模板应包含口音占位符', () => {
  const chinese = readFileSync('src/shared/i18n/catalog.zh-CN.base.ts', 'utf8')
  const english = readFileSync('src/shared/i18n/catalog.en-US.base.ts', 'utf8')

  assert.match(chinese, /'popup\.pronunciationPlayVariant':\s*'播放 \{\{word\}\} 的\{\{accent\}\}发音'/u)
  assert.match(english, /'popup\.pronunciationPlayVariant':\s*'Play \{\{accent\}\} pronunciation of \{\{word\}\}'/u)
})

test('双击的第一次 click 应延迟到双击窗口结束后再决定是否查词', () => {
  const scheduled: Array<() => void> = []
  const gate = createPronunciationClickGate({
    delayMs: 250,
    schedule: (callback) => {
      scheduled.push(callback)
      return scheduled.length
    },
    cancel: () => {}
  })

  let lookups = 0
  gate.click(() => { lookups += 1 })
  assert.equal(lookups, 0)
  assert.equal(scheduled.length, 1)

  gate.doubleClick()
  scheduled[0]?.()
  assert.equal(lookups, 0)
})

test('单击在双击窗口结束后只触发一次查词', () => {
  const scheduled: Array<() => void> = []
  const gate = createPronunciationClickGate({
    delayMs: 250,
    schedule: (callback) => {
      scheduled.push(callback)
      return scheduled.length
    },
    cancel: () => {}
  })

  let lookups = 0
  gate.click(() => { lookups += 1 })
  scheduled[0]?.()
  assert.equal(lookups, 1)
})

test('同一交互窗口内重复的同词点击只应激活一次', () => {
  let now = 1_000
  const deduper = createPronunciationInteractionDeduper({
    windowMs: 350,
    now: () => now
  })

  assert.equal(deduper.claim('hello', 'source'), true)
  assert.equal(deduper.claim('hello', 'source'), false)
  now += 349
  assert.equal(deduper.claim('hello', 'source'), false)
  now += 1
  assert.equal(deduper.claim('hello', 'source'), true)
})

test('去重不应阻止切换不同单词或不同区域', () => {
  let now = 1_000
  const deduper = createPronunciationInteractionDeduper({
    windowMs: 350,
    now: () => now
  })

  assert.equal(deduper.claim('hello', 'source'), true)
  assert.equal(deduper.claim('world', 'source'), true)
  assert.equal(deduper.claim('world', 'translation'), true)
})

test('双音标默认播放应固定选择第一个音标，而不是跳过后一个无音频项', () => {
  const variants = [
    { id: 'us-0', accent: 'US' as const, ipa: '/həˈloʊ/', hasAudio: false },
    { id: 'uk-1', accent: 'UK' as const, ipa: '/həˈləʊ/', hasAudio: true }
  ]

  assert.equal(selectPronunciationVariant(variants)?.id, 'us-0')
  assert.equal(selectPronunciationVariant(variants, 'uk-1')?.id, 'uk-1')
  assert.equal(selectPronunciationVariant([]), undefined)
})

test('Renderer 应在释义查询和自动发音前统一执行同词去重', () => {
  const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')
  const activatePronunciationWord =
    renderer.match(/function activatePronunciationWord\([\s\S]*?\n\}/u)?.[0] ?? ''

  assert.match(renderer, /createPronunciationInteractionDeduper/u)
  assert.match(activatePronunciationWord, /claim\(word, context\)/u)
  assert.ok(
    activatePronunciationWord.indexOf('claim(word, context)') < activatePronunciationWord.indexOf('lookupPronunciation('),
    '去重必须发生在释义查询之前'
  )
  assert.ok(
    activatePronunciationWord.indexOf('claim(word, context)') < activatePronunciationWord.indexOf('playPronunciationWordImmediately('),
    '去重必须发生在自动发音之前'
  )
})

test('音标卡状态应保留释义和当前展示区域', () => {
  const hidden = createPronunciationCardState()
  const loading = beginPronunciationLookup(hidden, 'hello', 1, 'translation')
  const available = settlePronunciationLookup(loading, 1, {
    status: 'available',
    word: 'hello',
    language: 'en',
    variants: [{ id: 'other-0', accent: 'other', ipa: '/həˈləʊ/', hasAudio: false }],
    definitions: [{ text: 'int. 喂；哈喽', language: 'zh', source: 'iscorevoc' }],
    source: 'iscorevoc'
  })

  assert.equal(available.context, 'translation')
  assert.deepEqual(available.definitions, [{
    text: 'int. 喂；哈喽',
    language: 'zh',
    source: 'iscorevoc'
  }])
})

test('迟到结果不得把原文音标卡移动到译文区域', () => {
  const source = beginPronunciationLookup(createPronunciationCardState(), 'hello', 1, 'source')
  const translation = beginPronunciationLookup(source, 'world', 2, 'translation')
  const stale = settlePronunciationLookup(translation, 1, {
    status: 'available',
    word: 'hello',
    language: 'en',
    variants: [],
    source: 'dictionaryapi'
  })

  assert.equal(stale, translation)
  assert.equal(stale.context, 'translation')
})

test('无音标时音标卡仍应渲染单词 TTS 播放按钮', () => {
  const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')
  const renderCard = renderer.match(/function renderPronunciationCard\(\): void \{[\s\S]*?\n\}/u)?.[0] ?? ''

  assert.match(renderCard, /pronunciationUnavailable/u)
  assert.match(renderCard, /createPronunciationWordPlayButton\(\)/u)
  assert.match(
    renderer,
    /pronunciationVariantsEl\.addEventListener\(['"]click['"][\s\S]{0,500}togglePronunciationPlayback\(['"]word['"]/u
  )
})

test('空态单词播放按钮应只由容器事件委托处理一次点击', () => {
  const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')
  const renderCard = renderer.match(/function renderPronunciationCard\(\): void \{[\s\S]*?\n\}/u)?.[0] ?? ''
  const createButton =
    renderer.match(/function createPronunciationWordPlayButton[\s\S]*?\n\}/u)?.[0] ?? ''

  assert.match(renderCard, /createPronunciationWordPlayButton\(\)/u)
  assert.doesNotMatch(createButton, /addEventListener\(['"]click['"]/u)
  assert.match(renderer, /pronunciationVariantsEl\.addEventListener\(['"]click['"]/u)
})

test('译文单词点击门控应与原文共用单击、拖拽、选区和双击规则', () => {
  assert.equal(shouldLookupPronunciationWord({
    targetKind: 'word',
    hasSelection: false,
    pointerTravel: 2,
    clickCount: 1
  }), true)
  assert.equal(shouldLookupPronunciationWord({
    targetKind: 'word',
    hasSelection: true,
    pointerTravel: 2,
    clickCount: 1
  }), false)
  assert.equal(shouldLookupPronunciationWord({
    targetKind: 'word',
    hasSelection: false,
    pointerTravel: 20,
    clickCount: 1
  }), false)
})
