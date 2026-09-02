import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { release } from 'node:os'
import type { Transporter } from 'nodemailer'
import { UsageStatsStore, type UsageStatsData } from './usageStats'

/** 翻译来源到统计渠道的映射输入类型。 */
export type TranslationOriginLike = 'selection' | 'manual' | 'ocr' | undefined

/** 上报 SMTP 配置，由打包流水线经环境变量注入生成。 */
export interface UsageReportConfig {
  /** 发件 QQ 邮箱地址。 */
  smtpUser: string
  /** 发件邮箱 SMTP 授权码。 */
  smtpPass: string
  /** 收件邮箱地址。 */
  reportTo: string
}

/** 上报时的运行环境信息。 */
export interface UsageReportEnvironment {
  /** 操作系统平台标识（如 darwin、win32、linux）。 */
  platform: string
  /** 操作系统内核版本。 */
  osRelease: string
  /** 应用安装版本。 */
  appVersion: string
  /** 构建编号。 */
  buildId: string
}

/** 发送选项，transporter 可注入便于测试。 */
export interface SendUsageReportOptions {
  config: UsageReportConfig
  stats: UsageStatsData
  environment: UsageReportEnvironment
  today: string
  yesterday: string
  /** 可注入的 transporter 工厂（测试用）；缺省惰性加载 nodemailer。 */
  createTransporter?: (config: UsageReportConfig) => Transporter
  transporter?: Transporter
}

/** 渠道标识的中文展示名。 */
const CHANNEL_LABELS: Record<string, string> = {
  hotkey: '快捷键翻译',
  selection: '划词翻译',
  screenshot: '截图翻译',
  webpage: '网页翻译'
}

/** 服务提供方标识的中文展示名。 */
const PROVIDER_LABELS: Record<string, string> = {
  ai: 'AI 翻译',
  dingtalk: '钉钉',
  microsoft: '微软',
  google: '谷歌',
  'deeplx-self': 'DeepLX 自建'
}

/**
 * 计算指定日期前一天的日期字符串。
 * @param today 当天日期（YYYY-MM-DD）。
 * @returns 前一天日期（YYYY-MM-DD）。
 * @author zhenghq
 */
export function previousDate(today: string): string {
  const date = new Date(`${today}T00:00:00`)
  date.setDate(date.getDate() - 1)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * 组装统计上报邮件正文（优化排版、大气结构化样式）
 * 分层展示系统信息、每日使用数据，格式规整、可读性强，无任何用户隐私文本
 * @param stats 统计快照。
 * @param environment 运行环境信息。
 * @param today 当天日期。
 * @param yesterday 前一天日期。
 * @returns 格式化邮件正文。
 * @author zhenghq
 */
export function buildReportBody(
    stats: UsageStatsData,
    environment: UsageReportEnvironment,
    today: string,
    yesterday: string
): string {
  // 统一分隔线，打造规整视觉层级
  const DIVIDER = '============================================================'
  const SUB_DIVIDER = '------------------------------------------------------------'

  const lines: string[] = [
    '',
    DIVIDER,
    '                划词翻译 - 每日使用量统计日报',
    DIVIDER,
    '',
    '【 运行环境信息 】',
    SUB_DIVIDER,
    `  操作系统：${environment.platform} (内核版本：${environment.osRelease})`,
    `  应用版本：${environment.appVersion}`,
    `  构建编号：${environment.buildId}`,
    '',
    DIVIDER,
    '【 每日使用数据统计 】',
    DIVIDER,
    ''
  ]

  // 遍历昨日、今日数据，分层渲染
  for (const date of [yesterday, today]) {
    const bucket = stats.days[date]
    lines.push(`📅 统计日期：${date}`)
    lines.push(SUB_DIVIDER)

    if (!bucket) {
      lines.push('  ✅ 当日无翻译使用记录')
      lines.push('')
      continue
    }

    // 翻译方式统计
    lines.push('  📝 翻译方式使用次数：')
    for (const [channel, count] of Object.entries(bucket.channels)) {
      lines.push(`    • ${CHANNEL_LABELS[channel] ?? channel}：${count} 次`)
    }

    // 翻译服务统计
    lines.push('')
    lines.push('  🔧 翻译服务使用次数：')
    for (const [provider, count] of Object.entries(bucket.providers)) {
      lines.push(`    • ${PROVIDER_LABELS[provider] ?? provider}：${count} 次`)
    }

    lines.push('')
  }

  // 页脚备注
  lines.push(DIVIDER)
  lines.push('  说明：本报表为自动化统计数据，仅记录使用次数，不包含任何用户隐私内容')
  lines.push(DIVIDER)
  lines.push('')

  return lines.join('\n')
}

/**
 * 通过 QQ 邮箱 SMTP 静默发送统计邮件；配置缺失或发送失败均不抛错。
 * @param options 发送选项。
 * @returns 发送成功返回 true，否则返回 false。
 * @author zhenghq
 */
export async function sendUsageReport(options: SendUsageReportOptions): Promise<boolean> {
  const { config, stats, environment, today, yesterday } = options
  if (!config.smtpUser || !config.smtpPass || !config.reportTo) return false
  try {
    const transporter = options.transporter ?? (options.createTransporter ?? defaultCreateTransporter)(config)
    await transporter.sendMail({
      from: `"划词翻译-统计系统" <${config.smtpUser}>`,
      to: config.reportTo,
      subject: `【划词翻译】每日使用量统计报表 - ${today}`,
      text: buildReportBody(stats, environment, today, yesterday)
    })
    return true
  } catch {
    // 静默：发送失败不提示、不写日志
    return false
  }
}

/**
 * 默认 transporter 工厂：惰性加载 nodemailer 并创建 QQ SMTP SSL 传输器。
 * @param config SMTP 配置。
 * @returns nodemailer 传输器。
 * @author zhenghq
 */
function defaultCreateTransporter(config: UsageReportConfig): Transporter {
  // 惰性加载：避免测试与未配置环境在模块导入时拉起 nodemailer
  const nodemailer = require('nodemailer') as typeof import('nodemailer')
  return nodemailer.createTransport({
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    auth: { user: config.smtpUser, pass: config.smtpPass },
    connectionTimeout: 15_000,
    socketTimeout: 20_000
  })
}

/**
 * 从构建产物中读取流水线注入的 SMTP 配置；缺失时返回空配置。
 * @returns SMTP 配置。
 * @author zhenghq
 */
function loadReportConfig(): UsageReportConfig {
  const empty: UsageReportConfig = { smtpUser: '', smtpPass: '', reportTo: '' }
  try {
    const { app } = require('electron') as typeof import('electron')
    const candidates = [
      join(app.getAppPath(), 'build/usage-report-config.json'),
      join(process.cwd(), 'build/usage-report-config.json')
    ]
    for (const path of candidates) {
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<UsageReportConfig>
        return {
          smtpUser: raw.smtpUser ?? '',
          smtpPass: raw.smtpPass ?? '',
          reportTo: raw.reportTo ?? ''
        }
      }
    }
  } catch {
    // 静默：配置读取失败视为未配置
  }
  return empty
}

/**
 * 读取构建元数据中的构建编号，缺失时回退为 unknown。
 * @returns 构建编号。
 * @author zhenghq
 */
function loadBuildId(): string {
  try {
    const { app } = require('electron') as typeof import('electron')
    const candidates = [
      join(app.getAppPath(), 'build/build-info.json'),
      join(process.cwd(), 'build/build-info.json')
    ]
    for (const path of candidates) {
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, 'utf-8')) as { buildId?: string }
        if (raw.buildId) return raw.buildId
      }
    }
  } catch {
    // 静默
  }
  return 'unknown'
}

let store: UsageStatsStore | null = null
/** 当前是否处于全局快捷键触发的取词窗口期。 */
let hotkeyWindowUntil = 0

/**
 * 惰性获取全局统计存储实例。
 * @returns 统计存储。
 * @author zhenghq
 */
function getStore(): UsageStatsStore {
  if (!store) {
    const { app } = require('electron') as typeof import('electron')
    store = new UsageStatsStore({
      filePath: join(app.getPath('userData'), 'usage-stats.json')
    })
  }
  return store
}

/**
 * 判断当天是否需要发送统计上报，需要时异步静默发送并写入防重发标记。
 * 全链路不抛异常、不写日志、不提示用户。
 * @returns 无返回值。
 * @author zhenghq
 */
export async function maybeSendUsageReport(): Promise<void> {
  try {
    const statsStore = getStore()
    if (!statsStore.shouldReportToday()) return
    const config = loadReportConfig()
    if (!config.smtpUser || !config.smtpPass || !config.reportTo) return
    const today = new Date()
    const month = String(today.getMonth() + 1).padStart(2, '0')
    const day = String(today.getDate()).padStart(2, '0')
    const todayString = `${today.getFullYear()}-${month}-${day}`
    const ok = await sendUsageReport({
      config,
      stats: statsStore.snapshot(),
      environment: {
        platform: process.platform,
        osRelease: release(),
        appVersion: (require('electron') as typeof import('electron')).app.getVersion(),
        buildId: loadBuildId()
      },
      today: todayString,
      yesterday: previousDate(todayString)
    })
    if (ok) statsStore.markReportSent(todayString)
  } catch {
    // 静默
  }
}

/**
 * 供测试重置全局存储实例。
 * @returns 无返回值。
 * @author zhenghq
 */
export function resetUsageReportStore(): void {
  store = null
}

/**
 * 标记一次全局快捷键翻译触发，使紧随其后的划词取词翻译计入快捷键渠道。
 * @param windowMs 归属窗口时长（毫秒）。
 * @returns 无返回值。
 * @author zhenghq
 */
export function markHotkeyTrigger(windowMs = 10_000): void {
  hotkeyWindowUntil = Date.now() + windowMs
}

/**
 * 记录一次翻译使用：按来源映射渠道、计数并在当天首次使用时异步触发上报。
 * 全链路静默，任何异常都不影响翻译主流程。
 * @param origin 翻译来源（selection/manual/ocr）。
 * @param provider 实际成功的翻译服务提供方标识。
 * @returns 无返回值。
 * @author zhenghq
 */
export function recordTranslationUsage(origin: TranslationOriginLike, provider: string | undefined): void {
  try {
    let channel: 'hotkey' | 'selection' | 'screenshot' = 'selection'
    if (origin === 'ocr') {
      channel = 'screenshot'
    } else if (Date.now() < hotkeyWindowUntil) {
      channel = 'hotkey'
      hotkeyWindowUntil = 0
    }
    getStore().recordUsage(channel, provider ?? 'unknown')
    void maybeSendUsageReport()
  } catch {
    // 静默
  }
}

/**
 * 记录一次网页翻译使用并触发上报检查。
 * @param provider 实际成功的翻译服务提供方标识。
 * @returns 无返回值。
 * @author zhenghq
 */
export function recordWebPageUsage(provider: string | undefined): void {
  try {
    getStore().recordUsage('webpage', provider ?? 'unknown')
    void maybeSendUsageReport()
  } catch {
    // 静默
  }
}