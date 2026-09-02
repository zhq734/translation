import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import type { Transporter } from 'nodemailer'
import type { SendMailOptions } from 'nodemailer'
import {UsageStatsData, UsageStatsStore} from "./usageStats";

/** SMTP 上报配置。 */
interface UsageReportConfig {
  /** 发件邮箱。 */
  smtpUser: string
  /** SMTP 授权码。 */
  smtpPass: string
  /** 收件邮箱。 */
  reportTo: string
}

/** 安装事件类型。 */
export type InstallEventType = 'install' | 'upgrade'

/** 待发送的安装或升级事件。 */
export interface InstallEvent {
  /** 事件类型。 */
  type: InstallEventType
  /** 上一版本，首次安装为空。 */
  previousVersion: string | null
  /** 当前应用版本。 */
  currentVersion: string
}

/** 本地持久化的事件确认记录。 */
export interface InstallEventRecord {
  /** 已确认安装或升级到的版本。 */
  version: string
  /** 本地确认时间，ISO 字符串。 */
  confirmedAt: string
}

/** 通知邮件使用的运行环境信息。 */
export interface InstallEventEnvironment {
  /** 操作系统平台。 */
  platform: string
  /** 操作系统内核版本。 */
  osRelease: string
  /** 本地事件时间展示字符串。 */
  eventTime: string
}

/** 通知服务构造选项。 */
export interface InstallEventServiceOptions {
  /** SMTP 配置。 */
  config: UsageReportConfig
  /** 运行环境信息。 */
  environment: InstallEventEnvironment
  /** 可注入的公网 IP 获取函数。 */
  fetchIp?: () => Promise<string | null>
  /** 可注入的 transporter，测试使用；缺省惰性加载 nodemailer。 */
  transporter?: Transporter
  /** 可注入的事件文件路径。 */
  filePath?: string
}

/** 默认公网 IP 服务，按顺序回退。 */
const PUBLIC_IP_URLS = [
  'https://api.ipify.org',
  'https://ipv4.icanhazip.com',
  'https://api.my-ip.io/v4/ip'
] as const
/** IPv4 格式校验。 */
const IPV4_PATTERN = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u
/** 单个公网 IP 服务超时时间。 */
const PUBLIC_IP_TIMEOUT_MS = 5_000

/**
 * 安装通知配置读取依赖。
 * @author zhenghq
 */
interface ConfigReaderOptions {
  /** 按优先级排列的候选配置目录。 */
  getDirectories: () => string[]
  /** 文件存在性判断。 */
  exists: (path: string) => boolean
  /** 配置文件读取函数。 */
  readConfig: (path: string) => UsageReportConfig
}

/**
 * 读取安装通知 SMTP 配置，兼容打包目录和本地运行目录。
 * @param options 可注入读取依赖。
 * @returns 配置与命中的配置路径。
 * @author zhenghq
 */
export function loadInstallNotificationConfig(options: ConfigReaderOptions): {
  config: UsageReportConfig
  configPath: string | null
} {
  for (const directory of Array.from(new Set(options.getDirectories()))) {
    const configPath = join(directory, 'usage-report-config.json')
    if (options.exists(configPath)) {
      return { config: options.readConfig(configPath), configPath }
    }
  }
  return { config: { smtpUser: '', smtpPass: '', reportTo: '' }, configPath: null }
}

/**
 * 格式化安装升级事件本地时间。
 * @param now 事件时间，默认当前时间。
 * @returns 运行时兼容的中文日期时间字符串。
 * @author zhenghq
 */
export function formatInstallEventTime(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'long'
  }).format(now)
}

/**
 * 根据持久化记录判定当前启动事件。
 * @param record 已持久化的事件确认。
 * @param currentVersion 当前应用版本。
 * @returns 待发送事件；同版本返回 null。
 * @author zhenghq
 */
export function detectInstallEvent(
    record: InstallEventRecord | null,
    currentVersion: string
): InstallEvent | null {
  if (!record) {
    return { type: 'install', previousVersion: null, currentVersion }
  }
  if (record.version === currentVersion) return null
  return { type: 'upgrade', previousVersion: record.version, currentVersion }
}

/**
 * 构造安装或升级事件邮件正文（统一美化风格，与统计日报样式一致）
 * @param event 当前事件。
 * @param context IP 与运行环境信息。
 * @returns 格式化邮件正文。
 * @author zhenghq
 */
export function buildInstallEventBody(
    event: InstallEvent,
    context: { ip: string } & InstallEventEnvironment
): string {
  // 与统计日报统一的分割线样式
  const DIVIDER = '============================================================'
  const SUB_DIVIDER = '------------------------------------------------------------'
  const eventType = event.type === 'install' ? '首次安装' : '版本升级'

  const lines: string[] = [
    '',
    DIVIDER,
    '                划词翻译 - 安装/升级事件通知',
    DIVIDER,
    '',
    '【 事件基础信息 】',
    SUB_DIVIDER,
    `  📌 事件类型：${eventType}`,
    `  🔙 上一版本：${event.previousVersion ?? '无（全新安装）'}`,
    `  ✅ 当前版本：${event.currentVersion}`,
    `  🕒 事件时间：${context.eventTime}`,
    '',
    '【 运行环境信息 】',
    SUB_DIVIDER,
    `  💻 操作系统：${context.platform} (内核版本：${context.osRelease})`,
    `  🌐 访问公网IP：${context.ip}`,
    '',
    DIVIDER,
    '  说明：本通知为自动化系统上报，仅记录设备安装/升级行为，无任何用户隐私数据',
    DIVIDER,
    ''
  ]

  return lines.join('\n')
}

/**
 * 获取并校验公网 IPv4 地址。
 * @param fetch 可注入的网络请求函数。
 * @returns 有效 IP；无效响应返回 null。
 * @author zhenghq
 */
export async function resolvePublicIpAddress(
    fetch: typeof globalThis.fetch = globalThis.fetch
): Promise<string | null> {
  for (const url of PUBLIC_IP_URLS) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(PUBLIC_IP_TIMEOUT_MS) })
      if (!response.ok) continue
      const value = (await response.text()).trim()
      if (IPV4_PATTERN.test(value)) return value
    } catch {
      // 单个服务失败继续尝试下一个服务
    }
  }
  return null
}

/**
 * 创建本地事件文件路径。
 * @returns 用户数据目录下的事件文件绝对路径。
 * @author zhenghq
 */
function defaultFilePath(): string {
  const electron = require('electron') as typeof import('electron')
  return `${electron.app.getPath('userData')}/install-events.json`
}

/**
 * 读取事件确认记录，损坏或缺失时返回空记录。
 * @param path 事件文件路径。
 * @returns 已确认记录或 null。
 * @author zhenghq
 */
function readRecord(path: string): InstallEventRecord | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<InstallEventRecord>
    if (typeof raw.version === 'string' && raw.version && typeof raw.confirmedAt === 'string') {
      return { version: raw.version, confirmedAt: raw.confirmedAt }
    }
  } catch {
    // 损坏文件按首次安装处理，不让通知影响主流程
  }
  return null
}

/**
 * 原子写入事件确认记录。
 * @param path 事件文件路径。
 * @param record 待写入记录。
 * @returns 无返回值。
 * @author zhenghq
 */
function writeRecord(path: string, record: InstallEventRecord): void {
  const temporaryPath = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(temporaryPath, JSON.stringify(record, null, 2))
  renameSync(temporaryPath, path)
}

/**
 * 创建安装与升级通知服务。
 * @param options 服务配置和可注入依赖。
 * @returns 事件处理服务。
 * @author zhenghq
 */
export function createInstallEventService(options: InstallEventServiceOptions) {
  const path = options.filePath ?? defaultFilePath()
  const fetchIp = options.fetchIp ?? (async () => {
    try {
      return await resolvePublicIpAddress()
    } catch {
      return null
    }
  })

  return {
    /**
     * 读取当前事件确认记录。
     * @returns 已确认记录或 null。
     * @author zhenghq
     */
    readRecord(): InstallEventRecord | null {
      return readRecord(path)
    },
    /**
     * 判定并发送当前启动事件；成功后确认当前版本。
     * @param currentVersion 当前应用版本。
     * @returns 发送成功返回 true；无事件返回 false。
     * @author zhenghq
     */
    async processLaunch(currentVersion: string): Promise<boolean> {
      const event = detectInstallEvent(readRecord(path), currentVersion)
      if (!event) return false
      const ip = await fetchIp()
      if (!ip) throw new Error('无法获取公网 IP')
      const transporter = options.transporter ?? (require('nodemailer') as typeof import('nodemailer')).createTransport({
        host: 'smtp.qq.com',
        port: 465,
        secure: true,
        auth: { user: options.config.smtpUser, pass: options.config.smtpPass },
        connectionTimeout: 15_000,
        socketTimeout: 20_000
      })
      try {
        await transporter.sendMail({
          from: `"划词翻译-系统通知" <${options.config.smtpUser}>`,
          to: options.config.reportTo,
          subject: `【划词翻译】${event.type === 'install' ? '首次安装' : '版本升级'}通知 - ${event.currentVersion}`,
          text: buildInstallEventBody(event, { ...options.environment, ip })
        } satisfies SendMailOptions)
      } catch (error) {
        throw error
      }
      writeRecord(path, {
        version: currentVersion,
        confirmedAt: new Date().toISOString()
      })
      return true
    }
  }
}

/**
 * 从打包产物读取 SMTP 配置并触发安装或升级通知。
 * @returns 发送成功返回 true；配置缺失或无事件返回 false。
 * @author zhenghq
 */
export async function maybeSendInstallUpgradeNotification(): Promise<boolean> {
  try {
    const electron = require('electron') as typeof import('electron')
    const { config, configPath: resolvedConfigPath } = loadInstallNotificationConfig({
      getDirectories: () => [
        join(electron.app.getAppPath(), 'build'),
        electron.app.getAppPath(),
        join(process.cwd(), 'build'),
        process.cwd()
      ],
      exists: existsSync,
      readConfig: (path) => JSON.parse(readFileSync(path, 'utf8')) as UsageReportConfig
    })
    if (!resolvedConfigPath) return false
    if (!config.smtpUser || !config.smtpPass || !config.reportTo) return false
    const eventTime = formatInstallEventTime()
    const service = createInstallEventService({
      config,
      environment: {
        platform: process.platform,
        osRelease: release(),
        eventTime
      }
    })
    return await service.processLaunch(electron.app.getVersion())
  } catch {
    return false
  }
}

// ====================== 以下为原有统计上报完整代码（保留不变，样式统一） ======================
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
