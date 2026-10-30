/** 批量翻译条目在队列中的稳定状态。 */
export type DocumentBatchItemStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'

/** 批量翻译队列中的单个文件。 */
export interface DocumentBatchItem {
  /** 当前窗口内稳定的队列标识。 */
  id: string
  /** 已通过主进程校验的文件绝对路径。 */
  path: string
  /** 用于界面展示的文件名。 */
  name: string
  /** 文件字节数。 */
  size: number
  /** 已识别格式。 */
  format: string
  /** 当前文件处理状态。 */
  status: DocumentBatchItemStatus
  /** 当前文件处理进度，范围为 0 到 100。 */
  progress: number
  /** 终态失败分类。 */
  errorCode?: string
}

/** 可加入批量队列的已批准文件元数据。 */
export type DocumentBatchCandidate = Pick<DocumentBatchItem, 'path' | 'name' | 'size' | 'format'>

/** 批量翻译队列状态。 */
export interface DocumentBatchState {
  /** 当前队列条目。 */
  items: DocumentBatchItem[]
  /** 下一个条目序号。 */
  nextSequence: number
  /** 是否已请求取消整个队列。 */
  cancelled: boolean
}

/** 批量翻译整体进度。 */
export interface DocumentBatchProgress {
  /** 已进入终态的条目数。 */
  completed: number
  /** 队列总条目数。 */
  total: number
  /** 按单文件进度平均计算的整体百分比。 */
  percent: number
  /** 当前运行条目标识。 */
  activeId: string | null
}

/**
 * 创建空批量翻译队列。
 * @returns 初始队列状态。
 * @author zhenghq
 */
export function createDocumentBatchState(): DocumentBatchState {
  return { items: [], nextSequence: 1, cancelled: false }
}

/**
 * 将已批准文件追加到批量队列，并按绝对路径去重。
 * @param state 当前队列状态。
 * @param candidates 待加入的已批准文件。
 * @returns 更新后的新队列状态。
 * @author zhenghq
 */
export function appendDocumentBatchItems(
  state: DocumentBatchState,
  candidates: readonly DocumentBatchCandidate[]
): DocumentBatchState {
  const existingPaths = new Set(state.items.map((item) => item.path))
  const items = [...state.items]
  let nextSequence = state.nextSequence
  for (const candidate of candidates) {
    if (!candidate.path.trim() || existingPaths.has(candidate.path)) continue
    existingPaths.add(candidate.path)
    items.push({
      ...candidate,
      id: `batch-${nextSequence}`,
      status: 'pending',
      progress: 0
    })
    nextSequence += 1
  }
  return { ...state, items, nextSequence }
}

/**
 * 更新指定条目的状态与进度；终态会触发整队取消标记。
 * @param state 当前队列状态。
 * @param itemId 队列条目标识。
 * @param status 新状态。
 * @param progress 可选进度百分比。
 * @param errorCode 可选稳定失败分类。
 * @returns 更新后的新队列状态。
 * @author zhenghq
 */
export function markDocumentBatchItem(
  state: DocumentBatchState,
  itemId: string,
  status: DocumentBatchItemStatus,
  progress?: number,
  errorCode?: string
): DocumentBatchState {
  const normalizedProgress = typeof progress === 'number' && Number.isFinite(progress)
    ? Math.max(0, Math.min(100, progress))
    : undefined
  let changed = false
  const items = state.items.map((item) => {
    if (item.id !== itemId) return item
    changed = true
    return {
      ...item,
      status,
      progress: status === 'completed' || status === 'partial'
        ? 100
        : normalizedProgress ?? item.progress,
      ...(errorCode ? { errorCode } : { errorCode: undefined })
    }
  })
  if (!changed) return state
  return {
    ...state,
    items,
    cancelled: state.cancelled || status === 'cancelled'
  }
}

/**
 * 从队列移除尚未运行的条目；运行中或已结束条目不可移除。
 * @param state 当前队列状态。
 * @param itemId 队列条目标识。
 * @returns 更新后的队列状态；不可移除时返回原状态。
 * @author zhenghq
 */
export function removeDocumentBatchItem(
  state: DocumentBatchState,
  itemId: string
): DocumentBatchState {
  const item = state.items.find((candidate) => candidate.id === itemId)
  if (!item || item.status === 'running') return state
  return { ...state, items: state.items.filter((candidate) => candidate.id !== itemId) }
}

/**
 * 将全部未运行条目标记为取消，并保留已结束文件的结果。
 * @param state 当前队列状态。
 * @returns 更新后的队列状态。
 * @author zhenghq
 */
export function cancelDocumentBatch(state: DocumentBatchState): DocumentBatchState {
  return {
    ...state,
    cancelled: true,
    items: state.items.map((item) =>
      item.status === 'pending' ? { ...item, status: 'cancelled' } : item
    )
  }
}

/**
 * 计算批量队列的整体进度。
 * @param state 当前队列状态。
 * @returns 完成数、总数、整体百分比与当前活动条目。
 * @author zhenghq
 */
export function resolveDocumentBatchProgress(state: DocumentBatchState): DocumentBatchProgress {
  const total = state.items.length
  if (total === 0) return { completed: 0, total: 0, percent: 0, activeId: null }
  const terminal = new Set<DocumentBatchItemStatus>(['completed', 'partial', 'failed', 'cancelled'])
  const completed = state.items.filter((item) => terminal.has(item.status)).length
  const progress = state.items.reduce((sum, item) =>
    sum + (terminal.has(item.status) ? 100 : item.progress), 0)
  return {
    completed,
    total,
    percent: Math.max(0, Math.min(100, Math.round(progress / total))),
    activeId: state.items.find((item) => item.status === 'running')?.id ?? null
  }
}
