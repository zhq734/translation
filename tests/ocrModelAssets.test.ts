import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  GUTEN_PPOCRV4_METADATA,
  PP_OCRV6_TINY_METADATA,
  resolveBundledOcrModelAssets,
  resolveBundledPpOcrV6ModelAssets,
  resolveOcrAssetRoot
} from '../src/main/ocrModelAssets.ts'

const assetDir = 'assets/ocr/ppocrv6_tiny'

/**
 * 读取资产文件的 SHA-256。
 * @param path 文件路径。
 * @returns 十六进制 SHA-256。
 * @author zhenghq
 */
function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 校验 PP-OCRv6_tiny 官方 ONNX 资产已随仓库分发。
 * @returns 无返回值。
 * @author zhenghq
 */
test('PP-OCRv6_tiny ONNX 模型资产应完整随包分发', () => {
  const metadata = JSON.parse(readFileSync(`${assetDir}/metadata.json`, 'utf8')) as {
    name: string
    version: string
    license: string
    distribution: string
    source: Record<string, string>
    files: Record<string, { path: string; bytes: number; sha256: string }>
  }

  assert.equal(metadata.name, 'PP-OCRv6_tiny ONNX')
  assert.equal(metadata.license, 'Apache-2.0')
  assert.equal(metadata.distribution, 'bundled')
  assert.match(metadata.source.detection, /PP-OCRv6_tiny_det_onnx/u)
  assert.match(metadata.source.recognition, /PP-OCRv6_tiny_rec_onnx/u)

  for (const file of Object.values(metadata.files)) {
    const path = `${assetDir}/${file.path}`
    assert.equal(existsSync(path), true)
    assert.equal(statSync(path).size, file.bytes)
    assert.equal(sha256(path), file.sha256)
  }
})

/**
 * 校验模型资产解析能返回 ocr-node 需要的 det/rec/dict 路径。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveBundledOcrModelAssets 应返回可供 PaddleOCR 使用的模型路径', () => {
  const status = resolveBundledOcrModelAssets(process.cwd())

  assert.equal(status.ready, true)
  assert.equal(status.missingFiles.length, 0)
  assert.equal(status.metadata, GUTEN_PPOCRV4_METADATA)
  assert.match(status.models?.detectionPath ?? '', /node_modules\/@gutenye\/ocr-models\/assets\/ch_PP-OCRv4_det_infer\.onnx$/u)
  assert.match(status.models?.recognitionPath ?? '', /node_modules\/@gutenye\/ocr-models\/assets\/ch_PP-OCRv4_rec_infer\.onnx$/u)
  assert.match(status.models?.dictionaryPath ?? '', /node_modules\/@gutenye\/ocr-models\/assets\/ppocr_keys_v1\.txt$/u)
  assert.match(status.message, /PP-OCRv4/u)
})

/**
 * 校验 PP-OCRv6_tiny 资产仅作为留档资产解析，不作为默认健康 PaddleOCR 链路。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveBundledPpOcrV6ModelAssets 应单独返回 PP-OCRv6_tiny 留档资产', () => {
  const status = resolveBundledPpOcrV6ModelAssets(process.cwd())

  assert.equal(status.ready, true)
  assert.equal(status.metadata, PP_OCRV6_TINY_METADATA)
  assert.match(status.models?.detectionPath ?? '', /assets\/ocr\/ppocrv6_tiny\/det\.onnx$/u)
})

/**
 * 校验打包后的 app.asar 路径会映射到真实解包资产目录。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveOcrAssetRoot 应把 app.asar 映射到 app.asar.unpacked', () => {
  assert.equal(
    resolveOcrAssetRoot('/Applications/Translator.app/Contents/Resources/app.asar'),
    '/Applications/Translator.app/Contents/Resources/app.asar.unpacked'
  )
})
