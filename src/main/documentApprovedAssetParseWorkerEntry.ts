import { parentPort } from 'node:worker_threads'
import type { DocumentFormat } from '../shared/documentTypes.ts'
import type { DocumentParseInput } from './documentParserShared.ts'
import { parseApprovedPdfAssetContext } from './documentApprovedAssetParse.ts'
import { parsePdfDocument } from './documentPdfParser.ts'
import { createProductionPdfRasterizer } from './documentPdfRuntime.ts'

/** 主进程发来的解析请求结构。 */
interface ApprovedPdfAssetParseWorkerRequest {
  /** 请求标识。 */
  requestId?: unknown
  /** 已校验的解析输入。 */
  input?: unknown
}

/**
 * 校验主进程发来的解析请求并还原解析输入。
 * @param payload 主进程原始消息。
 * @returns 合法的解析输入与请求标识；不合法时返回 null。
 * @author zhenghq
 */
function parseWorkerRequest(payload: unknown): {
  requestId: string
  input: DocumentParseInput
} | null {
  if (!payload || typeof payload !== 'object') return null
  const message = payload as ApprovedPdfAssetParseWorkerRequest
  if (typeof message.requestId !== 'string' || !message.requestId) return null
  const input = message.input as DocumentParseInput | undefined
  if (!input || typeof input !== 'object') return null
  if (typeof input.path !== 'string' || typeof input.fileName !== 'string' ||
    typeof input.sha256 !== 'string' || !(input.bytes instanceof Uint8Array) ||
    input.bytes.byteLength < 1) {
    return null
  }
  return { requestId: message.requestId, input }
}

/**
 * 受控资源恢复的独立线程解析入口；只在 worker_threads 环境启动。
 * @author zhenghq
 */
function startApprovedAssetParseWorker(): void {
  const port = parentPort
  if (!port) return
  port.on('message', (payload: unknown) => {
    const request = parseWorkerRequest(payload)
    if (!request) return
    parseApprovedPdfAssetContext(request.input, {
      parsePdfDocument,
      createProductionPdfRasterizer
    }).then((result) => {
      port.postMessage({
        requestId: request.requestId,
        model: result.model,
        assetBytes: Array.from(result.assetBytes.entries()),
        assetHashes: Array.from(result.assetHashes.entries())
      })
    }, (error: unknown) => {
      port.postMessage({
        requestId: request.requestId,
        failure: error instanceof Error ? error.message : 'approved-pdf-asset-parse-failed'
      })
    })
  })
}

startApprovedAssetParseWorker()
