import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DocumentTranslationCacheStore,
  DOCUMENT_TRANSLATION_CACHE_SCHEMA_VERSION
} from '../src/main/documentTranslationCache.ts'
import {
  DOCUMENT_TRANSLATION_PROTOCOL_VERSION,
  type DocumentTranslationCacheEntry
} from '../src/shared/documentTranslation.ts'

/**
 * 创建独立缓存目录，避免测试之间共享状态。
 * @returns 临时目录路径。
 * @author zhenghq
 */
function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'document-translation-cache-'))
}

/**
 * 构造可写入缓存的成功条目。
 * @param translation 完整译文。
 * @returns 成功缓存条目。
 * @author zhenghq
 */
function entry(translation: string): DocumentTranslationCacheEntry {
  return {
    sourceSha256: 'source-hash',
    languagePair: { sourceLang: 'EN', targetLang: 'ZH' },
    glossaryVersion: 'none',
    protectionRulesVersion: 'protection-v1',
    translationProtocolVersion: DOCUMENT_TRANSLATION_PROTOCOL_VERSION,
    status: 'completed',
    translation
  }
}

test('文档翻译缓存必须拒绝缺失或不匹配翻译协议版本的条目', async () => {
  const directory = temporaryDirectory()
  try {
    const store = new DocumentTranslationCacheStore({
      directory,
      maxBytes: 1024 * 1024,
      maxAgeMs: 60_000,
      now: () => 1000
    })
    const withoutProtocol = { ...entry('旧译文') } as Record<string, unknown>
    delete withoutProtocol.translationProtocolVersion
    await store.write('missing-protocol', withoutProtocol as DocumentTranslationCacheEntry)
    await store.write('old-protocol', {
      ...entry('旧协议译文'),
      translationProtocolVersion: 'document-translation-protocol-v1'
    })

    assert.equal(await store.read('missing-protocol'), null)
    assert.equal(await store.read('old-protocol'), null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('文档翻译缓存必须持久化、读取并清空条目', async () => {
  const directory = temporaryDirectory()
  try {
    const store = new DocumentTranslationCacheStore({
      directory,
      maxBytes: 1024 * 1024,
      maxAgeMs: 30 * 24 * 60 * 60 * 1000,
      now: () => 1000
    })
    await store.write('key-a', entry('译文'))
    assert.deepEqual(await store.read('key-a'), entry('译文'))
    assert.equal(existsSync(join(directory, 'translation-cache.json')), true)
    await store.clear()
    assert.equal(await store.read('key-a'), null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('文档翻译缓存必须丢弃过期条目和损坏 schema', async () => {
  const directory = temporaryDirectory()
  try {
    let now = 1000
    const store = new DocumentTranslationCacheStore({
      directory,
      maxBytes: 1024 * 1024,
      maxAgeMs: 100,
      now: () => now
    })
    await store.write('expired', entry('旧译文'))
    now = 1101
    assert.equal(await store.read('expired'), null)

    writeFileSync(join(directory, 'translation-cache.json'), JSON.stringify({
      schemaVersion: DOCUMENT_TRANSLATION_CACHE_SCHEMA_VERSION,
      entries: [{ key: 'broken', updatedAt: now, value: { status: 'completed' } }]
    }))
    assert.equal(await store.read('broken'), null)

    writeFileSync(join(directory, 'translation-cache.json'), JSON.stringify({
      schemaVersion: DOCUMENT_TRANSLATION_CACHE_SCHEMA_VERSION + 1,
      entries: [{ key: 'future', updatedAt: now, value: entry('未来') }]
    }))
    assert.equal(await store.read('future'), null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('文档翻译缓存必须按 LRU 淘汰并更新最近访问时间', async () => {
  const directory = temporaryDirectory()
  try {
    let now = 1000
    const first = new DocumentTranslationCacheStore({
      directory,
      maxBytes: 520,
      maxAgeMs: 60_000,
      now: () => now
    })
    await first.write('a', entry('a'.repeat(60)))
    now += 1
    await first.write('b', entry('b'.repeat(60)))
    now += 1
    assert.equal(await first.read('a'), null)
    assert.equal((await first.read('b'))?.translation, 'b'.repeat(60))

    now += 1
    await first.write('c', entry('c'.repeat(60)))
    assert.equal(await first.read('b'), null)
    assert.equal((await first.read('c'))?.translation, 'c'.repeat(60))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('文档翻译缓存损坏 JSON 时必须安全回退为空缓存并允许重新写入', async () => {
  const directory = temporaryDirectory()
  try {
    writeFileSync(join(directory, 'translation-cache.json'), '{not-json')
    const store = new DocumentTranslationCacheStore({
      directory,
      maxBytes: 1024,
      maxAgeMs: 1000,
      now: () => 1000
    })
    assert.equal(await store.read('missing'), null)
    await store.write('recovered', entry('恢复'))
    const raw = JSON.parse(readFileSync(join(directory, 'translation-cache.json'), 'utf8')) as {
      schemaVersion: number
    }
    assert.equal(raw.schemaVersion, DOCUMENT_TRANSLATION_CACHE_SCHEMA_VERSION)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('文档翻译缓存必须按源文件哈希删除条目并保留其他文件', async () => {
  const directory = temporaryDirectory()
  try {
    const store = new DocumentTranslationCacheStore({
      directory,
      maxBytes: 1024 * 1024,
      maxAgeMs: 60_000,
      now: () => 1000
    })
    await store.write('key-a', entry('译文 A'))
    await store.write('key-b', { ...entry('译文 B'), sourceSha256: 'other-source' })
    await store.deleteBySourceSha256('source-hash')
    assert.equal(await store.read('key-a'), null)
    assert.equal((await store.read('key-b'))?.translation, '译文 B')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
