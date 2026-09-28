import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  UpdateManager,
  isMacOSDeveloperIdApplicationSignature,
  resolveMacOSAppBundlePath,
  resolveUpdateInstallMode,
  type ManualMacUpdateService,
  type UpdateDriver,
  type UpdateDriverListeners
} from '../src/main/updateManager.ts'
import { createTranslator } from '../src/shared/i18n/translate.ts'
import { tForTest } from './helpers/i18n.ts'
import {
  parseSha256Sums,
  validateReleaseChecksum,
  validateReleaseChecksums
} from '../src/main/releaseChecksums.ts'
import type { UpdateStatus } from '../src/shared/types.ts'

class FakeUpdateDriver implements UpdateDriver {
  listeners: UpdateDriverListeners | null = null
  checkCount = 0
  downloadCount = 0
  cancelCount = 0
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
   * 记录取消下载调用次数。
   * @returns 无返回值。
   * @author zhenghq
   */
  cancelDownload(): void {
    this.cancelCount += 1
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

class FakeManualMacUpdateService implements ManualMacUpdateService {
  calls: Array<{ url: string; version: string }> = []
  progressCallbacks = 0
  /** 取消测试时用于挂起下载直到外部释放。 */
  blockSignal?: Promise<void>
  /** 最近一次下载收到的取消信号。 */
  lastSignal?: AbortSignal

  /**
   * 记录手动 macOS 更新包下载和打开请求，并模拟下载进度。
   * @param url DMG 下载地址。
   * @param version 更新版本号。
   * @param onProgress 下载进度回调。
   * @param integrity 更新清单提供的校验值与文件长度。
   * @param signal 外部传入的取消信号。
   * @returns 模拟下载文件路径的 Promise。
   * @author zhenghq
   */
  async downloadAndOpen(
    url: string,
    version: string,
    onProgress?: (progress: UpdateStatus['progress']) => void,
    integrity?: { sha512?: string; size?: number },
    signal?: AbortSignal
  ): Promise<{ path: string }> {
    this.calls.push({ url, version })
    this.lastSignal = signal
    if (this.blockSignal) {
      await this.blockSignal
    }
    if (onProgress) {
      this.progressCallbacks += 1
      onProgress({ percent: 100, transferred: 10, total: 10, bytesPerSecond: 10 })
    }
    return { path: `/Users/mac/Downloads/SelectionTranslator-${version}.dmg` }
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
  enabled = true,
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
  getTranslator?: () => ReturnType<typeof createTranslator>
): {
  manager: UpdateManager
  driver: FakeUpdateDriver
  manualUpdate: FakeManualMacUpdateService
  openedUrls: string[]
  statuses: UpdateStatus[]
} {
  const driver = new FakeUpdateDriver()
  const manualUpdate = new FakeManualMacUpdateService()
  const openedUrls: string[] = []
  const statuses: UpdateStatus[] = []
  const manager = new UpdateManager({
    driver,
    currentVersion: '1.0.3',
    enabled,
    installMode,
    releaseUrl: 'https://github.com/zhq734/translation/releases/latest',
    manualUpdate,
    ...(getTranslator ? { getTranslator } : { translator: createTranslator(locale) }),
    openExternal: async (url) => {
      openedUrls.push(url)
    },
    onStatusChanged: (status) => statuses.push(status)
  })
  return { manager, driver, manualUpdate, openedUrls, statuses }
}

test('更新安装模式应根据打包状态、平台、签名和 AppImage 环境决定', () => {
  assert.equal(resolveUpdateInstallMode('win32', false, false, false), 'disabled')
  assert.equal(resolveUpdateInstallMode('win32', true, false, false), 'automatic')
  assert.equal(resolveUpdateInstallMode('darwin', true, false, true), 'automatic')
  assert.equal(resolveUpdateInstallMode('darwin', true, false, true, true), 'manual')
  assert.equal(resolveUpdateInstallMode('darwin', true, false, false), 'manual')
  assert.equal(resolveUpdateInstallMode('linux', true, true, false), 'automatic')
  assert.equal(resolveUpdateInstallMode('linux', true, false, false), 'manual')
})

test('更新状态应使用注入的英文翻译器并正确插值', async () => {
  const { manager, driver } = createManager('automatic', true, 'en-US')

  assert.equal(manager.getStatus().message, tForTest('en-US', 'update.idle'))
  await manager.checkForUpdates()
  assert.equal(manager.getStatus().message, tForTest('en-US', 'update.checking'))

  driver.listeners?.available({ version: '1.0.4' })
  assert.equal(
    manager.getStatus().message,
    tForTest('en-US', 'update.available', { version: '1.0.4' })
  )

  await manager.downloadUpdate()
  driver.listeners?.progress({
    percent: 52.34,
    transferred: 52,
    total: 100,
    bytesPerSecond: 10
  })
  assert.equal(
    manager.getStatus().message,
    tForTest('en-US', 'update.downloading', { percent: '52.3' })
  )

  await manager.cancelDownload()
  assert.equal(manager.getStatus().message, tForTest('en-US', 'update.cancelled'))
})

test('英文更新错误状态应使用英文词条且保留诊断参数', async () => {
  const { manager, driver } = createManager('automatic', true, 'en-US')

  driver.checkForUpdates = async () => {
    throw new Error('net::ERR_CONNECTION_CLOSED')
  }
  await manager.checkForUpdates()

  assert.equal(
    manager.getStatus().message,
    tForTest('en-US', 'update.error.networkInterrupted')
  )
})

test('更新管理器应在语言切换后使用新的翻译器', async () => {
  let locale: 'zh-CN' | 'en-US' = 'zh-CN'
  const { manager, driver } = createManager(
    'automatic',
    true,
    'zh-CN',
    () => createTranslator(locale)
  )

  assert.equal(manager.getStatus().message, tForTest('zh-CN', 'update.idle'))
  locale = 'en-US'
  manager.setTranslator(createTranslator(locale))
  driver.listeners?.checking()
  assert.equal(manager.getStatus().message, tForTest('en-US', 'update.checking'))

  locale = 'zh-CN'
  manager.setTranslator(createTranslator(locale))
  driver.listeners?.available({ version: '1.0.4' })
  assert.equal(
    manager.getStatus().message,
    tForTest('zh-CN', 'update.available', { version: '1.0.4' })
  )
})

test('macOS 应从可执行文件路径解析应用包根目录', () => {
  assert.equal(
    resolveMacOSAppBundlePath('/Applications/划词翻译.app/Contents/MacOS/划词翻译'),
    '/Applications/划词翻译.app'
  )
  assert.equal(resolveMacOSAppBundlePath('/usr/local/bin/selection-translator'), null)
})

/**
 * 校验 macOS 自动更新只信任面向外部分发的 Developer ID Application 签名。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 自动更新只应接受 Developer ID Application 正式签名', () => {
  assert.equal(
    isMacOSDeveloperIdApplicationSignature(
      'Authority=Developer ID Application: Example Developer (499QMYBXLR)\n' +
      'TeamIdentifier=499QMYBXLR'
    ),
    true
  )
  assert.equal(
    isMacOSDeveloperIdApplicationSignature(
      'Authority=Apple Development: developer@example.com (ABCDE12345)\n' +
      'TeamIdentifier=499QMYBXLR'
    ),
    false
  )
  assert.equal(
    isMacOSDeveloperIdApplicationSignature(
      'Authority=Developer ID Application: Other Developer (ABCDE12345)\n' +
      'TeamIdentifier=ABCDE12345'
    ),
    false
  )
  assert.equal(
    isMacOSDeveloperIdApplicationSignature(
      'Authority=Developer ID Application: Missing Team Identifier (499QMYBXLR)'
    ),
    false
  )
  assert.equal(
    isMacOSDeveloperIdApplicationSignature('Signature=adhoc\nTeamIdentifier=not set'),
    false
  )
})

test('开发环境应返回禁用状态且不得请求远程更新', async () => {
  const { manager, driver } = createManager('disabled', false)

  assert.deepEqual(manager.getStatus(), {
    phase: 'disabled',
    currentVersion: '1.0.3',
    installMode: 'disabled',
    releaseUrl: 'https://github.com/zhq734/translation/releases/latest',
    message: tForTest('zh-CN', 'update.disabled')
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

test('Windows 与 Linux 自动更新初始化时应禁用差分下载，Windows 还应禁用 Web 安装器', () => {
  const source = readFileSync('src/main/updater.ts', 'utf8')

  assert.match(
    source,
    /if \(process\.platform === 'win32' \|\| process\.platform === 'linux'\) \{\s*autoUpdater\.disableDifferentialDownload = true\s*\}/u
  )
  assert.match(
    source,
    /if \(process\.platform === 'win32'\) \{\s*autoUpdater\.disableWebInstaller = true\s*\}/u
  )
  assert.doesNotMatch(source, /disableDifferentialDownload = false/u)
  assert.doesNotMatch(source, /disableWebInstaller = false/u)
})

test('Windows 与 Linux 自动更新初始化时应启用分片并发下载，macOS 不应改变', () => {
  const source = readFileSync('src/main/updater.ts', 'utf8')

  assert.match(
    source,
    /if \(process\.platform === 'win32' \|\| process\.platform === 'linux'\) \{\s*installParallelUpdateDownload\(autoUpdater, updateDownloadFetch\)\s*\}/u
  )
  assert.doesNotMatch(
    source,
    /if \(process\.platform === 'darwin'\) \{\s*installParallelUpdateDownload/u
  )
})

test('下载中的自动更新应支持取消并回到可重新下载状态', async () => {
  const { manager, driver } = createManager()

  driver.listeners?.available({ version: '1.0.4' })
  await manager.downloadUpdate()
  assert.equal(manager.getStatus().phase, 'downloading')

  await manager.cancelDownload()
  assert.equal(driver.cancelCount, 1)
  assert.equal(manager.getStatus().phase, 'available')
  assert.equal(manager.getStatus().progress, undefined)

  // 取消后的迟到进度与下载完成事件不得覆盖已取消状态。
  driver.listeners?.progress({
    percent: 60,
    transferred: 60,
    total: 100,
    bytesPerSecond: 10
  })
  driver.listeners?.downloaded({ version: '1.0.4' })
  assert.equal(manager.getStatus().phase, 'available')

  // 取消后用户可以立即重新点击升级重新下载。
  await manager.downloadUpdate()
  assert.equal(driver.downloadCount, 2)
  assert.equal(manager.getStatus().phase, 'downloading')
})

test('取消下载后底层补发的取消错误不得把状态覆盖成失败', async () => {
  const { manager, driver } = createManager()

  driver.listeners?.available({ version: '1.0.4' })
  await manager.downloadUpdate()
  await manager.cancelDownload()
  assert.equal(manager.getStatus().phase, 'available')

  // 真实 electron-updater 在分片适配层抛出普通 Error 时会补发 error 事件。
  driver.listeners?.error(new Error('分片下载失败（字节 0-8132141）：下载已取消'))
  assert.equal(manager.getStatus().phase, 'available')
  assert.ok(manager.getStatus().message.includes(tForTest('zh-CN', 'update.cancelled')))
})

test('手动 DMG 下载应支持取消并保留断点续传状态', async () => {
  const { manager, driver, manualUpdate } = createManager('manual')
  // 模拟真实下载：挂起直到取消信号触发，随后以“下载已取消”结束。
  manualUpdate.blockSignal = new Promise<void>((_resolve, reject) => {
    const timer = setInterval(() => {
      if (manualUpdate.lastSignal?.aborted) {
        clearInterval(timer)
        reject(new Error('下载已取消'))
      }
    }, 5)
  })

  driver.listeners?.available({
    version: '1.0.4',
    manualDownloadUrl: 'https://example.com/App-1.0.4-mac-arm64.dmg',
    manualDownloadSize: 1024
  })
  const downloading = manager.downloadUpdate()
  assert.equal(manager.getStatus().phase, 'downloading')

  await manager.cancelDownload()
  assert.equal(manualUpdate.lastSignal?.aborted, true)
  await downloading
  assert.equal(manager.getStatus().phase, 'available')
  assert.equal(manager.getStatus().progress, undefined)
  assert.ok(manager.getStatus().message.includes(tForTest('zh-CN', 'update.cancelled')))
})

test('SHA256SUMS 缺少当前安装包时应提示升级', () => {
  const { manager, driver, manualUpdate } = createManager('manual')

  driver.listeners?.notAvailable({
    version: '1.0.3',
    checksumStatus: 'missing',
    manualDownloadUrl: 'https://example.test/SelectionTranslator-1.0.3-mac-arm64.dmg'
  })

  assert.equal(manager.getStatus().phase, 'available')
  assert.ok(manager.getStatus().message.includes(tForTest('zh-CN', 'update.checksumNeedsUpdateMissing')))
  assert.equal(manager.getStatus().checksumStatus, 'missing')
  assert.equal(manager.getStatus().manualDownloadAvailable, true)
})

test('SHA256SUMS 应解析并比较 GitHub Release 资产摘要', async () => {
  const content = 'a'.repeat(64) + '  SelectionTranslator-1.0.4-mac-arm64.dmg\n'
  assert.equal(
    parseSha256Sums(content).get('SelectionTranslator-1.0.4-mac-arm64.dmg'),
    'a'.repeat(64)
  )

  const result = await validateReleaseChecksum({
    manifestUrl: 'https://example.test/SHA256SUMS',
    assetName: 'SelectionTranslator-1.0.4-mac-arm64.dmg',
    assetDigest: `sha256:${'a'.repeat(64)}`,
    fetch: async () => new Response(content, { status: 200 })
  })
  assert.equal(result.status, 'verified')
})

test('SHA256SUMS 与 GitHub Release 资产摘要不一致时应标记 mismatch', async () => {
  const expected = 'a'.repeat(64)
  const actual = 'b'.repeat(64)
  const result = await validateReleaseChecksums({
    manifestUrl: 'https://example.test/SHA256SUMS',
    assetNames: ['SelectionTranslator-1.0.4-mac-arm64.dmg'],
    assets: [{ name: 'SelectionTranslator-1.0.4-mac-arm64.dmg', digest: `sha256:${actual}` }],
    fetch: async () => new Response(`${expected}  SelectionTranslator-1.0.4-mac-arm64.dmg\n`)
  })

  assert.equal(result.status, 'mismatch')
})

test('SHA256SUMS 缺失或资产没有摘要时应标记 missing', async () => {
  const result = await validateReleaseChecksums({
    manifestUrl: 'https://example.test/SHA256SUMS',
    assetNames: ['SelectionTranslator-1.0.4-mac-arm64.dmg'],
    assets: [{ name: 'SelectionTranslator-1.0.4-mac-arm64.dmg' }],
    fetch: async () => new Response('')
  })
  assert.equal(result.status, 'missing')

  const missingDigest = await validateReleaseChecksums({
    manifestUrl: 'https://example.test/SHA256SUMS',
    assetNames: ['SelectionTranslator-1.0.4-mac-arm64.dmg'],
    fetch: async () => new Response(`${'a'.repeat(64)}  SelectionTranslator-1.0.4-mac-arm64.dmg\n`)
  })
  assert.equal(missingDigest.status, 'missing')
})

test('SHA256SUMS 校验通过且版本相同时应保持最新状态', () => {
  const { manager, driver } = createManager()

  driver.listeners?.notAvailable({ version: '1.0.3', checksumStatus: 'verified' })

  assert.equal(manager.getStatus().phase, 'not-available')
  assert.equal(manager.getStatus().message, tForTest('zh-CN', 'update.notAvailable'))
})

test('手动安装模式应下载 DMG 到本地并打开安装界面', async () => {
  const { manager, driver, manualUpdate, openedUrls } = createManager('manual')

  driver.listeners?.available({
    version: '1.0.4',
    manualDownloadUrl: 'https://github.com/zhq734/translation/releases/download/v1.0.4/SelectionTranslator-1.0.4-mac-arm64.dmg'
  })
  await manager.downloadUpdate()

  assert.equal(driver.downloadCount, 0)
  assert.deepEqual(openedUrls, [])
  assert.deepEqual(manualUpdate.calls, [{
    url: 'https://github.com/zhq734/translation/releases/download/v1.0.4/SelectionTranslator-1.0.4-mac-arm64.dmg',
    version: '1.0.4'
  }])
  assert.equal(manualUpdate.progressCallbacks, 1)
  assert.equal(manager.getStatus().phase, 'manual-downloaded')
  assert.equal(manager.getStatus().manualDownloadAvailable, true)
  const manualDownloadedMessage = tForTest('zh-CN', 'update.manualDownloaded')
  assert.ok(manager.getStatus().message.includes(manualDownloadedMessage))
})

test('驱动异常应转为可展示的错误状态并保留手动下载入口', async () => {
  const { manager, driver, openedUrls } = createManager()

  driver.listeners?.error(new Error('latest.yml 不存在'))
  assert.equal(manager.getStatus().phase, 'error')
  assert.match(manager.getStatus().message, /latest\.yml 不存在/u)

  await manager.openReleasePage()
  assert.equal(openedUrls.length, 1)
})

test('离线时不应发起更新检查，也不应产生错误状态', async () => {
  const driver = new FakeUpdateDriver()
  const statuses: UpdateStatus[] = []
  const manager = new UpdateManager({
    driver,
    currentVersion: '1.0.3',
    enabled: true,
    installMode: 'automatic',
    releaseUrl: 'https://github.com/zhq734/translation/releases/latest',
    isOnline: () => false,
    openExternal: async () => undefined,
    onStatusChanged: (status) => statuses.push(status)
  })

  await manager.checkForUpdates()

  assert.equal(driver.checkCount, 0, '离线时不应发起更新检查网络请求')
  assert.notEqual(manager.getStatus().phase, 'error')
  assert.equal(
    statuses.some((status) => status.phase === 'error'),
    false,
    '离线跳过更新检查不应产生错误状态'
  )
})

test('在线时应照常发起更新检查', async () => {
  const driver = new FakeUpdateDriver()
  const manager = new UpdateManager({
    driver,
    currentVersion: '1.0.3',
    enabled: true,
    installMode: 'automatic',
    releaseUrl: 'https://github.com/zhq734/translation/releases/latest',
    isOnline: () => true,
    openExternal: async () => undefined,
    onStatusChanged: () => undefined
  })

  await manager.checkForUpdates()

  assert.equal(driver.checkCount, 1)
})

test('electron-updater 应使用受控日志器，避免离线时刷出完整错误堆栈', () => {
  const source = readFileSync('src/main/updater.ts', 'utf8')

  assert.match(source, /autoUpdater\.logger\s*=/u)
  assert.doesNotMatch(source, /autoUpdater\.logger\s*=\s*console/u)
})

test('检查更新遇到连接中断时应自动重试并给出可操作提示', async () => {
  const { manager, driver, statuses } = createManager()
  let attempts = 0
  driver.checkForUpdates = async () => {
    attempts += 1
    if (attempts < 3) {
      // 模拟 electron-updater：失败时既广播 error 事件，又让 Promise 拒绝。
      driver.listeners?.error(new Error('net::ERR_CONNECTION_CLOSED'))
      throw new Error('net::ERR_CONNECTION_CLOSED')
    }
  }

  await manager.checkForUpdates()

  assert.equal(attempts, 3)
  assert.equal(manager.getStatus().phase, 'checking')
  assert.equal(manager.getStatus().message, tForTest('zh-CN', 'update.checking'))
  assert.equal(
    statuses.some((status) => status.phase === 'error'),
    false,
    '重试期间不应把临时网络抖动展示为最终失败'
  )
})

test('检查更新重试耗尽后应提示网络连接中断', async () => {
  const { manager, driver } = createManager()
  driver.checkForUpdates = async () => {
    throw new Error('net::ERR_CONNECTION_CLOSED')
  }

  await manager.checkForUpdates()

  assert.equal(manager.getStatus().phase, 'error')
  assert.equal(
    manager.getStatus().message,
    tForTest('zh-CN', 'update.error.networkInterrupted')
  )
})

test('下载中断后应自动从断点继续而不是要求用户重新点击升级', async () => {
  const { manager, driver, statuses } = createManager()
  let attempts = 0

  driver.listeners?.available({ version: '1.0.4' })
  driver.downloadUpdate = async () => {
    attempts += 1
    if (attempts < 3) {
      // 模拟 electron-updater：先广播 error 事件，再让 Promise 拒绝。
      driver.listeners?.error(new Error('分片下载失败（字节 0-8132141）：This operation was aborted'))
      throw new Error('分片下载失败（字节 0-8132141）：This operation was aborted')
    }
  }

  await manager.downloadUpdate()

  assert.equal(attempts, 3, '下载连接中断后应自动重试并从断点继续')
  assert.equal(manager.getStatus().phase, 'downloading')
  assert.equal(
    statuses.some((status) => status.phase === 'error'),
    false,
    '自动续传重试期间不应把中断展示为最终失败'
  )
})

test('下载中断重试耗尽后应提示已保留断点并可重新继续', async () => {
  const { manager, driver } = createManager()

  driver.listeners?.available({ version: '1.0.4' })
  driver.downloadUpdate = async () => {
    throw new Error('分片下载失败（字节 65057136-73189277）：网络连接被中断')
  }

  await manager.downloadUpdate()

  assert.equal(manager.getStatus().phase, 'error')
  assert.equal(
    manager.getStatus().message,
    tForTest('zh-CN', 'update.error.downloadInterrupted')
  )
})

test('下载校验失败属于确定性错误，不应自动重试续传', async () => {
  const { manager, driver } = createManager()
  let attempts = 0

  driver.listeners?.available({ version: '1.0.4' })
  driver.downloadUpdate = async () => {
    attempts += 1
    throw new Error('sha512 checksum mismatch')
  }

  await manager.downloadUpdate()

  assert.equal(attempts, 1, '校验失败重试没有意义，必须立即失败')
  assert.equal(manager.getStatus().phase, 'error')
})

test('Release 缺少更新清单时应显示简短中文提示而不是底层调用栈', () => {
  const { manager, driver } = createManager()

  driver.listeners?.error(new Error(
    'Cannot find latest-mac.yml in the latest release artifacts: HttpError: 404\n' +
    'at createHttpError (/app/node_modules/builder-util-runtime/out/httpExecutor.js:53:12)'
  ))

  assert.equal(
    manager.getStatus().message,
    tForTest('zh-CN', 'update.error.missingManifest', { manifest: 'latest-mac.yml' })
  )
  assert.doesNotMatch(manager.getStatus().message, /createHttpError|node_modules/u)
})

/**
 * 校验 ShipIt 拒绝更新包签名时会停止自动安装并提供手动恢复入口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 更新包签名不匹配时应切换为手动安装模式', async () => {
  const { manager, driver, manualUpdate, openedUrls } = createManager()

  driver.listeners?.available({
    version: '1.0.4',
    manualDownloadUrl: 'https://github.com/zhq734/translation/releases/download/v1.0.4/SelectionTranslator-1.0.4-mac-arm64.dmg'
  })

  driver.listeners?.error(new Error(
    'Code signature at URL file:///tmp/划词翻译.app/ did not pass validation: ' +
    '代码未能满足指定的代码要求'
  ))

  assert.equal(manager.getStatus().phase, 'error')
  assert.equal(manager.getStatus().installMode, 'manual')
  assert.equal(
    manager.getStatus().message,
    tForTest('zh-CN', 'update.error.signatureMismatch')
  )

  await manager.downloadUpdate()
  assert.equal(driver.downloadCount, 0)
  assert.deepEqual(openedUrls, [])
  assert.equal(manualUpdate.calls.length, 1)
})
