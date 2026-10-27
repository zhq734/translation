import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  resolveTargetWindow,
  resolveWindowLocateOutcome,
  type FrontmostWindowSnapshot,
  type MacosWindowInfo,
  type MacosWindowListResult
} from '../shared/macosWindowSnapshot'

const execFileP = promisify(execFile)

/** 窗口 helper 失败分类；只允许固定枚举进入诊断日志。 */
export type MacosWindowHelperFailureReason =
  | 'helper-missing'
  | 'timeout'
  | 'enoent'
  | 'nonzero-exit'
  | 'invalid-json'
  | 'window-list-unavailable'

/** 窗口 helper 执行结果。 */
export type MacosWindowHelperRunResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: MacosWindowHelperFailureReason }

/**
 * 将 helper 执行异常归类为固定失败原因。
 * 只读取错误码、信号与已解析的 JSON 错误字段，不拼接 stdout/stderr，
 * 避免窗口标题或其它用户数据进入日志。
 * @param error execFile 抛出的未知错误。
 * @param stdout helper 已输出的标准输出。
 * @returns 固定失败原因。
 * @author zhenghq
 */
export function classifyMacosWindowHelperFailure(
  error: unknown,
  stdout = ''
): MacosWindowHelperFailureReason {
  const record = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : {}
  if (record.code === 'ENOENT') return 'enoent'
  if (record.killed === true || record.signal === 'SIGTERM' || record.code === 'ETIMEDOUT') {
    return 'timeout'
  }
  try {
    const parsed = JSON.parse(stdout) as unknown
    if (parsed && typeof parsed === 'object') {
      const helperError = (parsed as Record<string, unknown>).error
      if (helperError === 'window-list-unavailable') return 'window-list-unavailable'
    }
  } catch {
    // helper 失败时 stdout 可能为空或不是 JSON，继续按退出码归类。
  }
  return 'nonzero-exit'
}

/**
 * 输出窗口 helper 失败诊断，只包含固定分类。
 * @param operation helper 子命令。
 * @param reason 固定失败原因。
 * @returns 无返回值。
 * @author zhenghq
 */
function logWindowHelperFailure(operation: string, reason: MacosWindowHelperFailureReason): void {
  console.log(`[macForeground] window-helper op=${operation} status=failed reason=${reason}`)
}

/**
 * 窗口枚举硬超时（毫秒）。
 *
 * helper 进程冷启动并查询 CGWindowList 的实测耗时会在 50-90ms 波动，
 * 原 50ms 上限会周期性超时，使微信多窗口被误报为 windowCount=unknown。
 * 放宽到 200ms 仍保持有界等待，同时覆盖正常启动抖动。
 */
export const MACOS_WINDOW_ENUMERATION_TIMEOUT_MS = 200

/**
 * 窗口枚举冷启动重试硬超时（毫秒）。
 *
 * 首次 200ms 超时说明 helper 很可能仍在冷启动。第二次若继续使用同一上限，
 * 会再次被进程启动开销截断，导致启动后的第一次取词稳定失败。800ms 仍为
 * 有界等待，只用于无副作用的 `list` 冷启动重试，不影响正常枚举路径。
 */
export const MACOS_WINDOW_ENUMERATION_RETRY_TIMEOUT_MS = 800

/** 窗口激活确认硬超时（毫秒）。 */
export const MACOS_WINDOW_ACTIVATION_TIMEOUT_MS = 200

/** 窗口激活确认轮询间隔（毫秒）。 */
export const MACOS_WINDOW_ACTIVATION_POLL_MS = 16

/** 窗口激活结果。 */
export interface MacosWindowActivationResult {
  /** 是否已向目标应用发出激活请求（精确或应用级）。 */
  activated: boolean
  /** 是否已确认目标窗口或应用取得前台；仅 activated 时仍可能未确认。 */
  confirmed: boolean
  /** 窗口定位诊断结果。 */
  outcome: 'exact' | 'app-fallback' | 'failed'
  /** 目标应用普通窗口数量；未枚举时为 undefined。 */
  windowCount?: number
  /** 是否精确匹配到目标窗口。 */
  windowMatched: boolean
}

/**
 * 判断窗口激活是否明确失败。
 * 只有 failed 才要求复制链路停止注入快捷键；应用级退化与精确命中仍保持原有行为。
 * @param result 窗口激活结果；未执行窗口激活时为 null。
 * @returns outcome 为 failed 时返回 true。
 * @author zhenghq
 */
export function isFailedWindowActivation(
  result: MacosWindowActivationResult | null | undefined
): boolean {
  return result?.outcome === 'failed'
}

/**
 * 判断窗口激活是否已精确确认目标窗口取得前台。
 * 应用级 open -b 只代表已发出请求，不能作为取词前交还完成。
 * @param result 窗口激活结果；未执行窗口激活时为 null。
 * @returns 已发出动作、已确认且精确定位目标窗口时返回 true。
 * @author zhenghq
 */
export function isExactWindowActivationConfirmed(
  result: MacosWindowActivationResult | null | undefined
): boolean {
  return Boolean(
    result &&
    result.activated &&
    result.confirmed &&
    result.outcome === 'exact' &&
    result.windowMatched
  )
}

/** 窗口激活依赖注入配置，便于单元测试替换系统调用。 */
export interface MacosWindowActivationDeps {
  /** 枚举指定进程的普通窗口。 */
  enumerateWindows: (pid: number) => Promise<MacosWindowListResult>
  /** 读取全局最前普通窗口编号；AX focused 不可用时作为兜底。 */
  readFrontmostWindowNumber: () => Promise<number | null>
  /** 提升指定窗口并使其成为目标应用 focused window。 */
  raiseWindow: (pid: number, windowNumber: number) => Promise<boolean>
  /** 读取指定进程当前 focused window 编号。 */
  readFocusedWindowNumber: (pid: number) => Promise<number | null>
  /** 使用应用级 open -b 激活目标应用。 */
  openApplication: (bundleId: string) => boolean
  /** 判断目标进程是否仍存活。 */
  isProcessAlive: (pid: number) => boolean
  /** 当前时间源。 */
  now: () => number
  /** 等待函数。 */
  sleep: (ms: number) => Promise<void>
}

/**
 * 解析窗口 helper 可执行文件路径。
 * @param resourcesPath 打包后的 resources 目录。
 * @param cwd 仓库根目录。
 * @param fileExists 文件存在性判断。
 * @returns helper 绝对路径；不存在时返回 null。
 * @author zhenghq
 */
export function resolveMacosWindowHelperPath(options?: {
  resourcesPath?: string
  cwd?: string
  fileExists?: (candidate: string) => boolean
}): string | null {
  const fileExists = options?.fileExists ?? existsSync
  const cwd = options?.cwd ?? process.cwd()
  const candidates = [
    options?.resourcesPath ? join(options.resourcesPath, 'macos-window-helper') : null,
    join(cwd, 'build', 'macos-window-helper')
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find(fileExists) ?? null
}

/**
 * 执行一次窗口 helper 请求并解析 JSON 输出。
 * @param helperPath helper 可执行文件路径。
 * @param args helper 参数。
 * @returns helper 输出对象或固定失败原因。
 * @author zhenghq
 */
async function executeWindowHelper(
  helperPath: string,
  args: string[],
  timeout: number
): Promise<MacosWindowHelperRunResult> {
  try {
    const { stdout } = await execFileP(helperPath, args, {
      timeout
    })
    try {
      const parsed = JSON.parse(stdout) as unknown
      if (!parsed || typeof parsed !== 'object') {
        return { ok: false, reason: 'invalid-json' }
      }
      return { ok: true, value: parsed as Record<string, unknown> }
    } catch {
      return { ok: false, reason: 'invalid-json' }
    }
  } catch (error) {
    const record = error && typeof error === 'object'
      ? error as Record<string, unknown>
      : {}
    const stdout = typeof record.stdout === 'string' ? record.stdout : ''
    const reason = classifyMacosWindowHelperFailure(error, stdout)
    return { ok: false, reason }
  }
}

/**
 * 执行窗口 helper 请求，并为 `list` 冷启动超时提供一次有界重试。
 *
 * 首次调用时 helper 进程和 CGWindowList 都可能尚未预热，实测会偶发超过
 * 200ms。只允许无副作用的 `list` 重试；`raise` / `focused` 重试会再次改变
 * 同进程窗口顺序，因此超时后必须直接失败。
 * @param args helper 参数。
 * @param run 单次 helper 执行函数，便于测试注入；第二个参数为本次硬超时。
 * @returns 首次成功或重试后的最终结果。
 * @author zhenghq
 */
export async function runWindowHelperWithListRetry(
  args: string[],
  run: (args: string[], timeoutMs: number) => Promise<MacosWindowHelperRunResult>
): Promise<MacosWindowHelperRunResult> {
  const timeoutMs = args[0] === 'list'
    ? MACOS_WINDOW_ENUMERATION_TIMEOUT_MS
    : MACOS_WINDOW_ACTIVATION_TIMEOUT_MS
  const first = await run(args, timeoutMs)
  if (args[0] !== 'list' || first.ok || first.reason !== 'timeout') return first
  console.log('[macForeground] window-helper op=list status=retry reason=timeout')
  return run(args, MACOS_WINDOW_ENUMERATION_RETRY_TIMEOUT_MS)
}

/**
 * 执行窗口 helper 并解析 JSON 输出。
 * @param args helper 参数。
 * @returns helper 输出对象或固定失败原因。
 * @author zhenghq
 */
async function runWindowHelper(args: string[]): Promise<MacosWindowHelperRunResult> {
  const helperPath = resolveMacosWindowHelperPath({
    resourcesPath: typeof process.resourcesPath === 'string' && process.resourcesPath
      ? process.resourcesPath
      : undefined
  })
  if (!helperPath) {
    logWindowHelperFailure(args[0] ?? 'unknown', 'helper-missing')
    return { ok: false, reason: 'helper-missing' }
  }
  const result = await runWindowHelperWithListRetry(
    args,
    (attemptArgs, timeoutMs) => executeWindowHelper(helperPath, attemptArgs, timeoutMs)
  )
  if (!result.ok) logWindowHelperFailure(args[0] ?? 'unknown', result.reason)
  return result
}

/**
 * 将 helper 返回的未知值解析为窗口信息。
 * @param value helper 返回的原始窗口对象。
 * @returns 合法窗口信息；字段非法时返回 null。
 * @author zhenghq
 */
function parseWindowInfo(value: unknown): MacosWindowInfo | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const bounds = record.bounds
  if (!bounds || typeof bounds !== 'object') return null
  const b = bounds as Record<string, unknown>
  const pid = record.pid
  const windowNumber = record.windowNumber
  const layer = record.layer
  const title = record.title
  if (typeof pid !== 'number' || typeof windowNumber !== 'number' || typeof layer !== 'number') return null
  if (typeof b.x !== 'number' || typeof b.y !== 'number' ||
      typeof b.width !== 'number' || typeof b.height !== 'number') return null
  return {
    pid,
    windowNumber,
    layer,
    title: typeof title === 'string' ? title : '',
    bounds: { x: b.x, y: b.y, width: b.width, height: b.height }
  }
}

/**
 * 通过原生 helper 枚举目标进程普通窗口，并读取全局最前普通窗口。
 * @param pid 目标进程号。
 * @returns 普通窗口列表。
 * @throws helper 不可用、超时或输出非法时抛出错误，避免把未知数量伪报为 0。
 * @author zhenghq
 */
export async function enumerateMacosWindows(pid: number): Promise<MacosWindowListResult> {
  const run = await runWindowHelper(['list', String(pid)])
  const result = run.ok ? run.value : null
  const windows = result?.windows
  if (!result || result.ok !== true || !Array.isArray(windows)) {
    throw new Error('macos-window-enumeration-failed')
  }
  const parsedWindows = windows
    .map(parseWindowInfo)
    .filter((window): window is MacosWindowInfo => Boolean(window))
  const frontmostWindowNumber = typeof result.frontmostWindowNumber === 'number'
    ? result.frontmostWindowNumber
    : undefined
  const frontmostPid = typeof result.frontmostPid === 'number'
    ? result.frontmostPid
    : undefined
  return {
    windows: parsedWindows,
    ...(frontmostWindowNumber === undefined ? {} : { frontmostWindowNumber }),
    ...(frontmostPid === undefined ? {} : { frontmostPid })
  }
}

/**
 * 通过原生 helper 提升指定窗口并确认 focused window。
 * @param pid 目标进程号。
 * @param windowNumber 目标窗口编号。
 * @returns 已提升且确认 focused 时返回 true。
 * @author zhenghq
 */
export async function raiseMacosWindow(pid: number, windowNumber: number): Promise<boolean> {
  const run = await runWindowHelper(['raise', String(pid), String(windowNumber)])
  return run.ok && run.value.raised === true
}

/**
 * 通过原生 helper 读取目标进程 focused window 编号。
 * @param pid 目标进程号。
 * @returns focused window 编号；无法读取时返回 null。
 * @author zhenghq
 */
export async function readFocusedMacosWindowNumber(pid: number): Promise<number | null> {
  const run = await runWindowHelper(['focused', String(pid)])
  return run.ok && typeof run.value.windowNumber === 'number' ? run.value.windowNumber : null
}

/**
 * 通过原生 helper 按进程激活源应用。
 *
 * 该入口不要求 AX 窗口能力，用于 Chrome 等多窗口应用在 AX raise 失败时
 * 仍能把前台交还给源进程；helper 不传 AllWindows 选项，避免切换同进程窗口。
 * @param pid 目标进程号。
 * @returns helper 明确确认已发出激活请求时返回 true。
 * @author zhenghq
 */
export async function activateMacosApplication(pid: number): Promise<boolean> {
  const run = await runWindowHelper(['activate', String(pid)])
  return run.ok && run.value.activated === true
}

/** 进程级激活后的应用失活确认依赖。 */
export interface MacosApplicationActivationDeps {
  /** 请求激活目标进程。 */
  activateApplication: (pid: number) => Promise<boolean>
  /** 读取本应用是否仍处于最前。 */
  isAppActive: () => boolean
  /** 当前时间源。 */
  now: () => number
  /** 等待函数。 */
  sleep: (ms: number) => Promise<void>
}

/**
 * 按进程激活源应用，并在有界时间内等待本应用失活。
 *
 * 激活请求本身成功不代表前台已经交还，必须继续轮询应用激活事件。轮询失败时
 * 返回 false，让调用方保留现有的整应用安全让出兜底，不能把未确认状态当成成功。
 * 依赖必须由调用方显式提供，避免默认实现漏接真实的应用激活事件后静默超时。
 * @param pid 目标进程号。
 * @param deps 激活请求、应用激活状态与时间依赖。
 * @returns 激活请求成功且确认本应用失活时返回 true。
 * @author zhenghq
 */
export async function activateMacosApplicationAndWaitForDeactivation(
  pid: number,
  deps: MacosApplicationActivationDeps
): Promise<boolean> {
  const activated = await deps.activateApplication(pid)
  if (!activated) return false
  const deadline = deps.now() + MACOS_WINDOW_ACTIVATION_TIMEOUT_MS
  while (deps.now() <= deadline) {
    if (!deps.isAppActive()) return true
    if (deps.now() >= deadline) break
    await deps.sleep(MACOS_WINDOW_ACTIVATION_POLL_MS)
  }
  return false
}

/** 进程级激活并重新确认目标窗口的依赖。 */
export interface MacosApplicationWindowActivationDeps {
  /** 请求激活目标进程。 */
  activateApplication: (pid: number) => Promise<boolean>
  /** 重新枚举目标进程窗口并读取全局最前窗口。 */
  enumerateWindows: (pid: number) => Promise<MacosWindowListResult>
  /** 当前时间源。 */
  now: () => number
  /** 等待函数。 */
  sleep: (ms: number) => Promise<void>
}

/**
 * 精确窗口激活失败后按进程激活，并确认同一目标窗口确实成为全局最前窗口。
 *
 * Chrome 的 AX focused/raise 可能不可用，但进程级激活不依赖 AX。由于同进程
 * 可能有多个窗口，激活应用本身不能证明 Cmd+C 会落到入口记录的目标窗口；必须
 * 重新枚举并通过 frontmostPid 与 frontmostWindowNumber 同时匹配目标窗口。
 * 无法确认时返回 failed，调用方仍应保持复制前安全早退。
 * @param snapshot 入口记录的源窗口快照。
 * @param deps 激活、窗口枚举与时间依赖。
 * @returns 已确认同一目标窗口位于最前时返回 exact，否则返回 failed。
 * @author zhenghq
 */
export async function activateMacosApplicationAndConfirmWindow(
  snapshot: FrontmostWindowSnapshot,
  deps: MacosApplicationWindowActivationDeps
): Promise<MacosWindowActivationResult> {
  const activated = await deps.activateApplication(snapshot.pid)
  if (!activated) {
    return { activated: false, confirmed: false, outcome: 'failed', windowMatched: false }
  }

  const deadline = deps.now() + MACOS_WINDOW_ACTIVATION_TIMEOUT_MS
  let lastWindowCount: number | undefined
  let lastWindowMatched = false
  while (deps.now() <= deadline) {
    let windowList: MacosWindowListResult
    try {
      windowList = await deps.enumerateWindows(snapshot.pid)
    } catch {
      return {
        activated: true,
        confirmed: false,
        outcome: 'failed',
        windowCount: lastWindowCount,
        windowMatched: lastWindowMatched
      }
    }
    const windows = windowList.windows
    lastWindowCount = windows.filter((window) =>
      window.pid === snapshot.pid && window.layer === 0
    ).length
    const target = resolveTargetWindow({ windows, pid: snapshot.pid, snapshot })
    lastWindowMatched = target !== null
    if (target &&
        windowList.frontmostPid === snapshot.pid &&
        windowList.frontmostWindowNumber === target.windowNumber) {
      return {
        activated: true,
        confirmed: true,
        outcome: 'exact',
        windowCount: lastWindowCount,
        windowMatched: true
      }
    }
    if (deps.now() >= deadline) break
    await deps.sleep(MACOS_WINDOW_ACTIVATION_POLL_MS)
  }

  return {
    activated: true,
    confirmed: false,
    outcome: 'failed',
    windowCount: lastWindowCount,
    windowMatched: lastWindowMatched
  }
}

/**
 * 通过原生 helper 读取全局最前普通窗口编号。
 *
 * `list` 子命令只依赖 CGWindowList，返回顺序中的第一个普通窗口就是全局最前窗口。
 * 微信不暴露 AXFocusedWindow 时，这是确认 raise 是否生效的可靠依据。
 * @param pid 目标进程号；只用于筛选该进程的普通窗口。
 * @returns 全局最前普通窗口编号；helper 不可用或查询失败时返回 null。
 * @author zhenghq
 */
export async function readFrontmostMacosWindowNumber(pid: number): Promise<number | null> {
  const run = await runWindowHelper(['list', String(pid)])
  return run.ok && typeof run.value.frontmostWindowNumber === 'number'
    ? run.value.frontmostWindowNumber
    : null
}

/** 默认系统依赖。 */
const defaultDeps: MacosWindowActivationDeps = {
  enumerateWindows: enumerateMacosWindows,
  readFrontmostWindowNumber: () => readFrontmostMacosWindowNumber(process.pid),
  raiseWindow: raiseMacosWindow,
  readFocusedWindowNumber: readFocusedMacosWindowNumber,
  openApplication: (bundleId) => {
    execFile('open', ['-b', bundleId], () => {})
    return true
  },
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 在注入复制快捷键前精确激活源窗口。
 *
 * 只要快照带有窗口定位信息，无论目标应用当前枚举到一个还是多个普通窗口，
 * 都先精确匹配并确认目标窗口，必要时只 raise 该窗口。不得因为窗口数量为 1
 * 就改走 `open -b`：Chrome for Testing 等应用会被系统再次拉起一个应用入口，
 * 微信等共享 bundle id 的应用还可能把同进程的其它窗口切到最前。
 * 微信的 AXFocusedWindow 不可用时仍可由 CGWindowList 最前窗口确认。
 * 窗口级快照一旦存在，枚举失败、目标失效、raise 失败或确认超时都不得退化为
 * open -b，否则会让随后注入的 Cmd+C 落错窗口。
 * @param snapshot 源窗口快照。
 * @param deps 可注入系统依赖。
 * @returns 激活结果与窗口定位诊断字段。
 * @author zhenghq
 */
export async function activateMacosWindowSnapshot(
  snapshot: FrontmostWindowSnapshot | null,
  deps: MacosWindowActivationDeps = defaultDeps
): Promise<MacosWindowActivationResult> {
  if (!snapshot || !deps.isProcessAlive(snapshot.pid)) {
    return { activated: false, confirmed: false, outcome: 'app-fallback', windowMatched: false }
  }
  if (snapshot.windowNumber === undefined && !snapshot.bounds) {
    // 入口已明确记录窗口定位失败时，应用级 open -b 可能把同进程的另一个窗口
    // 带到最前，必须返回失败交由 blur 兜底，而不是猜测用户想激活哪个窗口。
    if (snapshot.windowLocate === 'failed') {
      return { activated: false, confirmed: false, outcome: 'failed', windowMatched: false }
    }
    return {
      activated: deps.openApplication(snapshot.bundleId),
      confirmed: false,
      outcome: 'app-fallback',
      windowMatched: false
    }
  }

  let windowList: MacosWindowListResult | null
  try {
    windowList = await deps.enumerateWindows(snapshot.pid)
  } catch {
    windowList = null
  }
  // 枚举失败与“成功枚举但没有窗口”语义不同：前者无法给出可信窗口数量，
  // 必须省略 windowCount 避免把未知误报为 0；同时多窗口快照无法确认目标，
  // 不得走 open -b，否则会切换同进程的另一个窗口。
  if (windowList === null) {
    // 入口快照只能证明记录时窗口身份，不能证明复制前目标窗口仍在前台。
    // 本次枚举失败时无法再次确认，必须安全失败；不得继续注入 Cmd+C，
    // 也不得用 open -b 猜测同进程的其它窗口。
    return {
      activated: false,
      confirmed: false,
      outcome: 'failed',
      windowMatched: false
    }
  }
  const windows = windowList.windows
  const windowCount = windows.filter((window) => window.pid === snapshot.pid && window.layer === 0).length
  const target = resolveTargetWindow({ windows, pid: snapshot.pid, snapshot })
  if (!target) {
    // 复制前重新枚举无法匹配入口记录的窗口时，说明同进程窗口可能已经切换、
    // 移动或关闭。入口旧快照不能证明当前 focused/frontmost 仍是目标窗口，
    // 因此必须安全失败，不得继续注入 Cmd+C 或执行 open -b。
    return {
      activated: false,
      confirmed: false,
      outcome: 'failed',
      windowCount,
      windowMatched: false
    }
  }
  // 目标窗口已经是目标应用当前 focused window，或已是 CGWindowList 最前普通窗口时，
  // 无需再次 raise 或 open -b。微信的 AXFocusedWindow 返回 -25201，只能依赖
  // CGWindowList 顺序兜底，否则会把已在前台的目标窗口误判为需要再次激活。
  // 同一次取词中入口交还与复制兜底会先后调用激活；重复激活会让微信把另一个
  // 同进程窗口带到最前，反而使随后注入的 Cmd+C 落在错误窗口。
  const frontmostWindowNumber = windowList.frontmostPid === snapshot.pid
    ? windowList.frontmostWindowNumber ?? await deps.readFrontmostWindowNumber()
    : null
  // CGWindowList 顺序是微信场景最可靠的判断依据：AXFocusedWindow 会返回 -25201，
  // 且读取本身可能阻塞。先按全局最前普通窗口确认，命中后立即结束，不再读取 AX。
  if (frontmostWindowNumber === target.windowNumber) {
    return {
      activated: true,
      confirmed: true,
      outcome: 'exact',
      windowCount,
      windowMatched: true
    }
  }
  const focusedWindowNumber = await deps.readFocusedWindowNumber(snapshot.pid)
  if (focusedWindowNumber === target.windowNumber) {
    return {
      activated: true,
      confirmed: true,
      outcome: 'exact',
      windowCount,
      windowMatched: true
    }
  }

  const raised = await deps.raiseWindow(snapshot.pid, target.windowNumber)
  if (raised) {
    const deadline = deps.now() + MACOS_WINDOW_ACTIVATION_TIMEOUT_MS
    while (deps.now() <= deadline) {
      // 并行读取两个独立信号，避免 AX 不可用或响应慢时挤占 CGWindowList 确认。
      const [frontmostAfterRaise, focusedAfterRaise] = await Promise.all([
        deps.readFrontmostWindowNumber(),
        deps.readFocusedWindowNumber(snapshot.pid)
      ])
      if (frontmostAfterRaise === target.windowNumber ||
          focusedAfterRaise === target.windowNumber) {
        return {
          activated: true,
          confirmed: true,
          outcome: resolveWindowLocateOutcome({ hasWindow: true, exactMatched: true }),
          windowCount,
          windowMatched: true
        }
      }
      if (deps.now() >= deadline) break
      await deps.sleep(MACOS_WINDOW_ACTIVATION_POLL_MS)
    }
  }

  // raise 已成功发出但确认超时：保留 activated=true，避免入口层再次发起激活；
  // outcome=failed 则明确告诉调用方本次没有确认到目标窗口。raise 本身失败时
  // activated=false，同样不得追加 open -b。
  return {
    activated: raised,
    confirmed: false,
    outcome: 'failed',
    windowCount,
    windowMatched: true
  }
}
