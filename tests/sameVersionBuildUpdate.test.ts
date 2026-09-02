import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  UpdateManager,
  type ManualMacUpdateService,
  type UpdateDriver,
  type UpdateDriverListeners
} from '../src/main/updateManager.ts'
import { createBuildMetadata } from '../src/shared/buildMetadata.ts'
import type { BuildMetadata } from '../src/shared/buildMetadata.ts'
import type { UpdateProgress, UpdateStatus } from '../src/shared/types.ts'

const DMG_URL = 'https://github.com/zhq734/translation/releases/download/V1.1.2/SelectionTranslator-1.1.2-mac-arm64.dmg'

class RecordingDriver implements UpdateDriver {
  listeners: UpdateDriverListeners | null = null
  downloadCount = 0
  installCount = 0

  /**
   * 保存事件监听器供测试触发。
   * @param listeners 自动更新事件监听器。
   * @returns 无返回值。
   * @author zhenghq
   */
  initialize(listeners: UpdateDriverListeners): void {
    this.listeners = listeners
  }

  /**
   * 测试不需要真实检查更新。
   * @returns 已完成的 Promise。
   * @author zhenghq
   */
  async checkForUpdates(): Promise<void> {}

  /**
   * 记录自动下载调用次数，用于断言同版本路径不会触发自动下载。
   * @returns 已完成的 Promise。
   * @author zhenghq
   */
  async downloadUpdate(): Promise<void> {
    this.downloadCount += 1
  }

  /**
   * 记录自动安装调用次数，用于断言同版本路径不会触发自动安装。
   * @returns 无返回值。
   * @author zhenghq
   */
  installUpdate(): void {
    this.installCount += 1
  }
}

class RecordingManualUpdate implements ManualMacUpdateService {
  calls: Array<{ url: string; version: string; integrity?: { sha512?: string; size?: number } }> = []

  /**
   * 记录手动 DMG 下载请求。
   * @param url DMG 下载地址。
   * @param version 更新版本号。
   * @param onProgress 下载进度回调。
   * @param integrity 更新清单提供的校验信息。
   * @returns 模拟下载结果。
   * @author zhenghq
   */
  async downloadAndOpen(
    url: string,
    version: string,
    onProgress?: (progress: UpdateProgress) => void,
    integrity?: { sha512?: string; size?: number }
  ): Promise<{ path: string; verified: boolean }> {
    this.calls.push({ url, version, integrity })
    onProgress?.({ percent: 100, transferred: 4, total: 4, bytesPerSecond: 4 })
    return { path: `/Users/mac/Downloads/App-${version}.dmg`, verified: true }
  }
}

/**
 * 构造用于同版本判断的构建元数据。
 * @param runId 工作流运行 ID。
 * @param version SemVer 版本号。
 * @returns 构建元数据。
 * @author zhenghq
 */
function build(runId: string, version = '1.1.2'): BuildMetadata {
  return createBuildMetadata({
    version,
    sourceCommit: 'ca2037e5f2e38cfb8ecc99f05c77e186ef519d7e',
    workflowRunId: runId,
    workflowRunAttempt: '1'
  })
}

/**
 * 创建带构建元数据能力的更新管理器。
 * @param installMode 安装模式。
 * @param withManualUpdate 是否提供 macOS 手动下载服务。
 * @returns 管理器、驱动、手动下载服务与外部页面记录。
 * @author zhenghq
 */
function createManager(
  installMode: UpdateStatus['installMode'] = 'automatic',
  withManualUpdate = true
): {
  manager: UpdateManager
  driver: RecordingDriver
  manualUpdate: RecordingManualUpdate
  openedUrls: string[]
} {
  const driver = new RecordingDriver()
  const manualUpdate = new RecordingManualUpdate()
  const openedUrls: string[] = []
  const manager = new UpdateManager({
    driver,
    currentVersion: '1.1.2',
    enabled: true,
    installMode,
    releaseUrl: 'https://github.com/zhq734/translation/releases/latest',
    manualUpdate: withManualUpdate ? manualUpdate : undefined,
    openExternal: async (url) => {
      openedUrls.push(url)
    },
    onStatusChanged: () => {}
  })
  return { manager, driver, manualUpdate, openedUrls }
}

test('同版本但构建标识不同时应进入可操作的同版本新构建状态', () => {
  const { manager, driver } = createManager('manual')

  driver.listeners?.notAvailable({
    version: '1.1.2',
    checksumStatus: 'verified',
    localBuild: build('111'),
    remoteBuild: build('222'),
    manualDownloadUrl: DMG_URL
  })

  const status = manager.getStatus()
  assert.equal(status.phase, 'available')
  assert.equal(status.updateReason, 'same-version-new-build')
  assert.equal(status.latestVersion, '1.1.2')
  assert.match(status.message, /同版本的新构建/u)
  assert.equal(status.localBuildLabel, '#111.1')
  assert.equal(status.remoteBuildLabel, '#222.1')
  assert.equal(status.buildMetadataAvailable, true)
})

test('同版本且构建标识相同时应保持最新状态且不提供更新动作', () => {
  const { manager, driver } = createManager('manual')

  driver.listeners?.notAvailable({
    version: '1.1.2',
    checksumStatus: 'verified',
    localBuild: build('111'),
    remoteBuild: build('111'),
    manualDownloadUrl: DMG_URL
  })

  const status = manager.getStatus()
  assert.equal(status.phase, 'not-available')
  assert.equal(status.updateReason, undefined)
  assert.equal(status.updateAction, undefined)
  assert.match(status.message, /已经是最新构建/u)
  assert.equal(status.buildMetadataAvailable, true)
})

test('本地构建元数据缺失时同版本不得被判定为更新', () => {
  const { manager, driver } = createManager('manual')

  driver.listeners?.notAvailable({
    version: '1.1.2',
    checksumStatus: 'verified',
    remoteBuild: build('222'),
    manualDownloadUrl: DMG_URL
  })

  const status = manager.getStatus()
  assert.equal(status.phase, 'not-available')
  assert.equal(status.updateReason, undefined)
  assert.equal(status.buildMetadataAvailable, false)
  assert.equal(status.message, '当前已经是最新版本')
})

test('更高版本更新不得被构建元数据比较改写', () => {
  const { manager, driver } = createManager('automatic')

  driver.listeners?.available({
    version: '1.1.3',
    localBuild: build('111'),
    remoteBuild: build('111', '1.1.3')
  })

  const status = manager.getStatus()
  assert.equal(status.phase, 'available')
  assert.equal(status.updateReason, 'higher-version')
  assert.equal(status.updateAction, 'automatic-download')
  assert.match(status.message, /发现新版本 1\.1\.3/u)
})

test('macOS 同版本新构建应走受校验的手动 DMG 下载而不是自动下载', async () => {
  const { manager, driver, manualUpdate, openedUrls } = createManager('manual')

  driver.listeners?.notAvailable({
    version: '1.1.2',
    checksumStatus: 'verified',
    localBuild: build('111'),
    remoteBuild: build('222'),
    manualDownloadUrl: DMG_URL,
    manualDownloadSha512: 'expected-hash',
    manualDownloadSize: 123456
  })
  assert.equal(manager.getStatus().updateAction, 'verified-manual-download')

  await manager.downloadUpdate()

  assert.equal(driver.downloadCount, 0)
  assert.equal(driver.installCount, 0)
  assert.deepEqual(openedUrls, [])
  assert.equal(manualUpdate.calls.length, 1)
  assert.equal(manualUpdate.calls[0].url, DMG_URL)
  assert.deepEqual(manualUpdate.calls[0].integrity, { sha512: 'expected-hash', size: 123456 })
  assert.equal(manager.getStatus().phase, 'manual-downloaded')
})

test('Windows 与 Linux 同版本新构建只应打开 GitHub Release', async () => {
  const { manager, driver, openedUrls } = createManager('automatic', false)

  driver.listeners?.notAvailable({
    version: '1.1.2',
    checksumStatus: 'verified',
    localBuild: build('111'),
    remoteBuild: build('222')
  })
  assert.equal(manager.getStatus().updateAction, 'open-release')

  await manager.downloadUpdate()

  assert.equal(driver.downloadCount, 0)
  assert.equal(driver.installCount, 0)
  assert.deepEqual(openedUrls, ['https://github.com/zhq734/translation/releases/latest'])
  assert.match(manager.getStatus().message, /GitHub Release/u)
})

test('macOS 缺少安全 DMG 目标时同版本新构建应回退到 Release 页面', async () => {
  const { manager, driver, manualUpdate, openedUrls } = createManager('manual')

  driver.listeners?.notAvailable({
    version: '1.1.2',
    checksumStatus: 'verified',
    localBuild: build('111'),
    remoteBuild: build('222')
  })
  assert.equal(manager.getStatus().updateAction, 'open-release')

  await manager.downloadUpdate()

  assert.equal(manualUpdate.calls.length, 0)
  assert.deepEqual(openedUrls, ['https://github.com/zhq734/translation/releases/latest'])
})

test('同版本新构建不得触发自动安装', () => {
  const { manager, driver } = createManager('automatic')

  driver.listeners?.notAvailable({
    version: '1.1.2',
    checksumStatus: 'verified',
    localBuild: build('111'),
    remoteBuild: build('222'),
    manualDownloadUrl: DMG_URL
  })
  manager.installUpdate()

  assert.equal(driver.installCount, 0)
})

test('同版本新构建应保留 SHA256SUMS 完整性风险提示', () => {
  const { manager, driver } = createManager('manual')

  driver.listeners?.notAvailable({
    version: '1.1.2',
    checksumStatus: 'mismatch',
    localBuild: build('111'),
    remoteBuild: build('222'),
    manualDownloadUrl: DMG_URL
  })

  const status = manager.getStatus()
  assert.equal(status.updateReason, 'same-version-new-build')
  assert.equal(status.checksumStatus, 'mismatch')
  assert.match(status.message, /SHA256SUMS/u)
})

test('同版本新构建下载失败应转为错误状态且保留手动入口', async () => {
  const driver = new RecordingDriver()
  const openedUrls: string[] = []
  const manager = new UpdateManager({
    driver,
    currentVersion: '1.1.2',
    enabled: true,
    installMode: 'manual',
    releaseUrl: 'https://github.com/zhq734/translation/releases/latest',
    manualUpdate: {
      /**
       * 模拟手动下载失败。
       * @returns 始终抛出异常。
       * @author zhenghq
       */
      async downloadAndOpen(): Promise<{ path: string; verified: boolean }> {
        throw new Error('下载中断')
      }
    },
    openExternal: async (url) => {
      openedUrls.push(url)
    },
    onStatusChanged: () => {}
  })

  driver.listeners?.notAvailable({
    version: '1.1.2',
    checksumStatus: 'verified',
    localBuild: build('111'),
    remoteBuild: build('222'),
    manualDownloadUrl: DMG_URL
  })
  await manager.downloadUpdate()

  const status = manager.getStatus()
  assert.equal(status.phase, 'error')
  assert.match(status.message, /下载中断/u)
  assert.equal(status.manualDownloadAvailable, true)
  assert.equal(driver.downloadCount, 0)
})

test('构建元数据不可用不得把正常检查转为错误状态', () => {
  const { manager, driver } = createManager('automatic')

  driver.listeners?.notAvailable({
    version: '1.1.2',
    checksumStatus: 'verified',
    buildMetadataUnavailableReason: 'digest-mismatch'
  })

  const status = manager.getStatus()
  assert.equal(status.phase, 'not-available')
  assert.notEqual(status.phase, 'error')
  assert.equal(status.buildMetadataAvailable, false)
})

test('共享类型与 Preload 应暴露区分更新原因的脱敏字段', () => {
  const typesSource = readFileSync('src/shared/types.ts', 'utf8')

  assert.match(typesSource, /export type UpdateReason = 'higher-version' \| 'same-version-new-build'/u)
  assert.match(
    typesSource,
    /export type UpdateAction =\s*\|? ?'automatic-download'/u
  )
  assert.match(typesSource, /updateReason\?: UpdateReason/u)
  assert.match(typesSource, /updateAction\?: UpdateAction/u)
  assert.match(typesSource, /localBuildLabel\?: string/u)
  assert.match(typesSource, /remoteBuildLabel\?: string/u)
  assert.match(typesSource, /buildMetadataAvailable\?: boolean/u)
  assert.doesNotMatch(typesSource, /sourceCommit/u)
})

test('更新驱动应读取本地资源元数据并校验远程 Release 资产', () => {
  const source = readFileSync('src/main/updater.ts', 'utf8')

  assert.match(source, /readLocalBuildMetadata/u)
  assert.match(source, /fetchRemoteBuildMetadata/u)
  assert.match(source, /process\.resourcesPath/u)
  assert.doesNotMatch(source, /latest\/download\/build-info\.json/u)
})

test('设置页应区分更高版本与同版本新构建并提供手动入口', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const source = readFileSync('src/renderer/src/settings.ts', 'utf8')
  const css = readFileSync('src/renderer/src/settings.css', 'utf8')

  assert.match(html, /id="build-identity-row"/u)
  assert.match(html, /id="build-identity"/u)
  assert.match(css, /\.update-summary > div\[hidden\]\s*\{[\s\S]*display:\s*none/u)
  assert.match(css, /grid-template-columns:\s*repeat\(auto-fit/u)

  assert.match(source, /status\.updateReason === 'same-version-new-build'/u)
  assert.match(source, /status\.updateAction === 'open-release'/u)
  assert.match(source, /打开 GitHub Release/u)
  assert.match(source, /同版本的新构建/u)
  assert.match(source, /remoteBuildLabel/u)
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}/u)
})

test('Preload 应原样转发包含更新原因的状态且不新增未受控通道', () => {
  const preload = readFileSync('src/preload/index.ts', 'utf8')

  assert.match(preload, /getUpdateStatus: \(\): Promise<UpdateStatus> => ipcRenderer\.invoke\('updater:get-status'\)/u)
  assert.match(preload, /downloadUpdate: \(\): Promise<UpdateStatus> => ipcRenderer\.invoke\('updater:download'\)/u)
  assert.match(preload, /ipcRenderer\.on\('updater:status'/u)
  assert.doesNotMatch(preload, /build-info|buildId/u)
})

test('主进程日志与状态不得输出远程响应原文或本地资源路径', () => {
  const updaterSource = readFileSync('src/main/updater.ts', 'utf8')
  const remoteSource = readFileSync('src/main/remoteBuildMetadata.ts', 'utf8')
  const localSource = readFileSync('src/main/localBuildMetadata.ts', 'utf8')

  for (const source of [updaterSource, remoteSource, localSource]) {
    assert.doesNotMatch(source, /console\.(log|info|warn|error)/u)
  }
  assert.doesNotMatch(remoteSource, /token|Authorization/iu)
})
