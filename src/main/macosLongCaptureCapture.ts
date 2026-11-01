/**
 * macOS 长截图常驻抓帧客户端。
 *
 * helper 使用二进制安全的 stdio 协议，避免每个采样周期冷启动 screencapture：
 *   capture <x> <y> <width> <height>\n
 *   ok <pngByteLength>\n<png bytes>
 *   err <utf8ByteLength>\n<utf8 bytes>
 *
 * 请求严格串行；进程崩溃时拒绝当前请求并允许下一次请求重新拉起。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CaptureBounds } from './screenCapture'

/** helper 单次抓帧默认超时（毫秒）。 */
export const MACOS_LONG_CAPTURE_REQUEST_TIMEOUT_MS = 5000
/** helper 单行响应头最大长度，防止异常输出无限占用内存。 */
const MAX_RESPONSE_HEADER_BYTES = 1024
/** helper 单帧 PNG 最大字节数，避免错误长度导致异常内存分配。 */
const MAX_CAPTURE_BYTES = 256 * 1024 * 1024

/** 可注入的 helper 子进程接口。 */
export interface MacosLongCaptureChildProcess {
  /** helper stdin；关闭后表示进程不可再用。 */
  stdin: { write: (chunk: Buffer | string) => boolean } | null
  /** helper stdout。 */
  stdout: { on: (event: 'data', listener: (chunk: Buffer) => void) => void } | null
  /** 终止 helper。 */
  kill: () => void
  /** 监听进程错误或退出。 */
  on: (event: 'error' | 'exit', listener: (...args: unknown[]) => void) => void
}

/** 常驻抓帧客户端依赖。 */
export interface MacosLongCaptureCaptureOptions {
  /** helper 可执行文件路径；未提供时自动解析。 */
  helperPath?: string
  /** 打包后的 resources 目录。 */
  resourcesPath?: string
  /** 开发环境仓库根目录。 */
  cwd?: string
  /** 文件存在性判断，便于测试。 */
  fileExists?: (candidate: string) => boolean
  /** 子进程启动函数，便于测试。 */
  spawn?: (helperPath: string) => MacosLongCaptureChildProcess
  /** 单次请求超时。 */
  requestTimeoutMs?: number
}

/** 常驻抓帧客户端。 */
export interface MacosLongCaptureCapture {
  /**
   * 采集指定全局逻辑坐标区域。
   * @param bounds 全局屏幕坐标下的矩形。
   * @returns PNG 图片字节。
   */
  capture(bounds: CaptureBounds): Promise<Buffer>
  /** 关闭 helper 并拒绝未完成请求。 */
  dispose(): void
}

/** 当前待定请求。 */
interface PendingCapture {
  /** 完成请求。 */
  resolve: (png: Buffer) => void
  /** 拒绝请求。 */
  reject: (error: Error) => void
  /** 超时定时器。 */
  timer: ReturnType<typeof setTimeout>
}

/**
 * 解析 macOS 长截图 helper 路径：打包环境优先 resourcesPath，开发环境回退 build 目录。
 * @param options 路径解析选项。
 * @returns helper 绝对路径；不存在时返回 null。
 * @author zhenghq
 */
export function resolveMacosLongCaptureHelperPath(options?: {
  resourcesPath?: string
  cwd?: string
  fileExists?: (candidate: string) => boolean
}): string | null {
  const fileExists = options?.fileExists ?? existsSync
  const cwd = options?.cwd ?? process.cwd()
  const candidates = [
    options?.resourcesPath ? join(options.resourcesPath, 'macos-long-capture') : null,
    join(cwd, 'build', 'macos-long-capture')
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find(fileExists) ?? null
}

/**
 * 创建 macOS 长截图常驻抓帧客户端。
 * @param options 路径、超时与子进程依赖。
 * @returns 常驻抓帧客户端；helper 不存在时 capture 会明确拒绝。
 * @author zhenghq
 */
export function createMacosLongCaptureCapture(
  options: MacosLongCaptureCaptureOptions = {}
): MacosLongCaptureCapture {
  const helperPath = options.helperPath ?? resolveMacosLongCaptureHelperPath(options)
  const requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? MACOS_LONG_CAPTURE_REQUEST_TIMEOUT_MS)
  const spawnFn = options.spawn ?? defaultSpawn
  let child: MacosLongCaptureChildProcess | null = null
  let pending: PendingCapture | null = null
  let stdoutBuffer = Buffer.alloc(0)
  let expectedPayloadBytes: number | null = null
  let responseKind: 'ok' | 'err' | null = null
  let disposed = false
  /** 串行化请求，避免上一帧未完成时覆盖 stdout 状态。 */
  let queue: Promise<void> = Promise.resolve()

  /**
   * 清理当前请求与子进程，并把失败原因交给调用方。
   * @param error 失败原因。
   * @param killChild 是否同时终止 helper。
   * @returns 无返回值。
   * @author zhenghq
   */
  const failPending = (error: Error, killChild: boolean): void => {
    const current = pending
    pending = null
    stdoutBuffer = Buffer.alloc(0)
    expectedPayloadBytes = null
    responseKind = null
    if (current) {
      clearTimeout(current.timer)
      current.reject(error)
    }
    if (killChild) {
      const active = child
      child = null
      if (active) {
        try {
          active.kill()
        } catch {
          // helper 已退出时忽略 kill 异常。
        }
      }
    }
  }

  /**
   * 启动 helper 并接管 stdout 数据。
   * @returns 可用子进程；启动失败时返回 null。
   * @author zhenghq
   */
  const ensureChild = (): MacosLongCaptureChildProcess | null => {
    if (disposed) return null
    if (child) return child
    if (!helperPath) return null
    let next: MacosLongCaptureChildProcess
    try {
      next = spawnFn(helperPath)
    } catch {
      return null
    }
    child = next
    stdoutBuffer = Buffer.alloc(0)
    expectedPayloadBytes = null
    responseKind = null
    next.on('error', () => {
      if (child === next) failPending(new Error('macOS long capture helper error'), true)
    })
    next.on('exit', () => {
      if (child === next) failPending(new Error('macOS long capture helper exited'), true)
    })
    next.stdout?.on('data', (chunk) => handleStdout(chunk))
    return next
  }

  /**
   * 解析响应头并返回已消费字节数；头部不完整时返回 null。
   * @param buffer 当前 stdout 累积数据。
   * @returns 解析结果或 null。
   * @author zhenghq
   */
  const parseHeader = (buffer: Buffer): { kind: 'ok' | 'err'; length: number; headerBytes: number } | null => {
    const newline = buffer.indexOf(0x0a)
    if (newline < 0) {
      if (buffer.length > MAX_RESPONSE_HEADER_BYTES) {
        failPending(new Error('macOS long capture helper response header too long'), true)
      }
      return null
    }
    const line = buffer.subarray(0, newline).toString('utf8').trim()
    const match = /^(ok|err) ([0-9]+)$/u.exec(line)
    if (!match) {
      failPending(new Error('macOS long capture helper returned an invalid response'), true)
      return null
    }
    const length = Number(match[2])
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CAPTURE_BYTES) {
      failPending(new Error('macOS long capture helper returned an invalid payload length'), true)
      return null
    }
    return { kind: match[1] as 'ok' | 'err', length, headerBytes: newline + 1 }
  }

  /**
   * 处理 stdout 分包，按头部长度精确读取 PNG 或错误文本。
   * @param chunk helper 输出数据块。
   * @returns 无返回值。
   * @author zhenghq
   */
  const handleStdout = (chunk: Buffer): void => {
    if (!pending || !chunk.length) return
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk])
    if (expectedPayloadBytes === null) {
      const header = parseHeader(stdoutBuffer)
      if (!header) return
      responseKind = header.kind
      expectedPayloadBytes = header.length
      stdoutBuffer = stdoutBuffer.subarray(header.headerBytes)
    }
    if (expectedPayloadBytes === null || stdoutBuffer.length < expectedPayloadBytes) return
    const payload = stdoutBuffer.subarray(0, expectedPayloadBytes)
    const current = pending
    const kind = responseKind
    pending = null
    clearTimeout(current.timer)
    stdoutBuffer = Buffer.alloc(0)
    expectedPayloadBytes = null
    responseKind = null
    if (kind === 'err' || payload.length === 0) {
      current.reject(new Error(payload.length > 0 ? payload.toString('utf8') : 'macOS long capture helper returned an empty image'))
      return
    }
    current.resolve(Buffer.from(payload))
  }

  /**
   * 执行一次真正抓帧请求；调用方已保证串行。
   * @param bounds 全局逻辑坐标矩形。
   * @returns PNG 图片字节。
   * @author zhenghq
   */
  const executeCapture = (bounds: CaptureBounds): Promise<Buffer> => {
    if (disposed) return Promise.reject(new Error('macOS long capture client disposed'))
    if (!helperPath) return Promise.reject(new Error('macOS long capture helper not found'))
    const active = ensureChild()
    if (!active?.stdin) return Promise.reject(new Error('macOS long capture helper unavailable'))
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        failPending(new Error('macOS long capture request timeout'), true)
      }, requestTimeoutMs)
      pending = { resolve, reject, timer }
      const rect = [
        Math.round(bounds.x),
        Math.round(bounds.y),
        Math.max(1, Math.round(bounds.width)),
        Math.max(1, Math.round(bounds.height))
      ].join(' ')
      try {
        active.stdin?.write(`capture ${rect}\n`)
      } catch (error) {
        failPending(error instanceof Error ? error : new Error(String(error)), true)
      }
    })
  }

  return {
    capture(bounds) {
      const request = queue.then(() => executeCapture(bounds))
      queue = request.then(() => undefined, () => undefined)
      return request
    },
    dispose() {
      disposed = true
      failPending(new Error('macOS long capture client disposed'), true)
    }
  }
}

/**
 * 默认 helper 启动实现。
 * @param helperPath helper 绝对路径。
 * @returns 子进程接口。
 * @author zhenghq
 */
function defaultSpawn(helperPath: string): MacosLongCaptureChildProcess {
  const child: ChildProcess = spawn(helperPath, [], {
    stdio: ['pipe', 'pipe', 'ignore']
  })
  return {
    stdin: child.stdin,
    stdout: child.stdout
      ? { on: (event, listener) => child.stdout!.on(event, listener) }
      : null,
    kill: () => child.kill(),
    on: (event, listener) => child.on(event, listener)
  }
}
