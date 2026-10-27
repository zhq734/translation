import { normalizeSemanticVersion } from '../shared/buildMetadata'
import { compareSemanticVersions } from '../shared/updateAvailability'
import { translateMain } from './messages'
import type {
  UpdateDriver,
  UpdateDriverInfo,
  UpdateDriverListeners
} from './updateManager'

/** GitHub latest Release API 地址；Win7 轻量更新只读取公开元数据。 */
const WIN7_RELEASE_API_URL = 'https://api.github.com/repos/zhq734/translation/releases/latest'

/** 兼容测试注入与 Electron Session 的 fetch 函数签名。 */
export type Win7UpdateFetch = (
  input: string | Request,
  init?: RequestInit
) => Promise<Response>

/** Win7 更新驱动选项。 */
export interface Win7UpdateDriverOptions {
  /** 当前已安装版本。 */
  currentVersion: string
  /** 使用应用代理会话的 fetch 实现。 */
  fetch: Win7UpdateFetch
}

/** GitHub Release API 中本驱动使用的最小资产结构。 */
interface GitHubReleaseAsset {
  /** Release 资产文件名。 */
  name?: unknown
}

/** GitHub Release API 中本驱动使用的最小响应结构。 */
interface GitHubReleaseResponse {
  /** Release 标签，例如 v1.2.6。 */
  tag_name?: unknown
  /** Release 资产列表。 */
  assets?: unknown
}

/**
 * 解析 GitHub Release 响应，并校验最新版本对应的 Win7 x64 安装包。
 * @param response GitHub Release API 响应。
 * @returns 规范化版本号与安装包文件名。
 * @author zhenghq
 */
function parseWin7Release(response: GitHubReleaseResponse): {
  version: string
  assetName: string
} {
  const rawVersion = typeof response.tag_name === 'string' ? response.tag_name : ''
  const version = normalizeSemanticVersion(rawVersion)
  if (!version) {
    throw new Error(translateMain('win7.update.error.invalidReleaseVersion', {
      version: rawVersion || '-'
    }))
  }

  const assetName = `SelectionTranslator-${version}-Setup-win7-x64.exe`
  const assets = Array.isArray(response.assets) ? response.assets : []
  const hasWin7Asset = assets.some((asset) => {
    const candidate = asset as GitHubReleaseAsset
    return candidate?.name === assetName
  })
  if (!hasWin7Asset) {
    throw new Error(translateMain('win7.update.error.missingAsset', {
      version,
      asset: assetName
    }))
  }
  return { version, assetName }
}

/**
 * 使用 GitHub Release API 实现 Win7 轻量更新检查。
 *
 * 该驱动不依赖 electron-updater、builder-util-runtime 或现代更新适配器，
 * 只负责发现新版本；下载与覆盖安装始终由用户打开 Release 页面后手动完成。
 * @author zhenghq
 */
export class Win7UpdateDriver implements UpdateDriver {
  private listeners: UpdateDriverListeners | null = null

  /**
   * 创建 Win7 轻量更新驱动。
   * @param options 当前版本与代理会话 fetch。
   * @author zhenghq
   */
  constructor(private readonly options: Win7UpdateDriverOptions) {}

  /**
   * 保存更新管理器提供的事件监听器。
   * @param listeners 更新生命周期监听器。
   * @returns 无返回值。
   * @author zhenghq
   */
  initialize(listeners: UpdateDriverListeners): void {
    this.listeners = listeners
  }

  /**
   * 请求 GitHub latest Release 并比较版本。
   * @returns 检查完成后的 Promise。
   * @author zhenghq
   */
  async checkForUpdates(): Promise<void> {
    const listeners = this.listeners
    if (!listeners) throw new Error(translateMain('win7.update.error.notInitialized'))
    listeners.checking()

    const currentVersion = normalizeSemanticVersion(this.options.currentVersion)
    if (!currentVersion) {
      throw new Error(translateMain('win7.update.error.invalidCurrentVersion', {
        version: this.options.currentVersion
      }))
    }

    const response = await this.options.fetch(WIN7_RELEASE_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `SelectionTranslator/${currentVersion}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
    if (!response.ok) {
      throw new Error(translateMain('win7.update.error.http', {
        status: response.status
      }))
    }

    let body: GitHubReleaseResponse
    try {
      body = await response.json() as GitHubReleaseResponse
    } catch {
      throw new Error(translateMain('win7.update.error.invalidJson'))
    }
    const release = parseWin7Release(body)
    const comparison = compareSemanticVersions(release.version, currentVersion)
    if (comparison === null) {
      throw new Error(translateMain('win7.update.error.compareVersion', {
        remote: release.version,
        current: currentVersion
      }))
    }

    const info: UpdateDriverInfo = { version: release.version }
    if (comparison > 0) {
      listeners.available(info)
      return
    }
    listeners.notAvailable(info)
  }

  /**
   * Win7 不通过驱动下载安装包；更新管理器会改为打开 Release 页面。
   * @returns 已完成的 Promise。
   * @author zhenghq
   */
  async downloadUpdate(): Promise<void> {}

  /**
   * Win7 轻量驱动没有后台下载任务可取消。
   * @returns 无返回值。
   * @author zhenghq
   */
  cancelDownload(): void {}

  /**
   * Win7 不支持由应用退出并安装更新。
   * @returns 无返回值。
   * @author zhenghq
   */
  installUpdate(): void {}
}
