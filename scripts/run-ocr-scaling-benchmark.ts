import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recognizeAdaptiveOcr } from '../src/main/adaptiveOcr'
import { preprocessOcrImageBytes } from '../src/main/ocrImagePreprocess'
import { resolveBundledOcrModelAssets } from '../src/main/ocrModelAssets'
import { PaddleOcrEngine } from '../src/main/paddleOcr'
import { decodePng, encodePng } from '../src/main/pngCodec'
import { enhanceRgbaForOcr, resizeRgbaForOcr } from '../src/shared/imagePreprocess'
import type { OcrRecognizeResult } from '../src/shared/ocrEngine'
import { evaluateOcrQuality, type OcrQualityEvaluation } from '../src/shared/ocrQuality'
import { calculateCharacterAccuracy } from './ocr-scaling-benchmark-metrics'

/** 单个 OCR 缩放基准样本。 */
interface BenchmarkFixture {
  /** 样本标识。 */
  id: string
  /** 相对清单目录的图片路径。 */
  file: string
  /** 期望识别文本。 */
  expectedText: string
}

/** OCR 缩放基准样本清单。 */
interface BenchmarkManifest {
  /** 固定样本列表。 */
  fixtures: BenchmarkFixture[]
}

/** 单次策略执行结果。 */
interface StrategyExecution {
  /** OCR 识别结果。 */
  result: OcrRecognizeResult
  /** 策略实际送入 OCR 的最大图片像素数。 */
  peakPixels: number
  /** 策略执行耗时。 */
  elapsedMs: number
}

/** 单项基准输出。 */
interface BenchmarkResult {
  /** 样本标识。 */
  fixture: string
  /** 策略标识。 */
  strategy: string
  /** 归一化字符准确率。 */
  accuracy: number
  /** 多次运行的耗时中位数。 */
  medianElapsedMs: number
  /** 多次运行中送入 OCR 的最大图片像素数。 */
  peakPixels: number
  /** 最终识别文本。 */
  text: string
  /** 最终识别结果的统一质量摘要。 */
  quality: OcrQualityEvaluation
  /** 最终识别结果中引擎提供的逐行置信度，不记录正文。 */
  lineConfidences: Array<number | undefined>
}

/** 正式计时重复次数。 */
const MEASURED_RUNS = 3
/** 基准 OCR 超时。 */
const OCR_TIMEOUT_MS = 30000

/**
 * 解码图片并返回像素总数。
 * @param imageBytes PNG 图片字节。
 * @returns 图片宽高相乘后的像素数。
 * @author zhenghq
 */
function countImagePixels(imageBytes: Uint8Array | Buffer): number {
  const image = decodePng(imageBytes)
  return image.width * image.height
}

/**
 * 计算数值列表的中位数。
 * @param values 待统计数值。
 * @returns 中位数；空列表返回 0。
 * @author zhenghq
 */
function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}

/**
 * 使用 PaddleOCR 识别预处理后的单张图片。
 * @param engine 已预热的 PaddleOCR 引擎。
 * @param imageBytes 待识别 PNG 字节。
 * @returns 识别结果、耗时和输入像素数。
 * @author zhenghq
 */
async function recognizeSingleImage(
  engine: PaddleOcrEngine,
  imageBytes: Buffer
): Promise<StrategyExecution> {
  const startedAt = performance.now()
  const result = await engine.recognize({
    imageBytes,
    language: 'en',
    timeoutMs: OCR_TIMEOUT_MS
  })
  return {
    result,
    peakPixels: countImagePixels(imageBytes),
    elapsedMs: performance.now() - startedAt
  }
}

/**
 * 执行指定固定倍率策略。
 * @param engine 已预热的 PaddleOCR 引擎。
 * @param sourceBytes 原始样本字节。
 * @param scale 固定倍率。
 * @returns 策略执行结果。
 * @author zhenghq
 */
async function runFixedScale(
  engine: PaddleOcrEngine,
  sourceBytes: Buffer,
  scale: number
): Promise<StrategyExecution> {
  return recognizeSingleImage(engine, preprocessOcrImageBytes(sourceBytes, scale))
}

/**
 * 执行 1× 对比度增强策略。
 * @param engine 已预热的 PaddleOCR 引擎。
 * @param sourceBytes 原始样本字节。
 * @returns 策略执行结果。
 * @author zhenghq
 */
async function runEnhanced(
  engine: PaddleOcrEngine,
  sourceBytes: Buffer
): Promise<StrategyExecution> {
  const source = decodePng(sourceBytes)
  const enhanced = enhanceRgbaForOcr(resizeRgbaForOcr(source, 1))
  return recognizeSingleImage(engine, encodePng(enhanced))
}

/**
 * 执行最终“1× 优先、低质量时单次回退”策略。
 * @param engine 已预热的 PaddleOCR 引擎。
 * @param sourceBytes 原始样本字节。
 * @returns 策略执行结果及两轮中的峰值输入像素数。
 * @author zhenghq
 */
async function runAdaptive(
  engine: PaddleOcrEngine,
  sourceBytes: Buffer
): Promise<StrategyExecution> {
  let peakPixels = 0
  const startedAt = performance.now()
  const result = await recognizeAdaptiveOcr(
    { imageBytes: sourceBytes, maxScale: 3, language: 'en' },
    {
      recognize: async (imageBytes) => {
        peakPixels = Math.max(peakPixels, countImagePixels(imageBytes))
        return engine.recognize({
          imageBytes,
          language: 'en',
          timeoutMs: OCR_TIMEOUT_MS
        })
      },
      logger: () => undefined
    }
  )
  return { result, peakPixels, elapsedMs: performance.now() - startedAt }
}

/**
 * 多次运行同一策略并汇总确定性识别结果和耗时中位数。
 * @param fixture 样本信息。
 * @param strategy 策略名称。
 * @param execute 单次策略执行函数。
 * @returns 汇总后的基准结果。
 * @author zhenghq
 */
async function measureStrategy(
  fixture: BenchmarkFixture,
  strategy: string,
  execute: () => Promise<StrategyExecution>
): Promise<BenchmarkResult> {
  const executions: StrategyExecution[] = []
  for (let run = 0; run < MEASURED_RUNS; run += 1) executions.push(await execute())
  const finalExecution = executions[executions.length - 1]!
  return {
    fixture: fixture.id,
    strategy,
    accuracy: calculateCharacterAccuracy(finalExecution.result.text, fixture.expectedText),
    medianElapsedMs: median(executions.map((execution) => execution.elapsedMs)),
    peakPixels: Math.max(...executions.map((execution) => execution.peakPixels)),
    text: finalExecution.result.text,
    quality: evaluateOcrQuality(finalExecution.result, 'en'),
    lineConfidences: finalExecution.result.lines.map((line) => line.confidence)
  }
}

/**
 * 运行固定样本上的全部 OCR 缩放策略基准并输出 JSON。
 * @returns 无返回值。
 * @author zhenghq
 */
async function main(): Promise<void> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const manifestDirectory = join(projectRoot, 'tests', 'fixtures', 'ocr-scaling')
  const manifest = JSON.parse(
    readFileSync(join(manifestDirectory, 'manifest.json'), 'utf8')
  ) as BenchmarkManifest
  const assets = resolveBundledOcrModelAssets(projectRoot)
  if (!assets.ready || !assets.models) throw new Error(assets.message)

  const engine = new PaddleOcrEngine({ models: assets.models })
  if (!await engine.isAvailable()) {
    throw new Error(engine.getUnavailableReason() ?? 'PaddleOCR runtime 不可用')
  }

  const warmupBytes = readFileSync(join(manifestDirectory, manifest.fixtures[0]!.file))
  await runFixedScale(engine, warmupBytes, 1)

  const results: BenchmarkResult[] = []
  for (const fixture of manifest.fixtures) {
    const sourceBytes = readFileSync(join(manifestDirectory, fixture.file))
    const strategies: Array<[string, () => Promise<StrategyExecution>]> = [
      ['fixed-1x', () => runFixedScale(engine, sourceBytes, 1)],
      ['fixed-1.25x', () => runFixedScale(engine, sourceBytes, 1.25)],
      ['fixed-1.5x', () => runFixedScale(engine, sourceBytes, 1.5)],
      ['fixed-2x', () => runFixedScale(engine, sourceBytes, 2)],
      ['fixed-3x', () => runFixedScale(engine, sourceBytes, 3)],
      ['enhanced-1x', () => runEnhanced(engine, sourceBytes)],
      ['adaptive-max-3x', () => runAdaptive(engine, sourceBytes)]
    ]
    for (const [strategy, execute] of strategies) {
      const result = await measureStrategy(fixture, strategy, execute)
      results.push(result)
      console.error(
        `[benchmark] ${fixture.id} ${strategy}: ${(result.accuracy * 100).toFixed(2)}% ` +
        `${result.medianElapsedMs.toFixed(2)}ms ${result.peakPixels}px`
      )
    }
  }

  console.log(JSON.stringify({ measuredRuns: MEASURED_RUNS, results }, null, 2))
}

await main()
