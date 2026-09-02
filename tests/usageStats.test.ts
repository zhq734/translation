import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageStatsStore } from '../src/main/usageStats.ts'

/**
 * 创建基于临时目录的统计存储实例。
 * @param dateProvider 可选的当天日期提供者，便于测试跨天滚动。
 * @returns 存储实例、文件路径与清理函数。
 * @author zhenghq
 */
function createStore(dateProvider?: () => string): { store: UsageStatsStore; file: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'usage-stats-test-'))
  const file = join(directory, 'usage-stats.json')
  return {
    store: new UsageStatsStore({ filePath: file, today: dateProvider }),
    file,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  }
}

test('记录使用应按渠道与服务提供方双维计数并持久化', () => {
  const { store, file, cleanup } = createStore(() => '2026-08-31')
  try {
    store.recordUsage('selection', 'dingtalk')
    store.recordUsage('selection', 'dingtalk')
    store.recordUsage('hotkey', 'ai')

    const snapshot = store.snapshot()
    assert.equal(snapshot.days['2026-08-31']?.channels.selection, 2)
    assert.equal(snapshot.days['2026-08-31']?.channels.hotkey, 1)
    assert.equal(snapshot.days['2026-08-31']?.providers.dingtalk, 2)
    assert.equal(snapshot.days['2026-08-31']?.providers.ai, 1)

    const persisted = JSON.parse(readFileSync(file, 'utf-8'))
    assert.equal(persisted.days['2026-08-31'].channels.selection, 2)
  } finally {
    cleanup()
  }
})

test('两天滚动：记录时应丢弃早于前一天的日期桶', () => {
  let today = '2026-08-31'
  const { store, cleanup } = createStore(() => today)
  try {
    store.recordUsage('webpage', 'microsoft')
    today = '2026-09-01'
    store.recordUsage('screenshot', 'google')
    today = '2026-09-02'
    store.recordUsage('hotkey', 'ai')

    const snapshot = store.snapshot()
    assert.deepEqual(Object.keys(snapshot.days).sort(), ['2026-09-01', '2026-09-02'])
    assert.equal(snapshot.days['2026-09-01']?.channels.screenshot, 1)
    assert.equal(snapshot.days['2026-09-02']?.channels.hotkey, 1)
  } finally {
    cleanup()
  }
})

test('统计文件损坏时应静默重建为空结构', () => {
  const { store, file, cleanup } = createStore(() => '2026-08-31')
  try {
    writeFileSync(file, '{ 非法 JSON', 'utf-8')
    const storeAfterCorruption = new UsageStatsStore({ filePath: file, today: () => '2026-08-31' })
    assert.deepEqual(storeAfterCorruption.snapshot().days, {})
    storeAfterCorruption.recordUsage('selection', 'microsoft')
    assert.equal(storeAfterCorruption.snapshot().days['2026-08-31']?.channels.selection, 1)
    assert.equal(store.snapshot().days['2026-08-31'], undefined)
  } finally {
    cleanup()
  }
})

test('防重发标记：lastSentDate 等于当天则不应再次上报', () => {
  const { store, file, cleanup } = createStore(() => '2026-08-31')
  try {
    assert.equal(store.shouldReportToday(), true)
    store.markReportSent('2026-08-31')
    assert.equal(store.shouldReportToday(), false)
    const persisted = JSON.parse(readFileSync(file, 'utf-8'))
    assert.equal(persisted.report.lastSentDate, '2026-08-31')
  } finally {
    cleanup()
  }
})
