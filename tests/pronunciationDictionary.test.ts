import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePronunciationDictionaryResponse } from '../src/shared/pronunciationDictionary.ts'

const dictionaryPayload = [
  {
    word: 'hello',
    phonetics: [
      { text: '/həˈloʊ/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/hello-us.mp3' },
      { text: '/həˈləʊ/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/hello-uk.mp3' },
      { text: '/həˈloʊ/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/hello-other.mp3' },
      { text: '/hɛˈloʊ/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/hello.mp3' }
    ],
    license: { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0' },
    sourceUrls: ['https://en.wiktionary.org/wiki/hello']
  }
]

test('音标解析应保守推断美式、英式和其他口音', () => {
  const parsed = parsePronunciationDictionaryResponse(dictionaryPayload, 'hello')

  assert.equal(parsed.result.status, 'available')
  assert.deepEqual(parsed.result.variants.map((variant) => variant.accent), ['US', 'UK', 'other'])
  assert.deepEqual(parsed.result.variants.map((variant) => variant.ipa), ['/həˈloʊ/', '/həˈləʊ/', '/hɛˈloʊ/'])
  assert.deepEqual(parsed.result.attribution, {
    sourceUrl: 'https://en.wiktionary.org/wiki/hello',
    licenseName: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0'
  })
})

test('即使上游先返回英式，音标仍应按美式、英式、其他排序', () => {
  const parsed = parsePronunciationDictionaryResponse([
    {
      phonetics: [
        { text: '/uk/', audio: 'https://example.com/word-uk.mp3' },
        { text: '/us/', audio: 'https://example.com/word-us.mp3' },
        { text: '/other/', audio: 'https://example.com/word.mp3' }
      ]
    }
  ], 'word')

  assert.deepEqual(
    parsed.result.variants.map((variant) => variant.accent),
    ['US', 'UK', 'other']
  )
  assert.deepEqual(
    parsed.result.variants.map((variant) => variant.ipa),
    ['/us/', '/uk/', '/other/']
  )
})

test('音标解析应按 IPA 去重且最多保留三个变体', () => {
  const parsed = parsePronunciationDictionaryResponse([
    {
      phonetics: [
        { text: '/same/', audio: 'https://example.com/word-us.mp3' },
        { text: '/same/', audio: 'https://example.com/word-uk.mp3' },
        { text: '/one/', audio: 'https://example.com/word-uk.mp3' },
        { text: '/two/', audio: 'https://example.com/word.mp3' },
        { text: '/three/', audio: 'https://example.com/word.mp3' }
      ]
    }
  ], 'word')

  assert.equal(parsed.result.variants.length, 3)
  assert.deepEqual(parsed.result.variants.map((variant) => variant.ipa), ['/same/', '/one/', '/two/'])
  assert.equal(new Set(parsed.result.variants.map((variant) => variant.ipa)).size, 3)
})

test('音标解析只根据音频 URL 的明确标记判断口音', () => {
  const parsed = parsePronunciationDictionaryResponse([
    {
      phonetics: [
        { text: '/text-says-us/', audio: 'https://example.com/word.mp3' },
        { text: '/uk-in-text/', audio: 'https://example.com/word-uk.mp3' }
      ]
    }
  ], 'word')

  assert.deepEqual(parsed.result.variants.map((variant) => variant.accent), ['UK', 'other'])
})

test('音标解析应保留无音频变体并只登记可信音频 URL', () => {
  const parsed = parsePronunciationDictionaryResponse([
    { phonetics: [{ text: '/no-audio/' }, { text: '/with-audio/', audio: 'https://example.com/word-us.mp3' }] }
  ], 'word')

  assert.deepEqual(parsed.result.variants.map((variant) => variant.hasAudio), [true, false])
  assert.equal(Object.keys(parsed.audioUrls).length, 1)
  assert.equal(Object.values(parsed.audioUrls)[0], 'https://example.com/word-us.mp3')
  assert.equal(JSON.stringify(parsed.result).includes('https://example.com/word-us.mp3'), false)
})

test('缺失音标、异常结构和空响应应返回脱敏不可用结果', () => {
  const missingIpa = parsePronunciationDictionaryResponse([
    { phonetics: [{ audio: 'https://example.com/word.mp3' }] }
  ], 'word')
  assert.deepEqual(missingIpa.result, {
    status: 'unavailable',
    word: 'word',
    language: 'en',
    variants: [],
    source: 'dictionaryapi'
  })

  for (const payload of [null, {}, 'invalid', [], [null], [{ phonetics: 'invalid' }]]) {
    const parsed = parsePronunciationDictionaryResponse(payload, 'word')
    assert.equal(parsed.result.status, 'unavailable')
    assert.deepEqual(parsed.result.variants, [])
    assert.deepEqual(parsed.audioUrls, {})
  }
})
import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePronunciationDictionaryResponse } from '../src/shared/pronunciationDictionary.ts'

test('真实 hello 结构应忽略无 text 的 phonetics 并保留英式与美式 IPA', () => {
  const parsed = parsePronunciationDictionaryResponse([
    {
      word: 'hello',
      phonetics: [
        { audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/hello-au.mp3' },
        { text: '/həˈləʊ/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/hello-uk.mp3' },
        { text: '/həˈloʊ/', audio: '' }
      ],
      meanings: [
        {
          partOfSpeech: 'interjection',
          definitions: [{ definition: 'A greeting used when meeting someone.' }]
        }
      ]
    }
  ], 'hello')

  assert.equal(parsed.result.status, 'available')
  assert.deepEqual(parsed.result.variants.map((variant) => variant.ipa), ['/həˈloʊ/', '/həˈləʊ/'])
  assert.deepEqual(parsed.result.definitions, [{
    text: 'A greeting used when meeting someone.',
    partOfSpeech: 'interjection',
    language: 'en',
    source: 'dictionaryapi'
  }])
})

test('词典响应顶层 phonetic 应作为音标回退', () => {
  const parsed = parsePronunciationDictionaryResponse([
    {
      word: 'hello',
      phonetic: '/həˈləʊ/',
      phonetics: [{ audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/hello-uk.mp3' }]
    }
  ], 'hello')

  assert.equal(parsed.result.status, 'available')
  assert.deepEqual(parsed.result.variants.map((variant) => variant.ipa), ['/həˈləʊ/'])
  assert.equal(parsed.result.variants[0]?.hasAudio, true)
})

test('顶层 phonetic 不应覆盖已有 phonetics[].text', () => {
  const parsed = parsePronunciationDictionaryResponse([
    {
      phonetic: '/fallback/',
      phonetics: [{ text: '/preferred/', audio: 'https://example.com/hello-us.mp3' }]
    }
  ], 'hello')

  assert.deepEqual(parsed.result.variants.map((variant) => variant.ipa), ['/preferred/'])
})

test('词典释义应去重、限制数量并忽略空定义', () => {
  const parsed = parsePronunciationDictionaryResponse([
    {
      phonetic: '/word/',
      meanings: [
        { partOfSpeech: 'noun', definitions: [{ definition: 'A thing.' }, { definition: 'A thing.' }, {}] },
        { partOfSpeech: 'verb', definitions: [{ definition: 'To do something.' }] },
        { definitions: [{ definition: 'Another meaning.' }] }
      ]
    }
  ], 'word')

  assert.deepEqual(parsed.result.definitions?.map((item) => item.text), ['A thing.', 'To do something.', 'Another meaning.'])
})

test('音标不可用但存在释义时应返回可用释义', () => {
  const parsed = parsePronunciationDictionaryResponse([
    {
      meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'A greeting.' }] }]
    }
  ], 'hello')

  assert.equal(parsed.result.status, 'available')
  assert.deepEqual(parsed.result.variants, [])
  assert.equal(parsed.result.definitions?.[0]?.text, 'A greeting.')
})
