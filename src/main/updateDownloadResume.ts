import { readFile, rm, stat, writeFile } from 'node:fs/promises'

/** 单个下载分片的进度记录。 */
export interface DownloadResumeSegment {
  /** 分片在目标文件中的起始偏移。 */
  start: number
  /** 分片在目标文件中的结束偏移（含）。 */
  end: number
  /** 该分片已完成的字节数。 */
  completed: number
}

/** 未完成下载的进度记录，保存在 `<destination>.part.json`。 */
export interface DownloadResumeRecord {
  /** 更新版本号。 */
  version: string
  /** 更新包总字节数。 */
  total: number
  /** 更新清单提供的 sha512 校验值，无校验值时省略。 */
  sha512?: string
  /** 各分片的进度记录。 */
  segments: DownloadResumeSegment[]
}

/** 判定续传记录可复用性的本次下载目标。 */
export interface DownloadResumeTarget {
  /** 本次下载的版本号。 */
  version: string
  /** 本次下载的更新包总字节数。 */
  total: number
  /** 本次下载的 sha512 校验值，无校验值时省略。 */
  sha512?: string
}

/**
 * 生成下载临时文件路径。
 * @param destination 最终文件路径。
 * @returns 临时文件路径。
 * @author zhenghq
 */
export function resumeTemporaryPath(destination: string): string {
  return `${destination}.part`
}

/**
 * 生成续传进度记录文件路径。
 * @param destination 最终文件路径。
 * @returns 进度记录文件路径。
 * @author zhenghq
 */
export function resumeRecordPath(destination: string): string {
  return `${destination}.part.json`
}

/**
 * 判断进度记录中的分片描述是否结构合法。
 * @param value 待校验的分片记录。
 * @returns 结构合法时返回 true。
 * @author zhenghq
 */
function isValidSegment(value: unknown): value is DownloadResumeSegment {
  if (!value || typeof value !== 'object') return false
  const segment = value as Partial<DownloadResumeSegment>
  return Number.isFinite(segment.start) &&
    Number.isFinite(segment.end) &&
    Number.isFinite(segment.completed) &&
    (segment.start as number) >= 0 &&
    (segment.end as number) >= (segment.start as number) &&
    (segment.completed as number) >= 0 &&
    (segment.completed as number) <= (segment.end as number) - (segment.start as number) + 1
}

/**
 * 将未完成下载的分片进度写入 sidecar 记录文件。
 * @param destination 最终文件路径。
 * @param record 需要持久化的进度记录。
 * @returns 写入完成后的 Promise。
 * @author zhenghq
 */
export async function saveDownloadResumeState(
  destination: string,
  record: DownloadResumeRecord
): Promise<void> {
  await writeFile(resumeRecordPath(destination), JSON.stringify(record), 'utf8')
}

/**
 * 读取可复用的续传进度记录。
 * 仅当版本、总长度与校验值三者与本次下载目标完全一致，且临时文件长度足够时才复用。
 * @param destination 最终文件路径。
 * @param target 本次下载目标的版本、总长度与校验值。
 * @returns 可复用的进度记录；不可复用、记录缺失或损坏时返回 undefined。
 * @author zhenghq
 */
export async function loadDownloadResumeState(
  destination: string,
  target: DownloadResumeTarget
): Promise<DownloadResumeRecord | undefined> {
  let record: DownloadResumeRecord
  try {
    const raw = await readFile(resumeRecordPath(destination), 'utf8')
    record = JSON.parse(raw) as DownloadResumeRecord
  } catch {
    return undefined
  }

  if (record?.version !== target.version) return undefined
  if (record.total !== target.total) return undefined
  if (record.sha512 !== target.sha512) return undefined
  if (!Array.isArray(record.segments) || record.segments.length === 0) return undefined
  if (!record.segments.every(isValidSegment)) return undefined

  const completed = record.segments.reduce((sum, segment) => sum + segment.completed, 0)
  try {
    const temporaryStat = await stat(resumeTemporaryPath(destination))
    if (temporaryStat.size < completed) return undefined
  } catch {
    return undefined
  }
  return record
}

/**
 * 删除临时文件与续传进度记录。
 * @param destination 最终文件路径。
 * @returns 清理完成后的 Promise。
 * @author zhenghq
 */
export async function clearDownloadResumeState(destination: string): Promise<void> {
  await rm(resumeTemporaryPath(destination), { force: true }).catch(() => undefined)
  await rm(resumeRecordPath(destination), { force: true }).catch(() => undefined)
}
