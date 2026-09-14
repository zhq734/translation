import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installParallelUpdateDownload } from '../src/main/updateHttpExecutor.ts'
import { MAX_DOWNLOAD_CONCURRENCY } from '../src/main/updateRangeDownload.ts'

/** 测试用 electron-updater 下载选项，避免测试包引入 CommonJS 运行时依赖。 */
interface DownloadOptions {
  headers?: Record<string, string>
  sha2?: string
  sha512?: string
  cancellationToken?: FakeCancellationToken
  onProgress?: (progress: { total: number; transferred: number; percent: number }) => void
}

/** 测试用取消令牌，只实现分片下载适配器依赖的取消回调。 */
class FakeCancellationToken {
  private readonly controller = new AbortController()
  private readonly cancelCallbacks = new Set<() => void>()
  private cancelRequested = false

  /**
   * 注册令牌取消时的回调。
   * @param callback 包含 resolve、reject 与 onCancel 回调的注册函数。
   * @returns 永不完成的占位 Promise，避免 Node 测试进程因悬挂任务提前退出。
   * @author zhenghq
   */
  createPromise<T>(
    callback: (
      resolve: (thenableOrResult: T | PromiseLike<T>) => void,
      reject: (error: Error) => void,
      onCancel: (callback: () => void) => void
    ) => void
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      callback(resolve, reject, onCancel => {
        this.cancelCallbacks.add(onCancel)
        if (this.cancelRequested) onCancel()
      })
    })
  }

  /** 触发测试用取消令牌。 */
  cancel(): void {
    this.cancelRequested = true
    for (const callback of this.cancelCallbacks) callback()
    this.controller.abort()
  }
}

/** 测试用 electron-updater httpExecutor 形状。 */
interface FakeHttpExecutor {
  download: (
    url: URL,
    destination: string,
    options: DownloadOptions
  ) => Promise<string>
}

/** 测试用 updater，只暴露被包装的 httpExecutor 字段。 */
interface FakeUpdater {
  httpExecutor: FakeHttpExecutor
}

/**
 * 创建测试目标和可注入的 electron-updater 实例。
 * @returns 临时文件路径、清理函数和假更新器。
 * @author zhenghq
 */
async function createDownloadTarget(options?: {
  truncateError?: Error
}): Promise<{
  directory: string
  destination: string
  cleanup: () => Promise<void>
  updater: FakeUpdater
}> {
  const directory = await mkdtemp(join(tmpdir(), 'selection-translator-parallel-update-'))
  // 与 electron-updater 真实目录结构保持一致：目标文件位于 pending 子目录，
  // 续传文件则存放在 pending 的同级目录，避免被 electron-updater 失败清理逻辑删除。
  const pendingDirectory = join(directory, 'pending')
  await mkdir(pendingDirectory, { recursive: true })
  const destination = join(pendingDirectory, 'temp-update.exe')
  await writeFile(destination, Buffer.alloc(0))
  const updater = {
    httpExecutor: {
      async download(_url: URL, target: string, _options: DownloadOptions): Promise<string> {
        await writeFile(target, Buffer.from('single-stream'))
        return target
      }
    }
  }
  return {
    directory,
    destination,
    cleanup: async () => rm(directory, { recursive: true, force: true }),
    updater
  }
}

/**
 * 解析分片请求头中的字节区间。
 * @param init 请求初始化参数。
 * @returns 请求的起始与结束偏移（含）。
 * @author zhenghq
 */
function parseRequestRange(init?: RequestInit): { start: number; end: number } {
  const range = new Headers(init?.headers ?? {}).get('range') ?? ''
  const matched = /bytes=(\d+)-(\d+)/u.exec(range)
  assert.ok(matched, `请求必须携带 Range：${range}`)
  return { start: Number(matched[1]), end: Number(matched[2]) }
}

/**
 * 构造先返回部分数据、随后模拟连接超时的分片响应。
 * @param content 完整测试数据。
 * @param start 本次分片起始偏移。
 * @param end 本次分片结束偏移（含）。
 * @param total 完整数据长度。
 * @returns 首个数据块之后抛出超时错误的 206 响应。
 * @author zhenghq
 */
function createRangeResponse(
  content: Uint8Array,
  start: number,
  end: number,
  total: number
): Response {
  return new Response(content.slice(start, end + 1), {
    status: 206,
    headers: {
      'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${end}/${total}`
    }
  })
}

/**
 * 构造先返回指定字节、随后抛出错误的伪响应体，用于确定性地模拟传输中断。
 * @param chunks 中断前已到达的数据块。
 * @param error 数据块耗尽后抛出的错误。
 * @returns 只实现 downloadSegments 依赖方法的伪响应体。
 * @author zhenghq
 */
function createInterruptedBody(
  chunks: Uint8Array[],
  error: Error
): ReadableStream<Uint8Array> {
  let index = 0
  return {
    getReader: () => ({
      read: async () => {
        if (index < chunks.length) {
          const value = chunks[index]
          index += 1
          return { done: false, value }
        }
        throw error
      },
      cancel: async () => undefined
    })
  } as unknown as ReadableStream<Uint8Array>
}

/**
 * 构造模拟连接中断的 206 响应。
 * @param chunks 中断前已到达的数据块。
 * @param start 本次分片起始偏移。
 * @param end 本次分片结束偏移（含）。
 * @param total 完整安装包长度。
 * @returns 读取到末尾时抛出错误的伪响应。
 * @author zhenghq
 */
function createInterruptedResponse(
  chunks: Uint8Array[],
  start: number,
  end: number,
  total: number
): Response {
  return {
    status: 206,
    headers: new Headers({
      'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${end}/${total}`
    }),
    body: createInterruptedBody(chunks, new Error('ERR_SOCKET_CONNECTION_RESET'))
  } as unknown as Response
}

/**
 * 构造 Range 能力探测响应。
 * @param total 完整安装包长度。
 * @returns 声明支持字节范围请求的 206 响应。
 * @author zhenghq
 */
function createProbeResponse(total: number): Response {
  return new Response(Buffer.alloc(1), {
    status: 206,
    headers: {
      'accept-ranges': 'bytes',
      'content-range': `bytes 0-0/${total}`
    }
  })
}

/**
 * 读取续传目录中唯一的进度记录文件内容。
 * @param directory 续传记录所在目录。
 * @returns 进度记录文件路径与解析后的 JSON。
 * @author zhenghq
 */
async function readResumeRecordFile(
  directory: string
): Promise<{ path: string; record: { total: number; sha512?: string; segments: Array<{ completed: number }> } }> {
  const entries = await readdir(directory)
  const recordName = entries.find((entry) => entry.endsWith('.part.json'))
  assert.ok(recordName, `应保留续传进度记录，实际目录内容：${entries.join(', ')}`)
  const recordPath = join(directory, recordName)
  return { path: recordPath, record: JSON.parse(await readFile(recordPath, 'utf8')) }
}

/**
 * 生成可预测的测试数据。
 * @param length 数据长度。
 * @returns 每字节等于索引取模 251 的数据。
 * @author zhenghq
 */
function buildContent(length: number): Uint8Array {
  const content = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) content[index] = index % 251
  return content
}

test('安装后 electron-updater 下载应优先使用 Range 分片并发下载', async () => {
  const { destination, cleanup, updater } = await createDownloadTarget()
  const content = buildContent(16 * 1024 * 1024)
  const contentHash = createHash('sha512').update(content).digest('base64')
  let active = 0
  let peak = 0
  const progresses: Array<{ percent: number; transferred: number }> = []

  try {
    installParallelUpdateDownload(updater, async (_url, init) => {
      const requestHeaders = new Headers(init?.headers ?? {})
      assert.equal(requestHeaders.get('x-test-header'), 'kept')
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      const range = new Headers(init?.headers ?? {}).get('range') ?? 'bytes=0-0'
      const matched = /bytes=(\d+)-(\d+)/u.exec(range)
      assert.ok(matched, `请求必须携带 Range：${range}`)
      const start = Number(matched[1])
      const end = Number(matched[2])
      if (start === 0 && end === 0) {
        return new Response(content.slice(0, 1), {
          status: 206,
          headers: {
            'accept-ranges': 'bytes',
            'content-range': `bytes 0-0/${content.byteLength}`
          }
        })
      }
      return new Response(content.slice(start, end + 1), {
        status: 206,
        headers: {
          'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${end}/${content.byteLength}`
        }
      })
    })

    const result = await updater.httpExecutor.download(
      new URL('https://example.com/SelectionTranslator-1.0.4-Setup-x64.exe'),
      destination,
      {
        cancellationToken: new FakeCancellationToken(),
        headers: { 'x-test-header': 'kept' },
        sha512: contentHash,
        onProgress: (progress) => {
          progresses.push({ percent: progress.percent, transferred: progress.transferred })
        }
      }
    )

    assert.equal(result, destination)
    assert.equal(Buffer.from(content).equals(await readFile(destination)), true)
    assert.ok(peak > 1, `应确实存在并发下载，实际峰值 ${peak}`)
    assert.ok(
      peak <= MAX_DOWNLOAD_CONCURRENCY,
      `并发连接数不应超过 ${MAX_DOWNLOAD_CONCURRENCY}，实际峰值 ${peak}`
    )
    assert.equal(progresses.at(-1)?.transferred, content.byteLength)
    assert.equal(progresses.at(-1)?.percent, 100)
  } finally {
    await cleanup()
  }
})

test('并行下载的 sha512 校验失败时应删除损坏的更新包', async () => {
  const { destination, cleanup, updater } = await createDownloadTarget()
  const content = buildContent(16 * 1024 * 1024)

  try {
    installParallelUpdateDownload(updater, async (_url, init) => {
      const range = new Headers(init?.headers ?? {}).get('range') ?? 'bytes=0-0'
      const matched = /bytes=(\d+)-(\d+)/u.exec(range)
      assert.ok(matched, `请求必须携带 Range：${range}`)
      const start = Number(matched[1])
      const end = Number(matched[2])
      return new Response(content.slice(start, end + 1), {
        status: 206,
        headers: {
          'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${end}/${content.byteLength}`
        }
      })
    })

    await assert.rejects(
      updater.httpExecutor.download(
        new URL('https://example.com/SelectionTranslator-1.0.4-Setup-x64.exe'),
        destination,
        {
          cancellationToken: new FakeCancellationToken(),
          sha512: createHash('sha512').update('wrong content').digest('base64')
        }
      ),
      /sha512 checksum mismatch/u
    )
    assert.equal(await stat(destination).then((info) => info.size).catch(() => 0), 0)
  } finally {
    await cleanup()
  }
})

test('Windows 预分配更新临时文件应使用可随机写入的 w+ 模式', () => {
  const source = readFileSync('src/main/updateHttpExecutor.ts', 'utf8')

  assert.match(source, /open\(destination, 'w\+'\)/u)
  assert.doesNotMatch(source, /open\(destination, 'a\+'\)/u)
})

test('下载源不支持 Range 时应回退 electron-updater 原生单流下载', async () => {
  const { destination, cleanup, updater } = await createDownloadTarget()
  let requests = 0

  try {
    installParallelUpdateDownload(updater, async () => {
      requests += 1
      return new Response(Buffer.alloc(0), { status: 200 })
    })

    const result = await updater.httpExecutor.download(
      new URL('https://example.com/SelectionTranslator-1.0.4-Setup-x64.exe'),
      destination,
      { cancellationToken: new FakeCancellationToken() }
    )

    assert.equal(result, destination)
    assert.equal((await readFile(destination, 'utf8')).trim(), 'single-stream')
    assert.equal(requests, 1)
  } finally {
    await cleanup()
  }
})

test('Range 探测收到 200 响应时不应消费完整响应体', async () => {
  const { destination, cleanup, updater } = await createDownloadTarget()
  let cancelCalled = false
  let streamRead = false

  try {
    installParallelUpdateDownload(updater, async () => {
      // 使用小体积流即可验证探测逻辑：收到 200 后应立即 cancel，而不是读取。
      const body = {
        cancel: async () => {
          cancelCalled = true
        },
        getReader: () => {
          streamRead = true
          throw new Error('探测不应读取 200 响应体内容')
        }
      }
      const response = {
        status: 200,
        headers: new Headers({ 'content-length': '64' }),
        get body() {
          return body
        }
      } as unknown as Response
      return response
    })

    const result = await updater.httpExecutor.download(
      new URL('https://example.com/SelectionTranslator-1.0.4-Setup-x64.exe'),
      destination,
      { cancellationToken: new FakeCancellationToken() }
    )

    assert.equal(result, destination)
    assert.equal((await readFile(destination, 'utf8')).trim(), 'single-stream')
    assert.equal(cancelCalled, true, '收到 200 后应立即取消探测响应体')
    assert.equal(streamRead, false, '探测不应读取 200 响应体内容')
  } finally {
    await cleanup()
  }
})

test('取消 electron-updater 下载令牌时应中断分片下载且不产出目标文件', async () => {
  const { directory, destination, cleanup, updater } = await createDownloadTarget()
  const cancellationToken = new FakeCancellationToken()
  let releaseFetch: (() => void) | undefined

  try {
    installParallelUpdateDownload(updater, async (_url, init) => {
      const range = new Headers(init?.headers ?? {}).get('range') ?? ''
      // 动态分片策略会跳过过小的更新包；这里返回足够大的总长度，
      // 确保取消测试仍能进入分片下载路径。
      if (range === 'bytes=0-0') {
        return new Response(Buffer.alloc(0), {
          status: 206,
          headers: {
            'accept-ranges': 'bytes',
            'content-range': `bytes 0-0/${32 * 1024 * 1024}`
          }
        })
      }
      return new Promise<Response>((resolve, reject) => {
        // 模拟真实 fetch 的 AbortSignal 行为：令牌取消后立即拒绝未完成的分片请求。
        init?.signal?.addEventListener('abort', () => reject(new Error('下载已取消')), {
          once: true
        })
        releaseFetch = () => resolve(new Response(Buffer.alloc(1000), { status: 206 }))
      })
    })

    const downloading = updater.httpExecutor.download(
      new URL('https://example.com/SelectionTranslator-1.0.4-Setup-x64.exe'),
      destination,
      { cancellationToken }
    )
    cancellationToken.cancel()
    releaseFetch?.()
    await assert.rejects(downloading, /下载已取消/u)
    assert.equal(await stat(destination).then((info) => info.size).catch(() => 0), 0)
    // 取消属于可重试中断，已下载字节应保留在续传目录而非被直接删除。
    const resumeEntries = await readdir(join(directory, 'resume')).catch(() => [])
    assert.ok(resumeEntries.length > 0, '取消后应保留续传文件与进度记录')
  } finally {
    await cleanup()
  }
})

test('分片下载中断时应保留临时文件与续传记录，供下次继续下载', async () => {
  const { directory, destination, cleanup, updater } = await createDownloadTarget()
  const content = buildContent(16 * 1024 * 1024)
  const contentHash = createHash('sha512').update(content).digest('base64')

  try {
    installParallelUpdateDownload(updater, async (_url, init) => {
      const { start, end } = parseRequestRange(init)
      if (start === 0 && end === 0) return createProbeResponse(content.byteLength)
      // 首轮所有分片都只传回一半数据后中断，确保既产生部分字节又能结束整次下载。
      const half = Math.max(1, Math.floor((end - start + 1) / 2))
      return createInterruptedResponse(
        [content.slice(start, start + half)],
        start,
        end,
        content.byteLength
      )
    })

    await assert.rejects(
      updater.httpExecutor.download(
        new URL('https://example.com/SelectionTranslator-1.0.4-Setup-x64.exe'),
        destination,
        {
          cancellationToken: new FakeCancellationToken(),
          sha512: contentHash
        }
      )
    )

    const resumeDirectory = join(directory, 'resume')
    const { record } = await readResumeRecordFile(resumeDirectory)
    assert.equal(record.total, content.byteLength)
    assert.equal(record.sha512, contentHash)
    assert.ok(
      record.segments.some((segment) => segment.completed > 0),
      '续传记录应保存已下载的分片进度'
    )
    const temporaryStat = await stat(join(resumeDirectory, 'temp-update.exe.part'))
    assert.equal(temporaryStat.size, content.byteLength, '续传文件应保持预分配长度')
  } finally {
    await cleanup()
  }
})

test('分片请求超时后重试应从已完成偏移继续，而不是从分片开头重下', async () => {
  const { directory, destination, cleanup, updater } = await createDownloadTarget()
  const content = buildContent(16 * 1024 * 1024)
  const contentHash = createHash('sha512').update(content).digest('base64')
  const requestedRanges: string[] = []
  let resumePhase = false

  try {
    installParallelUpdateDownload(updater, async (_url, init) => {
      const { start, end } = parseRequestRange(init)
      if (start === 0 && end === 0) return createProbeResponse(content.byteLength)
      requestedRanges.push(`${start}-${end}`)
      if (!resumePhase) {
        // 模拟“分片请求超时”：连接建立阶段即失败，尚未写入任何字节。
        throw new Error('分片请求超时')
      }
      return createRangeResponse(content, start, end, content.byteLength)
    })

    const url = new URL('https://example.com/SelectionTranslator-1.0.4-Setup-x64.exe')
    await assert.rejects(
      updater.httpExecutor.download(url, destination, {
        cancellationToken: new FakeCancellationToken(),
        sha512: contentHash
      }),
      /分片请求超时/u
    )

    const resumeDirectory = join(directory, 'resume')
    const { record } = await readResumeRecordFile(resumeDirectory)
    assert.equal(record.total, content.byteLength)
    assert.ok(
      record.segments.every((segment) => segment.completed === 0),
      '请求阶段超时确实没有可续传的字节'
    )

    resumePhase = true
    requestedRanges.length = 0
    await updater.httpExecutor.download(url, destination, {
      cancellationToken: new FakeCancellationToken(),
      sha512: contentHash
    })

    assert.ok(
      requestedRanges.some((range) => range.startsWith('0-')),
      `未写入任何字节时分片仍需从起点请求，实际请求：${requestedRanges.join(', ')}`
    )
  } finally {
    await cleanup()
  }
})

test('分片传输中途超时应保留已写入字节，下次下载从超时位置继续', async () => {
  const { directory, destination, cleanup, updater } = await createDownloadTarget()
  const content = buildContent(16 * 1024 * 1024)
  const contentHash = createHash('sha512').update(content).digest('base64')
  const requestedRanges: string[] = []
  let resumePhase = false

  try {
    installParallelUpdateDownload(updater, async (_url, init) => {
      const { start, end } = parseRequestRange(init)
      if (start === 0 && end === 0) return createProbeResponse(content.byteLength)
      requestedRanges.push(`${start}-${end}`)
      if (!resumePhase) {
        // 模拟“分片请求超时”：先写入一段数据，随后连接被超时中断。
        const delivered = Math.max(1, Math.floor((end - start + 1) / 4))
        return createInterruptedResponse(
          [content.slice(start, start + delivered)],
          start,
          end,
          content.byteLength
        )
      }
      return createRangeResponse(content, start, end, content.byteLength)
    })

    const url = new URL('https://example.com/SelectionTranslator-1.0.4-Setup-x64.exe')
    await assert.rejects(
      updater.httpExecutor.download(url, destination, {
        cancellationToken: new FakeCancellationToken(),
        sha512: contentHash
      })
    )

    const resumeDirectory = join(directory, 'resume')
    const { record } = await readResumeRecordFile(resumeDirectory)
    const completedBefore = record.segments.reduce((sum, segment) => sum + segment.completed, 0)
    assert.ok(completedBefore > 0, '超时中断前已写入的字节必须被记录')

    resumePhase = true
    requestedRanges.length = 0
    await updater.httpExecutor.download(url, destination, {
      cancellationToken: new FakeCancellationToken(),
      sha512: contentHash
    })

    const zeroOffsetRequests = requestedRanges.filter((range) => range.startsWith('0-'))
    assert.equal(
      zeroOffsetRequests.length,
      0,
      `续传时不应再从头请求分片，实际请求：${requestedRanges.join(', ')}`
    )
    assert.equal(Buffer.from(content).equals(await readFile(destination)), true)
  } finally {
    await cleanup()
  }
})

test('再次下载时应从续传记录中的已完成偏移继续而不是从头下载', async () => {
  const { directory, destination, cleanup, updater } = await createDownloadTarget()
  const content = buildContent(16 * 1024 * 1024)
  const contentHash = createHash('sha512').update(content).digest('base64')
  const requestedRanges: string[] = []
  let resumePhase = false

  try {
    installParallelUpdateDownload(updater, async (_url, init) => {
      const { start, end } = parseRequestRange(init)
      if (start === 0 && end === 0) return createProbeResponse(content.byteLength)
      requestedRanges.push(`${start}-${end}`)
      if (!resumePhase) {
        const half = Math.max(1, Math.floor((end - start + 1) / 2))
        return createInterruptedResponse(
          [content.slice(start, start + half)],
          start,
          end,
          content.byteLength
        )
      }
      return createRangeResponse(content, start, end, content.byteLength)
    })

    const url = new URL('https://example.com/SelectionTranslator-1.0.4-Setup-x64.exe')
    await assert.rejects(
      updater.httpExecutor.download(url, destination, {
        cancellationToken: new FakeCancellationToken(),
        sha512: contentHash
      })
    )

    resumePhase = true
    requestedRanges.length = 0
    await updater.httpExecutor.download(url, destination, {
      cancellationToken: new FakeCancellationToken(),
      sha512: contentHash
    })

    const resumeDirectory = join(directory, 'resume')
    assert.equal(Buffer.from(content).equals(await readFile(destination)), true)
    assert.deepEqual(
      await readdir(resumeDirectory).catch(() => []),
      [],
      '续传完成后应清理续传文件与进度记录'
    )
    assert.ok(
      requestedRanges.every((range) => !range.startsWith('0-')),
      `续传时不应从零重新下载，实际请求：${requestedRanges.join(', ')}`
    )
  } finally {
    await cleanup()
  }
})

test('续传记录与本次校验值不一致时应丢弃旧进度并重新下载', async () => {
  const { directory, destination, cleanup, updater } = await createDownloadTarget()
  const content = buildContent(16 * 1024 * 1024)
  const contentHash = createHash('sha512').update(content).digest('base64')
  let resumePhase = false
  const requestedRanges: string[] = []

  try {
    installParallelUpdateDownload(updater, async (_url, init) => {
      const { start, end } = parseRequestRange(init)
      if (start === 0 && end === 0) return createProbeResponse(content.byteLength)
      requestedRanges.push(`${start}-${end}`)
      if (!resumePhase) {
        return createInterruptedResponse(
          [content.slice(start, start + 1)],
          start,
          end,
          content.byteLength
        )
      }
      return createRangeResponse(content, start, end, content.byteLength)
    })

    const url = new URL('https://example.com/SelectionTranslator-1.0.4-Setup-x64.exe')
    await assert.rejects(
      updater.httpExecutor.download(url, destination, {
        cancellationToken: new FakeCancellationToken(),
        sha512: contentHash
      })
    )

    resumePhase = true
    requestedRanges.length = 0
    await updater.httpExecutor.download(url, destination, {
      cancellationToken: new FakeCancellationToken(),
      sha512: createHash('sha512').update('different content').digest('base64')
    }).catch(() => undefined)

    assert.ok(
      requestedRanges.some((range) => range.startsWith('0-')),
      `校验值变化后应从零重新下载，实际请求：${requestedRanges.join(', ')}`
    )
    assert.equal(
      (await readdir(join(directory, 'resume'))).some((entry) => entry.endsWith('.part.json')),
      false,
      '校验失败后不应保留不匹配的续传记录'
    )
  } finally {
    await cleanup()
  }
})

test('续传下载完成并通过校验后应清理临时文件与续传记录', async () => {
  const { directory, destination, cleanup, updater } = await createDownloadTarget()
  const content = buildContent(16 * 1024 * 1024)
  const contentHash = createHash('sha512').update(content).digest('base64')
  let resumePhase = false

  try {
    installParallelUpdateDownload(updater, async (_url, init) => {
      const { start, end } = parseRequestRange(init)
      if (start === 0 && end === 0) return createProbeResponse(content.byteLength)
      if (!resumePhase) {
        const half = Math.max(1, Math.floor((end - start + 1) / 2))
        return createInterruptedResponse(
          [content.slice(start, start + half)],
          start,
          end,
          content.byteLength
        )
      }
      return createRangeResponse(content, start, end, content.byteLength)
    })

    const url = new URL('https://example.com/SelectionTranslator-1.0.4-Setup-x64.exe')
    await assert.rejects(
      updater.httpExecutor.download(url, destination, {
        cancellationToken: new FakeCancellationToken(),
        sha512: contentHash
      })
    )
    resumePhase = true
    await updater.httpExecutor.download(url, destination, {
      cancellationToken: new FakeCancellationToken(),
      sha512: contentHash
    })

    const resumeEntries = await readdir(join(directory, 'resume')).catch(() => [])
    assert.deepEqual(resumeEntries, [], '下载完成后应清空续传目录')
  } finally {
    await cleanup()
  }
})
