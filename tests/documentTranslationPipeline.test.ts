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
  createDocumentTaskState,
  type DocumentTaskState
} from '../src/shared/documentTask.ts'
import {
  runDocumentTranslationPipeline,
  retryFailedDocumentTranslationPipeline,
  type DocumentPipelineDeps
} from '../src/main/documentTranslationPipeline.ts'
import { parseHtmlDocument, parseMarkdownDocument } from '../src/main/documentTextParser.ts'
import { DOCUMENT_OCR_UNIFORM_FONT_SIZE } from '../src/shared/documentOcrLayout.ts'
import type { DocumentLanguagePair } from '../src/shared/documentLanguageDirection.ts'
import {
  buildDocumentTranslationCacheKey,
  DOCUMENT_PROTECTION_RULES_VERSION,
  DOCUMENT_TRANSLATION_PROTOCOL_VERSION,
  type DocumentGlossary,
  type DocumentTranslationCacheEntry
} from '../src/shared/documentTranslation.ts'

/**
 * 构造测试用文本区块。
 * @param blockId 区块标识。
 * @param runs 文本片段。
 * @param role 文本角色。
 * @returns 文本区块。
 * @author zhenghq
 */
function textBlock(
  blockId: string,
  runs: DocumentTextBlock['runs'],
  role: DocumentTextBlock['role'] = 'paragraph'
): DocumentTextBlock {
  return {
    kind: 'text',
    blockId,
    readingOrder: 0,
    translatable: true,
    role,
    runs
  }
}

/**
 * 构造测试用文档。
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
 * 构造测试用表格区块，每个单元格只包含一个可翻译文本 run。
 * @param blockId 表格区块标识。
 * @param rows 按行列排列的单元格文本。
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
          [{ runId: `${blockId}-run-${rowIndex + 1}-${cellIndex + 1}`, text }]
        )]
      }))
    }))
  }
}

/**
 * 收集流水线阶段。
 * @returns 进度收集器。
 * @author zhenghq
 */
function progressCollector(): { states: DocumentTaskState[]; onProgress: (state: DocumentTaskState) => void } {
  const states: DocumentTaskState[] = []
  return { states, onProgress: (state) => states.push(state) }
}

/**
 * 收集流水线发布的部分译文。
 * @returns 部分译文收集器。
 * @author zhenghq
 */
function translationCollector(): {
  translations: DocumentModel[]
  publishTranslation: (translation: DocumentModel) => void
} {
  const translations: DocumentModel[] = []
  return { translations, publishTranslation: (translation) => translations.push(translation) }
}

/**
 * 构造固定语言对，用于验证所有翻译路径复用同一方向。
 * @returns 任务级语言对。
 * @author zhenghq
 */
function fixedLanguagePair(): DocumentLanguagePair {
  return { sourceLang: 'auto', targetLang: 'ZH' }
}

/**
 * 模拟翻译服务逐段处理合并批次，并在返回时保留协议标记。
 * @param text 发送给翻译服务的完整批次文本。
 * @param transform 单段译文转换函数。
 * @returns 保留分段标记的整批译文。
 * @author zhenghq
 */
function translateMergedText(text: string, transform: (part: string) => string): string {
  /**
   * 在表格行内部按单元格标记拆分，模拟模型逐单元格翻译但整行一次请求。
   * @param part 单个表格行或普通分段文本。
   * @returns 保留单元格标记的译文。
   * @author zhenghq
   */
  const translateCellParts = (part: string): string => part
    .split(/(\n\[\[\[ST-DOC-CELL-\d+\]\]\]\n)/u)
    .map((candidate) => /^\n\[\[\[ST-DOC-CELL-\d+\]\]\]\n$/u.test(candidate)
      ? candidate
      : transform(candidate))
    .join('')
  return text
    .split(/(\n\[\[\[ST-SEG-\d+\]\]\]\n)/u)
    .map((part) => /^\n\[\[\[ST-SEG-\d+\]\]\]\n$/u.test(part) ? part : translateCellParts(part))
    .join('')
}

test('同一文本块连续可翻译 run 必须作为一个大目标发送并保留 runId', async () => {
  const source = model([textBlock('block-1', [
    { runId: 'run-1', text: 'Hello ' },
    { runId: 'run-2', text: 'world' }
  ])])
  const calls: string[] = []
  const progress = progressCollector()
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text, _signal, _languagePair, _onDelta) => {
      calls.push(text)
      return translateMergedText(text, (part) => `译:${part}`)
    },
    onProgress: progress.onProgress
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1, 2, 3]) },
    createDocumentTaskState('job-1', 1),
    new AbortController().signal,
    deps,
    fixedLanguagePair()
  )

  assert.deepEqual(calls, ['Hello world'])
  assert.equal(result.task.status, 'completed')
  assert.equal(result.source.pages[0]!.blocks[0]!.kind, 'text')
  const translated = result.translation.pages[0]!.blocks[0] as DocumentTextBlock
  assert.deepEqual(translated.runs.map((run) => run.runId), ['run-1', 'run-2'])
  assert.deepEqual(translated.runs.map((run) => run.text), ['译:Hello world', ''])
  assert.equal(progress.states.at(-1)?.status, 'completed')
})

test('同一文本块内样式不同的连续 run 必须分别翻译，避免整行被首个 run 样式覆盖', async () => {
  const source = model([textBlock('block-mixed-style', [
    { runId: 'run-bold', text: 'Important ', style: { fontSize: 24, fontWeight: 700 } },
    { runId: 'run-regular', text: 'details', style: { fontSize: 12, fontWeight: 400 } }
  ])])
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      return translateMergedText(text, (part) => `译:${part}`)
    },
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1, 2, 3]) },
    createDocumentTaskState('job-mixed-style', 1),
    new AbortController().signal,
    deps
  )

  assert.deepEqual(calls, [
    'Important\n[[[ST-SEG-0]]]\ndetails'
  ])
  const translated = result.translation.pages[0]!.blocks[0] as DocumentTextBlock
  assert.deepEqual(translated.runs.map((run) => run.text), ['译:Important ', '译:details'])
  assert.equal(translated.runs[0]?.style?.fontSize, 24)
  assert.equal(translated.runs[0]?.style?.fontWeight, 700)
  assert.equal(translated.runs[1]?.style?.fontSize, 12)
  assert.equal(translated.runs[1]?.style?.fontWeight, 400)
})

test('同一文本块被 protected run 分隔时按连续片段聚合且保留保护内容', async () => {
  const source = model([textBlock('block-1', [
    { runId: 'run-1', text: 'Before ' },
    { runId: 'run-2', text: 'https://example.com', protected: true },
    { runId: 'run-3', text: ' after' }
  ])])
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      return translateMergedText(text, (part) => `译:${part}`)
    },
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-protected-runs', 1),
    new AbortController().signal,
    deps
  )

  assert.deepEqual(calls, ['Before\n[[[ST-SEG-0]]]\nafter'])
  const translated = result.translation.pages[0]!.blocks[0] as DocumentTextBlock
  assert.deepEqual(translated.runs.map((run) => run.runId), ['run-1', 'run-2', 'run-3'])
  assert.deepEqual(translated.runs.map((run) => run.text), ['译:Before ', 'https://example.com', ' 译:after'])
})

test('目录块只翻译标题并保留点线、页码和目录元数据', async () => {
  const tocBlock: DocumentTextBlock = {
    ...textBlock('block-toc', [
      { runId: 'run-title', text: '2.1.3. Software installation' },
      { runId: 'run-leader', text: '.............................................................', protected: true },
      { runId: 'run-page', text: '2', protected: true }
    ]),
    toc: { pageNumber: '2' }
  }
  const source = model([tocBlock])
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      return translateMergedText(text, (part) => `译:${part}`)
    },
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/toc.pdf', fileName: 'toc.pdf', format: 'pdf', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-toc', 1),
    new AbortController().signal,
    deps
  )

  assert.deepEqual(calls, ['2.1.3. Software installation'])
  const translated = result.translation.pages[0]!.blocks[0] as DocumentTextBlock
  assert.equal(translated.toc?.pageNumber, '2')
  assert.deepEqual(translated.runs.map((run) => run.text), [
    '译:2.1.3. Software installation',
    '.............................................................',
    '2'
  ])
  assert.equal(translated.runs[1]?.protected, true)
  assert.equal(translated.runs[2]?.protected, true)
})

test('HTML SVG 扫描件解析后必须进入翻译流水线并生成可见译文', async () => {
  const input = {
    path: '/tmp/scanned.html',
    fileName: 'scanned.html',
    format: 'html' as const,
    sha256: 'scanned-html-fixture',
    bytes: new TextEncoder().encode([
      '<!doctype html><html><body>',
      '<svg><text x="0" y="20">机关档案</text></svg>',
      '<svg><text x="0" y="20">管理规定</text></svg>',
      '</body></html>'
    ].join(''))
  }
  const source = parseHtmlDocument(input)
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      return translateMergedText(text, (part) => `译:${part}`)
    },
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    input,
    createDocumentTaskState('job-html', 1),
    new AbortController().signal,
    deps
  )

  assert.deepEqual(calls, ['机关档案\n[[[ST-SEG-0]]]\n管理规定'])
  assert.equal(result.task.status, 'completed')
  assert.deepEqual(
    result.translation.pages[0]!.blocks.map((block) =>
      block.kind === 'text' ? block.runs.map((run) => run.text).join('') : ''),
    ['译:机关档案', '译:管理规定']
  )
})

test('AI 增量必须在当前 run 完成前持续发布部分译文', async () => {
  const source = model([textBlock('block-1', [{ runId: 'run-1', text: 'Hello world' }])])
  const published = translationCollector()
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (_text, _signal, _languagePair, onDelta) => {
      onDelta?.('你好')
      onDelta?.('，世界')
      return '你好，世界'
    },
    onProgress: () => undefined,
    publishTranslation: published.publishTranslation
  }

  await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-stream-single', 1),
    new AbortController().signal,
    deps
  )

  const streamed = published.translations
    .map((translation) => (translation.pages[0]!.blocks[0] as DocumentTextBlock).runs[0]!.text)
  assert.deepEqual(streamed.slice(1, 3), ['你好', '你好，世界'])
  assert.equal(streamed.at(-1), '你好，世界')
})

test('单目标流式预览后请求失败时必须恢复原文并标记 partial', async () => {
  const source = model([
    textBlock('block-1', [{ runId: 'run-1', text: 'Hello world' }]),
    textBlock('block-2', [{ runId: 'run-2', text: 'Second paragraph' }])
  ])
  const published = translationCollector()
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text, _signal, _languagePair, onDelta) => {
      if (text === 'Hello world') {
        onDelta?.('你好')
        throw new Error('provider failed after preview')
      }
      return '第二段'
    },
    onProgress: () => undefined,
    publishTranslation: published.publishTranslation,
    concurrency: 1
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-preview-failure', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(result.task.status, 'partial')
  assert.equal(
    (result.translation.pages[0]!.blocks[0] as DocumentTextBlock).runs[0]!.text,
    'Hello world'
  )
  assert.equal(
    (published.translations.at(-1)!.pages[0]!.blocks[0] as DocumentTextBlock).runs[0]!.text,
    'Hello world'
  )
  assert.deepEqual(result.completionReport?.failedTargetIds, ['0:0:text:run-1'])
})

test('同一目标多分段部分成功、部分失败时必须整体保留原文并归入失败', async () => {
  const firstPart = 'First sentence. '.repeat(120)
  const secondPart = 'Second sentence. '.repeat(120)
  const sourceText = `${firstPart}${secondPart}`
  const source = model([textBlock('block-1', [{ runId: 'run-1', text: sourceText }])])
  const published = translationCollector()
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      if (text.includes('Second sentence.')) throw new Error('second segment failed')
      return `译:${text}`
    },
    onProgress: () => undefined,
    publishTranslation: published.publishTranslation,
    concurrency: 1
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-segment-partial-failure', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(result.task.status, 'failed')
  assert.equal(result.task.failedBlocks, 1)
  assert.equal(
    (result.translation.pages[0]!.blocks[0] as DocumentTextBlock).runs[0]!.text,
    sourceText
  )
  assert.equal(
    (published.translations.at(-1)!.pages[0]!.blocks[0] as DocumentTextBlock).runs[0]!.text,
    sourceText
  )
  assert.deepEqual(result.retryableTargetIds, ['0:0:text:run-1'])
})

test('高频流式增量必须合并整页发布并保留首段即时反馈', async () => {
  const source = model([textBlock('block-1', [{ runId: 'run-1', text: 'Hello world' }])])
  const published = translationCollector()
  let countAfterFirstDelta = 0
  let countAfterAllDeltas = 0
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (_text, _signal, _languagePair, onDelta) => {
      onDelta?.('译')
      countAfterFirstDelta = published.translations.length
      for (let index = 1; index < 40; index += 1) onDelta?.(`文${index}`)
      countAfterAllDeltas = published.translations.length
      return `译文${Array.from({ length: 39 }, (_item, index) => index + 1).join('')}`
    },
    onProgress: () => undefined,
    publishTranslation: published.publishTranslation
  }

  await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-stream-throttle', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(countAfterFirstDelta, 2, '首个增量必须在 onDelta 返回前立即发布')
  assert.ok(countAfterAllDeltas <= 4, `同步增量发布次数应被合并，实际 ${countAfterAllDeltas}`)
  assert.ok(published.translations.length <= 5,
    `包含最终快照的发布次数应保持有限，实际 ${published.translations.length}`)
  assert.equal(
    (published.translations.at(-1)!.pages[0]!.blocks[0] as DocumentTextBlock).runs[0]!.text,
    `译文${Array.from({ length: 39 }, (_item, index) => index + 1).join('')}`
  )
})

test('未注入译文发布回调时仍必须持续推送翻译进度', async () => {
  const source = model([textBlock('block-1', [{ runId: 'run-1', text: 'Hello world' }])])
  const progress = progressCollector()
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => `译:${text}`,
    onProgress: progress.onProgress
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-progress-without-publish', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(result.task.status, 'completed')
  assert.equal(progress.states.some((state) => (
    state.phase === 'translate' && state.progress.completed === 1 && state.progress.total === 1
  )), true)
})

test('翻译阶段开始时必须立即发布完整原文占位模型，避免译文栏空白', async () => {
  const source = model([
    textBlock('block-1', [{ runId: 'run-1', text: 'Hello world' }]),
    textBlock('block-2', [{ runId: 'run-2', text: 'Second paragraph' }])
  ])
  const published = translationCollector()
  let resolveTranslation: ((translation: string) => void) | undefined
  let notifyTranslationStarted: (() => void) | undefined
  let sentText = ''
  const translationStarted = new Promise<void>((resolve) => {
    notifyTranslationStarted = resolve
  })
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      notifyTranslationStarted?.()
      sentText = text
      return new Promise<string>((resolve) => {
        resolveTranslation = resolve
      })
    },
    onProgress: () => undefined,
    publishTranslation: published.publishTranslation
  }

  const run = runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-merged-complete', 1),
    new AbortController().signal,
    deps
  )
  await Promise.race([
    translationStarted,
    new Promise<void>((resolve) => setTimeout(resolve, 100))
  ])

  assert.equal(published.translations.length, 1)
  assert.deepEqual(
    published.translations[0]!.pages[0]!.blocks.map((block) =>
      block.kind === 'text' ? block.runs.map((run) => run.text).join('') : ''),
    ['Hello world', 'Second paragraph']
  )
  assert.ok(resolveTranslation)
  assert.equal(sentText, 'Hello world\n[[[ST-SEG-0]]]\nSecond paragraph')
  resolveTranslation(translateMergedText(sentText, (part) => `译:${part}`))
  const result = await run
  assert.equal(result.task.status, 'completed')
  assert.deepEqual(
    result.translation.pages[0]!.blocks.map((block) =>
      block.kind === 'text' ? block.runs.map((run) => run.text).join('') : ''),
    ['译:Hello world', '译:Second paragraph']
  )
})

test('合并批次响应含分段标记时必须按标记流式预览且不丢正文', async () => {
  const source = model([
    textBlock('block-1', [{ runId: 'run-1', text: 'first' }]),
    textBlock('block-2', [{ runId: 'run-2', text: 'second' }])
  ])
  const published = translationCollector()
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (_text, _signal, _languagePair, onDelta) => {
      onDelta?.('译文一\n[[[ST-SEG-0]]]\n')
      onDelta?.('译文二')
      return '译文一\n[[[ST-SEG-0]]]\n译文二'
    },
    onProgress: () => undefined,
    publishTranslation: published.publishTranslation
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-merged-partial-marker', 1),
    new AbortController().signal,
    deps
  )

  assert.deepEqual(
    result.translation.pages[0]!.blocks.map((block) =>
      block.kind === 'text' ? block.runs.map((run) => run.text).join('') : ''),
    ['译文一', '译文二']
  )
  assert.deepEqual(
    published.translations.at(-1)!.pages[0]!.blocks.map((block) =>
      block.kind === 'text' ? block.runs.map((run) => run.text).join('') : ''),
    ['译文一', '译文二']
  )
})

test('合并批次完整响应必须保留普通方括号正文', async () => {
  const source = model([
    textBlock('block-1', [{ runId: 'run-1', text: 'source' }]),
    textBlock('block-2', [{ runId: 'run-2', text: 'next' }])
  ])
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async () => '[[[Source]]] 译文\n[[[ST-SEG-0]]]\n下一段',
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-merged-brackets', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(
    (result.translation.pages[0]!.blocks[0] as DocumentTextBlock).runs[0]!.text,
    '[[[Source]]] 译文'
  )
  assert.equal(
    (result.translation.pages[0]!.blocks[1] as DocumentTextBlock).runs[0]!.text,
    '下一段'
  )
})

test('合并批次流式预览必须保留普通方括号正文，只过滤残缺尾部分段标记', async () => {
  const source = model([
    textBlock('block-1', [{ runId: 'run-1', text: 'Hello world' }]),
    textBlock('block-2', [{ runId: 'run-2', text: 'Second paragraph' }])
  ])
  const published = translationCollector()
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (_text, _signal, _languagePair, onDelta) => {
      onDelta?.('[[[Source]]] 译文\n[[[ST-SEG-0]]]\n下一段\n[[[ST-')
      return '[[[Source]]] 译文\n[[[ST-SEG-0]]]\n下一段'
    },
    onProgress: () => undefined,
    publishTranslation: published.publishTranslation
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-1', 1),
    new AbortController().signal,
    deps
  )
  assert.equal(result.task.status, 'completed')
  const preview = published.translations.at(-1)!
  assert.equal((preview.pages[0]!.blocks[0] as DocumentTextBlock).runs[0]!.text, '[[[Source]]] 译文')
  assert.equal((preview.pages[0]!.blocks[1] as DocumentTextBlock).runs[0]!.text, '下一段')
  assert.deepEqual(
    result.translation.pages[0]!.blocks.map((block) =>
      block.kind === 'text' ? block.runs.map((run) => run.text).join('') : ''),
    ['[[[Source]]] 译文', '下一段']
  )
})

test('翻译流水线跳过公式、受保护与不可翻译区块', async () => {
  const source = model([
    textBlock('paragraph', [{ runId: 'p', text: 'translate me' }]),
    textBlock('protected', [{ runId: 'x', text: 'https://example.com', protected: true }]),
    textBlock('code', [{ runId: 'c', text: 'const a = 1', protected: true }], 'code'),
    {
      kind: 'formula',
      blockId: 'formula',
      readingOrder: 1,
      translatable: false,
      latex: 'x^2'
    }
  ])
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      return translateMergedText(text, (part) => `T(${part})`)
    },
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-1', 1),
    new AbortController().signal,
    deps
  )

  assert.deepEqual(calls, ['translate me'])
  const blocks = result.translation.pages[0]!.blocks
  assert.equal((blocks[1] as DocumentTextBlock).runs[0]!.text, 'https://example.com')
  assert.equal((blocks[2] as DocumentTextBlock).runs[0]!.text, 'const a = 1')
  assert.equal(blocks[3]!.kind, 'formula')
})

test('Markdown 代码块注释应进入翻译流水线并保留代码结构', async () => {
  const input = {
    path: '/tmp/config.md',
    fileName: 'config.md',
    format: 'markdown' as const,
    sha256: 'markdown-code-comments',
    bytes: new TextEncoder().encode([
      '```yaml',
      'borrow:',
      '  is-encrypt: true      #开启加密',
      'ext-pwd-plugin:',
      '  jar:',
      '    config:',
      '      enable: true',
      '      jarDir: D:\\tdr\\      #路径为插件包的路径',
      '```'
    ].join('\n'))
  }
  const source = parseMarkdownDocument(input)
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      return translateMergedText(text, (part) => `译:${part}`)
    },
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    input,
    createDocumentTaskState('job-markdown-code-comments', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(calls.length, 1)
  assert.match(calls[0]!, /开启加密/u)
  assert.match(calls[0]!, /路径为插件包的路径/u)
  assert.doesNotMatch(calls[0]!, /is-encrypt|jarDir/u)
  const code = result.translation.pages[0]!.blocks.find((block) => block.kind === 'text' && block.role === 'code')
  assert.equal(code?.kind, 'text')
  if (code?.kind !== 'text') return
  const translatedCode = code.runs.map((run) => run.text).join('')
  assert.match(translatedCode, /is-encrypt: true\s+#译:开启加密/u)
  assert.match(translatedCode, /jarDir: D:\\tdr\\\s+#译:路径为插件包的路径/u)
  assert.doesNotMatch(translatedCode, /译:is-encrypt|译:jarDir/u)
})

test('Markdown 无语言围栏中的提示词正文应完整进入翻译流水线', async () => {
  const input = {
    path: '/tmp/prompt.md',
    fileName: 'prompt.md',
    format: 'markdown' as const,
    sha256: 'markdown-untyped-fence',
    bytes: new TextEncoder().encode([
      '## 三、标准化输出模板',
      '```',
      '生成视频：',
      '【场景设定】',
      '{根据选定美术风格填充场景、光影、构图、环境细节}',
      '',
      '【整体视频要求】',
      '配音规范：全程使用固定真人音色，角色对应专属声线。',
      '```'
    ].join('\n'))
  }
  const source = parseMarkdownDocument(input)
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      return text.split('\n').map((line) => line ? `译:${line}` : line).join('\n')
    },
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    input,
    createDocumentTaskState('job-markdown-untyped-fence', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(calls.length, 1)
  assert.match(calls[0]!, /生成视频/u)
  assert.match(calls[0]!, /【场景设定】/u)
  assert.match(calls[0]!, /【整体视频要求】/u)
  assert.match(calls[0]!, /配音规范/u)
  const code = result.translation.pages[0]!.blocks.find((block) => block.kind === 'text' && block.role === 'code')
  assert.equal(code?.kind, 'text')
  if (code?.kind !== 'text') return
  const translatedCode = code.runs.map((run) => run.text).join('')
  assert.equal(translatedCode, [
    '译:生成视频：',
    '译:【场景设定】',
    '译:{根据选定美术风格填充场景、光影、构图、环境细节}',
    '',
    '译:【整体视频要求】',
    '译:配音规范：全程使用固定真人音色，角色对应专属声线。'
  ].join('\n'))
})

test('OCR 文本写入 ocrRegions 并参与后续翻译', async () => {
  const source = model([{
    kind: 'image',
    blockId: 'image-1',
    readingOrder: 0,
    translatable: false,
    assetId: 'asset-1'
  }])
  source.assets.push({ assetId: 'asset-1', kind: 'image', mimeType: 'image/png', sha256: 'a', byteLength: 3 })
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => new Uint8Array([1, 2, 3]),
    recognizeImage: async () => ({ text: 'OCR text', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      return `T(${text})`
    },
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.png', fileName: 'test.png', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-1', 1),
    new AbortController().signal,
    deps
  )

  const image = result.translation.pages[0]!.blocks[0]
  assert.equal(image.kind, 'image')
  assert.equal(image.ocrRegions?.[0]?.text, 'OCR text')
  assert.equal(image.ocrRegions?.[0]?.status, 'recognized')
  assert.deepEqual(calls, ['OCR text'])
  assert.equal(image.ocrRegions?.[0]?.translatedText, 'T(OCR text)')
})

test('低置信度 OCR 区域必须保留原文和图片并跳过翻译', async () => {
  const source = model([{
    kind: 'image',
    blockId: 'image-low-confidence',
    readingOrder: 0,
    translatable: false,
    assetId: 'asset-low-confidence'
  }])
  source.assets.push({
    assetId: 'asset-low-confidence',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'low-confidence',
    byteLength: 3
  })
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => new Uint8Array([1, 2, 3]),
    recognizeImage: async () => ({
      text: 'uncertain OCR content',
      lines: [{ text: 'uncertain OCR content', confidence: 0.35 }],
      engine: 'system'
    }),
    translate: async (text) => {
      calls.push(text)
      return `T(${text})`
    },
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.png', fileName: 'test.png', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-low-confidence', 1),
    new AbortController().signal,
    deps
  )

  const image = result.translation.pages[0]!.blocks[0]
  assert.equal(image.kind, 'image')
  if (image.kind !== 'image') return
  assert.equal(image.assetId, 'asset-low-confidence')
  assert.equal(image.ocrRegions?.[0]?.text, 'uncertain OCR content')
  assert.equal(image.ocrRegions?.[0]?.status, 'skipped')
  assert.equal(image.ocrRegions?.[0]?.reason, 'low-confidence')
  assert.deepEqual(calls, [])
  const warning = result.translation.warnings.find((candidate) => candidate.code === 'ocr-low-confidence')
  assert.equal(warning?.pageId, source.pages[0]!.pageId)
  assert.equal(warning?.blockId, image.blockId)
})

test('多页重复页眉装饰小图必须跳过 OCR，但正文小图仍要识别', async () => {
  const source = model([
    {
      kind: 'image',
      blockId: 'header-image-1',
      readingOrder: 0,
      translatable: false,
      assetId: 'header-asset-1',
      bbox: { x: 360, y: 40, width: 20, height: 20 }
    },
    {
      kind: 'image',
      blockId: 'body-image-1',
      readingOrder: 1,
      translatable: false,
      assetId: 'body-asset-1',
      bbox: { x: 100, y: 360, width: 20, height: 20 }
    }
  ])
  source.source.format = 'pdf'
  source.assets.push(
    { assetId: 'header-asset-1', kind: 'image', mimeType: 'image/png', sha256: 'header-1', byteLength: 3 },
    { assetId: 'body-asset-1', kind: 'image', mimeType: 'image/png', sha256: 'body-1', byteLength: 3 }
  )
  source.pages = Array.from({ length: 3 }, (_, pageIndex) => ({
    pageId: `page-${pageIndex + 1}`,
    index: pageIndex,
    width: 600,
    height: 800,
    blocks: [
      {
        kind: 'image' as const,
        blockId: `header-image-${pageIndex + 1}`,
        readingOrder: 0,
        translatable: false,
        assetId: `header-asset-${pageIndex + 1}`,
        bbox: { x: 360, y: 40, width: 20, height: 20 }
      },
      ...(pageIndex === 0 ? [{
        kind: 'image' as const,
        blockId: 'body-image-1',
        readingOrder: 1,
        translatable: false,
        assetId: 'body-asset-1',
        bbox: { x: 100, y: 360, width: 20, height: 20 }
      }] : [])
    ]
  }))
  source.assets = [
    ...Array.from({ length: 3 }, (_, pageIndex) => ({
      assetId: `header-asset-${pageIndex + 1}`,
      kind: 'image' as const,
      mimeType: 'image/png',
      sha256: `header-${pageIndex + 1}`,
      byteLength: 3
    })),
    { assetId: 'body-asset-1', kind: 'image', mimeType: 'image/png', sha256: 'body-1', byteLength: 3 }
  ]
  let recognizeCalls = 0
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => new Uint8Array([1, 2, 3]),
    recognizeImage: async () => {
      recognizeCalls += 1
      return { text: '正文截图', lines: [], engine: 'system' }
    },
    translate: async (text) => `T(${text})`,
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.pdf', fileName: 'test.pdf', format: 'pdf', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-decorative-header', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(recognizeCalls, 1)
  const headers = result.translation.pages.map((page) => page.blocks[0])
  assert.equal(headers.every((block) => block?.kind === 'image' &&
    block.ocrRegions?.[0]?.status === 'skipped' &&
    block.ocrRegions[0].reason === 'decorative-image'), true)
  const body = result.translation.pages[0]!.blocks[1]
  assert.equal(body?.kind === 'image' ? body.ocrRegions?.[0]?.text : undefined, '正文截图')
  assert.equal(body?.kind === 'image' ? body.ocrRegions?.[0]?.translatedText : undefined, 'T(正文截图)')
})

test('同一图片资源跨页复用时 OCR 只执行一次', async () => {
  const source = model([])
  source.source.format = 'pdf'
  source.assets.push({
    assetId: 'shared-asset',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'shared-image',
    byteLength: 3
  })
  source.pages = Array.from({ length: 2 }, (_, pageIndex) => ({
    pageId: `page-${pageIndex + 1}`,
    index: pageIndex,
    width: 600,
    height: 800,
    blocks: [{
      kind: 'image' as const,
      blockId: `shared-image-${pageIndex + 1}`,
      readingOrder: 0,
      translatable: false,
      assetId: 'shared-asset',
      bbox: { x: 100 + pageIndex * 100, y: 360, width: 80, height: 60 }
    }]
  }))
  let recognizeCalls = 0
  let loadCalls = 0
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => {
      loadCalls += 1
      return new Uint8Array([1, 2, 3])
    },
    recognizeImage: async () => {
      recognizeCalls += 1
      return { text: '共享图片文字', lines: [], engine: 'system' }
    },
    translate: async (text) => `T(${text})`,
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.pdf', fileName: 'test.pdf', format: 'pdf', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-shared-image', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(loadCalls, 1)
  assert.equal(recognizeCalls, 1)
  assert.deepEqual(
    result.translation.pages.map((page) => page.blocks[0]?.kind === 'image'
      ? page.blocks[0].ocrRegions?.[0]?.text
      : undefined),
    ['共享图片文字', '共享图片文字']
  )
})

test('表格单元格内的图片必须参与 OCR 并生成可切换的原文', async () => {
  const source = model([{
    kind: 'table',
    blockId: 'table-with-image',
    readingOrder: 0,
    translatable: true,
    rows: [{
      rowId: 'table-with-image-row-1',
      cells: [{
        cellId: 'table-with-image-cell-1',
        rowSpan: 1,
        colSpan: 1,
        blocks: [{
          kind: 'image' as const,
          blockId: 'cell-image-1',
          readingOrder: 0,
          translatable: false,
          assetId: 'cell-image-asset',
          bbox: { x: 40, y: 120, width: 200, height: 80 }
        }]
      }]
    }]
  }])
  source.source.format = 'pdf'
  source.assets.push({
    assetId: 'cell-image-asset',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'cell-image',
    byteLength: 3
  })
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => new Uint8Array([1, 2, 3]),
    recognizeImage: async () => ({ text: '单元格图片原文', lines: [], engine: 'system' }),
    translate: async (text) => `T(${text})`,
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.pdf', fileName: 'test.pdf', format: 'pdf', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-table-image', 1),
    new AbortController().signal,
    deps
  )

  const sourceTable = result.source.pages[0]!.blocks[0]
  assert.equal(sourceTable.kind, 'table')
  if (sourceTable.kind !== 'table') return
  const sourceImage = sourceTable.rows[0]!.cells[0]!.blocks[0]
  assert.equal(sourceImage.kind, 'image')
  if (sourceImage.kind !== 'image') return
  assert.equal(sourceImage.ocrRegions?.[0]?.text, '单元格图片原文')

  const translationTable = result.translation.pages[0]!.blocks[0]
  assert.equal(translationTable.kind, 'table')
  if (translationTable.kind !== 'table') return
  const translationImage = translationTable.rows[0]!.cells[0]!.blocks[0]
  assert.equal(translationImage.kind, 'image')
  if (translationImage.kind !== 'image') return
  assert.equal(translationImage.ocrRegions?.[0]?.translatedText, 'T(单元格图片原文)')
})

test('OCR 达到图片预算后必须跳过新资源且不加载或识别', async () => {
  const source = model([
    {
      kind: 'image',
      blockId: 'image-1',
      readingOrder: 0,
      translatable: false,
      assetId: 'asset-1'
    },
    {
      kind: 'image',
      blockId: 'image-2',
      readingOrder: 1,
      translatable: false,
      assetId: 'asset-2'
    }
  ])
  source.assets.push(
    { assetId: 'asset-1', kind: 'image', mimeType: 'image/png', sha256: 'image-a', byteLength: 3 },
    { assetId: 'asset-2', kind: 'image', mimeType: 'image/png', sha256: 'image-b', byteLength: 3 }
  )
  const loadedAssets: string[] = []
  const recognizedTexts: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async (asset) => {
      loadedAssets.push(asset.assetId)
      return new Uint8Array([asset.assetId === 'asset-1' ? 1 : 2])
    },
    recognizeImage: async (bytes) => {
      recognizedTexts.push(bytes[0] === 1 ? 'first image' : 'second image')
      return { text: bytes[0] === 1 ? 'first image' : 'second image', lines: [], engine: 'system' }
    },
    translate: async (text) => `T(${text})`,
    onProgress: () => undefined,
    maxOcrImages: 1
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.png', fileName: 'test.png', format: 'image', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-ocr-limit', 1),
    new AbortController().signal,
    deps
  )

  assert.deepEqual(loadedAssets, ['asset-1'])
  assert.deepEqual(recognizedTexts, ['first image'])
  const second = result.translation.pages[0]!.blocks[1]
  assert.equal(second?.kind === 'image' ? second.ocrRegions?.[0]?.status : undefined, 'skipped')
  assert.equal(second?.kind === 'image' ? second.ocrRegions?.[0]?.reason : undefined, 'ocr-limit-reached')
  assert.equal(result.translation.warnings.some((warning) => warning.code === 'ocr-limit-reached'), true)
})

test('OCR 图片预算按资源哈希去重且缓存命中不重复占用名额', async () => {
  const source = model([
    {
      kind: 'image',
      blockId: 'image-1',
      readingOrder: 0,
      translatable: false,
      assetId: 'asset-1'
    }
  ])
  source.assets.push(
    { assetId: 'asset-1', kind: 'image', mimeType: 'image/png', sha256: 'shared-image', byteLength: 3 }
  )
  source.pages.push({
    pageId: 'page-2',
    index: 1,
    width: 600,
    height: 800,
    blocks: [{
      kind: 'image',
      blockId: 'image-2',
      readingOrder: 0,
      translatable: false,
      assetId: 'asset-2'
    }]
  })
  source.assets.push(
    { assetId: 'asset-2', kind: 'image', mimeType: 'image/png', sha256: 'shared-image', byteLength: 3 }
  )
  let loadCalls = 0
  let recognizeCalls = 0
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => {
      loadCalls += 1
      return new Uint8Array([1, 2, 3])
    },
    recognizeImage: async () => {
      recognizeCalls += 1
      return { text: '共享文字', lines: [], engine: 'system' }
    },
    translate: async (text) => `T(${text})`,
    onProgress: () => undefined,
    maxOcrImages: 1
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.png', fileName: 'test.png', format: 'image', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-ocr-dedup', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(loadCalls, 1)
  assert.equal(recognizeCalls, 1)
  assert.deepEqual(
    result.translation.pages.map((page) => page.blocks[0]?.kind === 'image'
      ? page.blocks[0].ocrRegions?.[0]?.text
      : undefined),
    ['共享文字', '共享文字']
  )
  assert.equal(result.translation.warnings.some((warning) => warning.code === 'ocr-limit-reached'), false)
})

test('OCR 未识别到文字时必须生成可展示告警并保留跳过状态', async () => {
  const source = model([{
    kind: 'image',
    blockId: 'image-1',
    readingOrder: 0,
    translatable: false,
    assetId: 'asset-1'
  }])
  source.assets.push({ assetId: 'asset-1', kind: 'image', mimeType: 'image/png', sha256: 'a', byteLength: 3 })
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => new Uint8Array([1, 2, 3]),
    recognizeImage: async () => ({ text: '   ', lines: [], engine: 'system' }),
    translate: async (text) => `T(${text})`,
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.png', fileName: 'test.png', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-1', 1),
    new AbortController().signal,
    deps
  )

  const image = result.translation.pages[0]!.blocks[0]
  assert.equal(image.kind === 'image' ? image.ocrRegions?.[0]?.status : undefined, 'skipped')
  assert.equal(image.kind === 'image' ? image.ocrRegions?.[0]?.reason : undefined, 'no-text')
  const warning = result.translation.warnings.find((candidate) => candidate.code === 'ocr-no-text')
  assert.equal(warning?.pageId, source.pages[0]!.pageId)
  assert.equal(warning?.blockId, image.blockId)
})

test('OCR 识别异常时必须生成可展示告警并保留失败状态', async () => {
  const source = model([{
    kind: 'image',
    blockId: 'image-1',
    readingOrder: 0,
    translatable: false,
    assetId: 'asset-1'
  }])
  source.assets.push({ assetId: 'asset-1', kind: 'image', mimeType: 'image/png', sha256: 'a', byteLength: 3 })
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => new Uint8Array([1, 2, 3]),
    recognizeImage: async () => {
      throw new Error('ocr unavailable')
    },
    translate: async (text) => `T(${text})`,
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.png', fileName: 'test.png', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-1', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(result.task.status, 'partial')
  const image = result.translation.pages[0]!.blocks[0]
  assert.equal(image.kind === 'image' ? image.ocrRegions?.[0]?.status : undefined, 'failed')
  assert.equal(image.kind === 'image' ? image.ocrRegions?.[0]?.reason : undefined, 'ocr-failed')
  const warning = result.translation.warnings.find((candidate) => candidate.code === 'ocr-failed')
  assert.equal(warning?.pageId, source.pages[0]!.pageId)
  assert.equal(warning?.blockId, image.blockId)
})

test('OCR 多行结果必须生成归一化局部区域并按区域翻译', async () => {
  const source = model([{
    kind: 'image',
    blockId: 'image-1',
    readingOrder: 0,
    translatable: false,
    assetId: 'asset-1',
    bbox: { x: 40, y: 60, width: 400, height: 200 }
  }])
  source.assets.push({ assetId: 'asset-1', kind: 'image', mimeType: 'image/png', sha256: 'a', byteLength: 3 })
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => new Uint8Array([1, 2, 3]),
    recognizeImage: async () => ({
      text: 'first line\nsecond line',
      lines: [
        { text: 'first line', confidence: 0.9, box: { x: 20, y: 30, width: 180, height: 20 } },
        { text: 'second line', confidence: 0.8, box: { x: 30, y: 80, width: 220, height: 24 } }
      ],
      engine: 'system'
    }),
    translate: async (text) => {
      calls.push(text)
      return `T(${text})`
    },
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.png', fileName: 'test.png', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-1', 1),
    new AbortController().signal,
    deps
  )

  const image = result.translation.pages[0]!.blocks[0]
  assert.equal(image.kind, 'image')
  assert.equal(image.ocrRegions?.length, 2)
  assert.deepEqual(image.ocrRegions?.[0]?.bbox, { x: 0.05, y: 0.15, width: 0.45, height: 0.1 })
  assert.equal(image.ocrRegions?.[0]?.text, 'first line')
  assert.equal(image.ocrRegions?.[0]?.style?.fontSize, DOCUMENT_OCR_UNIFORM_FONT_SIZE)
  assert.equal(image.ocrRegions?.[1]?.text, 'second line')
  assert.equal(image.ocrRegions?.[1]?.style?.fontSize, DOCUMENT_OCR_UNIFORM_FONT_SIZE)
  // OCR 区域之间禁止合并，避免模型吞掉前序标记后把译文整体写到上一区域。
  assert.deepEqual(calls, ['first line', 'second line'])
})

test('文档翻译每批最多合并五十个短目标以优先减少请求数', async () => {
  const source = model(Array.from({ length: 60 }, (_, index) => textBlock(
    `block-${index + 1}`,
    [{ runId: `run-${index + 1}`, text: `text-${index + 1}` }]
  )))
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      return translateMergedText(text, (part) => part)
    },
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-batch-limit', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(calls.length, 2)
  assert.ok(calls.some((call) => /text-1[\s\S]*ST-SEG-48[\s\S]*text-50/u.test(call)))
  assert.ok(calls.some((call) => /text-51[\s\S]*ST-SEG-8[\s\S]*text-60/u.test(call)))
  assert.equal(result.task.status, 'completed')
  const translatedRuns = result.translation.pages[0]!.blocks.map((block) =>
    (block as DocumentTextBlock).runs[0]!.text
  )
  assert.deepEqual(translatedRuns, Array.from({ length: 60 }, (_, index) => `text-${index + 1}`))
})

test('表格文本必须在字符上限内按大块翻译并保持单元格对应关系', async () => {
  const source = model([{
    kind: 'table',
    blockId: 'table-1',
    readingOrder: 0,
    translatable: true,
    rows: Array.from({ length: 3 }, (_, rowIndex) => ({
      rowId: `row-${rowIndex + 1}`,
      cells: Array.from({ length: 2 }, (_, cellIndex) => {
        const index = rowIndex * 2 + cellIndex + 1
        return {
          cellId: `cell-${index}`,
          rowSpan: 1,
          colSpan: 1,
          blocks: [textBlock(`cell-block-${index}`, [{
            runId: `cell-run-${index}`,
            text: `Cell ${String.fromCharCode(64 + index)}`
          }])]
        }
      })
    }))
  }])
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      return translateMergedText(text, (part) => `T(${part})`)
    },
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-table-batch', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(calls.length, 1)
  assert.match(calls[0]!, /Cell A[\s\S]*Cell B[\s\S]*Cell C[\s\S]*Cell D[\s\S]*Cell E[\s\S]*Cell F/u)
  assert.equal(calls[0]!.match(/ST-DOC-CELL-0/gu)?.length, 3)
  assert.equal(calls[0]!.match(/ST-SEG/gu)?.length, 2)
  const table = result.translation.pages[0]!.blocks[0]
  assert.equal(table.kind, 'table')
  if (table.kind !== 'table') return
  assert.deepEqual(table.rows.flatMap((row) => row.cells.map((cell) =>
    (cell.blocks[0] as DocumentTextBlock).runs[0]!.text
  )), ['T(Cell A)', 'T(Cell B)', 'T(Cell C)', 'T(Cell D)', 'T(Cell E)', 'T(Cell F)'])
})

test('非 PDF 表格单元格内的真实段落必须在译文中保留换行边界', async () => {
  const source = model([{
    kind: 'table',
    blockId: 'table-multiline-cell',
    readingOrder: 0,
    translatable: true,
    rows: [{
      rowId: 'table-multiline-cell-row',
      cells: [{
        cellId: 'table-multiline-cell-cell',
        rowSpan: 1,
        colSpan: 1,
        blocks: [
          textBlock('table-multiline-cell-line-1', [{
            runId: 'table-multiline-cell-run-1',
            text: 'First source line'
          }]),
          textBlock('table-multiline-cell-line-2', [{
            runId: 'table-multiline-cell-run-2',
            text: 'Second source line'
          }])
        ]
      }]
    }]
  }])
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      return translateMergedText(text, (part) => `T(${part})`)
    },
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-table-multiline-cell', 1),
    new AbortController().signal,
    deps
  )

  assert.deepEqual(calls, ['First source line\nSecond source line'])
  const table = result.translation.pages[0]!.blocks[0]
  assert.equal(table.kind, 'table')
  if (table.kind !== 'table') return
  const firstCellBlock = table.rows[0]!.cells[0]!.blocks[0] as DocumentTextBlock
  assert.equal(firstCellBlock.runs[0]!.text, 'T(First source line\nSecond source line)')
})

test('PDF 表格单元格的视觉行必须合并为连续译文，不能沿用原文断行', async () => {
  const source = model([{
    kind: 'table',
    blockId: 'table-pdf-visual-lines',
    readingOrder: 0,
    translatable: true,
    rows: [{
      rowId: 'table-pdf-visual-lines-row',
      cells: [{
        cellId: 'table-pdf-visual-lines-cell',
        rowSpan: 1,
        colSpan: 1,
        blocks: [
          textBlock('table-pdf-visual-line-1', [{
            runId: 'table-pdf-visual-run-1',
            text: 'First source line'
          }]),
          textBlock('table-pdf-visual-line-2', [{
            runId: 'table-pdf-visual-run-2',
            text: 'Second source line'
          }])
        ]
      }]
    }]
  }])
  source.source.format = 'pdf'
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      return translateMergedText(text, (part) => `T(${part})`)
    },
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.pdf', fileName: 'test.pdf', format: 'pdf', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-table-pdf-visual-lines', 1),
    new AbortController().signal,
    deps
  )

  assert.deepEqual(calls, ['First source line Second source line'])
  const table = result.translation.pages[0]!.blocks[0]
  assert.equal(table.kind, 'table')
  if (table.kind !== 'table') return
  const firstCellBlock = table.rows[0]!.cells[0]!.blocks[0] as DocumentTextBlock
  assert.equal(firstCellBlock.runs[0]!.text, 'T(First source line Second source line)')
})

test('表格行请求丢失单元格标记时必须逐单元格回退翻译', async () => {
  const source = model([tableBlock('table-fallback', [[
    '题号',
    '一、单选题',
    '二、多选题',
    '三、判断题'
  ]])])
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      if (text.includes('ST-DOC-CELL')) return '模型丢失了单元格标记'
      return `T(${text})`
    },
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-table-cell-fallback', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(calls.length, 5)
  assert.match(calls[0]!, /题号[\s\S]*ST-DOC-CELL-0[\s\S]*一、单选题/u)
  assert.deepEqual(calls.slice(1), ['题号', '一、单选题', '二、多选题', '三、判断题'])
  assert.equal(result.task.status, 'completed')
  const table = result.translation.pages[0]!.blocks[0]
  assert.equal(table.kind, 'table')
  if (table.kind !== 'table') return
  assert.deepEqual(table.rows[0]!.cells.map((cell) =>
    (cell.blocks[0] as DocumentTextBlock).runs[0]!.text
  ), ['T(题号)', 'T(一、单选题)', 'T(二、多选题)', 'T(三、判断题)'])
})

test('超长表格行丢失单元格标记时回退译文不得与已有分段重复拼接', async () => {
  const firstCell = '甲'.repeat(1000)
  const secondCell = '乙'.repeat(1000)
  const source = model([tableBlock('table-long-fallback', [[firstCell, secondCell]])])
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      if (text.includes('ST-DOC-CELL')) {
        return text.replace(/\n\[\[\[ST-DOC-CELL-\d+\]\]\]\n/gu, '\n')
      }
      return `T(${text})`
    },
    onProgress: () => undefined,
    concurrency: 1
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-table-long-cell-fallback', 1),
    new AbortController().signal,
    deps,
    { sourcePreference: 'auto', targetPreference: 'ZH' }
  )

  assert.equal(result.task.status, 'completed')
  assert.equal(calls.length, 4)
  assert.deepEqual(calls.slice(-2), [firstCell, secondCell])
  const table = result.translation.pages[0]!.blocks[0]
  assert.equal(table.kind, 'table')
  if (table.kind !== 'table') return
  assert.deepEqual(table.rows[0]!.cells.map((cell) =>
    (cell.blocks[0] as DocumentTextBlock).runs[0]!.text
  ), [`T(${firstCell})`, `T(${secondCell})`])
})

test('超长表格行所在合并批次失败时只完成一次逐单元格回退', async () => {
  const firstCell = '甲'.repeat(920)
  const secondCell = '乙'.repeat(920)
  const source = model([
    tableBlock('table-long-merged-fallback', [[firstCell, secondCell]]),
    textBlock('paragraph-after-long-table', [{ runId: 'long-table-paragraph-run', text: '说明文字' }])
  ])
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      if (text.includes('ST-SEG')) return '模型丢失了分段标记'
      if (text.includes('ST-DOC-CELL')) {
        return text.replace(/\n\[\[\[ST-DOC-CELL-\d+\]\]\]\n/gu, '\n')
      }
      return `T(${text})`
    },
    onProgress: () => undefined,
    concurrency: 1
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-table-long-merged-fallback', 1),
    new AbortController().signal,
    deps,
    { sourcePreference: 'auto', targetPreference: 'ZH' }
  )

  assert.equal(result.task.status, 'completed')
  assert.equal(calls.some((text) => text.includes('ST-SEG')), true)
  assert.equal(calls.includes(firstCell), true)
  assert.equal(calls.includes(secondCell), true)
  const table = result.translation.pages[0]!.blocks[0]
  assert.equal(table.kind, 'table')
  if (table.kind !== 'table') return
  assert.deepEqual(table.rows[0]!.cells.map((cell) =>
    (cell.blocks[0] as DocumentTextBlock).runs[0]!.text
  ), [`T(${firstCell})`, `T(${secondCell})`])
  assert.equal((result.translation.pages[0]!.blocks[1] as DocumentTextBlock).runs[0]!.text, 'T(说明文字)')
})

test('合并批次保留分段标记但丢失单元格标记时必须只回退表格行', async () => {
  const source = model([
    tableBlock('table-merged', [['题号', '一、单选题']]),
    textBlock('paragraph-after-table', [{ runId: 'paragraph-run', text: '说明文字' }])
  ])
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      if (text.includes('ST-SEG')) return '整行译文\n[[[ST-SEG-0]]]\nT(说明文字)'
      return `T(${text})`
    },
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-table-merged-fallback', 1),
    new AbortController().signal,
    deps
  )

  assert.deepEqual(calls, [
    '题号\n[[[ST-DOC-CELL-0]]]\n一、单选题\n[[[ST-SEG-0]]]\n说明文字',
    '题号',
    '一、单选题'
  ])
  assert.equal(result.task.status, 'completed')
  const table = result.translation.pages[0]!.blocks[0]
  assert.equal(table.kind, 'table')
  if (table.kind !== 'table') return
  assert.deepEqual(table.rows[0]!.cells.map((cell) =>
    (cell.blocks[0] as DocumentTextBlock).runs[0]!.text
  ), ['T(题号)', 'T(一、单选题)'])
  assert.equal((result.translation.pages[0]!.blocks[1] as DocumentTextBlock).runs[0]!.text, 'T(说明文字)')
})

test('表格行逐单元格回退仍失败且无成功译文时必须标记失败并支持重新翻译', async () => {
  const source = model([tableBlock('table-retry', [['题号', '一、单选题']])])
  const calls: string[] = []
  let retrying = false
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      if (text.includes('ST-DOC-CELL')) return '模型丢失了单元格标记'
      if (!retrying && text === '一、单选题') throw new Error('provider failed')
      return `T(${text})`
    },
    onProgress: () => undefined,
    concurrency: 1
  }

  const initial = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-table-retry', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(initial.task.status, 'failed')
  assert.equal(initial.task.failedBlocks, 1)
  assert.equal(initial.completionReport?.status, 'failed')
  assert.equal(initial.retryableTargetIds?.length, 1)
  const initialTable = initial.translation.pages[0]!.blocks[0]
  assert.equal(initialTable.kind, 'table')
  if (initialTable.kind !== 'table') return
  assert.deepEqual(initialTable.rows[0]!.cells.map((cell) =>
    (cell.blocks[0] as DocumentTextBlock).runs[0]!.text
  ), ['题号', '一、单选题'])

  retrying = true
  calls.length = 0
  const retried = await retryFailedDocumentTranslationPipeline(
    initial.source,
    initial.translation,
    initial.retryableTargetIds!,
    { ...initial.task, generation: 2 },
    new AbortController().signal,
    deps,
    initial.languageResolution!
  )

  assert.equal(retried.task.status, 'completed')
  assert.deepEqual(retried.failedTargetIds, [])
  assert.equal(calls.length, 3)
  assert.match(calls[0]!, /ST-DOC-CELL/u)
  assert.deepEqual(calls.slice(1), ['题号', '一、单选题'])
  const retriedTable = retried.translation.pages[0]!.blocks[0]
  assert.equal(retriedTable.kind, 'table')
  if (retriedTable.kind !== 'table') return
  assert.deepEqual(retriedTable.rows[0]!.cells.map((cell) =>
    (cell.blocks[0] as DocumentTextBlock).runs[0]!.text
  ), ['T(题号)', 'T(一、单选题)'])
})

test('合并请求丢失分段标记时必须逐段回退翻译', async () => {
  const source = model([
    textBlock('block-1', [{ runId: 'run-1', text: 'first' }]),
    textBlock('block-2', [{ runId: 'run-2', text: 'second' }])
  ])
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      if (text.includes('ST-SEG')) return '模型丢失了分段标记'
      return `T(${text})`
    },
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-marker-fallback', 1),
    new AbortController().signal,
    deps
  )

  assert.deepEqual(calls, ['first\n[[[ST-SEG-0]]]\nsecond', 'first', 'second'])
  assert.equal(result.task.status, 'completed')
  assert.equal((result.translation.pages[0]!.blocks[0] as DocumentTextBlock).runs[0]!.text, 'T(first)')
  assert.equal((result.translation.pages[0]!.blocks[1] as DocumentTextBlock).runs[0]!.text, 'T(second)')
})

test('OCR 区域不得跨目标合并，避免模型吞并前序分隔标记后整体错位', async () => {
  const source = model([{
    kind: 'image',
    blockId: 'image-ocr-order',
    readingOrder: 0,
    translatable: false,
    assetId: 'asset-ocr-order',
    bbox: { x: 0, y: 0, width: 600, height: 800 },
    ocrRegions: [
      {
        regionId: 'ocr-title',
        pageId: 'page-1',
        blockId: 'image-ocr-order',
        assetId: 'asset-ocr-order',
        bbox: { x: 0.05, y: 0.05, width: 0.1, height: 0.02 },
        text: 'Agent2API',
        confidence: 0.99,
        status: 'recognized'
      },
      {
        regionId: 'ocr-status',
        pageId: 'page-1',
        blockId: 'image-ocr-order',
        assetId: 'asset-ocr-order',
        bbox: { x: 0.16, y: 0.04, width: 0.7, height: 0.02 },
        text: 'Reports Gateway Running · Not Logged In',
        confidence: 0.99,
        status: 'recognized'
      }
    ]
  }])
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      // 模拟模型把前两个短区域合并成一段，只保留第二个分隔标记的故障响应。
      if (text.includes('ST-SEG')) return 'Agent2API / Reports Gateway Running\n[[[ST-SEG-0]]]\nNot Logged In'
      return `T(${text})`
    },
    onProgress: () => undefined,
    concurrency: 1
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.png', fileName: 'test.png', format: 'png', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-ocr-order', 1),
    new AbortController().signal,
    deps
  )

  assert.deepEqual(calls, ['Agent2API', 'Reports Gateway Running · Not Logged In'])
  const image = result.translation.pages[0]!.blocks[0]
  assert.equal(image.kind, 'image')
  if (image.kind !== 'image') return
  assert.deepEqual(image.ocrRegions?.map((region) => region.translatedText), [
    'T(Agent2API)',
    'T(Reports Gateway Running · Not Logged In)'
  ])
})

test('三个 OCR 区域即使模拟模型重排后仍可解析，也必须独立翻译并按区域写回', async () => {
  const source = model([{
    kind: 'image',
    blockId: 'image-ocr-three-regions',
    readingOrder: 0,
    translatable: false,
    assetId: 'asset-ocr-three-regions',
    bbox: { x: 0, y: 0, width: 600, height: 800 },
    ocrRegions: [
      {
        regionId: 'ocr-title',
        pageId: 'page-1',
        blockId: 'image-ocr-three-regions',
        assetId: 'asset-ocr-three-regions',
        bbox: { x: 0.05, y: 0.05, width: 0.2, height: 0.04 },
        text: 'Agent2API',
        status: 'recognized'
      },
      {
        regionId: 'ocr-gateway',
        pageId: 'page-1',
        blockId: 'image-ocr-three-regions',
        assetId: 'asset-ocr-three-regions',
        bbox: { x: 0.3, y: 0.05, width: 0.2, height: 0.04 },
        text: 'Reports Gateway',
        status: 'recognized'
      },
      {
        regionId: 'ocr-status',
        pageId: 'page-1',
        blockId: 'image-ocr-three-regions',
        assetId: 'asset-ocr-three-regions',
        bbox: { x: 0.55, y: 0.05, width: 0.3, height: 0.04 },
        text: 'Running · Not Logged In',
        status: 'recognized'
      }
    ]
  }])
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      // 如果三个区域被错误合并，这个响应仍能通过标记数量与顺序校验，但语义已经错位。
      if (text.includes('ST-SEG')) {
        return 'Reports Gateway\n[[[ST-SEG-0]]]\nRunning · Not Logged In\n[[[ST-SEG-1]]]\nAgent2API'
      }
      return `T(${text})`
    },
    onProgress: () => undefined,
    concurrency: 1
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.png', fileName: 'test.png', format: 'png', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-ocr-three-regions', 1),
    new AbortController().signal,
    deps
  )

  assert.deepEqual(calls, ['Agent2API', 'Reports Gateway', 'Running · Not Logged In'])
  const image = result.translation.pages[0]!.blocks[0]
  assert.equal(image.kind, 'image')
  if (image.kind !== 'image') return
  assert.deepEqual(image.ocrRegions?.map((region) => [region.regionId, region.translatedText]), [
    ['ocr-title', 'T(Agent2API)'],
    ['ocr-gateway', 'T(Reports Gateway)'],
    ['ocr-status', 'T(Running · Not Logged In)']
  ])
})

test('OCR 重试必须按 regionId 回填，不能因译文模型区域顺序变化写到相邻区域', async () => {
  const source = model([{
    kind: 'image',
    blockId: 'image-ocr-retry',
    readingOrder: 0,
    translatable: false,
    assetId: 'asset-ocr-retry',
    bbox: { x: 0, y: 0, width: 600, height: 800 },
    ocrRegions: [
      {
        regionId: 'region-a',
        pageId: 'page-1',
        blockId: 'image-ocr-retry',
        assetId: 'asset-ocr-retry',
        bbox: { x: 0.05, y: 0.05, width: 0.2, height: 0.05 },
        text: 'Alpha',
        status: 'recognized'
      },
      {
        regionId: 'region-b',
        pageId: 'page-1',
        blockId: 'image-ocr-retry',
        assetId: 'asset-ocr-retry',
        bbox: { x: 0.05, y: 0.15, width: 0.2, height: 0.05 },
        text: 'Beta',
        status: 'recognized'
      }
    ]
  }])
  const initial = model([{
    ...(source.pages[0]!.blocks[0] as Extract<DocumentBlock, { kind: 'image' }>),
    ocrRegions: [
      {
        ...(source.pages[0]!.blocks[0] as Extract<DocumentBlock, { kind: 'image' }>).ocrRegions![1]!,
        translatedText: '旧译文 B'
      },
      {
        ...(source.pages[0]!.blocks[0] as Extract<DocumentBlock, { kind: 'image' }>).ocrRegions![0]!,
        translatedText: '旧译文 A'
      }
    ]
  }])
  let retrying = false
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      if (!retrying && text === 'Alpha') throw new Error('provider failed')
      return `T(${text})`
    },
    onProgress: () => undefined,
    concurrency: 1
  }

  const failed = await runDocumentTranslationPipeline(
    { path: '/tmp/test.png', fileName: 'test.png', format: 'png', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-ocr-region-retry', 1),
    new AbortController().signal,
    deps
  )
  assert.equal(failed.task.status, 'partial')

  retrying = true
  const retried = await retryFailedDocumentTranslationPipeline(
    failed.source,
    initial,
    ['0:0:ocr:region-a'],
    { ...failed.task, generation: 2 },
    new AbortController().signal,
    deps,
    failed.languageResolution!
  )

  assert.equal(retried.task.status, 'completed')
  const image = retried.translation.pages[0]!.blocks[0]
  assert.equal(image.kind, 'image')
  if (image.kind !== 'image') return
  assert.deepEqual(image.ocrRegions?.map((region) => [region.regionId, region.translatedText]), [
    ['region-b', '旧译文 B'],
    ['region-a', 'T(Alpha)']
  ])
})

test('文档翻译默认最多同时执行三个合并请求', async () => {
  const source = model(Array.from({ length: 80 }, (_, index) => textBlock(
    `block-${index + 1}`,
    [{ runId: `run-${index + 1}`, text: `${'text-'.padEnd(30, 'x')}${index + 1}` }]
  )))
  let active = 0
  let maxActive = 0
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return text
    },
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-concurrency', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(maxActive, 3)
  assert.equal(result.task.status, 'completed')
})

test('OCR 区域必须统一字号并保留居中、右对齐，供预览和 PDF 导出复用', async () => {
  const source = model([{
    kind: 'image',
    blockId: 'image-styled',
    readingOrder: 0,
    translatable: false,
    assetId: 'asset-styled',
    bbox: { x: 40, y: 60, width: 400, height: 200 }
  }])
  source.assets.push({ assetId: 'asset-styled', kind: 'image', mimeType: 'image/png', sha256: 'a', byteLength: 3 })
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => new Uint8Array([1, 2, 3]),
    recognizeImage: async () => ({
      text: 'centered\nright aligned',
      lines: [
        { text: 'centered', confidence: 0.95, box: { x: 100, y: 20, width: 200, height: 40 } },
        { text: 'right aligned', confidence: 0.9, box: { x: 200, y: 120, width: 180, height: 40 } }
      ],
      engine: 'system'
    }),
    translate: async (text) => `T(${text})`,
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.png', fileName: 'test.png', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-1', 1),
    new AbortController().signal,
    deps
  )

  const image = result.translation.pages[0]!.blocks[0]
  assert.equal(image.kind, 'image')
  assert.equal(image.ocrRegions?.[0]?.bbox.x, 0.25)
  assert.equal(image.ocrRegions?.[0]?.bbox.y, 0.1)
  assert.equal(image.ocrRegions?.[0]?.bbox.width, 0.5)
  assert.ok(Math.abs((image.ocrRegions?.[0]?.bbox.height ?? 0) - 0.2) < 1e-9)
  assert.equal(image.ocrRegions?.[0]?.textAlign, 'center')
  assert.equal(image.ocrRegions?.[0]?.style?.fontSize, DOCUMENT_OCR_UNIFORM_FONT_SIZE)
  assert.equal(image.ocrRegions?.[1]?.textAlign, 'right')
  assert.equal(image.ocrRegions?.[1]?.style?.fontSize, DOCUMENT_OCR_UNIFORM_FONT_SIZE)
})

test('OCR 结果缺少文本行边界时必须回退为整图区域', async () => {
  const source = model([{
    kind: 'image',
    blockId: 'image-1',
    readingOrder: 0,
    translatable: false,
    assetId: 'asset-1'
  }])
  source.assets.push({ assetId: 'asset-1', kind: 'image', mimeType: 'image/png', sha256: 'a', byteLength: 3 })
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => new Uint8Array([1, 2, 3]),
    recognizeImage: async () => ({ text: 'whole image text', lines: [], engine: 'system' }),
    translate: async (text) => `T(${text})`,
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.png', fileName: 'test.png', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-1', 1),
    new AbortController().signal,
    deps
  )

  const image = result.translation.pages[0]!.blocks[0]
  assert.equal(image.kind, 'image')
  assert.deepEqual(image.ocrRegions?.[0]?.bbox, { x: 0, y: 0, width: 1, height: 1 })
  assert.equal(image.ocrRegions?.[0]?.text, 'whole image text')
  // 缺少行框时不能把整页高度当成单行高度，否则扫描件译文会被放大到 72pt 上限。
  assert.equal(image.ocrRegions?.[0]?.style?.fontSize, DOCUMENT_OCR_UNIFORM_FONT_SIZE)
})

test('OCR 自适应放大结果必须回映射到原图坐标', async () => {
  const source = model([{
    kind: 'image',
    blockId: 'image-scaled',
    readingOrder: 0,
    translatable: false,
    assetId: 'asset-scaled'
  }])
  source.assets.push({
    assetId: 'asset-scaled',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'a',
    byteLength: 3,
    width: 1000,
    height: 1000
  })
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => new Uint8Array([1, 2, 3]),
    recognizeImage: async () => ({
      text: 'scaled text',
      lines: [{
        text: 'scaled text',
        confidence: 0.95,
        box: { x: 500, y: 200, width: 200, height: 100 }
      }],
      engine: 'system',
      coordinateScale: 2
    }),
    translate: async (text) => `T(${text})`,
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.png', fileName: 'test.png', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-scaled', 1),
    new AbortController().signal,
    deps
  )

  assert.deepEqual(result.translation.pages[0]!.blocks[0]!.ocrRegions?.[0]?.bbox, {
    x: 0.25,
    y: 0.1,
    width: 0.1,
    height: 0.05
  })
})

test('多个无框 OCR 行只能合并为一个整图兜底区域', async () => {
  const source = model([{
    kind: 'image',
    blockId: 'image-no-box',
    readingOrder: 0,
    translatable: false,
    assetId: 'asset-no-box'
  }])
  source.assets.push({ assetId: 'asset-no-box', kind: 'image', mimeType: 'image/png', sha256: 'a', byteLength: 3 })
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => new Uint8Array([1, 2, 3]),
    recognizeImage: async () => ({
      text: 'first\nsecond',
      lines: [
        { text: 'first', confidence: 0.95 },
        { text: 'second', confidence: 0.9 }
      ],
      engine: 'system'
    }),
    translate: async (text) => `T(${text})`,
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.png', fileName: 'test.png', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-no-box', 1),
    new AbortController().signal,
    deps
  )

  const regions = result.translation.pages[0]!.blocks[0]!.ocrRegions ?? []
  assert.equal(regions.length, 1)
  assert.deepEqual(regions[0]!.bbox, { x: 0, y: 0, width: 1, height: 1 })
  assert.equal(regions[0]!.text, 'first\nsecond')
})

test('单块翻译失败时保留原文、继续后续块并标记部分完成', async () => {
  const source = model([textBlock('block-1', [{ runId: 'r1', text: 'first' }]),
    textBlock('block-2', [{ runId: 'r2', text: 'second' }])])
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      if (text.includes('ST-SEG') || text === 'first') throw new Error('provider failed')
      return translateMergedText(text, (part) => `T(${part})`)
    },
    onProgress: () => undefined
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-1', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(result.task.status, 'partial')
  assert.equal(result.task.failedBlocks, 1)
  assert.equal(result.failedTargetIds?.length, 1)
  const blocks = result.translation.pages[0]!.blocks
  assert.equal((blocks[0] as DocumentTextBlock).runs[0]!.text, 'first')
  assert.equal((blocks[1] as DocumentTextBlock).runs[0]!.text, 'T(second)')
})

test('首次运行必须生成绑定任务身份与完整目标的完成报告', async () => {
  const source = model([
    textBlock('block-1', [{ runId: 'r1', text: 'first' }]),
    textBlock('block-2', [{ runId: 'r2', text: 'second' }])
  ])
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => text.includes('first') ? '第一' : '第二',
    onProgress: () => undefined,
    getModelFingerprint: () => 'provider:test-model',
    concurrency: 1
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-completion', 3),
    new AbortController().signal,
    deps
  )

  assert.equal(result.task.status, 'completed')
  assert.ok(result.completionReport)
  assert.equal(result.completionReport.jobId, 'job-completion')
  assert.equal(result.completionReport.generation, 3)
  assert.equal(result.completionReport.documentId, source.documentId)
  assert.equal(result.completionReport.modelFingerprint, 'provider:test-model')
  assert.equal(result.completionReport.status, 'completed')
  assert.equal(result.completionReport.total, 2)
  assert.equal(result.completionReport.translated, 2)
  assert.equal(result.completionReport.unchanged, 0)
  assert.deepEqual(result.completionReport.failedTargetIds, [])
  assert.deepEqual(result.completionReport.pendingTargetIds, [])
  assert.deepEqual(result.completionReport.suspectUntranslatedTargetIds, [])
  assert.deepEqual(result.failedTargetIds, [])
})

test('完成报告必须把部分失败归为 partial 并暴露失败原因和可重试目标', async () => {
  const source = model([
    textBlock('block-1', [{ runId: 'r1', text: 'first' }]),
    textBlock('block-2', [{ runId: 'r2', text: 'second' }])
  ])
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      if (text.includes('first')) throw new Error('provider failed')
      return '第二'
    },
    onProgress: () => undefined,
    getModelFingerprint: () => 'provider:test-model',
    concurrency: 1
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-partial-report', 4),
    new AbortController().signal,
    deps
  )

  assert.equal(result.task.status, 'partial')
  assert.ok(result.completionReport)
  assert.equal(result.completionReport.status, 'partial')
  assert.equal(result.completionReport.total, 2)
  assert.equal(result.completionReport.translated, 1)
  assert.equal(result.completionReport.failed, 1)
  assert.deepEqual(result.completionReport.failedTargetIds, ['0:0:text:r1'])
  assert.equal(result.completionReport.failureReasons['0:0:text:r1'], 'translation-failed')
  assert.deepEqual(result.failedTargetIds, ['0:0:text:r1'])
  assert.equal(result.translation.warnings.some((warning) => warning.code === 'translation-partial'), true)
})

test('重试成功必须对完整文档重新生成完成报告而不是只统计重试目标', async () => {
  const source = model([
    textBlock('block-1', [{ runId: 'r1', text: 'first' }]),
    textBlock('block-2', [{ runId: 'r2', text: 'second' }])
  ])
  let retrying = false
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      if (!retrying && text.includes('first')) throw new Error('provider failed')
      return text.includes('first') ? '第一' : '第二'
    },
    onProgress: () => undefined,
    getModelFingerprint: () => 'provider:test-model',
    concurrency: 1
  }
  const initial = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-retry-report', 5),
    new AbortController().signal,
    deps
  )
  assert.equal(initial.completionReport?.status, 'partial')

  retrying = true
  const retried = await retryFailedDocumentTranslationPipeline(
    initial.source,
    initial.translation,
    initial.failedTargetIds!,
    { ...initial.task, generation: 6 },
    new AbortController().signal,
    deps,
    initial.languageResolution!
  )

  assert.equal(retried.task.status, 'completed')
  assert.ok(retried.completionReport)
  assert.equal(retried.completionReport.jobId, 'job-retry-report')
  assert.equal(retried.completionReport.generation, 6)
  assert.equal(retried.completionReport.status, 'completed')
  assert.equal(retried.completionReport.total, 2)
  assert.equal(retried.completionReport.translated, 2)
  assert.deepEqual(retried.completionReport.failedTargetIds, [])
  assert.deepEqual(retried.failedTargetIds, [])
  assert.equal(retried.translation.warnings.some((warning) => warning.code === 'translation-partial'), false)
})

test('重新翻译只请求失败目标并保留已成功译文', async () => {
  const source = model([
    textBlock('block-1', [{ runId: 'r1', text: 'first' }]),
    textBlock('block-2', [{ runId: 'r2', text: 'second' }])
  ])
  let retrying = false
  let parseCalls = 0
  const calls: string[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => {
      parseCalls += 1
      if (parseCalls > 1) throw new Error('retry must not parse the source document again')
      return source
    },
    loadAssetBytes: async () => null,
    recognizeImage: async () => {
      throw new Error('retry must not run OCR again')
    },
    translate: async (text) => {
      calls.push(text)
      if (!retrying && text.includes('first')) throw new Error('provider failed')
      return `T(${text})`
    },
    onProgress: () => undefined,
    concurrency: 1
  }

  const initial = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-1', 1),
    new AbortController().signal,
    deps
  )
  assert.equal(initial.task.status, 'partial')
  assert.equal(initial.failedTargetIds?.length, 1)
  assert.equal((initial.translation.pages[0]!.blocks[1] as DocumentTextBlock).runs[0]!.text, 'T(second)')

  retrying = true
  calls.length = 0
  const retried = await retryFailedDocumentTranslationPipeline(
    initial.source,
    initial.translation,
    initial.failedTargetIds!,
    { ...initial.task, generation: 2 },
    new AbortController().signal,
    deps,
    initial.languageResolution!
  )

  assert.deepEqual(calls, ['first'])
  assert.equal(retried.task.status, 'completed')
  assert.equal(retried.task.failedBlocks, 0)
  assert.deepEqual(retried.failedTargetIds, [])
  assert.equal(parseCalls, 1)
  assert.equal((retried.translation.pages[0]!.blocks[0] as DocumentTextBlock).runs[0]!.text, 'T(first)')
  assert.equal((retried.translation.pages[0]!.blocks[1] as DocumentTextBlock).runs[0]!.text, 'T(second)')
  assert.equal(retried.translation.warnings.some((warning) => warning.code === 'translation-partial'), false)
})

test('重新翻译合并批次时也必须在整批完成前发布部分译文', async () => {
  const source = model([
    textBlock('block-1', [{ runId: 'r1', text: 'first' }]),
    textBlock('block-2', [{ runId: 'r2', text: 'second' }])
  ])
  const initial = model([
    textBlock('block-1', [{ runId: 'r1', text: 'first' }]),
    textBlock('block-2', [{ runId: 'r2', text: 'second' }])
  ])
  const languageResolution = {
    sourcePreference: 'auto',
    targetPreference: 'auto',
    languagePair: fixedLanguagePair()
  }
  const published = translationCollector()
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text, _signal, _languagePair, onDelta) => {
      assert.equal(text, 'first\n[[[ST-SEG-0]]]\nsecond')
      onDelta?.('译:first\n[[[ST-SEG-0]]]\n')
      assert.equal(
        (published.translations.at(-1)!.pages[0]!.blocks[0] as DocumentTextBlock).runs[0]!.text,
        '译:first'
      )
      onDelta?.('译:second')
      return '译:first\n[[[ST-SEG-0]]]\n译:second'
    },
    onProgress: () => undefined,
    publishTranslation: published.publishTranslation
  }

  const retried = await retryFailedDocumentTranslationPipeline(
    source,
    initial,
    ['0:0:text:r1', '0:1:text:r2'],
    createDocumentTaskState('job-retry-stream', 2),
    new AbortController().signal,
    deps,
    languageResolution
  )

  assert.equal(retried.task.status, 'completed')
  assert.equal(
    (published.translations.at(-1)!.pages[0]!.blocks[1] as DocumentTextBlock).runs[0]!.text,
    '译:second'
  )
  assert.deepEqual(
    retried.translation.pages[0]!.blocks.map((block) =>
      block.kind === 'text' ? block.runs.map((run) => run.text).join('') : ''),
    ['译:first', '译:second']
  )
})

test('重新翻译高频流式增量也必须合并整页发布并保留首段即时反馈', async () => {
  const source = model([textBlock('block-1', [{ runId: 'r1', text: 'first' }])])
  const initial = model([textBlock('block-1', [{ runId: 'r1', text: 'first' }])])
  const languageResolution = {
    sourcePreference: 'auto',
    targetPreference: 'auto',
    languagePair: fixedLanguagePair()
  }
  const published = translationCollector()
  let countAfterFirstDelta = 0
  let countAfterAllDeltas = 0
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (_text, _signal, _languagePair, onDelta) => {
      onDelta?.('译')
      countAfterFirstDelta = published.translations.length
      for (let index = 1; index < 40; index += 1) onDelta?.(`文${index}`)
      countAfterAllDeltas = published.translations.length
      return `译文${Array.from({ length: 39 }, (_item, index) => index + 1).join('')}`
    },
    onProgress: () => undefined,
    publishTranslation: published.publishTranslation
  }

  await retryFailedDocumentTranslationPipeline(
    source,
    initial,
    ['0:0:text:r1'],
    createDocumentTaskState('job-retry-throttle', 2),
    new AbortController().signal,
    deps,
    languageResolution
  )

  assert.equal(countAfterFirstDelta, 2, '重试的首个增量也必须立即发布')
  assert.ok(countAfterAllDeltas <= 4, `重试同步增量发布次数应被合并，实际 ${countAfterAllDeltas}`)
  assert.ok(published.translations.length <= 5,
    `重试包含最终快照的发布次数应保持有限，实际 ${published.translations.length}`)
  assert.equal(
    (published.translations.at(-1)!.pages[0]!.blocks[0] as DocumentTextBlock).runs[0]!.text,
    `译文${Array.from({ length: 39 }, (_item, index) => index + 1).join('')}`
  )
})

test('重新翻译后仍失败时必须保留可再次重试的目标并保持部分完成', async () => {
  const source = model([
    textBlock('block-1', [{ runId: 'r1', text: 'first' }]),
    textBlock('block-2', [{ runId: 'r2', text: 'second' }])
  ])
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      if (text.includes('first')) throw new Error('provider still unavailable')
      return `T(${text})`
    },
    onProgress: () => undefined,
    concurrency: 1
  }

  const initial = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-1', 1),
    new AbortController().signal,
    deps
  )
  const retried = await retryFailedDocumentTranslationPipeline(
    initial.source,
    initial.translation,
    initial.failedTargetIds!,
    { ...initial.task, generation: 2 },
    new AbortController().signal,
    deps,
    initial.languageResolution!
  )

  assert.equal(retried.task.status, 'partial')
  assert.equal(retried.task.failedBlocks, 1)
  assert.deepEqual(retried.failedTargetIds, initial.failedTargetIds)
  assert.equal((retried.translation.pages[0]!.blocks[0] as DocumentTextBlock).runs[0]!.text, 'first')
  assert.equal((retried.translation.pages[0]!.blocks[1] as DocumentTextBlock).runs[0]!.text, 'T(second)')
  assert.equal(retried.translation.warnings.some((warning) => warning.code === 'translation-partial'), true)
})

test('取消后不再发起翻译并返回 cancelled', async () => {
  const source = model([
    textBlock('block-1', [{ runId: 'r1', text: 'first' }]),
    textBlock('block-2', [{ runId: 'r2', text: 'second' }])
  ])
  const controller = new AbortController()
  let calls = 0
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls += 1
      controller.abort()
      return `T(${text})`
    },
    onProgress: () => undefined,
    concurrency: 1
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-1', 1),
    controller.signal,
    deps
  )

  assert.equal(result.task.status, 'cancelled')
  assert.equal(calls, 1)
})

test('取消后迟到的流式增量不得覆盖取消结果中的已完成译文', async () => {
  const completedSourceText = `${'first '.repeat(300)}`.trim()
  const source = model([
    textBlock('block-1', [{ runId: 'r1', text: completedSourceText }]),
    textBlock('block-2', [{ runId: 'r2', text: 'second' }])
  ])
  const controller = new AbortController()
  const published = translationCollector()
  let releaseFirst: (() => void) | null = null
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text, _signal, _languagePair, onDelta) => {
      if (text === completedSourceText) {
        onDelta?.('第一')
        return '第一'
      }
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      controller.abort()
      onDelta?.('迟到的第二段')
      return '迟到的第二段'
    },
    onProgress: () => undefined,
    publishTranslation: published.publishTranslation,
    concurrency: 1
  }

  const pending = runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-cancel-late-delta', 1),
    controller.signal,
    deps
  )
  await new Promise((resolve) => setTimeout(resolve, 5))
  releaseFirst?.()
  const result = await pending

  assert.equal(result.task.status, 'cancelled')
  assert.equal(
    (result.translation.pages[0]!.blocks[0] as DocumentTextBlock).runs[0]!.text,
    '第一'
  )
  assert.equal(
    (result.translation.pages[0]!.blocks[1] as DocumentTextBlock).runs[0]!.text,
    'second'
  )
  const lateSnapshots = published.translations.slice(1).filter((translation) =>
    (translation.pages[0]!.blocks[1] as DocumentTextBlock).runs[0]!.text === '迟到的第二段')
  assert.deepEqual(lateSnapshots, [])
})

test('文档翻译流水线必须把任务级语言对传给所有批次、回退和重试请求', async () => {
  const source = model([
    textBlock('block-cn', [{ runId: 'cn', text: '中文说明'.repeat(80) }]),
    textBlock('block-en', [{ runId: 'en', text: 'English-only batch text '.repeat(70) }]),
    tableBlock('table-direction', [[
      '表格中文单元格一',
      '表格中文单元格二'
    ]])
  ])
  const seenPairs: DocumentLanguagePair[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text, _signal, languagePair) => {
      seenPairs.push(languagePair)
      if (text.includes('ST-DOC-CELL')) return '表格标记丢失'
      return translateMergedText(text, (part) => `T(${part})`)
    },
    onProgress: () => undefined,
    concurrency: 3
  }
  const pair = { sourceLang: 'auto', targetLang: 'ZH' }
  const preference = { sourcePreference: 'auto', targetPreference: 'ZH' }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-document-direction', 1),
    new AbortController().signal,
    deps,
    preference
  )

  assert.ok(seenPairs.length >= 4)
  assert.equal(seenPairs.every((candidate) => candidate === result.languagePair), true)
  assert.deepEqual(result.languagePair, pair)
})

test('失败目标重试必须复用首次任务语言对，不能重新按失败块解析方向', async () => {
  const source = model([
    textBlock('block-fail', [{ runId: 'fail', text: 'English-only failed block' }]),
    textBlock('block-ok', [{ runId: 'ok', text: '中文成功块' }])
  ])
  const seenPairs: DocumentLanguagePair[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text, _signal, languagePair) => {
      seenPairs.push(languagePair)
      if (text.includes('English-only')) throw new Error('temporary failure')
      return `T(${text})`
    },
    onProgress: () => undefined,
    concurrency: 1
  }
  const pair = { sourceLang: 'auto', targetLang: 'ZH' }
  const preference = { sourcePreference: 'auto', targetPreference: 'auto' }

  const initial = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-retry-direction', 1),
    new AbortController().signal,
    deps,
    preference
  )
  const firstPair = initial.languagePair
  const firstResolution = {
    sourcePreference: initial.sourcePreference!,
    targetPreference: initial.targetPreference!,
    languagePair: firstPair!
  }
  const retried = await retryFailedDocumentTranslationPipeline(
    initial.source,
    initial.translation,
    initial.failedTargetIds!,
    { ...initial.task, generation: 2 },
    new AbortController().signal,
    deps,
    firstResolution
  )

  assert.deepEqual(firstPair, pair)
  assert.equal(seenPairs.every((candidate) => candidate === firstPair), true)
  assert.deepEqual(retried.languagePair, firstPair)
  assert.equal(retried.sourcePreference, 'auto')
  assert.equal(retried.targetPreference, 'auto')
})

test('OCR 原文模式必须完成解析与识别但绝不调用翻译', async () => {
  const source = model([
    textBlock('block-ocr', [{ runId: 'run-ocr', text: '需要识别但不翻译' }])
  ])
  let translateCalls = 0
  const progress = progressCollector()
  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-ocr-only', 1),
    new AbortController().signal,
    {
      parse: async () => source,
      loadAssetBytes: async () => null,
      recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
      translate: async () => {
        translateCalls += 1
        return '不应调用'
      },
      onProgress: progress.onProgress
    },
    { sourcePreference: 'auto', targetPreference: 'ZH' },
    'ocr'
  )

  assert.equal(translateCalls, 0)
  assert.equal(result.task.status, 'completed')
  assert.equal(result.runMode, 'ocr')
  assert.deepEqual(result.translation, result.source)
  assert.equal(progress.states.some((state) => state.phase === 'translate'), false)
})

test('OCR 原文模式识别失败时必须进入失败态并保留可诊断告警', async () => {
  const source = model([{
    kind: 'image',
    blockId: 'image-ocr-failed',
    readingOrder: 0,
    translatable: false,
    assetId: 'asset-ocr-failed'
  }])
  source.assets.push({
    assetId: 'asset-ocr-failed',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'ocr-failed',
    byteLength: 3
  })
  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.png', fileName: 'test.png', format: 'image', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-ocr-failed', 1),
    new AbortController().signal,
    {
      parse: async () => source,
      loadAssetBytes: async () => new Uint8Array([1, 2, 3]),
      recognizeImage: async () => {
        throw new Error('ocr unavailable')
      },
      translate: async () => '不应调用',
      onProgress: () => undefined
    },
    { sourcePreference: 'auto', targetPreference: 'ZH' },
    'ocr'
  )

  assert.equal(result.runMode, 'ocr')
  assert.equal(result.task.status, 'failed')
  assert.equal(result.task.errorCode, 'ocr-failed')
  assert.equal(result.completionReport?.status, 'failed')
  assert.equal(result.source.warnings.some((warning) => warning.code === 'ocr-failed'), true)
})

test('术语表命中后必须把受控术语上下文传给每个实际翻译请求', async () => {
  const source = model([
    textBlock('block-1', [{ runId: 'r1', text: 'workspace cache' }]),
    textBlock('block-2', [{ runId: 'r2', text: 'workspace settings' }])
  ])
  const contexts: Array<{ glossaryVersion: string; glossaryContext: string }> = []
  const glossary: DocumentGlossary = {
    version: 'glossary-v7',
    entries: [
      { source: 'workspace', target: '工作区', sourceLang: 'EN', targetLang: 'ZH' },
      { source: 'cache', target: '缓存', sourceLang: 'EN', targetLang: 'ZH' },
      { source: 'unused', target: '未命中', sourceLang: 'EN', targetLang: 'ZH' }
    ]
  }
  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-glossary', 1),
    new AbortController().signal,
    {
      parse: async () => source,
      loadAssetBytes: async () => null,
      recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
      translate: async (text, _signal, _languagePair, _onDelta, context) => {
        contexts.push({
          glossaryVersion: context?.glossaryVersion ?? '',
          glossaryContext: context?.glossaryContext ?? ''
        })
        return translateMergedText(text, (part) => `T(${part})`)
      },
      onProgress: () => undefined,
      concurrency: 1,
      glossary
    },
    { sourcePreference: 'EN', targetPreference: 'ZH' }
  )

  assert.equal(result.task.status, 'completed')
  assert.ok(contexts.length >= 1)
  assert.equal(contexts.every((context) => context.glossaryVersion === 'glossary-v7'), true)
  assert.equal(contexts.every((context) => context.glossaryContext.includes('workspace => 工作区')), true)
  assert.equal(contexts.some((context) => context.glossaryContext.includes('unused')), false)
})

test('完整目标缓存命中必须跳过提供方请求、写回译文并推进目标进度', async () => {
  const source = model([
    textBlock('block-1', [{ runId: 'r1', text: 'Cached sentence.' }]),
    textBlock('block-2', [{ runId: 'r2', text: 'Fresh sentence.' }])
  ])
  let translateCalls = 0
  const writes: Array<{ key: string; value: unknown }> = []
  const progress = progressCollector()
  const cachedKey = buildDocumentTranslationCacheKey({
    fileSha256: source.source.sha256,
    parserVersion: 'parser-v9',
    languagePair: { sourceLang: 'auto', targetLang: 'ZH' },
    modelFingerprint: 'provider:model',
    glossaryVersion: 'none',
    protectionRulesVersion: DOCUMENT_PROTECTION_RULES_VERSION,
    translationProtocolVersion: DOCUMENT_TRANSLATION_PROTOCOL_VERSION
  })
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      translateCalls += 1
      return text.includes('Cached') ? '不应请求' : '新鲜译文'
    },
    onProgress: progress.onProgress,
    concurrency: 1,
    getParserVersion: () => 'parser-v9',
    getModelFingerprint: () => 'provider:model',
    readTranslationCache: async (key) => key.startsWith(`${cachedKey}|target:`) && key.endsWith(':text:r1')
      ? {
          sourceSha256: source.source.sha256,
          languagePair: { sourceLang: 'auto', targetLang: 'ZH' },
          glossaryVersion: 'none',
          protectionRulesVersion: DOCUMENT_PROTECTION_RULES_VERSION,
          translationProtocolVersion: DOCUMENT_TRANSLATION_PROTOCOL_VERSION,
          status: 'completed',
          translation: '缓存译文'
        }
      : null,
    writeTranslationCache: async (key, value) => {
      writes.push({ key, value })
    }
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-cache-hit', 1),
    new AbortController().signal,
    deps,
    { sourcePreference: 'auto', targetPreference: 'ZH' }
  )

  assert.equal(result.task.status, 'completed')
  assert.equal(translateCalls, 1)
  assert.equal((result.translation.pages[0]!.blocks[0] as DocumentTextBlock).runs[0]!.text, '缓存译文')
  assert.equal((result.translation.pages[0]!.blocks[1] as DocumentTextBlock).runs[0]!.text, '新鲜译文')
  assert.equal(writes.length, 1)
  assert.equal(writes[0]!.key.startsWith(`${cachedKey}|target:`), true)
  assert.notEqual(writes[0]!.key, `${cachedKey}|target:page-1.block-1`)
  assert.equal((writes[0]!.value as DocumentTranslationCacheEntry).translation, '新鲜译文')
  const finalProgress = progress.states.filter((state) => state.phase === 'translate').at(-1)
  assert.equal(finalProgress?.progress.completed, 2)
})

test('缓存读写异常不得影响翻译主任务', async () => {
  const source = model([textBlock('block-1', [{ runId: 'r1', text: 'Cache failure.' }])])
  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-cache-error', 1),
    new AbortController().signal,
    {
      parse: async () => source,
      loadAssetBytes: async () => null,
      recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
      translate: async () => '缓存异常仍应成功',
      onProgress: () => undefined,
      readTranslationCache: async () => {
        throw new Error('cache read unavailable')
      },
      writeTranslationCache: async () => {
        throw new Error('cache write unavailable')
      }
    }
  )

  assert.equal(result.task.status, 'completed')
  assert.equal((result.translation.pages[0]!.blocks[0] as DocumentTextBlock).runs[0]!.text, '缓存异常仍应成功')
})

test('失败、取消、空译文和疑似未翻译目标不得写入成功缓存', async () => {
  const source = model([
    textBlock('block-failed', [{ runId: 'rf', text: 'Failure source text.' }]),
    textBlock('block-empty', [{ runId: 're', text: 'Empty source text.' }]),
    textBlock('block-suspect', [
      { runId: 'rs', text: 'This is a complete sentence that should be translated.' }
    ])
  ])
  const writes: unknown[] = []
  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-cache-negative', 1),
    new AbortController().signal,
    {
      parse: async () => source,
      loadAssetBytes: async () => null,
      recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
      translate: async (text) => {
        if (text.includes('Failure')) throw new Error('provider failure')
        if (text.includes('Empty')) return '   '
        return text
      },
      onProgress: () => undefined,
      concurrency: 1,
      writeTranslationCache: async (_key, value) => {
        writes.push(value)
      }
    },
    { sourcePreference: 'EN', targetPreference: 'ZH' }
  )

  assert.equal(result.task.status, 'failed')
  assert.deepEqual(writes, [])
})

test('重试必须使用完整源文档相邻上下文并透传命中的术语', async () => {
  const source = model([
    textBlock('block-1', [{ runId: 'r1', text: 'workspace first' }]),
    textBlock('block-2', [{ runId: 'r2', text: 'workspace failed' }]),
    textBlock('block-3', [{ runId: 'r3', text: 'workspace last' }])
  ])
  const contexts: Array<{
    text: string
    glossaryVersion: string
    glossaryContext: string
    contextSummary: string
  }> = []
  let retrying = false
  const glossary: DocumentGlossary = {
    version: 'glossary-retry-v1',
    entries: [
      { source: 'workspace', target: '工作区', sourceLang: 'EN', targetLang: 'ZH' },
      { source: 'failed', target: '失败', sourceLang: 'EN', targetLang: 'ZH' }
    ]
  }
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text, _signal, _languagePair, _onDelta, context) => {
      contexts.push({
        text,
        glossaryVersion: context?.glossaryVersion ?? '',
        glossaryContext: context?.glossaryContext ?? '',
        contextSummary: context?.contextSummary ?? ''
      })
      if (!retrying && text.includes('failed')) throw new Error('provider failed')
      return `T(${text})`
    },
    onProgress: () => undefined,
    concurrency: 1,
    glossary
  }
  const initial = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-retry-context', 1),
    new AbortController().signal,
    deps,
    { sourcePreference: 'EN', targetPreference: 'ZH' }
  )

  retrying = true
  contexts.length = 0
  const retried = await retryFailedDocumentTranslationPipeline(
    initial.source,
    initial.translation,
    initial.failedTargetIds!,
    { ...initial.task, generation: 2 },
    new AbortController().signal,
    deps,
    initial.languageResolution!
  )

  assert.equal(retried.task.status, 'completed')
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0]!.text, 'workspace failed')
  assert.equal(contexts[0]!.glossaryVersion, 'glossary-retry-v1')
  assert.match(contexts[0]!.glossaryContext, /workspace => 工作区/u)
  assert.match(contexts[0]!.glossaryContext, /failed => 失败/u)
  assert.match(contexts[0]!.contextSummary, /workspace first/u)
  assert.match(contexts[0]!.contextSummary, /workspace last/u)
})

test('重试缓存命中必须跳过提供方请求并写回已缓存译文', async () => {
  const source = model([
    textBlock('block-1', [{ runId: 'r1', text: 'first' }]),
    textBlock('block-2', [{ runId: 'r2', text: 'second' }])
  ])
  let retrying = false
  let translateCalls = 0
  const cachedKey = buildDocumentTranslationCacheKey({
    fileSha256: source.source.sha256,
    parserVersion: 'parser-retry-v1',
    languagePair: { sourceLang: 'auto', targetLang: 'ZH' },
    modelFingerprint: 'provider:retry-model',
    glossaryVersion: 'none',
    protectionRulesVersion: DOCUMENT_PROTECTION_RULES_VERSION,
    translationProtocolVersion: DOCUMENT_TRANSLATION_PROTOCOL_VERSION
  })
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      translateCalls += 1
      if (!retrying && text.includes('first')) throw new Error('provider failed')
      return `T(${text})`
    },
    onProgress: () => undefined,
    concurrency: 1,
    getParserVersion: () => 'parser-retry-v1',
    getModelFingerprint: () => 'provider:retry-model',
    readTranslationCache: async (key) => retrying && key === `${cachedKey}|target:0:0:text:r1`
      ? {
          sourceSha256: source.source.sha256,
          languagePair: { sourceLang: 'auto', targetLang: 'ZH' },
          glossaryVersion: 'none',
          protectionRulesVersion: DOCUMENT_PROTECTION_RULES_VERSION,
          translationProtocolVersion: DOCUMENT_TRANSLATION_PROTOCOL_VERSION,
          status: 'completed',
          translation: '重试缓存译文'
        }
      : null
  }
  const initial = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-retry-cache-hit', 1),
    new AbortController().signal,
    deps,
    { sourcePreference: 'auto', targetPreference: 'ZH' }
  )

  retrying = true
  translateCalls = 0
  const retried = await retryFailedDocumentTranslationPipeline(
    initial.source,
    initial.translation,
    initial.failedTargetIds!,
    { ...initial.task, generation: 2 },
    new AbortController().signal,
    deps,
    initial.languageResolution!
  )

  assert.equal(retried.task.status, 'completed')
  assert.equal(translateCalls, 0)
  assert.equal((retried.translation.pages[0]!.blocks[0] as DocumentTextBlock).runs[0]!.text, '重试缓存译文')
})

test('重试成功必须写入成功缓存，缓存异常不得影响重试结果', async () => {
  const source = model([
    textBlock('block-1', [{ runId: 'r1', text: 'first' }]),
    textBlock('block-2', [{ runId: 'r2', text: 'second' }])
  ])
  let retrying = false
  let writeMode: 'throw' | 'record' = 'record'
  const writes: Array<{ key: string; value: DocumentTranslationCacheEntry }> = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      if (!retrying && text.includes('first')) throw new Error('provider failed')
      return `T(${text})`
    },
    onProgress: () => undefined,
    concurrency: 1,
    readTranslationCache: async () => {
      throw new Error('cache read unavailable')
    },
    writeTranslationCache: async (key, value) => {
      if (writeMode === 'throw') throw new Error('cache write unavailable')
      writes.push({ key, value })
    }
  }
  const initial = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-retry-cache-write', 1),
    new AbortController().signal,
    deps,
    { sourcePreference: 'auto', targetPreference: 'ZH' }
  )
  const failedTargetIds = initial.failedTargetIds!

  retrying = true
  writeMode = 'throw'
  writes.length = 0
  const failedCache = await retryFailedDocumentTranslationPipeline(
    initial.source,
    initial.translation,
    failedTargetIds,
    { ...initial.task, generation: 2 },
    new AbortController().signal,
    deps,
    initial.languageResolution!
  )
  assert.equal(failedCache.task.status, 'completed')
  assert.equal((failedCache.translation.pages[0]!.blocks[0] as DocumentTextBlock).runs[0]!.text, 'T(first)')

  writeMode = 'record'
  const retried = await retryFailedDocumentTranslationPipeline(
    initial.source,
    initial.translation,
    failedTargetIds,
    { ...initial.task, generation: 3 },
    new AbortController().signal,
    deps,
    initial.languageResolution!
  )
  assert.equal(retried.task.status, 'completed')
  assert.equal(writes.length, 1)
  assert.equal(writes[0]!.value.translation, 'T(first)')
  assert.match(writes[0]!.key, /target:0:0:text:r1$/u)
})

test('重试取消后不得写入成功缓存', async () => {
  const source = model([textBlock('block-1', [{ runId: 'r1', text: 'first' }])])
  const initial = model([textBlock('block-1', [{ runId: 'r1', text: 'first' }])])
  const controller = new AbortController()
  const writes: unknown[] = []
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async () => {
      controller.abort()
      return 'T(first)'
    },
    onProgress: () => undefined,
    writeTranslationCache: async (_key, value) => {
      writes.push(value)
    }
  }

  const retried = await retryFailedDocumentTranslationPipeline(
    source,
    initial,
    ['0:0:text:r1'],
    createDocumentTaskState('job-retry-cancel-cache', 2),
    controller.signal,
    deps,
    { sourcePreference: 'auto', targetPreference: 'ZH', languagePair: fixedLanguagePair() }
  )

  assert.equal(retried.task.status, 'cancelled')
  assert.deepEqual(writes, [])
})
