import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DocumentFormat, DocumentModel } from '../shared/documentTypes.ts'
import type { DocumentLanguagePair } from '../shared/documentLanguageDirection.ts'
import type {
  DocumentHistoryEntry,
  DocumentWorkspaceSnapshot
} from '../shared/documentWorkspace.ts'

/** 文档任务历史文件结构版本；不兼容变更时必须递增。 */
export const DOCUMENT_TASK_HISTORY_SCHEMA_VERSION = 1

/** 不含正文的任务摘要文件名。 */
const HISTORY_SUMMARY_FILE = 'task-history.json'

/** 用于恢复原文与译文的完整快照文件名。 */
const HISTORY_SNAPSHOT_FILE = 'task-history-snapshots.json'

/** 历史摘要中额外保留、但不向界面暴露的文档与缓存标识。 */
interface PersistedHistoryMetadata {
  /** 解析后的文档稳定标识。 */
  documentId: string
  /** 源文件内容哈希，用于删除对应翻译缓存。 */
  sourceSha256: string
}

/** 写入摘要文件的安全条目。 */
type PersistedHistoryEntry = DocumentHistoryEntry & PersistedHistoryMetadata

/** 摘要文件结构。 */
interface PersistedHistoryFile {
  /** 摘要结构版本。 */
  schemaVersion: number
  /** 按更新时间倒序保存的任务摘要。 */
  entries: PersistedHistoryEntry[]
}

/** 单个任务代际的完整恢复快照。 */
interface PersistedSnapshotEntry {
  /** 任务标识。 */
  jobId: string
  /** 快照对应代际。 */
  generation: number
  /** 快照更新时间，用于容量裁剪与排序。 */
  updatedAt: number
  /** 原文、译文和完成报告等完整数据。 */
  snapshot: DocumentWorkspaceSnapshot
}

/** 完整快照文件结构。 */
interface PersistedSnapshotFile {
  /** 快照结构版本。 */
  schemaVersion: number
  /** 全部可恢复任务快照。 */
  entries: PersistedSnapshotEntry[]
}

/** 文档任务历史存储选项。 */
export interface DocumentTaskHistoryStoreOptions {
  /** 受控历史目录，通常位于应用用户数据目录下。 */
  directory: string
  /** 最多保留的任务数量。 */
  maxEntries: number
  /** 可注入时钟，便于测试更新时间与排序。 */
  now?(): number
}

/**
 * 判断未知值是否为受支持的文档格式。
 * @param value 待校验值。
 * @returns 是文档格式时返回 true。
 * @author zhenghq
 */
function isDocumentFormat(value: unknown): value is DocumentFormat {
  return value === 'pdf' || value === 'docx' || value === 'epub' ||
    value === 'html' || value === 'markdown' || value === 'txt' ||
    value === 'json' || value === 'csv' || value === 'srt' ||
    value === 'vtt' || value === 'image'
}

/**
 * 判断未知值是否为合法语言对。
 * @param value 待校验值。
 * @returns 源语言与目标语言均有效时返回 true。
 * @author zhenghq
 */
function isLanguagePair(value: unknown): value is DocumentLanguagePair {
  if (!value || typeof value !== 'object') return false
  const pair = value as Partial<DocumentLanguagePair>
  return typeof pair.sourceLang === 'string' && pair.sourceLang.length > 0 &&
    typeof pair.targetLang === 'string' && pair.targetLang.length > 0
}

/**
 * 判断未知值是否为可安全展示的摘要条目。
 * @param value 待校验值。
 * @returns 字段完整且状态有效时返回 true。
 * @author zhenghq
 */
function isPersistedHistoryEntry(value: unknown): value is PersistedHistoryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<PersistedHistoryEntry>
  return typeof entry.jobId === 'string' && entry.jobId.length > 0 &&
    Number.isInteger(entry.generation) && (entry.generation ?? 0) > 0 &&
    typeof entry.fileName === 'string' && entry.fileName.length > 0 &&
    isDocumentFormat(entry.format) &&
    typeof entry.sourcePreference === 'string' && entry.sourcePreference.length > 0 &&
    typeof entry.targetPreference === 'string' && entry.targetPreference.length > 0 &&
    isLanguagePair(entry.languagePair) &&
    (entry.status === 'completed' || entry.status === 'partial' ||
      entry.status === 'cancelled' || entry.status === 'failed') &&
    typeof entry.percent === 'number' && Number.isFinite(entry.percent) &&
    entry.percent >= 0 && entry.percent <= 100 &&
    typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) &&
    entry.updatedAt >= 0 &&
    (entry.exportStatus === 'not-exported' || entry.exportStatus === 'saved') &&
    typeof entry.documentId === 'string' && entry.documentId.length > 0 &&
    typeof entry.sourceSha256 === 'string' && entry.sourceSha256.length > 0
}

/**
 * 判断未知值是否为可恢复的完整快照条目。
 * @param value 待校验值。
 * @returns 任务身份与原文模型均有效时返回 true。
 * @author zhenghq
 */
function isPersistedSnapshotEntry(value: unknown): value is PersistedSnapshotEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<PersistedSnapshotEntry>
  const snapshot = entry.snapshot as Partial<DocumentWorkspaceSnapshot> | undefined
  return typeof entry.jobId === 'string' && entry.jobId.length > 0 &&
    Number.isInteger(entry.generation) && (entry.generation ?? 0) > 0 &&
    typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) &&
    entry.updatedAt >= 0 && Boolean(snapshot) && typeof snapshot === 'object' &&
    snapshot.jobId === entry.jobId && snapshot.generation === entry.generation &&
    Boolean(snapshot.source) && typeof snapshot.source === 'object' &&
    typeof snapshot.source.documentId === 'string' && snapshot.source.documentId.length > 0
}

/**
 * 从快照读取测试或旧版本注入的更新时间。
 * @param snapshot 工作台快照。
 * @param fallback 缺失时使用的当前时间。
 * @returns 有限的非负时间戳。
 * @author zhenghq
 */
function resolveUpdatedAt(snapshot: DocumentWorkspaceSnapshot, fallback: number): number {
  const candidate = (snapshot as DocumentWorkspaceSnapshot & { updatedAt?: unknown }).updatedAt
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
    ? candidate
    : fallback
}

/**
 * 从源模型提取稳定的格式与文件名，缺失时回退到快照元数据。
 * @param snapshot 工作台快照。
 * @returns 摘要使用的文件名与格式；无法生成安全摘要时返回 null。
 * @author zhenghq
 */
function resolveSourceMetadata(snapshot: DocumentWorkspaceSnapshot): {
  fileName: string
  format: DocumentFormat
  documentId: string
  sourceSha256: string
} | null {
  const source = snapshot.source as (DocumentModel & { source?: DocumentModel['source'] }) | undefined
  if (!source || typeof source.documentId !== 'string' || !source.documentId) return null
  const metadata = source.source
  if (!metadata || !isDocumentFormat(metadata.format)) return null
  const rawName = typeof metadata.fileName === 'string' && metadata.fileName
    ? metadata.fileName
    : basename(metadata.path)
  const fileName = basename(rawName)
  if (!fileName || fileName === '.' || fileName === '..') return null
  const sourceSha256 = typeof metadata.sha256 === 'string' ? metadata.sha256 : ''
  return { fileName, format: metadata.format, documentId: source.documentId, sourceSha256 }
}

/**
 * 生成面向历史列表的安全摘要，不携带正文、源路径或资源字节。
 * @param snapshot 工作台快照。
 * @param updatedAt 更新时间。
 * @param previous 同任务同代际的旧摘要，用于保留导出状态。
 * @returns 安全摘要；无法从源模型生成时返回 null。
 * @author zhenghq
 */
function createHistoryEntry(
  snapshot: DocumentWorkspaceSnapshot,
  updatedAt: number,
  previous?: PersistedHistoryEntry
): PersistedHistoryEntry | null {
  const metadata = resolveSourceMetadata(snapshot)
  if (!metadata) return null
  const sourcePreference = snapshot.sourcePreference ?? 'auto'
  const targetPreference = snapshot.targetPreference ?? 'auto'
  const languagePair = snapshot.languagePair ?? {
    sourceLang: sourcePreference,
    targetLang: targetPreference
  }
  return {
    jobId: snapshot.jobId,
    generation: snapshot.generation,
    fileName: metadata.fileName,
    format: metadata.format,
    sourcePreference,
    targetPreference,
    languagePair: { ...languagePair },
    status: snapshot.task.status,
    percent: Math.min(100, Math.max(0, snapshot.percent)),
    updatedAt,
    exportStatus: previous?.exportStatus === 'saved' ? 'saved' : 'not-exported',
    documentId: metadata.documentId,
    sourceSha256: metadata.sourceSha256
  }
}

/**
 * 将未知摘要文件规范化为安全、去重且按时间倒序的条目。
 * @param value 从磁盘读取的未知值。
 * @param maxEntries 最大保留数量。
 * @returns 可安全展示的摘要条目。
 * @author zhenghq
 */
function normalizeHistoryFile(value: unknown, maxEntries: number): PersistedHistoryEntry[] {
  if (!value || typeof value !== 'object') return []
  const file = value as Partial<PersistedHistoryFile>
  if (file.schemaVersion !== DOCUMENT_TASK_HISTORY_SCHEMA_VERSION || !Array.isArray(file.entries)) {
    return []
  }
  const byJob = new Map<string, PersistedHistoryEntry>()
  for (const candidate of file.entries) {
    if (!isPersistedHistoryEntry(candidate)) continue
    const previous = byJob.get(candidate.jobId)
    if (!previous || previous.updatedAt <= candidate.updatedAt) byJob.set(candidate.jobId, candidate)
  }
  return [...byJob.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, maxEntries)
}

/**
 * 将未知快照文件规范化为可恢复条目，并只保留仍有摘要的任务。
 * @param value 从磁盘读取的未知值。
 * @param entries 已裁剪的摘要条目。
 * @returns 可安全恢复的完整快照条目。
 * @author zhenghq
 */
function normalizeSnapshotFile(
  value: unknown,
  entries: readonly PersistedHistoryEntry[]
): PersistedSnapshotEntry[] {
  if (!value || typeof value !== 'object') return []
  const file = value as Partial<PersistedSnapshotFile>
  if (file.schemaVersion !== DOCUMENT_TASK_HISTORY_SCHEMA_VERSION || !Array.isArray(file.entries)) {
    return []
  }
  const validIds = new Set(entries.map((entry) => entry.jobId))
  const byJob = new Map<string, PersistedSnapshotEntry>()
  for (const candidate of file.entries) {
    if (!isPersistedSnapshotEntry(candidate) || !validIds.has(candidate.jobId)) continue
    const previous = byJob.get(candidate.jobId)
    if (!previous || previous.updatedAt <= candidate.updatedAt) byJob.set(candidate.jobId, candidate)
  }
  return [...byJob.values()]
}

/**
 * 文档任务历史磁盘存储；摘要与完整快照分离，所有写入串行且原子替换。
 * @author zhenghq
 */
export class DocumentTaskHistoryStore {
  /** 历史目录。 */
  private readonly directory: string
  /** 最大任务数量。 */
  private readonly maxEntries: number
  /** 可注入时钟。 */
  private readonly now: () => number
  /** 串行化读写，避免并发保存互相覆盖。 */
  private queue: Promise<void> = Promise.resolve()

  /**
   * 创建任务历史存储。
   * @param options 历史目录、容量与时钟。
   * @author zhenghq
   */
  constructor(options: DocumentTaskHistoryStoreOptions) {
    this.directory = options.directory
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries))
    this.now = options.now ?? Date.now
  }

  /**
   * 保存或替换一个任务代际的摘要与完整快照。
   * @param snapshot 当前工作台终态快照。
   * @returns 写入完成后的 Promise。
   * @author zhenghq
   */
  async save(snapshot: DocumentWorkspaceSnapshot): Promise<void> {
    await this.enqueue(async () => {
      const updatedAt = resolveUpdatedAt(snapshot, this.now())
      const previousEntries = await this.loadSummaries()
      const previous = previousEntries.find((entry) => (
        entry.jobId === snapshot.jobId && entry.generation === snapshot.generation
      ))
      const entry = createHistoryEntry(snapshot, updatedAt, previous)
      if (!entry) return
      const entries = previousEntries
        .filter((candidate) => candidate.jobId !== snapshot.jobId)
        .concat(entry)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, this.maxEntries)
      const snapshots = (await this.loadSnapshots(entries))
        .filter((candidate) => candidate.jobId !== snapshot.jobId)
        .concat({ jobId: snapshot.jobId, generation: snapshot.generation, updatedAt, snapshot })
        .filter((candidate) => entries.some((item) => item.jobId === candidate.jobId))
        .sort((left, right) => right.updatedAt - left.updatedAt)
      await this.persist(entries, snapshots)
    })
  }

  /**
   * 读取按更新时间倒序排列的安全历史摘要。
   * @returns 历史列表；文件缺失或损坏时为空数组。
   * @author zhenghq
   */
  async list(): Promise<DocumentHistoryEntry[]> {
    let result: DocumentHistoryEntry[] = []
    await this.enqueue(async () => {
      result = (await this.loadSummaries()).map((entry) => ({
        jobId: entry.jobId,
        generation: entry.generation,
        fileName: entry.fileName,
        format: entry.format,
        sourcePreference: entry.sourcePreference,
        targetPreference: entry.targetPreference,
        languagePair: { ...entry.languagePair },
        status: entry.status,
        percent: entry.percent,
        updatedAt: entry.updatedAt,
        exportStatus: entry.exportStatus
      }))
    })
    return result
  }

  /**
   * 打开指定任务最近代际的完整恢复快照。
   * @param jobId 任务标识。
   * @returns 包含原文与译文的快照；不存在或损坏时返回 null。
   * @author zhenghq
   */
  async open(jobId: string): Promise<{ snapshot: DocumentWorkspaceSnapshot } | null> {
    let result: { snapshot: DocumentWorkspaceSnapshot } | null = null
    await this.enqueue(async () => {
      const entries = await this.loadSummaries()
      if (!entries.some((entry) => entry.jobId === jobId)) return
      const snapshotEntry = (await this.loadSnapshots(entries)).find((entry) => entry.jobId === jobId)
      if (snapshotEntry) result = { snapshot: snapshotEntry.snapshot }
    })
    return result
  }

  /**
   * 删除一个任务的全部代际摘要与恢复快照。
   * @param jobId 任务标识。
   * @returns 是否实际删除了历史条目。
   * @author zhenghq
   */
  async delete(jobId: string): Promise<boolean> {
    let removed = false
    await this.enqueue(async () => {
      const entries = await this.loadSummaries()
      const snapshots = await this.loadSnapshots(entries)
      const nextEntries = entries.filter((entry) => entry.jobId !== jobId)
      const nextSnapshots = snapshots.filter((entry) => entry.jobId !== jobId)
      removed = nextEntries.length !== entries.length || nextSnapshots.length !== snapshots.length
      if (removed) await this.persist(nextEntries, nextSnapshots)
    })
    return removed
  }

  /**
   * 清空全部任务历史，不修改同目录中的用户设置。
   * @returns 清空完成后的 Promise。
   * @author zhenghq
   */
  async clear(): Promise<void> {
    await this.enqueue(async () => this.persist([], []))
  }

  /**
   * 只更新匹配任务与代际的导出状态。
   * @param jobId 任务标识。
   * @param generation 任务代际。
   * @param status 新的导出状态。
   * @returns 更新完成后的 Promise。
   * @author zhenghq
   */
  async updateExportStatus(
    jobId: string,
    generation: number,
    status: DocumentHistoryEntry['exportStatus']
  ): Promise<void> {
    if (status !== 'saved' && status !== 'not-exported') return
    await this.enqueue(async () => {
      const entries = await this.loadSummaries()
      let changed = false
      const nextEntries = entries.map((entry) => {
        if (entry.jobId !== jobId || entry.generation !== generation || entry.exportStatus === status) {
          return entry
        }
        changed = true
        return { ...entry, exportStatus: status }
      })
      if (!changed) return
      const snapshots = await this.loadSnapshots(nextEntries)
      await this.persist(nextEntries, snapshots)
    })
  }

  /**
   * 将操作加入串行队列，并保证一次失败不会阻塞后续操作。
   * @param operation 待执行操作。
   * @returns 操作完成后的 Promise。
   * @author zhenghq
   */
  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation, operation)
    this.queue = next.catch(() => undefined)
    await next
  }

  /**
   * 读取并规范化历史摘要；文件缺失或 JSON 损坏时安全回退为空。
   * @returns 安全摘要条目。
   * @author zhenghq
   */
  private async loadSummaries(): Promise<PersistedHistoryEntry[]> {
    try {
      const raw = await readFile(join(this.directory, HISTORY_SUMMARY_FILE), 'utf8')
      return normalizeHistoryFile(JSON.parse(raw), this.maxEntries)
    } catch {
      return []
    }
  }

  /**
   * 读取与当前摘要匹配的完整快照；文件损坏时回退为空。
   * @param entries 当前有效摘要。
   * @returns 安全快照条目。
   * @author zhenghq
   */
  private async loadSnapshots(
    entries: readonly PersistedHistoryEntry[]
  ): Promise<PersistedSnapshotEntry[]> {
    try {
      const raw = await readFile(join(this.directory, HISTORY_SNAPSHOT_FILE), 'utf8')
      return normalizeSnapshotFile(JSON.parse(raw), entries)
    } catch {
      return []
    }
  }

  /**
   * 使用临时文件原子替换摘要与快照文件。
   * @param entries 待写入摘要。
   * @param snapshots 待写入完整快照。
   * @returns 写入完成后的 Promise。
   * @author zhenghq
   */
  private async persist(
    entries: PersistedHistoryEntry[],
    snapshots: PersistedSnapshotEntry[]
  ): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    await this.writeJsonAtomic(HISTORY_SUMMARY_FILE, {
      schemaVersion: DOCUMENT_TASK_HISTORY_SCHEMA_VERSION,
      entries
    } satisfies PersistedHistoryFile)
    await this.writeJsonAtomic(HISTORY_SNAPSHOT_FILE, {
      schemaVersion: DOCUMENT_TASK_HISTORY_SCHEMA_VERSION,
      entries: snapshots
    } satisfies PersistedSnapshotFile)
  }

  /**
   * 将 JSON 写入同目录临时文件后原子重命名。
   * @param fileName 目标文件名。
   * @param value 待序列化值。
   * @returns 写入完成后的 Promise。
   * @author zhenghq
   */
  private async writeJsonAtomic(fileName: string, value: unknown): Promise<void> {
    const target = join(this.directory, fileName)
    const temporary = `${target}.tmp`
    await writeFile(temporary, JSON.stringify(value), 'utf8')
    await rename(temporary, target)
  }
}
