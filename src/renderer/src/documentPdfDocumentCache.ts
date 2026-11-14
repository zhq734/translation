/** 可销毁的 PDF 文档代理最小接口。 */
export type PdfDocumentProxyLike = {
  /** 释放 PDF.js 文档占用的解析内存。 */
  destroy(): Promise<void>
}

/** PDF 文档缓存对外接口。 */
export interface DocumentPdfDocumentCache<T extends PdfDocumentProxyLike = PdfDocumentProxyLike> {
  /** 按文件指纹读取缓存的 PDF 文档；命中会刷新最近使用顺序。 */
  get(sha256: string): T | null
  /** 写入新解析的 PDF 文档；超限时按最近最少使用淘汰并销毁。 */
  set(sha256: string, pdfDocument: T): void
  /** 显式删除指定文档并立即销毁。 */
  delete(sha256: string): void
}

/** 缓存中的 PDF 文档条目。 */
interface CachedPdfDocumentEntry<T extends PdfDocumentProxyLike = PdfDocumentProxyLike> {
  /** 已解析的 PDF 文档代理。 */
  pdfDocument: T
  /** 最近使用时钟，用于最近最少使用淘汰。 */
  lastUsedAt: number
}

/** 最近最少使用淘汰时钟。 */
let lruClock = 0

/**
 * 创建按文件指纹复用的 PDF 文档缓存。
 * Tab 切换重渲染原文时直接复用已解析文档，避免重复读取 44MB 源字节并重新解析。
 * @param options 缓存容量；默认保留 6 个大文档。
 * @returns 可复用、可显式删除的 PDF 文档缓存。
 * @author zhenghq
 */
export function createDocumentPdfDocumentCache<T extends PdfDocumentProxyLike = PdfDocumentProxyLike>(
  options: { capacity?: number } = {}
): DocumentPdfDocumentCache<T> {
  const capacity = Math.max(1, options.capacity ?? 6)
  const entries = new Map<string, CachedPdfDocumentEntry<T>>()

  /**
   * 销毁并移除指定缓存条目。
   * @param sha256 文件指纹。
   * @param entry 待销毁的缓存条目。
   * @returns 无返回值。
   * @author zhenghq
   */
  function destroyEntry(sha256: string, entry: CachedPdfDocumentEntry<T>): void {
    entries.delete(sha256)
    void entry.pdfDocument.destroy().catch(() => undefined)
  }

  /**
   * 淘汰最近最少使用的文档直到缓存回到容量内。
   * @returns 无返回值。
   * @author zhenghq
   */
  function evictBeyondCapacity(): void {
    while (entries.size > capacity) {
      let oldestKey: string | null = null
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [sha256, entry] of entries) {
        if (entry.lastUsedAt < oldestAt) {
          oldestAt = entry.lastUsedAt
          oldestKey = sha256
        }
      }
      if (oldestKey === null) break
      const entry = entries.get(oldestKey)
      if (entry) destroyEntry(oldestKey, entry)
    }
  }

  return {
    /**
     * 按文件指纹读取缓存的 PDF 文档。
     * @param sha256 文件指纹。
     * @returns 命中的 PDF 文档；未命中返回 null。
     * @author zhenghq
     */
    get(sha256: string): T | null {
      const entry = entries.get(sha256)
      if (!entry) return null
      entry.lastUsedAt = ++lruClock
      return entry.pdfDocument
    },
    /**
     * 写入新解析的 PDF 文档；同指纹旧文档被替换销毁，超限时淘汰最久未用文档。
     * @param sha256 文件指纹。
     * @param pdfDocument 已解析的 PDF 文档代理。
     * @returns 无返回值。
     * @author zhenghq
     */
    set(sha256: string, pdfDocument: T): void {
      const existing = entries.get(sha256)
      if (existing && existing.pdfDocument !== pdfDocument) {
        destroyEntry(sha256, existing)
      }
      entries.set(sha256, { pdfDocument, lastUsedAt: ++lruClock })
      evictBeyondCapacity()
    },
    /**
     * 显式删除指定文档并立即销毁。
     * @param sha256 文件指纹。
     * @returns 无返回值。
     * @author zhenghq
     */
    delete(sha256: string): void {
      const entry = entries.get(sha256)
      if (entry) destroyEntry(sha256, entry)
    }
  }
}
