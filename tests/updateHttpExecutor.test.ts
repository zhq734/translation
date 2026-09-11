import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
  destination: string
  cleanup: () => Promise<void>
  updater: FakeUpdater
}> {
  const directory = await mkdtemp(join(tmpdir(), 'selection-translator-parallel-update-'))
  const destination = join(directory, 'update.exe.part')
  await writeFile(destination, Buffer.alloc(0))
  const updater = {
    httpExecutor: {
      async download(_url: URL, target: string, _options: DownloadOptions): Promise<string> {
        await writeFile(target, Buffer.from('single-stream'))
        return target
      }
    }
  }
  return { destination, cleanup: async () => rm(directory, { recursive: true, force: true }), updater }
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

test('取消 electron-updater 下载令牌时应中断分片下载并清理目标文件', async () => {
  const { destination, cleanup, updater } = await createDownloadTarget()
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
  } finally {
    await cleanup()
  }
})
