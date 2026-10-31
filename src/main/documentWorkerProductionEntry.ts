import type { OcrEnginePreference } from '../shared/types.ts'
import {
  createDocumentWorkerExecutor,
  type DocumentWorkerExecutor
} from './documentWorker.ts'
import {
  DocumentWorkerTranslationRpcClient,
  type DocumentWorkerTranslationRpcClientPort,
  type DocumentWorkerTranslationRpcRequest
} from './documentWorkerTranslationRpc.ts'
import { createDocumentWorkerProductionDependencies } from './documentWorkerProductionDependencies.ts'
import { startDocumentWorkerEntry } from './documentWorkerEntry.ts'
import type { DocumentWorkerRuntimePort } from './documentWorkerRuntime.ts'

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
      request: DocumentWorkerTranslationRpcRequest,
      signal: AbortSignal,
      onDelta: (delta: string) => void
    ): Promise<string>
    getModelFingerprint(): string
    getTranslationConcurrency(): number
    dispose(): void
  }
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
      const wrapped = (messageEvent: { data: unknown }): void => listener(messageEvent.data)
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
 * 判断值是否为普通对象。
 * @param value 待检查值。
 * @returns 是否为普通对象。
 * @author zhenghq
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 校验启动配置，拒绝空路径和非法数值。
 * @param value 未信任配置。
 * @returns 合法配置或 null。
 * @author zhenghq
 */
function parseStartOptions(value: unknown): DocumentWorkerStartOptions | null {
  if (!isRecord(value) || typeof value.userDataPath !== 'string' || !value.userDataPath.trim() ||
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
    ocrConcurrency: value.ocrConcurrency
  }
}

/**
 * 解析启动消息。
 * @param value 未信任消息。
 * @returns 合法启动消息或 null。
 * @author zhenghq
 */
function parseStartMessage(value: unknown): DocumentWorkerStartMessage | null {
  if (!isRecord(value) || value.type !== 'worker-start') return null
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
    const rpc = dependencies.createTranslationRpc?.(translationPort) ??
      new DocumentWorkerTranslationRpcClient(
        translationPort,
        {
          modelFingerprint: message.options.modelFingerprint,
          translationConcurrency: message.options.translationConcurrency
        }
      )
    translationRpc = rpc
    const production = createDocumentWorkerProductionDependencies({
      userDataPath: message.options.userDataPath,
      appPath: message.options.appPath,
      resourcesPath: message.options.resourcesPath,
      isPackaged: message.options.isPackaged,
      ocrLang: message.options.ocrLang,
      ocrEnginePreference: message.options.ocrEnginePreference,
      ocrScale: message.options.ocrScale,
      ocrTesseractEnabled: message.options.ocrTesseractEnabled,
      ocrConcurrency: message.options.ocrConcurrency,
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
    translationRpc?.dispose()
    translationRpc = null
    translationPort?.dispose()
    translationPort = null
  }
}
