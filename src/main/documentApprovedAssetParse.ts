import type { DocumentModel } from '../shared/documentTypes.ts'
import { hashDocumentBytes, type DocumentParseInput } from './documentParserShared.ts'
import type { parsePdfDocument } from './documentPdfParser.ts'
import type { createProductionPdfRasterizer } from './documentPdfRuntime.ts'

/**
 * 受控资源恢复的 PDF 全量解析结果。
 * @author zhenghq
 */
export interface ApprovedPdfAssetParseResult {
  /** 解析得到的文档模型，用于定位图片区块。 */
  model: DocumentModel
  /** 解析期登记的真实图片字节。 */
  assetBytes: Map<string, Uint8Array>
  /** 解析期按资源字节一次性计算的哈希，避免逐请求重复哈希。 */
  assetHashes: Map<string, string>
}

/**
 * 受控资源恢复的 PDF 解析依赖；生产环境使用真实解析器与栅格化器，测试环境可注入桩。
 * @author zhenghq
 */
export interface ApprovedPdfAssetParseDependencies {
  /** PDF 文档解析函数。 */
  parsePdfDocument: typeof parsePdfDocument
  /** 生产 PDF 栅格化器工厂。 */
  createProductionPdfRasterizer: typeof createProductionPdfRasterizer
}

/**
 * 重新解析整份 PDF 并登记图片资源字节；该函数是纯计算，可在任意线程执行。
 * 主进程内直接调用会长时间占用事件循环，生产环境必须通过 worker 运行器调度。
 * @param input 已校验的 PDF 解析输入（含源文件字节）。
 * @param dependencies PDF 解析依赖。
 * @returns 解析模型、资源字节与资源哈希。
 * @author zhenghq
 */
export async function parseApprovedPdfAssetContext(
  input: DocumentParseInput,
  dependencies: ApprovedPdfAssetParseDependencies
): Promise<ApprovedPdfAssetParseResult> {
  const rasterizer = await dependencies.createProductionPdfRasterizer()
  const assetBytes = new Map<string, Uint8Array>()
  const assetHashes = new Map<string, string>()
  const model = await dependencies.parsePdfDocument(input, {
    renderPageToImage: rasterizer.renderPageToImage,
    renderPageRegionToImage: rasterizer.renderPageRegionToImage,
    renderEmbeddedImageToImage: rasterizer.renderEmbeddedImageToImage,
    registerAssetBytes: (assetId, bytes) => {
      if (assetId && bytes.byteLength > 0) {
        const copy = new Uint8Array(bytes)
        assetBytes.set(assetId, copy)
        assetHashes.set(assetId, hashDocumentBytes(copy))
      }
    }
  })
  return { model, assetBytes, assetHashes }
}
