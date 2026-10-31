import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DOCUMENT_TRANSLATION_PROTOCOL_VERSION,
  type DocumentTranslationCacheEntry
} from '../shared/documentTranslation.ts'

/** 文档翻译持久化缓存结构版本；不兼容变更时必须递增。 */
export const DOCUMENT_TRANSLATION_CACHE_SCHEMA_VERSION = 1

/** 默认缓存文件名。 */
const DOCUMENT_TRANSLATION_CACHE_FILE = 'translation-cache.json'

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

/** 磁盘缓存文件结构。 */
interface PersistedCacheFile {
  /** 缓存结构版本。 */
  schemaVersion: number
  /** 全部缓存条目。 */
  entries: PersistedEntry[]
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
    typeof languagePair.targetLang === 'string' &&
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
 * 计算持久化条目的近似字节数，确保容量限制对磁盘文件同样有效。
 * @param entry 待计算条目。
 * @returns UTF-8 JSON 字节数。
 * @author zhenghq
 */
function entrySize(entry: Omit<PersistedEntry, 'size'>): number {
  return Buffer.byteLength(JSON.stringify(entry), 'utf8')
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
  const file = value as Partial<PersistedCacheFile>
  if (file.schemaVersion !== DOCUMENT_TRANSLATION_CACHE_SCHEMA_VERSION || !Array.isArray(file.entries)) {
    return []
  }
  const byKey = new Map<string, PersistedEntry>()
  for (const candidate of file.entries) {
    if (!isPersistedEntry(candidate)) continue
    if (now - candidate.savedAt > maxAgeMs) continue
    const previous = byKey.get(candidate.key)
    if (!previous || previous.accessedAt < candidate.accessedAt) byKey.set(candidate.key, candidate)
  }
  return [...byKey.values()]
}

/**
 * 文档翻译磁盘缓存；所有写操作串行执行并采用临时文件原子替换。
 * @author zhenghq
 */
export class DocumentTranslationCacheStore {
  /** 缓存目录。 */
  private readonly directory: string
  /** 最大缓存字节数。 */
  private readonly maxBytes: number
  /** 条目保留时间。 */
  private readonly maxAgeMs: number
  /** 可注入时钟。 */
  private readonly now: () => number
  /** 串行化读写，避免并发写入互相覆盖。 */
  private queue: Promise<void> = Promise.resolve()

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
   * 读取缓存条目；命中时更新最近访问时间。
   * @param key 完整缓存键。
   * @returns 已校验条目或 null。
   * @author zhenghq
   */
  async read(key: string): Promise<DocumentTranslationCacheEntry | null> {
    let result: DocumentTranslationCacheEntry | null = null
    await this.enqueue(async () => {
      const entries = await this.load()
      const index = entries.findIndex((entry) => entry.key === key)
      if (index < 0) return
      const entry = entries[index]!
      entries[index] = { ...entry, accessedAt: this.now() }
      result = entry.value
      await this.persist(entries)
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
    await this.enqueue(async () => {
      const now = this.now()
      const entries = (await this.load()).filter((entry) => entry.key !== key)
      const candidateWithoutSize = { key, savedAt: now, accessedAt: now, value: { ...value } }
      const candidate: PersistedEntry = {
        ...candidateWithoutSize,
        size: entrySize(candidateWithoutSize)
      }
      if (candidate.size > this.maxBytes) return
      entries.push(candidate)
      this.evict(entries)
      await this.persist(entries)
    })
  }

  /**
   * 清空全部缓存并删除磁盘文件内容。
   * @returns 清空完成后的 Promise。
   * @author zhenghq
   */
  async clear(): Promise<void> {
    await this.enqueue(async () => this.persist([]))
  }

  /**
   * 删除指定源文件对应的全部翻译缓存条目，并保留其他源文件缓存。
   * @param sourceSha256 源文件内容哈希。
   * @returns 删除完成后的 Promise。
   * @author zhenghq
   */
  async deleteBySourceSha256(sourceSha256: string): Promise<void> {
    if (!sourceSha256.trim()) return
    await this.enqueue(async () => {
      const entries = await this.load()
      const retained = entries.filter((entry) => entry.value.sourceSha256 !== sourceSha256)
      if (retained.length === entries.length) return
      await this.persist(retained)
    })
  }

  /**
   * 将操作加入串行队列，并保持队列在异常后继续可用。
   * @param operation 待执行操作。
   * @returns 操作完成后的 Promise。
   * @author zhenghq
   */
  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation, operation)
    this.queue = next.catch(() => undefined)
    await next
  }

  /**
   * 从磁盘读取并规范化缓存；文件缺失或损坏时回退为空列表。
   * @returns 安全缓存条目。
   * @author zhenghq
   */
  private async load(): Promise<PersistedEntry[]> {
    try {
      const raw = await readFile(this.path(), 'utf8')
      return normalizeCacheFile(JSON.parse(raw), this.now(), this.maxAgeMs)
    } catch {
      return []
    }
  }

  /**
   * 按最近访问时间淘汰，直到缓存总量不超过配置上限。
   * @param entries 可修改的缓存条目列表。
   * @returns 无返回值。
   * @author zhenghq
   */
  private evict(entries: PersistedEntry[]): void {
    entries.sort((left, right) => left.accessedAt - right.accessedAt)
    let total = entries.reduce((sum, entry) => sum + entry.size, 0)
    while (entries.length > 0 && total > this.maxBytes) {
      const removed = entries.shift()
      if (removed) total -= removed.size
    }
  }

  /**
   * 使用临时文件原子写入缓存，避免进程中断留下半截 JSON。
   * @param entries 待写入条目。
   * @returns 写入完成后的 Promise。
   * @author zhenghq
   */
  private async persist(entries: PersistedEntry[]): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const file: PersistedCacheFile = {
      schemaVersion: DOCUMENT_TRANSLATION_CACHE_SCHEMA_VERSION,
      entries
    }
    const target = this.path()
    const temporary = `${target}.tmp`
    await writeFile(temporary, JSON.stringify(file), 'utf8')
    await rename(temporary, target)
  }

  /**
   * 返回缓存文件绝对路径。
   * @returns 缓存文件路径。
   * @author zhenghq
   */
  private path(): string {
    return join(this.directory, DOCUMENT_TRANSLATION_CACHE_FILE)
  }
}
