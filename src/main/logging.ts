import { createWriteStream, mkdirSync, readdirSync, rmSync, type WriteStream } from 'node:fs'
import { inspect } from 'node:util'
import { join } from 'node:path'

/**
 * 结构化日志条目，供内存缓冲、落盘与渲染进程展示共同使用。
 * @author zhenghq
 */
export interface LogEntry {
  /** 日志产生时间（ISO 字符串）。 */
  ts: string
  /** 日志级别，对应 console 方法名。 */
  level: 'log' | 'info' | 'warn' | 'error'
  /** 日志来源模块标签，console 包装默认为 main。 */
  scope: string
  /** 序列化后的日志内容（已截断）。 */
  message: string
}

/**
 * 日志推送订阅回调。
 * @author zhenghq
 */
export type LogListener = (entries: LogEntry[]) => void

/** 单条日志消息的最大长度，超出部分截断，防止内存与写盘压力。 */
const MESSAGE_MAX_LENGTH = 2048
/** 内存环形缓冲容量上限。 */
export const LOG_BUFFER_CAPACITY = 2000

/**
 * 将任意日志参数序列化为字符串，Error 提取 stack，对象走 inspect。
 * @param value 日志参数。
 * @returns 序列化后的字符串。
 * @author zhenghq
 */
function serializeValue(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  if (typeof value === 'string') return value
  try {
    return inspect(value, { depth: 4, breakLength: 120 })
  } catch {
    return String(value)
  }
}

/**
 * 拼接并截断日志消息。
 * @param args 原始日志参数列表。
 * @returns 拼接并限长后的消息。
 * @author zhenghq
 */
export function formatLogMessage(args: unknown[]): string {
  const message = args.map(serializeValue).join(' ')
  return message.length > MESSAGE_MAX_LENGTH ? `${message.slice(0, MESSAGE_MAX_LENGTH)}…` : message
}

/**
 * 从日志文件名中提取日期串（main-YYYY-MM-DD.log）。
 * @param fileName 日志文件名。
 * @returns 日期串；不匹配时返回 null。
 * @author zhenghq
 */
export function parseLogFileDate(fileName: string): string | null {
  const match = /^main-(\d{4}-\d{2}-\d{2})\.log$/u.exec(fileName)
  return match ? match[1] : null
}

/**
 * 获取当天日期串（本地时区，YYYY-MM-DD）。
 * @param now 当前时间，便于测试注入。
 * @returns 当天日期串。
 * @author zhenghq
 */
export function currentLogDate(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 主进程日志层：console 包装、环形缓冲、按天滚动落盘与订阅推送。
 * @author zhenghq
 */
export interface AppLogger {
  /** 追加一条日志（console 包装与 createLogger 的共同入口）。 */
  append(level: LogEntry['level'], args: unknown[], scope?: string): LogEntry
  /** 返回内存缓冲中的全部日志（时间升序）。 */
  getHistory(): LogEntry[]
  /** 订阅日志增量推送（同 tick 聚合），返回取消订阅函数。 */
  subscribe(listener: LogListener): () => void
  /** 获取当日日志文件路径。 */
  getLogFilePath(): string
  /** 关闭文件流并恢复原始 console（主要用于测试）。 */
  dispose(): void
}

/**
 * 创建主进程日志层实例。
 * @param options.logDir 日志目录。
 * @param options.hookConsole 是否包装全局 console 方法。
 * @param options.now 时间工厂（测试注入用）。
 * @returns 日志层实例。
 * @author zhenghq
 */
export function createAppLogger(options: {
  logDir: string
  hookConsole?: boolean
  now?: () => Date
}): AppLogger {
  const { logDir, hookConsole = true, now = () => new Date() } = options
  const buffer: LogEntry[] = []
  const listeners = new Set<LogListener>()
  let currentDate = currentLogDate(now())
  let stream: WriteStream | null = null
  let fileDisabled = false
  let pending: LogEntry[] = []
  let flushScheduled = false

  /**
   * 确保当日日志文件写流可用，跨天时切换新文件。
   * @returns 无返回值。
   * @author zhenghq
   */
  function ensureStream(): void {
    const today = currentLogDate(now())
    if (stream && today === currentDate) return
    stream?.end()
    currentDate = today
    if (fileDisabled) return
    try {
      mkdirSync(logDir, { recursive: true })
      stream = createWriteStream(join(logDir, `main-${today}.log`), { flags: 'a' })
      stream.on('error', () => {
        // 写盘失败时降级为仅内存缓冲与终端输出，不阻断业务
        fileDisabled = true
        stream = null
      })
    } catch {
      fileDisabled = true
      stream = null
    }
  }

  /**
   * 删除日志目录中日期早于当天的历史日志文件，仅保留最近 1 天。
   * @returns 无返回值。
   * @author zhenghq
   */
  function cleanupOldLogs(): void {
    try {
      const today = currentLogDate(now())
      for (const file of readdirSync(logDir)) {
        const date = parseLogFileDate(file)
        if (date !== null && date < today) rmSync(join(logDir, file), { force: true })
      }
    } catch {
      // 清理失败不影响启动
    }
  }

  /**
   * 将同 tick 内累积的日志批量推送给订阅者。
   * @returns 无返回值。
   * @author zhenghq
   */
  function flushPending(): void {
    flushScheduled = false
    if (pending.length === 0 || listeners.size === 0) {
      pending = []
      return
    }
    const batch = pending
    pending = []
    for (const listener of listeners) listener(batch)
  }

  try {
    mkdirSync(logDir, { recursive: true })
  } catch {
    // 日志目录不可创建时降级为仅内存缓冲与终端输出
    fileDisabled = true
  }
  cleanupOldLogs()
  ensureStream()

  const logger: AppLogger = {
    append(level, args, scope = 'main') {
      const entry: LogEntry = {
        ts: now().toISOString(),
        level,
        scope,
        message: formatLogMessage(args)
      }
      buffer.push(entry)
      if (buffer.length > LOG_BUFFER_CAPACITY) buffer.shift()
      ensureStream()
      try {
        stream?.write(`[${entry.ts}] [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}\n`)
      } catch {
        fileDisabled = true
      }
      if (listeners.size > 0) {
        pending.push(entry)
        if (!flushScheduled) {
          flushScheduled = true
          queueMicrotask(flushPending)
        }
      }
      return entry
    },
    getHistory() {
      return buffer.slice()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getLogFilePath() {
      return join(logDir, `main-${currentDate}.log`)
    },
    dispose() {
      listeners.clear()
      stream?.end()
      stream = null
      restoreConsole()
    }
  }

  const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  }

  /**
   * 恢复被包装的 console 方法。
   * @returns 无返回值。
   * @author zhenghq
   */
  function restoreConsole(): void {
    if (!hookConsole) return
    console.log = originalConsole.log
    console.info = originalConsole.info
    console.warn = originalConsole.warn
    console.error = originalConsole.error
  }

  if (hookConsole) {
    console.log = (...args: unknown[]) => { logger.append('log', args); originalConsole.log(...args) }
    console.info = (...args: unknown[]) => { logger.append('info', args); originalConsole.info(...args) }
    console.warn = (...args: unknown[]) => { logger.append('warn', args); originalConsole.warn(...args) }
    console.error = (...args: unknown[]) => { logger.append('error', args); originalConsole.error(...args) }
  }

  return logger
}

/**
 * 创建带模块标签的结构化日志器，供各模块渐进替换 console 调用。
 * @param logger 应用日志层实例。
 * @param scope 模块标签。
 * @returns 与 console 同形但带 scope 的日志器。
 * @author zhenghq
 */
export function createLogger(logger: AppLogger, scope: string) {
  return {
    log: (...args: unknown[]) => logger.append('log', args, scope),
    info: (...args: unknown[]) => logger.append('info', args, scope),
    warn: (...args: unknown[]) => logger.append('warn', args, scope),
    error: (...args: unknown[]) => logger.append('error', args, scope)
  }
}
