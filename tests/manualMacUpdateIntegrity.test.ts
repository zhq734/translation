import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createManualMacUpdateService,
  resolveManualMacDmgTarget
} from '../src/main/manualMacUpdate.ts'
import { saveDownloadResumeState } from '../src/main/updateDownloadResume.ts'

/**
 * 创建测试用临时下载目录。
 * @returns 临时目录与清理函数。
 * @author zhenghq
 */
async function createDownloadDirectory(): Promise<{
  directory: string
  cleanup: () => Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'selection-translator-integrity-'))
  return {
    directory,
    cleanup: async () => rm(directory, { recursive: true, force: true })
  }
}

/**
 * 计算内容的 base64 sha512 摘要，与 electron-updater 清单格式保持一致。
 * @param content 待计算内容。
 * @returns base64 编码的 sha512 摘要。
 * @author zhenghq
 */
function sha512Of(content: Uint8Array): string {
  return createHash('sha512').update(content).digest('base64')
}

test('命中清单真实 DMG 条目时应返回地址、sha512 与 size', () => {
  const target = resolveManualMacDmgTarget([
    { url: 'https://example.com/App-1.0.4-mac-arm64.dmg', sha512: 'dmg-hash', size: 1234 },
    { url: 'https://example.com/App-1.0.4-mac-arm64.zip', sha512: 'zip-hash', size: 999 }
  ], 'arm64')

  assert.deepEqual(target, {
    url: 'https://example.com/App-1.0.4-mac-arm64.dmg',
    sha512: 'dmg-hash',
    size: 1234
  })
})

test('由 ZIP 推导 DMG 地址时不得返回 ZIP 的 sha512 与 size', () => {
  const target = resolveManualMacDmgTarget([
    { url: 'https://example.com/App-1.0.4-mac-arm64.zip', sha512: 'zip-hash', size: 999 }
  ], 'arm64')

  assert.equal(target?.url, 'https://example.com/App-1.0.4-mac-arm64.dmg')
  assert.equal(target?.sha512, undefined)
  assert.equal(target?.size, undefined)
})

test('sha512 校验通过时应保留文件并打开安装界面', async () => {
  const { directory, cleanup } = await createDownloadDirectory()
  const content = new Uint8Array([1, 2, 3, 4, 5])
  const openedPaths: string[] = []
  const service = createManualMacUpdateService({
    downloadsDirectory: directory,
    architecture: 'arm64',
    fetch: async () => new Response(content, {
      status: 200,
      headers: { 'content-length': String(content.byteLength) }
    }),
    openPath: async (path) => {
      openedPaths.push(path)
      return ''
    }
  })

  try {
    const result = await service.downloadAndOpen(
      'https://example.com/App-1.0.4-mac-arm64.dmg',
      '1.0.4',
      undefined,
      { sha512: sha512Of(content) }
    )

    assert.equal(result.verified, true)
    assert.deepEqual(openedPaths, [result.path])
    assert.equal((await readFile(result.path)).toString('hex'), '0102030405')
  } finally {
    await cleanup()
  }
})

test('sha512 校验失败时应删除文件、不打开安装界面并抛出明确错误', async () => {
  const { directory, cleanup } = await createDownloadDirectory()
  const openedPaths: string[] = []
  const service = createManualMacUpdateService({
    downloadsDirectory: directory,
    architecture: 'arm64',
    fetch: async () => new Response(new Uint8Array([9, 9, 9]), { status: 200 }),
    openPath: async (path) => {
      openedPaths.push(path)
      return ''
    }
  })

  try {
    await assert.rejects(
      service.downloadAndOpen(
        'https://example.com/App-1.0.4-mac-arm64.dmg',
        '1.0.4',
        undefined,
        { sha512: sha512Of(new Uint8Array([1, 2, 3])) }
      ),
      /完整性校验失败/u
    )
    assert.deepEqual(openedPaths, [])
    assert.deepEqual(await rm(join(directory, 'x'), { force: true }), undefined)
    const remaining = await readFile(
      join(directory, 'SelectionTranslator-1.0.4-mac-arm64.dmg')
    ).catch(() => undefined)
    assert.equal(remaining, undefined, '校验失败的文件必须被删除')
  } finally {
    await cleanup()
  }
})

test('缺少校验值时应完成下载并标记为未经完整性校验', async () => {
  const { directory, cleanup } = await createDownloadDirectory()
  const openedPaths: string[] = []
  const service = createManualMacUpdateService({
    downloadsDirectory: directory,
    architecture: 'arm64',
    fetch: async () => new Response(new Uint8Array([7, 7]), { status: 200 }),
    openPath: async (path) => {
      openedPaths.push(path)
      return ''
    }
  })

  try {
    const result = await service.downloadAndOpen(
      'https://example.com/App-1.0.4-mac-arm64.dmg',
      '1.0.4'
    )

    assert.equal(result.verified, false)
    assert.deepEqual(openedPaths, [result.path])
  } finally {
    await cleanup()
  }
})

test('中断后重新下载同一版本应通过 Range 从已完成字节续传', async () => {
  const { directory, cleanup } = await createDownloadDirectory()
  const fullContent = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
  const destination = join(directory, 'SelectionTranslator-1.0.4-mac-arm64.dmg')
  const requests: Array<{ url: string; range: string | null }> = []
  const service = createManualMacUpdateService({
    downloadsDirectory: directory,
    architecture: 'arm64',
    fetch: async (url, init) => {
      const range = new Headers(init?.headers ?? {}).get('range')
      requests.push({ url, range })
      const start = range ? Number(/bytes=(\d+)-/u.exec(range)?.[1] ?? 0) : 0
      const slice = fullContent.slice(start)
      return new Response(slice, {
        status: start > 0 ? 206 : 200,
        headers: {
          'content-length': String(slice.byteLength),
          'content-range': `bytes ${start}-${fullContent.byteLength - 1}/${fullContent.byteLength}`
        }
      })
    },
    openPath: async () => ''
  })

  try {
    // 模拟上次下载中断：已完成前 5 字节且进度记录一致。
    await writeFile(`${destination}.part`, Buffer.from(fullContent.slice(0, 5)))
    await saveDownloadResumeState(destination, {
      version: '1.0.4',
      total: 8,
      sha512: sha512Of(fullContent),
      segments: [{ start: 0, end: 7, completed: 5 }]
    })

    const result = await service.downloadAndOpen(
      'https://example.com/App-1.0.4-mac-arm64.dmg',
      '1.0.4',
      undefined,
      { sha512: sha512Of(fullContent), size: 8 }
    )

    assert.equal(requests.length, 1)
    assert.equal(requests[0].range, 'bytes=5-', '必须只请求剩余字节')
    assert.equal((await readFile(result.path)).toString('hex'), '0102030405060708')
    assert.equal(result.verified, true)
  } finally {
    await cleanup()
  }
})

test('下载目标变化时应丢弃旧进度并重新完整下载', async () => {
  const { directory, cleanup } = await createDownloadDirectory()
  const fullContent = new Uint8Array([10, 20, 30, 40])
  const destination = join(directory, 'SelectionTranslator-1.0.5-mac-arm64.dmg')
  const ranges: Array<string | null> = []
  const service = createManualMacUpdateService({
    downloadsDirectory: directory,
    architecture: 'arm64',
    fetch: async (_url, init) => {
      ranges.push(new Headers(init?.headers ?? {}).get('range'))
      return new Response(fullContent, {
        status: 200,
        headers: { 'content-length': String(fullContent.byteLength) }
      })
    },
    openPath: async () => ''
  })

  try {
    await writeFile(`${destination}.part`, Buffer.alloc(3))
    await saveDownloadResumeState(destination, {
      version: '1.0.5',
      total: 4,
      sha512: '旧版本摘要',
      segments: [{ start: 0, end: 3, completed: 3 }]
    })

    const result = await service.downloadAndOpen(
      'https://example.com/App-1.0.5-mac-arm64.dmg',
      '1.0.5',
      undefined,
      { sha512: sha512Of(fullContent), size: 4 }
    )

    assert.deepEqual(ranges, [null], '校验值不一致时不应发送 Range 请求')
    assert.equal((await readFile(result.path)).toString('hex'), '0a141e28')
  } finally {
    await cleanup()
  }
})

test('下载成功后应清理临时文件与进度记录', async () => {
  const { directory, cleanup } = await createDownloadDirectory()
  const content = new Uint8Array([1, 1, 1])
  const service = createManualMacUpdateService({
    downloadsDirectory: directory,
    architecture: 'arm64',
    fetch: async () => new Response(content, { status: 200 }),
    openPath: async () => ''
  })

  try {
    const result = await service.downloadAndOpen(
      'https://example.com/App-1.0.4-mac-arm64.dmg',
      '1.0.4'
    )

    assert.equal(await readFile(`${result.path}.part`).catch(() => 'missing'), 'missing')
    assert.equal(await readFile(`${result.path}.part.json`).catch(() => 'missing'), 'missing')
  } finally {
    await cleanup()
  }
})
