import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
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

/**
 * 递归收集缓存目录中的条目文件。
 * @param directory 待扫描目录。
 * @returns JSON 文件绝对路径列表。
 * @author zhenghq
 */
function listShardFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  const files: string[] = []
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isDirectory()) files.push(...listShardFiles(path))
    else if (item.name.endsWith('.json')) files.push(path)
  }
  return files
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
    assert.equal(existsSync(join(directory, 'translation-cache.json')), false)
    assert.equal(listShardFiles(join(directory, 'entries')).length, 1)
    await store.clear()
    assert.equal(await store.read('key-a'), null)
    assert.deepEqual(listShardFiles(join(directory, 'entries')), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('文档翻译缓存必须丢弃过期条目和损坏分片 schema', async () => {
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

    const brokenStore = new DocumentTranslationCacheStore({
      directory,
      maxBytes: 1024 * 1024,
      maxAgeMs: 100,
      now: () => now
    })
    await brokenStore.write('broken', entry('损坏'))
    const brokenFile = listShardFiles(join(directory, 'entries'))[0]!
    writeFileSync(brokenFile, JSON.stringify({
      schemaVersion: DOCUMENT_TRANSLATION_CACHE_SCHEMA_VERSION,
      entries: [{ key: 'broken', updatedAt: now, value: { status: 'completed' } }]
    }))
    assert.equal(await brokenStore.read('broken'), null)

    await brokenStore.write('future', entry('未来'))
    const futureFile = listShardFiles(join(directory, 'entries')).find((file) => {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { entry?: { key?: string } }
      return parsed.entry?.key === 'future'
    })!
    writeFileSync(futureFile, JSON.stringify({
      schemaVersion: DOCUMENT_TRANSLATION_CACHE_SCHEMA_VERSION + 1,
      entries: [{ key: 'future', updatedAt: now, value: entry('未来') }]
    }))
    assert.equal(await brokenStore.read('future'), null)
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
    const store = new DocumentTranslationCacheStore({
      directory,
      maxBytes: 1024,
      maxAgeMs: 1000,
      now: () => 1000
    })
    assert.equal(await store.read('missing'), null)
    await store.write('recovered', entry('恢复'))
    const [file] = listShardFiles(join(directory, 'entries'))
    assert.ok(file)
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      schemaVersion: number
    }
    assert.equal(raw.schemaVersion, DOCUMENT_TRANSLATION_CACHE_SCHEMA_VERSION)
    writeFileSync(file, '{not-json')
    const reloaded = new DocumentTranslationCacheStore({
      directory,
      maxBytes: 1024,
      maxAgeMs: 1000,
      now: () => 1000
    })
    assert.equal(await reloaded.read('recovered'), null)
    await reloaded.write('recovered-again', entry('再次恢复'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('文档翻译缓存配置必须热更新并立即淘汰超限条目', async () => {
  const directory = temporaryDirectory()
  try {
    let now = 1000
    const store = new DocumentTranslationCacheStore({
      directory,
      maxBytes: 1024 * 1024,
      maxAgeMs: 60_000,
      now: () => now
    })
    await store.write('first', entry('a'.repeat(60)))
    now += 1
    await store.write('second', entry('b'.repeat(60)))
    const secondSize = Math.max(...listShardFiles(join(directory, 'entries'))
      .filter((file) => {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { entry?: { key?: string } }
        return parsed.entry?.key === 'second'
      })
      .map((file) => readFileSync(file).byteLength))

    await store.configure({ maxBytes: Math.max(1, secondSize), maxAgeMs: 60_000 })
    assert.equal(await store.read('first'), null)
    assert.equal((await store.read('second'))?.translation, 'b'.repeat(60))

    now += 61_000
    await store.configure({ maxBytes: 1024 * 1024, maxAgeMs: 1000 })
    assert.equal(await store.read('second'), null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('文档翻译缓存热更新删除过期条目后不得误删仍在保留期内的条目', async () => {
  const directory = temporaryDirectory()
  try {
    let now = 1000
    const store = new DocumentTranslationCacheStore({
      directory,
      maxBytes: 1024 * 1024,
      maxAgeMs: 60_000,
      now: () => now
    })
    await store.write('expired', entry('a'.repeat(60)))
    now = 2000
    await store.write('retained', entry('b'.repeat(60)))
    const retainedSize = Math.max(...listShardFiles(join(directory, 'entries'))
      .filter((file) => {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { entry?: { key?: string } }
        return parsed.entry?.key === 'retained'
      })
      .map((file) => readFileSync(file).byteLength))

    now = 3000
    await store.configure({ maxBytes: retainedSize, maxAgeMs: 1000 })
    assert.equal(await store.read('expired'), null)
    assert.equal((await store.read('retained'))?.translation, 'b'.repeat(60))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('文档翻译缓存并发读取同一键时必须全部命中', async () => {
  const directory = temporaryDirectory()
  try {
    const store = new DocumentTranslationCacheStore({
      directory,
      maxBytes: 1024 * 1024,
      maxAgeMs: 60_000,
      now: () => 1000
    })
    await store.write('shared-key', entry('并发命中'))

    const results = await Promise.all([
      store.read('shared-key'),
      store.read('shared-key'),
      store.read('shared-key')
    ])
    assert.deepEqual(results, [entry('并发命中'), entry('并发命中'), entry('并发命中')])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('文档翻译缓存并发读取同一键时访问时间刷新不得造成后续读取漏命中', async () => {
  const directory = temporaryDirectory()
  try {
    let now = 1000
    const store = new DocumentTranslationCacheStore({
      directory,
      maxBytes: 1024 * 1024,
      maxAgeMs: 60_000,
      now: () => {
        now += 1
        return now
      }
    })
    await store.write('shared-moving-clock', entry('时间推进命中'))

    const results = await Promise.all(Array.from({ length: 8 }, () => store.read('shared-moving-clock')))
    assert.equal(results.filter((value) => value !== null).length, results.length)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('文档翻译缓存必须迁移旧单文件缓存并删除旧文件', async () => {
  const directory = temporaryDirectory()
  try {
    const legacyEntry = {
      key: 'legacy-key',
      savedAt: 1000,
      accessedAt: 1000,
      size: 1,
      value: entry('旧缓存译文')
    }
    writeFileSync(join(directory, 'translation-cache.json'), JSON.stringify({
      schemaVersion: DOCUMENT_TRANSLATION_CACHE_SCHEMA_VERSION,
      entries: [legacyEntry]
    }))
    const store = new DocumentTranslationCacheStore({
      directory,
      maxBytes: 1024 * 1024,
      maxAgeMs: 60_000,
      now: () => 1000
    })

    assert.deepEqual(await store.read('legacy-key'), entry('旧缓存译文'))
    assert.equal(existsSync(join(directory, 'translation-cache.json')), false)
    assert.equal(listShardFiles(join(directory, 'entries')).length, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('文档翻译缓存迁移旧文件时必须按真实分片字节数应用容量限制', async () => {
  const directory = temporaryDirectory()
  try {
    const translation = '旧'.repeat(2000)
    writeFileSync(join(directory, 'translation-cache.json'), JSON.stringify({
      schemaVersion: DOCUMENT_TRANSLATION_CACHE_SCHEMA_VERSION,
      entries: [{
        key: 'legacy-oversized',
        savedAt: 1000,
        accessedAt: 1000,
        size: 1,
        value: entry(translation)
      }]
    }))
    const store = new DocumentTranslationCacheStore({
      directory,
      maxBytes: 1024,
      maxAgeMs: 60_000,
      now: () => 1000
    })

    assert.equal(await store.read('legacy-oversized'), null)
    assert.deepEqual(listShardFiles(join(directory, 'entries')), [])
    assert.equal(existsSync(join(directory, 'translation-cache.json')), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('文档翻译缓存并发写入不同分片时淘汰后必须至少保留可容纳条目', async () => {
  const directory = temporaryDirectory()
  try {
    const store = new DocumentTranslationCacheStore({
      directory,
      maxBytes: 8192,
      maxAgeMs: 60_000,
      now: () => 1000
    })
    const keys = Array.from({ length: 24 }, (_, index) => `concurrent-${index}`)
    await Promise.all(keys.map((key) => store.write(key, entry('并发译文'.repeat(100)))))

    const survivors = await Promise.all(keys.map((key) => store.read(key)))
    assert.ok(survivors.some((value) => value !== null))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('文档翻译缓存新分片落盘失败时不得删除仍然可用的旧条目', async () => {
  const directory = temporaryDirectory()
  try {
    const key = 'source-hash|target:retained'
    const store = new DocumentTranslationCacheStore({
      directory,
      maxBytes: 1024 * 1024,
      maxAgeMs: 60_000,
      now: () => 1000
    })
    await store.write(key, entry('保留译文'))
    const [retainedFile] = listShardFiles(join(directory, 'entries'))
    assert.ok(retainedFile)
    const retainedDirectory = join(directory, 'entries', 'source-hash')
    chmodSync(retainedDirectory, 0o555)
    await assert.rejects(store.write(key, entry('新译文'.repeat(400))))
    chmodSync(retainedDirectory, 0o755)
    assert.equal((await store.read(key))?.translation, '保留译文')
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
