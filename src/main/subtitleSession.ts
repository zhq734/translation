import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  encodeSubtitleSidecarCommand,
  isAudioSource,
  mergeSubtitleSegments,
  parseSubtitleSidecarLine,
  type RealtimeSubtitleAudioSource,
  type RealtimeSubtitleAudioActivity,
  type RealtimeSubtitleAsrProvider,
  type RealtimeSubtitleDisplayMode,
  type RealtimeSubtitleSegment,
  type RealtimeSubtitleSessionState,
  type RealtimeSubtitleSnapshot,
  type SubtitleSidecarEvent
} from '../shared/subtitleSession'
import { translateMain } from './messages'

/** 宿主可注入的 sidecar 子进程最小接口。 */
export interface SubtitleSessionChildProcess {
  /** sidecar 标准输入；进程已退出时可能为 null。 */
  stdin: { write: (chunk: string) => void } | null
  /** sidecar 标准输出。 */
  stdout: { on: (event: 'data', listener: (chunk: Buffer) => void) => void } | null
  /** sidecar 标准错误，仅用于诊断，不直接展示给用户。 */
  stderr?: { on: (event: 'data', listener: (chunk: Buffer) => void) => void } | null
  /** 终止 sidecar。 */
  kill: () => void
  /** 订阅退出或启动错误。 */
  on: (event: 'exit' | 'error', listener: (...args: unknown[]) => void) => void
}

/** sidecar 路径解析选项。 */
export interface MacosSubtitleAudioPathOptions {
  /** 打包后的 resources 目录。 */
  resourcesPath?: string
  /** 仓库根目录，默认取 process.cwd()。 */
  cwd?: string
  /** 文件存在性判断，便于单元测试注入。 */
  fileExists?: (candidate: string) => boolean
}

/** 实时字幕宿主依赖。 */
export interface SubtitleSessionHostOptions {
  /** 启动 sidecar；默认按平台解析并 spawn。 */
  spawn?: (environment: NodeJS.ProcessEnv) => SubtitleSessionChildProcess
  /** 接收 sidecar 事件及其所属会话代次。 */
  onEvent: (event: SubtitleSidecarEvent, generation: number) => void
  /** 接收会话状态变化。 */
  onStateChange?: (state: RealtimeSubtitleSessionState) => void
  /** 读取当前显示模式，用于状态快照。 */
  getDisplayMode?: () => RealtimeSubtitleDisplayMode
  /** 启动超时毫秒数；超时后终止 sidecar 并提示检查系统权限。 */
  startupTimeoutMs?: number
  /** 主进程诊断日志接收器；默认写入 console。 */
  log?: (message: string) => void
}

/** 一次实时字幕启动参数。 */
export interface SubtitleSessionStartOptions {
  /** 音频来源。 */
  source: RealtimeSubtitleAudioSource
  /** 实时 ASR 提供商。 */
  asr: RealtimeSubtitleAsrProvider
  /** 语音识别语言。 */
  language: string
  /** Deepgram API Key；只允许注入 sidecar 环境，不进入 stdio 协议。 */
  deepgramApiKey?: string | null
}

/**
 * 解析 macOS 实时字幕 sidecar 路径：打包目录优先，开发环境回退 build 目录。
 * @param options 路径解析选项。
 * @returns 可执行文件路径；均不存在时返回 null。
 * @author zhenghq
 */
export function resolveMacosSubtitleAudioPath(
  options: MacosSubtitleAudioPathOptions = {}
): string | null {
  const fileExists = options.fileExists ?? existsSync
  const cwd = options.cwd ?? process.cwd()
  const candidates = [
    options.resourcesPath ? join(options.resourcesPath, 'macos-subtitle-audio') : null,
    join(cwd, 'build', 'macos-subtitle-audio')
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find((candidate) => fileExists(candidate)) ?? null
}

/**
 * 默认 sidecar 启动实现。
 * @param environment 已经完成敏感变量隔离的子进程环境。
 * @returns 已启动的子进程适配器。
 * @author zhenghq
 */
function defaultSpawnSubtitleAudio(environment: NodeJS.ProcessEnv): SubtitleSessionChildProcess {
  const helperPath = resolveMacosSubtitleAudioPath({
    resourcesPath: process.resourcesPath
  })
  if (!helperPath) throw new Error('macos-subtitle-audio sidecar is missing')
  const child: ChildProcess = spawn(helperPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: environment
  })
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => child.kill(),
    on: (event, listener) => child.on(event, listener)
  }
}

/**
 * 管理 sidecar 生命周期、stdio 行协议、状态机与会话代次。
 * @author zhenghq
 */
export class SubtitleSessionHost {
  /** 默认启动超时，覆盖 macOS 首次授权对话框与原生采集初始化耗时。 */
  private static readonly DEFAULT_STARTUP_TIMEOUT_MS = 15_000
  /** 高于该 RMS 的输入视为有可听音频，过滤常见的低电平底噪。 */
  private static readonly AUDIO_ACTIVITY_RMS_THRESHOLD = 0.01

  private child: SubtitleSessionChildProcess | null = null
  private state: RealtimeSubtitleSessionState = 'idle'
  private generation = 0
  private audioSource: RealtimeSubtitleAudioSource = 'system'
  private sourceText = ''
  private translatedText = ''
  private audioActivity: RealtimeSubtitleAudioActivity = 'idle'
  private segments: RealtimeSubtitleSegment[] = []
  private segmentSequence = 0
  private stdoutBuffer = ''
  /** sidecar 最近一条 stderr 诊断，用于进程异常退出时提供可操作原因。 */
  private stderrTail = ''
  private intentionallyStopping = false
  private disposed = false
  private errorCode: import('../shared/subtitleSession').RealtimeSubtitleErrorCode | undefined
  private error: string | undefined
  /** 等待 sidecar 首次 ready 的计时器；就绪、出错或停止后必须清除。 */
  private startupTimer: ReturnType<typeof setTimeout> | null = null

  private readonly spawnFn: (environment: NodeJS.ProcessEnv) => SubtitleSessionChildProcess
  private readonly onEvent: SubtitleSessionHostOptions['onEvent']
  private readonly onStateChange?: SubtitleSessionHostOptions['onStateChange']
  private readonly getDisplayMode: () => RealtimeSubtitleDisplayMode
  private readonly startupTimeoutMs: number
  private readonly log: (message: string) => void

  /**
   * 创建实时字幕宿主。
   * @param options 依赖注入配置。
   * @author zhenghq
   */
  constructor(options: SubtitleSessionHostOptions) {
    this.spawnFn = options.spawn ?? defaultSpawnSubtitleAudio
    this.onEvent = options.onEvent
    this.onStateChange = options.onStateChange
    this.getDisplayMode = options.getDisplayMode ?? (() => 'bilingual')
    this.startupTimeoutMs = options.startupTimeoutMs ?? SubtitleSessionHost.DEFAULT_STARTUP_TIMEOUT_MS
    this.log = options.log ?? ((message) => console.log(`[subtitle] ${message}`))
  }

  /**
   * 启动新的实时字幕会话，并返回递增的会话代次。
   * @param options 音频来源与识别语言。
   * @returns 新会话代次。
   * @author zhenghq
   */
  start(options: SubtitleSessionStartOptions): number {
    if (this.disposed) throw new Error('subtitle session host disposed')
    this.killChild()
    this.generation += 1
    const generation = this.generation
    this.audioSource = options.source
    this.sourceText = ''
    this.translatedText = ''
    this.audioActivity = 'idle'
    this.segments = []
    this.errorCode = undefined
    this.error = undefined
    this.segmentSequence = 0
    this.stdoutBuffer = ''
    this.stderrTail = ''
    this.intentionallyStopping = false
    this.setState('starting')
    this.log(`starting source=${options.source} asr=${options.asr} lang=${options.language}`)

    let child: SubtitleSessionChildProcess
    try {
      const environment = { ...process.env }
      delete environment.DEEPGRAM_API_KEY
      if (options.asr === 'deepgram' && options.deepgramApiKey) {
        environment.DEEPGRAM_API_KEY = options.deepgramApiKey
      }
      child = this.spawnFn(environment)
    } catch (error) {
      this.fail(generation, 'sidecar-unavailable', error)
      return generation
    }

    this.log(`sidecar spawned generation=${generation}`)
    this.child = child
    this.startStartupTimer(generation)
    child.stdout?.on('data', (chunk) => this.handleStdout(chunk, child, generation))
    child.stderr?.on('data', (chunk) => {
      const message = chunk.toString('utf8').trim()
      if (message) {
        this.stderrTail = message.slice(-2_000)
        this.log(`stderr generation=${generation} ${message}`)
      }
    })
    child.on('error', (error) => this.handleUnexpectedExit(child, generation, error))
    child.on('exit', () => this.handleUnexpectedExit(child, generation))

    try {
      child.stdin?.write(encodeSubtitleSidecarCommand({
        cmd: 'start',
        source: options.source,
        asr: options.asr,
        lang: options.language
      }))
    } catch (error) {
      this.fail(generation, 'sidecar-unavailable', error)
    }
    return generation
  }

  /**
   * 暂停当前识别会话。
   * @returns 无返回值。
   * @author zhenghq
   */
  pause(): void {
    if (this.state !== 'running') return
    this.writeCommand({ cmd: 'pause' })
    this.setState('paused')
  }

  /**
   * 恢复已暂停的识别会话。
   * @returns 无返回值。
   * @author zhenghq
   */
  resume(): void {
    if (this.state !== 'paused') return
    this.writeCommand({ cmd: 'resume' })
    this.setState('running')
  }

  /**
   * 停止当前会话并释放 sidecar 进程。
   * @returns 无返回值。
   * @author zhenghq
   */
  stop(): void {
    if (this.state === 'idle') return
    this.setState('stopping')
    this.intentionallyStopping = true
    this.writeCommand({ cmd: 'stop' })
    this.killChild()
    this.setState('idle')
  }

  /**
   * 释放宿主，后续不再接受启动请求。
   * @returns 无返回值。
   * @author zhenghq
   */
  dispose(): void {
    this.disposed = true
    this.killChild()
    this.setState('idle')
  }

  /**
   * 读取当前会话快照。
   * @returns 不可变的当前状态与最近字幕段落。
   * @author zhenghq
   */
  snapshot(): RealtimeSubtitleSnapshot {
    return {
      state: this.state,
      audioSource: this.audioSource,
      displayMode: this.getDisplayMode(),
      windowVisible: this.state !== 'idle',
      sourceText: this.sourceText,
      translatedText: this.translatedText,
      audioActivity: this.audioActivity,
      segments: this.segments.map((segment) => ({ ...segment })),
      ...(this.error ? { error: this.error } : {}),
      ...(this.errorCode ? { errorCode: this.errorCode } : {})
    }
  }

  /**
   * 更新翻译协调器产生的译文状态。
   * @param segmentId 段落标识。
   * @param translatedText 最新译文。
   * @param status 段落状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  updateTranslation(
    segmentId: string,
    translatedText: string,
    status: RealtimeSubtitleSegment['status']
  ): void {
    const segment = this.segments.find((candidate) => candidate.id === segmentId)
    if (!segment) return
    segment.translatedText = translatedText
    segment.status = status
    segment.updatedAt = Date.now()
    this.translatedText = translatedText
  }

  /**
   * 清空当前显示文本与段落，但保持识别会话继续运行。
   * @returns 无返回值。
   * @author zhenghq
   */
  clearDisplay(): void {
    this.sourceText = ''
    this.translatedText = ''
    this.segments = []
  }

  /**
   * 切换状态并通知监听者。
   * @param state 目标状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  private setState(state: RealtimeSubtitleSessionState): void {
    if (this.state === state) return
    this.state = state
    this.onStateChange?.(state)
  }

  /**
   * 向当前 sidecar 写入控制命令。
   * @param command 控制命令。
   * @returns 无返回值。
   * @author zhenghq
   */
  private writeCommand(command: Parameters<typeof encodeSubtitleSidecarCommand>[0]): void {
    try {
      this.child?.stdin?.write(encodeSubtitleSidecarCommand(command))
    } catch {
      // 进程已退出时由 exit 事件统一迁移状态并上报错误。
    }
  }

  /**
   * 处理 stdout 数据块并按行解析事件。
   * @param chunk 数据块。
   * @param child 数据来源子进程。
   * @param generation 该子进程所属代次。
   * @returns 无返回值。
   * @author zhenghq
   */
  private handleStdout(
    chunk: Buffer,
    child: SubtitleSessionChildProcess,
    generation: number
  ): void {
    if (this.child !== child || generation !== this.generation) return
    this.stdoutBuffer += chunk.toString('utf8')
    const lines = this.stdoutBuffer.split(/\r?\n/u)
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const event = parseSubtitleSidecarLine(line)
      if (event) this.handleEvent(event, generation)
    }
  }

  /**
   * 应用 sidecar 事件并同步宿主快照。
   * @param event sidecar 事件。
   * @param generation 事件所属代次。
   * @returns 无返回值。
   * @author zhenghq
   */
  private handleEvent(event: SubtitleSidecarEvent, generation: number): void {
    if (generation !== this.generation || this.disposed) return
    if (event.type === 'ready') {
      this.log(`ready generation=${generation}`)
      this.clearStartupTimer()
      this.setState('running')
    } else if (event.type === 'partial' || event.type === 'final') {
      const merged = mergeSubtitleSegments(
        this.segments,
        event,
        () => `${generation}:${++this.segmentSequence}`
      )
      this.segments = merged.segments
      this.sourceText = event.text
      this.audioActivity = 'speech-detected'
      if (event.type === 'final') this.translatedText = ''
    } else if (event.type === 'level') {
      // 一旦识别到语音，就保持 speech-detected，避免句间停顿反复切换提示。
      if (event.rms >= SubtitleSessionHost.AUDIO_ACTIVITY_RMS_THRESHOLD && this.audioActivity === 'idle') {
        this.audioActivity = 'speech-pending'
      }
    } else if (event.type === 'status') {
      if (event.state === 'idle') {
        this.clearStartupTimer()
        this.intentionallyStopping = true
        this.killChild()
      }
      this.setState(event.state)
    } else if (event.type === 'error') {
      this.log(`error generation=${generation} code=${event.code} message=${event.message ?? event.code}`)
      this.clearStartupTimer()
      this.errorCode = event.code
      this.error = event.message ?? event.code
      this.killChild()
      this.setState('idle')
    }
    this.onEvent(event, generation)
  }

  /**
   * 处理非主动退出，通知上层并回到空闲状态。
   * @param child 退出的子进程。
   * @param generation 子进程所属代次。
   * @param error 可选的启动错误。
   * @returns 无返回值。
   * @author zhenghq
   */
  private handleUnexpectedExit(
    child: SubtitleSessionChildProcess,
    generation: number,
    error?: unknown
  ): void {
    if (this.child !== child || generation !== this.generation) return
    const intentional = this.intentionallyStopping || this.state === 'idle'
    this.child = null
    this.clearStartupTimer()
    if (intentional || this.disposed) return
    this.log(`exited unexpectedly generation=${generation} stderr=${this.stderrTail || 'none'}`)
    this.fail(
      generation,
      'sidecar-unavailable',
      error ?? new Error(this.stderrTail || 'subtitle sidecar exited unexpectedly')
    )
  }

  /**
   * 持久化错误、终止 sidecar 并通知上层，确保隐藏窗口后仍能读取失败原因。
   * @param generation 出错会话代次。
   * @param code 结构化错误分类。
   * @param error 原始异常或可读错误。
   * @returns 无返回值。
   * @author zhenghq
   */
  private fail(
    generation: number,
    code: import('../shared/subtitleSession').RealtimeSubtitleErrorCode,
    error: unknown
  ): void {
    if (generation !== this.generation || this.disposed) return
    const message = error instanceof Error ? error.message : String(error)
    this.log(`failed generation=${generation} code=${code} message=${message}`)
    this.errorCode = code
    this.error = message
    this.clearStartupTimer()
    this.killChild()
    this.setState('idle')
    this.onEvent({ type: 'error', code, message }, generation)
  }

  /**
   * 主动终止当前子进程，并抑制其 exit 事件产生的重复错误。
   * @returns 无返回值。
   * @author zhenghq
   */
  private killChild(): void {
    this.clearStartupTimer()
    const child = this.child
    this.child = null
    if (!child) return
    this.intentionallyStopping = true
    try {
      child.kill()
    } catch {
      // 已退出时忽略重复终止异常。
    }
  }

  /**
   * 启动 sidecar 就绪超时计时器，避免原生调用阻塞时界面永久停留在 starting。
   * @param generation 当前会话代次。
   * @returns 无返回值。
   * @author zhenghq
   */
  private startStartupTimer(generation: number): void {
    this.clearStartupTimer()
    if (this.startupTimeoutMs <= 0) return
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      if (generation !== this.generation || this.state !== 'starting' || this.disposed) return
      this.log(`startup timeout generation=${generation} timeoutMs=${this.startupTimeoutMs}`)
      this.fail(
        generation,
        'permission-denied',
        new Error(translateMain('settings.realtimeSubtitle.error.startupTimeout'))
      )
    }, this.startupTimeoutMs)
  }

  /**
   * 清除启动超时计时器；所有结束或成功启动路径都应调用。
   * @returns 无返回值。
   * @author zhenghq
   */
  private clearStartupTimer(): void {
    if (this.startupTimer === null) return
    clearTimeout(this.startupTimer)
    this.startupTimer = null
  }
}
