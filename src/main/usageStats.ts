import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 使用渠道标识：快捷键翻译、划词按钮翻译、截图 OCR 翻译、网页翻译。 */
export type UsageChannel = 'hotkey' | 'selection' | 'screenshot' | 'webpage'

/** 单个自然日的使用计数桶。 */
export interface UsageDayBucket {
  /** 各触发渠道的使用次数。 */
  channels: Partial<Record<UsageChannel, number>>
  /** 各翻译服务提供方的使用次数。 */
  providers: Record<string, number>
}

/** 统计文件整体结构。 */
export interface UsageStatsData {
  /** 按日期（YYYY-MM-DD）索引的计数桶，仅保留当天与前一天。 */
  days: Record<string, UsageDayBucket>
  /** 上报状态，用于防止当天重复发送。 */
  report: { lastSentDate: string | null }
}

/** 存储构造选项。 */
export interface UsageStatsStoreOptions {
  /** 统计文件绝对路径。 */
  filePath: string
  /** 当天日期提供者（YYYY-MM-DD），便于测试注入；默认按本地时区计算。 */
  today?: () => string
}

/**
 * 以本地时区计算当天日期字符串。
 * @returns YYYY-MM-DD 格式的本地日期。
 * @author zhenghq
 */
function localToday(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * 使用量统计存储：负责双维计数、两天滚动持久化与防重发标记。
 * @author zhenghq
 */
export class UsageStatsStore {
  private readonly filePath: string
  private readonly today: () => string
  private data: UsageStatsData

  /**
   * 创建统计存储并加载磁盘数据；文件损坏时静默重建为空结构。
   * @param options 存储构造选项。
   * @author zhenghq
   */
  constructor(options: UsageStatsStoreOptions) {
    this.filePath = options.filePath
    this.today = options.today ?? localToday
    this.data = this.load()
  }

  /**
   * 记录一次使用，并按两天滚动规则清理过期桶后持久化。
   * @param channel 触发渠道。
   * @param provider 翻译服务提供方标识。
   * @returns 无返回值。
   * @author zhenghq
   */
  recordUsage(channel: UsageChannel, provider: string): void {
    const today = this.today()
    const bucket = this.data.days[today] ?? { channels: {}, providers: {} }
    bucket.channels[channel] = (bucket.channels[channel] ?? 0) + 1
    bucket.providers[provider] = (bucket.providers[provider] ?? 0) + 1
    this.data.days[today] = bucket
    this.prune(today)
    this.persist()
  }

  /**
   * 判断当天是否尚未发送过统计上报。
   * @returns 当天未发送时返回 true。
   * @author zhenghq
   */
  shouldReportToday(): boolean {
    return this.data.report.lastSentDate !== this.today()
  }

  /**
   * 写入当天已发送标记并持久化，防止当天重复发送。
   * @param date 发送成功的日期（YYYY-MM-DD）。
   * @returns 无返回值。
   * @author zhenghq
   */
  markReportSent(date: string): void {
    this.data.report.lastSentDate = date
    this.persist()
  }

  /**
   * 获取当前统计快照（只读副本）。
   * @returns 统计数据深拷贝。
   * @author zhenghq
   */
  snapshot(): UsageStatsData {
    return JSON.parse(JSON.stringify(this.data)) as UsageStatsData
  }

  /**
   * 从磁盘加载统计数据，非法内容静默重建为空结构。
   * @returns 统计数据。
   * @author zhenghq
   */
  private load(): UsageStatsData {
    try {
      if (existsSync(this.filePath)) {
        const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<UsageStatsData>
        if (raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object') {
          return {
            days: raw.days,
            report: { lastSentDate: raw.report?.lastSentDate ?? null }
          }
        }
      }
    } catch {
      // 静默重建：损坏的统计不影响主流程
    }
    return { days: {}, report: { lastSentDate: null } }
  }

  /**
   * 丢弃早于前一天的日期桶。
   * @param today 当天日期（YYYY-MM-DD）。
   * @returns 无返回值。
   * @author zhenghq
   */
  private prune(today: string): void {
    const cutoff = new Date(`${today}T00:00:00`)
    cutoff.setDate(cutoff.getDate() - 1)
    const month = String(cutoff.getMonth() + 1).padStart(2, '0')
    const day = String(cutoff.getDate()).padStart(2, '0')
    const earliest = `${cutoff.getFullYear()}-${month}-${day}`
    for (const key of Object.keys(this.data.days)) {
      if (key < earliest) delete this.data.days[key]
    }
  }

  /**
   * 原子写入统计文件；写失败静默忽略，避免影响翻译主流程。
   * @returns 无返回值。
   * @author zhenghq
   */
  private persist(): void {
    try {
      const temporaryPath = `${this.filePath}.tmp`
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(temporaryPath, JSON.stringify(this.data, null, 2))
      renameSync(temporaryPath, this.filePath)
    } catch {
      // 静默：统计持久化失败不打扰用户
    }
  }
}
