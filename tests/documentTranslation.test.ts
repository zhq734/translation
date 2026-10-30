import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  DocumentBlock,
  DocumentModel,
  DocumentPage,
  DocumentTableBlock,
  DocumentTextBlock
} from '../src/shared/documentTypes.ts'
import {
  createDocumentTaskState
} from '../src/shared/documentTask.ts'
import {
  runDocumentTranslationPipeline,
  type DocumentPipelineDeps
} from '../src/main/documentTranslationPipeline.ts'
import type { DocumentLanguagePair } from '../src/shared/documentLanguageDirection.ts'
import {
  applyDocumentGlossary,
  buildDocumentTranslationCacheKey,
  collectDocumentTranslationUnits,
  createDocumentProtectedText,
  parseDocumentTranslationCacheEntry,
  restoreDocumentProtectedText,
  splitDocumentTranslationUnits,
  validateDocumentProtectedText,
  type DocumentGlossary,
  type DocumentTranslationCacheContext,
  type TranslationUnit
} from '../src/shared/documentTranslation.ts'

/**
 * 构造测试用文本区块。
 * @param blockId 区块标识。
 * @param text 原文。
 * @param role 文本语义角色。
 * @param extra 额外区块字段。
 * @returns 文本区块。
 * @author zhenghq
 */
function textBlock(
  blockId: string,
  text: string,
  role: DocumentTextBlock['role'] = 'paragraph',
  extra: Partial<DocumentTextBlock> = {}
): DocumentTextBlock {
  return {
    kind: 'text',
    blockId,
    readingOrder: 0,
    translatable: true,
    role,
    runs: [{ runId: `${blockId}-run`, text }],
    ...extra
  }
}

/**
 * 构造测试用表格区块。
 * @param blockId 表格标识。
 * @param rows 单元格文本矩阵。
 * @returns 表格区块。
 * @author zhenghq
 */
function tableBlock(blockId: string, rows: string[][]): DocumentTableBlock {
  return {
    kind: 'table',
    blockId,
    readingOrder: 0,
    translatable: true,
    rows: rows.map((cells, rowIndex) => ({
      rowId: `${blockId}-row-${rowIndex + 1}`,
      cells: cells.map((text, cellIndex) => ({
        cellId: `${blockId}-cell-${rowIndex + 1}-${cellIndex + 1}`,
        rowSpan: 1,
        colSpan: 1,
        blocks: [textBlock(
          `${blockId}-block-${rowIndex + 1}-${cellIndex + 1}`,
          text
        )]
      }))
    }))
  }
}

/**
 * 构造测试用文档模型。
 * @param blocks 页面区块。
 * @param format 文件格式。
 * @returns 文档模型。
 * @author zhenghq
 */
function model(blocks: DocumentBlock[], format: DocumentModel['source']['format'] = 'txt'): DocumentModel {
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
      format,
      sha256: 'file-sha-256',
      size: 3
    },
    metadata: { direction: 'auto' },
    pages: [page],
    assets: [],
    warnings: []
  }
}

/**
 * 构造固定语言对。
 * @returns 中英语言对。
 * @author zhenghq
 */
function languagePair(): DocumentLanguagePair {
  return { sourceLang: 'EN', targetLang: 'ZH' }
}

/**
 * 构造流水线依赖，默认返回保留正文的译文。
 * @param translate 自定义翻译函数。
 * @returns 可注入流水线依赖。
 * @author zhenghq
 */
function pipelineDeps(
  translate: DocumentPipelineDeps['translate'] = async (text) => `T(${text})`
): DocumentPipelineDeps {
  return {
    parse: async () => model([]),
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate,
    onProgress: () => undefined
  }
}

test('段落、标题、列表项、表格单元格和字幕行必须生成各自的语义单元', () => {
  const source = model([
    textBlock('paragraph', 'A normal paragraph.'),
    textBlock('heading', 'Document title', 'heading'),
    textBlock('list-item', 'List entry', 'list-item', {
      list: { level: 0, marker: '1.', ordered: true }
    }),
    tableBlock('table', [['Cell A', 'Cell B']]),
    textBlock('caption', 'Figure caption', 'caption', { timing: '00:00:01,000 --> 00:00:02,000' })
  ])

  const units = collectDocumentTranslationUnits(source)

  assert.deepEqual(units.map((unit) => unit.kind), [
    'paragraph',
    'heading',
    'list-item',
    'table-cell',
    'table-cell',
    'caption'
  ])
  assert.deepEqual(units.map((unit) => unit.text), [
    'A normal paragraph.',
    'Document title',
    'List entry',
    'Cell A',
    'Cell B',
    'Figure caption'
  ])
  assert.equal(units[0]?.unitId, 'page-1:paragraph:paragraph-run')
  assert.equal(units[3]?.unitId, 'page-1:table:table-cell-1-1:table-block-1-1:table-block-1-1-run')
  assert.equal(units[3]?.pageId, 'page-1')
  assert.equal(units[3]?.blockId, 'table')
  assert.equal(units[5]?.kind, 'caption')
})

test('同一段落内多个可翻译 run 必须合并，样式变化不能拆成多个单元', () => {
  const source = model([{
    ...textBlock('mixed', ''),
    runs: [
      { runId: 'bold', text: 'Important ', style: { fontWeight: 700 } },
      { runId: 'normal', text: 'details', style: { fontWeight: 400 } }
    ]
  }])

  const units = collectDocumentTranslationUnits(source)

  assert.equal(units.length, 1)
  assert.equal(units[0]?.text, 'Important details')
  assert.deepEqual(units[0]?.protectedSpans, [])
})

test('长文本只在句界切分，并携带稳定的分段标识和相邻上下文', () => {
  const source = model([textBlock(
    'long',
    'First sentence stays intact. Second sentence also stays intact. Third sentence is here.'
  )])
  const [unit] = collectDocumentTranslationUnits(source)
  assert.ok(unit)

  const parts = splitDocumentTranslationUnits([unit], 43)

  assert.equal(parts.length, 3)
  assert.deepEqual(parts.map((part) => part.text), [
    'First sentence stays intact.',
    'Second sentence also stays intact.',
    'Third sentence is here.'
  ])
  assert.deepEqual(parts.map((part) => part.unitId), [
    `${unit.unitId}:part-1`,
    `${unit.unitId}:part-2`,
    `${unit.unitId}:part-3`
  ])
  assert.equal(parts[0]?.context.next, 'Second sentence also stays intact.')
  assert.equal(parts[1]?.context.previous, 'First sentence stays intact.')
  assert.equal(parts[1]?.context.next, 'Third sentence is here.')
  assert.equal(parts[2]?.context.previous, 'Second sentence also stays intact.')
})

test('长文本不得切断单词、保护片段或公式', () => {
  const source = model([textBlock(
    'protected-long',
    'Read the installation guide carefully before starting the service. Keep https://example.com unchanged and verify every URL.'
  )])
  const [unit] = collectDocumentTranslationUnits(source)
  assert.ok(unit)

  const protectedText = createDocumentProtectedText(unit)
  assert.equal(protectedText.safe, true)
  if (!protectedText.safe) return
  const [protectedUnit] = collectDocumentTranslationUnits(model([textBlock(
    'protected-long',
    protectedText.text
  )]))
  assert.ok(protectedUnit)
  const parts = splitDocumentTranslationUnits([protectedUnit], 42)
  const joined = parts.map((part) => part.text).join(' ')

  assert.equal(parts.every((part) => part.text.length <= 42), true)
  assert.match(joined, /installation guide/u)
  assert.match(joined, /unchanged/u)
})

test('公式、代码、URL、邮箱、文件路径、纯数字和链接目标必须进入受保护片段', () => {
  const source = model([textBlock(
    'protected',
    'Use $E=mc^2$ with `npm test`, visit https://example.com, mail dev@example.com, open /tmp/report.pdf, keep 42 and [docs](https://example.com/docs).'
  )])

  const [unit] = collectDocumentTranslationUnits(source)
  assert.ok(unit)

  assert.equal(unit.protectedSpans.length >= 7, true)
  assert.equal(unit.protectedSpans.some((span) => span.text.includes('$E=mc^2$')), true)
  assert.equal(unit.protectedSpans.some((span) => span.text.includes('`npm test`')), true)
  assert.equal(unit.protectedSpans.some((span) => span.text.startsWith('https://example.com')), true)
  assert.equal(unit.protectedSpans.some((span) => span.text === 'dev@example.com'), true)
  assert.equal(unit.protectedSpans.some((span) => span.text.startsWith('/tmp/report.pdf')), true)
  assert.equal(unit.protectedSpans.some((span) => span.text === '42'), true)
  assert.equal(unit.protectedSpans.some((span) => span.text === 'https://example.com/docs'), true)
  assert.equal(new Set(unit.protectedSpans.map((span) => span.placeholder)).size, unit.protectedSpans.length)
})

test('源文本已包含保留协议时必须拒绝或安全避碰，不能覆盖原有内容', () => {
  const source = model([textBlock(
    'reserved',
    'The token [[[ST-DOC-PROTECTED-0001]]] belongs to the author.'
  )])
  const [unit] = collectDocumentTranslationUnits(source)
  assert.ok(unit)

  const protectedText = createDocumentProtectedText(unit)

  assert.equal(protectedText.safe, false)
  if (protectedText.safe) return
  assert.equal(protectedText.code, 'reserved-placeholder')
})

test('占位符缺失、重复、乱序和损坏必须返回稳定校验错误', () => {
  const source = model([textBlock(
    'validation',
    'Keep https://example.com and 42.'
  )])
  const [unit] = collectDocumentTranslationUnits(source)
  assert.ok(unit)
  const protectedText = createDocumentProtectedText(unit)
  assert.equal(protectedText.safe, true)
  assert.deepEqual(validateDocumentProtectedText(protectedText.text, protectedText.spans), { ok: true })

  assert.deepEqual(validateDocumentProtectedText(
    protectedText.text.replace(protectedText.spans[0]!.placeholder, ''),
    protectedText.spans
  ).code, 'missing')
  assert.deepEqual(validateDocumentProtectedText(
    `${protectedText.text} ${protectedText.spans[0]!.placeholder}`,
    protectedText.spans
  ).code, 'duplicate')
  const reordered = `${protectedText.spans[1]!.placeholder} ${protectedText.spans[0]!.placeholder}`
  assert.deepEqual(validateDocumentProtectedText(reordered, protectedText.spans).code, 'out-of-order')
  assert.deepEqual(validateDocumentProtectedText(
    protectedText.text.replace(protectedText.spans[0]!.placeholder, '[[[ST-DOC-PROTECTED-BROKEN]]]'),
    protectedText.spans
  ).code, 'corrupt')
})

test('受保护文本恢复后必须把全部不可翻译片段原位还原', () => {
  const source = model([textBlock(
    'restore',
    'Read https://example.com and run 42.'
  )])
  const [unit] = collectDocumentTranslationUnits(source)
  assert.ok(unit)
  const protectedText = createDocumentProtectedText(unit)

  const restored = restoreDocumentProtectedText(
    protectedText.text.replace('Read', '阅读').replace('and run', '并运行'),
    protectedText.spans
  )

  assert.equal(restored.ok, true)
  if (!restored.ok) return
  assert.equal(restored.text, '阅读 https://example.com 并运行 42.')
})

test('术语表必须按语言方向匹配，并只生成受控上下文', () => {
  const glossary: DocumentGlossary = {
    version: 'glossary-v2',
    entries: [
      { source: 'workspace', target: '工作区', sourceLang: 'EN', targetLang: 'ZH' },
      { source: 'workspace', target: 'espace de travail', sourceLang: 'EN', targetLang: 'FR' },
      { source: 'cache', target: '缓存', sourceLang: 'EN', targetLang: 'ZH' }
    ]
  }
  const source = model([textBlock('terms', 'The workspace uses a cache.')])
  const [unit] = collectDocumentTranslationUnits(source)
  assert.ok(unit)

  const result = applyDocumentGlossary(unit, glossary, languagePair())

  assert.deepEqual(result.matches.map((match) => match.target), ['工作区', '缓存'])
  assert.match(result.context, /workspace => 工作区/u)
  assert.match(result.context, /cache => 缓存/u)
  assert.equal(result.context.includes('espace de travail'), false)
  assert.equal(result.glossaryVersion, 'glossary-v2')
})

test('术语表变化必须同时改变术语版本和缓存键', () => {
  const context = cacheContext()
  const first = buildDocumentTranslationCacheKey(context)
  const changed = buildDocumentTranslationCacheKey({
    ...context,
    glossaryVersion: 'glossary-v3'
  })
  const changedRules = buildDocumentTranslationCacheKey({
    ...context,
    protectionRulesVersion: 'protection-v2'
  })

  assert.notEqual(first, changed)
  assert.notEqual(first, changedRules)
})

test('缓存键必须包含文件哈希、解析器、实际语言方向、模型、术语和保护版本', () => {
  const context = cacheContext()
  const key = buildDocumentTranslationCacheKey(context)

  assert.match(key, /file-sha-256/u)
  assert.match(key, /parser-v4/u)
  assert.match(key, /EN/u)
  assert.match(key, /ZH/u)
  assert.match(key, /provider-a:model-b/u)
  assert.match(key, /glossary-v2/u)
  assert.match(key, /protection-v1/u)
  assert.notEqual(key, buildDocumentTranslationCacheKey({
    ...context,
    languagePair: { ...context.languagePair, sourceLang: 'FR' }
  }))
  assert.notEqual(key, buildDocumentTranslationCacheKey({
    ...context,
    languagePair: { ...context.languagePair, targetLang: 'JA' }
  }))
  assert.notEqual(key, buildDocumentTranslationCacheKey({ ...context, modelFingerprint: 'provider-a:model-c' }))
  assert.notEqual(key, buildDocumentTranslationCacheKey({ ...context, fileSha256: 'other-file' }))
  assert.notEqual(key, buildDocumentTranslationCacheKey({ ...context, parserVersion: 'parser-v5' }))
})

test('失败、取消、疑似未翻译、空译文和不完整结果不得写入成功缓存', () => {
  const context = cacheContext()
  const successful = {
    sourceSha256: context.fileSha256,
    languagePair: languagePair(),
    glossaryVersion: context.glossaryVersion,
    protectionRulesVersion: context.protectionRulesVersion,
    status: 'completed' as const,
    translation: '已完成'
  }

  assert.equal(parseDocumentTranslationCacheEntry(context, successful).ok, true)
  for (const status of ['failed', 'cancelled', 'partial'] as const) {
    const parsed = parseDocumentTranslationCacheEntry(context, { ...successful, status })
    assert.equal(parsed.ok, false)
  }
  assert.equal(parseDocumentTranslationCacheEntry(context, {
    ...successful,
    suspectUntranslated: true
  }).ok, false)
  assert.equal(parseDocumentTranslationCacheEntry(context, {
    ...successful,
    translation: ''
  }).ok, false)
  assert.equal(parseDocumentTranslationCacheEntry(context, {
    ...successful,
    incomplete: true
  }).ok, false)
  assert.equal(parseDocumentTranslationCacheEntry({
    ...context,
    languagePair: { sourceLang: 'EN', targetLang: 'JA' }
  }, successful).ok, false)
})

/**
 * 构造缓存键测试上下文。
 * @returns 完整缓存上下文。
 * @author zhenghq
 */
function cacheContext(): DocumentTranslationCacheContext {
  return {
    fileSha256: 'file-sha-256',
    parserVersion: 'parser-v4',
    languagePair: languagePair(),
    modelFingerprint: 'provider-a:model-b',
    glossaryVersion: 'glossary-v2',
    protectionRulesVersion: 'protection-v1'
  }
}

test('现有流水线必须保持并发、失败隔离和取消语义', async () => {
  const source = model(Array.from({ length: 12 }, (_, index) =>
    textBlock(`block-${index + 1}`, `Sentence ${index + 1}.`)
  ))
  let active = 0
  let maxActive = 0
  const deps = pipelineDeps(async (text) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    if (text.includes('Sentence 3')) throw new Error('provider failed')
    return `T(${text})`
  })
  deps.parse = async () => source

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-shared', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(maxActive <= 3, true)
  assert.equal(result.task.status, 'partial')
  assert.equal(result.failedTargetIds?.length, 1)
})

test('现有流水线取消后必须返回 cancelled 且不再发起新请求', async () => {
  const source = model([
    textBlock('block-1', 'First sentence.'),
    textBlock('block-2', 'Second sentence.')
  ])
  const controller = new AbortController()
  let calls = 0
  const deps = pipelineDeps(async (text) => {
    calls += 1
    controller.abort()
    return `T(${text})`
  })
  deps.parse = async () => source
  deps.concurrency = 1

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-cancel', 1),
    controller.signal,
    deps
  )

  assert.equal(result.task.status, 'cancelled')
  assert.equal(calls, 1)
})
