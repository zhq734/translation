import type { WebImageCandidate, WebTranslationScope, ExtractedWebTextUnit } from '../shared/webPageTranslation'

/** 页面翻译缓存上下文。 */
export interface WebPageTranslationCacheContext {
  /** 当前网页地址。 */
  url: string
  /** 当前页面内容指纹。 */
  pageFingerprint: string
  /** 翻译范围。 */
  scope: WebTranslationScope
  /** 源语言。 */
  sourceLang: string
  /** 目标语言。 */
  targetLang: string
  /** 翻译服务商和 AI 配置上下文。 */
  translationContext: string
}

/** 可写入页面缓存的翻译单元。 */
export interface WebPageTranslationCacheUnit {
  /** 原始文本节点内容。 */
  sourceText: string
  /** 原文指纹。 */
  sourceFingerprint: string
  /** 成功译文。 */
  translation?: string
  /** 失败原因，存在时不缓存。 */
  error?: string
}

/** 页面翻译缓存配置。 */
export interface WebPageTranslationCacheOptions {
  /** 最多缓存的页面数量。 */
  maxPages?: number
  /** 每页最多缓存的语言方向数量。 */
  maxDirectionsPerPage?: number
  /** 全部页面最多缓存的单元数量。 */
  maxUnits?: number
  /** 全部页面最大估算字节数。 */
  maxBytes?: number
}

/** 可写入页面缓存的图片识别与译文结果。 */
export interface WebPageTranslationCacheImage {
  /** 图片标识。 */
  imageId: string
  /** 图片来源指纹。 */
  sourceFingerprint: string
  /** OCR 识别出的原文。 */
  ocrText: string
  /** 图片文字译文。 */
  translation: string
}

/** 内部页面缓存条目，文本与图片通过 kind 分区。 */
interface WebPageTranslationCacheEntry {
  /** 页面分组键。 */
  pageKey: string
  /** 完整缓存键。 */
  key: string
  /** 条目分区类型。 */
  kind: 'text' | 'image'
  /** 成功译文单元，仅文本分区使用。 */
  units: WebPageTranslationCacheUnit[]
  /** 图片识别与译文结果，仅图片分区使用。 */
  image?: WebPageTranslationCacheImage
  /** 估算字节数。 */
  bytes: number
}

/**
 * 管理同一应用会话内网页译文的有界内存 LRU 缓存。
 * @author zhenghq
 */
export class WebPageTranslationCache {
  private readonly entries = new Map<string, WebPageTranslationCacheEntry>()
  private readonly maxPages: number
  private readonly maxDirectionsPerPage: number
  private readonly maxUnits: number
  private readonly maxBytes: number
  private unitCount = 0
  private byteCount = 0

  /**
   * 创建页面翻译缓存。
   * @param options 页面数、语言方向、单元数和容量上限。
   * @author zhenghq
   */
  constructor(options: WebPageTranslationCacheOptions = {}) {
    this.maxPages = Math.max(1, Math.floor(options.maxPages ?? 30))
    this.maxDirectionsPerPage = Math.max(1, Math.floor(options.maxDirectionsPerPage ?? 3))
    this.maxUnits = Math.max(1, Math.floor(options.maxUnits ?? 30_000))
    this.maxBytes = Math.max(1, Math.floor(options.maxBytes ?? 30 * 1024 * 1024))
  }

  /**
   * 返回当前缓存页面数量。
   * @returns 按页面上下文去重后的页面数量。
   * @author zhenghq
   */
  get pageCount(): number {
    return new Set(Array.from(this.entries.values(), (entry) => entry.pageKey)).size
  }

  /**
   * 写入成功译文并执行页面、语言方向和容量淘汰。
   * @param context 页面和翻译上下文。
   * @param units 待缓存的文本单元。
   * @returns 实际缓存的成功译文数量。
   * @author zhenghq
   */
  put(context: WebPageTranslationCacheContext, units: WebPageTranslationCacheUnit[]): number {
    const successful = units
      .filter((unit): unit is WebPageTranslationCacheUnit & { translation: string } => !unit.error && typeof unit.translation === 'string')
      .map((unit) => ({ ...unit }))
    const { pageKey, key } = this.keys(context)
    this.remove(key)
    if (successful.length === 0) return 0
    const bytes = this.estimate(key, successful)
    if (successful.length > this.maxUnits || bytes > this.maxBytes) return 0
    const entry: WebPageTranslationCacheEntry = { pageKey, key, kind: 'text', units: successful, bytes }
    this.entries.set(key, entry)
    this.unitCount += successful.length
    this.byteCount += bytes
    this.trimDirections(pageKey)
    this.trimPages()
    this.trimCapacity()
    return this.entries.has(key) ? successful.length : 0
  }

  /**
   * 写入成功的图片 OCR 与译文结果，失败、取消或跳过结果不缓存。
   * @param context 页面和翻译上下文。
   * @param candidates 带识别与译文结果的图片候选。
   * @returns 实际缓存的图片数量。
   * @author zhenghq
   */
  putImages(context: WebPageTranslationCacheContext, candidates: readonly WebImageCandidate[]): number {
    const successful = candidates.filter((candidate): candidate is WebImageCandidate & { ocrText: string; translation: string } =>
      typeof candidate.imageId === 'string' && candidate.imageId !== '' &&
      typeof candidate.sourceFingerprint === 'string' && candidate.sourceFingerprint !== '' &&
      typeof candidate.ocrText === 'string' && candidate.ocrText.trim() !== '' &&
      typeof candidate.translation === 'string' && candidate.translation.trim() !== '' &&
      !candidate.error && !candidate.skippedReason)
    let stored = 0
    for (const candidate of successful) {
      const key = this.imageKey(context, candidate)
      this.remove(key)
      const image: WebPageTranslationCacheImage = {
        imageId: candidate.imageId,
        sourceFingerprint: candidate.sourceFingerprint as string,
        ocrText: candidate.ocrText,
        translation: candidate.translation
      }
      const bytes = this.estimateImage(key, image)
      if (bytes > this.maxBytes) continue
      const entry: WebPageTranslationCacheEntry = {
        pageKey: this.keys(context).pageKey,
        key,
        kind: 'image',
        units: [],
        image,
        bytes
      }
      this.entries.set(key, entry)
      this.unitCount += 1
      this.byteCount += bytes
      this.trimDirections(entry.pageKey)
      this.trimPages()
      this.trimCapacity()
      if (this.entries.has(key)) stored += 1
    }
    return stored
  }

  /**
   * 将缓存图片结果与当前快照按标识与来源指纹匹配。
   * @param context 当前页面和翻译上下文。
   * @param currentCandidates 当前页面重新提取的图片候选。
   * @returns 使用当前锚点并带上缓存识别与译文的候选列表。
   * @author zhenghq
   */
  matchImages(
    context: WebPageTranslationCacheContext,
    currentCandidates: readonly WebImageCandidate[]
  ): Array<WebImageCandidate & { ocrText: string; translation: string }> {
    const matched: Array<WebImageCandidate & { ocrText: string; translation: string }> = []
    for (const candidate of currentCandidates) {
      if (typeof candidate.imageId !== 'string' || candidate.imageId === '') continue
      if (typeof candidate.sourceFingerprint !== 'string' || candidate.sourceFingerprint === '') continue
      const key = this.imageKey(context, candidate)
      const entry = this.entries.get(key)
      if (!entry?.image) continue
      this.touch(key, entry)
      matched.push({
        ...candidate,
        ocrText: entry.image.ocrText,
        translation: entry.image.translation
      })
    }
    return matched
  }

  /**
   * 将缓存译文与当前页面快照按原文和指纹匹配。
   * @param context 当前页面和翻译上下文。
   * @param currentUnits 当前页面重新提取的文本单元。
   * @returns 使用当前单元标识和锚点的缓存命中结果。
   * @author zhenghq
   */
  match(
    context: WebPageTranslationCacheContext,
    currentUnits: ExtractedWebTextUnit[]
  ): Array<ExtractedWebTextUnit & { translation: string }> {
    const { key } = this.keys(context)
    const entry = this.entries.get(key)
    if (!entry) return []
    this.touch(key, entry)
    const cached = new Map<string, WebPageTranslationCacheUnit[]>()
    for (const unit of entry.units) {
      const matchKey = `${unit.sourceFingerprint}\u0000${unit.sourceText}`
      const list = cached.get(matchKey) ?? []
      list.push(unit)
      cached.set(matchKey, list)
    }
    const matched: Array<ExtractedWebTextUnit & { translation: string }> = []
    for (const unit of currentUnits) {
      const matchKey = `${unit.anchor.sourceFingerprint}\u0000${unit.sourceText}`
      const hit = cached.get(matchKey)?.shift()
      if (hit?.translation === undefined) continue
      matched.push({ ...unit, anchor: { ...unit.anchor }, translation: hit.translation })
    }
    return matched
  }

  /**
   * 清空全部页面译文缓存。
   * @returns 无返回值。
   * @author zhenghq
   */
  clear(): void {
    this.entries.clear()
    this.unitCount = 0
    this.byteCount = 0
  }

  /**
   * 构造规范化页面键和完整语言方向键。
   * @param context 页面缓存上下文。
   * @returns 页面分组键和完整缓存键。
   * @author zhenghq
   */
  private keys(context: WebPageTranslationCacheContext): { pageKey: string; key: string } {
    const url = normalizeWebPageCacheUrl(context.url)
    const pageKey = `${url}|${context.pageFingerprint}|${context.scope}|${context.translationContext}`
    return { pageKey, key: `${pageKey}|${context.sourceLang}>${context.targetLang}` }
  }

  /**
   * 刷新缓存条目的最近使用顺序。
   * @param key 完整缓存键。
   * @param entry 缓存条目。
   * @returns 无返回值。
   * @author zhenghq
   */
  private touch(key: string, entry: WebPageTranslationCacheEntry): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
  }

  /**
   * 删除缓存条目并同步容量统计。
   * @param key 完整缓存键。
   * @returns 是否删除成功。
   * @author zhenghq
   */
  private remove(key: string): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false
    this.entries.delete(key)
    this.unitCount -= entry.kind === 'image' ? 1 : entry.units.length
    this.byteCount -= entry.bytes
    return true
  }

  /**
   * 淘汰同一页面超过限制的最旧语言方向。
   * @param pageKey 页面分组键。
   * @returns 无返回值。
   * @author zhenghq
   */
  private trimDirections(pageKey: string): void {
    const keys = Array.from(this.entries.values())
      .filter((entry) => entry.pageKey === pageKey && entry.kind === 'text')
      .map((entry) => entry.key)
    while (keys.length > this.maxDirectionsPerPage) this.remove(keys.shift() as string)
  }

  /**
   * 淘汰超过页面数量限制的最旧页面及其全部语言方向。
   * @returns 无返回值。
   * @author zhenghq
   */
  private trimPages(): void {
    while (this.pageCount > this.maxPages) {
      const oldest = this.entries.values().next().value as WebPageTranslationCacheEntry | undefined
      if (!oldest) return
      for (const entry of Array.from(this.entries.values())) {
        if (entry.pageKey === oldest.pageKey) this.remove(entry.key)
      }
    }
  }

  /**
   * 淘汰超过总单元数或估算容量的最旧缓存条目。
   * @returns 无返回值。
   * @author zhenghq
   */
  private trimCapacity(): void {
    while (this.unitCount > this.maxUnits || this.byteCount > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (!oldest) return
      this.remove(oldest)
    }
  }

  /**
   * 估算页面缓存条目占用字节数。
   * @param key 完整缓存键。
   * @param units 成功译文单元。
   * @returns UTF-16 近似字节数。
   * @author zhenghq
   */
  private estimate(key: string, units: WebPageTranslationCacheUnit[]): number {
    return (key.length + units.reduce((sum, unit) => sum + unit.sourceText.length + unit.sourceFingerprint.length + (unit.translation?.length ?? 0), 0)) * 2
  }

  /**
   * 构造图片缓存键，与文本分区使用不同前缀避免互相覆盖。
   * @param context 页面缓存上下文。
   * @param image 图片标识与来源指纹。
   * @returns 图片完整缓存键。
   * @author zhenghq
   */
  private imageKey(
    context: WebPageTranslationCacheContext,
    image: Pick<WebImageCandidate, 'imageId' | 'sourceFingerprint'>
  ): string {
    const { key } = this.keys(context)
    return `${key}|image|${image.imageId}|${image.sourceFingerprint ?? ''}`
  }

  /**
   * 估算图片缓存条目占用字节数。
   * @param key 图片完整缓存键。
   * @param image 图片缓存内容。
   * @returns UTF-16 近似字节数。
   * @author zhenghq
   */
  private estimateImage(key: string, image: WebPageTranslationCacheImage): number {
    return (key.length + image.ocrText.length + image.translation.length + image.sourceFingerprint.length) * 2
  }
}

/**
 * 根据页面文本单元顺序生成稳定的页面内容指纹。
 * @param units 当前页面文本单元，只使用原文内容和原文指纹。
 * @returns 八位十六进制页面内容指纹。
 * @author zhenghq
 */
export function createWebPageContentFingerprint(
  units: ReadonlyArray<Pick<ExtractedWebTextUnit, 'sourceText' | 'text' | 'anchor'>>
): string {
  let hash = 2166136261
  for (const unit of units) {
    const value = `${unit.anchor.sourceFingerprint}\u0000${unit.text || unit.sourceText}`
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    hash ^= 0xff
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 规范化页面缓存 URL，忽略不会改变正文的片段标识。
 * @param value 原始页面地址。
 * @returns 规范化 HTTP(S) URL，解析失败时返回去除片段的原值。
 * @author zhenghq
 */
export function normalizeWebPageCacheUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString()
  } catch {
    return value.split('#', 1)[0]
  }
}
