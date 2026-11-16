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

/**
 * 模拟真实 kill 的异步退出：退出事件由测试稍后派发。
 * @param child 待延迟退出的假进程。
 * @returns 同一假进程。
 * @author zhenghq
 */
function delayKillExit(child: FakeChild): FakeChild {
  child.kill = () => { child.killed = true }
  return child
}

/**
 * 校验旧进程迟到的退出、错误和响应不会污染新进程请求。
 * @returns 无返回值。
 * @author zhenghq
 */
test('空闲回收后旧进程迟到事件不得拒绝或解析新进程请求', async () => {
  const { NativeReaderHost } = await loadHost()
  const old = delayKillExit(createFakeChild({ 1: { status: 'present', text: 'old' } }))
  const fresh = createFakeChild({})
  let now = 0
  let spawns = 0
  const host = new NativeReaderHost({
    spawn: () => (spawns++ === 0 ? old : fresh) as never,
    now: () => now, idleTimeoutMs: 100, requestTimeoutMs: 200
  })
  await host.readSelection()
  now = 1000
  const pending = host.readSelection()
  await Promise.resolve()
  old.emit('exit', 0)
  old.emit('error', new Error('late error'))
  old.stdout.emit('data', Buffer.from('{"id":2,"status":"present","text":"stale"}\n'))
  fresh.stdout.emit('data', Buffer.from('{"id":2,"status":"present","text":"fresh"}\n'))
  assert.deepEqual(await pending, { status: 'present', text: 'fresh' })
  host.dispose()
})

/**
 * 校验回收时丢弃旧进程残留半行，避免新响应被拼成无效 JSON。
 * @returns 无返回值。
 * @author zhenghq
 */
test('helper 换代必须清除旧 stdout 半行', async () => {
  const { NativeReaderHost } = await loadHost()
  const old = createFakeChild({ 1: { status: 'present', text: 'old' } })
  const fresh = createFakeChild({ 2: { status: 'present', text: 'new' } })
  let now = 0
  let spawns = 0
  const host = new NativeReaderHost({
    spawn: () => (spawns++ === 0 ? old : fresh) as never,
    now: () => now, idleTimeoutMs: 100, requestTimeoutMs: 30
  })
  await host.readSelection()
  old.stdout.emit('data', Buffer.from('{"id":999'))
  now = 1000
  assert.deepEqual(await host.readSelection(), { status: 'present', text: 'new' })
  host.dispose()
})

/**
 * 校验 UTF-8 多字节文本跨数据块输出时不会损坏中文选区。
 * @returns 无返回值。
 * @author zhenghq
 */
test('helper stdout 应正确拼接跨数据块的中文字符', async () => {
  const { NativeReaderHost } = await loadHost()
  const child = createFakeChild({})
  const host = new NativeReaderHost({ spawn: () => child as never, requestTimeoutMs: 100 })
  const pending = host.readSelection()
  await Promise.resolve()
  const line = Buffer.from('{"id":1,"status":"present","text":"中文"}\n')
  const split = line.indexOf(Buffer.from('中')) + 1
  child.stdout.emit('data', line.subarray(0, split))
  child.stdout.emit('data', line.subarray(split))
  assert.deepEqual(await pending, { status: 'present', text: '中文' })
  host.dispose()
})

/**
 * 校验点击按钮中止后台预取后立即回收阻塞进程，后续请求不等待旧 UIA。
 * @returns 无返回值。
 * @author zhenghq
 */
test('取消预取必须立即结束等待并回收阻塞 helper', async () => {
  const { NativeReaderHost } = await loadHost()
  const old = delayKillExit(createFakeChild({}))
  const fresh = createFakeChild({ 2: { status: 'present', text: 'button' } })
  let spawns = 0
  const host = new NativeReaderHost({
    spawn: () => (spawns++ === 0 ? old : fresh) as never, requestTimeoutMs: 100
  })
  const controller = new AbortController()
  const pending = host.readSelection(controller.signal)
  const rejected = assert.rejects(pending, /abort/iu)
  await Promise.resolve()
  controller.abort()
  await rejected
  assert.equal(old.killed, true)
  assert.deepEqual(await host.readSelection(), { status: 'present', text: 'button' })
  host.dispose()
})

/**
 * 校验已经取消的请求不启动进程、不发送取词命令。
 * @returns 无返回值。
 * @author zhenghq
 */
test('已取消的取词不得启动 helper', async () => {
  const { NativeReaderHost } = await loadHost()
  let spawns = 0
  const host = new NativeReaderHost({ spawn: () => { spawns++; return createFakeChild({}) as never } })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(host.readSelection(controller.signal), /abort/iu)
  assert.equal(spawns, 0)
  host.dispose()
})

/**
 * 校验 300ms 等短预算实际传入宿主，首次超时即隔离阻塞进程。
 * @returns 无返回值。
 * @author zhenghq
 */
test('请求短超时必须生效且首次超时就回收 helper', async () => {
  const { NativeReaderHost } = await loadHost()
  const old = createFakeChild({})
  const fresh = createFakeChild({ 2: { status: 'present', text: 'recovered' } })
  let spawns = 0
  const host = new NativeReaderHost({
    spawn: () => (spawns++ === 0 ? old : fresh) as never, requestTimeoutMs: 500
  })
  const pending = host.readSelection(undefined, 15)
  const state = await Promise.race([
    pending.then(() => 'response', () => 'timeout'),
    new Promise<string>((resolve) => setTimeout(() => resolve('still-waiting'), 100))
  ])
  try {
    assert.equal(state, 'timeout', '短预算不能退回默认 1500ms 等待')
    assert.equal(old.killed, true)
    assert.deepEqual(await host.readSelection(), { status: 'present', text: 'recovered' })
  } finally { host.dispose() }
})

/**
 * 校验旧进程主动回收不会留下全局抑制标记，使新进程崩溃后请求悬挂。
 * @returns 无返回值。
 * @author zhenghq
 */
test('新 helper 异步 error 必须立即拒绝待定请求', async () => {
  const { NativeReaderHost } = await loadHost()
  const child = createFakeChild({})
  const host = new NativeReaderHost({ spawn: () => child as never, requestTimeoutMs: 100 })
  const pending = host.readSelection()
  const rejected = assert.rejects(pending, /spawn failure/iu)
  await Promise.resolve()
  child.emit('error', new Error('spawn failure'))
  await rejected
  host.dispose()
})

/**
 * 校验惰性启动与异步继续之间崩溃时不登记永远收不到响应的新请求。
 * @returns 无返回值。
 * @author zhenghq
 */
test('helper 启动后微任务崩溃必须立即结束而非等待请求超时', async () => {
  const { NativeReaderHost } = await loadHost()
  const host = new NativeReaderHost({
    spawn: () => deferExit(createFakeChild({})) as never, requestTimeoutMs: 500
  })
  const pending = host.readSelection()
  const state = await Promise.race([
    pending.then(() => 'response', () => 'failed'),
    new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 100))
  ])
  try { assert.equal(state, 'failed') } finally { host.dispose() }
})

/**
 * 校验释放发生在惰性启动 await 空窗时不再向已经结束的进程写请求。
 * @returns 无返回值。
 * @author zhenghq
 */
test('惰性启动空窗内释放宿主不得向旧 stdin 写请求', async () => {
  const { NativeReaderHost } = await loadHost()
  const child = createFakeChild({})
  let writes = 0
  child.stdin.write = () => { writes++ }
  const host = new NativeReaderHost({ spawn: () => child as never, requestTimeoutMs: 20 })
  const pending = host.readSelection()
  const rejected = assert.rejects(pending)
  host.dispose()
  await rejected
  assert.equal(writes, 0)
})
