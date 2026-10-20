import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseIscorevocWords,
  parseIscorevocWord
} from '../src/shared/pronunciationIscorevoc.ts'
import { PronunciationService } from '../src/main/pronunciationService.ts'

test('iscorevoc 词条应解析 IPA、中文释义与来源', () => {
  const entries = parseIscorevocWords(JSON.stringify([
    { w: 'adapt', cn: 'v. 适应；改编', ipa: 'əˈdæpt', ay: 'https://example.com/adapt.wav' },
    { w: 'well-known', cn: 'adj. 众所周知的；著名的', ipa: 'ˌwel ˈnəʊn' }
  ]))

  assert.deepEqual(entries, [
    {
      word: 'adapt',
      ipa: 'əˈdæpt',
      definitions: [{ text: 'v. 适应；改编', language: 'zh', source: 'iscorevoc' }],
      source: 'iscorevoc'
    },
    {
      word: 'well-known',
      ipa: 'ˌwel ˈnəʊn',
      definitions: [{ text: 'adj. 众所周知的；著名的', language: 'zh', source: 'iscorevoc' }],
      source: 'iscorevoc'
    }
  ])
  assert.deepEqual(parseIscorevocWord({ w: 'hello', cn: 'int. 喂', ipa: 'həˈləʊ' }), entries[0] ? {
    word: 'hello',
    ipa: 'həˈləʊ',
    definitions: [{ text: 'int. 喂', language: 'zh', source: 'iscorevoc' }],
    source: 'iscorevoc'
  } : null)
})

test('iscorevoc 解析应拒绝空词条、重复词条和非字符串字段', () => {
  assert.deepEqual(parseIscorevocWords('invalid'), [])
  assert.deepEqual(parseIscorevocWords(JSON.stringify([
    null,
    { w: '', ipa: 'x', cn: 'x' },
    { w: 'hello', ipa: 1, cn: null },
    { w: 'hello', ipa: 'həˈləʊ', cn: 'int. 喂' },
    { w: 'HELLO', ipa: 'həˈloʊ', cn: 'int. 你好' }
  ])), [{
    word: 'hello',
    ipa: 'həˈləʊ',
    definitions: [{ text: 'int. 喂', language: 'zh', source: 'iscorevoc' }],
    source: 'iscorevoc'
  }])
})

test('雅思词汇音频不可用时仍应返回可朗读的释义和 IPA', async () => {
  const service = new PronunciationService({
    fetch: async () => new Response('not found', { status: 404 }),
    ieltsDictionary: {
      lookup: () => ({
        word: 'adapt',
        ipa: 'əˈdæpt',
        definitions: [{ text: 'v. 适应；改编', language: 'zh', source: 'iscorevoc' }],
        source: 'iscorevoc'
      })
    }
  })
  const result = await service.lookup('adapt')

  assert.equal(result.status, 'available')
  assert.deepEqual(result.definitions, [{
    text: 'v. 适应；改编',
    language: 'zh',
    source: 'iscorevoc'
  }])
  assert.equal(result.source, 'iscorevoc')
  assert.deepEqual(result.variants.map((variant) => variant.ipa), ['əˈdæpt'])
  assert.equal(result.variants[0]?.hasAudio, false)
})
