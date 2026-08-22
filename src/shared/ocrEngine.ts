import type { OcrEngineId, OcrErrorCode, OcrTextLine } from './types'

/** OCR 引擎识别输入：图片字节或路径二选一。 */
export interface OcrRecognizeInput {
  /** PNG/JPEG 等图片字节；优先于路径。 */
  imageBytes?: Uint8Array | Buffer
  /** 图片本地路径。 */
  imagePath?: string
  /** OCR 语言偏好，如 auto / zh / en。 */
  language?: string
  /** 取消信号，弹窗关闭或请求失效时中止。 */
  signal?: AbortSignal
  /** 超时毫秒数；缺省表示不额外施加超时。 */
  timeoutMs?: number
}

/** OCR 引擎识别结果。 */
export interface OcrRecognizeResult {
  /** 识别出的文本行。 */
  lines: OcrTextLine[]
  /** 拼接后的原文（未清洗）。 */
  text: string
  /** 实际产出结果的引擎。 */
  engine: OcrEngineId
}

/**
 * OCR 引擎抽象接口：输入图片字节或路径，输出文本行。
 * 各具体引擎（系统/Paddle/Tesseract）均实现此接口，统一超时与取消语义。
 */
export interface OcrEngine {
  /** 引擎标识。 */
  readonly id: OcrEngineId
  /**
   * 当前环境是否可用（平台、模型、运行时是否就绪）。
   * @returns 是否可用。
   */
  isAvailable(): Promise<boolean> | boolean
  /**
   * 返回引擎不可用的具体原因，用于状态展示和调度错误诊断。
   * @returns 不可用原因；可用或未知时返回 undefined。
   */
  getUnavailableReason?(): string | undefined
  /**
   * 识别图片中的文字。
   * @param input 识别输入。
   * @returns 识别结果。
   */
  recognize(input: OcrRecognizeInput): Promise<OcrRecognizeResult>
}

/** OCR 引擎执行错误，携带细分错误码。 */
export class OcrEngineError extends Error {
  /** 错误分类码。 */
  readonly code: OcrErrorCode
  /** 出错的引擎，可选。 */
  readonly engine?: OcrEngineId

  /**
   * 创建 OCR 引擎错误。
   * @param code 错误分类码。
   * @param message 面向调用方的描述。
   * @param engine 出错的引擎。
   * @author zhenghq
   */
  constructor(code: OcrErrorCode, message: string, engine?: OcrEngineId) {
    super(message)
    this.name = 'OcrEngineError'
    this.code = code
    this.engine = engine
  }
}

/**
 * 将 OCR 文本行按包围盒重建为段落：先按 Y 分行，同近似行内按 X 排序后以空格拼接，行间换行。
 * @param lines 文本行。
 * @returns 拼接后的原文；无行时返回空字符串。
 * @author zhenghq
 */
export function joinOcrLines(lines: OcrTextLine[]): string {
  if (!Array.isArray(lines) || lines.length === 0) return ''
  const sorted = [...lines].sort((a, b) => {
    const ay = a.box?.y ?? Number.POSITIVE_INFINITY
    const by = b.box?.y ?? Number.POSITIVE_INFINITY
    if (ay !== by) return ay - by
    const ax = a.box?.x ?? Number.POSITIVE_INFINITY
    const bx = b.box?.x ?? Number.POSITIVE_INFINITY
    return ax - bx
  })

  const rows: OcrTextLine[][] = []
  for (const line of sorted) {
    const text = String(line.text || '').trim()
    if (!text) continue
    const y = line.box?.y
    const last = rows[rows.length - 1]
    if (!last) {
      rows.push([line])
      continue
    }
    const lastY = last[0]?.box?.y
    const sameRow = y !== undefined && lastY !== undefined && Math.abs(y - lastY) <= 8
    if (sameRow) last.push(line)
    else rows.push([line])
  }

  return rows
    .map((row) => row
      .slice()
      .sort((a, b) => (a.box?.x ?? 0) - (b.box?.x ?? 0))
      .map((item) => String(item.text || '').trim())
      .filter(Boolean)
      .join(' '))
    .filter(Boolean)
    .join('\n')
}

/**
 * 校验识别输入至少包含图片字节或路径。
 * @param input 识别输入。
 * @param engine 出错时标注的引擎。
 * @returns 规范化后的输入快照。
 * @author zhenghq
 */
export function normalizeOcrRecognizeInput(
  input: OcrRecognizeInput,
  engine?: OcrEngineId
): OcrRecognizeInput {
  const hasBytes = Boolean(input.imageBytes && input.imageBytes.length > 0)
  const hasPath = typeof input.imagePath === 'string' && input.imagePath.trim() !== ''
  if (!hasBytes && !hasPath) {
    throw new OcrEngineError('engine-unavailable', 'OCR 请求缺少图片字节或路径', engine)
  }
  if (input.signal?.aborted) {
    throw new OcrEngineError('timeout', 'OCR 请求已取消', engine)
  }
  const timeoutMs = input.timeoutMs
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new OcrEngineError('timeout', 'OCR 超时时间必须为正数', engine)
  }
  return {
    imageBytes: hasBytes ? input.imageBytes : undefined,
    imagePath: hasPath ? input.imagePath!.trim() : undefined,
    language: typeof input.language === 'string' && input.language.trim()
      ? input.language.trim()
      : 'auto',
    signal: input.signal,
    timeoutMs
  }
}

/**
 * 为异步 OCR 任务套统一超时与取消语义：超时或取消时抛出 OcrEngineError。
 * @param task 实际识别任务。
 * @param options 超时与取消配置。
 * @param engine 出错时标注的引擎。
 * @returns 任务结果。
 * @author zhenghq
 */
export async function withOcrTimeout<T>(
  task: Promise<T>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
  engine?: OcrEngineId
): Promise<T> {
  const { timeoutMs, signal } = options
  if (signal?.aborted) {
    throw new OcrEngineError('timeout', 'OCR 请求已取消', engine)
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined

  try {
    const timeoutPromise = timeoutMs === undefined
      ? null
      : new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new OcrEngineError('timeout', `OCR 识别超时（${timeoutMs}ms）`, engine))
        }, timeoutMs)
      })

    const abortPromise = signal
      ? new Promise<T>((_, reject) => {
        onAbort = (): void => {
          reject(new OcrEngineError('timeout', 'OCR 请求已取消', engine))
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
      : null

    const racers: Array<Promise<T>> = [task]
    if (timeoutPromise) racers.push(timeoutPromise)
    if (abortPromise) racers.push(abortPromise)
    return await Promise.race(racers)
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 调用 OCR 引擎并统一应用输入校验、超时与取消语义。
 * @param engine 引擎实例。
 * @param input 识别输入。
 * @returns 识别结果。
 * @author zhenghq
 */
export async function recognizeWithTimeout(
  engine: OcrEngine,
  input: OcrRecognizeInput
): Promise<OcrRecognizeResult> {
  const normalized = normalizeOcrRecognizeInput(input, engine.id)
  return withOcrTimeout(
    engine.recognize(normalized),
    { timeoutMs: normalized.timeoutMs, signal: normalized.signal },
    engine.id
  )
}
