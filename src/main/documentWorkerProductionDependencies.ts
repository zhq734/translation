import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { recognizeAdaptiveOcr } from './adaptiveOcr.ts'
import type { DocumentWorkerProductionDependencies } from './documentWorker.ts'
import { exportDocumentToPdf } from './documentPdfExport.ts'
import { loadDocumentPdfFontBytes } from './documentPdfFont.ts'
import { createProductionPdfRasterizer } from './documentPdfRuntime.ts'
import { parseDocument } from './documentParser.ts'
import type { DocumentParseInput } from './documentParserShared.ts'
import type { OcrEngine, OcrRecognizeResult } from '../shared/ocrEngine.ts'
import type { OcrEnginePreference } from '../shared/types.ts'
import { OcrDispatcher } from './ocrDispatcher.ts'
import { resolveBundledOcrModelAssets } from './ocrModelAssets.ts'
import { PaddleOcrEngine } from './paddleOcr.ts'
import { createSystemOcrEngine } from './systemOcr.ts'
import {
  TesseractOcrEngine,
  resolveTesseractLangPath,
  resolveTesseractWorkerPath
} from './tesseractOcr.ts'
import type { DocumentLanguagePair } from '../shared/documentLanguageDirection.ts'
import { isWindows7CompatibilityRuntime } from './platformCompatibility.ts'

/** OCR 单次识别的统一超时时间，与主进程截图翻译保持一致。 */
export const DOCUMENT_WORKER_OCR_TIMEOUT_MS = 30_000

/** worker 内翻译 RPC 请求；只携带可翻译文本与语言对，不携带凭据。 */
export interface DocumentWorkerTranslationRpcRequest {
  /** 本次翻译请求标识，用于取消与迟到结果隔离。 */
  requestId: string
  /** 文档任务标识。 */
  jobId: string
  /** 文档任务代际。 */
  generation: number
  /** 待翻译文本。 */
  text: string
  /** 任务级冻结语言对。 */
  languagePair: DocumentLanguagePair
}

/** worker 内翻译 RPC 回调；增量只传递译文，不传原文或路径。 */
export interface DocumentWorkerTranslationRpc {
  /**
   * 向主进程请求流式翻译。
   * @param request 不含凭据的翻译请求。
   * @param signal 取消信号。
   * @param onDelta 安全译文增量回调。
   * @returns 完整译文。
   * @author zhenghq
   */
  translate(
    request: DocumentWorkerTranslationRpcRequest,
    signal: AbortSignal,
    onDelta: (delta: string) => void
  ): Promise<string>
  /**
   * 获取当前翻译提供方与模型的稳定指纹。
   * @returns 不含凭据的模型指纹。
   * @author zhenghq
   */
  getModelFingerprint(): string
  /**
   * 获取文档页面翻译并发数。
   * @returns 并发数。
   * @author zhenghq
   */
  getTranslationConcurrency(): number
}

/** 生产依赖创建选项；所有路径均由主进程显式传入。 */
export interface DocumentWorkerProductionDependencyOptions {
  /** Electron userData 目录，仅用于 OCR 模型缓存。 */
  userDataPath: string
  /** 应用根目录，用于定位随包 OCR 模型。 */
  appPath: string
  /** Electron resources 目录，用于定位打包 OCR worker 与字体。 */
  resourcesPath: string
  /** 当前应用是否已打包。 */
  isPackaged: boolean
  /** 当前 OCR 语言偏好。 */
  ocrLang: string
  /** 当前 OCR 引擎偏好。 */
  ocrEnginePreference: OcrEnginePreference
  /** OCR 自适应放大倍率。 */
  ocrScale: number
  /** 是否允许 Tesseract 兜底。 */
  ocrTesseractEnabled: boolean
  /** 文档 OCR 并发数，未提供时使用默认值 2。 */
  ocrConcurrency?: number
  /** 主进程受控翻译 RPC。 */
  translationRpc: DocumentWorkerTranslationRpc
  /** 可注入的 PDF 导出实现，生产环境默认使用 pdf-lib 导出器。 */
  exportDocumentToPdf?: typeof exportDocumentToPdf
  /** 可注入平台，测试时用于固定 OCR 队列。 */
  platform?: NodeJS.Platform
  /** 可注入 Win7 判定，测试时避免读取宿主环境。 */
  isWindows7Runtime?: () => boolean
  /** 可注入 OCR 引擎工厂，测试时替换原生依赖。 */
  createOcrEngines?: (settings: {
    platform: NodeJS.Platform
    isWindows7Runtime: boolean
    ocrTesseractEnabled: boolean
    userDataPath: string
    appPath: string
    resourcesPath: string
  }) => Partial<Record<'system' | 'paddle' | 'tesseract', OcrEngine | null>>
  /** 可注入翻译模型指纹函数，测试时避免真实配置。 */
  getModelFingerprint?: () => string
}

/**
 * 读取文档资源字节；解析阶段已登记的资源由执行器缓存，未命中时返回 null。
 * @param _asset 资源元数据。
 * @returns 固定 null，由执行器缓存命中处理。
 * @author zhenghq
 */
async function loadUncachedAssetBytes(): Promise<Uint8Array | null> {
  return null
}

/**
 * 创建生产 OCR 引擎集合，沿用主进程的系统、Paddle 与 Tesseract 能力。
 * @param options 已冻结的 OCR 运行配置。
 * @returns OCR 引擎映射。
 * @author zhenghq
 */
function createProductionOcrEngines(options: {
  platform: NodeJS.Platform
  isWindows7Runtime: boolean
  ocrTesseractEnabled: boolean
  userDataPath: string
  appPath: string
  resourcesPath: string
}): Partial<Record<'system' | 'paddle' | 'tesseract', OcrEngine | null>> {
  const tessDataPath = join(options.userDataPath, 'tessdata')
  if (options.isWindows7Runtime) {
    return {
      tesseract: new TesseractOcrEngine({
        tessDataPath,
        langPath: resolveTesseractLangPath(process.env['TESSERACT_LANG_PATH']),
        bundledLangPath: join(options.resourcesPath, 'tessdata'),
        workerPath: resolveTesseractWorkerPath(options.resourcesPath, true)
      })
    }
  }
  const paddleAssets = resolveBundledOcrModelAssets(options.appPath)
  return {
    system: createSystemOcrEngine({ platform: options.platform }),
    paddle: paddleAssets.ready ? new PaddleOcrEngine({ models: paddleAssets.models }) : null,
    tesseract: options.ocrTesseractEnabled
      ? new TesseractOcrEngine({ tessDataPath })
      : null
  }
}

/**
 * 创建真实文档 worker 依赖；不读取主进程凭据，也不暴露任意命令或 URL。
 * @param options 路径、OCR 设置与受控翻译 RPC。
 * @returns 可注入 worker 执行器的生产依赖。
 * @author zhenghq
 */
export function createDocumentWorkerProductionDependencies(
  options: DocumentWorkerProductionDependencyOptions
): DocumentWorkerProductionDependencies {
  const platform = options.platform ?? process.platform
  const isWindows7Runtime = options.isWindows7Runtime?.() ?? isWindows7CompatibilityRuntime()
  const engines = (options.createOcrEngines ?? createProductionOcrEngines)({
    platform,
    isWindows7Runtime,
    ocrTesseractEnabled: options.ocrTesseractEnabled,
    userDataPath: options.userDataPath,
    appPath: options.appPath,
    resourcesPath: options.resourcesPath
  })
  const dispatcher = new OcrDispatcher({
    platform,
    engines
  })
  const enginePreference = isWindows7Runtime ? 'tesseract' : options.ocrEnginePreference
  const modelFingerprint = options.getModelFingerprint?.() ??
    createHash('sha256').update(JSON.stringify([
      'document-worker',
      options.ocrLang,
      options.ocrEnginePreference
    ])).digest('hex')
  const exportDocument = options.exportDocumentToPdf ?? exportDocumentToPdf

  return {
    async parse(
      input: DocumentParseInput,
      signal: AbortSignal,
      registerAssetBytes?: (assetId: string, bytes: Uint8Array) => void
    ): Promise<Awaited<ReturnType<typeof parseDocument>>> {
      if (input.format !== 'pdf') {
        return parseDocument(input, {
          ...(registerAssetBytes ? { registerAssetBytes } : {})
        })
      }
      const rasterizer = await createProductionPdfRasterizer(signal)
      return parseDocument(input, {
        renderPageToImage: rasterizer.renderPageToImage,
        renderPageRegionToImage: rasterizer.renderPageRegionToImage,
        renderEmbeddedImageToImage: rasterizer.renderEmbeddedImageToImage,
        ...(registerAssetBytes ? { registerAssetBytes } : {}),
        signal
      })
    },
    loadAssetBytes: loadUncachedAssetBytes,
    async recognizeImage(bytes: Uint8Array, signal: AbortSignal): Promise<OcrRecognizeResult> {
      return recognizeAdaptiveOcr({
        imageBytes: bytes,
        maxScale: options.ocrScale,
        language: options.ocrLang,
        preprocessingProfile: 'document'
      }, {
        recognize: (preparedImageBytes) => dispatcher.recognize({
          imageBytes: preparedImageBytes,
          language: options.ocrLang,
          timeoutMs: DOCUMENT_WORKER_OCR_TIMEOUT_MS,
          signal
        }, enginePreference)
      })
    },
    translate(
      text: string,
      signal: AbortSignal,
      languagePair: DocumentLanguagePair,
      onDelta: ((delta: string) => void) | undefined,
      context: { jobId: string; generation: number }
    ): Promise<string> {
      return options.translationRpc.translate({
        requestId: randomUUID(),
        jobId: context.jobId,
        generation: context.generation,
        text,
        languagePair
      }, signal, onDelta ?? (() => undefined))
    },
    loadFontBytes: () => loadDocumentPdfFontBytes({
      isPackaged: options.isPackaged,
      appPath: options.appPath,
      resourcesPath: options.resourcesPath
    }),
    exportPdf: (model, dependencies, exportOptions) => exportDocument(
      model,
      dependencies,
      {
        ...(exportOptions.textLayer !== undefined
          ? { includeOcrTextLayer: exportOptions.textLayer }
          : {}),
        ...(exportOptions.layout ? { layout: exportOptions.layout } : {}),
        ...(exportOptions.sourceModel ? { sourceModel: exportOptions.sourceModel } : {}),
        ...(exportOptions.signal ? { signal: exportOptions.signal } : {}),
        ...(exportOptions.onProgress ? { onProgress: exportOptions.onProgress } : {})
      }
    ).then((result: Awaited<ReturnType<typeof exportDocumentToPdf>>) => ({
      bytes: result.bytes,
      warnings: result.warnings
    })),
    getModelFingerprint: () => options.getModelFingerprint?.() ?? modelFingerprint,
    getTranslationConcurrency: () => options.translationRpc.getTranslationConcurrency(),
    getOcrConcurrency: () => options.ocrConcurrency ?? 2
  }
}
