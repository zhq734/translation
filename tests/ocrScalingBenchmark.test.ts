import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { decodePng } from '../src/main/pngCodec.ts'
import {
  calculateCharacterAccuracy,
  normalizeOcrBenchmarkText
} from '../scripts/ocr-scaling-benchmark-metrics.ts'

/** OCR 缩放基准样本类型。 */
type OcrScalingFixtureCategory = 'clear' | 'defocused' | 'low-contrast' | 'compressed'

/** OCR 缩放基准清单条目。 */
interface OcrScalingFixtureEntry {
  /** 样本唯一标识。 */
  id: string
  /** 样本质量类型。 */
  category: OcrScalingFixtureCategory
  /** 相对清单文件的 PNG 路径。 */
  file: string
  /** 样本期望识别文本。 */
  expectedText: string
  /** 样本来源说明。 */
  source: string
  /** 确定性生成参数说明。 */
  generation: string
}

/** OCR 缩放基准清单结构。 */
interface OcrScalingFixtureManifest {
  /** 清单格式版本。 */
  version: number
  /** 固定样本列表。 */
  fixtures: OcrScalingFixtureEntry[]
}

/**
 * 读取固定 OCR 缩放样本清单。
 * @returns 清单路径、清单目录与解析后的清单。
 * @author zhenghq
 */
function readFixtureManifest(): {
  manifestPath: string
  manifestDirectory: string
  manifest: OcrScalingFixtureManifest
} {
  const manifestPath = resolve('tests', 'fixtures', 'ocr-scaling', 'manifest.json')
  return {
    manifestPath,
    manifestDirectory: dirname(manifestPath),
    manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) as OcrScalingFixtureManifest
  }
}

/**
 * 校验固定样本完整覆盖四类质量退化，并记录真值及可追溯来源。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 缩放基准应提供四类含真值且可追溯的固定样本', () => {
  const { manifestPath, manifest } = readFixtureManifest()
  const categories = manifest.fixtures.map((fixture) => fixture.category).sort()

  assert.equal(existsSync(manifestPath), true)
  assert.equal(manifest.version, 1)
  assert.deepEqual(categories, ['clear', 'compressed', 'defocused', 'low-contrast'])
  assert.equal(new Set(manifest.fixtures.map((fixture) => fixture.id)).size, 4)
  for (const fixture of manifest.fixtures) {
    assert.ok(fixture.expectedText.trim().length > 0)
    assert.match(fixture.source, /仓库内生成脚本/u)
    assert.ok(fixture.generation.trim().length > 0)
  }
})

/**
 * 校验清单引用的固定样本均已落盘，并能由生产 PNG 解码器读取。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 缩放基准中的 PNG 应存在且能由生产解码器读取', () => {
  const { manifestDirectory, manifest } = readFixtureManifest()

  for (const fixture of manifest.fixtures) {
    const imagePath = join(manifestDirectory, fixture.file)
    assert.equal(existsSync(imagePath), true, `${fixture.id} 图片不存在`)
    const image = decodePng(readFileSync(imagePath))
    assert.ok(image.width > 0)
    assert.ok(image.height > 0)
    assert.equal(image.data.length, image.width * image.height * 4)
  }
})

/**
 * 校验基准字符准确率使用清单约定的大小写、空白和标点归一化规则。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OCR 缩放基准应按归一化编辑距离计算字符准确率', () => {
  assert.equal(normalizeOcrBenchmarkText(' Adaptive, OCR 2026! '), 'ADAPTIVEOCR2026')
  assert.equal(calculateCharacterAccuracy('Adaptive OCR 2026', 'ADAPTIVE OCR 2026'), 1)
  assert.equal(calculateCharacterAccuracy('ADAPTIVE OCR 202B', 'ADAPTIVE OCR 2026'), 14 / 15)
  assert.equal(calculateCharacterAccuracy('', ''), 1)
  assert.equal(calculateCharacterAccuracy('', 'OCR'), 0)
})
