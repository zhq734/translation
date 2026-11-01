import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  createMacosLongCaptureCapture,
  resolveMacosLongCaptureHelperPath,
  type MacosLongCaptureChildProcess
} from '../src/main/macosLongCaptureCapture'

/**
 * 构造可手动控制 stdout 与生命周期的 helper 子进程替身。
 * @author zhenghq
 */
class FakeMacosLongCaptureHelper implements MacosLongCaptureChildProcess {
  /** helper 收到的原始 stdin 命令。 */
  readonly requests: string[] = []
  /** 模拟 stdout 数据流。 */
  readonly stdout = new EventEmitter()
  /** 模拟进程生命周期事件。 */
  readonly events = new EventEmitter()
  /** 是否已被客户端终止。 */
  killed = false
  /** 每次写入 stdin 时调用，便于测试按请求回包。 */
  onWrite: ((command: string, helper: FakeMacosLongCaptureHelper) => void) | null = null
  /** 模拟 stdin。 */
  readonly stdin = {
    write: (chunk: Buffer | string): boolean => {
      const command = String(chunk)
      this.requests.push(command)
      this.onWrite?.(command, this)
      return true
    }
  }

  /**
   * 发送一段 stdout 数据。
   * @param data 数据块。
   * @returns 无返回值。
   * @author zhenghq
   */
  emitStdout(data: Buffer | string): void {
    this.stdout.emit('data', Buffer.isBuffer(data) ? data : Buffer.from(data))
  }

  /**
   * 按协议发送成功响应。
   * @param payload PNG 字节。
   * @returns 无返回值。
   * @author zhenghq
   */
  respondOk(payload: Buffer): void {
    this.emitStdout(Buffer.concat([Buffer.from(`ok ${payload.length}\n`), payload]))
  }

  /**
   * 按协议发送错误响应。
   * @param message 错误文本。
   * @returns 无返回值。
   * @author zhenghq
   */
  respondError(message: string): void {
    const payload = Buffer.from(message)
    this.emitStdout(Buffer.concat([Buffer.from(`err ${payload.length}\n`), payload]))
  }

  /**
   * 终止模拟 helper。
   * @returns 无返回值。
   * @author zhenghq
   */
  kill(): void {
    this.killed = true
  }

  /**
   * 注册进程事件。
   * @param event 事件名。
   * @param listener 监听器。
   * @returns 无返回值。
   * @author zhenghq
   */
  on(event: 'error' | 'exit', listener: (...args: unknown[]) => void): void {
    this.events.on(event, listener)
  }
}

/**
 * 等待指定条件成立，避免依赖固定延时。
 * @param predicate 条件。
 * @returns 条件成立后的 Promise。
 * @author zhenghq
 */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('等待测试条件超时')
}

test('macOS 长截图 helper 路径应优先打包目录并回退开发 build 目录', () => {
  const packaged = resolveMacosLongCaptureHelperPath({
    resourcesPath: '/Applications/App.app/Contents/Resources',
    cwd: '/repo',
    fileExists: (candidate) => candidate === '/Applications/App.app/Contents/Resources/macos-long-capture'
  })
  assert.equal(packaged, '/Applications/App.app/Contents/Resources/macos-long-capture')

  const development = resolveMacosLongCaptureHelperPath({
    resourcesPath: '/missing',
    cwd: '/repo',
    fileExists: (candidate) => candidate === '/repo/build/macos-long-capture'
  })
  assert.equal(development, '/repo/build/macos-long-capture')
})

test('helper 不存在时抓帧应明确拒绝', async () => {
  const client = createMacosLongCaptureCapture({
    resourcesPath: '/missing',
    cwd: '/missing',
    fileExists: () => false
  })
  await assert.rejects(client.capture({ x: 0, y: 0, width: 20, height: 20 }), /helper not found/u)
  client.dispose()
})

test('stdout 头部与 PNG 被拆成多个 chunk 时仍应完整解析', async () => {
  const helper = new FakeMacosLongCaptureHelper()
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
  const client = createMacosLongCaptureCapture({
    helperPath: '/tmp/macos-long-capture',
    spawn: () => helper
  })

  const pending = client.capture({ x: 10, y: 20, width: 30, height: 40 })
  await waitFor(() => helper.requests.length === 1)
  assert.equal(helper.requests[0], 'capture 10 20 30 40\n')

  helper.emitStdout(Buffer.from('ok '))
  helper.emitStdout(Buffer.from('8\n'))
  helper.emitStdout(png.subarray(0, 3))
  helper.emitStdout(png.subarray(3))
  assert.deepEqual(await pending, png)
  client.dispose()
})

test('helper 的 err 响应应拒绝请求而不是返回错误文本图片', async () => {
  const helper = new FakeMacosLongCaptureHelper()
  const client = createMacosLongCaptureCapture({
    helperPath: '/tmp/macos-long-capture',
    spawn: () => helper
  })

  const pending = client.capture({ x: 0, y: 0, width: 20, height: 20 })
  await waitFor(() => helper.requests.length === 1)
  helper.respondError('screen capture failed')
  await assert.rejects(pending, /screen capture failed/u)
  client.dispose()
})

test('连续抓帧请求应严格串行执行', async () => {
  const helper = new FakeMacosLongCaptureHelper()
  const client = createMacosLongCaptureCapture({
    helperPath: '/tmp/macos-long-capture',
    spawn: () => helper
  })

  const first = client.capture({ x: 0, y: 0, width: 10, height: 10 })
  const second = client.capture({ x: 0, y: 0, width: 10, height: 10 })
  await waitFor(() => helper.requests.length === 1)
  assert.equal(helper.requests.length, 1)

  helper.respondOk(Buffer.from([1, 2, 3]))
  assert.deepEqual(await first, Buffer.from([1, 2, 3]))
  await waitFor(() => helper.requests.length === 2)
  helper.respondOk(Buffer.from([4, 5, 6]))
  assert.deepEqual(await second, Buffer.from([4, 5, 6]))
  client.dispose()
})

test('请求超时后应终止 helper，并允许下一次请求重新拉起', async () => {
  const helpers: FakeMacosLongCaptureHelper[] = []
  const client = createMacosLongCaptureCapture({
    helperPath: '/tmp/macos-long-capture',
    requestTimeoutMs: 10,
    spawn: () => {
      const helper = new FakeMacosLongCaptureHelper()
      helpers.push(helper)
      return helper
    }
  })

  await assert.rejects(
    client.capture({ x: 0, y: 0, width: 10, height: 10 }),
    /request timeout/u
  )
  assert.equal(helpers.length, 1)
  assert.equal(helpers[0].killed, true)

  const retry = client.capture({ x: 0, y: 0, width: 10, height: 10 })
  await waitFor(() => helpers.length === 2 && helpers[1].requests.length === 1)
  helpers[1].respondOk(Buffer.from([7]))
  assert.deepEqual(await retry, Buffer.from([7]))
  client.dispose()
})

test('dispose 应终止 helper 并拒绝待定请求', async () => {
  const helper = new FakeMacosLongCaptureHelper()
  const client = createMacosLongCaptureCapture({
    helperPath: '/tmp/macos-long-capture',
    spawn: () => helper
  })

  const pending = client.capture({ x: 0, y: 0, width: 10, height: 10 })
  await waitFor(() => helper.requests.length === 1)
  client.dispose()
  await assert.rejects(pending, /disposed/u)
  assert.equal(helper.killed, true)
})
