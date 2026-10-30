import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPartialExportDocument
} from '../src/shared/documentPartialExport.ts'
import {
  evaluateDocumentCompletion,
  type DocumentCompletionReport,
  type DocumentCompletionTarget
} from '../src/shared/documentCompletion.ts'
import type { DocumentModel } from '../src/shared/documentTypes.ts'

/**
 * 构造包含文本、OCR 与表格目标的部分导出测试文档。
 * @param translated 是否使用译文版本。
 * @returns 文档模型。
 * @author zhenghq
 */
function partialExportModel(translated: boolean): DocumentModel {
  return {
    schemaVersion: 1,
    documentId: 'document-partial',
    source: {
      path: '/tmp/source.pdf',
      fileName: 'source.pdf',
      format: 'pdf',
      sha256: 'fixture',
      size: 10,
      pageCount: 2
    },
    metadata: { direction: 'ltr' },
    pages: [{
      pageId: 'page-1',
      index: 0,
      width: 612,
      height: 792,
      background: { kind: 'solid', color: '#fff' },
      blocks: [
        {
          kind: 'text',
          blockId: 'text-1',
          readingOrder: 0,
          translatable: true,
          role: 'paragraph',
          runs: [
            { runId: 'run-1', text: translated ? '你好' : 'Hello' },
            { runId: 'run-2', text: translated ? '世界' : 'World' }
          ]
        },
        {
          kind: 'image',
          blockId: 'image-1',
          readingOrder: 1,
          translatable: false,
          assetId: 'asset-1',
          ocrRegions: [{
            regionId: 'region-1',
            bbox: { x: 0, y: 0, width: 1, height: 1 },
            text: 'Scanned text',
            status: 'recognized',
            ...(translated ? { translatedText: '扫描文字' } : {})
          }]
        },
        {
          kind: 'table',
          blockId: 'table-1',
          readingOrder: 2,
          translatable: false,
          rows: [{
            rowId: 'row-1',
            cells: [
              {
                cellId: 'cell-1',
                rowSpan: 1,
                colSpan: 1,
                blocks: [{
                  kind: 'text',
                  blockId: 'cell-text-1',
                  readingOrder: 0,
                  translatable: true,
                  role: 'paragraph',
                  runs: [{ runId: 'cell-run-1', text: translated ? '甲' : 'Alpha' }]
                }]
              },
              {
                cellId: 'cell-2',
                rowSpan: 1,
                colSpan: 1,
                blocks: [{
                  kind: 'text',
                  blockId: 'cell-text-2',
                  readingOrder: 0,
                  translatable: true,
                  role: 'paragraph',
                  runs: [{ runId: 'cell-run-2', text: translated ? '乙' : 'Beta' }]
                }]
              }
            ]
          }]
        }
      ]
    }, {
      pageId: 'page-2',
      index: 1,
      width: 612,
      height: 792,
      blocks: [{
        kind: 'text',
        blockId: 'text-2',
        readingOrder: 0,
        translatable: true,
        role: 'paragraph',
        runs: [{ runId: 'run-3', text: translated ? '第三页译文' : 'Third page' }]
      }]
    }],
    assets: [{
      assetId: 'asset-1',
      kind: 'image',
      mimeType: 'image/png',
      sha256: 'asset',
      byteLength: 1
    }],
    warnings: []
  }
}

/**
 * 构造固定完成报告。
 * @param states 目标状态映射。
 * @returns 完成报告。
 * @author zhenghq
 */
function completionReport(
  states: Array<Pick<DocumentCompletionTarget, 'targetId' | 'sourceText' | 'state'>>
): DocumentCompletionReport {
  return evaluateDocumentCompletion({
    jobId: 'job-1',
    generation: 1,
    documentId: 'document-partial',
    modelFingerprint: 'model-1',
    sourcePreference: 'EN',
    targetPreference: 'ZH',
    languagePair: { sourceLang: 'EN', targetLang: 'ZH' },
    targets: states.map((state) => ({
      ...state,
      ...(state.state === 'translated' ? { translatedText: '译' } : {})
    }))
  })
}

test('部分导出保留全部页面并只回退失败、未完成与疑似未翻译目标', () => {
  const report = completionReport([
    { targetId: '0:0:text:run-1', sourceText: 'HelloWorld', state: 'translated' },
    { targetId: '0:1:ocr:region-1', sourceText: 'Scanned text', state: 'failed' },
    { targetId: '0:2:row:row-1', sourceText: 'Alpha\nBeta', state: 'pending' },
    { targetId: '1:0:text:run-3', sourceText: 'Third page', state: 'suspect-untranslated' }
  ])

  const result = buildPartialExportDocument(
    partialExportModel(false),
    partialExportModel(true),
    report
  )

  assert.equal(result.model.pages.length, 2)
  assert.equal(result.model.assets.length, 1)
  assert.equal(result.summary.total, 4)
  assert.equal(result.summary.translated, 1)
  assert.equal(result.summary.reverted, 3)
  assert.equal(result.summary.failed, 1)
  assert.equal(result.summary.pending, 1)
  assert.equal(result.summary.suspectUntranslated, 1)

  const textBlock = result.model.pages[0]!.blocks[0]!
  assert.equal(textBlock.kind, 'text')
  if (textBlock.kind !== 'text') return
  assert.deepEqual(textBlock.runs.map((run) => run.text), ['你好', '世界'])

  const imageBlock = result.model.pages[0]!.blocks[1]!
  assert.equal(imageBlock.kind, 'image')
  if (imageBlock.kind !== 'image') return
  assert.equal(imageBlock.ocrRegions?.[0]?.text, 'Scanned text')
  assert.equal(imageBlock.ocrRegions?.[0]?.translatedText, undefined)

  const tableBlock = result.model.pages[0]!.blocks[2]!
  assert.equal(tableBlock.kind, 'table')
  if (tableBlock.kind !== 'table') return
  const firstCell = tableBlock.rows[0]!.cells[0]!.blocks[0]!
  const secondCell = tableBlock.rows[0]!.cells[1]!.blocks[0]!
  assert.equal(firstCell.kind, 'text')
  assert.equal(secondCell.kind, 'text')
  if (firstCell.kind !== 'text' || secondCell.kind !== 'text') return
  assert.equal(firstCell.runs[0]?.text, 'Alpha')
  assert.equal(secondCell.runs[0]?.text, 'Beta')

  const thirdPage = result.model.pages[1]!.blocks[0]!
  assert.equal(thirdPage.kind, 'text')
  if (thirdPage.kind !== 'text') return
  assert.equal(thirdPage.runs[0]?.text, 'Third page')
})

test('疑似未翻译目标即使有非空译文也必须回退原文', () => {
  const report = completionReport([
    { targetId: '0:0:text:run-1', sourceText: 'HelloWorld', state: 'suspect-untranslated' },
    { targetId: '0:1:ocr:region-1', sourceText: 'Scanned text', state: 'unchanged' },
    { targetId: '0:2:row:row-1', sourceText: 'Alpha\nBeta', state: 'unchanged' },
    { targetId: '1:0:text:run-3', sourceText: 'Third page', state: 'unchanged' }
  ])
  const result = buildPartialExportDocument(
    partialExportModel(false),
    partialExportModel(true),
    report
  )
  const block = result.model.pages[0]!.blocks[0]!
  assert.equal(block.kind, 'text')
  if (block.kind !== 'text') return
  assert.deepEqual(block.runs.map((run) => run.text), ['Hello', 'World'])
  assert.equal(result.summary.reverted, 1)
})

test('部分导出拒绝未知目标、重复目标、空译文成功目标与报告计数不一致', () => {
  const source = partialExportModel(false)
  const translation = partialExportModel(true)
  const valid = completionReport([
    { targetId: '0:0:text:run-1', sourceText: 'HelloWorld', state: 'translated' }
  ])

  assert.throws(
    () => buildPartialExportDocument(source, translation, {
      ...valid,
      failedTargetIds: ['9:0:text:missing'],
      failed: 1,
      translated: 0,
      status: 'partial'
    }),
    /completion-mismatch/u
  )
  assert.throws(
    () => buildPartialExportDocument(source, translation, {
      ...valid,
      pendingTargetIds: ['0:0:text:run-1', '0:0:text:run-1'],
      pending: 2,
      translated: 0,
      status: 'partial'
    }),
    /completion-mismatch/u
  )
  assert.throws(
    () => buildPartialExportDocument(source, translation, {
      ...valid,
      total: 2,
      translated: 2
    }),
    /completion-mismatch/u
  )
  const emptyTranslation = partialExportModel(true)
  const emptyBlock = emptyTranslation.pages[0]!.blocks[0]!
  if (emptyBlock.kind === 'text') emptyBlock.runs = [{ runId: 'run-1', text: '  ' }]
  assert.throws(
    () => buildPartialExportDocument(source, emptyTranslation, valid),
    /completion-mismatch/u
  )
})

test('部分导出构建器拒绝状态 completed 但仍含未解决目标的报告', () => {
  const source = partialExportModel(false)
  const translation = partialExportModel(true)
  const report = completionReport([
    { targetId: '0:0:text:run-1', sourceText: 'HelloWorld', state: 'failed' },
    { targetId: '0:1:ocr:region-1', sourceText: 'Scanned text', state: 'unchanged' },
    { targetId: '0:2:row:row-1', sourceText: 'Alpha\nBeta', state: 'unchanged' },
    { targetId: '1:0:text:run-3', sourceText: 'Third page', state: 'unchanged' }
  ])

  assert.equal(report.status, 'partial')
  assert.throws(
    () => buildPartialExportDocument(source, translation, { ...report, status: 'completed' }),
    /completion-mismatch/u
  )
})
