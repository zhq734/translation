import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyPronunciationText,
  normalizePronunciationWord,
  parsePronunciationWord,
  splitPronunciationText
} from '../src/shared/pronunciationWord.ts'

test('英文单词识别应清理首尾标点并保留普通英文内容', () => {
  assert.deepEqual(parsePronunciationWord('“Hello,”'), {
    word: 'Hello',
    lookupWord: 'Hello',
    possessive: false
  })
  assert.equal(normalizePronunciationWord('  (quick)!  '), 'quick')
})

test('英文单词识别应支持缩写、所有格和弯撇号', () => {
  assert.deepEqual(parsePronunciationWord('don’t'), {
    word: "don't",
    lookupWord: "don't",
    possessive: false
  })
  assert.deepEqual(parsePronunciationWord('student’s'), {
    word: "student's",
    lookupWord: 'student',
    possessive: true
  })
})

test('英文单词识别应支持连字符词且不自动拆分', () => {
  assert.deepEqual(parsePronunciationWord('well-known'), {
    word: 'well-known',
    lookupWord: 'well-known',
    possessive: false
  })
})

test('英文单词识别应拒绝数字、URL、邮箱、CJK、空输入和超长单词', () => {
  for (const value of [
    '',
    '   ',
    '12345',
    'hello2',
    '2hello',
    'https://example.com/hello',
    'person@example.com',
    '你好',
    'こんにちは',
    '안녕하세요',
    '!?…'
  ]) {
    assert.equal(parsePronunciationWord(value), null, `不应识别：${value}`)
  }
  assert.equal(parsePronunciationWord('a'.repeat(64))?.word, 'a'.repeat(64))
  assert.equal(parsePronunciationWord('a'.repeat(65)), null)
})

test('原文分类应区分单个英文词、段落和不支持内容', () => {
  assert.equal(classifyPronunciationText('hello'), 'word')
  assert.equal(classifyPronunciationText('“Hello!”'), 'word')
  assert.equal(classifyPronunciationText('The quick brown fox.'), 'paragraph')
  assert.equal(classifyPronunciationText('hello 123'), 'paragraph')
  assert.equal(classifyPronunciationText('123 https://example.com 中文'), 'unsupported')
  assert.equal(classifyPronunciationText(''), 'unsupported')
})

test('原文分词应保持顺序、空白、标点和原始字符', () => {
  const segments = splitPronunciationText('The “quick” fox.\nDon’t stop!')

  assert.deepEqual(
    segments.map((segment) => segment.kind === 'word' ? segment.text : segment.text),
    ['The', ' ', '“', 'quick', '”', ' ', 'fox', '.', '\n', 'Don’t', ' ', 'stop', '!']
  )
  assert.deepEqual(
    segments.filter((segment) => segment.kind === 'word').map((segment) => segment.word.word),
    ['The', 'quick', 'fox', "Don't", 'stop']
  )
  assert.equal(segments.map((segment) => segment.text).join(''), 'The “quick” fox.\nDon’t stop!')
})

test('原文分词不应把 URL、邮箱和数字中的英文片段变成可查询词', () => {
  const segments = splitPronunciationText('Visit https://example.com/user or mail me@example.com in 2026.')
  const words = segments
    .filter((segment) => segment.kind === 'word')
    .map((segment) => segment.word.word)

  assert.deepEqual(words, ['Visit', 'or', 'mail', 'in'])
  assert.equal(segments.map((segment) => segment.text).join(''), 'Visit https://example.com/user or mail me@example.com in 2026.')
})

test('译文分词应复用英文单词规则且中文保持普通文本', () => {
  const english = splitPronunciationText('The quick brown fox.')
  const chinese = splitPronunciationText('快速的棕色狐狸。')

  assert.deepEqual(
    english.filter((segment) => segment.kind === 'word').map((segment) => segment.word.word),
    ['The', 'quick', 'brown', 'fox']
  )
  assert.equal(chinese.some((segment) => segment.kind === 'word'), false)
  assert.equal(chinese.map((segment) => segment.text).join(''), '快速的棕色狐狸。')
})

test('译文英文单词分词应保留标点、换行和混合语言内容', () => {
  const text = 'Hello, 世界!\nDon’t stop.'
  const segments = splitPronunciationText(text)

  assert.equal(segments.map((segment) => segment.text).join(''), text)
  assert.deepEqual(
    segments.filter((segment) => segment.kind === 'word').map((segment) => segment.word.word),
    ['Hello', "Don't", 'stop']
  )
})
