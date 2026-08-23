/** 有界 LRU 缓存配置。 */
export interface BoundedLruCacheOptions<K, V> {
  /** 最大条目数。 */
  maxEntries: number
  /** 最大估算字节数。 */
  maxBytes: number
  /** 估算单条缓存占用的函数。 */
  sizeOf(key: K, value: V): number
}

/** 内部缓存条目。 */
interface BoundedLruEntry<V> {
  /** 缓存值。 */
  value: V
  /** 估算字节数。 */
  bytes: number
}

/**
 * 提供条目数和估算容量双重边界的内存 LRU 缓存。
 * @author zhenghq
 */
export class BoundedLruCache<K, V> {
  private readonly entries = new Map<K, BoundedLruEntry<V>>()
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly sizeOf: (key: K, value: V) => number
  private bytes = 0

  /**
   * 创建有界 LRU 缓存。
   * @param options 条目上限、容量上限和估算函数。
   * @author zhenghq
   */
  constructor(options: BoundedLruCacheOptions<K, V>) {
    this.maxEntries = Math.max(0, Math.floor(options.maxEntries))
    this.maxBytes = Math.max(0, Math.floor(options.maxBytes))
    this.sizeOf = options.sizeOf
  }

  /**
   * 返回当前缓存条目数。
   * @returns 当前条目数。
   * @author zhenghq
   */
  get size(): number {
    return this.entries.size
  }

  /**
   * 返回当前估算容量。
   * @returns 当前估算字节数。
   * @author zhenghq
   */
  get estimatedBytes(): number {
    return this.bytes
  }

  /**
   * 读取缓存并刷新最近使用顺序。
   * @param key 缓存键。
   * @returns 命中的缓存值，未命中时返回 undefined。
   * @author zhenghq
   */
  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  /**
   * 判断缓存键是否存在但不改变最近使用顺序。
   * @param key 缓存键。
   * @returns 缓存键是否存在。
   * @author zhenghq
   */
  has(key: K): boolean {
    return this.entries.has(key)
  }

  /**
   * 写入缓存并淘汰最久未使用条目。
   * @param key 缓存键。
   * @param value 缓存值。
   * @returns 当前值是否成功保留在缓存中。
   * @author zhenghq
   */
  set(key: K, value: V): boolean {
    this.delete(key)
    const bytes = Math.max(0, Math.ceil(this.sizeOf(key, value)))
    if (this.maxEntries === 0 || this.maxBytes === 0 || bytes > this.maxBytes) return false
    this.entries.set(key, { value, bytes })
    this.bytes += bytes
    this.trim()
    return this.entries.has(key)
  }

  /**
   * 删除指定缓存条目。
   * @param key 缓存键。
   * @returns 是否删除了已有条目。
   * @author zhenghq
   */
  delete(key: K): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false
    this.entries.delete(key)
    this.bytes -= entry.bytes
    return true
  }

  /**
   * 清空全部缓存条目。
   * @returns 无返回值。
   * @author zhenghq
   */
  clear(): void {
    this.entries.clear()
    this.bytes = 0
  }

  /**
   * 按从最久未使用到最近使用的顺序返回缓存键。
   * @returns 缓存键数组。
   * @author zhenghq
   */
  keys(): K[] {
    return Array.from(this.entries.keys())
  }

  /**
   * 淘汰超过条目数或容量限制的最旧条目。
   * @returns 无返回值。
   * @author zhenghq
   */
  private trim(): void {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as K | undefined
      if (oldest === undefined) return
      this.delete(oldest)
    }
  }
}
