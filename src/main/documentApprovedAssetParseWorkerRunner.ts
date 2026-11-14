import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { DocumentFormat, DocumentModel } from '../shared/documentTypes.ts'
import type { DocumentParseInput } from './documentParserShared.ts'
import type { ApprovedPdfAssetParseResult } from './documentApprovedAssetParse.ts'
import { parseApprovedPdfAssetContext } from './documentApprovedAssetParse.ts'
import { parsePdfDocument } from './documentPdfParser.ts'
import { createProductionPdfRasterizer } from './documentPdfRuntime.ts'

/**
 * 解析 worker 所需的最小线程接口；测试环境可注入桩实现。
 * @author zhenghq
 */
export interface WorkerLike {
  /** 监听 worker 消息、错误与退出事件。 */
  on(event: 'message' | 'error' | 'exit', listener: (payload: unknown) => void): void
  /** 向 worker 发送消息；transferList 用于转移 ArrayBuffer 避免拷贝。 */
  postMessage(value: unknown, transferList?: readonly Transferable[]): void
  /** 终止 worker。 */
  terminate(): Promise<number> | number | void
}

/**
 * Worker 解析运行器选项；测试环境可注入 worker 工厂与进程内解析兜底。
 * @author zhenghq
 */
export interface WorkerPdfAssetParseRunnerOptions {
  /** 创建解析 worker 的工厂；默认按打包路径加载独立 worker 入口。 */
  createWorker?: (workerPath: string) => WorkerLike
  /** worker 无法启动时的进程内解析兜底；生产环境使用真实解析器。 */
  inProcessParse?: (input: DocumentParseInput) => Promise<ApprovedPdfAssetParseResult>
}

/** 主进程发送给 worker 的解析请求结构。 */
interface ApprovedPdfAssetParseRequest {
  /** 请求标识，用于匹配响应。 */
  requestId: string
  /** 已校验的解析输入；字节单独复制后转移。 */
  input: DocumentParseInput
}

/** worker 返回的解析响应结构。 */
interface ApprovedPdfAssetParseResponse {
  /** 对应请求标识。 */
  requestId?: string
  /** 解析得到的文档模型。 */
  model?: DocumentModel
  /** 资源字节数组对列表。 */
  assetBytes?: Array<[string, Uint8Array]>
  /** 资源哈希数组对列表。 */
  assetHashes?: Array<[string, string]>
  /** worker 内解析失败时的稳定错误分类。 */
  failure?: string
}

/**
 * 解析当前模块目录，兼容 ESM 与打包后的 CommonJS 环境。
 * @returns 模块所在目录绝对路径。
 * @author zhenghq
 */
function resolveModuleDirectory(): string {
  return typeof __dirname === 'string'
    ? __dirname
    : fileURLToPath(new URL('.', import.meta.url))
}

/**
 * 创建基于独立线程的 PDF 资源解析运行器。
 * 主进程只负责调度与结果装配，全量解析不再阻塞事件循环；
 * worker 无法启动时回退到进程内解析，保持既有行为可用。
 * @param options 可选的 worker 工厂与进程内兜底解析。
 * @returns 输入解析请求、输出解析结果的运行器函数。
 * @author zhenghq
 */
export function createWorkerPdfAssetParseRunner(
  options: WorkerPdfAssetParseRunnerOptions = {}
): (input: DocumentParseInput) => Promise<ApprovedPdfAssetParseResult> {
  const workerPath = join(resolveModuleDirectory(), '..', 'documentApprovedAssetParseWorker.cjs')
  const inProcessParse = options.inProcessParse ?? ((input) => parseApprovedPdfAssetContext(input, {
    parsePdfDocument,
    createProductionPdfRasterizer
  }))
  return (input) => {
    let worker: WorkerLike
    try {
      worker = options.createWorker
        ? options.createWorker(workerPath)
        : new Worker(workerPath)
    } catch (error) {
      // worker 启动失败只回退一次解析，不改变受控资源读取的错误语义。
      console.warn('[approved-asset-parse] worker 启动失败，回退到进程内解析:',
        error instanceof Error ? error.message : error)
      return inProcessParse(input)
    }
    return new Promise<ApprovedPdfAssetParseResult>((resolve, reject) => {
      let settled = false
      // 源字节必须复制后转移，主进程持有的原字节仍用于源预览响应。
      const bytes = new Uint8Array(input.bytes)
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const settle = (action: () => void): void => {
        if (settled) return
        settled = true
        void worker.terminate()
        action()
      }
      worker.on('message', (payload: unknown) => {
        const message = payload as ApprovedPdfAssetParseResponse
        if (!message || message.requestId !== requestId) return
        if (message.failure || !message.model ||
          !Array.isArray(message.assetBytes) || !Array.isArray(message.assetHashes)) {
          settle(() => reject(new Error(message.failure ?? 'approved-pdf-asset-parse-failed')))
          return
        }
        const assetBytes = new Map(message.assetBytes)
        const assetHashes = new Map(message.assetHashes)
        settle(() => resolve({ model: message.model!, assetBytes, assetHashes }))
      })
      worker.on('error', (error: unknown) => {
        // worker 加载或运行崩溃时回退到进程内解析，保证资源恢复仍然可用。
        settle(() => {
          console.warn('[approved-asset-parse] worker 异常，回退到进程内解析:',
            error instanceof Error ? error.message : error)
          inProcessParse(input).then(resolve, reject)
        })
      })
      worker.on('exit', (code: unknown) => {
        // 正常完成后退出属预期；未收到结果就退出说明 worker 异常终止。
        settle(() => reject(new Error(`approved-pdf-asset-worker-exited-${String(code)}`)))
      })
      const request: ApprovedPdfAssetParseRequest = {
        requestId,
        input: {
          path: input.path,
          fileName: input.fileName,
          format: input.format as DocumentFormat,
          sha256: input.sha256,
          bytes
        }
      }
      worker.postMessage(request, [bytes.buffer])
    })
  }
}
