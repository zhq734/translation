import { createHash } from 'node:crypto'
import { normalizeAppIdentifier } from './captureDiagnostics'

/** 屏幕坐标点。 */
export interface ScreenPoint {
  x: number
  y: number
}

/** 窗口在屏幕坐标系中的边界。 */
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** CGWindowList 枚举出的单个窗口信息。 */
export interface MacosWindowInfo {
  /** 窗口所属进程号。 */
  pid: number
  /** CGWindow 窗口编号，窗口生命周期内稳定。 */
  windowNumber: number
  /** 窗口边界（屏幕坐标）。 */
  bounds: WindowBounds
  /** 窗口标题；仅在本地用于生成指纹，不得持久化明文。 */
  title: string
  /** 窗口层级；0 表示普通应用窗口。 */
  layer: number
}

/** CGWindowList 枚举结果，包含目标进程窗口与全局最前普通窗口。 */
export interface MacosWindowListResult {
  /** 目标进程的普通窗口列表，顺序保持 CGWindowList 从前到后。 */
  windows: MacosWindowInfo[]
  /** 全局最前普通窗口编号；无法确定时缺失。 */
  frontmostWindowNumber?: number
  /** 全局最前普通窗口所属进程号；无法确定时缺失。 */
  frontmostPid?: number
}

/** 取词前记录的源窗口快照；窗口字段缺失时表示应用级快照。 */
export interface FrontmostWindowSnapshot {
  /** 应用 bundle id。 */
  bundleId: string
  /** 应用进程号。 */
  pid: number
  /** 窗口编号；应用级快照时缺失。 */
  windowNumber?: number
  /** 窗口边界；应用级快照时缺失。 */
  bounds?: WindowBounds
  /** 标题哈希指纹；应用级或空标题时缺失。 */
  titleFingerprint?: string
  /** 快照采集时间戳（毫秒）。 */
  capturedAt: number
  /** 入口记录阶段的窗口定位结果；failed 表示不得退化为 open -b。 */
  windowLocate?: WindowLocateOutcome
}

/** 窗口定位结果分类，用于诊断打点。 */
export type WindowLocateOutcome = 'exact' | 'app-fallback' | 'failed'

/**
 * 判断屏幕坐标点是否位于窗口边界内（包含边界）。
 * @param bounds 窗口边界。
 * @param point 屏幕坐标点。
 * @returns 点位于边界内时返回 true。
 * @author zhenghq
 */
export function containsPoint(bounds: WindowBounds, point: ScreenPoint): boolean {
  return point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
}

/**
 * 生成窗口标题的稳定哈希指纹。
 * 只用于同一窗口的本地身份校验，禁止把标题明文写入快照或诊断。
 * @param title 窗口标题。
 * @returns SHA-256 前 12 位十六进制；空标题返回空串。
 * @author zhenghq
 */
export function createWindowTitleFingerprint(title: unknown): string {
  if (typeof title !== 'string' || !title.trim()) return ''
  return createHash('sha256').update(title.trim()).digest('hex').slice(0, 12)
}

/**
 * 判断两个窗口边界是否完全一致。
 * @param left 左边界。
 * @param right 右边界。
 * @returns 四元组完全一致时返回 true。
 * @author zhenghq
 */
function boundsEqual(left: WindowBounds, right: WindowBounds): boolean {
  return left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
}

/**
 * 判断窗口是否可作为取词目标：普通层级且属于指定进程。
 * @param window 窗口信息。
 * @param pid 目标进程号。
 * @returns 可作为目标时返回 true。
 * @author zhenghq
 */
function isTargetableWindow(window: MacosWindowInfo, pid: number): boolean {
  return window.pid === pid && window.layer === 0 && window.bounds.width > 0 && window.bounds.height > 0
}

/**
 * 按快照定位窗口：窗口编号优先，编号失效后回退到边界 + 标题指纹。
 * 快照明确指向窗口但两种方式都无法匹配时返回 null，由调用方退化为应用级。
 * @param windows 候选窗口列表。
 * @param snapshot 窗口级快照。
 * @param pid 目标进程号。
 * @returns 匹配到的窗口；未匹配返回 null。
 * @author zhenghq
 */
function resolveWindowBySnapshot(
  windows: readonly MacosWindowInfo[],
  snapshot: FrontmostWindowSnapshot,
  pid: number
): MacosWindowInfo | null {
  const candidates = windows.filter((window) => isTargetableWindow(window, pid))
  if (snapshot.windowNumber !== undefined) {
    const matchedByNumber = candidates.find((window) => window.windowNumber === snapshot.windowNumber)
    if (matchedByNumber) return matchedByNumber
  }
  if (snapshot.bounds) {
    return candidates.find((window) =>
      boundsEqual(window.bounds, snapshot.bounds as WindowBounds) &&
      (!snapshot.titleFingerprint ||
        createWindowTitleFingerprint(window.title) === snapshot.titleFingerprint)
    ) ?? null
  }
  return null
}

/**
 * 按坐标选择目标窗口：保留 CGWindowList 从前到后的顺序，返回首个包含该点的普通窗口。
 *
 * 微信与 Chrome for Testing 的同进程窗口可能几乎完全重叠，面积差异只是窗口
 * 尺寸噪声；若按面积重排会把后台窗口误当成用户正在操作的窗口。CGWindowList
 * 的返回顺序才是系统提供的层级权威信号，因此坐标命中后不得再次排序。
 * @param windows 候选窗口列表，顺序必须保持 CGWindowList 从前到后。
 * @param point 屏幕坐标点。
 * @param pid 目标进程号。
 * @returns 命中的窗口；无命中返回 null。
 * @author zhenghq
 */
function resolveWindowByPoint(
  windows: readonly MacosWindowInfo[],
  point: ScreenPoint,
  pid: number
): MacosWindowInfo | null {
  return windows.find((window) =>
    isTargetableWindow(window, pid) && containsPoint(window.bounds, point)
  ) ?? null
}

/**
 * 解析取词目标窗口：优先使用快照精确匹配，否则按坐标命中。
 * @param options 候选窗口、目标进程、坐标或快照。
 * @returns 目标窗口；无法定位返回 null。
 * @author zhenghq
 */
export function resolveTargetWindow(options: {
  windows: readonly MacosWindowInfo[]
  pid: number
  point?: ScreenPoint
  snapshot?: FrontmostWindowSnapshot
}): MacosWindowInfo | null {
  const { windows, pid, point, snapshot } = options
  if (snapshot) return resolveWindowBySnapshot(windows, snapshot, pid)
  if (point) return resolveWindowByPoint(windows, point, pid)
  return null
}

/**
 * 解析一次取词应使用的目标窗口，并生成入口诊断所需的窗口数量与定位结果。
 * 窗口枚举成功且仅有一个普通窗口时，坐标未命中属于正常的应用级退化；多窗口
 * 场景下坐标未命中或快照未命中都无法确认用户目标窗口，必须归类为 failed，
 * 禁止上层用应用级 open -b 猜测并切换到同进程的其它窗口。
 * @param options 候选窗口、目标进程、坐标或窗口快照。
 * @returns 目标窗口、普通窗口数量、是否命中以及窗口定位结果。
 * @author zhenghq
 */
export function resolveWindowCaptureTarget(options: {
  windows: readonly MacosWindowInfo[] | null
  pid: number
  point?: ScreenPoint
  snapshot?: FrontmostWindowSnapshot
}): {
  windowCount?: number
  windowMatched: boolean
  window: MacosWindowInfo | null
  outcome: WindowLocateOutcome
} {
  if (options.windows === null) {
    return {
      windowCount: undefined,
      windowMatched: false,
      window: null,
      outcome: 'failed'
    }
  }
  const windowCount = options.windows.filter((window) => isTargetableWindow(window, options.pid)).length
  const window = resolveTargetWindow({ ...options, windows: options.windows })
  const windowMatched = window !== null
  // 多窗口应用共享 bundle id 时，坐标未命中意味着无法确认用户操作的是哪个窗口。
  // 此时必须标记 failed，禁止上层用应用级 open -b 猜测目标并切到同进程其它窗口。
  const outcome = windowMatched
    ? resolveWindowLocateOutcome({ hasWindow: true, exactMatched: true })
    : windowCount > 1
      ? 'failed'
      : resolveWindowLocateOutcome({
          hasWindow: options.snapshot !== undefined,
          exactMatched: false
        })
  return {
    windowCount,
    windowMatched,
    window,
    outcome
  }
}

/**
 * 构建窗口级快照；缺少窗口信息时退化为只含应用字段的快照。
 * @param options 应用与窗口信息。
 * @returns 规范化后的源窗口快照。
 * @author zhenghq
 */
export function buildFrontmostWindowSnapshot(options: {
  bundleId: string
  pid: number
  window: MacosWindowInfo | null
  capturedAt: number
  windowLocate?: WindowLocateOutcome
}): FrontmostWindowSnapshot {
  const snapshot: FrontmostWindowSnapshot = {
    bundleId: normalizeAppIdentifier(options.bundleId),
    pid: options.pid,
    capturedAt: options.capturedAt
  }
  if (options.windowLocate) snapshot.windowLocate = options.windowLocate
  if (!options.window || options.window.pid !== options.pid || options.window.layer !== 0) {
    return snapshot
  }
  snapshot.windowNumber = options.window.windowNumber
  snapshot.bounds = { ...options.window.bounds }
  const fingerprint = createWindowTitleFingerprint(options.window.title)
  if (fingerprint) snapshot.titleFingerprint = fingerprint
  return snapshot
}

/**
 * 将窗口定位状态归类为诊断结果。
 * @param options 是否存在窗口快照、是否精确命中。
 * @returns 精确命中、应用级退化或定位失败。
 * @author zhenghq
 */
export function resolveWindowLocateOutcome(options: {
  hasWindow: boolean
  exactMatched: boolean
}): WindowLocateOutcome {
  if (options.exactMatched) return 'exact'
  return options.hasWindow ? 'failed' : 'app-fallback'
}
