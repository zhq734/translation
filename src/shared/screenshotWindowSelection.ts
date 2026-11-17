import type { OcrSelectionBeginPayload } from './types'

/** 候选和正式选区的最小有效边长，单位为 DIP。 */
const MIN_SELECTION_SIZE = 8
/** 严格超过此欧氏距离后，从按下点开始手动绘制，单位为 DIP。 */
const DRAW_THRESHOLD = 3

/** 显示器或窗口的 DIP 矩形；是否全局坐标由调用边界约定。 */
export interface ScreenshotWindowRect {
  x: number
  y: number
  width: number
  height: number
}

/** 当前覆盖层的本屏局部 DIP 坐标。 */
export interface ScreenshotWindowPoint {
  x: number
  y: number
}

/** 系统窗口候选；原生层输出全局 DIP，归一化后传输本屏局部 DIP。 */
export interface ScreenshotWindowCandidate {
  id: string
  appName: string
  bounds: ScreenshotWindowRect
  /** 数值越小越靠前，与窗口面积无关。 */
  zOrder: number
}

/** 尚未锁定时的候选交互阶段；锁定后的编辑交给既有 Renderer。 */
export type ScreenshotWindowSelectionPhase = 'hover' | 'pressed' | 'drawing' | 'locked' | 'cancelled'

/** 不包含 DOM、Electron、标注或 OCR 结果的纯交互状态。 */
export interface ScreenshotWindowSelectionState {
  sessionId: number | null
  /** 普通截图启用候选，快捷 OCR 禁用候选但允许手动绘制。 */
  enabled: boolean
  /** 本屏局部边界，左上角固定为零。 */
  bounds: ScreenshotWindowRect
  candidates: readonly ScreenshotWindowCandidate[]
  phase: ScreenshotWindowSelectionPhase
  cursorPoint: ScreenshotWindowPoint | null
  pressPoint: ScreenshotWindowPoint | null
  /** 仅预览候选，不写入正式选区。 */
  hoverCandidate: ScreenshotWindowCandidate | null
  /** drawing 时为手动绘制预览，locked 时为确认的正式选区。 */
  currentRect: ScreenshotWindowRect | null
}

/** 所有异步和鼠标事件都携带会话序号；重新选择仅在外部完成标注清理确认后发送。 */
export type ScreenshotWindowSelectionEvent =
  | { type: 'snapshot'; payload: { sessionId: number; windowCandidates?: readonly ScreenshotWindowCandidate[] } }
  | { type: 'pointer-move' | 'pointer-down' | 'pointer-up'; sessionId: number; point: ScreenshotWindowPoint }
  | { type: 'reselect'; sessionId: number }
  | { type: 'cancel'; sessionId: number }

/**
 * 检查 DIP 矩形及右下角是否有限且具有正尺寸。
 * @param bounds 待校验的矩形。
 * @returns 所有数值及端点有限且宽高为正时返回 true。
 * @author zhenghq
 */
function isValidRect(bounds: ScreenshotWindowRect): boolean {
  return [bounds.x, bounds.y, bounds.width, bounds.height, bounds.x + bounds.width, bounds.y + bounds.height]
    .every(Number.isFinite) && bounds.width > 0 && bounds.height > 0
}

/**
 * 检查窗口候选的层级和最小可选边界。
 * @param candidate 待校验的候选。
 * @returns 层级有限且边界有效、两边均至少 8 DIP 时返回 true。
 * @author zhenghq
 */
function isValidCandidate(candidate: ScreenshotWindowCandidate): boolean {
  return Number.isFinite(candidate.zOrder) && isValidRect(candidate.bounds) &&
    candidate.bounds.width >= MIN_SELECTION_SIZE && candidate.bounds.height >= MIN_SELECTION_SIZE
}

/**
 * 将全局 DIP 窗口裁剪到目标显示器并转换为本屏局部 DIP，不做物理像素缩放。
 * @param candidates 原生层输出的全局 DIP 候选，保持其输入顺序且不修改原对象。
 * @param displayBounds 当前显示器的全局 DIP 边界。
 * @returns 裁剪后的本屏局部候选；非法、屏外或裁剪后不足 8 DIP 的窗口被过滤。
 * @author zhenghq
 */
export function normalizeScreenshotWindowCandidates(
  candidates: readonly ScreenshotWindowCandidate[],
  displayBounds: ScreenshotWindowRect
): ScreenshotWindowCandidate[] {
  if (!isValidRect(displayBounds)) return []
  const normalized: ScreenshotWindowCandidate[] = []
  for (const candidate of candidates) {
    if (!isValidCandidate(candidate)) continue
    const left = Math.max(candidate.bounds.x, displayBounds.x)
    const top = Math.max(candidate.bounds.y, displayBounds.y)
    const right = Math.min(candidate.bounds.x + candidate.bounds.width, displayBounds.x + displayBounds.width)
    const bottom = Math.min(candidate.bounds.y + candidate.bounds.height, displayBounds.y + displayBounds.height)
    const bounds = {
      x: left - displayBounds.x,
      y: top - displayBounds.y,
      width: right - left,
      height: bottom - top
    }
    const clipped = { ...candidate, bounds }
    if (isValidCandidate(clipped)) normalized.push(clipped)
  }
  return normalized
}

/**
 * 在候选坐标系内选择鼠标下最靠前的有效窗口。
 * @param candidates 候选列表，无需预先排序；与 point 使用相同 DIP 坐标系。
 * @param point 鼠标 DIP 坐标，左上边界包含、右下边界排除。
 * @returns 最小 zOrder 的命中候选原对象；同层级保持首个，未命中或坐标非法返回 null。
 * @author zhenghq
 */
export function hitTestScreenshotWindowCandidate(
  candidates: readonly ScreenshotWindowCandidate[],
  point: ScreenshotWindowPoint
): ScreenshotWindowCandidate | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null
  let hit: ScreenshotWindowCandidate | null = null
  for (const candidate of candidates) {
    if (!isValidCandidate(candidate)) continue
    const { x, y, width, height } = candidate.bounds
    if (point.x >= x && point.y >= y && point.x < x + width && point.y < y + height &&
        (!hit || candidate.zOrder < hit.zOrder)) hit = candidate
  }
  return hit
}

/**
 * 将有限鼠标坐标限制到本屏范围，拒绝异常事件。
 * @param point 鼠标本屏局部 DIP 坐标，可省略。
 * @param bounds 本屏局部边界。
 * @returns 裁剪后的坐标；坐标省略或包含非有限值时返回 null。
 * @author zhenghq
 */
function clampPoint(point: ScreenshotWindowPoint | undefined, bounds: ScreenshotWindowRect): ScreenshotWindowPoint | null {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null
  return { x: Math.max(0, Math.min(bounds.width, point.x)), y: Math.max(0, Math.min(bounds.height, point.y)) }
}

/**
 * 为 begin 初始化全新状态，不继承旧会话候选或正式选区。
 * @param begin 原有 begin 负载，cursorPoint 可省略且为本屏局部 DIP。
 * @returns 候选尚未到达的 hover 状态；快捷 OCR 的 enabled 为 false。
 * @author zhenghq
 */
export function createScreenshotWindowSelectionState(begin: OcrSelectionBeginPayload): ScreenshotWindowSelectionState {
  const bounds = {
    x: 0, y: 0,
    width: Number.isFinite(begin.bounds.width) ? Math.max(0, begin.bounds.width) : 0,
    height: Number.isFinite(begin.bounds.height) ? Math.max(0, begin.bounds.height) : 0
  }
  return {
    sessionId: begin.sessionId,
    enabled: !begin.autoTranslate,
    bounds,
    candidates: [],
    phase: 'hover',
    cursorPoint: clampPoint(begin.cursorPoint, bounds),
    pressPoint: null,
    hoverCandidate: null,
    currentRect: null
  }
}

/**
 * 根据两点构建支持任意拖拽方向的局部矩形。
 * @param start 按下时已经裁剪的本屏 DIP 坐标。
 * @param end 当前已经裁剪的本屏 DIP 坐标。
 * @returns 两点之间的正向矩形，绘制过程中允许不足最小有效尺寸。
 * @author zhenghq
 */
function buildRect(start: ScreenshotWindowPoint, end: ScreenshotWindowPoint): ScreenshotWindowRect {
  return {
    x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y)
  }
}

/**
 * 在不改变原状态的前提下处理候选预览、按下、拖拽、确认和会话清理。
 * @param state 当前状态；locked 后的移动、缩放和标注仍由既有 Renderer 负责。
 * @param event 同会话事件；snapshot 候选必须已经是本屏局部 DIP，reselect 必须已获得外部清理确认。
 * @returns 新状态；旧会话、已取消会话及异常鼠标事件返回原状态，不执行 IPC 或自动 OCR。
 * @author zhenghq
 */
export function reduceScreenshotWindowSelectionState(
  state: ScreenshotWindowSelectionState,
  event: ScreenshotWindowSelectionEvent
): ScreenshotWindowSelectionState {
  const sessionId = event.type === 'snapshot' ? event.payload.sessionId : event.sessionId
  if (state.sessionId === null || state.sessionId !== sessionId) return state
  if (event.type === 'cancel') {
    return {
      ...state, sessionId: null, enabled: false, phase: 'cancelled', candidates: [],
      cursorPoint: null, pressPoint: null, hoverCandidate: null, currentRect: null
    }
  }
  if (event.type === 'reselect') {
    return {
      ...state, phase: 'hover', pressPoint: null, currentRect: null,
      hoverCandidate: state.cursorPoint ? hitTestScreenshotWindowCandidate(state.candidates, state.cursorPoint) : null
    }
  }
  if (event.type === 'snapshot') {
    // IPC 中已经是局部 DIP，仅用零原点边界做有效性过滤与本屏约束，不再减全局坐标。
    const candidates = state.enabled ? normalizeScreenshotWindowCandidates(event.payload.windowCandidates ?? [], state.bounds) : []
    const point = state.phase === 'pressed' ? state.pressPoint : state.cursorPoint
    const hoverCandidate = (state.phase === 'hover' || state.phase === 'pressed') && point
      ? hitTestScreenshotWindowCandidate(candidates, point) : null
    return { ...state, candidates, hoverCandidate }
  }
  const point = clampPoint(event.point, state.bounds)
  if (!point) return state
  if (state.phase === 'locked') return { ...state, cursorPoint: point }
  if (event.type === 'pointer-down') {
    if (state.phase !== 'hover') return state
    return {
      ...state, phase: 'pressed', cursorPoint: point, pressPoint: point,
      hoverCandidate: hitTestScreenshotWindowCandidate(state.candidates, point)
    }
  }
  if (state.phase === 'hover') {
    if (event.type !== 'pointer-move') return state
    return { ...state, cursorPoint: point, hoverCandidate: hitTestScreenshotWindowCandidate(state.candidates, point) }
  }
  const start = state.pressPoint
  if (!start) return state
  const drawing = state.phase === 'drawing' || Math.hypot(point.x - start.x, point.y - start.y) > DRAW_THRESHOLD
  if (event.type === 'pointer-move') {
    return drawing
      ? { ...state, phase: 'drawing', cursorPoint: point, hoverCandidate: null, currentRect: buildRect(start, point) }
      : { ...state, cursorPoint: point }
  }
  // 抬起也检查阈值，防止低采样率或快照尚未就绪时缺失 move 事件造成整窗误锁定。
  const rect = drawing ? buildRect(start, point) : state.hoverCandidate?.bounds ?? null
  if (rect && rect.width >= MIN_SELECTION_SIZE && rect.height >= MIN_SELECTION_SIZE) {
    return {
      ...state, phase: 'locked', cursorPoint: point, pressPoint: null,
      hoverCandidate: null, currentRect: { ...rect }
    }
  }
  return {
    ...state, phase: 'hover', cursorPoint: point, pressPoint: null, currentRect: null,
    hoverCandidate: hitTestScreenshotWindowCandidate(state.candidates, point)
  }
}
