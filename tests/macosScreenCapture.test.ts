import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  createMacosScreenCaptureClient,
  resolveMacosScreenCaptureHelperPath,
  type MacosScreenCaptureChildProcess
} from '../src/main/macosScreenCapture.ts'

/**
 * 构造可手动控制 stdout 与生命周期的 helper 子进程替身。
 * @author zhenghq
 */
class FakeMacosScreenCaptureHelper implements MacosScreenCaptureChildProcess {
  /** helper 收到的原始 stdin 命令。 */
  readonly requests: string[] = []
  /** 模拟 stdout 数据流。 */
  readonly stdout = new EventEmitter()
  /** 模拟进程生命周期事件。 */
  readonly events = new EventEmitter()
  /** 是否已被客户端终止。 */
  killed = false
  /** 模拟 stdin。 */
  readonly stdin = {
    write: (chunk: Buffer | string): boolean => {
      this.requests.push(chunk.toString())
      return true
    }
  }

  /**
   * 向 stdout 发送数据。
   * @param chunk 数据块。
   * @returns 无返回值。
   * @author zhenghq
   */
  emitStdout(chunk: Buffer): void {
    this.stdout.emit('data', chunk)
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

  /**
   * 终止 helper。
   * @returns 无返回值。
   * @author zhenghq
   */
  kill(): void {
    this.killed = true
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

test('macOS ScreenCaptureKit helper 路径应优先打包目录并回退开发 build 目录', () => {
  const packaged = resolveMacosScreenCaptureHelperPath({
    resourcesPath: '/Applications/App.app/Contents/Resources',
    cwd: '/repo',
    fileExists: (candidate) => candidate === '/Applications/App.app/Contents/Resources/macos-screen-capture'
  })
  assert.equal(packaged, '/Applications/App.app/Contents/Resources/macos-screen-capture')

  const development = resolveMacosScreenCaptureHelperPath({
    resourcesPath: '/missing',
    cwd: '/repo',
    fileExists: (candidate) => candidate === '/repo/build/macos-screen-capture'
  })
  assert.equal(development, '/repo/build/macos-screen-capture')
})

test('helper 不存在时抓帧应明确拒绝', async () => {
  const client = createMacosScreenCaptureClient({
    resourcesPath: '/missing',
    cwd: '/missing',
    fileExists: () => false
  })
  await assert.rejects(client.capture({ x: 0, y: 0, width: 20, height: 20 }), /helper not found/u)
  client.dispose()
})

test('stdout 头部与 PNG 被拆成多个 chunk 时仍应完整解析', async () => {
  const helper = new FakeMacosScreenCaptureHelper()
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
  const client = createMacosScreenCaptureClient({
    helperPath: '/tmp/macos-screen-capture',
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
  const helper = new FakeMacosScreenCaptureHelper()
  const client = createMacosScreenCaptureClient({
    helperPath: '/tmp/macos-screen-capture',
    spawn: () => helper
  })

  const pending = client.capture({ x: 0, y: 0, width: 20, height: 20 })
  await waitFor(() => helper.requests.length === 1)
  const message = Buffer.from('screen capture failed')
  helper.emitStdout(Buffer.from(`err ${message.length}\n`))
  helper.emitStdout(message)
  await assert.rejects(pending, /screen capture failed/u)
  client.dispose()
})

test('连续抓帧请求应严格串行执行', async () => {
  const helper = new FakeMacosScreenCaptureHelper()
  const client = createMacosScreenCaptureClient({
    helperPath: '/tmp/macos-screen-capture',
    spawn: () => helper
  })

  const first = client.capture({ x: 0, y: 0, width: 10, height: 10 })
  const second = client.capture({ x: 0, y: 0, width: 10, height: 10 })
  await waitFor(() => helper.requests.length === 1)
  assert.equal(helper.requests.length, 1)

  helper.emitStdout(Buffer.from('ok 3\n'))
  helper.emitStdout(Buffer.from([1, 2, 3]))
  assert.deepEqual(await first, Buffer.from([1, 2, 3]))
  await waitFor(() => helper.requests.length === 2)
  helper.emitStdout(Buffer.from('ok 3\n'))
  helper.emitStdout(Buffer.from([4, 5, 6]))
  assert.deepEqual(await second, Buffer.from([4, 5, 6]))
  client.dispose()
})

test('请求超时后应终止 helper，并允许下一次请求重新拉起', async () => {
  const helpers: FakeMacosScreenCaptureHelper[] = []
  const client = createMacosScreenCaptureClient({
    helperPath: '/tmp/macos-screen-capture',
    requestTimeoutMs: 10,
    spawn: () => {
      const helper = new FakeMacosScreenCaptureHelper()
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
  helpers[1].emitStdout(Buffer.from('ok 1\n'))
  helpers[1].emitStdout(Buffer.from([7]))
  assert.deepEqual(await retry, Buffer.from([7]))
  client.dispose()
})

test('dispose 应终止 helper 并拒绝待定请求', async () => {
  const helper = new FakeMacosScreenCaptureHelper()
  const client = createMacosScreenCaptureClient({
    helperPath: '/tmp/macos-screen-capture',
    spawn: () => helper
  })

  const pending = client.capture({ x: 0, y: 0, width: 10, height: 10 })
  await waitFor(() => helper.requests.length === 1)
  client.dispose()
  await assert.rejects(pending, /disposed/u)
  assert.equal(helper.killed, true)
})
