/**
 * 常驻原生取词 helper 宿主：管理 Windows UIA helper 进程的生命周期，
 * 包括惰性启动、stdio 请求/响应配对、连续超时重启、重启失败会话内禁用
 * 与空闲自动退出。macOS 直读由 capture.ts 以单次执行方式调用，
 * 不经过本宿主。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  encodeNativeReaderRequest,
  parseNativeReaderResponseLine,
  NativeReaderRequestMatcher,
  NATIVE_READER_REQUEST_TIMEOUT_MS,
  type NativeReaderResult
} from '../shared/nativeReaderProtocol'
import { translateMain } from './messages'

/** 默认首次超时即回收 helper，避免阻塞的 UIA 请求继续占用后续取词。 */
export const NATIVE_READER_RESTART_AFTER_TIMEOUTS = 1
/** helper 空闲自动退出的时间（毫秒）：5 分钟。 */
export const NATIVE_READER_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/** 宿主可注入的子进程最小接口，便于单元测试替换。 */
export interface NativeReaderChildProcess {
  stdin: { write: (chunk: string) => void } | null
  stdout: { on: (event: 'data', listener: (chunk: Buffer) => void) => void } | null
  kill: () => void
  on: (event: 'exit' | 'error', listener: (...args: unknown[]) => void) => void
}

/** 宿主依赖注入配置。 */
export interface NativeReaderHostOptions {
  /** 启动 helper 子进程；默认按平台解析 helper 路径并 spawn。 */
  spawn?: () => NativeReaderChildProcess
  /** 单次请求超时（毫秒）。 */
  requestTimeoutMs?: number
  /** 连续超时多少次后重启 helper。 */
  restartAfterTimeouts?: number
  /** 空闲自动退出时间（毫秒）。 */
  idleTimeoutMs?: number
  /** 时间源，便于测试快进空闲时间。 */
  now?: () => number
}

/**
 * 解析 Windows UIA helper 的可执行文件路径：优先打包产物，其次仓库内预编译 exe。
 * @param resourcesPath 打包后的 resources 目录（开发环境传 undefined）。
 * @returns helper 可执行文件路径；不存在时返回 null。
 * @author zhenghq
 */
export function resolveWindowsUiaReaderPath(resourcesPath?: string): string | null {
  const candidates = [
    resourcesPath ? join(resourcesPath, 'windows-uia-reader.exe') : null,
    join(__dirname, '..', '..', 'helpers', 'windows-uia-reader', 'windows-uia-reader.exe'),
    join(process.cwd(), 'helpers', 'windows-uia-reader', 'windows-uia-reader.exe')
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/** macOS AX helper 路径解析选项，便于单元测试注入。 */
export interface MacosAxReaderPathOptions {
  /** 打包后的 resources 目录；开发环境传 undefined。 */
  resourcesPath?: string
  /** 仓库根目录；默认取 process.cwd()。 */
  cwd?: string
  /** 文件存在性判断，默认使用 fs.existsSync。 */
  fileExists?: (candidate: string) => boolean
}

/**
 * 解析 macOS AX helper 的可执行文件路径：打包环境优先 resourcesPath，
 * 开发环境回退仓库 build 目录，均不存在时返回 null 让取词管线降级。
 * @param options 路径解析选项，可注入 resourcesPath、cwd 与文件存在性判断。
 * @returns helper 可执行文件绝对路径；不存在时返回 null。
 * @author zhenghq
 */
export function resolveMacosAxReaderPath(options?: MacosAxReaderPathOptions): string | null {
  const fileExists = options?.fileExists ?? existsSync
  const cwd = options?.cwd ?? process.cwd()
  const resourcesPath = options?.resourcesPath
  const candidates = [
    resourcesPath ? join(resourcesPath, 'macos-ax-reader') : null,
    join(cwd, 'build', 'macos-ax-reader')
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find((candidate) => fileExists(candidate)) ?? null
}

/**
 * 常驻原生取词 helper 宿主。
 * @author zhenghq
 */
export class NativeReaderHost {
  private child: NativeReaderChildProcess | null = null
  private readonly matcher = new NativeReaderRequestMatcher()
  private nextRequestId = 1
  private stdoutBuffer = ''
  private stdoutDecoder = new StringDecoder('utf8')
  private consecutiveTimeouts = 0
  /** 哨兵 -1 表示尚未发生过任何活动，避免与 now() 返回 0 冲突。 */
  private lastActivityAt = -1
  private disabled = false
  private restarting: Promise<boolean> | null = null

  private readonly spawnFn: () => NativeReaderChildProcess
  private readonly requestTimeoutMs: number
  private readonly restartAfterTimeouts: number
  private readonly idleTimeoutMs: number
  private readonly now: () => number

  /**
   * 创建 helper 宿主；进程惰性启动，首次请求时才拉起。
   * @param options 依赖注入配置。
   * @author zhenghq
   */
  constructor(options: NativeReaderHostOptions = {}) {
    this.spawnFn = options.spawn ?? (() => defaultSpawnWindowsUiaReader())
    this.requestTimeoutMs = options.requestTimeoutMs ?? NATIVE_READER_REQUEST_TIMEOUT_MS
    this.restartAfterTimeouts = options.restartAfterTimeouts ?? NATIVE_READER_RESTART_AFTER_TIMEOUTS
    this.idleTimeoutMs = options.idleTimeoutMs ?? NATIVE_READER_IDLE_TIMEOUT_MS
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * 向 helper 发起一次选区直读。
   * @param signal 请求取消信号；取消时回收正在执行 UIA 的进程。
   * @param timeoutMs 单次请求预算，默认使用宿主配置。
   * @returns 直读结果；helper 不可用或被禁用时返回 unknown 并带降级原因。
   * @author zhenghq
   */
  async readSelection(
    signal?: AbortSignal,
    timeoutMs = this.requestTimeoutMs
  ): Promise<NativeReaderResult> {
    if (signal?.aborted) throw new Error('native reader request aborted')
    if (this.disabled) {
      return { status: 'unknown', reason: 'helper-disabled' }
    }

    const child = await this.ensureChild()
    if (signal?.aborted) throw new Error('native reader request aborted')
    // spawn 后到 await 继续之间可能已 exit、dispose 或换代，不能向旧 stdin 发请求。
    if (child && (this.disabled || this.child !== child)) {
      throw new Error('native reader helper exited before request')
    }
    if (!child) {
      return { status: 'unknown', reason: 'helper-disabled' }
    }

    const id = this.nextRequestId
    this.nextRequestId += 1
    const pending = this.matcher.track(id, timeoutMs)
    /**
     * 中止本代原生调用并释放全部等待者，防止过期 UIA 继续排队。
     * @returns 无返回值。
     * @author zhenghq
     */
    const handleAbort = (): void => {
      if (this.child === child) this.killChild(new Error('native reader request aborted'))
    }
    signal?.addEventListener('abort', handleAbort, { once: true })
    try {
      child.stdin?.write(encodeNativeReaderRequest({ id, method: 'readSelection' }))
    } catch (error) {
      this.matcher.rejectAll(error instanceof Error ? error : new Error(String(error)))
    }

    try {
      const result = await pending
      if (this.child === child) {
        this.consecutiveTimeouts = 0
        this.lastActivityAt = this.now()
      }
      return result
    } catch (error) {
      if (this.child === child) this.lastActivityAt = this.now()
      if (this.child === child && error instanceof Error && /timeout/iu.test(error.message)) {
        this.consecutiveTimeouts += 1
        if (this.consecutiveTimeouts >= this.restartAfterTimeouts) {
          await this.restart()
        }
      }
      throw error
    } finally {
      signal?.removeEventListener('abort', handleAbort)
    }
  }

  /**
   * 释放宿主：终止 helper 进程并拒绝全部待定请求。
   * @returns 无返回值。
   * @author zhenghq
   */
  dispose(): void {
    this.killChild(new Error('native reader host disposed'))
    this.disabled = true
  }

  /**
   * 确保 helper 进程可用：空闲超时先退出旧进程，必要时惰性启动。
   * @returns 可用的子进程；重启失败或禁用后返回 null。
   * @author zhenghq
   */
  private async ensureChild(): Promise<NativeReaderChildProcess | null> {
    if (this.disabled) return null

    if (this.child && this.matcher.pendingCount === 0 && this.idleTimeoutMs > 0 &&
        this.lastActivityAt >= 0 &&
        this.now() - this.lastActivityAt > this.idleTimeoutMs) {
      this.killChild()
    }

    if (this.child) return this.child
    return this.spawnChild()
  }

  /**
   * 启动新的 helper 进程并接管其 stdout 响应流。
   * @returns 启动成功的子进程；启动即失败时禁用宿主并返回 null。
   * @author zhenghq
   */
  private spawnChild(): NativeReaderChildProcess | null {
    let child: NativeReaderChildProcess
    try {
      child = this.spawnFn()
    } catch {
      this.disabled = true
      return null
    }

    this.child = child
    this.stdoutBuffer = ''
    this.stdoutDecoder = new StringDecoder('utf8')
    child.on('error', (error) => {
      if (this.child !== child) return
      this.disabled = true
      this.killChild(error instanceof Error ? error : new Error('native reader helper error'))
    })
    child.on('exit', () => {
      // kill 的 exit 异步到达；只能处理当前代，不能拒绝新进程的请求。
      if (this.child !== child) return
      this.child = null
      this.disabled = true
      this.stdoutBuffer = ''
      this.matcher.rejectAll(new Error('native reader helper exited'))
    })
    child.stdout?.on('data', (chunk) => {
      if (this.child === child) this.handleStdout(chunk)
    })
    this.lastActivityAt = this.now()
    return child
  }

  /**
   * 处理 helper stdout 数据：按行切分并配对响应。
   * @param chunk stdout 数据块。
   * @returns 无返回值。
   * @author zhenghq
   */
  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += this.stdoutDecoder.write(chunk)
    const lines = this.stdoutBuffer.split(/\r?\n/u)
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const response = parseNativeReaderResponseLine(line)
      if (response) this.matcher.resolve(response)
    }
  }

  /**
   * 重启 helper：终止旧进程后重新启动；失败时本次会话禁用。
   * @returns 重启是否成功。
   * @author zhenghq
   */
  private async restart(): Promise<boolean> {
    this.restarting ??= (async () => {
      this.consecutiveTimeouts = 0
      this.killChild()
      const child = this.spawnChild()
      return child !== null
    })()
    try {
      return await this.restarting
    } finally {
      this.restarting = null
    }
  }

  /**
   * 终止当前 helper 进程（若存在）。
   * @param error 用于结束本代待定请求的错误。
   * @returns 无返回值。
   * @author zhenghq
   */
  private killChild(error = new Error('native reader helper recycled')): void {
    const child = this.child
    this.child = null
    if (!child) return
    this.matcher.rejectAll(error)
    this.stdoutBuffer = ''
    this.stdoutDecoder = new StringDecoder('utf8')
    this.lastActivityAt = -1
    try {
      child.kill()
    } catch {
      // 进程已退出时忽略 kill 异常。
    }
  }
}

/**
 * 默认的 Windows UIA helper 启动实现。
 * @returns 启动的 helper 子进程。
 * @author zhenghq
 */
function defaultSpawnWindowsUiaReader(): NativeReaderChildProcess {
  const resourcesPath = process.resourcesPath as string | undefined
  const helperPath = resolveWindowsUiaReaderPath(resourcesPath)
  if (!helperPath) {
    throw new Error(translateMain('capture.error.nativeReaderHelperMissing'))
  }
  const child: ChildProcess = spawn(helperPath, [], { windowsHide: true })
  return {
    stdin: child.stdin,
    stdout: child.stdout
      ? { on: (event, listener) => child.stdout!.on(event, listener) }
      : null,
    kill: () => child.kill(),
    on: (event, listener) => child.on(event, listener)
  }
}
