import type { OcrEnginePreference } from '../shared/types.ts'
import type {
  DocumentGlossary,
  DocumentGlossaryEntry,
  DocumentTranslationCacheEntry
} from '../shared/documentTranslation.ts'
import { DOCUMENT_PARSER_VERSION } from '../shared/documentParserVersion.ts'
import { normalizeDocumentGlossary } from '../shared/settingsDefaults.ts'
import {
  createDocumentWorkerExecutor,
  type DocumentWorkerExecutor,
  type DocumentWorkerProductionDependencies
} from './documentWorker.ts'
import {
  DocumentWorkerCacheRpcClient,
  type DocumentWorkerCacheRpcClientPort
} from './documentWorkerCacheRpc.ts'
import {
  DocumentWorkerTranslationRpcClient,
  isDocumentWorkerTranslationRpcMessage,
  type DocumentWorkerTranslationRpcClientRequest,
  type DocumentWorkerTranslationRpcClientPort
} from './documentWorkerTranslationRpc.ts'
import {
  createDocumentWorkerProductionDependencies,
  type DocumentWorkerProductionDependencyOptions
} from './documentWorkerProductionDependencies.ts'
import type { DocumentWorkerRuntimePort } from './documentWorkerRuntime.ts'

/** 文档预算最小值：1MB。 */
const DOCUMENT_WORKER_MIN_FILE_BYTES = 1024 * 1024
/** 文档预算最大值：2GB，与设置校验保持一致。 */
const DOCUMENT_WORKER_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
/** 单任务最大页数上限。 */
const DOCUMENT_WORKER_MAX_PAGES = 5000
/** 单任务最大 OCR 图片数上限。 */
const DOCUMENT_WORKER_MAX_OCR_IMAGES = 2000

/** 文档术语表允许携带的最大条目数。 */
const DOCUMENT_WORKER_GLOSSARY_MAX_ENTRIES = 500

/** 单条术语源文或译法允许的最大字符数。 */
const DOCUMENT_WORKER_GLOSSARY_TERM_MAX_CHARS = 256

/** 术语语言标签允许的最大字符数。 */
const DOCUMENT_WORKER_GLOSSARY_LANGUAGE_MAX_CHARS = 32

/** 术语表版本允许的最大字符数。 */
const DOCUMENT_WORKER_GLOSSARY_VERSION_MAX_CHARS = 256

/** 解析器版本允许的最大字符数。 */
const DOCUMENT_WORKER_PARSER_VERSION_MAX_CHARS = 128

/** 主进程发送给 worker 的非敏感启动配置。 */
export interface DocumentWorkerStartOptions {
  /** Electron userData 目录，仅用于 OCR 缓存。 */
  userDataPath: string
  /** 应用根目录。 */
  appPath: string
  /** Electron resources 目录。 */
  resourcesPath: string
  /** 当前应用是否已打包。 */
  isPackaged: boolean
  /** OCR 语言偏好。 */
  ocrLang: string
  /** OCR 引擎偏好。 */
  ocrEnginePreference: OcrEnginePreference
  /** OCR 自适应放大倍率。 */
  ocrScale: number
  /** 是否启用 Tesseract 兜底。 */
  ocrTesseractEnabled: boolean
  /** 主进程公开的翻译模型指纹。 */
  modelFingerprint: string
  /** 文档翻译并发数。 */
  translationConcurrency: number
  /** 文档 OCR 并发数。 */
  ocrConcurrency: number
  /** 单次任务允许读取的最大文件字节数；省略时使用共享默认预算。 */
  maxFileBytes?: number
  /** 单次任务允许解析的最大页数；省略时不额外限制。 */
  maxPages?: number
  /** 单次任务允许 OCR 的不同图片数；省略时使用共享默认预算。 */
  maxOcrImages?: number
  /** 当前文档术语表；省略时不注入术语约束。 */
  glossary?: DocumentGlossary
  /** 当前解析器版本；省略时使用共享默认版本。 */
  parserVersion?: string
}

/** worker 启动消息。 */
interface DocumentWorkerStartMessage {
  /** 消息类型。 */
  type: 'worker-start'
  /** 已校验的非敏感配置。 */
  options: DocumentWorkerStartOptions
}

/** 生产入口依赖；测试可替换运行时与执行器工厂。 */
export interface DocumentWorkerProductionEntryDependencies {
  /**
   * 创建并启动生产运行时。
   * @param dependencies 运行时所需父端口与执行器工厂。
   * @returns 幂等清理函数。
   * @author zhenghq
   */
  createRuntime(dependencies: {
    resolveParentPort(): DocumentWorkerRuntimePort | null
    createExecutor(): DocumentWorkerExecutor
  }): () => void
  /**
   * 可注入翻译 RPC 客户端工厂，测试避免真实消息端口。
   * @param port worker 父端口。
   * @returns 翻译 RPC 客户端。
   * @author zhenghq
   */
  createTranslationRpc?(port: DocumentWorkerTranslationRpcClientPort): {
    translate(
      request: DocumentWorkerTranslationRpcClientRequest,
      signal: AbortSignal,
      onDelta: (delta: string) => void
    ): Promise<string>
    getModelFingerprint(): string
    getTranslationConcurrency(): number
    dispose(): void
  }
  /**
   * 可注入缓存 RPC 客户端工厂，测试避免真实消息端口。
   * @param port 独立解包后的 worker 父端口。
   * @returns 缓存 RPC 客户端。
   * @author zhenghq
   */
  createCacheRpc?(port: DocumentWorkerCacheRpcClientPort): {
    read(jobId: string, generation: number, key: string): Promise<DocumentTranslationCacheEntry | null>
    write(
      jobId: string,
      generation: number,
      key: string,
      value: DocumentTranslationCacheEntry
    ): Promise<boolean>
    dispose(): void
  }
  /**
   * 可注入生产依赖工厂，测试用于核验真实启动参数接线。
   * @param options 已校验的 worker 生产依赖选项。
   * @returns 文档 worker 生产依赖。
   * @author zhenghq
   */
  createProductionDependencies?(
    options: DocumentWorkerProductionDependencyOptions
  ): DocumentWorkerProductionDependencies
}

/** 可主动释放全部订阅的 worker 翻译 RPC 端口适配器。 */
export interface DocumentWorkerTranslationRpcClientPortAdapter
  extends DocumentWorkerTranslationRpcClientPort {
  /**
   * 注销适配器创建的全部父端口监听。
   * @returns 无返回值。
   * @author zhenghq
   */
  dispose(): void
}

/** 可主动释放全部订阅的 worker 缓存 RPC 端口适配器。 */
export interface DocumentWorkerCacheRpcClientPortAdapter
  extends DocumentWorkerCacheRpcClientPort {
  /**
   * 注销适配器创建的全部父端口监听。
   * @returns 无返回值。
   * @author zhenghq
   */
  dispose(): void
}

/**
 * 把 Electron utility process 的 `{ data }` 消息事件适配为翻译 RPC 客户端端口。
 * @param port worker 父端口。
 * @returns 与 RPC 客户端兼容的消息端口。
 * @author zhenghq
 */
export function adaptDocumentWorkerTranslationRpcClientPort(
  port: DocumentWorkerRuntimePort
): DocumentWorkerTranslationRpcClientPortAdapter {
  const listenerWrappers = new Map<(message: unknown) => void, (event: { data: unknown }) => void>()
  return {
    postMessage(message): void {
      port.postMessage(message)
    },
    on(event, listener): void {
      const wrapped = (messageEvent: { data: unknown }): void => {
        // 翻译适配器只解包翻译 RPC 响应，避免缓存结果误触发翻译请求失败。
        if (!isDocumentWorkerTranslationRpcMessage(messageEvent.data)) return
        listener(messageEvent.data)
      }
      listenerWrappers.set(listener, wrapped)
      port.on(event, wrapped)
    },
    off(event, listener): void {
      // utility process 要求注销同一个包装函数；这里保存包装关系，避免遗留监听。
      const wrapped = listenerWrappers.get(listener)
      if (wrapped) {
        listenerWrappers.delete(listener)
        port.off(event, wrapped)
      }
    },
    dispose(): void {
      for (const wrapped of listenerWrappers.values()) port.off('message', wrapped)
      listenerWrappers.clear()
    }
  }
}

/**
 * 把 Electron utility process 的 `{ data }` 消息事件适配为缓存 RPC 客户端端口。
 * @param port worker 父端口。
 * @returns 与缓存 RPC 客户端兼容的消息端口。
 * @author zhenghq
 */
export function adaptDocumentWorkerCacheRpcClientPort(
  port: DocumentWorkerRuntimePort
): DocumentWorkerCacheRpcClientPortAdapter {
  const listenerWrappers = new Map<(message: unknown) => void, (event: { data: unknown }) => void>()
  return {
    postMessage(message): void {
      port.postMessage(message)
    },
    on(event, listener): void {
      const wrapped = (messageEvent: { data: unknown }): void => {
        // 缓存适配器只解包自身响应，避免与翻译 RPC 或任务协议互相消费。
        if (!isDocumentWorkerCacheRpcResponseMessage(messageEvent.data)) return
        listener(messageEvent.data)
      }
      listenerWrappers.set(listener, wrapped)
      port.on(event, wrapped)
    },
    off(event, listener): void {
      // utility process 要求注销同一个包装函数；这里保存包装关系，避免遗留监听。
      const wrapped = listenerWrappers.get(listener)
      if (wrapped) {
        listenerWrappers.delete(listener)
        port.off(event, wrapped)
      }
    },
    dispose(): void {
      for (const wrapped of listenerWrappers.values()) port.off('message', wrapped)
      listenerWrappers.clear()
    }
  }
}

/**
 * 判断消息是否属于 worker 侧缓存 RPC 响应。
 * @param value 未信任消息。
 * @returns 是否为缓存读取或写入结果。
 * @author zhenghq
 */
function isDocumentWorkerCacheRpcResponseMessage(value: unknown): boolean {
  if (!isRecord(value)) return false
  return value.type === 'cache-read-result' || value.type === 'cache-write-result'
}

/**
 * 判断值是否为普通对象。
 * @param value 待检查值。
 * @returns 是否为普通对象。
 * @author zhenghq
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 判断对象是否只包含指定字段。
 * @param value 待检查对象。
 * @param allowedKeys 允许字段集合。
 * @returns 是否未包含未知字段。
 * @author zhenghq
 */
function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys)
  return Object.keys(value).every((key) => allowed.has(key))
}

/**
 * 判断字符串是否为不含控制字符的非空文本。
 * @param value 待检查值。
 * @param maxChars 最大字符数。
 * @returns 是否为安全文本。
 * @author zhenghq
 */
function isSafeText(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
}

/**
 * 严格解析术语表，拒绝未知字段以及任何会被规范化改变的内容。
 * @param value 未信任术语表。
 * @returns 与持久化设置完全一致的安全术语表或 null。
 * @author zhenghq
 */
function parseGlossary(value: unknown): DocumentGlossary | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['version', 'entries']) ||
    !isSafeText(value.version, DOCUMENT_WORKER_GLOSSARY_VERSION_MAX_CHARS) ||
    !Array.isArray(value.entries) ||
    value.entries.length > DOCUMENT_WORKER_GLOSSARY_MAX_ENTRIES) return null
  const entries: DocumentGlossaryEntry[] = []
  for (const candidate of value.entries) {
    if (!isRecord(candidate) ||
      !hasOnlyKeys(candidate, ['source', 'target', 'sourceLang', 'targetLang']) ||
      !isSafeText(candidate.source, DOCUMENT_WORKER_GLOSSARY_TERM_MAX_CHARS) ||
      !isSafeText(candidate.target, DOCUMENT_WORKER_GLOSSARY_TERM_MAX_CHARS)) return null
    if (candidate.sourceLang !== undefined &&
      !isSafeText(candidate.sourceLang, DOCUMENT_WORKER_GLOSSARY_LANGUAGE_MAX_CHARS)) return null
    if (candidate.targetLang !== undefined &&
      !isSafeText(candidate.targetLang, DOCUMENT_WORKER_GLOSSARY_LANGUAGE_MAX_CHARS)) return null
    entries.push({
      source: candidate.source,
      target: candidate.target,
      ...(candidate.sourceLang !== undefined ? { sourceLang: candidate.sourceLang } : {}),
      ...(candidate.targetLang !== undefined ? { targetLang: candidate.targetLang } : {})
    })
  }
  const normalized = normalizeDocumentGlossary({ entries })
  // 启动消息不得静默裁剪、去重、改大小写或移除字段，否则缓存版本会与实际术语不一致。
  if (normalized.version !== value.version ||
    JSON.stringify(normalized.entries) !== JSON.stringify(entries)) return null
  return { version: normalized.version, entries: normalized.entries }
}

/**
 * 校验启动配置，拒绝空路径和非法数值。
 * @param value 未信任配置。
 * @returns 合法配置或 null。
 * @author zhenghq
 */
function parseStartOptions(value: unknown): DocumentWorkerStartOptions | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'userDataPath',
    'appPath',
    'resourcesPath',
    'isPackaged',
    'ocrLang',
    'ocrEnginePreference',
    'ocrScale',
    'ocrTesseractEnabled',
    'modelFingerprint',
    'translationConcurrency',
    'ocrConcurrency',
    'maxFileBytes',
    'maxPages',
    'maxOcrImages',
    'glossary',
    'parserVersion'
  ]) ||
    typeof value.userDataPath !== 'string' || !value.userDataPath.trim() ||
    typeof value.appPath !== 'string' || !value.appPath.trim() ||
    typeof value.resourcesPath !== 'string' || !value.resourcesPath.trim() ||
    typeof value.isPackaged !== 'boolean' ||
    typeof value.ocrLang !== 'string' || !value.ocrLang.trim() ||
    (value.ocrEnginePreference !== 'auto' && value.ocrEnginePreference !== 'system' &&
      value.ocrEnginePreference !== 'paddle' && value.ocrEnginePreference !== 'tesseract') ||
    typeof value.ocrScale !== 'number' || !Number.isFinite(value.ocrScale) ||
    value.ocrScale < 1 || value.ocrScale > 3 ||
    typeof value.ocrTesseractEnabled !== 'boolean' ||
    typeof value.modelFingerprint !== 'string' || !value.modelFingerprint.trim() ||
    typeof value.translationConcurrency !== 'number' ||
    !Number.isInteger(value.translationConcurrency) || value.translationConcurrency < 1 ||
    value.translationConcurrency > 8 ||
    typeof value.ocrConcurrency !== 'number' ||
    !Number.isInteger(value.ocrConcurrency) || value.ocrConcurrency < 1 ||
    value.ocrConcurrency > 4) return null
  if (value.maxFileBytes !== undefined &&
    (typeof value.maxFileBytes !== 'number' || !Number.isInteger(value.maxFileBytes) ||
      value.maxFileBytes < DOCUMENT_WORKER_MIN_FILE_BYTES ||
      value.maxFileBytes > DOCUMENT_WORKER_MAX_FILE_BYTES)) return null
  if (value.maxPages !== undefined &&
    (typeof value.maxPages !== 'number' || !Number.isInteger(value.maxPages) ||
      value.maxPages < 1 || value.maxPages > DOCUMENT_WORKER_MAX_PAGES)) return null
  if (value.maxOcrImages !== undefined &&
    (typeof value.maxOcrImages !== 'number' || !Number.isInteger(value.maxOcrImages) ||
      value.maxOcrImages < 1 || value.maxOcrImages > DOCUMENT_WORKER_MAX_OCR_IMAGES)) return null
  const glossary: DocumentGlossary | undefined = value.glossary === undefined
    ? undefined
    : parseGlossary(value.glossary) ?? undefined
  if (value.glossary !== undefined && !glossary) return null
  if (value.parserVersion !== undefined &&
    !isSafeText(value.parserVersion, DOCUMENT_WORKER_PARSER_VERSION_MAX_CHARS)) return null
  return {
    userDataPath: value.userDataPath,
    appPath: value.appPath,
    resourcesPath: value.resourcesPath,
    isPackaged: value.isPackaged,
    ocrLang: value.ocrLang,
    ocrEnginePreference: value.ocrEnginePreference,
    ocrScale: value.ocrScale,
    ocrTesseractEnabled: value.ocrTesseractEnabled,
    modelFingerprint: value.modelFingerprint,
    translationConcurrency: value.translationConcurrency,
    ocrConcurrency: value.ocrConcurrency,
    ...(value.maxFileBytes !== undefined ? { maxFileBytes: value.maxFileBytes } : {}),
    ...(value.maxPages !== undefined ? { maxPages: value.maxPages } : {}),
    ...(value.maxOcrImages !== undefined ? { maxOcrImages: value.maxOcrImages } : {}),
    ...(glossary !== undefined ? { glossary } : {}),
    ...(value.parserVersion !== undefined ? { parserVersion: value.parserVersion } : {})
  }
}

/**
 * 解析启动消息。
 * @param value 未信任消息。
 * @returns 合法启动消息或 null。
 * @author zhenghq
 */
function parseStartMessage(value: unknown): DocumentWorkerStartMessage | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['type', 'options']) ||
    value.type !== 'worker-start') return null
  const options = parseStartOptions(value.options)
  return options ? { type: 'worker-start', options } : null
}

/**
 * 启动生产 worker 入口；收到启动配置前不创建 OCR 或解析依赖。
 * @param port utility process 父端口。
 * @param dependencies 运行时组合依赖。
 * @returns 幂等清理函数。
 * @author zhenghq
 */
export function startDocumentWorkerProductionEntry(
  port: DocumentWorkerRuntimePort,
  dependencies: DocumentWorkerProductionEntryDependencies
): () => void {
  let stopRuntime: (() => void) | null = null
  let translationRpc: { dispose(): void } | null = null
  let translationPort: DocumentWorkerTranslationRpcClientPortAdapter | null = null
  let cacheRpc: { dispose(): void } | null = null
  let cachePort: DocumentWorkerCacheRpcClientPortAdapter | null = null
  let disposed = false
  let startListener: ((event: { data: unknown }) => void) | null = null

  /**
   * 处理启动配置并切换为正式 worker 监听。
   * @param event 父端口消息事件。
   * @returns 无返回值。
   * @author zhenghq
   */
  const onStart = (event: { data: unknown }): void => {
    if (disposed) return
    const message = parseStartMessage(event.data)
    if (!message) {
      port.postMessage({
        version: 1,
        type: 'failure',
        jobId: 'invalid-job',
        generation: 1,
        payload: { code: 'invalid-request', message: 'invalid worker start options' }
      })
      return
    }
    if (startListener) port.off('message', startListener)
    startListener = null
    translationPort = adaptDocumentWorkerTranslationRpcClientPort(port)
    cachePort = adaptDocumentWorkerCacheRpcClientPort(port)
    const rpc = dependencies.createTranslationRpc?.(translationPort) ??
      new DocumentWorkerTranslationRpcClient(
        translationPort,
        {
          modelFingerprint: message.options.modelFingerprint,
          translationConcurrency: message.options.translationConcurrency
        }
      )
    translationRpc = rpc
    const cacheClient = dependencies.createCacheRpc?.(cachePort) ??
      new DocumentWorkerCacheRpcClient(cachePort)
    cacheRpc = cacheClient
    const createProductionDependencies = dependencies.createProductionDependencies ??
      createDocumentWorkerProductionDependencies
    const production = createProductionDependencies({
      userDataPath: message.options.userDataPath,
      appPath: message.options.appPath,
      resourcesPath: message.options.resourcesPath,
      isPackaged: message.options.isPackaged,
      ocrLang: message.options.ocrLang,
      ocrEnginePreference: message.options.ocrEnginePreference,
      ocrScale: message.options.ocrScale,
      ocrTesseractEnabled: message.options.ocrTesseractEnabled,
      ocrConcurrency: message.options.ocrConcurrency,
      ...(message.options.maxFileBytes !== undefined
        ? { maxFileBytes: message.options.maxFileBytes }
        : {}),
      ...(message.options.maxPages !== undefined ? { maxPages: message.options.maxPages } : {}),
      ...(message.options.maxOcrImages !== undefined
        ? { maxOcrImages: message.options.maxOcrImages }
        : {}),
      ...(message.options.glossary !== undefined
        ? { glossary: () => message.options.glossary }
        : {}),
      readTranslationCache: (jobId, generation, key) =>
        cacheClient.read(jobId, generation, key),
      writeTranslationCache: async (jobId, generation, key, value) => {
        await cacheClient.write(jobId, generation, key, value)
      },
      getParserVersion: () =>
        message.options.parserVersion ?? DOCUMENT_PARSER_VERSION,
      translationRpc: rpc,
      getModelFingerprint: () => message.options.modelFingerprint
    })
    stopRuntime = dependencies.createRuntime({
      resolveParentPort: () => port,
      createExecutor: () => createDocumentWorkerExecutor(production)
    })
  }

  startListener = onStart
  port.on('message', onStart)
  return () => {
    if (disposed) return
    disposed = true
    if (startListener) {
      port.off('message', startListener)
      startListener = null
    }
    stopRuntime?.()
    stopRuntime = null
    cacheRpc?.dispose()
    cacheRpc = null
    translationRpc?.dispose()
    translationRpc = null
    cachePort?.dispose()
    cachePort = null
    translationPort?.dispose()
    translationPort = null
  }
}
