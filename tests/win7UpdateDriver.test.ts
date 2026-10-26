import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  Win7UpdateDriver,
  type Win7UpdateFetch
} from '../src/main/win7UpdateDriver.ts'
import { UpdateManager } from '../src/main/updateManager.ts'
import { setMainMessageTranslator } from '../src/main/messages.ts'
import { createTranslator } from '../src/shared/i18n/index.ts'
import type {
  UpdateDriverInfo,
  UpdateDriverListeners
} from '../src/main/updateManager.ts'

setMainMessageTranslator(createTranslator('zh-CN'))

/** 记录 Win7 更新驱动回调的最小监听器。 */
interface RecordedListeners extends UpdateDriverListeners {
  /** 已发现的可用更新。 */
  availableEvents: UpdateDriverInfo[]
  /** 已确认无需更新的版本。 */
  notAvailableEvents: UpdateDriverInfo[]
  /** 检查开始次数。 */
  checkingCount: number
}

/**
 * 创建记录全部事件的更新监听器。
 * @returns 可用于断言的监听器。
 * @author zhenghq
 */
function createListeners(): RecordedListeners {
  const listeners: RecordedListeners = {
    availableEvents: [],
    notAvailableEvents: [],
    checkingCount: 0,
    checking: () => {
      listeners.checkingCount += 1
    },
    available: (info) => {
      listeners.availableEvents.push(info)
    },
    notAvailable: (info) => {
      listeners.notAvailableEvents.push(info)
    },
    progress: () => undefined,
    downloaded: () => undefined,
    error: () => undefined
  }
  return listeners
}

/**
 * 创建返回固定 GitHub Release JSON 的 fetch 替身。
 * @param body Release 响应体。
 * @param status HTTP 状态码。
 * @returns fetch 替身及捕获的请求信息。
 * @author zhenghq
 */
function createFetch(body: unknown, status = 200): {
  fetch: Win7UpdateFetch
  requests: Array<{ url: string; init?: RequestInit }>
} {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  return {
    requests,
    fetch: async (url, init) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) })
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      })
    }
  }
}

/**
 * 构造包含 Win7 安装包的 GitHub Release 响应。
 * @param version Release 标签版本。
 * @param assetNames Release 资产文件名。
 * @returns GitHub Release 响应对象。
 * @author zhenghq
 */
function createRelease(version: string, assetNames: string[]): unknown {
  return {
    tag_name: `v${version}`,
    assets: assetNames.map((name) => ({ name }))
  }
}

test('Win7 更新驱动应请求 GitHub latest Release 并带上兼容请求头', async () => {
  const { fetch, requests } = createFetch(
    createRelease('1.2.6', ['SelectionTranslator-1.2.6-Setup-win7-x64.exe'])
  )
  const driver = new Win7UpdateDriver({ currentVersion: '1.2.5', fetch })
  const listeners = createListeners()

  driver.initialize(listeners)
  await driver.checkForUpdates()

  assert.equal(listeners.checkingCount, 1)
  assert.equal(requests.length, 1)
  assert.equal(
    requests[0]?.url,
    'https://api.github.com/repos/zhq734/translation/releases/latest'
  )
  assert.equal(requests[0]?.init?.headers && new Headers(requests[0].init.headers).get('accept'), 'application/vnd.github+json')
  assert.equal(new Headers(requests[0]?.init?.headers).get('user-agent'), 'SelectionTranslator/1.2.5')
  assert.equal(new Headers(requests[0]?.init?.headers).get('x-github-api-version'), '2022-11-28')
})

test('Win7 更新驱动发现更高版本时应上报可用更新', async () => {
  const { fetch } = createFetch(
    createRelease('1.2.6', ['SelectionTranslator-1.2.6-Setup-win7-x64.exe'])
  )
  const driver = new Win7UpdateDriver({ currentVersion: '1.2.5', fetch })
  const listeners = createListeners()

  driver.initialize(listeners)
  await driver.checkForUpdates()

  assert.deepEqual(listeners.availableEvents, [{ version: '1.2.6' }])
  assert.deepEqual(listeners.notAvailableEvents, [])
})

test('Win7 检查更新后应通过应用内操作打开 GitHub Release', async () => {
  const { fetch } = createFetch(
    createRelease('1.2.6', ['SelectionTranslator-1.2.6-Setup-win7-x64.exe'])
  )
  const openedUrls: string[] = []
  const driver = new Win7UpdateDriver({ currentVersion: '1.2.5', fetch })
  const manager = new UpdateManager({
    driver,
    currentVersion: '1.2.5',
    enabled: true,
    installMode: 'manual',
    releaseUrl: 'https://github.com/zhq734/translation/releases/latest',
    openExternal: async (url) => {
      openedUrls.push(url)
    },
    onStatusChanged: () => undefined
  })

  await manager.checkForUpdates()
  assert.equal(manager.getStatus().phase, 'available')
  assert.equal(manager.getStatus().updateAction, 'open-release')

  const status = await manager.downloadUpdate()
  assert.deepEqual(openedUrls, ['https://github.com/zhq734/translation/releases/latest'])
  assert.equal(status.phase, 'available')
  assert.match(status.message, /已打开 GitHub Release/u)
})

test('Win7 更新驱动在当前已是最新版本时应上报无需更新', async () => {
  const { fetch } = createFetch(
    createRelease('1.2.5', ['SelectionTranslator-1.2.5-Setup-win7-x64.exe'])
  )
  const driver = new Win7UpdateDriver({ currentVersion: '1.2.5', fetch })
  const listeners = createListeners()

  driver.initialize(listeners)
  await driver.checkForUpdates()

  assert.deepEqual(listeners.availableEvents, [])
  assert.deepEqual(listeners.notAvailableEvents, [{ version: '1.2.5' }])
})

test('Win7 更新驱动必须只接受版本匹配的 Win7 x64 安装包', async () => {
  const { fetch } = createFetch(
    createRelease('1.2.6', [
      'SelectionTranslator-1.2.6-Setup-x64.exe',
      'SelectionTranslator-1.2.6-Setup-win7-arm64.exe'
    ])
  )
  const driver = new Win7UpdateDriver({ currentVersion: '1.2.5', fetch })
  const listeners = createListeners()

  driver.initialize(listeners)
  await assert.rejects(
    driver.checkForUpdates(),
    /Release v1\.2\.6 缺少 SelectionTranslator-1\.2\.6-Setup-win7-x64\.exe/u
  )
})

test('Win7 更新驱动在 GitHub API 失败时应抛出可读错误', async () => {
  const { fetch } = createFetch({ message: 'rate limited' }, 403)
  const driver = new Win7UpdateDriver({ currentVersion: '1.2.5', fetch })

  driver.initialize(createListeners())
  await assert.rejects(driver.checkForUpdates(), /GitHub Release 检查失败：HTTP 403/u)
})

test('Win7 更新驱动不得导入 electron-updater 或现代更新适配器', () => {
  const source = readFileSync('src/main/win7UpdateDriver.ts', 'utf8')
  assert.doesNotMatch(source, /from ['"]electron-updater['"]/u)
  assert.doesNotMatch(source, /from ['"]\.\/updater['"]/u)
})
