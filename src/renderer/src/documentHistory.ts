import type { DocumentHistoryEntry } from '../../shared/documentWorkspace'
import type { DocumentWorkspaceTab } from './documentUiModel'

/** 文件翻译历史最多保留的条目数，避免本地存储无限增长。 */
export const DOCUMENT_FILE_HISTORY_LIMIT = 20

/** 文件翻译历史在 Renderer 本地存储中的键名。 */
export const DOCUMENT_FILE_HISTORY_STORAGE_KEY = 'selection-translator.document-file-history'

/** 可快速切换的文件翻译历史记录。 */
export interface DocumentFileHistoryEntry {
  /** 已通过主进程校验的本地文件绝对路径。 */
  path: string
  /** 用于界面展示的文件名。 */
  name: string
  /** 文件字节数。 */
  size: number
  /** 已识别格式。 */
  format: string
  /** 最近一次选择该文件的时间戳。 */
  lastUsedAt: number
}

/** 文件历史下拉中的统一条目；任务历史可只读回放，文件历史可重新授权并开始任务。 */
export type DocumentHistoryListItem =
  | {
    /** 任务历史条目。 */
    kind: 'task'
    /** 任务标识。 */
    jobId: string
    /** 最近更新时间。 */
    updatedAt: number
    /** 完整任务摘要。 */
    task: DocumentHistoryEntry
  }
  | {
    /** 本地文件历史条目。 */
    kind: 'file'
    /** 文件绝对路径。 */
    path: string
    /** 最近使用时间。 */
    updatedAt: number
    /** 文件元数据。 */
    file: DocumentFileHistoryEntry
  }

/**
 * 判断一个未知值是否为有效的文件翻译历史记录。
 * @param value 待检查的存储值。
 * @returns 字段完整且类型有效时返回 true。
 * @author zhenghq
 */
function isDocumentFileHistoryEntry(value: unknown): value is DocumentFileHistoryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<DocumentFileHistoryEntry>
  return typeof entry.path === 'string' && entry.path.trim().length > 0 &&
    typeof entry.name === 'string' && entry.name.trim().length > 0 &&
    typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size >= 0 &&
    typeof entry.format === 'string' && entry.format.trim().length > 0 &&
    typeof entry.lastUsedAt === 'number' && Number.isFinite(entry.lastUsedAt) && entry.lastUsedAt >= 0
}

/**
 * 规范化本地历史数据：过滤损坏条目、按路径去重、按最近使用排序并限制数量。
 * @param value 从本地存储读取的未知数据。
 * @returns 可安全用于界面渲染的历史记录。
 * @author zhenghq
 */
export function normalizeDocumentFileHistory(value: unknown): DocumentFileHistoryEntry[] {
  if (!Array.isArray(value)) return []
  const byPath = new Map<string, DocumentFileHistoryEntry>()
  for (const candidate of value) {
    if (!isDocumentFileHistoryEntry(candidate)) continue
    const entry: DocumentFileHistoryEntry = {
      path: candidate.path,
      name: candidate.name.trim(),
      size: candidate.size,
      format: candidate.format.trim().toLowerCase(),
      lastUsedAt: candidate.lastUsedAt
    }
    const previous = byPath.get(entry.path)
    if (!previous || previous.lastUsedAt < entry.lastUsedAt) byPath.set(entry.path, entry)
  }
  return [...byPath.values()]
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
    .slice(0, DOCUMENT_FILE_HISTORY_LIMIT)
}

/**
 * 记录一次成功的文件选择，并把该文件移动到历史列表顶部。
 * @param currentEntries 当前历史记录。
 * @param selection 本次成功选择的文件元数据。
 * @param lastUsedAt 本次选择时间戳。
 * @returns 更新后的历史记录。
 * @author zhenghq
 */
export function recordDocumentFileHistory(
  currentEntries: readonly DocumentFileHistoryEntry[],
  selection: Pick<DocumentFileHistoryEntry, 'path' | 'name' | 'size' | 'format'>,
  lastUsedAt: number
): DocumentFileHistoryEntry[] {
  return normalizeDocumentFileHistory([
    ...currentEntries.filter((entry) => entry.path !== selection.path),
    { ...selection, lastUsedAt }
  ])
}

/**
 * 按文件名或路径过滤历史记录；空白查询返回完整列表。
 * @param entries 完整历史记录。
 * @param query 用户输入的搜索文本。
 * @returns 与查询匹配的历史记录。
 * @author zhenghq
 */
export function filterDocumentFileHistory(
  entries: readonly DocumentFileHistoryEntry[],
  query: string
): DocumentFileHistoryEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return [...entries]
  return entries.filter((entry) =>
    entry.name.toLocaleLowerCase().includes(normalizedQuery) ||
    entry.path.toLocaleLowerCase().includes(normalizedQuery)
  )
}

/**
 * 查找与历史任务对应的已打开 Tab，避免从历史重复打开同一文件时新开 Tab。
 * 优先精确匹配任务标识（回放快照、运行中或待启动任务），再按文件路径与哈希匹配实时 Tab。
 * @param tabs 当前所有已打开文档 Tab。
 * @param jobId 历史任务标识。
 * @param source 历史快照中的源文件信息；仅在提供路径时才参与文件身份匹配。
 * @returns 匹配到的已打开 Tab；没有匹配时返回 null。
 * @author zhenghq
 */
export function findExistingTaskHistoryTab(
  tabs: readonly DocumentWorkspaceTab[],
  jobId: string,
  source?: { path?: string | null; sha256?: string | null }
): DocumentWorkspaceTab | null {
  const byJob = tabs.find((tab) =>
    tab.snapshot?.jobId === jobId ||
    tab.activeJobId === jobId ||
    tab.expectedJobId === jobId
  )
  if (byJob) return byJob
  if (!source?.path) return null
  // 文件身份只用于复用实时翻译 Tab 与重启恢复的只读 Tab（其快照任务标识是占位符，只能按文件绑定）；
  // 只读回放 Tab 已按任务标识匹配，不得跨任务复用。
  return tabs.find((tab) =>
    (tab.sourceKind === 'task' || tab.sourceKind === 'restored') &&
    tab.selection.path === source.path &&
    (!source.sha256 || !tab.selection.sha256 || tab.selection.sha256 === source.sha256)
  ) ?? null
}

/**
 * 合并任务历史与本地文件历史；同一文件名优先保留任务摘要，避免重复入口。
 * @param taskEntries 主进程返回的任务摘要。
 * @param fileEntries 本地可重新选择的文件历史。
 * @returns 按更新时间倒序排列的统一历史条目。
 * @author zhenghq
 */
export function mergeDocumentHistoryEntries(
  taskEntries: readonly DocumentHistoryEntry[],
  fileEntries: readonly DocumentFileHistoryEntry[]
): DocumentHistoryListItem[] {
  const taskNames = new Set(taskEntries.map((entry) => entry.fileName.toLocaleLowerCase()))
  const taskItems: DocumentHistoryListItem[] = taskEntries.map((entry) => ({
    kind: 'task',
    jobId: entry.jobId,
    updatedAt: entry.updatedAt,
    task: entry
  }))
  const fileItems: DocumentHistoryListItem[] = fileEntries
    .filter((entry) => !taskNames.has(entry.name.toLocaleLowerCase()))
    .map((entry) => ({
      kind: 'file',
      path: entry.path,
      updatedAt: entry.lastUsedAt,
      file: entry
    }))
  return [...taskItems, ...fileItems].sort((left, right) => right.updatedAt - left.updatedAt)
}

/**
 * 按文件名、语言方向或状态过滤任务历史；空白查询返回完整列表。
 * @param entries 完整任务历史。
 * @param query 用户输入的搜索文本。
 * @returns 与查询匹配的任务历史。
 * @author zhenghq
 */
export function filterDocumentTaskHistory(
  entries: readonly DocumentHistoryEntry[],
  query: string
): DocumentHistoryEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return [...entries]
  return entries.filter((entry) => {
    const direction = `${entry.languagePair.sourceLang} → ${entry.languagePair.targetLang}`
    return entry.fileName.toLocaleLowerCase().includes(normalizedQuery) ||
      direction.toLocaleLowerCase().includes(normalizedQuery) ||
      entry.status.toLocaleLowerCase().includes(normalizedQuery) ||
      entry.format.toLocaleLowerCase().includes(normalizedQuery)
  })
}
