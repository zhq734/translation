import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  TRANSLATION_HISTORY_LIMIT,
  createTranslationHistoryEntry,
  filterTranslationHistory,
  normalizeTranslationHistory,
  recordTranslationHistory,
  toggleTranslationHistoryFavorite,
  type TranslationHistoryEntry
} from '../src/shared/translationHistory.ts'
import {
  TRANSLATION_HISTORY_SCHEMA_VERSION,
  TranslationHistoryStore
} from '../src/main/translationHistory.ts'

/**
 * 构造一条统一翻译历史记录。
 * @param id 记录标识。
 * @param createdAt 创建时间。
 * @param overrides 需要覆盖的字段。
 * @returns 历史记录。
 * @author zhenghq
 */
function entry(
  id: string,
  createdAt: number,
  overrides: Partial<TranslationHistoryEntry> = {}
): TranslationHistoryEntry {
  return {
    id,
    sourceText: `source-${id}`,
    translatedText: `translation-${id}`,
    sourceLang: 'EN',
    targetLang: 'ZH',
    provider: 'microsoft',
    origin: 'selection',
    createdAt,
    favorite: false,
    ...overrides
  }
}

test('翻译历史必须过滤损坏条目并按收藏优先、时间倒序排序', () => {
  const normalized = normalizeTranslationHistory([
    entry('old', 10),
    entry('favorite', 5, { favorite: true }),
    { ...entry('broken', 20), sourceText: '' },
    null,
    entry('new', 30, { origin: 'manual' })
  ])

  assert.deepEqual(normalized.map((item) => item.id), ['favorite', 'new', 'old'])
})

test('相同来源、原文和语言对再次翻译时必须更新原记录并保留收藏', () => {
  const previous = [entry('first', 10, { favorite: true })]
  const result = recordTranslationHistory(previous, {
    sourceText: 'source-first',
    translatedText: 'new-translation',
    sourceLang: 'EN',
    targetLang: 'ZH',
    provider: 'ai',
    origin: 'selection',
    createdAt: 20,
    favorite: false
  })

  assert.equal(result.length, 1)
  assert.equal(result[0]?.id, 'first')
  assert.equal(result[0]?.translatedText, 'new-translation')
  assert.equal(result[0]?.favorite, true)
  assert.equal(result[0]?.createdAt, 20)
})

test('翻译历史必须只保留最近的非收藏记录并继续保留收藏项', () => {
  const previous = [
    entry('favorite', 1, { favorite: true }),
    ...Array.from({ length: TRANSLATION_HISTORY_LIMIT + 2 }, (_, index) =>
      entry(`entry-${index}`, index + 2)
    )
  ]
  const result = recordTranslationHistory(previous, {
    sourceText: 'latest',
    translatedText: 'latest-translation',
    sourceLang: 'auto',
    targetLang: 'ZH',
    origin: 'ocr',
    createdAt: 9999
  })

  assert.equal(result.length, TRANSLATION_HISTORY_LIMIT + 1)
  assert.equal(result[0]?.favorite, true)
  assert.equal(result[1]?.sourceText, 'latest')
  assert.equal(result.filter((item) => !item.favorite).length, TRANSLATION_HISTORY_LIMIT)
})

test('翻译历史搜索必须忽略大小写并匹配原文、译文、语言和来源', () => {
  const entries = [
    entry('a', 1, {
      sourceText: 'Quarterly Report',
      translatedText: '季度报告',
      sourceLang: 'EN',
      targetLang: 'ZH',
      origin: 'ocr'
    }),
    entry('b', 2, {
      sourceText: 'bonjour',
      translatedText: 'hello',
      sourceLang: 'FR',
      targetLang: 'EN',
      origin: 'manual'
    })
  ]

  assert.deepEqual(filterTranslationHistory(entries, 'quarterly'), [entries[0]])
  assert.deepEqual(filterTranslationHistory(entries, '季度'), [entries[0]])
  assert.deepEqual(filterTranslationHistory(entries, 'fr → en'), [entries[1]])
  assert.deepEqual(filterTranslationHistory(entries, 'OCR'), [entries[0]])
  assert.deepEqual(filterTranslationHistory(entries, '  '), entries)
})

test('收藏切换必须只修改指定记录', () => {
  const entries = [entry('a', 1), entry('b', 2)]
  const result = toggleTranslationHistoryFavorite(entries, 'b')
  assert.equal(result[0]?.favorite, false)
  assert.equal(result[1]?.favorite, true)
  assert.equal(toggleTranslationHistoryFavorite(result, 'missing'), result)
})

test('重新翻译历史条目必须复用原记录并刷新译文与时间', () => {
  const original = entry('a', 10, {
    sourceText: 'Hello',
    translatedText: '你好',
    sourceLang: 'EN',
    targetLang: 'ZH',
    origin: 'selection',
    favorite: true
  })
  const result = recordTranslationHistory([original], {
    sourceText: 'Hello',
    translatedText: '您好',
    sourceLang: 'EN',
    targetLang: 'ZH',
    origin: 'selection',
    createdAt: 20
  })

  assert.equal(result.length, 1)
  assert.equal(result[0]?.id, original.id)
  assert.equal(result[0]?.translatedText, '您好')
  assert.equal(result[0]?.createdAt, 20)
  assert.equal(result[0]?.favorite, true)
})

test('创建历史记录必须拒绝空白原文或译文且不包含截图字段', () => {
  assert.equal(createTranslationHistoryEntry({
    sourceText: '   ',
    translatedText: '译文',
    sourceLang: 'EN',
    targetLang: 'ZH',
    origin: 'ocr',
    createdAt: 1
  }), null)
  assert.equal(createTranslationHistoryEntry({
    sourceText: '原文',
    translatedText: '  ',
    sourceLang: 'EN',
    targetLang: 'ZH',
    origin: 'ocr',
    createdAt: 1
  }), null)

  const created = createTranslationHistoryEntry({
    sourceText: '原文',
    translatedText: '译文',
    sourceLang: 'EN',
    targetLang: 'ZH',
    origin: 'ocr',
    ocrEngine: 'system',
    createdAt: 1
  })
  assert.ok(created)
  assert.deepEqual(Object.keys(created).sort(), [
    'createdAt',
    'favorite',
    'id',
    'ocrEngine',
    'origin',
    'sourceLang',
    'sourceText',
    'targetLang',
    'translatedText'
  ])
})

test('翻译历史存储必须原子持久化、去重、收藏、删除并清空非收藏', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'translation-history-test-'))
  try {
    const store = new TranslationHistoryStore({
      directory,
      now: () => 500
    })
    const first = await store.record({
      sourceText: 'Hello',
      translatedText: '你好',
      sourceLang: 'EN',
      targetLang: 'ZH',
      provider: 'microsoft',
      origin: 'selection'
    })
    assert.ok(first)
    assert.equal((await store.list()).length, 1)

    await store.setFavorite(first.id, true)
    const second = await store.record({
      sourceText: 'World',
      translatedText: '世界',
      sourceLang: 'EN',
      targetLang: 'ZH',
      origin: 'manual'
    })
    assert.ok(second)
    assert.deepEqual((await store.list()).map((item) => item.id), [first.id, second.id])

    assert.equal(await store.delete(second.id), true)
    assert.deepEqual((await store.list()).map((item) => item.id), [first.id])
    await store.record({
      sourceText: 'Temporary',
      translatedText: '临时',
      sourceLang: 'EN',
      targetLang: 'ZH',
      origin: 'ocr'
    })
    assert.equal(await store.clearNonFavorites(), 1)
    assert.deepEqual((await store.list()).map((item) => item.id), [first.id])

    const raw = await readFile(join(directory, 'translation-history.json'), 'utf8')
    assert.equal(JSON.parse(raw).schemaVersion, TRANSLATION_HISTORY_SCHEMA_VERSION)
    assert.equal(raw.includes('Hello'), true)
    assert.equal(raw.includes('data:image'), false)
    assert.equal(raw.includes('/Users/'), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('翻译历史存储遇到损坏文件时必须安全回退并允许重新写入', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'translation-history-broken-'))
  try {
    await writeFile(join(directory, 'translation-history.json'), '{broken', 'utf8')
    const store = new TranslationHistoryStore({ directory, now: () => 1 })
    assert.deepEqual(await store.list(), [])
    assert.ok(await store.record({
      sourceText: 'Recovered',
      translatedText: '已恢复',
      sourceLang: 'EN',
      targetLang: 'ZH',
      origin: 'selection'
    }))
    assert.equal((await store.list()).length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
