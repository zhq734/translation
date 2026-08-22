import {
  OcrEngineError,
  withOcrTimeout,
  type OcrEngine,
  type OcrRecognizeInput,
  type OcrRecognizeResult
} from '../shared/ocrEngine'
import type { OcrTextLine } from '../shared/types'

/** Tesseract worker 最小接口，便于测试注入。 */
export interface TesseractWorker {
  /**
   * 识别图片或字节。
   * @param input 图片字节或路径。
   * @returns 识别结果，含 data.text。
   */
  recognize(input: unknown): Promise<{ data: { text: string } }>
  /**
   * 设置 Tesseract 参数。
   * @param params 参数键值对。
   */
  setParameters(params: Record<string, string>): Promise<void>
  /**
   * 释放 worker 资源。
   */
  terminate(): Promise<void>
}

/**
 * Tesseract OCR 引擎可注入依赖。
 * @author zhenghq
 */
export interface TesseractOcrDeps {
  /** tessdata 缓存目录路径。 */
  tessDataPath: string
  /**
   * 创建 Tesseract worker（惰性加载 tesseract.js）。
   * @param lang Tesseract 语言字符串（如 chi_sim+eng）。
   * @returns worker 实例。
   */
  createWorker(lang: string): Promise<TesseractWorker>
  /**
   * 识别进度回调，可用于更新 UI 状态。
   * @param status 状态描述。
   * @param progress 进度 0-100，可选。
   */
  onProgress?(status: string, progress?: number): void
}

/**
 * 将语言偏好映射为 Tesseract 语言字符串。
 * 默认回退 chi_sim+eng（兜底兼容中英）。
 * @param language 语言偏好字符串。
 * @returns Tesseract 语言字符串。
 * @author zhenghq
 */
export function tesseractLanguageTag(language: string): string {
  if (!language || language === 'auto') return 'chi_sim+eng'
  const key = language.toLowerCase()
  if (key === 'zh-hant' || key === 'zh-tw' || key === 'zht') return 'chi_tra+eng'
  if (key.startsWith('zh')) return 'chi_sim+eng'
  const map: Record<string, string> = {
    'en': 'eng',
    'ja': 'jpn+eng',
    'ko': 'kor+eng',
    'ru': 'rus+eng',
    'fr': 'fra+eng',
    'de': 'deu+eng',
    'es': 'spa+eng',
    'it': 'ita+eng',
    'pt': 'por+eng',
    'ar': 'ara+eng',
    'th': 'tha+eng',
    'vi': 'vie+eng',
    'id': 'ind+eng'
  }
  return map[key] ?? 'chi_sim+eng'
}

/**
 * 将 Tesseract 识别的原始文本规范化为 OcrTextLine 数组。
 * 按换行符拆分，过滤空行与仅空白行。
 * @param rawText Tesseract data.text 原始字符串。
 * @returns 文本行数组。
 * @author zhenghq
 */
export function normalizeTesseractLines(rawText: string): OcrTextLine[] {
  if (!rawText || !rawText.trim()) return []
  return rawText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text) => ({ text }))
}

/**
 * 默认 Tesseract worker 创建函数，动态 import tesseract.js。
 * @param lang Tesseract 语言字符串。
 * @param tessDataPath tessdata 缓存目录。
 * @param onProgress 进度回调。
 * @returns worker 实例。
 * @author zhenghq
 */
async function defaultCreateWorker(
  lang: string,
  tessDataPath: string,
  onProgress?: (status: string, progress?: number) => void
): Promise<TesseractWorker> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = await import('tesseract.js' as string) as any
  const createWorker = mod.createWorker ?? mod.default?.createWorker
  const worker = await createWorker(lang, 1, {
    cachePath: tessDataPath,
    logger: (message: { status?: string; progress?: number }) => {
      if (!message?.status) return
      if (!/loading language|recognizing text/iu.test(message.status)) return
      const progress = Math.round((message.progress ?? 0) * 100)
      onProgress?.(message.status, progress || undefined)
    }
  })
  await worker.setParameters({
    tessedit_pageseg_mode: '6',
    preserve_interword_spaces: '1'
  })
  return worker
}

/**
 * Tesseract.js 兜底 OCR 引擎。
 * 按语言缓存 worker，避免重复初始化。支持进度回调与超时/取消。
 * @author zhenghq
 */
export class TesseractOcrEngine implements OcrEngine {
  /** 引擎标识。 */
  readonly id = 'tesseract' as const

  /** 按语言缓存的 worker 实例（key: Tesseract 语言字符串）。 */
  private readonly workerCache = new Map<string, Promise<TesseractWorker>>()

  /** 可注入依赖。 */
  private readonly deps: TesseractOcrDeps

  /**
   * 创建 Tesseract OCR 引擎。
   * @param deps 可注入依赖；省略时使用默认值（生产环境）。
   * @author zhenghq
   */
  constructor(deps?: Partial<TesseractOcrDeps>) {
    this.deps = {
      tessDataPath: '',
      createWorker: (lang: string) =>
        defaultCreateWorker(lang, this.deps.tessDataPath, this.deps.onProgress),
      onProgress: undefined,
      ...deps
    }
  }

  /**
   * 判断 Tesseract.js 是否可加载。
   * 尝试动态 import tesseract.js 模块，失败则返回 false。
   * @returns 是否可用。
   * @author zhenghq
   */
  async isAvailable(): Promise<boolean> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await import('tesseract.js' as string) as any
      return true
    } catch {
      return false
    }
  }

  /**
   * 惰性获取或创建指定语言的 Tesseract worker，按语言字符串缓存。
   * @param lang Tesseract 语言字符串。
   * @returns worker 实例。
   * @author zhenghq
   */
  private getOrCreateWorker(lang: string): Promise<TesseractWorker> {
    if (!this.workerCache.has(lang)) {
      this.workerCache.set(lang, this.deps.createWorker(lang))
    }
    return this.workerCache.get(lang)!
  }

  /**
   * 使用 Tesseract.js 识别图片文字。
   * imageBytes 优先于 imagePath；结果经 normalizeTesseractLines 规范化后返回。
   * @param input 识别输入（图片字节或路径）。
   * @returns 识别结果。
   * @author zhenghq
   */
  async recognize(input: OcrRecognizeInput): Promise<OcrRecognizeResult> {
    const hasBytes = Boolean(input.imageBytes && input.imageBytes.length > 0)
    const hasPath = typeof input.imagePath === 'string' && input.imagePath.trim() !== ''
    if (!hasBytes && !hasPath) {
      throw new OcrEngineError('engine-unavailable', 'Tesseract OCR 缺少图片输入', 'tesseract')
    }

    const lang = tesseractLanguageTag(input.language ?? 'auto')
    const timeoutMs = input.timeoutMs ?? 60000

    const worker = await this.getOrCreateWorker(lang)

    const imageInput = hasBytes
      ? Buffer.from(input.imageBytes!)
      : input.imagePath!

    try {
      const { data } = await withOcrTimeout(
        worker.recognize(imageInput),
        { timeoutMs, signal: input.signal },
        'tesseract'
      )
      const lines = normalizeTesseractLines(data.text)
      const text = lines.map((l) => l.text).join('\n')
      return { lines, text, engine: 'tesseract' }
    } catch (error) {
      if (error instanceof OcrEngineError) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (/timeout/i.test(message)) {
        throw new OcrEngineError('timeout', 'Tesseract OCR 超时', 'tesseract')
      }
      if (/traineddata|fetch|download|network/i.test(message)) {
        throw new OcrEngineError(
          'engine-unavailable',
          'Tesseract 语言模型下载失败，请检查网络后重试',
          'tesseract'
        )
      }
      if (/terminated/i.test(message)) {
        throw new OcrEngineError(
          'engine-unavailable',
          'Tesseract OCR 已中断，请重新截图识别',
          'tesseract'
        )
      }
      throw new OcrEngineError(
        'engine-unavailable',
        `Tesseract OCR 执行失败: ${message}`,
        'tesseract'
      )
    }
  }

  /**
   * 释放所有缓存的 Tesseract worker，供应用退出时调用。
   * @returns 无返回值。
   * @author zhenghq
   */
  async dispose(): Promise<void> {
    const workers = [...this.workerCache.values()]
    this.workerCache.clear()
    await Promise.allSettled(
      workers.map(async (wp) => {
        try {
          const w = await wp
          await w.terminate()
        } catch {
          // 静默忽略释放失败
        }
      })
    )
  }
}
