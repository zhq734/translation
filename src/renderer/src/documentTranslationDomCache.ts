/** 缓存译文 DOM 时的身份与签名描述。 */
export interface DocumentTranslationDomCacheKey {
  /** 译文 DOM 所属的 Tab 标识。 */
  tabId: string
  /** 文件内容指纹；文件变化时禁止复用。 */
  sha256: string
  /** 任务标识；跨任务禁止复用。 */
  jobId: string
  /** 译文内容签名。 */
  signature: string
  /** 译文警告签名。 */
  warningSignature: string
}

/** 写入缓存的译文 DOM 条目。 */
export interface DocumentTranslationDomCacheEntry extends DocumentTranslationDomCacheKey {
  /** 译文预览类型，复用时恢复容器标记。 */
  previewKind: string
  /** 已构建的译文容器子节点列表；复用时按原顺序重新挂载。 */
  content: readonly HTMLElement[]
}

/** 译文 DOM 缓存对外接口。 */
export interface DocumentTranslationDomCache {
  /** 写入最近构建的译文 DOM；超限时按最近最少使用淘汰。 */
  remember(entry: DocumentTranslationDomCacheEntry): void
  /** 按身份与签名读取缓存；命中会刷新最近使用顺序。 */
  take(key: DocumentTranslationDomCacheKey): DocumentTranslationDomCacheEntry | null
  /** 显式移除指定 Tab 的缓存。 */
  remove(tabId: string): void
  /** 当前仍被缓存的全部 Tab 标识。 */
  cachedTabIds(): Iterable<string>
  /** 注册淘汰回调；用于同步释放对应 Tab 的图片 Blob URL。 */
  onEvict(listener: (tabId: string) => void): void
}

/** 缓存中的译文 DOM 条目。 */
interface CachedTranslationDomEntry extends DocumentTranslationDomCacheEntry {
  /** 最近使用时钟，用于最近最少使用淘汰。 */
  lastUsedAt: number
}

/** 最近最少使用淘汰时钟。 */
let lruClock = 0

/**
 * 判断缓存条目是否与请求键完全匹配。
 * @param entry 缓存条目。
 * @param key 请求键。
 * @returns 全部字段一致时返回 true。
 * @author zhenghq
 */
function matchesKey(entry: CachedTranslationDomEntry, key: DocumentTranslationDomCacheKey): boolean {
  return entry.tabId === key.tabId &&
    entry.sha256 === key.sha256 &&
    entry.jobId === key.jobId &&
    entry.signature === key.signature &&
    entry.warningSignature === key.warningSignature
}

/**
 * 创建按 Tab 复用的译文 DOM 缓存。
 * Tab 切换时直接重新挂载已构建的译文 DOM，避免 1132 个区块的同步重建卡住主线程。
 * @param options 缓存容量；默认保留 4 个 Tab 的译文 DOM。
 * @returns 可复用、可显式移除的译文 DOM 缓存。
 * @author zhenghq
 */
export function createDocumentTranslationDomCache(
  options: { capacity?: number } = {}
): DocumentTranslationDomCache {
  const capacity = Math.max(1, options.capacity ?? 4)
  const entries = new Map<string, CachedTranslationDomEntry>()
  const evictListeners = new Set<(tabId: string) => void>()

  /**
   * 淘汰指定 Tab 并通知监听者释放关联资源。
   * @param tabId 被淘汰的 Tab 标识。
   * @returns 无返回值。
   * @author zhenghq
   */
  function evict(tabId: string): void {
    entries.delete(tabId)
    for (const listener of evictListeners) listener(tabId)
  }

  /**
   * 淘汰最近最少使用的译文 DOM 直到缓存回到容量内。
   * @returns 无返回值。
   * @author zhenghq
   */
  function evictBeyondCapacity(): void {
    while (entries.size > capacity) {
      let oldestKey: string | null = null
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [tabId, entry] of entries) {
        if (entry.lastUsedAt < oldestAt) {
          oldestAt = entry.lastUsedAt
          oldestKey = tabId
        }
      }
      if (oldestKey === null) break
      evict(oldestKey)
    }
  }

  return {
    /**
     * 写入最近构建的译文 DOM。
     * @param entry 译文 DOM 条目。
     * @returns 无返回值。
     * @author zhenghq
     */
    remember(entry: DocumentTranslationDomCacheEntry): void {
      entries.set(entry.tabId, { ...entry, lastUsedAt: ++lruClock })
      evictBeyondCapacity()
    },
    /**
     * 按身份与签名读取缓存。
     * @param key 请求键。
     * @returns 命中的译文 DOM 条目；未命中返回 null。
     * @author zhenghq
     */
    take(key: DocumentTranslationDomCacheKey): DocumentTranslationDomCacheEntry | null {
      const entry = entries.get(key.tabId)
      if (!entry || !matchesKey(entry, key)) return null
      entry.lastUsedAt = ++lruClock
      return entry
    },
    /**
     * 显式移除指定 Tab 的缓存。
     * @param tabId Tab 标识。
     * @returns 无返回值。
     * @author zhenghq
     */
    remove(tabId: string): void {
      if (entries.has(tabId)) evict(tabId)
    },
    /**
     * 当前仍被缓存的全部 Tab 标识。
     * @returns Tab 标识集合。
     * @author zhenghq
     */
    *cachedTabIds(): Iterable<string> {
      yield* entries.keys()
    },
    /**
     * 注册淘汰回调。
     * @param listener 淘汰回调。
     * @returns 无返回值。
     * @author zhenghq
     */
    onEvict(listener: (tabId: string) => void): void {
      evictListeners.add(listener)
    }
  }
}
