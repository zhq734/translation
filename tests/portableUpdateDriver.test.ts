import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { afterEach } from 'node:test'
import { runInNewContext } from 'node:vm'
import { PortableUpdateDriver, PORTABLE_RELEASE_URL } from '../src/main/portableUpdateDriver.ts'
import { UpdateManager } from '../src/main/updateManager.ts'
import { getMainMessageTranslator, resetMainMessageTranslator, setMainMessageTranslator } from '../src/main/messages.ts'
import { createTranslator } from '../src/shared/i18n/index.ts'
import type { UpdateStatus } from '../src/shared/types.ts'

const require = createRequire(`${process.cwd()}/package.json`)
const ts: typeof import('typescript') = require('typescript')
type PortableFetch = ConstructorParameters<typeof PortableUpdateDriver>[0]['fetch']

afterEach(() => resetMainMessageTranslator())

/** 创建可记录手动更新行为的管理器；参数为远程响应、架构、本地版本和请求实现，返回管理器和操作记录。@author zhenghq */
function fixture(body: unknown, arch = 'x64', currentVersion = '1.0.0', fetchOverride?: PortableFetch) {
  const opened: string[] = []
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const driver = new PortableUpdateDriver({
    arch,
    currentVersion,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init })
      return fetchOverride ? fetchOverride(url, init) : new Response(JSON.stringify(body))
    }
  })
  const manager = new UpdateManager({
    driver, currentVersion, enabled: true, installMode: 'manual',
    releaseUrl: PORTABLE_RELEASE_URL, onStatusChanged: () => undefined,
    openExternal: async (url) => { opened.push(url) }
  })
  return { driver, manager, opened, requests }
}

/** 创建发布响应；参数为版本及架构，返回对应 ZIP 资产元数据。@author zhenghq */
function release(version = '1.1.0', arch = 'x64') {
  return { tag_name: `v${version}`, draft: false, prerelease: false, assets: [{ name: `SelectionTranslator-${version}-Portable-${arch}.zip` }] }
}

/** 在受控 Electron 环境运行真实工厂；参数为打包状态与联网状态，返回实际管理器和副作用记录。@author zhenghq */
async function factoryFixture(packaged = true, online = true) {
  const requests: string[] = []
  const opened: string[] = []
  const statuses: UpdateStatus[] = []
  const fetch: PortableFetch = async (url) => {
    requests.push(String(url))
    return new Response(JSON.stringify(release('1.1.0', 'arm64')))
  }
  const exports: { createPortableUpdateManager?: (callback: (status: UpdateStatus) => void) => Promise<UpdateManager> } = {}
  const code = ts.transpileModule(readFileSync('src/main/portableUpdater.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  runInNewContext(code, {
    exports,
    process: { arch: 'arm64' },
    require: (id: string) => {
      if (id === 'electron') return {
        app: { getVersion: () => '1.0.0', isPackaged: packaged },
        net: { isOnline: () => online },
        shell: { openExternal: async (url: string) => { opened.push(url) } }
      }
      if (id === './network') return { translationFetch: fetch }
      if (id === './updateManager') return { UpdateManager }
      if (id === './portableUpdateDriver') return { PortableUpdateDriver, PORTABLE_RELEASE_URL }
      if (id === './messages') return { getMainMessageTranslator }
      throw new Error(`禁止便携工厂加载非契约模块：${id}`)
    }
  })
  assert.ok(exports.createPortableUpdateManager)
  const manager = await exports.createPortableUpdateManager((status) => statuses.push(status))
  return { manager, requests, opened, statuses }
}

for (const arch of ['x64', 'arm64']) {
  test(`便携 ${arch} 新版本只提供手动 release 更新，下载安装接口不产生副作用`, async () => {
    const body = release('1.1.0', arch)
    body.assets.unshift(
      { name: 'SelectionTranslator-1.1.0-Setup-x64.exe' },
      { name: 'SelectionTranslator-1.1.0-Setup-win7-x64.exe' },
      { name: `SelectionTranslator-1.1.0-Portable-${arch === 'x64' ? 'arm64' : 'x64'}.zip` }
    )
    const f = fixture({ ...body, html_url: 'https://untrusted.example/release' }, arch)
    await f.manager.checkForUpdates()
    assert.equal(f.manager.getStatus().phase, 'available')
    assert.equal(f.manager.getStatus().updateAction, 'open-release')
    assert.equal(f.manager.getStatus().installMode, 'manual')
    assert.equal(f.manager.getStatus().latestVersion, '1.1.0')
    f.manager.installUpdate()
    await f.manager.downloadUpdate()
    assert.deepEqual(f.opened, [PORTABLE_RELEASE_URL])
    assert.equal(f.requests.length, 1)
    assert.equal(f.requests[0].url, 'https://api.github.com/repos/zhq734/translation/releases/latest')
    const headers = new Headers(f.requests[0].init?.headers)
    assert.equal(headers.get('accept'), 'application/vnd.github+json')
    assert.equal(headers.get('user-agent'), 'SelectionTranslator/1.0.0')
    assert.equal(headers.get('x-github-api-version'), '2022-11-28')
    const message = getMainMessageTranslator().t('portable.update.manualOnly')
    await assert.rejects(f.driver.downloadUpdate(), { message })
    assert.throws(() => f.driver.installUpdate(), { message })
    f.driver.cancelDownload()
    assert.equal(f.requests.length, 1)
  })
}

for (const version of ['1.0.0', '0.9.0']) {
  test(`便携同版或旧版 ${version} 不误报升级`, async () => {
    const f = fixture(release(version))
    await f.manager.checkForUpdates()
    assert.equal(f.manager.getStatus().phase, 'not-available')
    assert.equal(f.manager.getStatus().updateAction, undefined)
    assert.deepEqual(f.opened, [])
  })
}

for (const [name, body, arch] of [
  ['只有安装包', { ...release(), assets: [{ name: 'SelectionTranslator-1.1.0-Setup-x64.exe' }] }, 'x64'],
  ['错误架构', release('1.1.0', 'arm64'), 'x64'],
  ['反向错误架构', release(), 'arm64'],
  ['Win7资产', { ...release(), assets: [{ name: 'SelectionTranslator-1.1.0-Setup-win7-x64.exe' }] }, 'x64'],
  ['Win7伪便携资产', { ...release(), assets: [{ name: 'SelectionTranslator-1.1.0-Portable-win7-x64.zip' }] }, 'x64'],
  ['旧版本资产', { ...release(), assets: release('1.0.0').assets }, 'x64'],
  ['空资产', { ...release(), assets: [] }, 'x64'],
  ['缺失资产', { ...release(), assets: undefined }, 'x64'],
  ['非数组资产', { ...release(), assets: {} }, 'x64'],
  ['预发布', { ...release(), prerelease: true }, 'x64'],
  ['草稿', { ...release(), draft: true }, 'x64'],
  ['畸形草稿标记', { ...release(), draft: 'true' }, 'x64'],
  ['缺失正式发布标记', { tag_name: 'v1.1.0', assets: release().assets }, 'x64'],
  ['预发布版本标签', release('1.1.0-beta.1'), 'x64'],
  ['错误版本', { ...release(), tag_name: 'invalid' }, 'x64'],
  ['畸形资产', { ...release(), assets: [null, 'zip', { name: 1 }] }, 'x64'],
  ['空响应', null, 'x64'],
  ['数组响应', [], 'x64'],
  ['文本响应', 'error', 'x64'],
  ['未知架构', release(), 'ia32']
] as const) {
  test(`便携拒绝${name}且不打开不可信链接`, async () => {
    const f = fixture(body, arch)
    await assert.rejects(f.driver.checkForUpdates())
    const managed = fixture(body, arch)
    await managed.manager.checkForUpdates()
    assert.equal(managed.manager.getStatus().phase, 'error')
    assert.equal(managed.manager.getStatus().updateAction, undefined)
    assert.deepEqual(managed.opened, [])
    assert.deepEqual(f.opened, [])
  })
}

for (const [name, fetch, expected] of [
  ['HTTP 403', async () => new Response('{}', { status: 403 }), /HTTP 403/u],
  ['无效 JSON', async () => new Response('{bad-json'), /Invalid portable/u],
  ['请求失败', async () => { throw new Error('offline') }, /offline/u]
] as const) {
  test(`便携检查明确报告${name}且不启动下载`, async () => {
    const f = fixture(null, 'x64', '1.0.0', fetch)
    await assert.rejects(f.driver.checkForUpdates(), expected)
    assert.deepEqual(f.opened, [])
  })
}

test('便携检查拒绝无效本地版本与未初始化调用且不发请求', async () => {
  const f = fixture(release(), 'x64', 'invalid')
  await assert.rejects(f.driver.checkForUpdates(), /Invalid portable/u)
  assert.equal(f.requests.length, 0)
  const driver = new PortableUpdateDriver({ currentVersion: '1.0.0', arch: 'x64', fetch: async () => assert.fail('不能请求') })
  await assert.rejects(driver.checkForUpdates(), /Invalid portable/u)
})

test('便携工厂使用当前架构、代理 fetch 和固定发布页，语言随主进程切换', async () => {
  const f = await factoryFixture()
  assert.equal(f.manager.getStatus().message, createTranslator('en-US').t('update.idle'))
  await f.manager.checkForUpdates()
  assert.equal(f.manager.getStatus().phase, 'available')
  assert.equal(f.manager.getStatus().updateAction, 'open-release')
  assert.equal(f.statuses.at(-1)?.phase, 'available')
  await f.manager.downloadUpdate()
  assert.deepEqual(f.opened, [PORTABLE_RELEASE_URL])
  assert.equal(f.requests.length, 1)
  setMainMessageTranslator(createTranslator('zh-CN'))
  await f.manager.checkForUpdates()
  assert.equal(f.manager.getStatus().message, createTranslator('zh-CN').t('update.availableManual', { version: '1.1.0' }))
})

for (const [packaged, online] of [[false, true], [true, false]]) {
  test(`便携工厂在打包=${packaged} 联网=${online}时不进行检查`, async () => {
    const f = await factoryFixture(packaged, online)
    await f.manager.checkForUpdates()
    assert.deepEqual(f.requests, [])
    assert.deepEqual(f.opened, [])
  })
}

test('便携驱动和工厂不引入自动安装、文件下载或命令执行依赖', () => {
  for (const file of ['src/main/portableUpdateDriver.ts', 'src/main/portableUpdater.ts']) {
    const source = readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /(?:from\s*|import\s*\(|require\s*\()['"](?:electron-updater|\.\/updater|node:child_process|node:fs)['"]/u)
    assert.doesNotMatch(source, /downloadURL|openPath|quitAndInstall/u)
  }
})
