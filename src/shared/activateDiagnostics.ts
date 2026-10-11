/**
 * activate 来源诊断的共享模型与纯函数。
 *
 * 本模块不依赖 Electron 运行时，只负责构造、校验、序列化与离线对齐诊断记录，
 * 使 macOS 应用级 activate 事件可以被追溯到具体候选动作，同时把敏感字段挡在
 * 日志之外。所有打点均为只读诊断，不得影响窗口行为。
 *
 * @author zhenghq
 */

/** activate 事件的放行/拦截判定。 */
export type ActivateDecision = 'allow' | 'ignore'

/** 候选动作枚举，覆盖所有已知可能间接触发应用级 activate 的路径。 */
export const CANDIDATE_ACTIONS = [
  'dock-show-sync-before',
  'dock-show-sync-after',
  'dock-show-delayed',
  'settings-activate-entry',
  'settings-reuse-raise',
  'popup-show',
  'popup-show-inactive',
  'popup-hide',
  'selection-button-show-inactive',
  'selection-button-hide'
] as const

/** 候选动作名称。 */
export type CandidateAction = (typeof CANDIDATE_ACTIONS)[number]

/** 诊断记录构造失败的稳定错误码，便于调用方静默降级并保持可观测。 */
export type ActivateDiagnosticError =
  | 'invalid-timestamp'
  | 'missing-stack'
  | 'missing-reason'
  | 'invalid-decision'
  | 'sensitive-field'
  | 'invalid-action'
  | 'invalid-window-visible'

/** activate 事件允许进入日志的白名单标量字段。 */
export interface ActivateEventSnapshot {
  /** macOS 事件回调提供的“是否存在可见窗口”标记。 */
  hasVisibleWindows?: boolean
}

/** activate 来源诊断记录。 */
export interface ActivateSourceRecord {
  /** 记录类型固定为 activate。 */
  kind: 'activate'
  /** 精确到毫秒的本地时间戳。 */
  timestampMs: number
  /** 放行或拦截判定。 */
  decision: ActivateDecision
  /** 拦截原因，仅 ignore 时存在。 */
  reason?: string
  /** 同步调用栈，必须在进入异步边界之前采集。 */
  stack: string
  /** 白名单内的事件字段快照。 */
  event?: ActivateEventSnapshot
}

/** 候选动作诊断记录。 */
export interface CandidateProbeRecord {
  /** 记录类型固定为 candidate。 */
  kind: 'candidate'
  /** 精确到毫秒的本地时间戳。 */
  timestampMs: number
  /** 候选动作名称。 */
  action: CandidateAction
  /** 打点时刻目标窗口的可见性布尔值。 */
  windowVisible: boolean
}

/** 诊断记录联合类型。 */
export type ActivateDiagnosticRecord = ActivateSourceRecord | CandidateProbeRecord

/** 记录构造结果；失败时返回稳定错误码而不是抛出异常。 */
export type ActivateDiagnosticResult<T> =
  | { ok: true; record: T }
  | { ok: false; error: ActivateDiagnosticError }

/** activate 记录构造入参。 */
export interface CreateActivateSourceRecordInput {
  /** 精确到毫秒的本地时间戳。 */
  timestampMs: number
  /** 放行或拦截判定。 */
  decision: ActivateDecision
  /** 拦截原因，仅 ignore 时必填。 */
  reason?: string
  /** 同步调用栈。 */
  stack: string
  /** 事件回调字段；仅白名单内字段会被保留。 */
  event?: Record<string, unknown>
}

/** 候选打点记录构造入参。 */
export interface CreateCandidateProbeRecordInput {
  /** 精确到毫秒的本地时间戳。 */
  timestampMs: number
  /** 候选动作名称。 */
  action: CandidateAction
  /** 打点时刻目标窗口的可见性布尔值。 */
  windowVisible: boolean
}

/** 对齐算法选项。 */
export interface AlignActivateDiagnosticsOptions {
  /** 候选打点有效时间窗口，默认 60 秒。 */
  windowMs?: number
  /** 每个 activate 最多关联的最近候选数量，默认 3 条。 */
  maxCandidates?: number
}

/** 单个 activate 与其近邻候选的对齐结果。 */
export interface ActivateDiagnosticAlignment {
  /** 被对齐的 activate 记录。 */
  activate: ActivateSourceRecord
  /** 窗口内最近的候选打点及时间差（activate 时间减候选时间）。 */
  candidates: { record: CandidateProbeRecord; deltaMs: number }[]
  /** 窗口内没有任何候选时为 true，用于显式标注“无近邻候选”。 */
  noNearbyCandidate: boolean
}

/** 日志前缀，便于离线脚本按行提取。 */
export const ACTIVATE_DIAGNOSTIC_PREFIX = '[activate-diagnostics]'

/** 调用栈最多保留的帧数，避免日志被 Chromium 内部帧淹没。 */
const MAX_STACK_FRAMES = 12

/** 敏感字段名模式；命中即拒绝该条记录，避免隐私内容进入日志。 */
const SENSITIVE_FIELD_PATTERN = /selectedtext|clipboard|windowtitle|selectiontext|windowtitle|title/iu

/**
 * 采集当前同步调用栈并截断为前若干帧。
 * @param maxFrames 最多保留的帧数，省略时使用默认值。
 * @returns 截断后的调用栈字符串；采集失败时返回空字符串。
 * @author zhenghq
 */
export function captureSyncStack(maxFrames = MAX_STACK_FRAMES): string {
  const stack = new Error().stack
  if (!stack) return ''
  const lines = stack.split('\n')
  const header = lines[0] ?? 'Error'
  const frames = lines.slice(1, Math.max(1, maxFrames + 1))
  return [header, ...frames].join('\n')
}

/**
 * 构造并校验一条 activate 来源诊断记录。
 * @param input activate 记录入参。
 * @returns 成功时返回记录，失败时返回稳定错误码。
 * @author zhenghq
 */
export function createActivateSourceRecord(
  input: CreateActivateSourceRecordInput
): ActivateDiagnosticResult<ActivateSourceRecord> {
  if (!Number.isFinite(input.timestampMs)) {
    return { ok: false, error: 'invalid-timestamp' }
  }
  if (input.decision !== 'allow' && input.decision !== 'ignore') {
    return { ok: false, error: 'invalid-decision' }
  }
  if (!input.stack || input.stack.trim() === '') {
    return { ok: false, error: 'missing-stack' }
  }
  if (input.decision === 'ignore' && !input.reason) {
    return { ok: false, error: 'missing-reason' }
  }
  if (input.event && containsSensitiveField(input.event)) {
    return { ok: false, error: 'sensitive-field' }
  }

  const event = snapshotEvent(input.event)
  return {
    ok: true,
    record: {
      kind: 'activate',
      timestampMs: input.timestampMs,
      decision: input.decision,
      ...(input.decision === 'ignore' ? { reason: input.reason } : {}),
      stack: input.stack,
      ...(event ? { event } : {})
    }
  }
}

/**
 * 构造并校验一条候选动作诊断记录。
 * @param input 候选打点入参。
 * @returns 成功时返回记录，失败时返回稳定错误码。
 * @author zhenghq
 */
export function createCandidateProbeRecord(
  input: CreateCandidateProbeRecordInput
): ActivateDiagnosticResult<CandidateProbeRecord> {
  if (!Number.isFinite(input.timestampMs)) {
    return { ok: false, error: 'invalid-timestamp' }
  }
  if (!CANDIDATE_ACTIONS.includes(input.action)) {
    return { ok: false, error: 'invalid-action' }
  }
  if (typeof input.windowVisible !== 'boolean') {
    return { ok: false, error: 'invalid-window-visible' }
  }
  return {
    ok: true,
    record: {
      kind: 'candidate',
      timestampMs: input.timestampMs,
      action: input.action,
      windowVisible: input.windowVisible
    }
  }
}

/**
 * 把诊断记录序列化为单行结构化日志。
 * @param record 需要输出的诊断记录。
 * @returns 单行日志字符串。
 * @author zhenghq
 */
export function formatActivateDiagnosticLog(record: ActivateDiagnosticRecord): string {
  return `${ACTIVATE_DIAGNOSTIC_PREFIX} ${JSON.stringify(record)}`
}

/**
 * 采集并输出一条候选动作打点。
 *
 * 本函数为只读诊断：内部捕获所有异常并静默返回，绝不抛出、不返回 Promise，
 * 也不会插入异步边界，保证调用方的窗口显隐顺序与返回值完全不变。
 * @param action 候选动作名称。
 * @param windowVisible 打点时刻目标窗口的可见性布尔值。
 * @param timestampMs 精确到毫秒的本地时间戳，省略时取当前时间。
 * @returns 无返回值。
 * @author zhenghq
 */
export function logCandidateProbe(
  action: CandidateAction,
  windowVisible: boolean,
  timestampMs: number = Date.now()
): void {
  try {
    const result = createCandidateProbeRecord({ timestampMs, action, windowVisible })
    if (result.ok) {
      console.log(formatActivateDiagnosticLog(result.record))
    }
  } catch {
    // 诊断失败必须静默降级，不得影响窗口流程。
  }
}

/**
 * 把 activate 与候选打点离线对齐。
 *
 * 输入允许乱序，函数内部按时间稳定排序；每个 activate 关联其之前
 * `windowMs` 窗口内最近的若干候选打点，并统一按时间差升序输出（最近候选在前），
 * 窗口内没有候选时显式标注 `noNearbyCandidate`，不静默省略该行。
 * @param records 诊断记录序列。
 * @param options 对齐窗口与候选数量选项。
 * @returns 按 activate 时间升序排列的对齐结果。
 * @author zhenghq
 */
export function alignActivatesWithCandidates(
  records: readonly ActivateDiagnosticRecord[],
  options: AlignActivateDiagnosticsOptions = {}
): ActivateDiagnosticAlignment[] {
  const windowMs = options.windowMs ?? 60_000
  const maxCandidates = Math.max(1, options.maxCandidates ?? 3)
  const sorted = [...records].sort((left, right) => left.timestampMs - right.timestampMs)
  const candidates = sorted.filter(
    (record): record is CandidateProbeRecord => record.kind === 'candidate'
  )
  const activates = sorted.filter(
    (record): record is ActivateSourceRecord => record.kind === 'activate'
  )

  return activates.map((activate) => {
    const matched = candidates
      .filter((candidate) => {
        const deltaMs = activate.timestampMs - candidate.timestampMs
        return deltaMs >= 0 && deltaMs <= windowMs
      })
      .slice(-maxCandidates)
      .map((record) => ({ record, deltaMs: activate.timestampMs - record.timestampMs }))
      // 最近候选优先，时间差相同时按时间戳稳定排序，保证离线对齐结果可复现。
      .sort((left, right) => left.deltaMs - right.deltaMs || left.record.timestampMs - right.record.timestampMs)
    return { activate, candidates: matched, noNearbyCandidate: matched.length === 0 }
  })
}

/**
 * 从一行主进程日志中解析诊断记录。
 *
 * 只接受带 `[activate-diagnostics]` 前缀且 JSON 合法的行；其它日志行返回 null，
 * 便于离线脚本直接逐行处理真实日志。解析失败不抛出异常。
 * @param line 单行日志文本。
 * @returns 解析成功时返回诊断记录，否则返回 null。
 * @author zhenghq
 */
export function parseActivateDiagnosticLogLine(line: string): ActivateDiagnosticRecord | null {
  const markerIndex = line.indexOf(ACTIVATE_DIAGNOSTIC_PREFIX)
  if (markerIndex < 0) return null
  const jsonText = line.slice(markerIndex + ACTIVATE_DIAGNOSTIC_PREFIX.length).trim()
  if (jsonText === '') return null
  try {
    const parsed: unknown = JSON.parse(jsonText)
    return isActivateDiagnosticRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 判断解析结果是否为合法的诊断记录。
 * @param value 待校验值。
 * @returns 结构合法时返回 true。
 * @author zhenghq
 */
function isActivateDiagnosticRecord(value: unknown): value is ActivateDiagnosticRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (!Number.isFinite(record['timestampMs'])) return false
  if (record['kind'] === 'activate') {
    return (record['decision'] === 'allow' || record['decision'] === 'ignore') &&
      typeof record['stack'] === 'string'
  }
  if (record['kind'] === 'candidate') {
    return CANDIDATE_ACTIONS.includes(record['action'] as CandidateAction) &&
      typeof record['windowVisible'] === 'boolean'
  }
  return false
}

/**
 * 判断事件字段对象是否包含敏感字段名。
 * @param event 待检查的事件字段对象。
 * @returns 命中敏感字段时返回 true。
 * @author zhenghq
 */
function containsSensitiveField(event: Record<string, unknown>): boolean {
  return Object.keys(event).some((key) => SENSITIVE_FIELD_PATTERN.test(key))
}

/**
 * 按白名单提取事件字段快照。
 * @param event 原始事件字段对象；允许为空。
 * @returns 仅含白名单字段的快照；没有任何白名单字段时返回 undefined。
 * @author zhenghq
 */
function snapshotEvent(event?: Record<string, unknown>): ActivateEventSnapshot | undefined {
  if (!event) return undefined
  const snapshot: ActivateEventSnapshot = {}
  if (typeof event['hasVisibleWindows'] === 'boolean') {
    snapshot.hasVisibleWindows = event['hasVisibleWindows']
  }
  return Object.keys(snapshot).length > 0 ? snapshot : undefined
}
