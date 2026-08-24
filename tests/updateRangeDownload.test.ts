import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  downloadSegments,
  parseRangeProbe,
  planDownloadSegments,
  MAX_DOWNLOAD_CONCURRENCY,
  MINIMUM_SEGMENT_SIZE
} from '../src/main/updateRangeDownload.ts'
import type { DownloadResumeSegment } from '../src/main/updateDownloadResume.ts'

test('Range 探测在返回 206 且声明支持字节范围时应启用分片', () => {
  assert.deepEqual(
    parseRangeProbe({
      status: 206,
      acceptRanges: 'bytes',
      contentRange: 'bytes 0-0/104857600'
    }),
    { supported: true, total: 104_857_600 }
  )
})

test('Range 探测在状态码不是 206 时应回退单流', () => {
  assert.deepEqual(
    parseRangeProbe({ status: 200, acceptRanges: 'bytes', contentRange: 'bytes 0-0/1000' }),
    { supported: false, total: 0 }
  )
})

test('Range 探测在未声明 Accept-Ranges 时应回退单流', () => {
  assert.deepEqual(
    parseRangeProbe({ status: 206, acceptRanges: 'none', contentRange: 'bytes 0-0/1000' }),
    { supported: false, total: 0 }
  )
  assert.deepEqual(
    parseRangeProbe({ status: 206, acceptRanges: null, contentRange: 'bytes 0-0/1000' }),
    { supported: false, total: 0 }
  )
})

test('Range 探测缺少可信总长度时应回退单流', () => {
  assert.deepEqual(
    parseRangeProbe({ status: 206, acceptRanges: 'bytes', contentRange: null }),
    { supported: false, total: 0 }
  )
  assert.deepEqual(
    parseRangeProbe({ status: 206, acceptRanges: 'bytes', contentRange: 'bytes 0-0/*' }),
    { supported: false, total: 0 }
  )
})

test('Range 探测应接受清单提供的总长度作为兜底', () => {
  assert.deepEqual(
    parseRangeProbe({
      status: 206,
      acceptRanges: 'bytes',
      contentRange: 'bytes 0-0/*',
      manifestSize: 104_857_600
    }),
    { supported: true, total: 104_857_600 }
  )
})

test('分片规划应按并发上限覆盖完整字节区间且不重叠', () => {
  const total = 100 * 1024 * 1024
  const segments = planDownloadSegments(total, 4)

  assert.equal(segments.length, 4)
  assert.equal(segments[0].start, 0)
  assert.equal(segments[segments.length - 1].end, total - 1)
  for (let index = 1; index < segments.length; index += 1) {
    assert.equal(segments[index].start, segments[index - 1].end + 1)
  }
  const covered = segments.reduce((sum, segment) => sum + (segment.end - segment.start + 1), 0)
  assert.equal(covered, total)
  assert.ok(segments.every((segment) => segment.completed === 0))
})

test('分片规划应保证每个分片不小于最小分片体积', () => {
  const total = MINIMUM_SEGMENT_SIZE * 2 + 1024
  const segments = planDownloadSegments(total, 4)

  assert.equal(segments.length, 2, '总长度只够两个最小分片时不应切成四片')
  assert.ok(segments.every((segment) => segment.end - segment.start + 1 >= MINIMUM_SEGMENT_SIZE))
})

test('分片规划在更新包过小时应退化为单个分片', () => {
  const segments = planDownloadSegments(1024, 4)

  assert.deepEqual(segments, [{ start: 0, end: 1023, completed: 0 }])
  assert.deepEqual(planDownloadSegments(0, 4), [])
})

test('分片并发上限应为固定小值，避免触发下载源限流', () => {
  assert.equal(MAX_DOWNLOAD_CONCURRENCY, 4)
})

/**
 * 创建分片下载测试用的临时文件路径。
 * @returns 临时文件路径与清理函数。
 * @author zhenghq
 */
async function createTemporaryTarget(): Promise<{
  path: string
  cleanup: () => Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'selection-translator-segments-'))
  return {
    path: join(directory, 'update.dmg.part'),
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
 * 将总长度均分为指定数量的测试分片，不受生产最小分片体积限制。
 * @param total 总字节数。
 * @param count 分片数量。
 * @returns 测试用分片列表。
 * @author zhenghq
 */
function buildTestSegments(total: number, count: number): DownloadResumeSegment[] {
  const size = Math.ceil(total / count)
  const segments: DownloadResumeSegment[] = []
  for (let start = 0; start < total; start += size) {
    segments.push({ start, end: Math.min(start + size, total) - 1, completed: 0 })
  }
  return segments
}

/**
 * 从 Range 请求头解析起止偏移。
 * @param init 请求参数。
 * @returns 起止偏移。
 * @author zhenghq
 */
function parseRangeHeader(init?: RequestInit): { start: number; end: number } {
  const range = new Headers(init?.headers ?? {}).get('range') ?? ''
  const matched = /bytes=(\d+)-(\d+)/u.exec(range)
  if (!matched) throw new Error(`分片请求必须携带完整 Range，实际：${range}`)
  return { start: Number(matched[1]), end: Number(matched[2]) }
}

test('分片下载结果应与顺序下载字节一致且长度等于声明总长度', async () => {
  const { path, cleanup } = await createTemporaryTarget()
  const content = buildContent(10_000)

  try {
    await writeFile(path, Buffer.alloc(0))
    await downloadSegments({
      url: 'https://example.com/App-1.0.4-mac-arm64.dmg',
      temporaryPath: path,
      total: content.byteLength,
      segments: buildTestSegments(content.byteLength, 4),
      concurrency: 4,
      fetch: async (_url, init) => {
        const { start, end } = parseRangeHeader(init)
        return new Response(content.slice(start, end + 1), { status: 206 })
      }
    })

    const written = await readFile(path)
    assert.equal(written.byteLength, content.byteLength)
    assert.equal(Buffer.from(content).equals(written), true)
  } finally {
    await cleanup()
  }
})

test('单个分片失败后应只重试该分片的剩余部分', async () => {
  const { path, cleanup } = await createTemporaryTarget()
  const content = buildContent(4000)
  const requestedRanges: string[] = []
  let failuresInjected = 0

  try {
    await writeFile(path, Buffer.alloc(0))
    await downloadSegments({
      url: 'https://example.com/App-1.0.4-mac-arm64.dmg',
      temporaryPath: path,
      total: content.byteLength,
      segments: buildTestSegments(content.byteLength, 4),
      concurrency: 4,
      maxRetries: 3,
      fetch: async (_url, init) => {
        const { start, end } = parseRangeHeader(init)
        requestedRanges.push(`${start}-${end}`)
        if (start === 1000 && failuresInjected === 0) {
          failuresInjected += 1
          throw new Error('连接被重置')
        }
        return new Response(content.slice(start, end + 1), { status: 206 })
      }
    })

    assert.equal(Buffer.from(content).equals(await readFile(path)), true)
    assert.equal(requestedRanges.filter((range) => range === '1000-1999').length, 2)
    assert.equal(requestedRanges.filter((range) => range === '0-999').length, 1)
  } finally {
    await cleanup()
  }
})

test('分片重试耗尽时应抛出明确错误并保留已完成进度', async () => {
  const { path, cleanup } = await createTemporaryTarget()
  const content = buildContent(4000)
  const segments = buildTestSegments(content.byteLength, 4)

  try {
    await writeFile(path, Buffer.alloc(0))
    await assert.rejects(
      downloadSegments({
        url: 'https://example.com/App-1.0.4-mac-arm64.dmg',
        temporaryPath: path,
        total: content.byteLength,
        segments,
        concurrency: 2,
        maxRetries: 2,
        fetch: async (_url, init) => {
          const { start, end } = parseRangeHeader(init)
          if (start === 3000) throw new Error('分片持续失败')
          return new Response(content.slice(start, end + 1), { status: 206 })
        }
      }),
      /分片下载失败/u
    )

    assert.equal(segments[3].completed, 0)
    assert.ok(
      segments.slice(0, 3).some((segment) => segment.completed > 0),
      '已完成分片的进度必须保留下来供续传'
    )
  } finally {
    await cleanup()
  }
})

test('分片下载的并发连接数不应超过配置上限', async () => {
  const { path, cleanup } = await createTemporaryTarget()
  const content = buildContent(16_000)
  let active = 0
  let peak = 0

  try {
    await writeFile(path, Buffer.alloc(0))
    await downloadSegments({
      url: 'https://example.com/App-1.0.4-mac-arm64.dmg',
      temporaryPath: path,
      total: content.byteLength,
      segments: buildTestSegments(content.byteLength, 16),
      concurrency: 4,
      fetch: async (_url, init) => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        const { start, end } = parseRangeHeader(init)
        return new Response(content.slice(start, end + 1), { status: 206 })
      }
    })

    assert.ok(peak > 1, '应确实存在并发下载')
    assert.ok(peak <= 4, `并发连接数不应超过 4，实际峰值 ${peak}`)
  } finally {
    await cleanup()
  }
})

test('分片进度应合计所有分片已完成字节且百分比单调不减', async () => {
  const { path, cleanup } = await createTemporaryTarget()
  const content = buildContent(8000)
  const percents: number[] = []
  let lastTransferred = 0

  try {
    await writeFile(path, Buffer.alloc(0))
    await downloadSegments({
      url: 'https://example.com/App-1.0.4-mac-arm64.dmg',
      temporaryPath: path,
      total: content.byteLength,
      segments: buildTestSegments(content.byteLength, 4),
      concurrency: 4,
      onProgress: (progress) => {
        percents.push(progress.percent)
        lastTransferred = progress.transferred
      },
      fetch: async (_url, init) => {
        const { start, end } = parseRangeHeader(init)
        return new Response(content.slice(start, end + 1), { status: 206 })
      }
    })

    assert.equal(lastTransferred, content.byteLength)
    for (let index = 1; index < percents.length; index += 1) {
      assert.ok(percents[index] >= percents[index - 1], `百分比不应回退：${percents.join(',')}`)
    }
  } finally {
    await cleanup()
  }
})

test('分片下载应支持从各分片已完成偏移续传', async () => {
  const { path, cleanup } = await createTemporaryTarget()
  const content = buildContent(4000)
  const requestedRanges: string[] = []
  const segments = buildTestSegments(content.byteLength, 4)
  segments[0].completed = 400
  segments[2].completed = 1000

  try {
    // 预置已完成字节，模拟上次中断留下的临时文件。
    const partial = Buffer.alloc(content.byteLength)
    Buffer.from(content.slice(0, 400)).copy(partial, 0)
    Buffer.from(content.slice(2000, 3000)).copy(partial, 2000)
    await writeFile(path, partial)

    await downloadSegments({
      url: 'https://example.com/App-1.0.4-mac-arm64.dmg',
      temporaryPath: path,
      total: content.byteLength,
      segments,
      concurrency: 4,
      fetch: async (_url, init) => {
        const { start, end } = parseRangeHeader(init)
        requestedRanges.push(`${start}-${end}`)
        return new Response(content.slice(start, end + 1), { status: 206 })
      }
    })

    assert.equal(requestedRanges.includes('400-999'), true, '第一个分片应只请求剩余字节')
    assert.equal(requestedRanges.includes('3000-2999'), false)
    assert.equal(requestedRanges.includes('0-999'), false, '不应重新下载已完成部分')
    assert.equal(Buffer.from(content).equals(await readFile(path)), true)
  } finally {
    await cleanup()
  }
})
