import assert from 'node:assert/strict'
import test from 'node:test'
import { createUpdateProgressReporter } from '../src/main/updateDownloadProgress.ts'
import type { UpdateProgress } from '../src/shared/types.ts'

/**
 * 创建可手动推进的测试时钟。
 * @param startedAt 初始时间戳。
 * @returns 读取当前时间和推进时间的方法。
 * @author zhenghq
 */
function createClock(startedAt = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = startedAt
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    }
  }
}

test('进度聚合器应按最小间隔合并高频数据块上报', () => {
  const clock = createClock()
  const reported: UpdateProgress[] = []
  const reporter = createUpdateProgressReporter({
    total: 1000,
    now: clock.now,
    minimumIntervalMs: 250,
    onProgress: (progress) => reported.push(progress)
  })

  reporter.start()
  assert.equal(reported.length, 1)
  assert.equal(reported[0].percent, 0)
  assert.equal(reported[0].transferred, 0)

  for (let index = 0; index < 10; index += 1) {
    clock.advance(20)
    reporter.add(10)
  }
  assert.equal(reported.length, 1, '间隔内的数据块不应逐块上报')

  clock.advance(60)
  reporter.add(10)
  assert.equal(reported.length, 2)
  assert.equal(reported[1].transferred, 110)
})

test('进度聚合器结束时必须强制上报最终进度', () => {
  const clock = createClock()
  const reported: UpdateProgress[] = []
  const reporter = createUpdateProgressReporter({
    total: 400,
    now: clock.now,
    minimumIntervalMs: 250,
    onProgress: (progress) => reported.push(progress)
  })

  reporter.start()
  clock.advance(10)
  reporter.add(400)
  assert.equal(reported.length, 1, '节流窗口内不应额外上报')

  reporter.finish()
  const last = reported[reported.length - 1]
  assert.equal(last.transferred, 400)
  assert.equal(last.total, 400)
  assert.equal(last.percent, 100)
})

test('进度聚合器应使用采样窗口计算瞬时速度而不是累计均值', () => {
  const clock = createClock()
  const reported: UpdateProgress[] = []
  const reporter = createUpdateProgressReporter({
    total: 20_000_000,
    now: clock.now,
    minimumIntervalMs: 250,
    sampleWindowMs: 3000,
    onProgress: (progress) => reported.push(progress)
  })

  reporter.start()
  // 前 5 秒以 2MB/s 高速下载。
  for (let index = 0; index < 20; index += 1) {
    clock.advance(250)
    reporter.add(500_000)
  }
  const fast = reported[reported.length - 1]
  assert.ok(fast.bytesPerSecond > 1_800_000, `高速阶段速度应接近 2MB/s，实际 ${fast.bytesPerSecond}`)

  // 之后 5 秒降速到 100KB/s。
  for (let index = 0; index < 20; index += 1) {
    clock.advance(250)
    reporter.add(25_000)
  }
  const slow = reported[reported.length - 1]
  const cumulativeAverage = slow.transferred / 10
  assert.ok(slow.bytesPerSecond < 200_000, `降速后应反映近期速度，实际 ${slow.bytesPerSecond}`)
  assert.ok(
    slow.bytesPerSecond < cumulativeAverage / 2,
    `瞬时速度不应等于累计均值 ${cumulativeAverage}`
  )
})

test('进度聚合器应支持延迟获知总长度并保持百分比单调不减', () => {
  const clock = createClock()
  const reported: UpdateProgress[] = []
  const reporter = createUpdateProgressReporter({
    total: 0,
    now: clock.now,
    minimumIntervalMs: 250,
    onProgress: (progress) => reported.push(progress)
  })

  reporter.start()
  reporter.setTotal(1000)
  clock.advance(300)
  reporter.add(400)
  clock.advance(300)
  reporter.add(300)
  reporter.finish()

  const percents = reported.map((progress) => progress.percent)
  for (let index = 1; index < percents.length; index += 1) {
    assert.ok(percents[index] >= percents[index - 1], `百分比不应回退：${percents.join(',')}`)
  }
  assert.equal(reporter.getTransferred(), 700)
  assert.equal(reported[reported.length - 1].total, 1000)
})

test('进度聚合器应支持从续传起点计入已完成字节', () => {
  const clock = createClock()
  const reported: UpdateProgress[] = []
  const reporter = createUpdateProgressReporter({
    total: 1000,
    now: clock.now,
    minimumIntervalMs: 250,
    onProgress: (progress) => reported.push(progress)
  })

  reporter.start(600)
  assert.equal(reported[0].transferred, 600)
  assert.equal(reported[0].percent, 60)

  clock.advance(300)
  reporter.add(400)
  reporter.finish()
  assert.equal(reporter.getTransferred(), 1000)
  assert.equal(reported[reported.length - 1].percent, 100)
})
