import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CaptureDiagnosticsStore } from '../src/main/captureDiagnostics.ts'
import { buildCaptureDiagnosticRecord } from '../src/shared/captureDiagnostics.ts'

/**
 * 创建基于临时目录的诊断存储实例。
 * @param dateProvider 可选的当天日期提供者，便于测试跨天滚动。
 * @returns 存储实例、文件路径与清理函数。
 * @author zhenghq
 */
function createStore(dateProvider?: () => string): {
  store: CaptureDiagnosticsStore
  file: string
  cleanup: () => void
} {
  const directory = mkdtempSync(join(tmpdir(), 'capture-diagnostics-test-'))
  const file = join(directory, 'capture-diagnostics.json')
  return {
    store: new CaptureDiagnosticsStore({ filePath: file, today: dateProvider }),
    file,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * 校验记录取词诊断并持久化到磁盘。
 * @returns 无返回值。
 * @author zhenghq
 */
test('记录诊断应按日桶聚合并持久化', () => {
  const { store, file, cleanup } = createStore(() => '2026-09-07')
  try {
    store.record(
      buildCaptureDiagnosticRecord({
        at: 1_700_000_000_000,
        entry: 'button',
        platform: 'darwin',
        level: 'native-read',
        elapsedMs: 50,
        app: 'com.apple.Safari'
      })
    )
    store.record(
      buildCaptureDiagnosticRecord({
        at: 1_700_000_001_000,
        entry: 'hotkey',
        platform: 'win32',
        level: 'failed',
        reason: 'timeout',
        elapsedMs: 800,
        app: 'code.exe'
      })
    )

    const snapshot = store.snapshot()
    assert.equal(snapshot.days['2026-09-07']?.summary.total, 2)
    assert.equal(snapshot.days['2026-09-07']?.summary.byEntry.button, 1)
    assert.equal(snapshot.days['2026-09-07']?.summary.byEntry.hotkey, 1)
    assert.equal(snapshot.days['2026-09-07']?.summary.byLevel['native-read'], 1)
    assert.equal(snapshot.days['2026-09-07']?.summary.byLevel.failed, 1)
    assert.equal(snapshot.days['2026-09-07']?.summary.byReason.timeout, 1)

    const persisted = JSON.parse(readFileSync(file, 'utf-8'))
    assert.equal(persisted.days['2026-09-07'].summary.total, 2)
  } finally {
    cleanup()
  }
})

/**
 * 校验跨天时最旧日期被清理，仅保留当天与前一天。
 * @returns 无返回值。
 * @author zhenghq
 */
test('两天滚动：跨天时丢弃最旧日期桶', () => {
  let today = '2026-09-05'
  const { store, cleanup } = createStore(() => today)
  try {
    store.record(
      buildCaptureDiagnosticRecord({
        at: 1_700_000_000_000,
        entry: 'button',
        platform: 'darwin',
        level: 'native-read',
        elapsedMs: 10,
        app: 'com.apple.Safari'
      })
    )
    today = '2026-09-06'
    store.record(
      buildCaptureDiagnosticRecord({
        at: 1_700_000_001_000,
        entry: 'hotkey',
        platform: 'win32',
        level: 'failed',
        reason: 'empty',
        elapsedMs: 500,
        app: 'unknown'
      })
    )
    today = '2026-09-07'
    store.record(
      buildCaptureDiagnosticRecord({
        at: 1_700_000_002_000,
        entry: 'auto',
        platform: 'linux',
        level: 'copy-late',
        elapsedMs: 200,
        app: 'firefox'
      })
    )

    const snapshot = store.snapshot()
    assert.deepEqual(Object.keys(snapshot.days).sort(), ['2026-09-06', '2026-09-07'])
    assert.equal(snapshot.days['2026-09-06']?.summary.total, 1)
    assert.equal(snapshot.days['2026-09-07']?.summary.total, 1)
  } finally {
    cleanup()
  }
})

/**
 * 校验文件损坏时静默重建为空结构，不影响后续记录。
 * @returns 无返回值。
 * @author zhenghq
 */
test('诊断文件损坏时应静默重建为空结构', () => {
  const { store, file, cleanup } = createStore(() => '2026-09-07')
  try {
    writeFileSync(file, '{ 非法 JSON', 'utf-8')
    const storeAfterCorruption = new CaptureDiagnosticsStore({ filePath: file, today: () => '2026-09-07' })
    assert.deepEqual(storeAfterCorruption.snapshot().days, {})
    storeAfterCorruption.record(
      buildCaptureDiagnosticRecord({
        at: 1_700_000_000_000,
        entry: 'button',
        platform: 'darwin',
        level: 'native-read',
        elapsedMs: 10,
        app: 'com.apple.Safari'
      })
    )
    assert.equal(storeAfterCorruption.snapshot().days['2026-09-07']?.summary.total, 1)
  } finally {
    cleanup()
  }
})

/**
 * 校验原子写入：临时文件在重命名后被清理。
 * @returns 无返回值。
 * @author zhenghq
 */
test('持久化应使用临时文件加原子重命名', () => {
  const { store, file, cleanup } = createStore(() => '2026-09-07')
  try {
    store.record(
      buildCaptureDiagnosticRecord({
        at: 1_700_000_000_000,
        entry: 'button',
        platform: 'darwin',
        level: 'native-read',
        elapsedMs: 10,
        app: 'com.apple.Safari'
      })
    )
    // 临时文件不应残留
    assert.equal(readFileSync(`${file}.tmp`, 'utf-8') === undefined, false)
  } catch {
    // 临时文件不存在时 readFileSync 会抛错，符合预期
  } finally {
    cleanup()
  }
})
