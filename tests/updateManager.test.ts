import assert from 'node:assert/strict'
import test from 'node:test'
import {
  UpdateManager,
  resolveMacOSAppBundlePath,
  resolveUpdateInstallMode,
  type UpdateDriver,
  type UpdateDriverListeners
} from '../src/main/updateManager.ts'
import type { UpdateStatus } from '../src/shared/types.ts'

class FakeUpdateDriver implements UpdateDriver {
  listeners: UpdateDriverListeners | null = null
  checkCount = 0
  downloadCount = 0
  installCount = 0

  /**
   * 保存自动更新事件监听器，供测试主动触发状态变化。
   * @param listeners 自动更新事件监听器。
   * @returns 无返回值。
   * @author zhenghq
   */
  initialize(listeners: UpdateDriverListeners): void {
    this.listeners = listeners
  }

  /**
   * 记录检查更新调用次数。
   * @returns 已完成的 Promise。
   * @author zhenghq
   */
  async checkForUpdates(): Promise<void> {
    this.checkCount += 1
  }

  /**
   * 记录下载更新调用次数。
   * @returns 已完成的 Promise。
   * @author zhenghq
   */
  async downloadUpdate(): Promise<void> {
    this.downloadCount += 1
  }

  /**
   * 记录安装更新调用次数。
   * @returns 无返回值。
   * @author zhenghq
   */
  installUpdate(): void {
    this.installCount += 1
  }
}

/**
 * 创建用于测试的自动更新管理器及其依赖记录器。
 * @param installMode 更新安装模式。
 * @param enabled 是否允许检查更新。
 * @returns 自动更新管理器、驱动和外部页面记录。
 * @author zhenghq
 */
function createManager(
  installMode: UpdateStatus['installMode'] = 'automatic',
  enabled = true
): {
  manager: UpdateManager
  driver: FakeUpdateDriver
  openedUrls: string[]
  statuses: UpdateStatus[]
} {
  const driver = new FakeUpdateDriver()
  const openedUrls: string[] = []
  const statuses: UpdateStatus[] = []
  const manager = new UpdateManager({
    driver,
    currentVersion: '1.0.3',
    enabled,
    installMode,
    releaseUrl: 'https://github.com/zhq734/translation/releases/latest',
    openExternal: async (url) => {
      openedUrls.push(url)
    },
    onStatusChanged: (status) => statuses.push(status)
  })
  return { manager, driver, openedUrls, statuses }
}

test('更新安装模式应根据打包状态、平台、签名和 AppImage 环境决定', () => {
  assert.equal(resolveUpdateInstallMode('win32', false, false, false), 'disabled')
  assert.equal(resolveUpdateInstallMode('win32', true, false, false), 'automatic')
  assert.equal(resolveUpdateInstallMode('darwin', true, false, true), 'automatic')
  assert.equal(resolveUpdateInstallMode('darwin', true, false, false), 'manual')
  assert.equal(resolveUpdateInstallMode('linux', true, true, false), 'automatic')
  assert.equal(resolveUpdateInstallMode('linux', true, false, false), 'manual')
})

test('macOS 应从可执行文件路径解析应用包根目录', () => {
  assert.equal(
    resolveMacOSAppBundlePath('/Applications/划词翻译.app/Contents/MacOS/划词翻译'),
    '/Applications/划词翻译.app'
  )
  assert.equal(resolveMacOSAppBundlePath('/usr/local/bin/selection-translator'), null)
})

test('开发环境应返回禁用状态且不得请求远程更新', async () => {
  const { manager, driver } = createManager('disabled', false)

  assert.deepEqual(manager.getStatus(), {
    phase: 'disabled',
    currentVersion: '1.0.3',
    installMode: 'disabled',
    releaseUrl: 'https://github.com/zhq734/translation/releases/latest',
    message: '开发环境不会检查更新'
  })

  await manager.checkForUpdates()
  assert.equal(driver.checkCount, 0)
})

test('自动更新应依次广播检查、发现、下载进度和已下载状态', async () => {
  const { manager, driver, statuses } = createManager()

  await manager.checkForUpdates()
  assert.equal(driver.checkCount, 1)
  assert.equal(manager.getStatus().phase, 'checking')

  driver.listeners?.available({ version: '1.0.4' })
  assert.equal(manager.getStatus().phase, 'available')
  assert.equal(manager.getStatus().latestVersion, '1.0.4')

  await manager.downloadUpdate()
  assert.equal(driver.downloadCount, 1)
  assert.equal(manager.getStatus().phase, 'downloading')

  driver.listeners?.progress({
    percent: 52.34,
    transferred: 52428800,
    total: 100663296,
    bytesPerSecond: 2097152
  })
  assert.equal(manager.getStatus().progress?.percent, 52.34)

  driver.listeners?.downloaded({ version: '1.0.4' })
  assert.equal(manager.getStatus().phase, 'downloaded')
  manager.installUpdate()
  assert.equal(driver.installCount, 1)
  assert.ok(statuses.length >= 5)
})

test('手动安装模式应检查版本但点击更新时打开 GitHub Release', async () => {
  const { manager, driver, openedUrls } = createManager('manual')

  driver.listeners?.available({ version: '1.0.4' })
  await manager.downloadUpdate()

  assert.equal(driver.downloadCount, 0)
  assert.deepEqual(openedUrls, ['https://github.com/zhq734/translation/releases/latest'])
  assert.match(manager.getStatus().message, /已打开 GitHub Release/u)
})

test('驱动异常应转为可展示的错误状态并保留手动下载入口', async () => {
  const { manager, driver, openedUrls } = createManager()

  driver.listeners?.error(new Error('latest.yml 不存在'))
  assert.equal(manager.getStatus().phase, 'error')
  assert.match(manager.getStatus().message, /latest\.yml 不存在/u)

  await manager.openReleasePage()
  assert.equal(openedUrls.length, 1)
})
