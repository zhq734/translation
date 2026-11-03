import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  normalizeTranslationHistory,
  recordTranslationHistory,
  toggleTranslationHistoryFavorite,
  type TranslationHistoryEntry,
  type TranslationHistoryInput
} from '../shared/translationHistory'

/** 翻译历史文件结构版本。 */
export const TRANSLATION_HISTORY_SCHEMA_VERSION = 1

interface TranslationHistoryFile {
  /** 文件结构版本，用于未来迁移。 */
  schemaVersion: number
  /** 已持久化的安全历史记录。 */
  entries: TranslationHistoryEntry[]
}

export interface TranslationHistoryStoreOptions {
  /** 历史文件所在目录。 */
  directory: string
  /** 可选时钟，便于测试和稳定排序。 */
  now?: () => number
}

/**
 * 统一翻译历史文件存储。
 * 所有读写操作进入同一 Promise 队列，避免并发 IPC 造成丢失更新。
 */
export class TranslationHistoryStore {
  private readonly directory: string
  private readonly now: () => number
  private queue: Promise<void> = Promise.resolve()

  /**
   * 创建历史存储。
   * @param options 存储目录与可选时钟。
   * @author zhenghq
   */
  constructor(options: TranslationHistoryStoreOptions) {
    this.directory = options.directory
    this.now = options.now ?? Date.now
  }

  /**
   * 返回历史数据文件路径。
   * @returns translation-history.json 的完整路径。
   * @author zhenghq
   */
  private filePath(): string {
    return join(this.directory, 'translation-history.json')
  }

  /**
   * 在串行队列中执行一个操作。
   * @param operation 需要独占历史文件的操作。
   * @returns 操作结果。
   * @author zhenghq
   */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * 从磁盘读取并规范化历史；文件缺失或损坏时安全回退为空数组。
   * @returns 当前历史记录。
   * @author zhenghq
   */
  private async read(): Promise<TranslationHistoryEntry[]> {
    try {
      const raw = await readFile(this.filePath(), 'utf8')
      const parsed = JSON.parse(raw) as Partial<TranslationHistoryFile> | unknown
      if (!parsed || typeof parsed !== 'object') return []
      return normalizeTranslationHistory((parsed as TranslationHistoryFile).entries)
    } catch {
      return []
    }
  }

  /**
   * 使用临时文件替换方式原子写入历史数据。
   * @param entries 待持久化的安全历史记录。
   * @returns 无返回值。
   * @author zhenghq
   */
  private async write(entries: TranslationHistoryEntry[]): Promise<void> {
    const path = this.filePath()
    const temporaryPath = `${path}.tmp`
    await mkdir(dirname(path), { recursive: true })
    const payload: TranslationHistoryFile = {
      schemaVersion: TRANSLATION_HISTORY_SCHEMA_VERSION,
      entries: normalizeTranslationHistory(entries)
    }
    await writeFile(temporaryPath, JSON.stringify(payload, null, 2), 'utf8')
    await rename(temporaryPath, path)
  }

  /**
   * 列出全部统一翻译历史。
   * @returns 收藏优先、其余按时间倒序的安全记录。
   * @author zhenghq
   */
  list(): Promise<TranslationHistoryEntry[]> {
    return this.enqueue(async () => this.read())
  }

  /**
   * 记录一次成功翻译并持久化。
   * @param input 成功翻译的安全字段。
   * @returns 新记录；原文或译文为空时返回 null。
   * @author zhenghq
   */
  record(input: TranslationHistoryInput): Promise<TranslationHistoryEntry | null> {
    return this.enqueue(async () => {
      const previous = await this.read()
      const next = recordTranslationHistory(previous, {
        ...input,
        createdAt: input.createdAt ?? this.now()
      })
      const identityEntry = next.find((entry) =>
        entry.origin === input.origin &&
        entry.sourceText === input.sourceText.trim() &&
        entry.sourceLang === String(input.sourceLang || 'auto').trim() &&
        entry.targetLang === String(input.targetLang || 'auto').trim()
      )
      if (!identityEntry) return null
      await this.write(next)
      return identityEntry
    })
  }

  /**
   * 设置指定历史记录的收藏状态。
   * @param id 历史记录标识。
   * @param favorite 目标收藏状态。
   * @returns 是否找到并更新记录。
   * @author zhenghq
   */
  setFavorite(id: string, favorite: boolean): Promise<boolean> {
    return this.enqueue(async () => {
      const previous = await this.read()
      const found = previous.some((entry) => entry.id === id)
      if (!found) return false
      const toggled = previous.map((entry) =>
        entry.id === id ? { ...entry, favorite } : entry
      )
      await this.write(toggled)
      return true
    })
  }

  /**
   * 删除指定历史记录。
   * @param id 历史记录标识。
   * @returns 是否实际删除记录。
   * @author zhenghq
   */
  delete(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const previous = await this.read()
      const next = previous.filter((entry) => entry.id !== id)
      if (next.length === previous.length) return false
      await this.write(next)
      return true
    })
  }

  /**
   * 清空所有非收藏历史并保留收藏项。
   * @returns 被删除的记录数量。
   * @author zhenghq
   */
  clearNonFavorites(): Promise<number> {
    return this.enqueue(async () => {
      const previous = await this.read()
      const next = previous.filter((entry) => entry.favorite)
      const removed = previous.length - next.length
      if (removed > 0) await this.write(next)
      return removed
    })
  }
}
