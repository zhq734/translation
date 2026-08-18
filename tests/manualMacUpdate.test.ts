import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createManualMacUpdateService,
  resolveManualMacDmgUrl
} from '../src/main/manualMacUpdate.ts'

/**
 * 创建测试用临时下载目录，并在测试结束后清理。
 * @returns 临时目录和清理函数。
 * @author zhenghq
 */
async function createDownloadDirectory(): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'selection-translator-manual-update-'))
  return {
    directory,
    cleanup: async () => rm(directory, { recursive: true, force: true })
  }
}

test('手动更新应优先选择当前架构 DMG，并能从同名 ZIP 推导 DMG 地址', () => {
  assert.equal(
    resolveManualMacDmgUrl([
      { url: 'https://example.com/SelectionTranslator-1.0.4-mac-x64.dmg' },
      { url: 'https://example.com/SelectionTranslator-1.0.4-mac-arm64.zip' },
      { url: 'https://example.com/SelectionTranslator-1.0.4-mac-x64.zip' }
    ], 'arm64'),
    'https://example.com/SelectionTranslator-1.0.4-mac-arm64.dmg'
  )
  assert.equal(
    resolveManualMacDmgUrl([
      { url: 'https://example.com/SelectionTranslator-1.0.4-mac-arm64.zip' }
    ], 'arm64'),
    'https://example.com/SelectionTranslator-1.0.4-mac-arm64.dmg'
  )
  assert.equal(resolveManualMacDmgUrl([], 'arm64'), undefined)
})

test('手动更新应使用 Release 下载基准地址解析相对 DMG，并优先选择当前架构', () => {
  const releaseDownloadBaseUrl = 'https://github.com/zhq734/translation/releases/latest/download/'

  assert.equal(
    resolveManualMacDmgUrl([
      { url: 'SelectionTranslator-1.0.4-mac-x64.dmg' },
      { url: 'SelectionTranslator-1.0.4-mac-arm64.dmg' }
    ], 'arm64', releaseDownloadBaseUrl),
    'https://github.com/zhq734/translation/releases/latest/download/SelectionTranslator-1.0.4-mac-arm64.dmg'
  )
})

test('手动更新应使用 Release 下载基准地址从相对 ZIP 推导 DMG 地址', () => {
  const releaseDownloadBaseUrl = 'https://github.com/zhq734/translation/releases/latest/download/'

  assert.equal(
    resolveManualMacDmgUrl([
      { url: 'SelectionTranslator-1.0.4-mac-x64.zip' },
      { url: 'SelectionTranslator-1.0.4-mac-arm64.zip' }
    ], 'arm64', releaseDownloadBaseUrl),
    'https://github.com/zhq734/translation/releases/latest/download/SelectionTranslator-1.0.4-mac-arm64.dmg'
  )
})

test('手动更新缺少下载基准地址时不应返回无法下载的相对地址', () => {
  assert.equal(
    resolveManualMacDmgUrl([
      { url: 'SelectionTranslator-1.0.4-mac-arm64.dmg' }
    ], 'arm64'),
    undefined
  )
})

test('手动更新不应改变更新清单中的绝对 HTTPS 地址', () => {
  assert.equal(
    resolveManualMacDmgUrl([
      { url: 'https://example.com/releases/SelectionTranslator-1.0.4-mac-arm64.dmg?download=1' }
    ], 'arm64', 'https://github.com/zhq734/translation/releases/latest/download/'),
    'https://example.com/releases/SelectionTranslator-1.0.4-mac-arm64.dmg?download=1'
  )
})

test('手动 macOS 更新只接受 HTTPS 的 DMG 地址', async () => {
  const { directory, cleanup } = await createDownloadDirectory()
  const requestedUrls: string[] = []
  const openedPaths: string[] = []
  const service = createManualMacUpdateService({
    downloadsDirectory: directory,
    architecture: 'arm64',
    fetch: async (url) => {
      requestedUrls.push(String(url))
      return new Response(new Uint8Array([1, 2, 3]))
    },
    openPath: async (path) => {
      openedPaths.push(path)
      return ''
    }
  })

  try {
    await assert.rejects(
      service.downloadAndOpen('http://example.com/update.dmg', '1.0.4'),
      /只支持 HTTPS/u
    )
    await assert.rejects(
      service.downloadAndOpen('https://example.com/update.zip', '1.0.4'),
      /必须是 DMG/u
    )
    assert.deepEqual(requestedUrls, [])
    assert.deepEqual(openedPaths, [])
  } finally {
    await cleanup()
  }
})

test('手动 macOS 更新应将 DMG 保存到 Downloads 并打开文件', async () => {
  const { directory, cleanup } = await createDownloadDirectory()
  const openedPaths: string[] = []
  const service = createManualMacUpdateService({
    downloadsDirectory: directory,
    architecture: 'arm64',
    fetch: async () => new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { 'content-length': '4' }
    }),
    openPath: async (path) => {
      openedPaths.push(path)
      return ''
    }
  })

  try {
    const result = await service.downloadAndOpen(
      'https://example.com/releases/SelectionTranslator-1.0.4-mac-arm64.dmg?download=1',
      '1.0/../4'
    )
    const content = await readFile(result.path)

    assert.equal(content.toString('hex'), '01020304')
    assert.equal(openedPaths.length, 1)
    assert.equal(openedPaths[0], result.path)
    assert.equal(result.path.startsWith(directory), true)
    assert.equal(result.path.includes('..'), false)
    assert.match(result.path, /SelectionTranslator-1\.0___4-mac-arm64\.dmg$/u)
  } finally {
    await cleanup()
  }
})

test('GitHub DMG 跳转到不带扩展名的 HTTPS 资产地址后仍应完成下载', async () => {
  const { directory, cleanup } = await createDownloadDirectory()
  const requestedUrls: string[] = []
  const openedPaths: string[] = []
  const service = createManualMacUpdateService({
    downloadsDirectory: directory,
    architecture: 'arm64',
    fetch: async (url) => {
      requestedUrls.push(String(url))
      if (requestedUrls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://release-assets.githubusercontent.com/github-production-release-asset/asset-id?download=1'
          }
        })
      }
      return new Response(new Uint8Array([4, 3, 2, 1]), { status: 200 })
    },
    openPath: async (path) => {
      openedPaths.push(path)
      return ''
    }
  })

  try {
    const result = await service.downloadAndOpen(
      'https://github.com/example/project/releases/download/v1.0.4/SelectionTranslator-1.0.4-mac-arm64.dmg',
      '1.0.4'
    )

    assert.deepEqual(requestedUrls, [
      'https://github.com/example/project/releases/download/v1.0.4/SelectionTranslator-1.0.4-mac-arm64.dmg',
      'https://release-assets.githubusercontent.com/github-production-release-asset/asset-id?download=1'
    ])
    assert.equal((await readFile(result.path)).toString('hex'), '04030201')
    assert.deepEqual(openedPaths, [result.path])
  } finally {
    await cleanup()
  }
})

test('DMG 下载重定向仍应拒绝非 HTTPS 地址', async () => {
  const { directory, cleanup } = await createDownloadDirectory()
  const service = createManualMacUpdateService({
    downloadsDirectory: directory,
    fetch: async () => new Response(null, {
      status: 302,
      headers: { location: 'http://example.com/asset-id' }
    }),
    openPath: async () => ''
  })

  try {
    await assert.rejects(
      service.downloadAndOpen('https://example.com/releases/update.dmg', '1.0.4'),
      /只支持 HTTPS/u
    )
  } finally {
    await cleanup()
  }
})

test('DMG 下载失败时不应打开不完整文件', async () => {
  const { directory, cleanup } = await createDownloadDirectory()
  const openedPaths: string[] = []
  const service = createManualMacUpdateService({
    downloadsDirectory: directory,
    fetch: async () => new Response('failed', { status: 503, statusText: 'Service Unavailable' }),
    openPath: async (path) => {
      openedPaths.push(path)
      return ''
    }
  })

  try {
    await assert.rejects(
      service.downloadAndOpen('https://example.com/releases/update.dmg', '1.0.4'),
      /DMG 下载失败/u
    )
    assert.deepEqual(openedPaths, [])
  } finally {
    await cleanup()
  }
})

test('DMG 打开失败时应返回可操作错误', async () => {
  const { directory, cleanup } = await createDownloadDirectory()
  const service = createManualMacUpdateService({
    downloadsDirectory: directory,
    fetch: async () => new Response(new Uint8Array([1]), { status: 200 }),
    openPath: async () => 'Finder 打开失败'
  })

  try {
    await assert.rejects(
      service.downloadAndOpen('https://example.com/releases/update.dmg', '1.0.4'),
      /无法打开已下载的 DMG：Finder 打开失败/u
    )
  } finally {
    await cleanup()
  }
})
