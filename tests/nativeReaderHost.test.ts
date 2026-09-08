import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

/**
 * 惰性加载待实现的宿主模块，不存在时给出明确失败而非模块解析错误。
 * @returns 宿主模块导出。
 * @author zhenghq
 */
async function loadHost(): Promise<typeof import('../src/main/nativeReaderHost')> {
  const module = await import('../src/main/nativeReaderHost.ts')
  assert.ok(module, '缺少宿主模块: src/main/nativeReaderHost.ts')
  return module
}

/** 模拟 helper 子进程的最小接口。 */
interface FakeChild extends EventEmitter {
  stdin: { write: (line: string) => void }
  stdout: EventEmitter
  kill: () => void
  killed: boolean
  emittedExit: boolean
}

/**
 * 创建可脚本化的假子进程：收到请求行后按响应表应答。
 * @param respond 请求 id 到响应行为的映射；缺省不回包（用于模拟超时）。
 * @returns 假子进程。
 * @author zhenghq
 */
function createFakeChild(
  respond: Record<number, { status: string; text?: string } | 'hang'>
): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.killed = false
  child.emittedExit = false
  child.stdin = {
    write(line: string) {
      try {
        const request = JSON.parse(line) as { id: number }
        const behavior = respond[request.id]
        if (!behavior || behavior === 'hang') return
        child.stdout.emit(
          'data',
          Buffer.from(JSON.stringify({ id: request.id, ...behavior }) + '\n')
        )
      } catch {
        // 忽略非 JSON 行。
      }
    }
  }
  child.kill = () => {
    child.killed = true
    if (!child.emittedExit) {
      child.emittedExit = true
      child.emit('exit', 1)
    }
  }
  return child
}

/**
 * 把假子进程标记为在下一微任务崩溃，模拟真实进程“先 spawn 成功、随后退出”的时序。
 * @param child 假子进程。
 * @returns 同一假子进程。
 * @author zhenghq
 */
function deferExit(child: FakeChild): FakeChild {
  queueMicrotask(() => {
    if (!child.emittedExit) {
      child.emittedExit = true
      child.emit('exit', 1)
    }
  })
  return child
}

/**
 * 校验宿主惰性启动：首次调用才拉起 helper 进程。
 * @returns 无返回值。
 * @author zhenghq
 */
test('宿主应惰性启动 helper 进程', async () => {
  const { NativeReaderHost } = await loadHost()
  let spawns = 0
  const host = new NativeReaderHost({
    spawn: () => {
      spawns += 1
      return createFakeChild({ 1: { status: 'present', text: 'hi' } }) as never
    },
    requestTimeoutMs: 100
  })

  assert.equal(spawns, 0)
  const result = await host.readSelection()
  assert.deepEqual(result, { status: 'present', text: 'hi' })
  assert.equal(spawns, 1)
  host.dispose()
})

/**
 * 校验连续 3 次超时触发重启，重启成功后恢复响应。
 * @returns 无返回值。
 * @author zhenghq
 */
test('连续 3 次超时应重启 helper 并恢复服务', async () => {
  const { NativeReaderHost } = await loadHost()
  const generations: FakeChild[] = []
  const host = new NativeReaderHost({
    spawn: () => {
      // 第一代挂起不回包，重启后的第二代正常响应。
      const child = generations.length === 0
        ? createFakeChild({ 1: 'hang', 2: 'hang', 3: 'hang' })
        : createFakeChild({ 4: { status: 'present', text: 'recovered' } })
      generations.push(child)
      return child as never
    },
    requestTimeoutMs: 20,
    restartAfterTimeouts: 3
  })

  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(host.readSelection(), /timeout/i)
  }
  const recovered = await host.readSelection()
  assert.deepEqual(recovered, { status: 'present', text: 'recovered' })
  assert.equal(generations.length, 2, '超时达到阈值后应重启 helper')
  host.dispose()
})

/**
 * 校验重启失败后本次会话禁用 helper，后续调用直接返回不可用。
 * @returns 无返回值。
 * @author zhenghq
 */
test('重启失败应在会话内禁用 helper', async () => {
  const { NativeReaderHost } = await loadHost()
  let spawns = 0
  const host = new NativeReaderHost({
    spawn: () => {
      spawns += 1
      // 每次 spawn 都立即崩溃。
      return deferExit(createFakeChild({})) as never
    },
    requestTimeoutMs: 20,
    restartAfterTimeouts: 1
  })

  await assert.rejects(host.readSelection())
  const after = await host.readSelection()
  assert.equal(after.status, 'unknown')
  assert.equal(after.reason, 'helper-disabled')
  const spawnsBefore = spawns
  await host.readSelection()
  assert.equal(spawns, spawnsBefore, '会话禁用后不应再次拉起 helper')
  host.dispose()
})

/**
 * 校验空闲 5 分钟无请求时 helper 自动退出，下次请求惰性重启。
 * @returns 无返回值。
 * @author zhenghq
 */
test('空闲超时应退出 helper 并在下次请求时重启', async () => {
  const { NativeReaderHost } = await loadHost()
  const children: FakeChild[] = []
  let now = 0
  const host = new NativeReaderHost({
    spawn: () => {
      const child = createFakeChild({
        1: { status: 'present', text: 'a' },
        2: { status: 'present', text: 'b' }
      })
      children.push(child)
      return child as never
    },
    requestTimeoutMs: 100,
    idleTimeoutMs: 300,
    now: () => now
  })

  await host.readSelection()
  assert.equal(children.length, 1)

  now += 1000 // 超过空闲阈值
  const second = await host.readSelection()
  assert.deepEqual(second, { status: 'present', text: 'b' })
  assert.equal(children[0].killed, true, '空闲超时后旧进程应已退出')
  assert.equal(children.length, 2, '空闲后应惰性重启新进程')
  host.dispose()
})
