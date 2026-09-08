import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeAppIdentifier,
  buildCaptureDiagnosticRecord,
  aggregateCaptureDiagnostics,
  pruneDiagnosticDays,
  appendDiagnosticRecord,
  getDiagnosticDaySummary,
  resolveDiagnosticLevel,
  resolveDiagnosticReason,
  type CaptureDiagnosticRecord,
  type DiagnosticDayBucket
} from '../src/shared/captureDiagnostics.ts'

/**
 * 校验前台应用标识被 trim 并转换为小写。
 * @returns 无返回值。
 * @author zhenghq
 */
test('normalizeAppIdentifier 应 trim 并转小写', () => {
  assert.equal(normalizeAppIdentifier('  Com.Apple.Safari  '), 'com.apple.safari')
  assert.equal(normalizeAppIdentifier('Code.EXE'), 'code')
  assert.equal(normalizeAppIdentifier('chrome'), 'chrome')
})

/**
 * 校验空值、undefined 与非字符串输入被规范化为 unknown。
 * @returns 无返回值。
 * @author zhenghq
 */
test('normalizeAppIdentifier 应对空值兜底为 unknown', () => {
  assert.equal(normalizeAppIdentifier(''), 'unknown')
  assert.equal(normalizeAppIdentifier('   '), 'unknown')
  assert.equal(normalizeAppIdentifier(undefined), 'unknown')
  assert.equal(normalizeAppIdentifier(null), 'unknown')
})

/**
 * 校验 Windows 进程名去除 .exe 后缀与路径分隔符。
 * @returns 无返回值。
 * @author zhenghq
 */
test('normalizeAppIdentifier 应去除 Windows 路径与 .exe 后缀', () => {
  assert.equal(normalizeAppIdentifier('C:\\Program Files\\App\\app.exe'), 'app')
  assert.equal(normalizeAppIdentifier('/usr/bin/Safari'), 'safari')
  assert.equal(normalizeAppIdentifier('chrome.exe'), 'chrome')
})

/**
 * 校验诊断记录字段白名单：仅允许指定字段，不允许出现文本内容。
 * @returns 无返回值。
 * @author zhenghq
 */
test('buildCaptureDiagnosticRecord 应仅包含白名单字段', () => {
  const record = buildCaptureDiagnosticRecord({
    at: 1_700_000_000_000,
    entry: 'button',
    platform: 'darwin',
    level: 'native-read',
    elapsedMs: 123,
    app: 'com.apple.Safari'
  })
  assert.deepEqual(Object.keys(record).sort(), [
    'app',
    'at',
    'elapsedMs',
    'entry',
    'level',
    'platform',
    'reason'
  ])
  assert.equal(record.app, 'com.apple.safari')
})

/**
 * 校验失败时记录包含 reason 字段。
 * @returns 无返回值。
 * @author zhenghq
 */
test('buildCaptureDiagnosticRecord 应在失败时包含 reason', () => {
  const record = buildCaptureDiagnosticRecord({
    at: 1_700_000_000_000,
    entry: 'hotkey',
    platform: 'win32',
    level: 'failed',
    reason: 'timeout',
    elapsedMs: 800,
    app: 'unknown'
  })
  assert.equal(record.reason, 'timeout')
  assert.equal(record.level, 'failed')
})

/**
 * 校验失败原因枚举值被限制在预定义集合内。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveDiagnosticReason 应接受合法原因并兜底 unknown', () => {
  assert.equal(resolveDiagnosticReason('empty'), 'empty')
  assert.equal(resolveDiagnosticReason('timeout'), 'timeout')
  assert.equal(resolveDiagnosticReason('unsupported'), 'unsupported')
  assert.equal(resolveDiagnosticReason('permission'), 'permission')
  assert.equal(resolveDiagnosticReason('unknown'), 'unknown')
  assert.equal(resolveDiagnosticReason('other'), undefined)
  assert.equal(resolveDiagnosticReason(undefined), undefined)
})

/**
 * 校验命中级别枚举值被限制在预定义集合内。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveDiagnosticLevel 应接受合法级别并兜底 failed', () => {
  assert.equal(resolveDiagnosticLevel('native-read'), 'native-read')
  assert.equal(resolveDiagnosticLevel('copy-polled'), 'copy-polled')
  assert.equal(resolveDiagnosticLevel('copy-late'), 'copy-late')
  assert.equal(resolveDiagnosticLevel('failed'), 'failed')
  assert.equal(resolveDiagnosticLevel('other'), 'failed')
})

/**
 * 校验跨天时最旧日期被清理，仅保留当天与前一天。
 * @returns 无返回值。
 * @author zhenghq
 */
test('pruneDiagnosticDays 应丢弃早于前一天的日期桶', () => {
  const days: Record<string, DiagnosticDayBucket> = {
    '2026-09-05': { records: [], summary: getDiagnosticDaySummary([]) },
    '2026-09-06': { records: [], summary: getDiagnosticDaySummary([]) },
    '2026-09-07': { records: [], summary: getDiagnosticDaySummary([]) }
  }
  const pruned = pruneDiagnosticDays(days, '2026-09-07')
  assert.deepEqual(Object.keys(pruned).sort(), ['2026-09-06', '2026-09-07'])
})

/**
 * 校验单日超过 2000 条时丢弃最早的原始记录，但聚合计数保留。
 * @returns 无返回值。
 * @author zhenghq
 */
test('appendDiagnosticRecord 应截断单日记录到 2000 条并保留聚合计数', () => {
  const records: CaptureDiagnosticRecord[] = []
  for (let i = 0; i < 2000; i += 1) {
    records.push(
      buildCaptureDiagnosticRecord({
        at: 1_700_000_000_000 + i,
        entry: 'button',
        platform: 'darwin',
        level: 'native-read',
        elapsedMs: 10,
        app: 'com.apple.Safari'
      })
    )
  }
  const day: DiagnosticDayBucket = {
    records: [...records],
    summary: getDiagnosticDaySummary(records)
  }
  const extra = buildCaptureDiagnosticRecord({
    at: 1_700_000_001_000,
    entry: 'hotkey',
    platform: 'darwin',
    level: 'failed',
    reason: 'timeout',
    elapsedMs: 800,
    app: 'unknown'
  })
  const next = appendDiagnosticRecord(day, extra)
  assert.equal(next.records.length, 2000)
  assert.equal(next.records[0]?.at, 1_700_000_000_001)
  assert.equal(next.summary.total, 2001)
  assert.equal(next.summary.byLevel['native-read'], 2000)
  assert.equal(next.summary.byLevel.failed, 1)
  assert.equal(next.summary.byReason.timeout, 1)
})

/**
 * 校验空记录列表的聚合摘要为空态。
 * @returns 无返回值。
 * @author zhenghq
 */
test('getDiagnosticDaySummary 应对空记录返回空态', () => {
  const summary = getDiagnosticDaySummary([])
  assert.equal(summary.total, 0)
  assert.deepEqual(summary.byEntry, {})
  assert.deepEqual(summary.byLevel, {})
  assert.deepEqual(summary.byReason, {})
  assert.deepEqual(summary.topApps, [])
})

/**
 * 校验入口 × 级别矩阵、失败原因分布与失败应用 Top 统计。
 * @returns 无返回值。
 * @author zhenghq
 */
test('aggregateCaptureDiagnostics 应生成跨天聚合摘要', () => {
  const records: CaptureDiagnosticRecord[] = [
    buildCaptureDiagnosticRecord({ at: 1, entry: 'button', platform: 'darwin', level: 'native-read', elapsedMs: 10, app: 'com.apple.Safari' }),
    buildCaptureDiagnosticRecord({ at: 2, entry: 'button', platform: 'darwin', level: 'failed', reason: 'timeout', elapsedMs: 800, app: 'com.apple.Safari' }),
    buildCaptureDiagnosticRecord({ at: 3, entry: 'hotkey', platform: 'win32', level: 'failed', reason: 'empty', elapsedMs: 500, app: 'code.exe' }),
    buildCaptureDiagnosticRecord({ at: 4, entry: 'auto', platform: 'linux', level: 'copy-late', elapsedMs: 200, app: 'firefox' })
  ]
  const summary = aggregateCaptureDiagnostics(records)
  assert.equal(summary.total, 4)
  assert.equal(summary.byEntry.button, 2)
  assert.equal(summary.byEntry.hotkey, 1)
  assert.equal(summary.byEntry.auto, 1)
  assert.equal(summary.byLevel['native-read'], 1)
  assert.equal(summary.byLevel.failed, 2)
  assert.equal(summary.byLevel['copy-late'], 1)
  assert.equal(summary.byReason.timeout, 1)
  assert.equal(summary.byReason.empty, 1)
  assert.deepEqual(summary.topApps, [
    { app: 'com.apple.safari', count: 1 },
    { app: 'code', count: 1 }
  ])
})
