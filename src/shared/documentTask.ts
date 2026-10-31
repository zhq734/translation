import type { DocumentTaskPhase, DocumentTaskStatus } from './documentTypes.ts'

/** 文档任务按固定顺序执行的阶段。 */
export const DOCUMENT_TASK_PHASES: readonly DocumentTaskPhase[] = [
  'validate',
  'parse',
  'ocr',
  'translate',
  'layout',
  'export'
]

/** 各阶段在总进度中的权重，总和为 100。 */
const PHASE_WEIGHTS: Readonly<Record<DocumentTaskPhase, number>> = {
  validate: 2,
  parse: 8,
  ocr: 20,
  translate: 55,
  layout: 10,
  export: 5
}

/** 阶段对应的运行状态。 */
const PHASE_STATUS: Readonly<Record<DocumentTaskPhase, DocumentTaskStatus>> = {
  validate: 'validating',
  parse: 'parsing',
  ocr: 'ocr',
  translate: 'translating',
  layout: 'rendering',
  export: 'exporting'
}

/** 任务内单个阶段的进度。 */
export interface DocumentTaskProgress {
  /** 已完成单位数。 */
  completed: number
  /** 总单位数；零表示当前阶段尚无总量。 */
  total: number
}

/** 可恢复的文档任务状态。 */
export interface DocumentTaskState {
  /** 当前任务标识。 */
  jobId: string
  /** 当前任务代际，切换文件或重试时递增。 */
  generation: number
  /** 当前阶段。 */
  phase: DocumentTaskPhase
  /** 整体运行状态。 */
  status: DocumentTaskStatus
  /** 当前阶段进度。 */
  progress: DocumentTaskProgress
  /** 是否已经请求取消。 */
  cancellationRequested: boolean
  /** 失败块数量。 */
  failedBlocks: number
  /** 告警数量。 */
  warningCount: number
  /** 失败分类，仅失败状态携带。 */
  errorCode?: string
  /** 当前阶段是否已完成，用于阶段间进度归属。 */
  phaseCompleted: boolean
}

/** 部分完成统计。 */
export interface DocumentTaskPartialSummary {
  /** 失败块数量。 */
  failedBlocks: number
  /** 告警数量。 */
  warningCount: number
}

/**
 * 创建处于文件校验阶段的初始任务状态。
 * @param jobId 任务标识。
 * @param generation 任务代际。
 * @returns 初始任务状态。
 * @author zhenghq
 */
export function createDocumentTaskState(jobId: string, generation: number): DocumentTaskState {
  if (!jobId.trim()) throw new Error('document task jobId must not be empty')
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error('document task generation must be a positive integer')
  }
  return {
    jobId,
    generation,
    phase: 'validate',
    status: 'validating',
    progress: { completed: 0, total: 0 },
    cancellationRequested: false,
    failedBlocks: 0,
    warningCount: 0,
    phaseCompleted: false
  }
}

/**
 * 判断任务是否已进入不可继续推进的终态。
 * @param state 当前任务状态。
 * @returns 是否为终态。
 * @author zhenghq
 */
function isTerminalStatus(state: DocumentTaskState): boolean {
  return state.status === 'completed' ||
    state.status === 'partial' ||
    state.status === 'cancelled' ||
    state.status === 'failed'
}

/**
 * 获取阶段在固定顺序中的索引。
 * @param phase 文档任务阶段。
 * @returns 阶段索引。
 * @author zhenghq
 */
function phaseIndex(phase: DocumentTaskPhase): number {
  return DOCUMENT_TASK_PHASES.indexOf(phase)
}

/**
 * 将任务推进到下一个阶段；只允许按固定顺序前进一步。
 * @param state 当前任务状态。
 * @param nextPhase 目标阶段。
 * @returns 推进后的新状态。
 * @author zhenghq
 */
export function moveDocumentTaskToPhase(
  state: DocumentTaskState,
  nextPhase: DocumentTaskPhase
): DocumentTaskState {
  if (isTerminalStatus(state)) throw new Error('document task is in a terminal status')
  const currentIndex = phaseIndex(state.phase)
  const nextIndex = phaseIndex(nextPhase)
  if (nextIndex !== currentIndex + 1) {
    throw new Error(`document task phase transition is invalid: ${state.phase} -> ${nextPhase}`)
  }
  return {
    ...state,
    phase: nextPhase,
    status: PHASE_STATUS[nextPhase],
    progress: { completed: 0, total: 0 },
    errorCode: undefined,
    phaseCompleted: false
  }
}

/**
 * 规范化阶段内进度，避免负数、NaN 和完成数超过总量。
 * @param progress 原始阶段进度。
 * @returns 规范化后的进度。
 * @author zhenghq
 */
function normalizeProgress(progress: DocumentTaskProgress): DocumentTaskProgress {
  const total = Number.isFinite(progress.total) && progress.total > 0
    ? Math.floor(progress.total)
    : 0
  if (total === 0) return { completed: 0, total: 0 }
  const completed = Number.isFinite(progress.completed)
    ? Math.min(total, Math.max(0, Math.floor(progress.completed)))
    : 0
  return { completed, total }
}

/**
 * 更新当前阶段进度，并保证阶段内完成数单调不减。
 * @param state 当前任务状态。
 * @param nextProgress 新进度。
 * @returns 更新后的新状态。
 * @author zhenghq
 */
export function updateDocumentTaskProgress(
  state: DocumentTaskState,
  nextProgress: DocumentTaskProgress
): DocumentTaskState {
  if (isTerminalStatus(state)) return state
  const normalized = normalizeProgress(nextProgress)
  const previous = state.progress
  if (normalized.total === 0 && previous.total > 0) {
    return state
  }
  if (normalized.total > 0 && previous.total > 0 && normalized.total < previous.total) {
    return state
  }
  if (normalized.total > 0 && previous.total > 0 && normalized.total === previous.total && normalized.completed < previous.completed) {
    return state
  }
  return { ...state, progress: normalized }
}

/**
 * 标记当前阶段完成；阶段内已有进度保持不变。
 * @param state 当前任务状态。
 * @returns 带有阶段完成标记的新状态。
 * @author zhenghq
 */
export function completeDocumentTaskPhase(
  state: DocumentTaskState
): DocumentTaskState {
  if (isTerminalStatus(state)) return state
  return { ...state, phaseCompleted: true }
}

/**
 * 计算当前阶段进度占总进度的百分比。
 * @param state 当前任务状态。
 * @returns 0 到 100 的总进度。
 * @author zhenghq
 */
export function calculateDocumentTaskProgress(state: DocumentTaskState): number {
  if (state.status === 'completed') return 100
  return calculateRunningProgress(state)
}

/**
 * 根据阶段权重和阶段内比例计算总进度。
 * @param state 当前任务状态。
 * @returns 0 到 100 的总进度。
 * @author zhenghq
 */
function calculateRunningProgress(state: DocumentTaskState): number {
  const index = phaseIndex(state.phase)
  if (index < 0) return 0
  const priorWeight = DOCUMENT_TASK_PHASES
    .slice(0, index)
    .reduce((sum, phase) => sum + PHASE_WEIGHTS[phase], 0)
  const ratio = state.progress.total > 0
    ? Math.min(1, Math.max(0, state.progress.completed / state.progress.total))
    : 0
  const phaseProgress = state.phaseCompleted ? PHASE_WEIGHTS[state.phase] : PHASE_WEIGHTS[state.phase] * ratio
  return Math.min(100, Math.max(0, priorWeight + phaseProgress))
}

/**
 * 将任务标记为成功完成，保留失败块与告警统计。
 * @param state 当前任务状态。
 * @param summary 可选的失败块与告警统计。
 * @returns 成功完成状态。
 * @author zhenghq
 */
export function completeDocumentTask(
  state: DocumentTaskState,
  summary: DocumentTaskPartialSummary = {
    failedBlocks: state.failedBlocks,
    warningCount: state.warningCount
  }
): DocumentTaskState {
  if (state.status === 'cancelled') return state
  return {
    ...state,
    status: 'completed',
    phaseCompleted: true,
    progress: { completed: 1, total: 1 },
    failedBlocks: Math.max(0, Math.floor(summary.failedBlocks)),
    warningCount: Math.max(0, Math.floor(summary.warningCount))
  }
}

/**
 * 请求取消任务并保留当前进度；重复调用保持幂等。
 * @param state 当前任务状态。
 * @returns 已请求取消的状态。
 * @author zhenghq
 */
export function requestDocumentTaskCancellation(state: DocumentTaskState): DocumentTaskState {
  if (isTerminalStatus(state)) return state
  return { ...state, status: 'cancelled', cancellationRequested: true }
}

/**
 * 将任务标记为失败并保留已有进度。
 * @param state 当前任务状态。
 * @param errorCode 脱敏后的错误分类。
 * @returns 失败状态。
 * @author zhenghq
 */
export function failDocumentTask(state: DocumentTaskState, errorCode: string): DocumentTaskState {
  if (!errorCode.trim()) throw new Error('document task errorCode must not be empty')
  if (state.status === 'cancelled') return state
  return { ...state, status: 'failed', errorCode }
}

/**
 * 标记任务部分完成，用于保留成功块并允许后续重试失败块。
 * @param state 当前任务状态。
 * @param summary 失败块与告警统计。
 * @returns 部分完成状态。
 * @author zhenghq
 */
export function markDocumentTaskPartial(
  state: DocumentTaskState,
  summary: DocumentTaskPartialSummary
): DocumentTaskState {
  if (isTerminalStatus(state)) return state
  return {
    ...state,
    status: 'partial',
    failedBlocks: Math.max(0, Math.floor(summary.failedBlocks)),
    warningCount: Math.max(0, Math.floor(summary.warningCount))
  }
}

/**
 * 判断异步事件是否属于当前任务代际且任务仍接受事件。
 * @param state 当前任务状态。
 * @param jobId 事件携带的任务标识。
 * @param generation 事件携带的代际。
 * @returns 是否可以应用事件。
 * @author zhenghq
 */
export function canApplyDocumentTaskEvent(
  state: DocumentTaskState,
  jobId: string,
  generation: number
): boolean {
  return !isTerminalStatus(state) && state.jobId === jobId && state.generation === generation
}
