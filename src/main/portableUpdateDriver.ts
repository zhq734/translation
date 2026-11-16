import { normalizeSemanticVersion } from '../shared/buildMetadata'
import { compareSemanticVersions } from '../shared/updateAvailability'
import { translateMain } from './messages'
import type { UpdateDriver, UpdateDriverListeners } from './updateManager'

/** 固定可信发布页；不使用远端响应中的任意链接。 */
export const PORTABLE_RELEASE_URL = 'https://github.com/zhq734/translation/releases/latest'
const RELEASE_API_URL = 'https://api.github.com/repos/zhq734/translation/releases/latest'

/** 便携更新仅使用当前架构与只读网络请求，不提供文件执行能力。 */
interface PortableUpdateOptions {
  currentVersion: string
  arch: string
  /** 请求发布元数据；参数为 URL 和 fetch 选项，返回 HTTP 响应。@author zhenghq */
  fetch(input: string | Request, init?: RequestInit): Promise<Response>
}

/** 独立于 NSIS/electron-updater 的便携 ZIP 更新检查驱动。 */
export class PortableUpdateDriver implements UpdateDriver {
  private listeners: UpdateDriverListeners | null = null

  /**
   * 创建便携更新检查器。
   * @param options 当前版本、架构与遵循应用代理的请求实现。
   * @returns 便携更新检查器实例。
   * @author zhenghq
   */
  constructor(private readonly options: PortableUpdateOptions) {}

  /**
   * 接入更新生命周期监听器。
   * @param listeners 状态回调。
   * @returns 无返回值。
   * @author zhenghq
   */
  initialize(listeners: UpdateDriverListeners): void {
    this.listeners = listeners
  }

  /**
   * 检查最新正式发布是否存在当前架构便携包，不解析或执行安装程序。
   * @returns 检查完成的 Promise；响应无效或缺少匹配资产时拒绝。
   * @author zhenghq
   */
  async checkForUpdates(): Promise<void> {
    const listeners = this.listeners
    if (!listeners) throw new Error(translateMain('portable.update.invalid'))
    listeners.checking()
    const local = normalizeSemanticVersion(this.options.currentVersion)
    if (!local || !['x64', 'arm64'].includes(this.options.arch)) {
      throw new Error(translateMain('portable.update.invalid'))
    }
    const response = await this.options.fetch(RELEASE_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `SelectionTranslator/${local}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
    if (!response.ok) {
      throw new Error(translateMain('portable.update.http', { status: response.status }))
    }
    let raw: unknown
    try {
      raw = await response.json()
    } catch {
      throw new Error(translateMain('portable.update.invalid'))
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(translateMain('portable.update.invalid'))
    }
    const release = raw as Record<string, unknown>
    const version = typeof release.tag_name === 'string' ? normalizeSemanticVersion(release.tag_name) : null
    if (!version || release.draft !== false || release.prerelease !== false) {
      throw new Error(translateMain('portable.update.invalid'))
    }
    const assetName = `SelectionTranslator-${version}-Portable-${this.options.arch}.zip`
    if (!Array.isArray(release.assets) || !release.assets.some((asset: unknown) => (
      asset !== null && typeof asset === 'object' && (asset as { name?: unknown }).name === assetName
    ))) {
      throw new Error(translateMain('portable.update.missingAsset', { asset: assetName }))
    }
    const comparison = compareSemanticVersions(version, local)
    if (comparison === null) throw new Error(translateMain('portable.update.invalid'))
    if (comparison > 0) listeners.available({ version })
    else listeners.notAvailable({ version })
  }

  /**
   * 拒绝驱动层下载；更新管理器应打开固定发布页。
   * @returns 始终拒绝的 Promise。
   * @author zhenghq
   */
  async downloadUpdate(): Promise<void> {
    throw new Error(translateMain('portable.update.manualOnly'))
  }

  /**
   * 便携驱动没有下载任务，取消不会产生副作用。
   * @returns 无返回值。
   * @author zhenghq
   */
  cancelDownload(): void {}

  /**
   * 拒绝安装程序执行，用户必须手动升级便携目录。
   * @returns 不返回，始终抛出异常。
   * @author zhenghq
   */
  installUpdate(): void {
    throw new Error(translateMain('portable.update.manualOnly'))
  }
}
