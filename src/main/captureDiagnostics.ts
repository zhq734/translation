import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'
import {
  appendDiagnosticRecord,
  buildCaptureDiagnosticRecord,
  normalizeAppIdentifier,
  pruneDiagnosticDays,
  type CaptureDiagnosticRecord,
  type CaptureDiagnosticsData,
  type CaptureDiagnosticReason,
  type DiagnosticDayBucket
} from '../shared/captureDiagnostics'

const execFileP = promisify(execFile)

/** 前台应用标识查询的最长执行时间（毫秒）。 */
const FRONTMOST_APP_QUERY_TIMEOUT_MS = 500

/** 诊断存储构造选项。 */
export interface CaptureDiagnosticsStoreOptions {
  /** 诊断文件绝对路径。 */
  filePath: string
  /** 当天日期提供者（YYYY-MM-DD），便于测试注入；默认按本地时区计算。 */
  today?: () => string
}

/** 前台应用查询结果。 */
export interface FrontmostAppInfo {
  /** 规范化后的应用标识；查询失败时为 unknown。 */
  app: string
}

/**
 * 以本地时区计算当天日期字符串。
 * @returns YYYY-MM-DD 格式的本地日期。
 * @author zhenghq
 */
function localToday(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * 查询 macOS 前台进程的 bundle identifier，失败时回退应用名。
 * @returns 前台应用标识。
 * @author zhenghq
 */
async function queryMacOSFrontmostApp(): Promise<string> {
  const script = [
    'tell application "System Events"',
    'set frontProcess to first application process whose frontmost is true',
    'try',
    'return bundle identifier of frontProcess',
    'on error',
    'return name of frontProcess',
    'end try',
    'end tell'
  ].join('\n')
  const { stdout } = await execFileP('osascript', ['-e', script], {
    timeout: FRONTMOST_APP_QUERY_TIMEOUT_MS
  })
  return stdout.trim()
}

/**
 * 查询 Windows 前台窗口的进程名。
 * @returns 前台应用标识。
 * @author zhenghq
 */
async function queryWindowsFrontmostApp(): Promise<string> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$handle = [System.Windows.Forms.Form]::ActiveForm;',
    'if ($null -eq $handle) {',
    '  $hwnd = (Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();\' -Name Win32 -PassThru)::GetForegroundWindow();',
    '} else { $hwnd = $handle.Handle }',
    '$process = Get-Process | Where-Object { $_.MainWindowHandle -eq $hwnd } | Select-Object -First 1;',
    'if ($null -eq $process) { Write-Output \'unknown\' } else { Write-Output $process.ProcessName }'
  ].join(' ')
  const { stdout } = await execFileP('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-Command',
    script
  ], {
    timeout: FRONTMOST_APP_QUERY_TIMEOUT_MS,
    windowsHide: true
  })
  return stdout.trim()
}

/**
 * 查询当前前台应用标识，带 500ms 超时与异常兜底。
 * @returns 前台应用标识；失败时返回 unknown。
 * @author zhenghq
 */
export async function queryFrontmostApp(): Promise<FrontmostAppInfo> {
  try {
    if (process.platform === 'darwin') {
      const raw = await queryMacOSFrontmostApp()
      return { app: normalizeAppIdentifier(raw) }
    }
    if (process.platform === 'win32') {
      const raw = await queryWindowsFrontmostApp()
      return { app: normalizeAppIdentifier(raw) }
    }
    // Linux 及其他平台暂不支持前台应用查询
    return { app: 'unknown' }
  } catch {
    return { app: 'unknown' }
  }
}

/**
 * 取词诊断存储：负责内存聚合、两天滚动持久化与原子写入。
 * @author zhenghq
 */
export class CaptureDiagnosticsStore {
  private readonly filePath: string
  private readonly today: () => string
  private data: CaptureDiagnosticsData

  /**
   * 创建诊断存储并加载磁盘数据；文件损坏时静默重建为空结构。
   * @param options 存储构造选项。
   * @author zhenghq
   */
  constructor(options: CaptureDiagnosticsStoreOptions) {
    this.filePath = options.filePath
    this.today = options.today ?? localToday
    this.data = this.load()
  }

  /**
   * 记录一条取词诊断，并按两天滚动规则清理过期桶后持久化。
   * @param record 诊断记录。
   * @returns 无返回值。
   * @author zhenghq
   */
  record(record: CaptureDiagnosticRecord): void {
    const today = this.today()
    const bucket = this.data.days[today] ?? { records: [], summary: { total: 0, byEntry: {}, byLevel: {}, byReason: {}, topApps: [] } }
    this.data.days[today] = appendDiagnosticRecord(bucket, record)
    this.data.days = pruneDiagnosticDays(this.data.days, today)
    this.persist()
  }

  /**
   * 获取当前诊断数据快照（只读副本）。
   * @returns 诊断数据深拷贝。
   * @author zhenghq
   */
  snapshot(): CaptureDiagnosticsData {
    return JSON.parse(JSON.stringify(this.data)) as CaptureDiagnosticsData
  }

  /**
   * 获取近两天聚合摘要，供设置页展示。
   * @returns 两天聚合摘要。
   * @author zhenghq
   */
  getSummary(): { days: Record<string, DiagnosticDayBucket> } {
    return { days: this.data.days }
  }

  /**
   * 获取导出数据：两天聚合与原始样本。
   * @returns 导出用诊断数据。
   * @author zhenghq
   */
  getExportData(): CaptureDiagnosticsData {
    return this.snapshot()
  }

  /**
   * 从磁盘加载诊断数据，非法内容静默重建为空结构。
   * @returns 诊断数据。
   * @author zhenghq
   */
  private load(): CaptureDiagnosticsData {
    try {
      if (existsSync(this.filePath)) {
        const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<CaptureDiagnosticsData>
        if (raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object') {
          return { days: raw.days as Record<string, DiagnosticDayBucket> }
        }
      }
    } catch {
      // 静默重建：损坏的诊断文件不影响取词功能
    }
    return { days: {} }
  }

  /**
   * 原子写入诊断文件；写失败静默忽略，避免影响取词主流程。
   * @returns 无返回值。
   * @author zhenghq
   */
  private persist(): void {
    try {
      const temporaryPath = `${this.filePath}.tmp`
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(temporaryPath, JSON.stringify(this.data, null, 2))
      renameSync(temporaryPath, this.filePath)
    } catch {
      // 静默：诊断持久化失败不打扰用户
    }
  }
}

/** 默认诊断存储实例（基于应用 userData 目录）。 */
let defaultStore: CaptureDiagnosticsStore | null = null

/**
 * 惰性解析 Electron 应用 userData 目录，避免单元测试环境顶层加载 electron 模块。
 * @returns 应用 userData 目录绝对路径。
 * @author zhenghq
 */
function resolveUserDataPath(): string {
  const require = createRequire(import.meta.url)
  const { app } = require('electron') as typeof import('electron')
  return app.getPath('userData')
}

/**
 * 获取默认诊断存储实例，惰性初始化。
 * @returns 诊断存储实例。
 * @author zhenghq
 */
export function getCaptureDiagnosticsStore(): CaptureDiagnosticsStore {
  if (!defaultStore) {
    defaultStore = new CaptureDiagnosticsStore({
      filePath: `${resolveUserDataPath()}/capture-diagnostics.json`
    })
  }
  return defaultStore
}

/**
 * 便捷函数：构建并记录一条诊断记录。
 * @param input 诊断记录字段。
 * @returns 无返回值。
 * @author zhenghq
 */
export function recordCaptureDiagnostic(input: {
  at: number
  entry: 'button' | 'hotkey' | 'auto'
  platform: NodeJS.Platform
  level: 'native-read' | 'copy-polled' | 'copy-late' | 'failed'
  reason?: CaptureDiagnosticReason
  elapsedMs: number
  app: string
}): void {
  getCaptureDiagnosticsStore().record(buildCaptureDiagnosticRecord(input))
}
