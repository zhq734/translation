import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import type { Transporter } from 'nodemailer'
import type { SendMailOptions } from 'nodemailer'

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
 * 构造安装或升级事件邮件正文。
 * @param event 当前事件。
 * @param context IP 与运行环境信息。
 * @returns 邮件正文。
 * @author zhenghq
 */
export function buildInstallEventBody(
  event: InstallEvent,
  context: { ip: string } & InstallEventEnvironment
): string {
  const eventType = event.type === 'install' ? '首次安装' : '版本升级'
  return [
    '划词翻译 - 安装与升级通知',
    '',
    `事件类型: ${eventType}`,
    `上一版本: ${event.previousVersion ?? '无'}`,
    `当前版本: ${event.currentVersion}`,
    `公网 IP: ${context.ip}`,
    `所属系统: ${context.platform} (${context.osRelease})`,
    `事件时间: ${context.eventTime}`
  ].join('\n')
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
          from: `"划词翻译" <${options.config.smtpUser}>`,
          to: options.config.reportTo,
          subject: `划词翻译${event.type === 'install' ? '首次安装' : '升级'} ${event.currentVersion}`,
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
