import assert from 'node:assert/strict'
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

class FakeManualMacUpdateService implements ManualMacUpdateService {
  calls: Array<{ url: string; version: string }> = []
  progressCallbacks = 0

  /**
   * 记录手动 macOS 更新包下载和打开请求，并模拟下载进度。
   * @param url DMG 下载地址。
   * @param version 更新版本号。
   * @param onProgress 下载进度回调。
   * @returns 模拟下载文件路径的 Promise。
   * @author zhenghq
   */
  async downloadAndOpen(
    url: string,
    version: string,
    onProgress?: (progress: UpdateStatus['progress']) => void
  ): Promise<{ path: string }> {
    this.calls.push({ url, version })
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
  enabled = true
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

test('SHA256SUMS 缺少当前安装包时应提示升级', () => {
  const { manager, driver, manualUpdate } = createManager('manual')

  driver.listeners?.notAvailable({
    version: '1.0.3',
    checksumStatus: 'missing',
    manualDownloadUrl: 'https://example.test/SelectionTranslator-1.0.3-mac-arm64.dmg'
  })

  assert.equal(manager.getStatus().phase, 'available')
  assert.match(manager.getStatus().message, /没有 SHA256SUMS 校验值/u)
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
  assert.equal(manager.getStatus().message, '当前已经是最新版本')
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
  assert.match(manager.getStatus().message, /已下载到“下载”文件夹/u)
  assert.match(manager.getStatus().message, /拖入“应用程序”覆盖旧版本/u)
})

test('驱动异常应转为可展示的错误状态并保留手动下载入口', async () => {
  const { manager, driver, openedUrls } = createManager()

  driver.listeners?.error(new Error('latest.yml 不存在'))
  assert.equal(manager.getStatus().phase, 'error')
  assert.match(manager.getStatus().message, /latest\.yml 不存在/u)

  await manager.openReleasePage()
  assert.equal(openedUrls.length, 1)
})

test('Release 缺少更新清单时应显示简短中文提示而不是底层调用栈', () => {
  const { manager, driver } = createManager()

  driver.listeners?.error(new Error(
    'Cannot find latest-mac.yml in the latest release artifacts: HttpError: 404\n' +
    'at createHttpError (/app/node_modules/builder-util-runtime/out/httpExecutor.js:53:12)'
  ))

  assert.equal(
    manager.getStatus().message,
    '当前 GitHub Release 缺少自动更新清单 latest-mac.yml，请稍后重新检查或打开发布页手动安装'
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
    '更新包签名与当前应用不兼容，已改用手动安装；请下载 DMG，拖入“应用程序”并覆盖旧版本'
  )

  await manager.downloadUpdate()
  assert.equal(driver.downloadCount, 0)
  assert.deepEqual(openedUrls, [])
  assert.equal(manualUpdate.calls.length, 1)
})
