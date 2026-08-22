import { createHash } from 'node:crypto'
import type { OcrEngineId } from '../shared/types'

/** OCR 结果缓存条目。 */
export interface OcrCacheEntry {
  /** 清洗后的 OCR 文本。 */
  text: string
  /** 产出该文本的引擎。 */
  engine: OcrEngineId
  /** 文本质量分。 */
  score: number
  /** 条目写入时间（毫秒）。 */
  createdAt: number
}

/**
 * 构建 OCR 缓存键：引擎 + 语言 + 图片字节 SHA1。
 * 任一输入变化都会得到不同键，保证缓存命中语义精确。
 * @param imageBytes 图片字节（PNG 等）。
 * @param language OCR 语言设置。
 * @param engine 产出结果的引擎。
 * @returns 形如 `engine|language|<sha1>` 的缓存键。
 * @author zhenghq
 */
export function buildOcrCacheKey(
  imageBytes: Uint8Array,
  language: string,
  engine: OcrEngineId
): string {
  const hash = createHash('sha1')
  hash.update(language)
  hash.update('\u0000')
  hash.update(engine)
  hash.update('\u0000')
  hash.update(Buffer.from(imageBytes))
  return `${engine}|${language}|${hash.digest('hex')}`
}

/**
 * OCR 结果缓存：按最近最少使用（LRU）策略限制条目数量，
 * 避免同一画面重复识别，同时防止缓存无限增长。
 * @author zhenghq
 */
export class OcrResultCache {
  private readonly entries = new Map<string, OcrCacheEntry>()
  private readonly capacity: number
  private readonly now: () => number

  /**
   * 创建 OCR 结果缓存。
   * @param capacity 最大条目数，默认 60。
   * @param now 可注入的时钟，便于测试固定时间。
   * @author zhenghq
   */
  constructor(capacity = 60, now: () => number = () => Date.now()) {
    this.capacity = Math.max(1, capacity)
    this.now = now
  }

  /**
   * 读取缓存条目；命中时刷新其 LRU 位置。
   * @param key 缓存键。
   * @returns 命中的条目；未命中返回 null。
   * @author zhenghq
   */
  get(key: string): OcrCacheEntry | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  /**
   * 判断缓存是否包含指定键（不刷新 LRU 位置）。
   * @param key 缓存键。
   * @returns 是否包含该键。
   * @author zhenghq
   */
  has(key: string): boolean {
    return this.entries.has(key)
  }

  /**
   * 写入缓存条目；超容量时淘汰最久未访问的条目。
   * @param key 缓存键。
   * @param entry 缓存条目。
   * @returns 无返回值。
   * @author zhenghq
   */
  set(key: string, entry: Omit<OcrCacheEntry, 'createdAt'>): void {
    this.entries.delete(key)
    this.entries.set(key, { ...entry, createdAt: this.now() })
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  /**
   * 清空全部缓存条目。
   * @returns 无返回值。
   * @author zhenghq
   */
  clear(): void {
    this.entries.clear()
  }

  /** 当前缓存条目数。 */
  get size(): number {
    return this.entries.size
  }
}
