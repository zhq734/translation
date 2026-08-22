import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  OcrEngineError,
  withOcrTimeout,
  type OcrEngine,
  type OcrRecognizeInput,
  type OcrRecognizeResult
} from '../shared/ocrEngine'
import { normalizePaddleLines, type PaddleDetectItem } from './paddleOcr'

/**
 * PaddleOCR-json 进程适配可注入依赖。
 * @author zhenghq
 */
export interface PaddleOcrFallbackDeps {
  /**
   * 检查可执行文件是否存在于 PATH 或指定路径。
   * @param executable 可执行文件名或路径。
   * @returns 是否可用。
   */
  checkExecutable(executable: string): Promise<boolean>
  /**
   * 启动子进程并执行命令。
   * @param executable 可执行文件。
   * @param args 参数。
   * @param options 选项。
   * @returns stdout/stderr 字符串。
   */
  execFile(
    executable: string,
    args: string[],
    options?: { timeout?: number; signal?: AbortSignal }
  ): Promise<{ stdout: string; stderr: string }>
  /**
   * 写临时文件。
   * @param path 路径。
   * @param data 内容。
   */
  writeFile(path: string, data: Buffer): Promise<void>
  /**
   * 删除临时文件（失败静默忽略）。
   * @param path 路径。
   */
  unlink(path: string): Promise<void>
  /** 返回系统临时目录。 */
  tmpDir(): string
  /** PaddleOCR-json 可执行文件名或绝对路径，默认 'paddleocr-json'。 */
  executable?: string
}

/**
 * 默认 execFile 实现。
 * @param executable 可执行文件。
 * @param args 参数列表。
 * @param options 选项。
 * @returns stdout/stderr。
 * @author zhenghq
 */
async function defaultExecFile(
  executable: string,
  args: string[],
  options?: { timeout?: number; signal?: AbortSignal }
): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileP = promisify(execFile)
  const result = await execFileP(executable, args, {
    timeout: options?.timeout,
    signal: options?.signal,
    maxBuffer: 1024 * 1024 * 4,
    encoding: 'utf8'
  } as Parameters<typeof execFileP>[2])
  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? '')
  }
}

/**
 * 检查可执行文件是否在 PATH 中可用。
 * @param executable 可执行文件名或路径。
 * @returns 是否可用。
 * @author zhenghq
 */
async function defaultCheckExecutable(executable: string): Promise<boolean> {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileP = promisify(execFile)
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    await execFileP(cmd, [executable], { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

/**
 * PaddleOCR-json 进程适配引擎（备选方案）。
 *
 * 仅在 onnxruntime 链路（@gutenye/ocr-node）不可用时考虑启用。
 * 已知限制：PaddleOCR-json v1.4.1 不支持 PP-OCRv6_tiny 的 PIR 格式；
 * 需用户自行安装兼容版本的 PaddleOCR-json 可执行文件。
 * @author zhenghq
 */
export class PaddleOcrFallbackEngine implements OcrEngine {
  /** 引擎标识。 */
  readonly id = 'paddle' as const

  /** 可注入依赖。 */
  private readonly deps: Required<PaddleOcrFallbackDeps>

  /** 可用性缓存，避免重复检测。 */
  private availableCache: boolean | null = null

  /**
   * 创建 PaddleOCR-json 备选引擎。
   * @param deps 可注入依赖；省略时使用默认值。
   * @author zhenghq
   */
  constructor(deps?: Partial<PaddleOcrFallbackDeps>) {
    this.deps = {
      checkExecutable: defaultCheckExecutable,
      execFile: defaultExecFile,
      writeFile: async (path, data) => {
        const { writeFile } = await import('node:fs/promises')
        await writeFile(path, data)
      },
      unlink: async (path) => {
        try {
          const { unlink } = await import('node:fs/promises')
          await unlink(path)
        } catch { /* 静默忽略 */ }
      },
      tmpDir: tmpdir,
      executable: 'paddleocr-json',
      ...deps
    }
  }

  /**
   * 检查 paddleocr-json 可执行文件是否在 PATH 中可用。
   * 结果缓存，避免重复检测。
   * @returns 是否可用。
   * @author zhenghq
   */
  async isAvailable(): Promise<boolean> {
    if (this.availableCache !== null) return this.availableCache
    this.availableCache = await this.deps.checkExecutable(this.deps.executable)
    return this.availableCache
  }

  /**
   * 调用 paddleocr-json 进程识别图片文字。
   * 输入图片字节时先写临时文件，识别完毕后删除。
   * @param input 识别输入（图片字节或路径）。
   * @returns 识别结果。
   * @author zhenghq
   */
  async recognize(input: OcrRecognizeInput): Promise<OcrRecognizeResult> {
    const available = await this.isAvailable()
    if (!available) {
      throw new OcrEngineError(
        'engine-unavailable',
        'PaddleOCR-json 可执行文件未找到，请先安装并确保在 PATH 中',
        'paddle'
      )
    }

    const timeoutMs = input.timeoutMs ?? 30000
    let imagePath: string | undefined
    let tempPath: string | undefined

    if (input.imageBytes && input.imageBytes.length > 0) {
      tempPath = join(
        this.deps.tmpDir(),
        `ocr-paddle-fb-${process.pid}-${Date.now()}.png`
      )
      await this.deps.writeFile(tempPath, Buffer.from(input.imageBytes))
      imagePath = tempPath
    } else if (input.imagePath) {
      imagePath = input.imagePath
    } else {
      throw new OcrEngineError('empty', 'PaddleOCR-json 缺少图片输入', 'paddle')
    }

    try {
      const { stdout, stderr } = await withOcrTimeout(
        this.deps.execFile(
          this.deps.executable,
          ['--image', imagePath],
          { timeout: timeoutMs, signal: input.signal }
        ),
        { timeoutMs, signal: input.signal },
        'paddle'
      )

      if (stderr?.includes('No Windows OCR')) {
        throw new OcrEngineError('engine-unavailable', 'PaddleOCR-json 不可用', 'paddle')
      }

      // 尝试解析 JSON 行格式输出
      const rawLines: PaddleDetectItem[] = []
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        try {
          const parsed = JSON.parse(trimmed)
          if (Array.isArray(parsed)) {
            rawLines.push(...(parsed as PaddleDetectItem[]))
          } else if (parsed && typeof parsed === 'object' && parsed.text) {
            rawLines.push(parsed as PaddleDetectItem)
          }
        } catch {
          // 非 JSON 行按纯文本处理
          if (trimmed) rawLines.push({ text: trimmed })
        }
      }

      const lines = normalizePaddleLines(rawLines)
      const text = lines.map((l) => l.text).join('\n')
      return { lines, text, engine: 'paddle' }
    } catch (error) {
      if (error instanceof OcrEngineError) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (/timeout/i.test(message)) {
        throw new OcrEngineError('timeout', 'PaddleOCR-json 超时', 'paddle')
      }
      throw new OcrEngineError(
        'engine-unavailable',
        `PaddleOCR-json 执行失败: ${message}`,
        'paddle'
      )
    } finally {
      if (tempPath) await this.deps.unlink(tempPath)
    }
  }
}
