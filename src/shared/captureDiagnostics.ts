/** 取词诊断记录的入口类型：按钮、快捷键或自动模式。 */
export type CaptureDiagnosticEntry = 'button' | 'hotkey' | 'auto'

/** 取词命中级别：原生直读、复制轮询命中、复制稳定期晚到或最终失败。 */
export type CaptureDiagnosticLevel = 'native-read' | 'copy-polled' | 'copy-late' | 'failed'

/** 取词失败原因枚举，与既有 SelectionFailureReason 保持一致。 */
export type CaptureDiagnosticReason = 'empty' | 'timeout' | 'unsupported' | 'permission' | 'clipboard-locked' | 'unknown'

/** 前台应用标识：macOS bundleId、Windows 进程名或 unknown。 */
export type CaptureDiagnosticApp = string

/** 单次取词的结构化诊断记录。 */
export interface CaptureDiagnosticRecord {
  /** 结束时间戳（毫秒）。 */
  at: number
  /** 入口：button / hotkey / auto。 */
  entry: CaptureDiagnosticEntry
  /** 平台：darwin / win32 / linux。 */
  platform: NodeJS.Platform
  /** 命中级别。 */
  level: CaptureDiagnosticLevel
  /** 失败原因（仅失败时存在）。 */
  reason?: CaptureDiagnosticReason
  /** 取词耗时（毫秒）。 */
  elapsedMs: number
  /** 前台应用标识。 */
  app: CaptureDiagnosticApp
}

/** 失败应用 Top 统计项。 */
export interface DiagnosticTopApp {
  app: string
  count: number
}

/** 单日聚合摘要。 */
export interface DiagnosticDaySummary {
  /** 当日总取词次数。 */
  total: number
  /** 按入口分组的计数。 */
  byEntry: Partial<Record<CaptureDiagnosticEntry, number>>
  /** 按命中级别分组的计数。 */
  byLevel: Partial<Record<CaptureDiagnosticLevel, number>>
  /** 按失败原因分组的计数（仅失败时）。 */
  byReason: Partial<Record<CaptureDiagnosticReason, number>>
  /** 失败前台应用 Top 5。 */
  topApps: DiagnosticTopApp[]
}

/** 单日诊断桶，包含截断后的原始记录与聚合摘要。 */
export interface DiagnosticDayBucket {
  /** 截断后的原始诊断记录（最多 2000 条）。 */
  records: CaptureDiagnosticRecord[]
  /** 当日聚合摘要。 */
  summary: DiagnosticDaySummary
}

/** 诊断数据文件整体结构。 */
export interface CaptureDiagnosticsData {
  /** 按日期（YYYY-MM-DD）索引的诊断桶。 */
  days: Record<string, DiagnosticDayBucket>
}

/** 单日原始记录上限，超出时丢弃最旧记录。 */
export const DIAGNOSTIC_DAY_RECORD_LIMIT = 2000

/** 诊断导出时保留的最近原始样本数量。 */
export const DIAGNOSTIC_EXPORT_SAMPLE_LIMIT = 200

/** 失败应用 Top 统计的最大条数。 */
export const DIAGNOSTIC_TOP_APP_LIMIT = 5

/** 诊断记录字段白名单，用于导出前过滤。 */
export const CAPTURE_DIAGNOSTIC_WHITELIST: readonly (keyof CaptureDiagnosticRecord)[] = [
  'at',
  'entry',
  'platform',
  'level',
  'reason',
  'elapsedMs',
  'app'
]

const VALID_REASONS: readonly CaptureDiagnosticReason[] = [
  'empty',
  'timeout',
  'unsupported',
  'permission',
  'clipboard-locked',
  'unknown'
]

const VALID_LEVELS: readonly CaptureDiagnosticLevel[] = [
  'native-read',
  'copy-polled',
  'copy-late',
  'failed'
]

/**
 * 规范化前台应用标识：trim、转小写、去除路径分隔与 .exe 后缀。
 * @param value 原始应用标识。
 * @returns 规范化后的应用标识；空值或非法输入返回 unknown。
 * @author zhenghq
 */
export function normalizeAppIdentifier(value: unknown): string {
  if (typeof value !== 'string') return 'unknown'
  const trimmed = value.trim()
  if (!trimmed) return 'unknown'
  // 取最后一个路径分隔符之后的部分，再去除 .exe 后缀
  const basename = trimmed.split(/[\\/]/u).pop() ?? trimmed
  const withoutExe = basename.replace(/\.exe$/iu, '')
  return withoutExe.toLowerCase() || 'unknown'
}

/**
 * 将输入值限制在合法失败原因枚举内。
 * @param value 待校验的失败原因。
 * @returns 合法原因；非法输入返回 undefined。
 * @author zhenghq
 */
export function resolveDiagnosticReason(value: unknown): CaptureDiagnosticReason | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return VALID_REASONS.includes(normalized as CaptureDiagnosticReason)
    ? (normalized as CaptureDiagnosticReason)
    : undefined
}

/**
 * 将输入值限制在合法命中级别枚举内。
 * @param value 待校验的命中级别。
 * @returns 合法级别；非法输入返回 failed。
 * @author zhenghq
 */
export function resolveDiagnosticLevel(value: unknown): CaptureDiagnosticLevel {
  if (typeof value !== 'string') return 'failed'
  const normalized = value.trim().toLowerCase()
  return VALID_LEVELS.includes(normalized as CaptureDiagnosticLevel)
    ? (normalized as CaptureDiagnosticLevel)
    : 'failed'
}

/**
 * 构建一条结构化的取词诊断记录，自动规范化应用标识。
 * @param input 原始诊断字段。
 * @returns 规范化后的诊断记录。
 * @author zhenghq
 */
export function buildCaptureDiagnosticRecord(input: {
  at: number
  entry: CaptureDiagnosticEntry
  platform: NodeJS.Platform
  level: CaptureDiagnosticLevel
  reason?: CaptureDiagnosticReason
  elapsedMs: number
  app: string
}): CaptureDiagnosticRecord {
  return {
    at: input.at,
    entry: input.entry,
    platform: input.platform,
    level: resolveDiagnosticLevel(input.level),
    reason: input.level === 'failed' ? resolveDiagnosticReason(input.reason) : undefined,
    elapsedMs: input.elapsedMs,
    app: normalizeAppIdentifier(input.app)
  }
}

/**
 * 生成单日诊断记录的聚合摘要。
 * @param records 当日诊断记录列表。
 * @returns 聚合摘要。
 * @author zhenghq
 */
export function getDiagnosticDaySummary(records: readonly CaptureDiagnosticRecord[]): DiagnosticDaySummary {
  const byEntry: Partial<Record<CaptureDiagnosticEntry, number>> = {}
  const byLevel: Partial<Record<CaptureDiagnosticLevel, number>> = {}
  const byReason: Partial<Record<CaptureDiagnosticReason, number>> = {}
  const appCounts = new Map<string, number>()

  for (const record of records) {
    byEntry[record.entry] = (byEntry[record.entry] ?? 0) + 1
    byLevel[record.level] = (byLevel[record.level] ?? 0) + 1
    if (record.level === 'failed' && record.reason) {
      byReason[record.reason] = (byReason[record.reason] ?? 0) + 1
    }
    if (record.level === 'failed' && record.app) {
      appCounts.set(record.app, (appCounts.get(record.app) ?? 0) + 1)
    }
  }

  const topApps = [...appCounts.entries()]
    .map(([app, count]) => ({ app, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, DIAGNOSTIC_TOP_APP_LIMIT)

  return {
    total: records.length,
    byEntry,
    byLevel,
    byReason,
    topApps
  }
}

/**
 * 将多条诊断记录聚合为摘要，供跨天统计使用。
 * @param records 诊断记录列表。
 * @returns 聚合摘要。
 * @author zhenghq
 */
export function aggregateCaptureDiagnostics(records: readonly CaptureDiagnosticRecord[]): DiagnosticDaySummary {
  return getDiagnosticDaySummary(records)
}

/**
 * 按两天滚动规则清理过期日期桶，仅保留当天与前一天。
 * @param days 按日期索引的诊断桶。
 * @param today 当天日期（YYYY-MM-DD）。
 * @returns 清理后的诊断桶。
 * @author zhenghq
 */
export function pruneDiagnosticDays(
  days: Record<string, DiagnosticDayBucket>,
  today: string
): Record<string, DiagnosticDayBucket> {
  const cutoff = new Date(`${today}T00:00:00`)
  cutoff.setDate(cutoff.getDate() - 1)
  const month = String(cutoff.getMonth() + 1).padStart(2, '0')
  const day = String(cutoff.getDate()).padStart(2, '0')
  const earliest = `${cutoff.getFullYear()}-${month}-${day}`
  const result: Record<string, DiagnosticDayBucket> = {}
  for (const [key, bucket] of Object.entries(days)) {
    if (key >= earliest) result[key] = bucket
  }
  return result
}

/**
 * 向单日桶追加一条诊断记录，超限时截断最旧记录并重新聚合。
 * @param day 原单日桶。
 * @param record 待追加的诊断记录。
 * @returns 更新后的单日桶。
 * @author zhenghq
 */
export function appendDiagnosticRecord(
  day: DiagnosticDayBucket,
  record: CaptureDiagnosticRecord
): DiagnosticDayBucket {
  const records = [...day.records, record]
  const trimmed = records.length > DIAGNOSTIC_DAY_RECORD_LIMIT
    ? records.slice(-DIAGNOSTIC_DAY_RECORD_LIMIT)
    : records
  return {
    records: trimmed,
    summary: getDiagnosticDaySummary(records)
  }
}
