import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** PaddleOCR ONNX 模型路径集合。 */
export interface PaddleOcrModelPaths {
  /** 文字检测 ONNX 模型路径。 */
  detectionPath: string
  /** 文字识别 ONNX 模型路径。 */
  recognitionPath: string
  /** 识别字典路径。 */
  dictionaryPath: string
}

/** OCR 模型资产元数据，用于运行时状态展示与测试校验。 */
export interface OcrModelAssetMetadata {
  /** 模型名称。 */
  name: string
  /** 模型版本或上游提交标识。 */
  version: string
  /** 模型许可。 */
  license: string
  /** 模型分发方式。 */
  distribution: 'bundled'
  /** 上游提供方。 */
  provider: string
  /** 上游来源链接。 */
  source: {
    detection: string
    recognition: string
    dictionary: string
  }
}

/** OCR 模型资产解析结果。 */
export interface OcrModelAssetStatus {
  /** 随包模型资产是否完整可用。 */
  ready: boolean
  /** 模型资产目录。 */
  modelDir: string
  /** 模型元数据。 */
  metadata: OcrModelAssetMetadata
  /** ocr-node 可直接消费的模型路径。 */
  models?: PaddleOcrModelPaths
  /** 缺失或异常的文件名。 */
  missingFiles: string[]
  /** 面向用户展示的状态说明。 */
  message: string
}

/** @gutenye/ocr-node 默认 PP-OCRv4 兼容模型元数据。 */
export const GUTEN_PPOCRV4_METADATA: OcrModelAssetMetadata = {
  name: 'PP-OCRv4 ONNX',
  version: '@gutenye/ocr-models bundled',
  license: 'MIT',
  distribution: 'bundled',
  provider: 'Guten OCR / PaddleOCR',
  source: {
    detection: 'node_modules/@gutenye/ocr-models/assets/ch_PP-OCRv4_det_infer.onnx',
    recognition: 'node_modules/@gutenye/ocr-models/assets/ch_PP-OCRv4_rec_infer.onnx',
    dictionary: 'node_modules/@gutenye/ocr-models/assets/ppocr_keys_v1.txt'
  }
}

/** PP-OCRv6_tiny 随包资产元数据。 */
export const PP_OCRV6_TINY_METADATA: OcrModelAssetMetadata = {
  name: 'PP-OCRv6_tiny ONNX',
  version: 'det:2ba1506c0380b8f0b03dd142459aac66d4421f6c; rec:2612ab37152ae0a677521bae4e1e3d4fb4cf7c30',
  license: 'Apache-2.0',
  distribution: 'bundled',
  provider: 'PaddlePaddle',
  source: {
    detection: 'https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx',
    recognition: 'https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec_onnx',
    dictionary: 'https://github.com/PaddlePaddle/PaddleOCR/blob/main/ppocr/utils/ppocr_keys_v1.txt'
  }
}

const GUTEN_PPOCRV4_RELATIVE_DIR = ['node_modules', '@gutenye', 'ocr-models', 'assets'] as const
const GUTEN_PPOCRV4_REQUIRED_FILES = [
  { name: 'ch_PP-OCRv4_det_infer.onnx', minBytes: 4_000_000 },
  { name: 'ch_PP-OCRv4_rec_infer.onnx', minBytes: 9_000_000 },
  { name: 'ppocr_keys_v1.txt', minBytes: 20_000 }
] as const

const PP_OCRV6_TINY_RELATIVE_DIR = ['assets', 'ocr', 'ppocrv6_tiny'] as const
const PP_OCRV6_TINY_REQUIRED_FILES = [
  { name: 'det.onnx', minBytes: 1_700_000 },
  { name: 'rec.onnx', minBytes: 4_400_000 },
  { name: 'dict.txt', minBytes: 20_000 },
  { name: 'metadata.json', minBytes: 100 },
  { name: 'LICENSE', minBytes: 100 }
] as const

/**
 * 将 Electron app 路径转换为真实可读的资源根路径。
 * 打包后模型放在 asarUnpack 中，native runtime 需要真实文件路径。
 * @param appPath Electron `app.getAppPath()` 返回值。
 * @returns 资源根路径。
 * @author zhenghq
 */
export function resolveOcrAssetRoot(appPath: string): string {
  const normalized = String(appPath ?? '')
  return normalized.includes('.asar')
    ? normalized.replace(/\.asar(?=$|[\\/])/u, '.asar.unpacked')
    : normalized
}

/**
 * 校验模型目录中的必需文件是否完整。
 * @param modelDir 模型目录。
 * @param requiredFiles 必需文件定义。
 * @returns 缺失或异常的文件名列表。
 * @author zhenghq
 */
function findMissingModelFiles(
  modelDir: string,
  requiredFiles: ReadonlyArray<{ name: string; minBytes: number }>
): string[] {
  const missingFiles: string[] = []
  for (const file of requiredFiles) {
    const filePath = join(modelDir, file.name)
    if (!existsSync(filePath)) {
      missingFiles.push(file.name)
      continue
    }
    const size = statSync(filePath).size
    if (size < file.minBytes) missingFiles.push(`${file.name}(${size}B)`)
  }
  return missingFiles
}

/**
 * 解析当前默认 PaddleOCR 兼容模型目录，并校验必需文件是否完整。
 * @param appPath Electron 应用路径。
 * @returns 模型资产状态。
 * @author zhenghq
 */
export function resolveBundledOcrModelAssets(appPath: string): OcrModelAssetStatus {
  const modelDir = join(resolveOcrAssetRoot(appPath), ...GUTEN_PPOCRV4_RELATIVE_DIR)
  const missingFiles = findMissingModelFiles(modelDir, GUTEN_PPOCRV4_REQUIRED_FILES)
  const ready = missingFiles.length === 0
  return {
    ready,
    modelDir,
    metadata: GUTEN_PPOCRV4_METADATA,
    models: ready
      ? {
          detectionPath: join(modelDir, 'ch_PP-OCRv4_det_infer.onnx'),
          recognitionPath: join(modelDir, 'ch_PP-OCRv4_rec_infer.onnx'),
          dictionaryPath: join(modelDir, 'ppocr_keys_v1.txt')
        }
      : undefined,
    missingFiles,
    message: ready
      ? 'PP-OCRv4 兼容模型资产已就绪'
      : `PP-OCRv4 兼容模型资产不完整：${missingFiles.join('、')}`
  }
}

/**
 * 解析随包 PP-OCRv6_tiny 留档模型目录，并校验必需文件是否完整。
 * 该模型当前不作为默认 PaddleOCR runtime，避免与 @gutenye/ocr-node 解码链路不兼容。
 * @param appPath Electron 应用路径。
 * @returns 模型资产状态。
 * @author zhenghq
 */
export function resolveBundledPpOcrV6ModelAssets(appPath: string): OcrModelAssetStatus {
  const modelDir = join(resolveOcrAssetRoot(appPath), ...PP_OCRV6_TINY_RELATIVE_DIR)
  const missingFiles = findMissingModelFiles(modelDir, PP_OCRV6_TINY_REQUIRED_FILES)
  const ready = missingFiles.length === 0
  return {
    ready,
    modelDir,
    metadata: PP_OCRV6_TINY_METADATA,
    models: ready
      ? {
          detectionPath: join(modelDir, 'det.onnx'),
          recognitionPath: join(modelDir, 'rec.onnx'),
          dictionaryPath: join(modelDir, 'dict.txt')
        }
      : undefined,
    missingFiles,
    message: ready
      ? 'PP-OCRv6_tiny 留档模型资产已就绪（默认不启用）'
      : `PP-OCRv6_tiny 留档模型资产不完整：${missingFiles.join('、')}`
  }
}
