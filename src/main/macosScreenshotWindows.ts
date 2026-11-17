import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ScreenshotWindowCandidate } from '../shared/screenshotWindowSelection'

const execFileP = promisify(execFile)

/** 截图窗口枚举的单次默认预算；不采用取词路径的冷启动重试。 */
export const MACOS_SCREENSHOT_WINDOWS_TIMEOUT_MS = 200

/** 截图枚举依赖与过滤选项。 */
export interface MacosScreenshotWindowsOptions {
  /** 指定 helper 路径；默认优先打包 resources，再查开发 build 目录。 */
  helperPath?: string
  /** 单次执行依赖：接收路径、命令参数和毫秒预算，返回原始 stdout JSON。 */
  runHelper?: (helperPath: string, args: string[], timeoutMs: number) => Promise<string>
  /** 请求预算；非有限、非正或溢出值恢复默认预算。 */
  timeoutMs?: number
  /** 需要排除的系统窗口编号；支持数组或 Set 等可迭代集合。 */
  excludedWindowIds?: Iterable<string>
}

/**
 * 查找截图枚举共用的原生 helper，不进入现有取词重试或焦点链路。
 * @returns helper 路径；文件缺失时返回 null。
 * @author zhenghq
 */
function resolveScreenshotHelperPath(): string | null {
  const candidates = [
    typeof process.resourcesPath === 'string' && process.resourcesPath
      ? join(process.resourcesPath, 'macos-window-helper') : null,
    join(process.cwd(), 'build', 'macos-window-helper')
  ]
  return candidates.find((path): path is string => path !== null && existsSync(path)) ?? null
}

/**
 * 只执行一次截图子命令，限制输出大小并在预算耗尽时终止子进程。
 * @param helperPath helper 可执行文件路径。
 * @param args 独立截图子命令参数。
 * @param timeoutMs 本次执行的毫秒预算。
 * @returns 原始 stdout；启动、超时或退出失败时拒绝。
 * @author zhenghq
 */
async function executeScreenshotHelper(
  helperPath: string,
  args: string[],
  timeoutMs: number
): Promise<string> {
  const { stdout } = await execFileP(helperPath, args, {
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    encoding: 'utf8'
  })
  return stdout
}

/**
 * 校验单个全局 DIP 候选，并仅复制公开字段，丢弃标题等无关数据。
 * @param value helper 返回的未知候选。
 * @returns 有效候选；非有限边界、过小窗口或非法字段返回 null。
 * @author zhenghq
 */
function parseScreenshotCandidate(value: unknown): ScreenshotWindowCandidate | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !record.id.trim() ||
      typeof record.appName !== 'string' ||
      typeof record.zOrder !== 'number' || !Number.isSafeInteger(record.zOrder) || record.zOrder < 0 ||
      !record.bounds || typeof record.bounds !== 'object') return null
  const { x, y, width, height } = record.bounds as Record<string, unknown>
  if (typeof x !== 'number' || !Number.isFinite(x) ||
      typeof y !== 'number' || !Number.isFinite(y) ||
      typeof width !== 'number' || !Number.isFinite(width) || width < 8 ||
      typeof height !== 'number' || !Number.isFinite(height) || height < 8) return null
  return {
    id: record.id,
    appName: record.appName,
    bounds: { x, y, width, height },
    zOrder: record.zOrder
  }
}

/**
 * 有界枚举所有 macOS 普通可见窗口，不激活窗口、不读取标题、不重试冷启动。
 * 注入依赖也受外层超时约束；所有执行、解析及过滤错误静默降级为空候选。
 * @param options helper 路径、单次执行依赖、超时预算与排除窗口编号。
 * @returns 按原始 zOrder 从前到后排列的全局 DIP 候选；失败返回空数组。
 * @author zhenghq
 */
export async function enumerateMacosScreenshotWindows(
  options: MacosScreenshotWindowsOptions = {}
): Promise<ScreenshotWindowCandidate[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const helperPath = options.helperPath ?? resolveScreenshotHelperPath() ??
      (options.runHelper ? 'macos-window-helper' : null)
    if (!helperPath) return []
    const requestedTimeout = options.timeoutMs ?? MACOS_SCREENSHOT_WINDOWS_TIMEOUT_MS
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 && requestedTimeout <= 2147483647
      ? Math.max(1, Math.floor(requestedTimeout)) : MACOS_SCREENSHOT_WINDOWS_TIMEOUT_MS
    const runHelper = options.runHelper ?? executeScreenshotHelper
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    })
    // 先注册超时，再异步调用注入依赖；race 会吸收超时后到达的拒绝。
    const stdout = await Promise.race([
      Promise.resolve().then(() => runHelper(helperPath, ['screenshot-windows'], timeoutMs)),
      timeout
    ])
    if (typeof stdout !== 'string') return []
    const parsed: unknown = JSON.parse(stdout)
    if (!parsed || typeof parsed !== 'object') return []
    const response = parsed as Record<string, unknown>
    if (response.ok !== true || !Array.isArray(response.windows)) return []
    const excluded = new Set(options.excludedWindowIds)
    const seen = new Set<string>()
    const candidates = response.windows
      .map(parseScreenshotCandidate)
      .filter((candidate): candidate is ScreenshotWindowCandidate => candidate !== null)
      .sort((a, b) => a.zOrder - b.zOrder)
    return candidates.filter((candidate) => {
      if (excluded.has(candidate.id) || seen.has(candidate.id)) return false
      seen.add(candidate.id)
      return true
    })
  } catch {
    return []
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
