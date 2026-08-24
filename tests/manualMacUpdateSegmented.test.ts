import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createManualMacUpdateService } from '../src/main/manualMacUpdate.ts'

/**
 * 创建测试用临时下载目录。
 * @returns 临时目录与清理函数。
 * @author zhenghq
 */
async function createDownloadDirectory(): Promise<{
  directory: string
  cleanup: () => Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'selection-translator-segmented-'))
  return {
    directory,
    cleanup: async () => rm(directory, { recursive: true, force: true })
  }
}

/**
 * 生成可预测内容的测试数据。
 * @param length 数据长度。
 * @returns 每字节等于索引取模 251 的数据。
 * @author zhenghq
 */
function buildContent(length: number): Uint8Array {
  const content = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) content[index] = index % 251
  return content
}

/**
 * 计算 base64 sha512 摘要。
 * @param content 待计算内容。
 * @returns base64 编码摘要。
 * @author zhenghq
 */
function sha512Of(content: Uint8Array): string {
  return createHash('sha512').update(content).digest('base64')
}

test('下载源支持 Range 时应改用分片并发下载且结果字节一致', async () => {
  const { directory, cleanup } = await createDownloadDirectory()
  const content = buildContent(12 * 1024 * 1024)
  const rangeRequests: string[] = []
  const service = createManualMacUpdateService({
    downloadsDirectory: directory,
    architecture: 'arm64',
    fetch: async (_url, init) => {
      const range = new Headers(init?.headers ?? {}).get('range')
      if (range) rangeRequests.push(range)
      // 能力探测请求。
      if (range === 'bytes=0-0') {
        return new Response(content.slice(0, 1), {
          status: 206,
          headers: {
            'accept-ranges': 'bytes',
            'content-range': `bytes 0-0/${content.byteLength}`
          }
        })
      }
      const matched = /bytes=(\d+)-(\d+)/u.exec(range ?? '')
      assert.ok(matched, `分片请求必须携带完整 Range，实际：${range}`)
      const start = Number(matched[1])
      const end = Number(matched[2])
      return new Response(content.slice(start, end + 1), { status: 206 })
    },
    openPath: async () => ''
  })

  try {
    const result = await service.downloadAndOpen(
      'https://example.com/App-1.0.4-mac-arm64.dmg',
      '1.0.4',
      undefined,
      { sha512: sha512Of(content), size: content.byteLength }
    )

    assert.equal(rangeRequests[0], 'bytes=0-0', '必须先做 Range 能力探测')
    assert.ok(rangeRequests.length > 2, '支持 Range 时应发出多个分片请求')
    assert.equal(result.verified, true)
    assert.equal(Buffer.from(content).equals(await readFile(result.path)), true)
  } finally {
    await cleanup()
  }
})

test('下载源不支持 Range 时应回退单流下载并完成校验', async () => {
  const { directory, cleanup } = await createDownloadDirectory()
  const content = buildContent(12 * 1024 * 1024)
  let probeCount = 0
  let fullRequests = 0
  const service = createManualMacUpdateService({
    downloadsDirectory: directory,
    architecture: 'arm64',
    fetch: async (_url, init) => {
      const range = new Headers(init?.headers ?? {}).get('range')
      if (range === 'bytes=0-0') {
        probeCount += 1
        // 忽略 Range，直接返回整包。
        return new Response(content, {
          status: 200,
          headers: { 'content-length': String(content.byteLength) }
        })
      }
      fullRequests += 1
      return new Response(content, {
        status: 200,
        headers: { 'content-length': String(content.byteLength) }
      })
    },
    openPath: async () => ''
  })

  try {
    const result = await service.downloadAndOpen(
      'https://example.com/App-1.0.4-mac-arm64.dmg',
      '1.0.4',
      undefined,
      { sha512: sha512Of(content), size: content.byteLength }
    )

    assert.equal(probeCount, 1)
    assert.equal(fullRequests, 1, '回退路径应只发起一次完整下载')
    assert.equal(Buffer.from(content).equals(await readFile(result.path)), true)
    assert.equal(result.verified, true)
  } finally {
    await cleanup()
  }
})

test('Range 能力探测本身失败时应回退单流而不是判定下载失败', async () => {
  const { directory, cleanup } = await createDownloadDirectory()
  const content = buildContent(12 * 1024 * 1024)
  let probeAttempted = false
  const service = createManualMacUpdateService({
    downloadsDirectory: directory,
    architecture: 'arm64',
    fetch: async (_url, init) => {
      const range = new Headers(init?.headers ?? {}).get('range')
      if (range === 'bytes=0-0') {
        probeAttempted = true
        throw new Error('探测请求被中断')
      }
      return new Response(content, {
        status: 200,
        headers: { 'content-length': String(content.byteLength) }
      })
    },
    openPath: async () => ''
  })

  try {
    const result = await service.downloadAndOpen(
      'https://example.com/App-1.0.4-mac-arm64.dmg',
      '1.0.4',
      undefined,
      { sha512: sha512Of(content), size: content.byteLength }
    )

    assert.equal(probeAttempted, true)
    assert.equal(Buffer.from(content).equals(await readFile(result.path)), true)
  } finally {
    await cleanup()
  }
})

test('缺少清单长度时不应尝试分片，直接单流下载', async () => {
  const { directory, cleanup } = await createDownloadDirectory()
  const content = buildContent(4096)
  const ranges: Array<string | null> = []
  const service = createManualMacUpdateService({
    downloadsDirectory: directory,
    architecture: 'arm64',
    fetch: async (_url, init) => {
      ranges.push(new Headers(init?.headers ?? {}).get('range'))
      return new Response(content, { status: 200 })
    },
    openPath: async () => ''
  })

  try {
    await service.downloadAndOpen('https://example.com/App-1.0.4-mac-arm64.dmg', '1.0.4')

    assert.deepEqual(ranges, [null], '无清单长度时不应发出 Range 探测')
  } finally {
    await cleanup()
  }
})

test('分片下载中断后重试应从各分片已完成偏移续传', async () => {
  const { directory, cleanup } = await createDownloadDirectory()
  const content = buildContent(12 * 1024 * 1024)
  const sha512 = sha512Of(content)
  let failNextSegment = true
  const attemptedRanges: string[] = []

  /**
   * 构建可控失败的下载服务，用于验证续传行为。
   * @returns 手动 macOS 更新服务。
   * @author zhenghq
   */
  const buildService = () => createManualMacUpdateService({
    downloadsDirectory: directory,
    architecture: 'arm64',
    fetch: async (_url, init) => {
      const range = new Headers(init?.headers ?? {}).get('range')
      if (range === 'bytes=0-0') {
        return new Response(content.slice(0, 1), {
          status: 206,
          headers: {
            'accept-ranges': 'bytes',
            'content-range': `bytes 0-0/${content.byteLength}`
          }
        })
      }
      const matched = /bytes=(\d+)-(\d+)/u.exec(range ?? '')
      assert.ok(matched, `分片请求必须携带 Range，实际：${range}`)
      const start = Number(matched[1])
      const end = Number(matched[2])
      attemptedRanges.push(`${start}-${end}`)
      // 让最后一个分片在首轮下载中持续失败。
      if (failNextSegment && start >= 9 * 1024 * 1024) {
        throw new Error('分片连接中断')
      }
      return new Response(content.slice(start, end + 1), { status: 206 })
    },
    openPath: async () => ''
  })

  try {
    await assert.rejects(
      buildService().downloadAndOpen(
        'https://example.com/App-1.0.4-mac-arm64.dmg',
        '1.0.4',
        undefined,
        { sha512, size: content.byteLength }
      ),
      /分片下载失败/u
    )

    failNextSegment = false
    attemptedRanges.length = 0

    const result = await buildService().downloadAndOpen(
      'https://example.com/App-1.0.4-mac-arm64.dmg',
      '1.0.4',
      undefined,
      { sha512, size: content.byteLength }
    )

    assert.equal(Buffer.from(content).equals(await readFile(result.path)), true)
    assert.equal(result.verified, true)
    assert.ok(
      attemptedRanges.every((range) => Number(range.split('-')[0]) >= 9 * 1024 * 1024),
      `重试只应请求未完成分片，实际请求：${attemptedRanges.join(',')}`
    )
  } finally {
    await cleanup()
  }
})
