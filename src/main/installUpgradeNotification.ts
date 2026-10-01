import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import type { Transporter } from 'nodemailer'
import type { SendMailOptions } from 'nodemailer'
import {
  createTranslator,
  type Locale,
  type Translator
} from '../shared/i18n/index.ts'
import { resolveIpLocation, resolvePublicIpAddress } from './ipLocation.ts'
import { detectMainProcessLocale, formatLocaleDateTime, localeFieldSeparator } from './localeFormat.ts'
import type { UsageReportConfig } from './usageReporter.ts'

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
  /** 可注入的 IP 归属地获取函数。 */
  fetchLocation?: (ip: string) => Promise<string | null>
  /** 可注入的 transporter，测试使用；缺省惰性加载 nodemailer。 */
  transporter?: Transporter
  /** 可注入的事件文件路径。 */
  filePath?: string
  /** 邮件文案翻译器；未提供时按 locale 或当前系统语言创建。 */
  translator?: Translator
  /** 邮件文案界面语言；显式传入时优先于系统语言。 */
  locale?: Locale
}

// 复用共享 IP 查询实现，保持安装通知与统计日报行为一致
export { resolvePublicIpAddress } from './ipLocation.ts'

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
 * 固定使用东八区（Asia/Shanghai）时区，确保上报时间在不同运行环境下展示一致。
 * @param now 事件时间，默认当前时间。
 * @param locale 界面语言；未传入时使用简体中文以保持既有调用兼容。
 * @returns 与界面语言一致的日期时间字符串。
 * @author zhenghq
 */
export function formatInstallEventTime(
  now: Date = new Date(),
  locale: Locale = 'zh-CN'
): string {
  return formatLocaleDateTime(now, locale, {
    dateStyle: 'medium',
    timeStyle: 'long',
    timeZone: 'Asia/Shanghai'
  })
}

/**
 * 解析通知服务应使用的翻译器，显式注入优先，未注入时保持简体中文兼容行为。
 * @param options 通知服务或入口选项。
 * @returns 当前界面语言翻译器。
 * @author zhenghq
 */
function resolveNotificationTranslator(options: { translator?: Translator; locale?: Locale }): Translator {
  if (options.translator) return options.translator
  if (options.locale) return createTranslator(options.locale)
  return createTranslator('zh-CN')
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
 * @param translatorOrLocale 界面语言翻译器或 locale；缺省使用简体中文以保持既有调用兼容。
 * @returns 格式化邮件正文。
 * @author zhenghq
 */
export function buildInstallEventBody(
    event: InstallEvent,
    context: { ip: string; location?: string | null } & InstallEventEnvironment,
    translatorOrLocale?: Translator | Locale
): string {
  const translator = typeof translatorOrLocale === 'string'
    ? createTranslator(translatorOrLocale)
    : translatorOrLocale ?? createTranslator('zh-CN')
  const separator = localeFieldSeparator(translator.locale)
  // 与统计日报统一的分割线样式
  const DIVIDER = '============================================================'
  const SUB_DIVIDER = '------------------------------------------------------------'
  const eventType = translator.t(event.type === 'install'
    ? 'notification.event.install'
    : 'notification.event.upgrade')

  const lines: string[] = [
    '',
    DIVIDER,
    `                ${translator.t('notification.title')}`,
    DIVIDER,
    '',
    `【 ${translator.t('notification.section.event')} 】`,
    SUB_DIVIDER,
    `  📌 ${translator.t('notification.event.type')}${separator}${eventType}`,
    `  🔙 ${translator.t('notification.previousVersion')}${separator}${event.previousVersion ?? translator.t('notification.previousVersion.none')}`,
    `  ✅ ${translator.t('notification.currentVersion')}${separator}${event.currentVersion}`,
    `  🕒 ${translator.t('notification.eventTime')}${separator}${context.eventTime}`,
    '',
    `【 ${translator.t('notification.section.environment')} 】`,
    SUB_DIVIDER,
    `  💻 ${translator.t('notification.platform')}${separator}${context.platform} (${translator.t('notification.kernel')}${separator}${context.osRelease})`,
    `  🌐 ${translator.t('notification.ip')}${separator}${context.ip}`,
    `  📍 ${translator.t('notification.location')}${separator}${context.location || translator.t('notification.unknown')}`,
    '',
    DIVIDER,
    `  ${translator.t('notification.footer')}`,
    DIVIDER,
    ''
  ]

  return lines.join('\n')
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
  const translator = resolveNotificationTranslator(options)
  const fetchIp = options.fetchIp ?? (async () => {
    try {
      return await resolvePublicIpAddress()
    } catch {
      return null
    }
  })
  const fetchLocation = options.fetchLocation ?? (async (ip: string) => {
    try {
      return await resolveIpLocation(ip)
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
      if (!ip) throw new Error(translator.t('notification.ipUnavailable'))
      // 归属地查询失败不影响通知发送，正文按「未知」降级展示
      const location = await fetchLocation(ip)
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
          from: `"${translator.t('notification.brand')}" <${options.config.smtpUser}>`,
          to: options.config.reportTo,
          subject: translator.t(event.type === 'install'
            ? 'notification.install.subject'
            : 'notification.upgrade.subject', { version: event.currentVersion }),
          text: buildInstallEventBody(event, { ...options.environment, ip, location }, translator)
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
    const translator = createTranslator(detectMainProcessLocale())
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
    const eventTime = formatInstallEventTime(new Date(), translator.locale)
    const service = createInstallEventService({
      config,
      environment: {
        platform: process.platform,
        osRelease: release(),
        eventTime
      },
      translator
    })
    return await service.processLaunch(electron.app.getVersion())
  } catch {
    return false
  }
}

// 保持原有导出契约，统一转发到已本地化的统计上报模块，避免两份实现产生差异。
export type {
  TranslationOriginLike,
  UsageReportConfig,
  UsageReportEnvironment,
  UsageReportNetwork,
  SendUsageReportOptions
} from './usageReporter.ts'

export {
  previousDate,
  buildReportBody,
  sendUsageReport,
  maybeSendUsageReport,
  resetUsageReportStore,
  markHotkeyTrigger,
  recordTranslationUsage,
  recordWebPageUsage
} from './usageReporter.ts'
