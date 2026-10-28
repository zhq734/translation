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
  const published = translationCollector()
  const deps: DocumentPipelineDeps = {
    parse: async () => source,
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => {
      calls.push(text)
      return translateMergedText(text, (part) => `译:${part}`)
    },
    onProgress: progress.onProgress,
    publishTranslation: published.publishTranslation
  }

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1, 2, 3]) },
    createDocumentTaskState('job-1', 1),
    new AbortController().signal,
    deps
  )

  assert.deepEqual(calls, ['Hello world'])
  assert.equal(result.task.status, 'completed')
  assert.equal(result.source.pages[0]!.blocks[0]!.kind, 'text')
  const translated = result.translation.pages[0]!.blocks[0] as DocumentTextBlock
  assert.deepEqual(translated.runs.map((run) => run.runId), ['run-1', 'run-2'])
  assert.deepEqual(translated.runs.map((run) => run.text), ['译:Hello world', ''])
  assert.equal(published.translations.length >= 1, true)
  assert.equal((published.translations.at(-1)!.pages[0]!.blocks[0] as DocumentTextBlock).runs[0]!.text, '译:Hello world')
  assert.equal((published.translations.at(-1)!.pages[0]!.blocks[0] as DocumentTextBlock).runs[1]!.text, '')
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
    translate: async (_text, _signal, onDelta) => {
      onDelta?.('你好')
      onDelta?.('，世界')
      return '你好，世界'
    },
    onProgress: () => undefined,
    publishTranslation: published.publishTranslation
  }

  await runDocumentTranslationPipeline(
    { path: '/tmp/test.txt', fileName: 'test.txt', format: 'txt', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-1', 1),
    new AbortController().signal,
    deps
  )

  const streamed = published.translations
    .map((translation) => (translation.pages[0]!.blocks[0] as DocumentTextBlock).runs[0]!.text)
  assert.deepEqual(streamed.slice(1, 3), ['你好', '你好，世界'])
  assert.equal(streamed.at(-1), '你好，世界')
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
    createDocumentTaskState('job-1', 1),
    new AbortController().signal,
    deps
  )
  await Promise.race([
    translationStarted,
    new Promise<void>((resolve) => setTimeout(resolve, 100))
  ])

  assert.equal(published.translations.length, 1)
  const initial = published.translations[0]!
  assert.deepEqual(
    initial.pages[0]!.blocks.map((block) =>
      block.kind === 'text' ? block.runs.map((run) => run.text).join('') : ''),
    ['Hello world', 'Second paragraph']
  )

  assert.ok(resolveTranslation)
  assert.equal(sentText, 'Hello world\n[[[ST-SEG-0]]]\nSecond paragraph')
  resolveTranslation(translateMergedText(sentText, (part) => `译:${part}`))
  await run
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
  assert.equal(image.ocrRegions?.[1]?.text, 'second line')
  assert.deepEqual(calls, ['first line\n[[[ST-SEG-0]]]\nsecond line'])
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

test('PDF 表格单元格内的原始文本行必须在译文中保留换行边界', async () => {
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
    deps
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
    deps
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

test('表格行逐单元格回退仍失败时必须标记部分完成并支持重新翻译', async () => {
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

  assert.equal(initial.task.status, 'partial')
  assert.equal(initial.task.failedBlocks, 1)
  assert.equal(initial.failedTargetIds?.length, 1)
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
    initial.failedTargetIds!,
    { ...initial.task, generation: 2 },
    new AbortController().signal,
    deps
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

test('OCR 区域必须保留字号与居中、右对齐，供预览和 PDF 导出复用', async () => {
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
  assert.equal(image.ocrRegions?.[0]?.style?.fontSize, 32)
  assert.equal(image.ocrRegions?.[1]?.textAlign, 'right')
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
  assert.equal(image.ocrRegions?.[0]?.style?.fontSize, 12)
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
    deps
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
    deps
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
