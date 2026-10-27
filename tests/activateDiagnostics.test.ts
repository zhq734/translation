import assert from 'node:assert/strict'
import test from 'node:test'
import {
  alignActivatesWithCandidates,
  createActivateSourceRecord,
  createCandidateProbeRecord,
  formatActivateDiagnosticLog,
  parseActivateDiagnosticLogLine
} from '../src/shared/activateDiagnostics.ts'

/**
 * 校验放行 activate 记录包含时间戳、判定、调用栈与白名单事件字段。
 * @returns 无返回值。
 * @author zhenghq
 */
test('放行 activate 记录应包含时间戳、allow 判定、调用栈与白名单事件字段', () => {
  const result = createActivateSourceRecord({
    timestampMs: 1_760_000_000_123,
    decision: 'allow',
    stack: 'Error: probe\n    at onActivate (index.ts:719:5)',
    event: { hasVisibleWindows: true }
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.record.kind, 'activate')
  assert.equal(result.record.timestampMs, 1_760_000_000_123)
  assert.equal(result.record.decision, 'allow')
  assert.match(result.record.stack ?? '', /onActivate/u)
  assert.equal(result.record.event?.hasVisibleWindows, true)
})

/**
 * 校验拦截 activate 记录必须携带拦截原因。
 * @returns 无返回值。
 * @author zhenghq
 */
test('拦截 activate 记录应包含 ignore 判定与拦截原因', () => {
  const result = createActivateSourceRecord({
    timestampMs: 1_760_000_000_200,
    decision: 'ignore',
    reason: 'selection-button-visible',
    stack: 'Error: probe\n    at onActivate (index.ts:719:5)',
    event: { hasVisibleWindows: false }
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.record.decision, 'ignore')
  assert.equal(result.record.reason, 'selection-button-visible')
})

/**
 * 校验拦截 activate 缺失原因时被判定为失败结果。
 * @returns 无返回值。
 * @author zhenghq
 */
test('拦截 activate 缺失原因时应返回失败结果', () => {
  const result = createActivateSourceRecord({
    timestampMs: 1_760_000_000_300,
    decision: 'ignore',
    stack: 'Error: probe\n    at onActivate (index.ts:719:5)'
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error, 'missing-reason')
})

/**
 * 校验缺失调用栈时记录构造失败，避免产出无法指认派发者的日志。
 * @returns 无返回值。
 * @author zhenghq
 */
test('缺失调用栈时 activate 记录应返回失败结果', () => {
  const result = createActivateSourceRecord({
    timestampMs: 1_760_000_000_400,
    decision: 'allow',
    stack: ''
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error, 'missing-stack')
})

/**
 * 校验非有限时间戳被拒绝。
 * @returns 无返回值。
 * @author zhenghq
 */
test('非有限时间戳应返回失败结果', () => {
  const result = createActivateSourceRecord({
    timestampMs: Number.NaN,
    decision: 'allow',
    stack: 'Error: probe\n    at onActivate (index.ts:719:5)'
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error, 'invalid-timestamp')
})

/**
 * 校验敏感字段被拒绝，避免选中文字或窗口标题进入诊断日志。
 * @returns 无返回值。
 * @author zhenghq
 */
test('activate 记录包含敏感字段时应返回失败结果', () => {
  const result = createActivateSourceRecord({
    timestampMs: 1_760_000_000_500,
    decision: 'allow',
    stack: 'Error: probe\n    at onActivate (index.ts:719:5)',
    event: { hasVisibleWindows: true, windowTitle: '敏感窗口标题' }
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error, 'sensitive-field')
})

/**
 * 校验候选打点记录包含动作名、时间戳与窗口可见性布尔值。
 * @returns 无返回值。
 * @author zhenghq
 */
test('候选打点记录应包含动作名、时间戳与窗口可见性', () => {
  const result = createCandidateProbeRecord({
    timestampMs: 1_760_000_000_600,
    action: 'dock-show-sync-before',
    windowVisible: true
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.record.kind, 'candidate')
  assert.equal(result.record.action, 'dock-show-sync-before')
  assert.equal(result.record.timestampMs, 1_760_000_000_600)
  assert.equal(result.record.windowVisible, true)
})

/**
 * 校验候选打点缺少窗口可见性或动作名不合法时返回失败结果。
 * @returns 无返回值。
 * @author zhenghq
 */
test('候选打点字段不完整或动作名非法时应返回失败结果', () => {
  const missingVisible = createCandidateProbeRecord({
    timestampMs: 1_760_000_000_700,
    action: 'popup-hide'
  } as never)
  assert.equal(missingVisible.ok, false)
  if (!missingVisible.ok) assert.equal(missingVisible.error, 'invalid-window-visible')

  const unknownAction = createCandidateProbeRecord({
    timestampMs: 1_760_000_000_800,
    action: 'unknown-action' as never,
    windowVisible: false
  })
  assert.equal(unknownAction.ok, false)
  if (!unknownAction.ok) assert.equal(unknownAction.error, 'invalid-action')
})

/**
 * 校验序列化输出为单行结构化日志且不包含敏感字段。
 * @returns 无返回值。
 * @author zhenghq
 */
test('诊断日志序列化应为单行且不含敏感字段', () => {
  const result = createCandidateProbeRecord({
    timestampMs: 1_760_000_000_900,
    action: 'selection-button-hide',
    windowVisible: false
  })
  assert.equal(result.ok, true)
  if (!result.ok) return

  const line = formatActivateDiagnosticLog(result.record)
  assert.equal(line.includes('\n'), false)
  assert.match(line, /\[activate-diagnostics\]/u)
  assert.match(line, /selection-button-hide/u)
  assert.doesNotMatch(line, /selectedText|clipboard|windowTitle/u)
})

/**
 * 构造一条用于对齐测试的 activate 记录。
 * @param timestampMs 时间戳。
 * @returns activate 记录。
 * @author zhenghq
 */
function activateRecord(timestampMs: number) {
  const result = createActivateSourceRecord({
    timestampMs,
    decision: 'allow',
    stack: 'Error: probe\n    at onActivate (index.ts:719:5)'
  })
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('activate record should be valid')
  return result.record
}

/**
 * 构造一条用于对齐测试的候选记录。
 * @param timestampMs 时间戳。
 * @param action 候选动作。
 * @returns 候选记录。
 * @author zhenghq
 */
function candidateRecord(
  timestampMs: number,
  action: 'dock-show-sync-after' | 'popup-hide' = 'dock-show-sync-after'
) {
  const result = createCandidateProbeRecord({
    timestampMs,
    action,
    windowVisible: true
  })
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('candidate record should be valid')
  return result.record
}

test('对齐应把 activate 关联到前 3 秒内的 dock.show 候选并给出时间差', () => {
  const activate = activateRecord(10_000)
  const candidate = candidateRecord(7_000)

  const aligned = alignActivatesWithCandidates([activate, candidate])

  assert.equal(aligned.length, 1)
  assert.equal(aligned[0]?.noNearbyCandidate, false)
  assert.equal(aligned[0]?.candidates.length, 1)
  assert.equal(aligned[0]?.candidates[0]?.record.action, 'dock-show-sync-after')
  assert.equal(aligned[0]?.candidates[0]?.deltaMs, 3_000)
})

test('默认 60 秒窗口内无候选时必须显式标注无近邻候选而非省略', () => {
  const aligned = alignActivatesWithCandidates([activateRecord(100_000)])

  assert.equal(aligned.length, 1)
  assert.equal(aligned[0]?.noNearbyCandidate, true)
  assert.deepEqual(aligned[0]?.candidates, [])
})

test('对齐窗口边界、同时间戳与乱序输入行为必须确定', () => {
  const activate = activateRecord(60_000)
  // 恰好等于窗口边界：默认 60 秒应视为命中。
  const boundary = candidateRecord(0)
  const afterActivate = candidateRecord(70_000, 'popup-hide')
  const sameMoment = candidateRecord(60_000)

  const aligned = alignActivatesWithCandidates([afterActivate, sameMoment, activate, boundary])

  assert.equal(aligned.length, 1)
  assert.deepEqual(
    aligned[0]?.candidates.map((item) => item.deltaMs),
    [0, 60_000]
  )
})

test('每个 activate 最多关联最近 3 条候选', () => {
  const records = [
    candidateRecord(1_000),
    candidateRecord(2_000, 'popup-hide'),
    candidateRecord(3_000),
    candidateRecord(4_000, 'popup-hide'),
    activateRecord(5_000)
  ]

  const aligned = alignActivatesWithCandidates(records)

  assert.equal(aligned[0]?.candidates.length, 3)
  assert.deepEqual(
    aligned[0]?.candidates.map((item) => item.record.timestampMs),
    [4_000, 3_000, 2_000]
  )
})

test('日志解析应跳过非诊断行并还原记录', () => {
  const record = candidateRecord(1_760_000_001_000)
  const line = `[2026-10-11T02:34:31.346Z] [LOG] [main] ${formatActivateDiagnosticLog(record)}`

  assert.equal(parseActivateDiagnosticLogLine('普通日志行'), null)
  assert.deepEqual(parseActivateDiagnosticLogLine(line), record)
})
