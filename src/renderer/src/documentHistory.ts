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
