import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  UpdateManager,
  type ManualMacUpdateService,
  type UpdateDriver,
  type UpdateDriverListeners
} from '../src/main/updateManager.ts'
import type { UpdateProgress, UpdateStatus } from '../src/shared/types.ts'

class StubDriver implements UpdateDriver {
  listeners: UpdateDriverListeners | null = null

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
   * 测试不需要真实下载更新。
   * @returns 已完成的 Promise。
   * @author zhenghq
   */
  async downloadUpdate(): Promise<void> {}

  /**
   * 测试不需要真实安装更新。
   * @returns 无返回值。
   * @author zhenghq
   */
  installUpdate(): void {}
}

class RecordingManualUpdate implements ManualMacUpdateService {
  calls: Array<{
    url: string
    version: string
    integrity?: { sha512?: string; size?: number }
  }> = []
  verified = true

  /**
   * 记录下载请求参数并返回可控的校验结果。
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
    onProgress?.({ percent: 100, transferred: 8, total: 8, bytesPerSecond: 8 })
    return { path: `/Users/mac/Downloads/App-${version}.dmg`, verified: this.verified }
  }
}

/**
 * 创建手动安装模式下的更新管理器。
 * @returns 管理器、驱动与手动下载服务。
 * @author zhenghq
 */
function createManualManager(): {
  manager: UpdateManager
  driver: StubDriver
  manualUpdate: RecordingManualUpdate
  statuses: UpdateStatus[]
} {
  const driver = new StubDriver()
  const manualUpdate = new RecordingManualUpdate()
  const statuses: UpdateStatus[] = []
  const manager = new UpdateManager({
    driver,
    currentVersion: '1.0.3',
    enabled: true,
    installMode: 'manual',
    releaseUrl: 'https://github.com/zhq734/translation/releases/latest',
    manualUpdate,
    openExternal: async () => {},
    onStatusChanged: (status) => statuses.push(status)
  })
  return { manager, driver, manualUpdate, statuses }
}

test('更新管理器应把清单校验信息透传给手动下载服务', async () => {
  const { manager, driver, manualUpdate } = createManualManager()

  driver.listeners?.available({
    version: '1.0.4',
    manualDownloadUrl: 'https://example.com/App-1.0.4-mac-arm64.dmg',
    manualDownloadSha512: 'expected-hash',
    manualDownloadSize: 184_000_000
  })
  await manager.downloadUpdate()

  assert.equal(manualUpdate.calls.length, 1)
  assert.deepEqual(manualUpdate.calls[0].integrity, {
    sha512: 'expected-hash',
    size: 184_000_000
  })
})

test('校验通过的手动更新状态不应提示未经校验', async () => {
  const { manager, driver, manualUpdate } = createManualManager()
  manualUpdate.verified = true

  driver.listeners?.available({
    version: '1.0.4',
    manualDownloadUrl: 'https://example.com/App-1.0.4-mac-arm64.dmg',
    manualDownloadSha512: 'expected-hash'
  })
  await manager.downloadUpdate()

  assert.equal(manager.getStatus().phase, 'manual-downloaded')
  assert.doesNotMatch(manager.getStatus().message, /未经完整性校验/u)
})

test('无校验值的手动更新应在状态中明确标注未经完整性校验', async () => {
  const { manager, driver, manualUpdate } = createManualManager()
  manualUpdate.verified = false

  driver.listeners?.available({
    version: '1.0.4',
    manualDownloadUrl: 'https://example.com/App-1.0.4-mac-arm64.dmg'
  })
  await manager.downloadUpdate()

  assert.equal(manager.getStatus().phase, 'manual-downloaded')
  assert.match(manager.getStatus().message, /未经完整性校验/u)
})

test('更新驱动应从清单解析携带校验值的 DMG 下载目标', () => {
  const source = readFileSync('src/main/updater.ts', 'utf8')

  assert.match(source, /resolveManualMacDmgTarget\(info\.files, process\.arch, RELEASE_DOWNLOAD_BASE_URL\)/u)
  assert.match(source, /manualDownloadSha512/u)
  assert.match(source, /manualDownloadSize/u)
})
