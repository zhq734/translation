import { formatBuildIdLabel, type BuildMetadata } from '../shared/buildMetadata'
import type {
  UpdateAction,
  UpdateInstallMode,
  UpdatePhase,
  UpdateProgress,
  UpdateStatus
} from '../shared/types'
import { decideUpdateAvailability } from '../shared/updateAvailability'
import type { ManualMacUpdateService } from './manualMacUpdate'
import type { ReleaseChecksumStatus } from './releaseChecksums'

export type { ManualMacUpdateService } from './manualMacUpdate'

/** 检查更新遇到可恢复网络错误时的最大尝试次数（含首次请求）。 */
const UPDATE_CHECK_MAX_ATTEMPTS = 3
/** 检查更新重试之间的基础等待毫秒数，按尝试次数线性退避。 */
const UPDATE_CHECK_RETRY_BASE_DELAY_MS = 600

/**
 * 更新包下载遇到可恢复网络中断时的最大尝试次数（含首次下载）。
 * 分片下载会把已完成字节与断点记录保留在独立续传目录，因此重试只补齐
 * 剩余字节，不会重新下载整包。
 */
const UPDATE_DOWNLOAD_MAX_ATTEMPTS = 3
/** 更新包下载重试之间的基础等待毫秒数，按尝试次数线性退避。 */
const UPDATE_DOWNLOAD_RETRY_BASE_DELAY_MS = 1_000

/** electron-updater 返回的最小版本信息。 */
export interface UpdateDriverInfo {
  /** 可用或已下载版本号。 */
  version: string
  /** 手动安装模式可直接下载的 macOS DMG 地址。 */
  manualDownloadUrl?: string
  /** 该 DMG 在更新清单中的 base64 sha512 校验值。 */
  manualDownloadSha512?: string
  /** 该 DMG 在更新清单中的字节长度。 */
  manualDownloadSize?: number
  /** 最新安装包在 SHA256SUMS 中的校验状态。 */
  checksumStatus?: ReleaseChecksumStatus
  /** 当前安装包内嵌的本地构建元数据。 */
  localBuild?: BuildMetadata
  /** 已通过摘要与格式校验的远程构建元数据。 */
  remoteBuild?: BuildMetadata
  /** 辅助构建元数据不可用的诊断原因。 */
  buildMetadataUnavailableReason?: string
}

/** electron-updater 返回的最小下载进度信息。 */
export interface UpdateDriverProgress extends UpdateProgress {}

/** 自动更新驱动向状态管理器上报的事件集合。 */
export interface UpdateDriverListeners {
  /**
   * 通知状态管理器开始检查更新。
   * @returns 无返回值。
   * @author zhenghq
   */
  checking(): void
  /**
   * 通知状态管理器检测到新版本。
   * @param info 新版本信息。
   * @returns 无返回值。
   * @author zhenghq
   */
  available(info: UpdateDriverInfo): void
  /**
   * 通知状态管理器当前已是最新版本。
   * @param info 远程版本信息。
   * @returns 无返回值。
   * @author zhenghq
   */
  notAvailable(info: UpdateDriverInfo): void
  /**
   * 通知状态管理器更新下载进度发生变化。
   * @param progress 当前下载进度。
   * @returns 无返回值。
   * @author zhenghq
   */
  progress(progress: UpdateDriverProgress): void
  /**
   * 通知状态管理器更新已经下载完成。
   * @param info 已下载版本信息。
   * @returns 无返回值。
   * @author zhenghq
   */
  downloaded(info: UpdateDriverInfo): void
  /**
   * 通知状态管理器更新流程发生错误。
   * @param error 自动更新异常。
   * @returns 无返回值。
   * @author zhenghq
   */
  error(error: Error): void
}

/** 隔离 electron-updater 的最小驱动接口，便于单元测试。 */
export interface UpdateDriver {
  /**
   * 初始化底层更新器并注册事件监听器。
   * @param listeners 自动更新事件监听器。
   * @returns 无返回值。
   * @author zhenghq
   */
  initialize(listeners: UpdateDriverListeners): void
  /**
   * 请求检查远程版本。
   * @returns 检查请求完成后的 Promise。
   * @author zhenghq
   */
  checkForUpdates(): Promise<void>
  /**
   * 下载已经发现的更新。
   * @returns 下载请求完成后的 Promise。
   * @author zhenghq
   */
  downloadUpdate(): Promise<void>
  /**
   * 取消正在进行的更新下载；未在下载时为空操作。
   * @returns 无返回值。
   * @author zhenghq
   */
  cancelDownload(): void
  /**
   * 退出应用并安装已经下载的更新。
   * @returns 无返回值。
   * @author zhenghq
   */
  installUpdate(): void
}

export interface UpdateManagerOptions {
  /** 自动更新底层驱动。 */
  driver: UpdateDriver
  /** 当前应用版本。 */
  currentVersion: string
  /** 当前运行环境是否允许检查更新。 */
  enabled: boolean
  /** 当前平台采用的安装模式。 */
  installMode: UpdateInstallMode
  /** GitHub Release 页面地址。 */
  releaseUrl: string
  /** 下载并打开手动 macOS 更新包的受限服务。 */
  manualUpdate?: ManualMacUpdateService
  /**
   * 使用系统默认浏览器打开外部页面。
   * @param url 需要打开的页面地址。
   * @returns 页面打开完成后的 Promise。
   * @author zhenghq
   */
  openExternal(url: string): Promise<void>
  /**
   * 接收自动更新状态变化并通知应用窗口。
   * @param status 最新自动更新状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  onStatusChanged(status: UpdateStatus): void
}

/**
 * 根据运行环境决定自动更新安装模式。
 * @param platform 当前 Node.js 平台标识。
 * @param packaged 当前应用是否为正式打包版本。
 * @param linuxAppImage Linux 是否从 AppImage 运行。
 * @param macSigned macOS 应用是否通过代码签名校验。
 * @param macDiskImage macOS 应用是否仍从已挂载的 DMG 中运行。
 * @returns 自动安装、手动安装或禁用模式。
 * @author zhenghq
 */
export function resolveUpdateInstallMode(
  platform: NodeJS.Platform,
  packaged: boolean,
  linuxAppImage: boolean,
  macSigned: boolean,
  macDiskImage = false
): UpdateInstallMode {
  if (!packaged) return 'disabled'
  if (platform === 'darwin') return macSigned && !macDiskImage ? 'automatic' : 'manual'
  if (platform === 'linux') return linuxAppImage ? 'automatic' : 'manual'
  return platform === 'win32' ? 'automatic' : 'manual'
}

/**
 * 从 macOS 可执行文件路径解析 `.app` 应用包根目录。
 * @param executablePath 当前应用可执行文件路径。
 * @returns 应用包根目录；路径不属于 `.app` 时返回 null。
 * @author zhenghq
 */
export function resolveMacOSAppBundlePath(executablePath: string): string | null {
  const marker = '.app/Contents/MacOS/'
  const markerIndex = executablePath.indexOf(marker)
  if (markerIndex < 0) return null
  return executablePath.slice(0, markerIndex + '.app'.length)
}

/**
 * 判断 codesign 详情是否表明应用使用预期团队的 Developer ID Application 正式分发签名。
 * @param signatureDetails `codesign -dv --verbose=4` 输出的签名详情。
 * @returns 使用 TeamIdentifier=499QMYBXLR 的 Developer ID Application 签名时返回 true。
 * @author zhenghq
 */
export function isMacOSDeveloperIdApplicationSignature(signatureDetails: string): boolean {
  return /^Authority=Developer ID Application:/mu.test(signatureDetails) &&
    /^TeamIdentifier=499QMYBXLR$/mu.test(signatureDetails)
}

/**
 * 判断底层更新异常是否为 macOS ShipIt 代码签名要求不匹配。
 * @param rawMessage 底层更新器返回的原始错误文本。
 * @returns 属于代码签名校验失败时返回 true。
 * @author zhenghq
 */
function isMacOSCodeSignatureValidationError(rawMessage: string): boolean {
  return /Code signature at URL[\s\S]*did not pass validation/iu.test(rawMessage) ||
    /代码未能满足指定的代码要求/u.test(rawMessage)
}

/**
 * 判断检查更新失败是否属于可自动重试的临时网络故障。
 *
 * Windows 上 GitHub 连接被重置、代理连接池被关闭或 TLS 握手被中断时，底层会
 * 抛出 `ERR_CONNECTION_CLOSED` 等一次性网络错误；这类错误与版本信息、签名或
 * Release 配置无关，稍后重试通常即可恢复。DNS 解析失败与连接超时也纳入重试，
 * 但 HTTP 404、校验失败等确定性错误不会重试。
 * @param error 底层更新器抛出的异常。
 * @returns 属于可恢复网络故障时返回 true。
 * @author zhenghq
 */
function isRetryableUpdateCheckError(error: unknown): boolean {
  const rawMessage = error instanceof Error ? error.message : String(error)
  return /ERR_(?:CONNECTION_CLOSED|CONNECTION_RESET|CONNECTION_ABORTED|CONNECTION_REFUSED|CONNECTION_FAILED|TIMED_OUT|NETWORK_CHANGED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/iu
    .test(rawMessage)
}

/**
 * 将临时网络故障转换为用户可理解且可操作的提示。
 * @param rawMessage 底层更新器返回的原始错误文本。
 * @returns 匹配到网络故障时返回中文提示，否则返回 undefined。
 * @author zhenghq
 */
function formatTransientNetworkErrorMessage(rawMessage: string): string | undefined {
  if (/ERR_(?:TIMED_OUT|CONNECTION_TIMED_OUT)|ETIMEDOUT|timeout/iu.test(rawMessage)) {
    return '更新失败：网络请求超时，请检查网络或代理设置后重试'
  }
  if (/ERR_(?:NAME_NOT_RESOLVED|INTERNET_DISCONNECTED)|ENOTFOUND|EAI_AGAIN/iu.test(rawMessage)) {
    return '更新失败：无法连接更新服务器，请检查网络或代理设置后重试'
  }
  if (isRetryableUpdateCheckError(rawMessage)) {
    return '更新失败：网络连接被中断，请检查网络或代理设置后重试'
  }
  return undefined
}

/**
 * 判断下载失败是否属于可自动重试并续传的连接中断。
 *
 * 分片下载在中途超时、连接被重置或被 Electron 中止时，已完成字节与断点记录
 * 会保留在独立续传目录；这类错误重试会从中断偏移继续，因此值得自动重试。
 * 校验失败、HTTP 状态错误等确定性失败不在其中，重复下载没有意义。
 * @param error 底层更新器抛出的异常。
 * @returns 属于可续传的连接中断时返回 true。
 * @author zhenghq
 */
function isResumableDownloadError(error: unknown): boolean {
  const rawMessage = error instanceof Error ? error.message : String(error)
  if (/checksum mismatch|更新包长度校验失败|HTTP \d{3}/iu.test(rawMessage)) return false
  // 用户主动取消不是网络故障，不能触发自动续传重试。
  if (isDownloadCancelledError(error)) return false
  return /分片(?:下载失败|请求超时|读取超时)|ERR_(?:CONNECTION_CLOSED|CONNECTION_RESET|CONNECTION_ABORTED|CONNECTION_REFUSED|CONNECTION_FAILED|TIMED_OUT|NETWORK_CHANGED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ABORTED)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|This operation was aborted|网络连接被中断/iu
    .test(rawMessage)
}

/**
 * 判断异常是否表示用户主动取消下载。
 *
 * 分片适配层在取消时抛出普通 `Error`（而非 electron-updater 的
 * `CancellationError`），底层因此会把它当作真实错误补发 `error` 事件；这里
 * 统一识别取消语义，避免已取消状态被覆盖成下载失败。
 * @param error 底层更新器抛出的异常。
 * @returns 属于用户取消时返回 true。
 * @author zhenghq
 */
function isDownloadCancelledError(error: unknown): boolean {
  const rawMessage = error instanceof Error ? error.message : String(error)
  return /下载已取消|已取消下载|cancell?ed/iu.test(rawMessage)
}

/**
 * 将下载连接中断转换为说明断点已保留的中文提示。
 * @param rawMessage 底层更新器返回的原始错误文本。
 * @returns 属于可续传中断时返回中文提示，否则返回 undefined。
 * @author zhenghq
 */
function formatResumableDownloadErrorMessage(rawMessage: string): string | undefined {
  if (!isResumableDownloadError(rawMessage)) return undefined
  return /超时|timed? out|ETIMEDOUT/iu.test(rawMessage)
    ? '更新失败：下载连接超时，已保留断点，可重新点击升级继续'
    : '更新失败：下载连接中断，已保留断点，可重新点击升级继续'
}

/**
 * 将 electron-updater 底层异常转换为简短、安全且可操作的用户提示。
 * @param error 自动更新异常。
 * @param phase 出错时所处的更新阶段，用于区分检查与下载的提示语义。
 * @returns 适合直接展示在设置页的错误信息。
 * @author zhenghq
 */
function formatUpdateErrorMessage(error: unknown, phase?: UpdatePhase): string {
  const rawMessage = error instanceof Error ? error.message : String(error)
  if (isMacOSCodeSignatureValidationError(rawMessage)) {
    return '更新包签名与当前应用不兼容，已改用手动安装；请下载 DMG，拖入“应用程序”并覆盖旧版本'
  }
  if (phase === 'downloading') {
    const resumeMessage = formatResumableDownloadErrorMessage(rawMessage)
    if (resumeMessage) return resumeMessage
  }
  const networkMessage = formatTransientNetworkErrorMessage(rawMessage)
  if (networkMessage) return networkMessage
  const metadataMatch = rawMessage.match(/Cannot find\s+(latest(?:-[\w-]+)?\.yml)\b/iu)
  if (metadataMatch && /\b404\b/u.test(rawMessage)) {
    return `当前 GitHub Release 缺少自动更新清单 ${metadataMatch[1]}，请稍后重新检查或打开发布页手动安装`
  }

  const firstLine = rawMessage.split(/\r?\n/u, 1)[0].replace(/\s+/gu, ' ').trim()
  const conciseMessage = firstLine.length > 240
    ? `${firstLine.slice(0, 239)}…`
    : firstLine
  return `更新失败：${conciseMessage || '未知错误'}`
}

/**
 * 将 SHA256SUMS 校验状态转换为附加在状态消息后的风险提示。
 * @param checksumStatus 安装包 SHA256SUMS 校验状态。
 * @returns 需要提示时返回以分号开头的说明，否则返回空字符串。
 * @author zhenghq
 */
function formatChecksumNotice(checksumStatus: ReleaseChecksumStatus | undefined): string {
  if (checksumStatus === 'missing') return '；Release 缺少当前安装包的 SHA256SUMS 校验值，建议升级'
  if (checksumStatus === 'mismatch') return '；Release 的 SHA256SUMS 与安装包不一致，建议重新升级'
  if (checksumStatus === 'unreachable') return '；无法读取 Release 的 SHA256SUMS 校验值，请确认安装包来源'
  return ''
}

/**
 * 管理自动更新状态、用户操作和平台降级策略。
 * @author zhenghq
 */
export class UpdateManager {
  private status: UpdateStatus
  private manualDownloadUrl: string | undefined
  private manualDownloadIntegrity: { sha512?: string; size?: number } | undefined
  /** 手动 DMG 下载的取消控制器；仅下载期间存在。 */
  private manualDownloadAbort: AbortController | undefined

  /**
   * 创建自动更新管理器并连接底层驱动事件。
   * @param options 自动更新依赖和运行环境选项。
   * @author zhenghq
   */
  constructor(private readonly options: UpdateManagerOptions) {
    const disabled = !options.enabled || options.installMode === 'disabled'
    this.status = {
      phase: disabled ? 'disabled' : 'idle',
      currentVersion: options.currentVersion,
      installMode: disabled ? 'disabled' : options.installMode,
      releaseUrl: options.releaseUrl,
      message: disabled ? '开发环境不会检查更新' : '尚未检查更新'
    }
    options.driver.initialize({
      checking: () => this.setStatus({ phase: 'checking', message: '正在检查更新…' }),
      available: (info) => this.handleAvailable(info),
      notAvailable: (info) => this.handleNotAvailable(info),
      progress: (progress) => this.handleProgress(progress),
      downloaded: (info) => this.handleDownloaded(info),
      error: (error) => this.handleDriverError(error)
    })
  }

  /**
   * 处理底层更新驱动广播的错误事件。
   *
   * electron-updater 在检查失败时会先同步广播 `error` 事件、再拒绝
   * `checkForUpdates()` 的 Promise。重试期间若直接把临时网络错误展示为最终
   * 失败，界面会先闪出错误提示，随后又被重试覆盖。这里把可恢复网络错误交回
   * `checkForUpdates()` 的重试循环统一处理，只在重试耗尽后展示最终错误。
   * @param error 底层更新驱动上报的异常。
   * @returns 无返回值。
   * @author zhenghq
   */
  private handleDriverError(error: Error): void {
    if (this.status.phase === 'checking' && isRetryableUpdateCheckError(error)) return
    // 下载中断重试期间同样先广播 error 事件；此时断点已经落盘，交给
    // `downloadUpdate()` 的重试循环统一处理，避免界面先闪出失败提示。
    if (this.status.phase === 'downloading' && isResumableDownloadError(error)) return
    // 用户取消后底层会把取消语义包装成普通错误补发事件，此时不得覆盖
    // 已经回到“可重新下载”的状态。
    if (isDownloadCancelledError(error)) return
    this.handleError(error)
  }

  /**
   * 获取当前自动更新状态的只读副本。
   * @returns 当前自动更新状态。
   * @author zhenghq
   */
  getStatus(): UpdateStatus {
    const status = { ...this.status }
    if (this.status.progress) {
      status.progress = { ...this.status.progress }
    } else {
      delete status.progress
    }
    return status
  }

  /**
   * 主动检查 GitHub Release 中的最新版本。
   * @returns 检查请求发出后的当前状态。
   * @author zhenghq
   */
  async checkForUpdates(): Promise<UpdateStatus> {
    if (this.status.phase === 'disabled' || this.status.phase === 'downloading') {
      return this.getStatus()
    }
    if (this.status.phase === 'checking') return this.getStatus()

    this.setStatus({ phase: 'checking', message: '正在检查更新…', progress: undefined })
    for (let attempt = 1; attempt <= UPDATE_CHECK_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.options.driver.checkForUpdates()
        return this.getStatus()
      } catch (error) {
        const isLastAttempt = attempt >= UPDATE_CHECK_MAX_ATTEMPTS
        if (isLastAttempt || !isRetryableUpdateCheckError(error)) {
          this.handleError(error)
          return this.getStatus()
        }
        // GitHub 在部分网络下会偶发重置连接；短暂等待后重试，避免用户看到
        // 一次网络抖动就判定更新失败。重试期间保持“正在检查更新”状态。
        await new Promise((resolve) => {
          setTimeout(resolve, UPDATE_CHECK_RETRY_BASE_DELAY_MS * attempt)
        })
      }
    }
    return this.getStatus()
  }

  /**
   * 下载新版本；手动安装模式下把 DMG 保存到 Downloads 并打开安装界面。
   * @returns 操作完成后的当前状态。
   * @author zhenghq
   */
  async downloadUpdate(): Promise<UpdateStatus> {
    if (this.status.updateAction === 'open-release') {
      return this.openReleaseForManualUpdate()
    }
    if (this.status.updateAction === 'verified-manual-download') {
      return this.downloadManualMacUpdate()
    }
    if (this.status.installMode === 'manual') {
      return this.downloadManualMacUpdate()
    }
    if (this.status.installMode !== 'automatic' || this.status.phase !== 'available') {
      return this.getStatus()
    }

    this.setStatus({
      phase: 'downloading',
      message: '正在下载更新…',
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }
    })
    for (let attempt = 1; attempt <= UPDATE_DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.options.driver.downloadUpdate()
        return this.getStatus()
      } catch (error) {
        // 下载期间用户取消时，底层抛出的中断异常不得覆盖已取消状态。
        if ((this.status.phase as UpdatePhase) !== 'downloading') return this.getStatus()
        const isLastAttempt = attempt >= UPDATE_DOWNLOAD_MAX_ATTEMPTS
        if (isLastAttempt || !isResumableDownloadError(error)) {
          this.handleError(error)
          return this.getStatus()
        }
        // 断点已经落盘，短暂等待后从中断偏移继续补齐剩余字节；重试期间保持
        // “正在下载更新”状态，避免界面在续传过程中闪出失败提示。
        this.setStatus({
          phase: 'downloading',
          message: `下载连接中断，正在从断点继续（第 ${attempt + 1} 次尝试）…`
        })
        await new Promise((resolve) => {
          setTimeout(resolve, UPDATE_DOWNLOAD_RETRY_BASE_DELAY_MS * attempt)
        })
      }
    }
    return this.getStatus()
  }

  /**
   * 安装已下载的新版本并重新启动应用。
   * @returns 无返回值。
   * @author zhenghq
   */
  installUpdate(): void {
    if (this.status.updateReason === 'same-version-new-build') return
    if (this.status.installMode !== 'automatic' || this.status.phase !== 'downloaded') return
    this.options.driver.installUpdate()
  }

  /**
   * 取消正在进行的更新下载，回到可重新下载状态，方便用户重新点击升级。
   * 自动安装模式通过驱动取消 electron-updater 下载；手动 DMG 模式通过
   * AbortSignal 中断分片或单流下载，已写入的断点续传记录会保留。
   * @returns 取消操作完成后的当前状态。
   * @author zhenghq
   */
  async cancelDownload(): Promise<UpdateStatus> {
    if (this.status.phase !== 'downloading') return this.getStatus()
    this.options.driver.cancelDownload()
    this.manualDownloadAbort?.abort()
    this.manualDownloadAbort = undefined
    this.setStatus({
      phase: 'available',
      message: '已取消下载，可重新点击升级继续',
      progress: undefined
    })
    return this.getStatus()
  }

  /**
   * 在系统默认浏览器中打开 GitHub Release 页面。
   * @returns 页面打开完成后的 Promise。
   * @author zhenghq
   */
  async openReleasePage(): Promise<void> {
    await this.options.openExternal(this.options.releaseUrl)
  }

  /**
   * 处理检测到新版本事件。
   * @param info 新版本信息。
   * @returns 无返回值。
   * @author zhenghq
   */
  private handleAvailable(info: UpdateDriverInfo): void {
    this.applyManualDownloadTarget(info)
    const decision = this.decide(info)
    const message = (this.status.installMode === 'automatic'
      ? `发现新版本 ${info.version}，可以下载并安装`
      : `发现新版本 ${info.version}，当前环境需要手动安装`) + formatChecksumNotice(info.checksumStatus)
    this.setStatus({
      phase: 'available',
      latestVersion: info.version,
      message,
      progress: undefined,
      manualDownloadAvailable: this.options.manualUpdate && info.manualDownloadUrl
        ? true
        : undefined,
      checksumStatus: info.checksumStatus,
      updateReason: 'higher-version',
      updateAction: this.status.installMode === 'automatic'
        ? 'automatic-download'
        : this.resolveManualUpdateAction(info),
      ...this.buildIdentityFields(info, decision)
    })
  }

  /**
   * 记录本次更新可用的手动 DMG 下载目标和完整性信息。
   * @param info 驱动上报的更新信息。
   * @returns 无返回值。
   * @author zhenghq
   */
  private applyManualDownloadTarget(info: UpdateDriverInfo): void {
    this.manualDownloadUrl = info.manualDownloadUrl
    this.manualDownloadIntegrity = info.manualDownloadSha512 || info.manualDownloadSize
      ? {
        ...(info.manualDownloadSha512 ? { sha512: info.manualDownloadSha512 } : {}),
        ...(info.manualDownloadSize ? { size: info.manualDownloadSize } : {})
      }
      : undefined
  }

  /**
   * 判断当前平台对本次更新可执行的手动交付动作。
   * @param info 驱动上报的更新信息。
   * @returns 具备受校验 DMG 目标时返回手动下载动作，否则返回打开 Release 动作。
   * @author zhenghq
   */
  private resolveManualUpdateAction(info: UpdateDriverInfo): UpdateAction {
    return this.options.manualUpdate && info.manualDownloadUrl
      ? 'verified-manual-download'
      : 'open-release'
  }

  /**
   * 使用纯函数决策器比较版本号与构建身份。
   * @param info 驱动上报的更新信息。
   * @returns 更新判断结果。
   * @author zhenghq
   */
  private decide(info: UpdateDriverInfo): ReturnType<typeof decideUpdateAvailability> {
    return decideUpdateAvailability({
      currentVersion: this.status.currentVersion,
      remoteVersion: info.version,
      ...(info.localBuild ? { localBuild: info.localBuild } : {}),
      ...(info.remoteBuild ? { remoteBuild: info.remoteBuild } : {})
    })
  }

  /**
   * 生成构建标识的脱敏展示字段。
   * @param info 驱动上报的更新信息。
   * @param decision 更新判断结果。
   * @returns 可直接合并进状态的构建标识字段。
   * @author zhenghq
   */
  private buildIdentityFields(
    info: UpdateDriverInfo,
    decision: ReturnType<typeof decideUpdateAvailability>
  ): Partial<UpdateStatus> {
    const comparable = Boolean(decision.localBuildId && decision.remoteBuildId)
    return {
      localBuildLabel: formatBuildIdLabel(decision.localBuildId ?? info.localBuild?.buildId) || undefined,
      remoteBuildLabel: formatBuildIdLabel(decision.remoteBuildId ?? info.remoteBuild?.buildId) || undefined,
      buildMetadataAvailable: comparable
    }
  }

  /**
   * 处理当前已经是最新版本事件。
   * @param info 当前远程版本信息。
   * @returns 无返回值。
   * @author zhenghq
   */
  private handleNotAvailable(info: UpdateDriverInfo): void {
    const decision = this.decide(info)
    const checksumNeedsUpdate = info.checksumStatus === 'missing' || info.checksumStatus === 'mismatch'
    const sameVersionNewBuild = decision.outcome === 'same-version-new-build'
    const needsUpdate = sameVersionNewBuild || checksumNeedsUpdate
    const identityFields = this.buildIdentityFields(info, decision)

    if (needsUpdate) {
      this.applyManualDownloadTarget(info)
    } else {
      this.manualDownloadUrl = undefined
      this.manualDownloadIntegrity = undefined
    }

    this.setStatus({
      phase: needsUpdate ? 'available' : 'not-available',
      latestVersion: info.version || this.status.currentVersion,
      message: sameVersionNewBuild
        ? this.formatSameVersionMessage(info, decision)
        : checksumNeedsUpdate
          ? info.checksumStatus === 'mismatch'
            ? '当前版本的 SHA256SUMS 校验值不一致，建议升级'
            : '当前版本没有 SHA256SUMS 校验值，建议升级'
          : identityFields.buildMetadataAvailable
            ? `当前已经是最新构建（构建 ${identityFields.localBuildLabel}）`
            : '当前已经是最新版本',
      progress: undefined,
      manualDownloadAvailable: needsUpdate && this.options.manualUpdate && info.manualDownloadUrl
        ? true
        : undefined,
      checksumStatus: info.checksumStatus,
      updateReason: sameVersionNewBuild ? 'same-version-new-build' : undefined,
      updateAction: needsUpdate ? this.resolveManualUpdateAction(info) : undefined,
      ...identityFields
    })
  }

  /**
   * 组织同版本新构建的用户提示文案。
   * @param info 驱动上报的更新信息。
   * @param decision 更新判断结果。
   * @returns 面向用户的同版本新构建说明。
   * @author zhenghq
   */
  private formatSameVersionMessage(
    info: UpdateDriverInfo,
    decision: ReturnType<typeof decideUpdateAvailability>
  ): string {
    const version = info.version || this.status.currentVersion
    const localLabel = formatBuildIdLabel(decision.localBuildId)
    const remoteLabel = formatBuildIdLabel(decision.remoteBuildId)
    const action = this.resolveManualUpdateAction(info) === 'verified-manual-download'
      ? '可下载 DMG 覆盖安装'
      : '请打开 GitHub Release 手动更新'
    return `发现同版本的新构建 ${version}（当前构建 ${localLabel}，最新构建 ${remoteLabel}），${action}` +
      formatChecksumNotice(info.checksumStatus)
  }

  /**
   * 处理更新包下载进度事件。
   * @param progress 当前下载进度。
   * @returns 无返回值。
   * @author zhenghq
   */
  private handleProgress(progress: UpdateDriverProgress): void {
    // 用户取消后底层驱动可能仍补发迟到进度，忽略以保持已取消状态。
    if (this.status.phase !== 'downloading') return
    this.setStatus({
      phase: 'downloading',
      message: `正在下载更新… ${Math.max(0, Math.min(100, progress.percent)).toFixed(1)}%`,
      progress: { ...progress }
    })
  }

  /**
   * 处理更新包下载完成事件。
   * @param info 已下载版本信息。
   * @returns 无返回值。
   * @author zhenghq
   */
  private handleDownloaded(info: UpdateDriverInfo): void {
    // 用户取消后底层驱动可能仍补发下载完成事件，忽略以保持已取消状态。
    if (this.status.phase !== 'downloading') return
    this.setStatus({
      phase: 'downloaded',
      latestVersion: info.version,
      message: `版本 ${info.version} 已下载，重启后完成升级`,
      progress: this.status.progress
        ? { ...this.status.progress, percent: 100 }
        : { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 }
    })
  }

  /**
   * 为无法安全自动安装的平台打开 GitHub Release 手动更新入口。
   * @returns 操作完成后的当前状态。
   * @author zhenghq
   */
  private async openReleaseForManualUpdate(): Promise<UpdateStatus> {
    if (this.status.phase === 'checking' || this.status.phase === 'downloading') {
      return this.getStatus()
    }
    await this.openReleasePage()
    this.setStatus({
      message: '已打开 GitHub Release，请手动下载对应平台的安装包覆盖安装'
    })
    return this.getStatus()
  }

  /**
   * 下载并打开手动 macOS 更新包；缺少 DMG 地址时回退到 GitHub Release。
   * @returns 操作完成后的当前状态。
   * @author zhenghq
   */
  private async downloadManualMacUpdate(): Promise<UpdateStatus> {
    if (this.status.phase === 'checking' || this.status.phase === 'downloading') {
      return this.getStatus()
    }

    const version = this.status.latestVersion
    if (!version || !this.manualDownloadUrl || !this.options.manualUpdate) {
      await this.openReleasePage()
      this.setStatus({
        message: '当前更新清单没有可直接下载的 DMG，已打开 GitHub Release，请手动下载安装'
      })
      return this.getStatus()
    }

    this.setStatus({
      phase: 'downloading',
      message: '正在下载 macOS DMG 更新包…',
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
      manualDownloadPath: undefined
    })
    try {
      const abortController = new AbortController()
      this.manualDownloadAbort = abortController
      const downloadPromise = this.options.manualUpdate.downloadAndOpen(
        this.manualDownloadUrl,
        version,
        (progress) => this.handleProgress(progress),
        this.manualDownloadIntegrity,
        abortController.signal
      )
      let result
      try {
        result = await downloadPromise
      } finally {
        if (this.manualDownloadAbort === abortController) {
          this.manualDownloadAbort = undefined
        }
      }
      // 下载期间用户取消时，迟到的下载完成结果不得覆盖已取消状态。
      if ((this.status.phase as UpdatePhase) !== 'downloading') return this.getStatus()
      const integrityNotice = result.verified
        ? ''
        : '；本次更新清单未提供该 DMG 的校验值，安装包未经完整性校验'
      this.setStatus({
        phase: 'manual-downloaded',
        message: '更新包已下载到“下载”文件夹并打开 DMG；请把“划词翻译”拖入“应用程序”覆盖旧版本，然后点击“解除 macOS 隔离属性”' +
          integrityNotice,
        progress: this.status.progress
          ? { ...this.status.progress, percent: 100 }
          : { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 },
        manualDownloadPath: result.path
      })
    } catch (error) {
      // 下载期间用户取消时，底层抛出的中断异常不得覆盖已取消状态。
      if ((this.status.phase as UpdatePhase) !== 'downloading') return this.getStatus()
      this.handleError(error)
    }
    return this.getStatus()
  }

  /**
  * 将底层异常转换为设置页可展示的错误状态。
   * @param error 自动更新异常。
   * @returns 无返回值。
   * @author zhenghq
  */
  private handleError(error: unknown): void {
    const rawMessage = error instanceof Error ? error.message : String(error)
    const signatureValidationFailed = isMacOSCodeSignatureValidationError(rawMessage)
    const errorPhase = this.status.phase as UpdatePhase
    this.setStatus({
      phase: 'error',
      installMode: signatureValidationFailed ? 'manual' : this.status.installMode,
      message: formatUpdateErrorMessage(error, errorPhase),
      progress: undefined,
      manualDownloadAvailable: signatureValidationFailed && this.options.manualUpdate &&
        this.manualDownloadUrl
        ? true
        : this.status.manualDownloadAvailable
    })
  }

  /**
   * 合并状态补丁、复制可变数据并通知所有窗口。
   * @param patch 自动更新状态补丁。
   * @returns 无返回值。
   * @author zhenghq
   */
  private setStatus(patch: Partial<UpdateStatus>): void {
    this.status = {
      ...this.status,
      ...patch,
      progress: patch.progress
        ? { ...patch.progress }
        : patch.progress === undefined && 'progress' in patch
          ? undefined
          : this.status.progress
    }
    this.options.onStatusChanged(this.getStatus())
  }
}
