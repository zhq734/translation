import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateDocumentCompletion,
  isLikelyUntranslatedTranslation,
  selectDocumentWorkspaceSnapshot,
  validateDocumentCompletionReport,
  type DocumentCompletionTarget,
  type EvaluateDocumentCompletionInput
} from '../src/shared/documentCompletion.ts'
import type { DocumentLanguagePair } from '../src/shared/documentLanguageDirection.ts'
import type { DocumentWorkspaceSnapshot } from '../src/shared/documentWorkspace.ts'

/**
 * 构造完成报告评估输入。
 * @param targets 目标级完成状态。
 * @param overrides 需要覆盖的字段。
 * @returns 完成报告评估输入。
 * @author zhenghq
 */
function completionInput(
  targets: DocumentCompletionTarget[],
  overrides: Partial<EvaluateDocumentCompletionInput> = {}
): EvaluateDocumentCompletionInput {
  return {
    jobId: 'job-1',
    generation: 3,
    documentId: 'document-1',
    modelFingerprint: 'model-3',
    sourcePreference: 'auto',
    targetPreference: 'auto',
    languagePair: { sourceLang: 'auto', targetLang: 'ZH' },
    targets,
    ...overrides
  }
}

/**
 * 构造已成功翻译的目标。
 * @param targetId 目标标识。
 * @param sourceText 原文。
 * @param translatedText 译文。
 * @returns 目标级完成状态。
 * @author zhenghq
 */
function translatedTarget(
  targetId: string,
  sourceText: string,
  translatedText: string
): DocumentCompletionTarget {
  return { targetId, sourceText, translatedText, state: 'translated' }
}

test('全部目标成功时完成报告为 completed 并满足计数不变量', () => {
  const report = evaluateDocumentCompletion(completionInput([
    translatedTarget('target-1', 'Hello world', '你好，世界'),
    translatedTarget('target-2', 'Install the application', '安装应用程序')
  ]))

  assert.equal(report.status, 'completed')
  assert.equal(report.total, 2)
  assert.equal(report.translated, 2)
  assert.equal(report.unchanged, 0)
  assert.equal(report.failed, 0)
  assert.equal(report.pending, 0)
  assert.equal(report.suspectUntranslated, 0)
  assert.equal(
    report.total,
    report.translated + report.unchanged + report.failed + report.pending + report.suspectUntranslated
  )
  assert.deepEqual(report.failedTargetIds, [])
  assert.deepEqual(report.pendingTargetIds, [])
  assert.deepEqual(report.suspectUntranslatedTargetIds, [])
})

test('原文已经是目标语言时计为无需翻译，不能与真正译文混计', () => {
  const report = evaluateDocumentCompletion(completionInput([
    translatedTarget('target-1', '这是完整的中文说明。', '这是完整的中文说明。'),
    {
      targetId: 'target-2',
      sourceText: 'OpenAI',
      state: 'unchanged'
    }
  ]))

  assert.equal(report.status, 'completed')
  assert.equal(report.translated, 0)
  assert.equal(report.unchanged, 2)
})

test('单个目标失败时保留成功结果并生成 partial 报告', () => {
  const report = evaluateDocumentCompletion(completionInput([
    translatedTarget('target-1', 'Hello world', '你好，世界'),
    {
      targetId: 'target-2',
      sourceText: 'Install the application',
      translatedText: '安装应用程序',
      state: 'failed',
      failureReason: 'provider-error'
    }
  ]))

  assert.equal(report.status, 'partial')
  assert.equal(report.translated, 1)
  assert.equal(report.failed, 1)
  assert.deepEqual(report.failedTargetIds, ['target-2'])
  assert.equal(report.failureReasons['target-2'], 'provider-error')
})

test('全部目标失败且没有可用结果时为 failed', () => {
  const report = evaluateDocumentCompletion(completionInput([
    { targetId: 'target-1', sourceText: 'First', state: 'failed' },
    { targetId: 'target-2', sourceText: 'Second', state: 'pending' }
  ]))

  assert.equal(report.status, 'failed')
  assert.equal(report.translated + report.unchanged, 0)
  assert.equal(report.failed, 1)
  assert.equal(report.pending, 1)
})

test('非空译文为空、占位符损坏或表格映射失败时不得计为成功', () => {
  const report = evaluateDocumentCompletion(completionInput([
    translatedTarget('empty', 'Hello world', '   '),
    translatedTarget('placeholder', 'Hello {{name}}', '你好'),
    {
      targetId: 'table',
      sourceText: 'A\n[[[ST-DOC-CELL-0]]]\nB',
      translatedText: '甲',
      state: 'translated',
      tableMappingValid: false
    }
  ]))

  assert.equal(report.status, 'failed')
  assert.equal(report.failed, 3)
  assert.deepEqual(report.failedTargetIds, ['empty', 'placeholder', 'table'])
  assert.equal(report.failureReasons.empty, 'empty-translation')
  assert.equal(report.failureReasons.placeholder, 'placeholder-mismatch')
  assert.equal(report.failureReasons.table, 'table-mapping-failed')
})

test('中文目标收到长段英文时标记疑似未翻译并保留原文', () => {
  const pair: DocumentLanguagePair = { sourceLang: 'EN', targetLang: 'ZH' }
  const source = 'The quick brown fox jumps over the lazy dog every morning.'
  const report = evaluateDocumentCompletion(completionInput([
    translatedTarget('target-1', source, source)
  ], { languagePair: pair }))

  assert.equal(report.status, 'failed')
  assert.equal(report.suspectUntranslated, 1)
  assert.deepEqual(report.suspectUntranslatedTargetIds, ['target-1'])
  assert.equal(report.translated, 0)
})

test('英文目标收到长段中文时标记疑似未翻译', () => {
  const pair: DocumentLanguagePair = { sourceLang: 'ZH', targetLang: 'EN' }
  const source = '这是一段用于验证英文目标方向的中文说明文字，包含完整的业务规则。'
  const report = evaluateDocumentCompletion(completionInput([
    translatedTarget('target-1', source, source)
  ], { languagePair: pair }))

  assert.equal(report.status, 'failed')
  assert.equal(report.suspectUntranslated, 1)
})

test('数字、URL、代码标识符、专有名词、短文本和已处于目标语言的文本保守豁免', () => {
  const zhPair: DocumentLanguagePair = { sourceLang: 'EN', targetLang: 'ZH' }
  const exempt = [
    '12345',
    'https://example.com/docs/getting-started',
    'getUserProfileV2',
    'OpenAI GPT-5',
    'Local transportation',
    '这是已经处于目标语言的中文短文本。'
  ]

  for (const text of exempt) {
    assert.equal(
      isLikelyUntranslatedTranslation(text, text, zhPair),
      false,
      `${text} 不应被误判为未翻译`
    )
  }
})

test('重试成功后重新计算报告并恢复 completed', () => {
  const initial = evaluateDocumentCompletion(completionInput([
    translatedTarget('target-1', 'Hello world', '你好，世界'),
    { targetId: 'target-2', sourceText: 'Install the application', state: 'failed' }
  ]))
  assert.equal(initial.status, 'partial')

  const retried = evaluateDocumentCompletion(completionInput([
    translatedTarget('target-1', 'Hello world', '你好，世界'),
    translatedTarget('target-2', 'Install the application', '安装应用程序')
  ]))

  assert.equal(retried.status, 'completed')
  assert.equal(retried.failed, 0)
  assert.deepEqual(retried.failedTargetIds, [])
})

test('报告复验拒绝旧代际、旧文档、旧模型指纹和计数不一致', () => {
  const report = evaluateDocumentCompletion(completionInput([
    translatedTarget('target-1', 'Hello world', '你好，世界')
  ]))
  const expected = {
    jobId: report.jobId,
    generation: report.generation,
    documentId: report.documentId,
    modelFingerprint: report.modelFingerprint,
    total: report.total,
    translated: report.translated,
    unchanged: report.unchanged,
    failed: report.failed,
    pending: report.pending,
    suspectUntranslated: report.suspectUntranslated
  }

  assert.deepEqual(validateDocumentCompletionReport(report, expected), { ok: true })
  assert.equal(
    validateDocumentCompletionReport(report, { ...expected, generation: 2 }).code,
    'completion-mismatch'
  )
  assert.equal(
    validateDocumentCompletionReport(report, { ...expected, documentId: 'document-old' }).code,
    'completion-mismatch'
  )
  assert.equal(
    validateDocumentCompletionReport(report, { ...expected, modelFingerprint: 'model-old' }).code,
    'completion-mismatch'
  )
  assert.equal(
    validateDocumentCompletionReport(report, { ...expected, translated: 0, pending: 1 }).code,
    'completion-mismatch'
  )
})

test('取消终态优先于目标计数并保留已有结果统计', () => {
  const report = evaluateDocumentCompletion(completionInput([
    translatedTarget('target-1', 'Hello world', '你好，世界'),
    { targetId: 'target-2', sourceText: 'Pending content', state: 'pending' }
  ], { cancelled: true }))

  assert.equal(report.status, 'cancelled')
  assert.equal(report.translated, 1)
  assert.equal(report.pending, 1)
  assert.deepEqual(report.pendingTargetIds, ['target-2'])
})

/**
 * 构造用于验证终态快照门禁的工作台快照。
 * @param status 任务状态。
 * @param completed 当前阶段完成数。
 * @param translationText 译文首段。
 * @returns 工作台快照。
 * @author zhenghq
 */
function workspaceSnapshot(
  status: 'translating' | 'partial' | 'completed' | 'cancelled',
  completed: number,
  translationText: string
): DocumentWorkspaceSnapshot {
  return {
    jobId: 'job-1',
    generation: 1,
    task: {
      jobId: 'job-1',
      generation: 1,
      phase: 'translate',
      status,
      progress: { completed, total: 2 },
      cancellationRequested: status === 'cancelled',
      failedBlocks: status === 'partial' ? 1 : 0,
      warningCount: 0,
      phaseCompleted: false
    },
    percent: status === 'completed' ? 100 : 55,
    translation: {
      schemaVersion: 1,
      documentId: 'document-1',
      source: {
        path: '/tmp/source.txt',
        fileName: 'source.txt',
        format: 'txt',
        sha256: 'fixture',
        size: 5
      },
      metadata: { direction: 'auto' },
      pages: [{
        pageId: 'page-1',
        index: 0,
        width: 600,
        height: 800,
        blocks: [{
          kind: 'text',
          blockId: 'block-1',
          readingOrder: 0,
          translatable: true,
          role: 'paragraph',
          runs: [{ runId: 'run-1', text: translationText }]
        }]
      }],
      assets: [],
      warnings: []
    }
  }
}

test('终态后迟到进度不得让任务状态、进度和译文回退', () => {
  const completed = workspaceSnapshot('completed', 2, '最终译文')
  const lateProgress = workspaceSnapshot('translating', 1, '迟到的旧译文')

  assert.equal(selectDocumentWorkspaceSnapshot(completed, lateProgress), completed)
})

test('同一 completed 终态的迟到快照不得回退进度或覆盖最终译文', () => {
  const completed = workspaceSnapshot('completed', 2, '最终译文')
  const lateCompleted = workspaceSnapshot('completed', 1, '迟到的旧译文')

  const selected = selectDocumentWorkspaceSnapshot(completed, lateCompleted)

  assert.equal(selected, completed)
  assert.deepEqual(selected.task.progress, { completed: 2, total: 2 })
  assert.equal(
    (selected.translation!.pages[0]!.blocks[0] as { runs: Array<{ text: string }> }).runs[0]!.text,
    '最终译文'
  )
})

test('同一终态只补全缺失字段且不得替换已有完成报告与语言方向', () => {
  const completed = workspaceSnapshot('completed', 2, '最终译文')
  const currentReport = evaluateDocumentCompletion(completionInput([
    translatedTarget('target-1', 'Hello world', '你好，世界')
  ]))
  const incomingReport = evaluateDocumentCompletion(completionInput([
    translatedTarget('target-1', 'Hello world', '旧的覆盖译文')
  ]))
  const currentPair: DocumentLanguagePair = { sourceLang: 'EN', targetLang: 'ZH' }
  const incomingPair: DocumentLanguagePair = { sourceLang: 'ZH', targetLang: 'EN' }
  const withCurrentMetadata: DocumentWorkspaceSnapshot = {
    ...completed,
    sourcePreference: 'auto',
    targetPreference: 'zh',
    languagePair: currentPair,
    completionReport: currentReport
  }
  const incomingMetadata: DocumentWorkspaceSnapshot = {
    ...workspaceSnapshot('completed', 1, '迟到的旧译文'),
    sourcePreference: 'en',
    targetPreference: 'en',
    languagePair: incomingPair,
    completionReport: incomingReport,
    retryableFailedBlocks: 2
  }

  const merged = selectDocumentWorkspaceSnapshot(withCurrentMetadata, incomingMetadata)

  assert.equal(merged.task.progress.completed, 2)
  assert.equal(merged.sourcePreference, 'auto')
  assert.equal(merged.targetPreference, 'zh')
  assert.equal(merged.languagePair, currentPair)
  assert.equal(merged.completionReport, currentReport)
  assert.equal(merged.retryableFailedBlocks, 2)
})

test('同一终态快照必须从迟到事件补全尚未生成的完成报告和语言方向', () => {
  const completed = workspaceSnapshot('completed', 2, '最终译文')
  const report = evaluateDocumentCompletion(completionInput([
    translatedTarget('target-1', 'Hello world', '你好，世界')
  ]))
  const pair: DocumentLanguagePair = { sourceLang: 'EN', targetLang: 'ZH' }
  const incoming = {
    ...workspaceSnapshot('completed', 2, '最终译文'),
    sourcePreference: 'auto',
    targetPreference: 'zh',
    languagePair: pair,
    completionReport: report,
    retryableFailedBlocks: 1
  }

  const merged = selectDocumentWorkspaceSnapshot(completed, incoming)

  assert.equal(merged.task.progress.completed, 2)
  assert.equal(merged.sourcePreference, 'auto')
  assert.equal(merged.targetPreference, 'zh')
  assert.equal(merged.languagePair, pair)
  assert.equal(merged.completionReport, report)
  assert.equal(merged.retryableFailedBlocks, 1)
})

test('部分完成终态同样拒绝迟到的运行中快照', () => {
  const partial = workspaceSnapshot('partial', 2, '部分译文')
  const lateProgress = workspaceSnapshot('translating', 0, '旧译文')

  assert.equal(selectDocumentWorkspaceSnapshot(partial, lateProgress), partial)
})

test('取消终态后迟到结果必须丢弃且不能恢复运行状态', () => {
  const cancelled = workspaceSnapshot('cancelled', 1, '取消前译文')
  const lateCompleted = workspaceSnapshot('completed', 2, '迟到完成译文')

  assert.equal(selectDocumentWorkspaceSnapshot(cancelled, lateCompleted), cancelled)
})

test('不同任务代际的迟到快照必须丢弃', () => {
  const running = workspaceSnapshot('translating', 1, '当前译文')
  const oldGeneration = {
    ...workspaceSnapshot('partial', 2, '旧代际译文'),
    generation: 0,
    task: {
      ...workspaceSnapshot('partial', 2, '旧代际译文').task,
      generation: 0
    }
  }

  assert.equal(selectDocumentWorkspaceSnapshot(running, oldGeneration), running)
})
