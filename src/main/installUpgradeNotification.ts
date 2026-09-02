import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { dirname } from 'node:path'
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

/** 默认公网 IP 服务。 */
const PUBLIC_IP_URL = 'https://api.ipify.org'
/** IPv4 格式校验。 */
const IPV4_PATTERN = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u

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
  const response = await fetch(PUBLIC_IP_URL)
  if (!response.ok) return null
  const value = (await response.text()).trim()
  return IPV4_PATTERN.test(value) ? value : null
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
      await transporter.sendMail({
        from: options.config.smtpUser,
        to: options.config.reportTo,
        subject: `划词翻译${event.type === 'install' ? '首次安装' : '升级'} ${event.currentVersion}`,
        text: buildInstallEventBody(event, { ...options.environment, ip })
      } satisfies SendMailOptions)
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
    const configPath = `${electron.app.getAppPath()}/build/usage-report-config.json`
    if (!existsSync(configPath)) return false
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as UsageReportConfig
    if (!config.smtpUser || !config.smtpPass || !config.reportTo) return false
    const eventTime = new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'medium',
      timeStyle: 'long',
      timeZoneName: 'shortOffset'
    }).format(new Date())
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
