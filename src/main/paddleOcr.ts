import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OcrEngineError,
  withOcrTimeout,
  type OcrEngine,
  type OcrRecognizeInput,
  type OcrRecognizeResult
} from '../shared/ocrEngine'
import type { OcrTextLine } from '../shared/types'
import type { PaddleOcrModelPaths } from './ocrModelAssets'

/** @gutenye/ocr-node 返回的原始检测条目结构。 */
export interface PaddleDetectItem {
  /** 识别文本。 */
  text: string
  /** 四点包围盒（[[x0,y0],[x1,y1],[x2,y2],[x3,y3]]）。 */
  box?: [[number, number], [number, number], [number, number], [number, number]] | number[][]
  /** 置信度（0-1）。 */
  confidence?: number
  /** 置信度备选字段。 */
  score?: number
  mean?: number
  probability?: number
}

/**
 * 从 PaddleOCR 检测条目中提取包围盒（左/上/宽/高）。
 * 支持四点坐标数组与 frame/bounds/boundingBox 两种格式。
 * @param item 原始检测条目。
 * @returns 包围盒，含 x/y/width/height。
 * @author zhenghq
 */
function getPaddleItemBox(item: PaddleDetectItem): { x: number; y: number; width: number; height: number } {
  const points = Array.isArray(item?.box) ? item.box as number[][] : null
  if (points?.length) {
    const xs = points.map((p) => Number(p?.[0] ?? 0))
    const ys = points.map((p) => Number(p?.[1] ?? 0))
    const left = Math.min(...xs)
    const top = Math.min(...ys)
    const right = Math.max(...xs)
    const bottom = Math.max(...ys)
    return { x: left, y: top, width: right - left, height: bottom - top }
  }
  const rawItem = item as unknown as Record<string, unknown>
  const frame = rawItem.frame ?? rawItem.bounds ?? rawItem.boundingBox ?? {}
  const f = frame as Record<string, unknown>
  const x = Number(f.left ?? f.x ?? 0)
  const y = Number(f.top ?? f.y ?? 0)
  const width = Number(f.width ?? 0)
  const height = Number(f.height ?? 0)
  return { x, y, width, height }
}

/**
 * 判断两个相邻 OCR 片段是否应无空格拼接。
 * CJK-CJK、标点前、左括号后等场景无空格。
 * @param previous 前一片段。
 * @param next 后一片段。
 * @returns 是否无空格拼接。
 * @author zhenghq
 */
function shouldJoinWithoutSpace(previous: string, next: string): boolean {
  if (!previous || !next) return true
  if (/[\s([{《"']$/u.test(previous)) return true
  if (/^[\s,.;:!?，。！？、；：）\]】》"']/u.test(next)) return true
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]$/u.test(previous) &&
    /^[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(next)) return true
  return false
}

/**
 * 将同一行内的 OCR 片段智能拼接为一行文本。
 * CJK 无空格，英文有空格，标点前无空格。
 * @param fragments 同行文本片段数组。
 * @returns 拼接后的行文本。
 * @author zhenghq
 */
export function joinOcrFragments(fragments: string[]): string {
  return fragments.reduce((line, fragment) => {
    if (!line) return fragment
    return line + (shouldJoinWithoutSpace(line, fragment) ? '' : ' ') + fragment
  }, '')
}

/**
 * 将 @gutenye/ocr-node 返回的原始检测行列表规范化为 OcrTextLine 数组。
 * 过滤低置信度与空白文本，按包围盒 Y 轴分组后同行内按 X 排序拼接。
 * @param lines @gutenye/ocr-node 检测结果。
 * @returns 规范化后的文本行数组。
 * @author zhenghq
 */
export function normalizePaddleLines(lines: PaddleDetectItem[] | null | undefined): OcrTextLine[] {
  if (!Array.isArray(lines) || lines.length === 0) return []

  const MIN_CONFIDENCE = 0.35

  const items = lines
    .map((line) => {
      const text = String(line?.text ?? '').trim()
      const confidence = Number(
        line?.confidence ?? line?.score ?? line?.mean ?? line?.probability ?? 1
      )
      const box = getPaddleItemBox(line)
      return { text, confidence, box }
    })
    .filter(
      (item) =>
        item.text.length > 0 &&
        (!Number.isFinite(item.confidence) || item.confidence >= MIN_CONFIDENCE)
    )
    .sort((a, b) => {
      if (Math.abs(a.box.y - b.box.y) > 12) return a.box.y - b.box.y
      return a.box.x - b.box.x
    })

  // 按 Y 轴分组（同行）
  const groups: Array<{ mid: number; height: number; items: typeof items }> = []
  for (const item of items) {
    const mid = item.box.y + (item.box.height || 0) / 2
    const height = item.box.height || 18
    let group = groups.find(
      (g) => Math.abs(g.mid - mid) <= Math.max(10, Math.max(g.height, height) * 0.72)
    )
    if (!group) {
      group = { mid, height, items: [] }
      groups.push(group)
    }
    group.items.push(item)
    group.height = Math.max(group.height, height)
    group.mid =
      group.items.reduce((sum, v) => sum + v.box.y + (v.box.height || 0) / 2, 0) /
      group.items.length
  }

  const mergedLines = groups
    .sort((a, b) => a.mid - b.mid)
    .map((group): OcrTextLine | null => {
      const sorted = group.items.slice().sort((a, b) => a.box.x - b.box.x)
      const text = joinOcrFragments(sorted.map((item) => item.text))
      if (!text) return null
      const firstBox = sorted[0]!.box
      return {
        text,
        box: firstBox,
        confidence: sorted.reduce((sum, item) => sum + (item.confidence ?? 1), 0) / sorted.length
      } satisfies OcrTextLine
    })
  return mergedLines.filter((line): line is OcrTextLine => line !== null)
}

/** @gutenye/ocr-node 实例接口（最小化依赖类型，方便测试注入）。 */
export interface OcrNodeInstance {
  /**
   * 检测图片中的文字。
   * @param imagePath 图片本地路径。
   * @returns 检测结果数组。
   */
  detect(imagePath: string): Promise<PaddleDetectItem[]>
}

/** PaddleOCR 引擎可注入依赖。 */
export interface PaddleOcrDeps {
  /**
   * 写文件到磁盘。
   * @param path 目标路径。
   * @param data 内容。
   */
  writeFile(path: string, data: Buffer): Promise<void>
  /**
   * 删除文件（失败静默忽略）。
   * @param path 目标路径。
   */
  unlink(path: string): Promise<void>
  /** 返回系统临时目录路径。 */
  tmpDir(): string
  /**
   * 动态加载 @gutenye/ocr-node 模块并创建实例。
   * @param options onnxruntime 选项与模型路径。
   * @returns ocr-node 实例。
   */
  createOcrNode(options?: {
    onnxOptions?: { executionProviders?: string[] }
    models?: PaddleOcrModelPaths
  }): Promise<OcrNodeInstance>
}

/** PaddleOCR 引擎创建参数。 */
export interface PaddleOcrEngineOptions extends Partial<PaddleOcrDeps> {
  /** ocr-node 加载的 ONNX 模型路径。 */
  models?: PaddleOcrModelPaths
}

/**
 * 默认 PaddleOCR 依赖：动态 import @gutenye/ocr-node。
 * 若模块未安装，isAvailable() 返回 false，不会抛错。
 * @author zhenghq
 */
async function defaultCreateOcrNode(options?: {
  onnxOptions?: { executionProviders?: string[] }
  models?: PaddleOcrModelPaths
}): Promise<OcrNodeInstance> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = await import('@gutenye/ocr-node' as string) as any
  const Ocr = mod.default ?? mod
  return Ocr.create({
    onnxOptions: { executionProviders: ['cpu'], ...(options?.onnxOptions ?? {}) },
    ...(options?.models ? { models: options.models } : {})
  }) as Promise<OcrNodeInstance>
}

/**
 * PaddleOCR 引擎（@gutenye/ocr-node + onnxruntime-node 链路）。
 * 惰性加载 ocr-node，首次识别时初始化，后续复用实例。
 * @author zhenghq
 */
export class PaddleOcrEngine implements OcrEngine {
  /** 引擎标识。 */
  readonly id = 'paddle' as const

  /** 已初始化的 ocr-node 实例。 */
  private instance: OcrNodeInstance | null = null

  /** 正在初始化的 Promise，防止并发重复初始化。 */
  private loading: Promise<OcrNodeInstance> | null = null

  /** 可注入依赖。 */
  private readonly deps: PaddleOcrDeps

  /** ocr-node 加载的 ONNX 模型路径。 */
  private readonly models?: PaddleOcrModelPaths

  /** 最近一次 runtime 初始化失败原因。 */
  private unavailableReason: string | undefined

  /**
   * 创建 PaddleOCR 引擎。
   * @param options 可注入依赖与模型路径；省略时使用默认值（生产环境）。
   * @author zhenghq
   */
  constructor(options?: PaddleOcrEngineOptions) {
    const { models, ...deps } = options ?? {}
    this.deps = {
      writeFile: async (path, data) => {
        const { writeFile } = await import('node:fs/promises')
        await writeFile(path, data)
      },
      unlink: async (path) => {
        try {
          const { unlink } = await import('node:fs/promises')
          await unlink(path)
        } catch {
          // 静默忽略删除失败
        }
      },
      tmpDir: tmpdir,
      createOcrNode: defaultCreateOcrNode,
      ...deps
    }
    this.models = models
  }

  /**
   * 检查 @gutenye/ocr-node 是否可加载。
   * 首次调用会尝试初始化，失败则返回 false。
   * @returns 是否可用。
   * @author zhenghq
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.getOrCreate()
      this.unavailableReason = undefined
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.unavailableReason = `PaddleOCR runtime 初始化失败: ${message}`
      console.error('[ocr] PaddleOCR runtime 初始化失败:', message)
      return false
    }
  }

  /**
   * 返回 PaddleOCR runtime 最近一次不可用原因。
   * @returns 不可用原因；尚未检测或可用时返回 undefined。
   * @author zhenghq
   */
  getUnavailableReason(): string | undefined {
    return this.unavailableReason
  }

  /**
   * 惰性获取或创建 ocr-node 实例，防止并发重复初始化。
   * @returns ocr-node 实例。
   * @author zhenghq
   */
  private async getOrCreate(): Promise<OcrNodeInstance> {
    if (this.instance) return this.instance
    if (this.loading) return this.loading
    this.loading = this.deps
      .createOcrNode({
        onnxOptions: { executionProviders: ['cpu'] },
        ...(this.models ? { models: this.models } : {})
      })
      .then((inst) => {
        this.instance = inst
        return inst
      })
      .finally(() => {
        this.loading = null
      })
    return this.loading
  }

  /**
   * 使用 @gutenye/ocr-node 识别图片文字。
   * imageBytes 优先于 imagePath；结果经 normalizePaddleLines 规范化后返回。
   * @param input 识别输入。
   * @returns 识别结果。
   * @author zhenghq
   */
  async recognize(input: OcrRecognizeInput): Promise<OcrRecognizeResult> {
    const ocr = await this.getOrCreate()
    const timeoutMs = input.timeoutMs ?? 30000

    let imagePath: string | undefined
    let tempPath: string | undefined

    if (input.imageBytes && input.imageBytes.length > 0) {
      tempPath = join(
        this.deps.tmpDir(),
        `ocr-paddle-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.png`
      )
      await this.deps.writeFile(tempPath, Buffer.from(input.imageBytes))
      imagePath = tempPath
    } else if (input.imagePath) {
      imagePath = input.imagePath
    } else {
      throw new OcrEngineError('empty', 'PaddleOCR 缺少图片输入', 'paddle')
    }

    try {
      const raw = await withOcrTimeout(
        ocr.detect(imagePath),
        { timeoutMs, signal: input.signal },
        'paddle'
      )
      const lines = normalizePaddleLines(raw)
      const text = lines.map((l) => l.text).join('\n')
      return { lines, text, engine: 'paddle' }
    } catch (error) {
      if (error instanceof OcrEngineError) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (/timeout/i.test(message)) {
        throw new OcrEngineError('timeout', 'PaddleOCR 超时', 'paddle')
      }
      throw new OcrEngineError('engine-unavailable', `PaddleOCR 执行失败: ${message}`, 'paddle')
    } finally {
      if (tempPath) {
        await this.deps.unlink(tempPath)
      }
    }
  }
}
