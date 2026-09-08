import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { SelectionCaptureCoordinator } from '../src/shared/selectionCaptureCoordinator.ts'
import type {
  CaptureDiagnosticEntry,
  CaptureDiagnosticLevel
} from '../src/shared/captureDiagnostics.ts'

/**
 * 校验协调器在直读命中时生成 native-read 级别诊断。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('直读命中应生成 native-read 诊断记录', async () => {
  const records: { entry?: CaptureDiagnosticEntry; level: CaptureDiagnosticLevel }[] = []
  const coordinator = new SelectionCaptureCoordinator(
    async () => ({ text: '直读文字', diagnostics: { level: 'native-read' } }),
    undefined,
    undefined,
    { onDiagnostic: (record) => { records.push(record) } }
  )

  const result = await coordinator.capture()
  assert.equal(result?.text, '直读文字')
  assert.equal(records.length, 1)
  assert.equal(records[0]?.level, 'native-read')
})

/**
 * 校验复制轮询命中生成 copy-polled 级别诊断。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('复制轮询命中应生成 copy-polled 诊断记录', async () => {
  const records: { level: CaptureDiagnosticLevel }[] = []
  const coordinator = new SelectionCaptureCoordinator(
    async () => ({ text: '复制文字', diagnostics: { level: 'copy-polled' } }),
    undefined,
    undefined,
    { onDiagnostic: (record) => { records.push(record) } }
  )

  const result = await coordinator.capture()
  assert.equal(result?.text, '复制文字')
  assert.equal(records.length, 1)
  assert.equal(records[0]?.level, 'copy-polled')
})

/**
 * 校验稳定期晚到命中生成 copy-late 级别诊断。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('稳定期晚到命中应生成 copy-late 诊断记录', async () => {
  const records: { level: CaptureDiagnosticLevel }[] = []
  const coordinator = new SelectionCaptureCoordinator(
    async () => ({ text: '晚到文字', diagnostics: { level: 'copy-late' } }),
    undefined,
    undefined,
    { onDiagnostic: (record) => { records.push(record) } }
  )

  const result = await coordinator.capture()
  assert.equal(result?.text, '晚到文字')
  assert.equal(records.length, 1)
  assert.equal(records[0]?.level, 'copy-late')
})

/**
 * 校验失败时生成带 reason 的 failed 诊断记录。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('取词失败应生成带 reason 的 failed 诊断记录', async () => {
  const records: { level: CaptureDiagnosticLevel; reason?: string }[] = []
  const coordinator = new SelectionCaptureCoordinator(
    async () => ({ text: '', reason: 'timeout', diagnostics: { level: 'failed', reason: 'timeout' } }),
    undefined,
    undefined,
    { onDiagnostic: (record) => { records.push(record) } }
  )

  const result = await coordinator.capture()
  assert.equal(result?.text, '')
  assert.equal(result?.reason, 'timeout')
  assert.equal(records.length, 1)
  assert.equal(records[0]?.level, 'failed')
  assert.equal(records[0]?.reason, 'timeout')
})

/**
 * 校验双击预取不单独生成诊断记录，其结果随最终按钮取词进入记录。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('双击预取本身不生成诊断记录', async () => {
  const records: { level: CaptureDiagnosticLevel }[] = []
  const coordinator = new SelectionCaptureCoordinator(
    async () => ({ text: '完整管线' }),
    async () => ({ text: '预取文字', diagnostics: { level: 'native-read' } }),
    async () => ({ text: '按钮复制' }),
    { onDiagnostic: (record) => { records.push(record) } }
  )

  await coordinator.prepare({ x: 1, y: 2 })
  assert.equal(records.length, 0)
})

/**
 * 校验入口标记：按钮、快捷键、自动模式分别标记为 button/hotkey/auto。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('入口应被正确标记到诊断记录', async () => {
  const records: { entry?: CaptureDiagnosticEntry }[] = []
  const coordinator = new SelectionCaptureCoordinator(
    async () => ({ text: 'x' }),
    undefined,
    undefined,
    { onDiagnostic: (record) => { records.push(record) } }
  )

  coordinator.markEntry('button')
  await coordinator.capture()
  coordinator.markEntry('hotkey')
  await coordinator.capture()
  coordinator.markEntry('auto')
  await coordinator.capture()

  assert.deepEqual(records.map((item) => item.entry), ['button', 'hotkey', 'auto'])
})

/**
 * 校验取词耗时被记录到诊断记录。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('诊断记录应包含非负耗时', async () => {
  const records: { elapsedMs: number }[] = []
  const coordinator = new SelectionCaptureCoordinator(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { text: 'x' }
    },
    undefined,
    undefined,
    { onDiagnostic: (record) => { records.push(record) } }
  )

  await coordinator.capture()
  assert.equal(records.length, 1)
  assert.ok(records[0]!.elapsedMs >= 0)
})

/**
 * 校验 capture.ts 为取词结果组装命中级别元数据。
 * @returns 无返回值。
 * @author zhenghq
 */
test('capture.ts 应在取词结果中返回命中级别诊断元数据', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  assert.match(source, /diagnostics/)
  assert.match(source, /copy-polled|copy-late|native-read/)
})

/**
 * 校验 index.ts 在三个取词入口调用 markEntry。
 * @returns 无返回值。
 * @author zhenghq
 */
test('index.ts 应在按钮、快捷键与自动入口标记诊断入口', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  assert.match(source, /markEntry\('button'\)/)
  assert.match(source, /markEntry\('hotkey'\)/)
  assert.match(source, /markEntry\('auto'\)/)
})
