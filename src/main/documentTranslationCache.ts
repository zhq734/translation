import { createHash } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  DOCUMENT_TRANSLATION_PROTOCOL_VERSION,
  type DocumentTranslationCacheEntry
} from '../shared/documentTranslation.ts'

/** 文档翻译持久化缓存结构版本；不兼容变更时必须递增。 */
export const DOCUMENT_TRANSLATION_CACHE_SCHEMA_VERSION = 1

/** 旧版单文件缓存名；仅用于迁移读取。 */
const LEGACY_DOCUMENT_TRANSLATION_CACHE_FILE = 'translation-cache.json'

/** 分片缓存根目录名。 */
const DOCUMENT_TRANSLATION_CACHE_ENTRIES_DIRECTORY = 'entries'

/** 分片缓存临时文件名后缀。 */
const CACHE_TEMP_FILE_SUFFIX = '.tmp'

/** 持久化缓存条目结构。 */
interface PersistedEntry {
  /** 流水线生成的完整缓存键。 */
  key: string
  /** 条目首次写入时间，用于保留期判断。 */
  savedAt: number
  /** 条目最近访问时间，用于 LRU 淘汰。 */
  accessedAt: number
  /** 序列化后的条目字节数估算。 */
  size: number
  /** 已通过结构校验的翻译结果。 */
  value: DocumentTranslationCacheEntry
}

/** 旧版单文件缓存结构；仅用于兼容迁移。 */
interface LegacyPersistedCacheFile {
  /** 缓存结构版本。 */
  schemaVersion: number
  /** 全部缓存条目。 */
  entries: PersistedEntry[]
}

/** 单个分片文件结构；每个文件只包含一条翻译结果。 */
interface PersistedShardFile {
  /** 缓存结构版本。 */
  schemaVersion: number
  /** 当前分片中的缓存条目。 */
  entry: PersistedEntry
}

/** 内存索引条目；只保留容量和淘汰所需元数据，不保留完整译文。 */
interface CacheIndexEntry extends Omit<PersistedEntry, 'value'> {
  /** 条目所属源文件哈希，用于按源文件批量删除。 */
  sourceSha256: string
  /** 分片文件相对缓存目录的路径。 */
  relativePath: string
  /** 进程内单调递增的访问序号，用于同一毫秒内稳定排序。 */
  accessSequence: number
  /** 进程内单调递增的写版本；访问刷新不变，同键重写递增。 */
  writeSequence: number
}

/** 串行执行索引变更的异步互斥锁。 */
class DocumentTranslationCacheMutex {
  /** 当前队尾 Promise；新任务必须等待其完成。 */
  private tail: Promise<void> = Promise.resolve()

  /**
   * 在互斥区内执行操作。
   * @param operation 待执行的异步操作。
   * @returns 操作返回值。
   * @author zhenghq
   */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

/** 文档翻译缓存存储选项。 */
export interface DocumentTranslationCacheStoreOptions {
  /** 缓存目录；由主进程传入用户数据目录下的受控子目录。 */
  directory: string
  /** 最大缓存字节数。 */
  maxBytes: number
  /** 条目最长保留时间。 */
  maxAgeMs: number
  /** 可注入时钟，便于验证过期与 LRU 行为。 */
  now?(): number
}

/** 缓存配置热更新载荷。 */
export interface DocumentTranslationCacheConfiguration {
  /** 最大缓存字节数。 */
  maxBytes: number
  /** 条目最长保留时间。 */
  maxAgeMs: number
}

/**
 * 判断未知值是否为合法翻译缓存条目。
 * @param value 待校验值。
 * @returns 字段完整且成功终态时返回 true。
 * @author zhenghq
 */
function isCacheEntry(value: unknown): value is DocumentTranslationCacheEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<DocumentTranslationCacheEntry>
  const languagePair = entry.languagePair as Partial<DocumentTranslationCacheEntry['languagePair']> | undefined
  return typeof entry.sourceSha256 === 'string' && entry.sourceSha256.length > 0 &&
    Boolean(languagePair) && typeof languagePair?.sourceLang === 'string' &&
    typeof languagePair?.targetLang === 'string' &&
    entry.translationProtocolVersion === DOCUMENT_TRANSLATION_PROTOCOL_VERSION &&
    typeof entry.glossaryVersion === 'string' &&
    typeof entry.protectionRulesVersion === 'string' &&
    entry.status === 'completed' &&
    typeof entry.translation === 'string' && entry.translation.trim().length > 0 &&
    entry.suspectUntranslated !== true && entry.incomplete !== true
}

/**
 * 判断未知值是否为合法持久化条目。
 * @param value 待校验值。
 * @returns 结构有效时返回 true。
 * @author zhenghq
 */
function isPersistedEntry(value: unknown): value is PersistedEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<PersistedEntry>
  return typeof entry.key === 'string' && entry.key.length > 0 &&
    typeof entry.savedAt === 'number' && Number.isFinite(entry.savedAt) && entry.savedAt >= 0 &&
    typeof entry.accessedAt === 'number' && Number.isFinite(entry.accessedAt) && entry.accessedAt >= 0 &&
    typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size > 0 &&
    isCacheEntry(entry.value)
}

/**
 * 按实际分片序列化长度重新计算条目大小，修复旧缓存中的失准元数据。
 * @param entry 已校验的持久化条目。
 * @returns 使用可信字节数的新条目。
 * @author zhenghq
 */
function normalizePersistedEntry(entry: PersistedEntry): PersistedEntry {
  return { ...entry, size: entrySize(entry) }
}

/**
 * 从持久化条目提取轻量索引信息，避免完整译文长期驻留主进程内存。
 * @param entry 已校验的持久化条目。
 * @returns 不包含译文内容的内存索引条目。
 * @author zhenghq
 */
function toCacheIndexEntry(
  entry: PersistedEntry
): Omit<CacheIndexEntry, 'relativePath' | 'accessSequence' | 'writeSequence'> {
  return {
    key: entry.key,
    savedAt: entry.savedAt,
    accessedAt: entry.accessedAt,
    size: entry.size,
    sourceSha256: entry.value.sourceSha256
  }
}

/**
 * 计算持久化条目的近似字节数，确保容量限制对磁盘文件同样有效。
 * @param entry 待计算条目。
 * @returns UTF-8 JSON 字节数。
 * @author zhenghq
 */
function entrySize(entry: Omit<PersistedEntry, 'size'>): number {
  // size 字段本身也占字节，迭代到序列化长度稳定后再作为容量统计值。
  let size = 0
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = Buffer.byteLength(JSON.stringify({
      schemaVersion: DOCUMENT_TRANSLATION_CACHE_SCHEMA_VERSION,
      entry: { ...entry, size }
    } satisfies PersistedShardFile), 'utf8')
    if (next === size) break
    size = next
  }
  return size
}

/**
 * 解析并校验单个分片文件，结构版本不匹配时视为损坏缓存。
 * @param value 从磁盘读取的未知值。
 * @returns 合法缓存条目或 null。
 * @author zhenghq
 */
function parsePersistedShard(value: unknown): PersistedEntry | null {
  if (!value || typeof value !== 'object') return null
  const file = value as Partial<PersistedShardFile>
  if (file.schemaVersion !== DOCUMENT_TRANSLATION_CACHE_SCHEMA_VERSION ||
    !isPersistedEntry(file.entry)) return null
  return file.entry
}

/** 等待中的读写锁请求类型。 */
type CacheLockKind = 'read' | 'write'

/** 读写锁内部等待项。 */
interface CacheLockWaiter {
  /** 请求类型。 */
  kind: CacheLockKind
  /** 获得锁后调用的回调。 */
  resolve(): void
}

/**
 * 文档缓存读写锁：允许不同分片并行读写，结构性操作独占执行。
 * @author zhenghq
 */
class DocumentTranslationCacheLock {
  /** 当前共享读者数量。 */
  private readers = 0
  /** 当前是否由写者独占。 */
  private writer = false
  /** 按到达顺序等待的请求。 */
  private readonly waiters: CacheLockWaiter[] = []

  /**
   * 获取共享读锁。
   * @returns 获得读锁后的 Promise。
   * @author zhenghq
   */
  async acquireRead(): Promise<void> {
    if (!this.writer && !this.waiters.some((waiter) => waiter.kind === 'write')) {
      this.readers += 1
      return
    }
    await new Promise<void>((resolve) => this.waiters.push({ kind: 'read', resolve }))
  }

  /**
   * 释放共享读锁并唤醒可执行的等待者。
   * @returns 无返回值。
   * @author zhenghq
   */
  releaseRead(): void {
    this.readers = Math.max(0, this.readers - 1)
    this.drain()
  }

  /**
   * 获取独占写锁。
   * @returns 获得写锁后的 Promise。
   * @author zhenghq
   */
  async acquireWrite(): Promise<void> {
    if (!this.writer && this.readers === 0 && this.waiters.length === 0) {
      this.writer = true
      return
    }
    await new Promise<void>((resolve) => this.waiters.push({ kind: 'write', resolve }))
  }

  /**
   * 释放独占写锁并唤醒后续请求。
   * @returns 无返回值。
   * @author zhenghq
   */
  releaseWrite(): void {
    this.writer = false
    this.drain()
  }

  /**
   * 按 FIFO 顺序唤醒不冲突的请求，避免写者被持续读请求饿死。
   * @returns 无返回值。
   * @author zhenghq
   */
  private drain(): void {
    if (this.writer || this.readers > 0) return
    const first = this.waiters[0]
    if (!first) return
    if (first.kind === 'write') {
      this.waiters.shift()
      this.writer = true
      first.resolve()
      return
    }
    while (this.waiters[0]?.kind === 'read') {
      this.waiters.shift()?.resolve()
      this.readers += 1
    }
  }
}

/**
 * 将未知缓存数据规范化为安全条目，忽略损坏、过期和重复键。
 * @param value 从磁盘读取的未知值。
 * @param now 当前时间。
 * @param maxAgeMs 保留期。
 * @returns 可安全使用的缓存条目。
 * @author zhenghq
 */
function normalizeCacheFile(
  value: unknown,
  now: number,
  maxAgeMs: number
): PersistedEntry[] {
  if (!value || typeof value !== 'object') return []
  const file = value as Partial<LegacyPersistedCacheFile>
  if (file.schemaVersion !== DOCUMENT_TRANSLATION_CACHE_SCHEMA_VERSION || !Array.isArray(file.entries)) {
    return []
  }
  const byKey = new Map<string, PersistedEntry>()
  for (const candidate of file.entries) {
    if (!isPersistedEntry(candidate)) continue
    if (now - candidate.savedAt > maxAgeMs) continue
    const previous = byKey.get(candidate.key)
    if (!previous || previous.accessedAt < candidate.accessedAt) {
      byKey.set(candidate.key, normalizePersistedEntry(candidate))
    }
  }
  return [...byKey.values()]
}

/**
 * 计算缓存键的稳定分片文件名，避免把用户正文或长键直接落到路径中。
 * @param key 完整缓存键。
 * @returns 带 JSON 后缀的稳定文件名。
 * @author zhenghq
 */
function shardFileName(key: string): string {
  return `${createHash('sha256').update(key).digest('hex')}.json`
}

/**
 * 从缓存键首段提取源文件哈希；缓存键由流水线固定以 fileSha256 开头。
 * @param key 完整缓存键。
 * @returns 安全的分片目录名，无法识别时返回 unknown-source。
 * @author zhenghq
 */
function sourceShardDirectory(key: string): string {
  const sourceSha256 = key.split('|', 1)[0]?.trim() ?? ''
  return /^[a-zA-Z0-9_-]{1,128}$/u.test(sourceSha256) ? sourceSha256 : 'unknown-source'
}

/**
 * 文档翻译分片磁盘缓存。
 *
 * 每个目标只读写自己的小文件，容量与 LRU 由轻量元数据索引维护；
 * 索引只在写入和访问时增量更新，不把完整译文加载到内存。
 * @author zhenghq
 */
export class DocumentTranslationCacheStore {
  /** 缓存目录。 */
  private readonly directory: string
  /** 最大缓存字节数。 */
  private maxBytes: number
  /** 条目保留时间。 */
  private maxAgeMs: number
  /** 可注入时钟。 */
  private readonly now: () => number
  /** 索引初始化只执行一次。 */
  private indexPromise: Promise<void> | null = null
  /** 元数据索引；value 只在读取时短暂使用。 */
  private index = new Map<string, CacheIndexEntry>()
  /** 当前索引中全部条目的字节总数。 */
  private totalBytes = 0
  /** 允许不同分片并行，并让清空与删除操作独占执行。 */
  private readonly lock = new DocumentTranslationCacheLock()
  /** 串行更新索引与容量统计，避免并发写入互相覆盖。 */
  private readonly indexLock = new DocumentTranslationCacheMutex()
  /** 同一缓存键的写入队列；不同键仍可并行刷新分片。 */
  private readonly keyWriteQueues = new Map<string, Promise<void>>()
  /** 单调递增的访问序号，避免同一时间戳下的 LRU 顺序不确定。 */
  private accessSequence = 0
  /** 单调递增的写版本，用于区分访问刷新与同键持久化内容替换。 */
  private writeSequence = 0

  /**
   * 创建持久化缓存存储。
   * @param options 目录、容量、保留期与时钟。
   * @author zhenghq
   */
  constructor(options: DocumentTranslationCacheStoreOptions) {
    this.directory = options.directory
    this.maxBytes = Math.max(1, Math.floor(options.maxBytes))
    this.maxAgeMs = Math.max(1, Math.floor(options.maxAgeMs))
    this.now = options.now ?? Date.now
  }

  /**
   * 热更新容量与保留期，并立即淘汰超限或过期条目。
   * @param configuration 最新容量与保留期。
   * @returns 配置生效后的 Promise。
   * @author zhenghq
   */
  async configure(configuration: DocumentTranslationCacheConfiguration): Promise<void> {
    await this.withWriteLock(async () => {
      this.maxBytes = Math.max(1, Math.floor(configuration.maxBytes))
      this.maxAgeMs = Math.max(1, Math.floor(configuration.maxAgeMs))
      await this.ensureIndexLocked()
      const now = this.now()
      const expired = [...this.index.values()].filter((entry) => now - entry.savedAt > this.maxAgeMs)
      await this.removeIndexEntries(expired)
      await this.evictIndex(false)
    })
  }

  /**
   * 读取缓存条目；命中时只更新索引中的最近访问时间。
   * @param key 完整缓存键。
   * @returns 已校验条目或 null。
   * @author zhenghq
   */
  async read(key: string): Promise<DocumentTranslationCacheEntry | null> {
    let result: DocumentTranslationCacheEntry | null = null
    await this.withReadLock(async () => {
      await this.ensureIndex()
      const indexed = this.index.get(key)
      if (!indexed) return
      if (this.now() - indexed.savedAt > this.maxAgeMs) {
        await this.removeIndexEntryIfCurrent(indexed)
        return
      }
      try {
        const raw = await readFile(join(this.directory, indexed.relativePath), 'utf8')
        const persisted = parsePersistedShard(JSON.parse(raw) as unknown)
        if (!isPersistedEntry(persisted) || persisted.key !== key) {
          await this.removeIndexEntryIfCurrent(indexed)
          return
        }
        await this.indexLock.run(async () => {
          const current = this.index.get(key)
          // 读取期间若同键已完成新写入，旧分片内容不能覆盖新索引或返回过期结果。
          if (!current || current.relativePath !== indexed.relativePath ||
            current.writeSequence !== indexed.writeSequence) return
          const updated: CacheIndexEntry = {
            ...toCacheIndexEntry(persisted),
            accessedAt: this.now(),
            relativePath: indexed.relativePath,
            accessSequence: this.nextAccessSequence(),
            writeSequence: indexed.writeSequence
          }
          this.totalBytes += updated.size - indexed.size
          this.index.set(key, updated)
          result = persisted.value
        })
      } catch {
        await this.removeIndexEntryIfCurrent(indexed)
      }
    })
    return result
  }

  /**
   * 写入或替换缓存条目，并按 LRU 与总容量淘汰旧条目。
   * @param key 完整缓存键。
   * @param value 已成功完成的翻译结果。
   * @returns 写入完成后的 Promise。
   * @author zhenghq
   */
  async write(key: string, value: DocumentTranslationCacheEntry): Promise<void> {
    if (!key.trim() || !isCacheEntry(value)) return
    await this.enqueueKeyWrite(key, async () => {
      await this.withReadLock(async () => {
        await this.ensureIndex()
        const now = this.now()
        const candidateWithoutSize = {
          key,
          savedAt: now,
          accessedAt: now,
          value: { ...value }
        }
        const candidate: PersistedEntry = {
          ...candidateWithoutSize,
          size: entrySize(candidateWithoutSize)
        }
        if (candidate.size > this.maxBytes) return
        const relativePath = join(
          DOCUMENT_TRANSLATION_CACHE_ENTRIES_DIRECTORY,
          sourceShardDirectory(key),
          shardFileName(key)
        )
        // 新分片必须成功原子落盘后才能提交索引或淘汰旧条目，写入失败时保留原缓存。
        await this.persistShard(relativePath, candidate)
        await this.indexLock.run(async () => {
          const previous = this.index.get(key)
          this.totalBytes += candidate.size - (previous?.size ?? 0)
          this.index.set(key, {
            ...toCacheIndexEntry(candidate),
            relativePath,
            accessSequence: this.nextAccessSequence(),
            writeSequence: this.nextWriteSequence()
          })
          await this.evictIndex(false)
        })
      })
    })
  }

  /**
   * 清空全部缓存并删除磁盘分片。
   * @returns 清空完成后的 Promise。
   * @author zhenghq
   */
  async clear(): Promise<void> {
    await this.withWriteLock(async () => {
      this.index.clear()
      this.totalBytes = 0
      this.indexPromise = Promise.resolve()
      await rm(this.entriesDirectory(), { recursive: true, force: true })
      await rm(this.legacyPath(), { force: true })
    })
  }

  /**
   * 删除指定源文件对应的全部翻译缓存条目，并保留其他源文件缓存。
   * @param sourceSha256 源文件内容哈希。
   * @returns 删除完成后的 Promise。
   * @author zhenghq
   */
  async deleteBySourceSha256(sourceSha256: string): Promise<void> {
    if (!sourceSha256.trim()) return
    await this.withWriteLock(async () => {
      await this.ensureIndexLocked()
      const retained: CacheIndexEntry[] = []
      for (const entry of this.index.values()) {
        if (entry.sourceSha256 === sourceSha256) {
          await this.removeShard(entry.relativePath)
        } else {
          retained.push(entry)
        }
      }
      this.index.clear()
      for (const entry of retained) this.index.set(entry.key, entry)
      this.recalculateTotalBytes()
      await this.removeEmptySourceDirectories()
    })
  }

  /**
   * 在共享读锁内执行缓存操作。
   * @param operation 待执行操作。
   * @returns 操作完成后的 Promise。
   * @author zhenghq
   */
  private async withReadLock(operation: () => Promise<void>): Promise<void> {
    await this.lock.acquireRead()
    try {
      await operation()
    } finally {
      this.lock.releaseRead()
    }
  }

  /**
   * 在独占写锁内执行结构性或容量变更。
   * @param operation 待执行操作。
   * @returns 操作完成后的 Promise。
   * @author zhenghq
   */
  private async withWriteLock(operation: () => Promise<void>): Promise<void> {
    await this.lock.acquireWrite()
    try {
      await operation()
    } finally {
      this.lock.releaseWrite()
    }
  }

  /**
   * 将同一缓存键的写入串行化，同时保留不同键之间的写入并行度。
   * @param key 完整缓存键。
   * @param operation 待执行的写入操作。
   * @returns 写入完成后的 Promise。
   * @author zhenghq
   */
  private async enqueueKeyWrite(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.keyWriteQueues.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.keyWriteQueues.set(key, current)
    try {
      await current
    } finally {
      if (this.keyWriteQueues.get(key) === current) this.keyWriteQueues.delete(key)
    }
  }

  /**
   * 首次使用时扫描分片元数据并迁移旧单文件缓存。
   * @returns 索引就绪后的 Promise。
   * @author zhenghq
   */
  private async ensureIndex(): Promise<void> {
    this.indexPromise ??= this.initializeIndex()
    await this.indexPromise
  }

  /**
   * 在独占锁内确保索引可用，供结构性操作复用。
   * @returns 索引就绪后的 Promise。
   * @author zhenghq
   */
  private async ensureIndexLocked(): Promise<void> {
    await this.ensureIndex()
  }

  /**
   * 首次扫描分片并应用当前容量与保留策略。
   * @returns 初始化完成后的 Promise。
   * @author zhenghq
   */
  private async initializeIndex(): Promise<void> {
    try {
      await this.migrateLegacyCache()
      await this.scanIndex()
      this.recalculateTotalBytes()
      const now = this.now()
      const expired = [...this.index.values()].filter((entry) => now - entry.savedAt > this.maxAgeMs)
      await this.removeIndexEntries(expired)
      await this.evictIndex(true)
    } catch (error) {
      // 损坏目录不应让本次进程永久失去重试机会。
      this.indexPromise = null
      throw error
    }
  }

  /**
   * 扫描分片目录中的合法元数据；损坏分片会被清理。
   * @returns 扫描完成后的 Promise。
   * @author zhenghq
   */
  private async scanIndex(): Promise<void> {
    const visited = new Set<string>()
    const walk = async (relativeDirectory: string): Promise<void> => {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await readdir(join(this.directory, relativeDirectory), { withFileTypes: true })
      } catch {
        return
      }
      for (const item of entries) {
        const relativePath = join(relativeDirectory, item.name)
        if (item.isDirectory()) {
          await walk(relativePath)
          continue
        }
        if (!item.isFile() || !item.name.endsWith('.json')) continue
        visited.add(relativePath)
        try {
          const persisted = parsePersistedShard(
            JSON.parse(await readFile(join(this.directory, relativePath), 'utf8')) as unknown
          )
          if (!persisted) {
            await this.removeShard(relativePath)
            continue
          }
          const candidate: CacheIndexEntry = {
            ...toCacheIndexEntry(normalizePersistedEntry(persisted)),
            relativePath,
            accessSequence: this.nextAccessSequence(),
            writeSequence: this.nextWriteSequence()
          }
          const previous = this.index.get(persisted.key)
          if (!previous || previous.accessedAt < candidate.accessedAt) {
            if (previous) await this.removeShard(previous.relativePath)
            this.index.set(persisted.key, candidate)
          } else {
            await this.removeShard(relativePath)
          }
        } catch {
          await this.removeShard(relativePath)
        }
      }
    }
    await walk(DOCUMENT_TRANSLATION_CACHE_ENTRIES_DIRECTORY)
    for (const [key, entry] of [...this.index]) {
      if (!visited.has(entry.relativePath)) this.index.delete(key)
    }
  }

  /**
   * 将旧版全量单文件迁移为独立分片并删除旧文件，避免升级后重复读取大文件。
   * @returns 迁移完成后的 Promise。
   * @author zhenghq
   */
  private async migrateLegacyCache(): Promise<void> {
    let entries: PersistedEntry[]
    try {
      const raw = await readFile(this.legacyPath(), 'utf8')
      entries = normalizeCacheFile(JSON.parse(raw), this.now(), this.maxAgeMs)
    } catch {
      return
    }
    for (const entry of entries) {
      const relativePath = join(
        DOCUMENT_TRANSLATION_CACHE_ENTRIES_DIRECTORY,
        sourceShardDirectory(entry.key),
        shardFileName(entry.key)
      )
      await this.persistShard(relativePath, entry)
    }
    await rm(this.legacyPath(), { force: true })
  }

  /**
   * 删除一组不能再使用的索引条目及其分片。
   * @param entries 待移除索引条目。
   * @returns 删除完成后的 Promise。
   * @author zhenghq
   */
  private async removeIndexEntries(entries: readonly CacheIndexEntry[]): Promise<void> {
    for (const entry of entries) {
      this.index.delete(entry.key)
      this.totalBytes = Math.max(0, this.totalBytes - entry.size)
      await this.removeShard(entry.relativePath)
    }
    await this.removeEmptySourceDirectories()
  }

  /**
   * 仅当索引仍指向读取时的分片时才移除条目，避免误删并发写入的新结果。
   * @param staleEntry 读取开始时对应的索引条目。
   * @returns 移除完成后的 Promise。
   * @author zhenghq
   */
  private async removeIndexEntryIfCurrent(staleEntry: CacheIndexEntry): Promise<void> {
    await this.indexLock.run(async () => {
      const current = this.index.get(staleEntry.key)
      if (!current || current.relativePath !== staleEntry.relativePath ||
        current.writeSequence !== staleEntry.writeSequence) return
      this.index.delete(staleEntry.key)
      this.totalBytes = Math.max(0, this.totalBytes - staleEntry.size)
      await this.removeShard(staleEntry.relativePath)
    })
    await this.removeEmptySourceDirectories()
  }

  /**
   * 按最近访问时间淘汰，直到缓存总量不超过配置上限。
   * @returns 淘汰完成后的 Promise。
   * @author zhenghq
   */
  private async evictIndex(forceRecalculate: boolean): Promise<void> {
    if (forceRecalculate) this.recalculateTotalBytes()
    if (this.totalBytes <= this.maxBytes) return
    const byAge = [...this.index.values()].sort((left, right) =>
      left.accessedAt - right.accessedAt || left.accessSequence - right.accessSequence)
    for (const entry of byAge) {
      if (this.totalBytes <= this.maxBytes) break
      this.index.delete(entry.key)
      this.totalBytes = Math.max(0, this.totalBytes - entry.size)
      await this.removeShard(entry.relativePath)
    }
    await this.removeEmptySourceDirectories()
  }

  /**
   * 使用唯一临时文件原子写入单个分片。
   * @param relativePath 分片相对路径。
   * @param entry 待持久化条目。
   * @returns 写入完成后的 Promise。
   * @author zhenghq
   */
  private async persistShard(relativePath: string, entry: PersistedEntry): Promise<void> {
    const target = join(this.directory, relativePath)
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}${CACHE_TEMP_FILE_SUFFIX}`
    const file: PersistedShardFile = {
      schemaVersion: DOCUMENT_TRANSLATION_CACHE_SCHEMA_VERSION,
      entry
    }
    await writeFile(temporary, JSON.stringify(file), 'utf8')
    await rename(temporary, target)
  }

  /**
   * 根据当前索引重新计算总字节数。
   * @returns 无返回值。
   * @author zhenghq
   */
  private recalculateTotalBytes(): void {
    this.totalBytes = [...this.index.values()].reduce((sum, entry) => sum + entry.size, 0)
  }

  /**
   * 生成稳定的进程内访问序号。
   * @returns 单调递增的访问序号。
   * @author zhenghq
   */
  private nextAccessSequence(): number {
    this.accessSequence += 1
    return this.accessSequence
  }

  /**
   * 生成稳定的进程内写版本，标识一次持久化内容替换。
   * @returns 单调递增的写版本号。
   * @author zhenghq
   */
  private nextWriteSequence(): number {
    this.writeSequence += 1
    return this.writeSequence
  }

  /**
   * 删除单个分片；文件缺失时不报错。
   * @param relativePath 分片相对路径。
   * @returns 删除完成后的 Promise。
   * @author zhenghq
   */
  private async removeShard(relativePath: string): Promise<void> {
    try {
      await unlink(join(this.directory, relativePath))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  /**
   * 清理已经为空的分片源目录，保持缓存目录整洁。
   * @returns 清理完成后的 Promise。
   * @author zhenghq
   */
  private async removeEmptySourceDirectories(): Promise<void> {
    let directories: import('node:fs').Dirent[]
    try {
      directories = await readdir(this.entriesDirectory(), { withFileTypes: true })
    } catch {
      return
    }
    for (const directory of directories) {
      if (!directory.isDirectory()) continue
      const path = join(this.entriesDirectory(), directory.name)
      try {
        if ((await readdir(path)).length === 0) await rm(path, { recursive: true, force: true })
      } catch {
        // 其他进程可能正在创建或删除目录；清理失败不影响缓存正确性。
      }
    }
  }

  /**
   * 返回分片缓存根目录绝对路径。
   * @returns 分片缓存根目录。
   * @author zhenghq
   */
  private entriesDirectory(): string {
    return join(this.directory, DOCUMENT_TRANSLATION_CACHE_ENTRIES_DIRECTORY)
  }

  /**
   * 返回旧版单文件缓存绝对路径。
   * @returns 旧版缓存文件路径。
   * @author zhenghq
   */
  private legacyPath(): string {
    return join(this.directory, LEGACY_DOCUMENT_TRANSLATION_CACHE_FILE)
  }
}
