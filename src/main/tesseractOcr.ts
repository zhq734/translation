import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  OcrEngineError,
  withOcrTimeout,
  type OcrEngine,
  type OcrRecognizeInput,
  type OcrRecognizeResult
} from '../shared/ocrEngine'
import type { OcrTextLine } from '../shared/types'
import { translateMain } from './messages'

/** Tesseract worker 最小接口，便于测试注入。 */
export interface TesseractWorker {
  /**
   * 识别图片或字节。
   * @param input 图片字节或路径。
   * @param options 识别参数；省略时由 tesseract.js 使用默认值。
   * @param output 需要返回的输出类型；文档场景显式请求 blocks。
   * @returns 识别结果，含 data.text 与可选结构化 blocks。
   */
  recognize(
    input: unknown,
    options?: Record<string, unknown>,
    output?: { text?: boolean; blocks?: boolean }
  ): Promise<{ data: TesseractRecognizeData }>
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

/** Tesseract 行框，坐标使用输入图片像素。 */
interface TesseractBoundingBox {
  /** 左坐标。 */
  x0: number
  /** 上坐标。 */
  y0: number
  /** 右坐标。 */
  x1: number
  /** 下坐标。 */
  y1: number
}

/** Tesseract 结构化文本行。 */
interface TesseractLine {
  /** 识别文本。 */
  text?: unknown
  /** 识别置信度，通常为 0-100。 */
  confidence?: unknown
  /** 行框。 */
  bbox?: unknown
}

/** Tesseract 结构化段落。 */
interface TesseractParagraph {
  /** 段落内文本行。 */
  lines?: unknown
}

/** Tesseract 结构化区块。 */
interface TesseractBlock {
  /** 区块内段落。 */
  paragraphs?: unknown
}

/** Tesseract worker 返回的识别数据。 */
interface TesseractRecognizeData {
  /** 纯文本。 */
  text: string
  /** 可选结构化区块。 */
  blocks?: unknown
}

/**
 * Tesseract OCR 引擎可注入依赖。
 * @author zhenghq
 */
export interface TesseractOcrDeps {
  /** tessdata 缓存目录路径。 */
  tessDataPath: string
  /** 语言模型下载地址或本地目录；省略时使用 tesseract.js 默认 CDN。 */
  langPath?: string
  /** 安装包内置语言模型目录；目录包含所需全部模型时优先使用。 */
  bundledLangPath?: string
  /** 打包后 worker 脚本的真实文件路径；asar 内路径无法启动 worker。 */
  workerPath?: string
  /** 判断模型文件是否存在；供测试注入，省略时使用文件系统。 */
  fileExists?(path: string): boolean
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

/** 传给 tesseract.js createWorker 的最小选项。 */
export interface TesseractWorkerOptions {
  /** 语言模型缓存目录。 */
  cachePath: string
  /** 已解析的语言模型目录或镜像地址。 */
  langPath?: string
  /** 打包后 worker 脚本的真实文件路径。 */
  workerPath?: string
  /** Tesseract 运行进度回调。 */
  logger(message: { status?: string; progress?: number }): void
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
 * 将 Tesseract blocks 中的行框与置信度规范化为 OCR 文本行。
 * 无有效行框时返回空数组，由调用方回退到纯文本拆分。
 * @param blocks Tesseract data.blocks。
 * @returns 带像素行框和 0-1 置信度的文本行。
 * @author zhenghq
 */
export function normalizeTesseractBlocks(blocks: unknown): OcrTextLine[] {
  if (!Array.isArray(blocks)) return []
  const result: OcrTextLine[] = []
  for (const block of blocks) {
    const paragraphs = (block as TesseractBlock | null)?.paragraphs
    if (!Array.isArray(paragraphs)) continue
    for (const paragraph of paragraphs) {
      const lines = (paragraph as TesseractParagraph | null)?.lines
      if (!Array.isArray(lines)) continue
      for (const rawLine of lines) {
        const line = rawLine as TesseractLine | null
        const text = typeof line?.text === 'string' ? line.text.trim() : ''
        const box = normalizeTesseractBoundingBox(line?.bbox)
        if (!text || !box) continue
        const rawConfidence = Number(line?.confidence)
        const confidence = Number.isFinite(rawConfidence)
          ? Math.max(0, Math.min(1, rawConfidence / 100))
          : undefined
        result.push({
          text,
          box,
          ...(confidence === undefined ? {} : { confidence })
        })
      }
    }
  }
  return result
}

/**
 * 将 Tesseract x0/y0/x1/y1 行框转换为统一左上角宽高格式。
 * @param value 原始行框。
 * @returns 有效像素行框；坐标无效或尺寸非正时返回 undefined。
 * @author zhenghq
 */
function normalizeTesseractBoundingBox(value: unknown): OcrTextLine['box'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const bbox = value as Partial<TesseractBoundingBox>
  const x0 = Number(bbox.x0)
  const y0 = Number(bbox.y0)
  const x1 = Number(bbox.x1)
  const y1 = Number(bbox.y1)
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return undefined
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/**
 * 确保 Tesseract 语言模型缓存目录存在。
 * tesseract.js 只调用 fs.writeFile 写入缓存，不会创建父目录；
 * 目录缺失会导致模型永远写不进缓存，每次识别都要重新下载。
 * @param tessDataPath tessdata 缓存目录路径；为空时不做任何处理。
 * @returns 无返回值。
 * @author zhenghq
 */
export function ensureTessDataDirectory(tessDataPath: string): void {
  if (!tessDataPath) return
  try {
    mkdirSync(tessDataPath, { recursive: true })
  } catch {
    // 目录创建失败时保持原有行为，交由 tesseract.js 后续报错处理。
  }
}

/**
 * 规范化 Tesseract 语言模型地址，避免把无效协议或空值传给 worker。
 * @param value 配置的模型地址或本地目录。
 * @returns 可用的 HTTP(S)/本地绝对路径；无效时返回 undefined。
 * @author zhenghq
 */
export function resolveTesseractLangPath(value: string | undefined): string | undefined {
  const candidate = value?.trim()
  if (!candidate) return undefined
  if (/^https?:\/\//iu.test(candidate)) return candidate.replace(/\/+$/u, '')
  if (/^[A-Za-z]:[\\/]/u.test(candidate) || candidate.startsWith('/')) {
    return candidate.replace(/[\\/]+$/u, '')
  }
  return undefined
}

/**
 * 为指定 Tesseract 语言选择模型目录。
 * 显式配置始终优先；内置目录只有在包含全部所需语言模型时才使用，
 * 否则返回 undefined，让 tesseract.js 回退到默认 CDN。
 * @param options 语言、显式配置目录、内置目录与文件存在性检查。
 * @returns 可传给 tesseract.js 的语言模型目录；需要回退 CDN 时返回 undefined。
 * @author zhenghq
 */
export function resolveTesseractLangPathForLanguage(options: {
  lang: string
  configuredPath?: string
  bundledPath?: string
  fileExists?(path: string): boolean
}): string | undefined {
  const configuredPath = resolveTesseractLangPath(options.configuredPath)
  if (configuredPath) return configuredPath

  const bundledPath = resolveTesseractLangPath(options.bundledPath)
  if (!bundledPath) return undefined
  const fileExists = options.fileExists ?? existsSync
  const languages = options.lang.split('+').map((lang) => lang.trim()).filter(Boolean)
  if (languages.length === 0) return undefined
  const hasAllModels = languages.every((lang) =>
    fileExists(join(bundledPath, `${lang}.traineddata.gz`))
  )
  return hasAllModels ? bundledPath : undefined
}

/**
 * 解析打包后的 Tesseract worker 脚本路径。
 * worker_threads 只能从真实文件系统加载脚本，因此打包版本必须指向 asar.unpacked。
 * @param resourcesPath Electron resources 目录。
 * @param packaged 当前是否运行于打包应用。
 * @returns 打包应用的 worker 绝对路径；开发环境返回 undefined。
 * @author zhenghq
 */
export function resolveTesseractWorkerPath(
  resourcesPath: string,
  packaged: boolean
): string | undefined {
  if (!packaged) return undefined
  return join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    'tesseract.js',
    'src',
    'worker-script',
    'node',
    'index.js'
  )
}

/**
 * 构造 tesseract.js worker 选项，集中处理缓存目录、内置模型与 worker 路径。
 * @param options 语言、缓存目录、模型来源、worker 路径与进度回调。
 * @returns 可直接传给 tesseract.js createWorker 的选项。
 * @author zhenghq
 */
export function buildTesseractWorkerOptions(options: {
  lang: string
  tessDataPath: string
  langPath?: string
  bundledLangPath?: string
  workerPath?: string
  fileExists?(path: string): boolean
  onProgress?(status: string, progress?: number): void
}): TesseractWorkerOptions {
  const resolvedLangPath = resolveTesseractLangPathForLanguage({
    lang: options.lang,
    configuredPath: options.langPath,
    bundledPath: options.bundledLangPath,
    ...(options.fileExists ? { fileExists: options.fileExists } : {})
  })
  return {
    cachePath: options.tessDataPath,
    ...(resolvedLangPath ? { langPath: resolvedLangPath } : {}),
    ...(options.workerPath ? { workerPath: options.workerPath } : {}),
    logger: (message: { status?: string; progress?: number }) => {
      if (!message?.status) return
      if (!/loading language|recognizing text/iu.test(message.status)) return
      const progress = Math.round((message.progress ?? 0) * 100)
      options.onProgress?.(message.status, progress || undefined)
    }
  }
}

/**
 * 默认 Tesseract worker 创建函数，动态 import tesseract.js。
 * @param lang Tesseract 语言字符串。
 * @param tessDataPath tessdata 缓存目录。
 * @param onProgress 进度回调。
 * @param langPath 显式配置的语言模型目录或镜像。
 * @param bundledLangPath 安装包内置语言模型目录。
 * @param fileExists 模型文件存在性检查。
 * @param workerPath 打包后 worker 脚本的真实文件路径。
 * @returns worker 实例。
 * @author zhenghq
 */
async function defaultCreateWorker(
  lang: string,
  tessDataPath: string,
  onProgress?: (status: string, progress?: number) => void,
  langPath?: string,
  bundledLangPath?: string,
  fileExists?: (path: string) => boolean,
  workerPath?: string
): Promise<TesseractWorker> {
  ensureTessDataDirectory(tessDataPath)
  const workerOptions = buildTesseractWorkerOptions({
    lang,
    tessDataPath,
    ...(langPath ? { langPath } : {}),
    ...(bundledLangPath ? { bundledLangPath } : {}),
    ...(fileExists ? { fileExists } : {}),
    ...(workerPath ? { workerPath } : {}),
    ...(onProgress ? { onProgress } : {})
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = await import('tesseract.js' as string) as any
  const createWorker = mod.createWorker ?? mod.default?.createWorker
  const worker = await createWorker(lang, 1, workerOptions)
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
        defaultCreateWorker(
          lang,
          this.deps.tessDataPath,
          this.deps.onProgress,
          this.deps.langPath,
          this.deps.bundledLangPath,
          this.deps.fileExists,
          this.deps.workerPath
        ),
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
      // 创建失败时必须移除缓存，否则后续截图会永久复用同一个 rejected Promise。
      const created = this.deps.createWorker(lang).catch((error: unknown) => {
        this.workerCache.delete(lang)
        throw error
      })
      this.workerCache.set(lang, created)
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
      throw new OcrEngineError(
        'engine-unavailable',
        translateMain('ocr.error.tesseractMissingInput'),
        'tesseract'
      )
    }

    const lang = tesseractLanguageTag(input.language ?? 'auto')
    const timeoutMs = input.timeoutMs ?? 60000

    try {
      const worker = await this.getOrCreateWorker(lang)
      const imageInput = hasBytes
        ? Buffer.from(input.imageBytes!)
        : input.imagePath!

      const { data } = await withOcrTimeout(
        worker.recognize(imageInput, {}, { text: true, blocks: true }),
        { timeoutMs, signal: input.signal, message: translateMain },
        'tesseract'
      )
      const structuredLines = normalizeTesseractBlocks(data.blocks)
      const lines = structuredLines.length > 0
        ? structuredLines
        : normalizeTesseractLines(data.text)
      const text = lines.map((l) => l.text).join('\n')
      return { lines, text, engine: 'tesseract' }
    } catch (error) {
      if (error instanceof OcrEngineError) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (/timeout/i.test(message)) {
        throw new OcrEngineError('timeout', translateMain('ocr.error.tesseractTimeout'), 'tesseract')
      }
      if (/traineddata|fetch|download|network/i.test(message)) {
        throw new OcrEngineError(
          'engine-unavailable',
          translateMain('ocr.error.tesseractModelDownloadFailed'),
          'tesseract'
        )
      }
      if (/terminated/i.test(message)) {
        throw new OcrEngineError(
          'engine-unavailable',
          translateMain('ocr.error.tesseractInterrupted'),
          'tesseract'
        )
      }
      throw new OcrEngineError(
        'engine-unavailable',
        translateMain('ocr.error.tesseractFailed', { message }),
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
