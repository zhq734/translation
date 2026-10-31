import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  DocumentBlock,
  DocumentModel,
  DocumentPage,
  DocumentTextBlock
} from '../src/shared/documentTypes.ts'
import {
  resolveDocumentLanguagePair,
  type DocumentLanguagePreference
} from '../src/shared/documentLanguageDirection.ts'

/**
 * 构造测试用文本区块。
 * @param blockId 区块标识。
 * @param text 文本内容。
 * @returns 文本区块。
 * @author zhenghq
 */
function textBlock(blockId: string, text: string): DocumentTextBlock {
  return {
    kind: 'text',
    blockId,
    readingOrder: 0,
    translatable: true,
    role: 'paragraph',
    runs: [{ runId: `${blockId}-run`, text }]
  }
}

/**
 * 构造测试用文档模型。
 * @param blocks 页面区块。
 * @returns 文档模型。
 * @author zhenghq
 */
function model(blocks: DocumentBlock[]): DocumentModel {
  const page: DocumentPage = {
    pageId: 'page-1',
    index: 0,
    width: 600,
    height: 800,
    blocks
  }
  return {
    schemaVersion: 1,
    documentId: 'document-1',
    source: {
      path: '/tmp/test.txt',
      fileName: 'test.txt',
      format: 'txt',
      sha256: 'abc',
      size: 3
    },
    metadata: { direction: 'auto' },
    pages: [page],
    assets: [],
    warnings: []
  }
}

/**
 * 构造语言偏好。
 * @param sourcePreference 源语言偏好。
 * @param targetPreference 目标语言偏好。
 * @returns 语言偏好。
 * @author zhenghq
 */
function preferences(
  sourcePreference: string,
  targetPreference: string
): DocumentLanguagePreference {
  return { sourcePreference, targetPreference }
}

test('文档级自动方向在中文占优时选择英文，并保留用户偏好', () => {
  const source = model([
    textBlock('block-1', '这是一份中文产品说明，包含完整的业务规则。'),
    textBlock('block-2', 'API')
  ])

  const pair = resolveDocumentLanguagePair(source, preferences('auto', 'auto'))

  assert.deepEqual(pair, {
    sourcePreference: 'auto',
    targetPreference: 'auto',
    languagePair: { sourceLang: 'auto', targetLang: 'EN' }
  })
})

test('文档级自动方向在英文占优时选择中文', () => {
  const source = model([
    textBlock('block-1', 'This document explains the complete installation workflow.'),
    textBlock('block-2', '中文')
  ])

  const pair = resolveDocumentLanguagePair(source, preferences('auto', 'auto'))

  assert.deepEqual(pair.languagePair, { sourceLang: 'auto', targetLang: 'ZH' })
})

test('整份文档聚合后决定方向，不能让单个英文批次翻转中文占优文档', () => {
  const source = model([
    textBlock('block-1', '中文说明'.repeat(40)),
    textBlock('block-2', 'English-only batch with enough Latin characters to dominate locally.'),
    textBlock('block-3', '更多中文内容'.repeat(40))
  ])

  const pair = resolveDocumentLanguagePair(source, preferences('auto', 'auto'))

  assert.equal(pair.languagePair.targetLang, 'EN')
})

test('显式目标语言始终优先，不被文档主语言覆盖', () => {
  const source = model([textBlock('block-1', 'This is an English document.')])

  assert.equal(
    resolveDocumentLanguagePair(source, preferences('auto', 'zh')).languagePair.targetLang,
    'ZH'
  )
  assert.equal(
    resolveDocumentLanguagePair(source, preferences('auto', 'fr')).languagePair.targetLang,
    'FR'
  )
})

test('OCR 后的识别文本参与方向判定，保护片段和协议标记不参与判定', () => {
  const source = model([
    textBlock('block-protected', '[[[ST-SEG-0]]] https://example.com ' + 'A'.repeat(200)),
    {
      kind: 'image',
      blockId: 'image-1',
      readingOrder: 1,
      translatable: false,
      assetId: 'asset-1',
      ocrRegions: [{
        regionId: 'region-1',
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        text: '扫描件中的中文正文内容',
        status: 'recognized'
      }]
    }
  ])
  source.pages[0]!.blocks[0] = {
    ...(source.pages[0]!.blocks[0] as DocumentTextBlock),
    runs: [
      { runId: 'protocol', text: '[[[ST-SEG-0]]]', protected: true },
      { runId: 'url', text: 'https://example.com', protected: true },
      { runId: 'latin', text: 'A'.repeat(200), protected: true }
    ]
  }

  const pair = resolveDocumentLanguagePair(source, preferences('auto', 'auto'))

  assert.equal(pair.languagePair.targetLang, 'EN')
})

test('表格行只汇总单元格正文，不把内部单元格协议标记计入语言比例', () => {
  const source = model([{
    kind: 'table',
    blockId: 'table-1',
    readingOrder: 0,
    translatable: true,
    rows: [{
      rowId: 'row-1',
      cells: [
        { cellId: 'cell-1', rowSpan: 1, colSpan: 1, blocks: [textBlock('cell-block-1', '中文内容')] },
        { cellId: 'cell-2', rowSpan: 1, colSpan: 1, blocks: [textBlock('cell-block-2', '更多中文')] }
      ]
    }]
  }])

  const pair = resolveDocumentLanguagePair(source, preferences('auto', 'auto'))

  assert.equal(pair.languagePair.targetLang, 'EN')
})

test('没有可翻译文本时 auto 回退为中文目标，且不产生空白源文本请求', () => {
  const source = model([textBlock('block-1', '   ')])

  const pair = resolveDocumentLanguagePair(source, preferences('auto', 'auto'))

  assert.deepEqual(pair.languagePair, { sourceLang: 'auto', targetLang: 'ZH' })
})
