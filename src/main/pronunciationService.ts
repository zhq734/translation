import { BoundedLruCache } from './boundedLruCache'
import { parsePronunciationDictionaryResponse } from '../shared/pronunciationDictionary'
import { parsePronunciationWord, type ParsedPronunciationWord } from '../shared/pronunciationWord'
import type { IscorevocEntry } from '../shared/pronunciationIscorevoc'
import type {
  PronunciationAudioResult,
  PronunciationDefinition,
  PronunciationResult,
  PronunciationVariant
} from '../shared/types'

/** 词典查询地址前缀。 */
const DICTIONARY_API_BASE = 'https://api.dictionaryapi.dev/api/v2/entries/en/'
/** 默认词典响应上限，避免异常上游占满主进程内存。 */
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024
/** 默认音频上限，词典发音文件通常远小于该值。 */
const DEFAULT_MAX_AUDIO_BYTES = 2 * 1024 * 1024
/** 默认查询超时。 */
const DEFAULT_TIMEOUT_MS = 3500
/** 缓存条目上限。 */
const CACHE_MAX_ENTRIES = 100
/** 缓存估算容量上限。 */
const CACHE_MAX_BYTES = 2 * 1024 * 1024

/** 主进程音标服务依赖。 */
export interface PronunciationServiceOptions {
  /** 可注入的网络请求实现，生产环境使用 translationFetch。 */
  fetch: (input: string | Request, init?: RequestInit) => Promise<Response>
  /** 本地雅思词表查询；命中时补充中文释义和备选 IPA。 */
  ieltsDictionary?: {
    /**
     * 查询本地词条。
     * @param word 已规范化的英文单词。
     * @returns 命中的词条；未命中时返回 null 或 undefined。
     * @author zhenghq
     */
    lookup(word: string): IscorevocEntry | null | undefined
  }
  /** 查询与下载超时毫秒数。 */
  timeoutMs?: number
  /** 词典 JSON 响应大小上限。 */
  maxResponseBytes?: number
  /** 音频响应大小上限。 */
  maxAudioBytes?: number
}

/** 缓存中的音标元数据与内部音频映射。 */
interface CachedPronunciation {
  /** 可返回 Renderer 的脱敏结果。 */
  result: PronunciationResult
  /** 变体 ID 到上游音频地址的映射，只保留在主进程。 */
  audioUrls: Record<string, string>
}

/** 同一单词共享查询的内部状态。 */
interface SharedLookup {
  /** 所有调用方共享的查询 Promise。 */
  promise: Promise<PronunciationResult>
  /** 当前仍等待该查询的调用方数量。 */
  waiterCount: number
  /** 带取消信号的调用方控制器。 */
  subscribers: Set<AbortController>
  /** 上游请求取消控制器。 */
  upstream: AbortController
}

/**
 * 读取响应体并在超过上限时中止，避免把超大内容完整读入内存。
 * @param response 上游响应。
 * @param maxBytes 允许的最大字节数。
 * @returns 完整字节；超限、空响应或读取失败时返回 null。
 * @author zhenghq
 */
async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return null
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer())
    return buffer.byteLength > maxBytes ? null : buffer
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

/**
 * 将字节解码为 UTF-8 文本。
 * @param bytes 响应字节。
 * @returns 解码后的文本。
 * @author zhenghq
 */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/**
 * 判断 MIME 是否为允许在 Renderer 中作为 Blob 音频播放的类型。
 * @param mimeType 上游 MIME 类型。
 * @returns 允许播放时返回 true。
 * @author zhenghq
 */
function isAudioMimeType(mimeType: string): boolean {
  return /^audio\/(?:mpeg|mp3|ogg|wav|x-wav|webm|aac|mp4|m4a)(?:;|$)/iu.test(mimeType.trim())
}

/**
 * 生成不可用的脱敏音标结果。
 * @param word 当前查询词。
 * @returns 不可用结果。
 * @author zhenghq
 */
function unavailableResult(word: string): PronunciationResult {
  return {
    status: 'unavailable',
    word,
    language: 'en',
    variants: [],
    source: 'dictionaryapi'
  }
}

/**
 * 生成不支持查询的脱敏结果。
 * @param word 当前输入。
 * @returns 不支持结果。
 * @author zhenghq
 */
function unsupportedResult(word: string): PronunciationResult {
  return {
    status: 'unsupported',
    word,
    language: 'en',
    variants: [],
    source: 'dictionaryapi'
  }
}

/**
 * 估算缓存条目大小。
 * @param key 缓存单词键。
 * @param value 缓存结果。
 * @returns 估算字节数。
 * @author zhenghq
 */
function estimateCacheBytes(key: string, value: CachedPronunciation): number {
  return key.length * 2 + JSON.stringify(value.result).length * 2
    + Object.values(value.audioUrls).reduce((total, url) => total + url.length * 2, 0)
}

/**
 * 提供词典音标查询和受信任音频下载的主进程服务。
 * @author zhenghq
 */
export class PronunciationService {
  private readonly fetchImpl: PronunciationServiceOptions['fetch']
  private readonly ieltsDictionary: PronunciationServiceOptions['ieltsDictionary']
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number
  private readonly maxAudioBytes: number
  private readonly cache = new BoundedLruCache<string, CachedPronunciation>({
    maxEntries: CACHE_MAX_ENTRIES,
    maxBytes: CACHE_MAX_BYTES,
    sizeOf: estimateCacheBytes
  })
  private readonly pendingLookups = new Map<string, SharedLookup>()

  /**
   * 创建音标服务。
   * @param options 网络请求、超时和响应大小配置。
   * @author zhenghq
   */
  constructor(options: PronunciationServiceOptions) {
    this.fetchImpl = options.fetch
    this.ieltsDictionary = options.ieltsDictionary
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
    this.maxResponseBytes = Math.max(1, Math.floor(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES))
    this.maxAudioBytes = Math.max(1, Math.floor(options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES))
  }

  /**
   * 查询单个英文单词的音标；相同查询并发复用同一上游请求。
   * @param input 用户点击或翻译原文中的单词。
   * @param signal 当前调用方的取消信号；仅在所有调用方取消时中止上游请求。
   * @returns 脱敏音标结果。
   * @author zhenghq
   */
  async lookup(input: string, signal?: AbortSignal): Promise<PronunciationResult> {
    const parsed = parsePronunciationWord(input)
    if (!parsed) return unsupportedResult(String(input ?? ''))
    if (signal?.aborted) return unavailableResult(parsed.word)
    const key = parsed.word.toLowerCase()
    const cached = this.cache.get(key)
    if (cached) return cached.result
    const pending = this.pendingLookups.get(key)
    if (pending) return this.subscribeLookup(pending, signal, parsed.word)
    const upstream = new AbortController()
    const shared: SharedLookup = {
      promise: Promise.resolve(unavailableResult(parsed.word)),
      waiterCount: 0,
      subscribers: new Set(),
      upstream
    }
    shared.promise = this.lookupFresh(parsed, upstream.signal).finally(() => {
      this.pendingLookups.delete(key)
    })
    this.pendingLookups.set(key, shared)
    return this.subscribeLookup(shared, signal, parsed.word)
  }

  /**
   * 为共享查询登记一个调用方，并在调用方取消时只移除该订阅者。
   * @param shared 同一单词的共享查询状态。
   * @param signal 当前调用方的取消信号。
   * @param word 当前调用方展示的单词。
   * @returns 当前调用方可见的查询结果。
   * @author zhenghq
   */
  private subscribeLookup(
    shared: SharedLookup,
    signal: AbortSignal | undefined,
    word: string
  ): Promise<PronunciationResult> {
    if (!signal) {
      shared.waiterCount += 1
      return shared.promise.finally(() => {
        shared.waiterCount = Math.max(0, shared.waiterCount - 1)
      })
    }
    if (signal.aborted) return Promise.resolve(unavailableResult(word))
    shared.waiterCount += 1
    const subscriber = new AbortController()
    shared.subscribers.add(subscriber)
    /**
     * 释放当前调用方的等待者计数，并在无人等待时中止共享上游请求。
     * @returns 无返回值。
     * @author zhenghq
     */
    const releaseWaiter = (): void => {
      if (shared.subscribers.delete(subscriber)) shared.waiterCount = Math.max(0, shared.waiterCount - 1)
      if (shared.waiterCount === 0) shared.upstream.abort()
    }
    const abort = (): void => {
      subscriber.abort()
      releaseWaiter()
    }
    signal.addEventListener('abort', abort, { once: true })
    return new Promise<PronunciationResult>((resolve) => {
      let settled = false
      /**
       * 只结算一次调用方结果。
       * @param result 调用方可见的音标结果。
       * @returns 无返回值。
       * @author zhenghq
       */
      const settle = (result: PronunciationResult): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        releaseWaiter()
        resolve(result)
      }
      subscriber.signal.addEventListener('abort', () => settle(unavailableResult(word)), { once: true })
      void shared.promise.then(settle, () => settle(unavailableResult(word)))
    })
  }

  /**
   * 从上游查询并解析音标，必要时对精确形式失败的所有格回退基础词。
   * @param parsed 已规范化的单词信息。
   * @param signal 共享上游请求的取消信号。
   * @returns 脱敏音标结果。
   * @author zhenghq
   */
  private async lookupFresh(parsed: ParsedPronunciationWord, signal: AbortSignal): Promise<PronunciationResult> {
    // 所有格先请求完整形式，只有完整形式不可用时才回退基础词。
    const exact = await this.requestDictionary(parsed.word, parsed.word, signal)
    const dictionary = exact.result.status === 'available' || !parsed.possessive
      ? exact
      : await this.requestDictionary(parsed.lookupWord, parsed.word, signal)
    const ielts = this.lookupIelts(parsed)
    return this.storeResult(parsed.word, this.mergeResults(parsed.word, dictionary, ielts))
  }

  /**
   * 查询本地雅思词表，并对所有格或精确未命中时回退基础词。
   * @param parsed 已规范化的单词信息。
   * @returns 本地词条；未命中时返回 null。
   * @author zhenghq
   */
  private lookupIelts(parsed: ParsedPronunciationWord): IscorevocEntry | null {
    if (!this.ieltsDictionary) return null
    const exact = this.ieltsDictionary.lookup(parsed.word)
    if (exact) return exact
    if (!parsed.possessive) return null
    return this.ieltsDictionary.lookup(parsed.lookupWord) ?? null
  }

  /**
   * 合并通用词典与本地雅思词表，保留通用词典音频并补充中文释义。
   * @param word 用户当前查询词。
   * @param dictionary 通用词典查询结果。
   * @param ielts 本地雅思词条。
   * @returns 合并后的脱敏音标结果。
   * @author zhenghq
   */
  private mergeResults(
    word: string,
    dictionary: CachedPronunciation,
    ielts: IscorevocEntry | null
  ): CachedPronunciation {
    if (!ielts) return dictionary
    const dictionaryAvailable = dictionary.result.status === 'available'
    const variants: PronunciationVariant[] = dictionaryAvailable
      ? [...dictionary.result.variants]
      : []
    const seenIpa = new Set(variants.map((variant) => variant.ipa))
    if (!seenIpa.has(ielts.ipa) && variants.length < 3) {
      variants.push({
        id: `other-${variants.length}`,
        accent: 'other',
        ipa: ielts.ipa,
        hasAudio: false
      })
    }
    // 雅思中文释义是本地词表的核心补充，先保留它，再由通用词典英文释义补足展示上限。
    const definitions: PronunciationDefinition[] = [
      ...ielts.definitions,
      ...(dictionaryAvailable ? dictionary.result.definitions ?? [] : [])
    ].filter((definition, index, all) =>
      all.findIndex((candidate) => candidate.text.toLowerCase() === definition.text.toLowerCase()) === index
    ).slice(0, 5)
    return {
      result: {
        status: 'available',
        word,
        language: 'en',
        variants,
        source: dictionaryAvailable ? 'mixed' : 'iscorevoc',
        ...(definitions.length > 0 ? { definitions } : {}),
        ...(dictionaryAvailable && dictionary.result.attribution
          ? { attribution: dictionary.result.attribution }
          : {})
      },
      // 雅思词表不接入远程音频，避免依赖当前不可用的第三方音频地址。
      audioUrls: dictionaryAvailable ? dictionary.audioUrls : {}
    }
  }

  /**
   * 请求一次词典并按大小、状态和 JSON 格式解析。
   * @param lookupWord 实际发送给词典的查询词。
   * @param displayWord 返回结果中保留的用户单词。
   * @param signal 共享上游请求的取消信号。
   * @returns 解析后的内部结果。
   * @author zhenghq
   */
  private async requestDictionary(
    lookupWord: string,
    displayWord: string,
    signal: AbortSignal
  ): Promise<CachedPronunciation> {
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) controller.abort()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const encodedWord = encodeURIComponent(lookupWord).replace(/'/gu, '%27')
      const response = await this.fetchImpl(`${DICTIONARY_API_BASE}${encodedWord}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' }
      })
      if (!response.ok) return { result: unavailableResult(displayWord), audioUrls: {} }
      const bytes = await readBoundedBody(response, this.maxResponseBytes)
      if (!bytes) return { result: unavailableResult(displayWord), audioUrls: {} }
      let payload: unknown
      try {
        payload = JSON.parse(decodeUtf8(bytes))
      } catch {
        return { result: unavailableResult(displayWord), audioUrls: {} }
      }
      return parsePronunciationDictionaryResponse(payload, displayWord)
    } catch {
      return { result: unavailableResult(displayWord), audioUrls: {} }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }

  /**
   * 缓存查询结果并返回给调用方。
   * @param displayWord 用户查询词。
   * @param value 查询结果。
   * @returns 可返回 Renderer 的音标结果。
   * @author zhenghq
   */
  private storeResult(displayWord: string, value: CachedPronunciation): PronunciationResult {
    if (value.result.status === 'available') this.cache.set(displayWord.toLowerCase(), value)
    return value.result
  }

  /**
   * 下载已缓存音标结果中登记变体的音频。
   * @param word 已查询的单词。
   * @param variantId 主进程生成的变体标识。
   * @param signal 可选取消信号。
   * @returns 音频字节或脱敏错误。
   * @author zhenghq
   */
  async getAudio(word: string, variantId: string, signal?: AbortSignal): Promise<PronunciationAudioResult> {
    const parsed = parsePronunciationWord(word)
    if (!parsed) return { ok: false, error: 'Unsupported pronunciation word' }
    const cached = this.cache.get(parsed.word.toLowerCase())
    const audioUrl = cached?.audioUrls[variantId]
    if (!cached || !audioUrl) return { ok: false, error: 'Pronunciation audio is unavailable' }

    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      // 使用 Request 传递取消信号，避免把音频 URL 与词典查询输入混淆。
      const request = new Request(audioUrl, { signal: controller.signal })
      const response = await this.fetchImpl(request, { signal: controller.signal })
      if (!response.ok) return { ok: false, error: 'Pronunciation audio is unavailable' }
      const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      if (!isAudioMimeType(mimeType)) return { ok: false, error: 'Pronunciation audio type is unsupported' }
      const audio = await readBoundedBody(response, this.maxAudioBytes)
      if (!audio || audio.byteLength === 0) return { ok: false, error: 'Pronunciation audio is unavailable' }
      return { ok: true, audio, mimeType, size: audio.byteLength }
    } catch {
      return { ok: false, error: 'Pronunciation audio download failed' }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
}
