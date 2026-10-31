import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  DocumentBlock,
  DocumentFormat,
  DocumentImageBlock,
  DocumentModel,
  DocumentOcrRegion
} from '../src/shared/documentTypes.ts'
import { createDocumentTaskState } from '../src/shared/documentTask.ts'
import {
  runDocumentTranslationPipeline,
  type DocumentPipelineDeps
} from '../src/main/documentTranslationPipeline.ts'

/**
 * 构造 OCR 测试文档模型。
 * @param format 文档格式。
 * @param blocks 首屏区块。
 * @param assets 文档资源。
 * @returns 可直接交给流水线的文档模型。
 * @author zhenghq
 */
function ocrModel(
  format: DocumentFormat,
  blocks: DocumentBlock[],
  assets: DocumentModel['assets'] = []
): DocumentModel {
  return {
    schemaVersion: 1,
    documentId: `ocr-${format}`,
    source: {
      path: `/tmp/ocr-test.${format}`,
      fileName: `ocr-test.${format}`,
      format,
      sha256: `sha-${format}`,
      size: 128
    },
    metadata: { direction: 'auto' },
    pages: [{
      pageId: `page-${format}`,
      index: 0,
      width: 600,
      height: 800,
      blocks
    }],
    assets,
    warnings: []
  }
}

/**
 * 构造带资源登记的内嵌图片区块。
 * @param blockId 区块标识。
 * @param assetId 资源标识。
 * @param renderPending 是否等待页面补渲染。
 * @returns 图片区块。
 * @author zhenghq
 */
function imageBlock(
  blockId: string,
  assetId: string,
  renderPending = false
): DocumentImageBlock {
  return {
    kind: 'image',
    blockId,
    readingOrder: 0,
    translatable: false,
    assetId,
    bbox: { x: 40, y: 80, width: 520, height: 640 },
    ...(renderPending ? { renderPending } : {})
  }
}

/**
 * 创建测试图片资源。
 * @param assetId 资源标识。
 * @returns 图片资源元数据。
 * @author zhenghq
 */
function imageAsset(assetId: string): DocumentModel['assets'][number] {
  return {
    assetId,
    kind: 'image',
    mimeType: 'image/png',
    sha256: `hash-${assetId}`,
    byteLength: 3,
    width: 600,
    height: 800
  }
}

/**
 * 读取图片区块的首个 OCR 区域。
 * @param block 图片区块。
 * @returns OCR 区域；不存在时返回 undefined。
 * @author zhenghq
 */
function firstOcrRegion(block: DocumentBlock | undefined): DocumentOcrRegion | undefined {
  return block?.kind === 'image' ? block.ocrRegions?.[0] : undefined
}

/**
 * 创建只关注 OCR 阶段、不会实际翻译的流水线依赖。
 * @param overrides 需要覆盖的依赖。
 * @returns 完整流水线依赖。
 * @author zhenghq
 */
function ocrDeps(overrides: Partial<DocumentPipelineDeps>): DocumentPipelineDeps {
  return {
    parse: async () => {
      throw new Error('测试必须显式注入 parse')
    },
    loadAssetBytes: async () => null,
    recognizeImage: async () => ({ text: '', lines: [], engine: 'system' }),
    translate: async (text) => `T(${text})`,
    onProgress: () => undefined,
    ...overrides
  }
}

/**
 * 等待微任务与短暂定时器，给并发任务进入在途状态的机会。
 * @returns 等待完成的 Promise。
 * @author zhenghq
 */
async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

test('扫描 PDF 必须补渲染页面，并把渲染字节交给 OCR', async () => {
  const source = ocrModel('pdf', [
    imageBlock('scanned-page-image', 'scanned-page-asset', true)
  ], [imageAsset('scanned-page-asset')])
  const renderedBytes = new Uint8Array([9, 8, 7, 6])
  let renderedPage = -1
  let recognizedBytes: Uint8Array | null = null
  const deps = ocrDeps({
    parse: async () => source,
    loadAssetBytes: async () => null,
    renderPage: async (pageIndex) => {
      renderedPage = pageIndex
      return renderedBytes
    },
    recognizeImage: async (bytes) => {
      recognizedBytes = bytes
      return { text: '扫描页正文', lines: [], engine: 'system' }
    }
  })

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/ocr-test.pdf', fileName: 'ocr-test.pdf', format: 'pdf', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-scan-pdf', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(renderedPage, 0)
  assert.deepEqual(recognizedBytes, renderedBytes)
  const region = firstOcrRegion(result.translation.pages[0]!.blocks[0])
  assert.equal(region?.status, 'recognized')
  assert.equal(region?.text, '扫描页正文')
  assert.equal(region?.translatedText, 'T(扫描页正文)')
})

test('PDF 内嵌图片、DOCX 图片与 EPUB 图片必须分别绑定 OCR 文本', async () => {
  const cases: Array<{ format: DocumentFormat; blockId: string; text: string }> = [
    { format: 'pdf', blockId: 'pdf-embedded-image', text: 'PDF 内嵌图片文字' },
    { format: 'docx', blockId: 'docx-inline-image', text: 'DOCX 图片文字' },
    { format: 'epub', blockId: 'epub-chapter-image', text: 'EPUB 图片文字' }
  ]

  for (const candidate of cases) {
    const assetId = `${candidate.format}-asset`
    const source = ocrModel(candidate.format, [
      imageBlock(candidate.blockId, assetId)
    ], [imageAsset(assetId)])
    const seenAssets: string[] = []
    const deps = ocrDeps({
      parse: async () => source,
      loadAssetBytes: async (asset) => {
        seenAssets.push(asset.assetId)
        return new Uint8Array([1, 2, 3])
      },
      recognizeImage: async () => ({
        text: candidate.text,
        lines: [{ text: candidate.text, confidence: 0.96 }],
        engine: 'system'
      })
    })

    const result = await runDocumentTranslationPipeline(
      {
        path: `/tmp/ocr-test.${candidate.format}`,
        fileName: `ocr-test.${candidate.format}`,
        format: candidate.format,
        bytes: new Uint8Array([1])
      },
      createDocumentTaskState(`job-${candidate.format}-image`, 1),
      new AbortController().signal,
      deps
    )

    assert.deepEqual(seenAssets, [assetId])
    const image = result.translation.pages[0]!.blocks[0]
    assert.equal(image?.kind, 'image')
    assert.equal(image?.kind === 'image' ? image.blockId : undefined, candidate.blockId)
    assert.equal(image?.kind === 'image' ? image.assetId : undefined, assetId)
    const region = firstOcrRegion(image)
    assert.equal(region?.regionId, `${candidate.blockId}-ocr-0`)
    assert.equal(region?.pageId, source.pages[0]?.pageId)
    assert.equal(region?.blockId, candidate.blockId)
    assert.equal(region?.assetId, assetId)
    assert.equal(region?.text, candidate.text)
    assert.equal(region?.confidence, 0.96)
    assert.equal(region?.translatedText, `T(${candidate.text})`)
  }
})

test('低质量 OCR 必须跳过翻译、保留原图并产生告警', async () => {
  const source = ocrModel('pdf', [
    imageBlock('blurred-image', 'blurred-asset')
  ], [imageAsset('blurred-asset')])
  let translateCalls = 0
  const deps = ocrDeps({
    parse: async () => source,
    loadAssetBytes: async () => new Uint8Array([1, 2, 3]),
    recognizeImage: async () => ({
      text: '模糊但可能重要的文字',
      lines: [{ text: '模糊但可能重要的文字', confidence: 0.31 }],
      engine: 'system'
    }),
    translate: async (text) => {
      translateCalls += 1
      return `T(${text})`
    }
  })

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/ocr-test.pdf', fileName: 'ocr-test.pdf', format: 'pdf', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-low-quality', 1),
    new AbortController().signal,
    deps
  )

  const image = result.translation.pages[0]!.blocks[0]
  const region = firstOcrRegion(image)
  assert.equal(image?.kind, 'image')
  assert.equal(image?.kind === 'image' ? image.assetId : undefined, 'blurred-asset')
  assert.equal(region?.status, 'skipped')
  assert.equal(region?.reason, 'low-confidence')
  assert.equal(region?.pageId, source.pages[0]?.pageId)
  assert.equal(region?.blockId, 'blurred-image')
  assert.equal(region?.assetId, 'blurred-asset')
  assert.equal(region?.translatedText, undefined)
  assert.equal(translateCalls, 0)
  const warning = result.translation.warnings.find((candidate) => candidate.code === 'ocr-low-confidence')
  assert.equal(warning?.severity, 'warning')
  assert.equal(warning?.pageId, source.pages[0]?.pageId)
  assert.equal(warning?.blockId, 'blurred-image')
})

test('OCR 失败必须保留失败原因和告警，且不写入异常文本', async () => {
  const source = ocrModel('docx', [
    imageBlock('broken-image', 'broken-asset')
  ], [imageAsset('broken-asset')])
  const deps = ocrDeps({
    parse: async () => source,
    loadAssetBytes: async () => new Uint8Array([1, 2, 3]),
    recognizeImage: async () => {
      throw new Error('engine unavailable')
    }
  })

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/ocr-test.docx', fileName: 'ocr-test.docx', format: 'docx', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-ocr-failure', 1),
    new AbortController().signal,
    deps
  )

  const image = result.translation.pages[0]!.blocks[0]
  const region = firstOcrRegion(image)
  assert.equal(image?.kind, 'image')
  assert.equal(image?.kind === 'image' ? image.assetId : undefined, 'broken-asset')
  assert.equal(region?.status, 'failed')
  assert.equal(region?.reason, 'ocr-failed')
  assert.equal(region?.pageId, source.pages[0]?.pageId)
  assert.equal(region?.blockId, 'broken-image')
  assert.equal(region?.assetId, 'broken-asset')
  assert.equal(region?.text, '')
  assert.equal(region?.translatedText, undefined)
  assert.equal(result.task.status, 'partial')
  const warning = result.translation.warnings.find((candidate) => candidate.code === 'ocr-failed')
  assert.equal(warning?.severity, 'error')
  assert.equal(warning?.pageId, source.pages[0]?.pageId)
  assert.equal(warning?.blockId, 'broken-image')
})

test('OCR 图像字节只能进入本地识别，翻译请求只能携带文本与语言对', async () => {
  const source = ocrModel('pdf', [
    imageBlock('private-image', 'private-asset')
  ], [imageAsset('private-asset')])
  const privateBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
  const recognizedBytes: Uint8Array[] = []
  const translationRequests: Array<Record<string, unknown>> = []
  const deps = ocrDeps({
    parse: async () => source,
    loadAssetBytes: async () => privateBytes,
    recognizeImage: async (bytes) => {
      recognizedBytes.push(bytes)
      return {
        text: '图片中的文字',
        lines: [{ text: '图片中的文字', confidence: 0.98 }],
        engine: 'system'
      }
    },
    translate: async (text, signal, languagePair) => {
      translationRequests.push({
        text,
        sourceLang: languagePair.sourceLang,
        targetLang: languagePair.targetLang,
        signalType: signal.constructor.name
      })
      return `T(${text})`
    }
  })

  await runDocumentTranslationPipeline(
    { path: '/tmp/private.pdf', fileName: 'private.pdf', format: 'pdf', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-private-boundary', 1),
    new AbortController().signal,
    deps
  )

  assert.deepEqual(recognizedBytes, [privateBytes])
  assert.deepEqual(translationRequests, [{
    text: '图片中的文字',
    sourceLang: 'auto',
    targetLang: 'EN',
    signalType: 'AbortSignal'
  }])
  const serializedRequests = JSON.stringify(translationRequests)
  assert.equal(serializedRequests.includes('private-asset'), false)
  assert.equal(serializedRequests.includes('private.pdf'), false)
  assert.equal(serializedRequests.includes('data:image'), false)
  assert.equal(serializedRequests.includes('0,222,173,190'), false)
})

test('取消 OCR 后必须返回 cancelled，并丢弃迟到识别结果', async () => {
  const source = ocrModel('epub', [
    imageBlock('slow-image', 'slow-asset')
  ], [imageAsset('slow-asset')])
  const controller = new AbortController()
  let releaseOcr: (() => void) | null = null
  let translateCalls = 0
  const deps = ocrDeps({
    parse: async () => source,
    loadAssetBytes: async () => new Uint8Array([1, 2, 3]),
    recognizeImage: async () => {
      await new Promise<void>((resolve) => {
        releaseOcr = resolve
      })
      return { text: '迟到的识别结果', lines: [], engine: 'system' }
    },
    translate: async (text) => {
      translateCalls += 1
      return `T(${text})`
    }
  })

  const pending = runDocumentTranslationPipeline(
    { path: '/tmp/ocr-test.epub', fileName: 'ocr-test.epub', format: 'epub', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-cancel-ocr', 1),
    controller.signal,
    deps
  )
  await nextTurn()
  controller.abort()
  releaseOcr?.()
  const result = await pending

  assert.equal(result.task.status, 'cancelled')
  assert.equal(translateCalls, 0)
  const region = firstOcrRegion(result.translation.pages[0]!.blocks[0])
  assert.notEqual(region?.translatedText, 'T(迟到的识别结果)')
  assert.notEqual(region?.text, '迟到的识别结果')
})

test('不同图片 OCR 必须遵守并发上限，相同资源仍只识别一次', async () => {
  const blocks = Array.from({ length: 4 }, (_, index) =>
    imageBlock(`parallel-image-${index + 1}`, `parallel-asset-${index + 1}`))
  const source = ocrModel(
    'pdf',
    blocks,
    blocks.map((block) => imageAsset(block.kind === 'image' ? block.assetId : ''))
  )
  let inFlight = 0
  let maxInFlight = 0
  let recognizeCalls = 0
  const deps = ocrDeps({
    parse: async () => source,
    loadAssetBytes: async () => new Uint8Array([1, 2, 3]),
    recognizeImage: async (bytes, signal) => {
      assert.equal(signal.aborted, false)
      recognizeCalls += 1
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise<void>((resolve) => setTimeout(resolve, 8))
      inFlight -= 1
      return { text: `OCR-${bytes.byteLength}`, lines: [], engine: 'system' }
    },
    ocrConcurrency: 2
  })

  const result = await runDocumentTranslationPipeline(
    { path: '/tmp/ocr-test.pdf', fileName: 'ocr-test.pdf', format: 'pdf', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-ocr-concurrency', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(recognizeCalls, 4)
  assert.equal(maxInFlight, 2)
  assert.equal(result.task.status, 'completed')
  assert.deepEqual(
    result.translation.pages[0]!.blocks.map((block) => firstOcrRegion(block)?.status),
    ['recognized', 'recognized', 'recognized', 'recognized']
  )
})

test('OCR 并发数必须限制在 1 到 4，避免资源竞争失控', async () => {
  const blocks = Array.from({ length: 6 }, (_, index) =>
    imageBlock(`bounded-image-${index + 1}`, `bounded-asset-${index + 1}`))
  const source = ocrModel(
    'pdf',
    blocks,
    blocks.map((block) => imageAsset(block.kind === 'image' ? block.assetId : ''))
  )
  let inFlight = 0
  let maxInFlight = 0
  const deps = ocrDeps({
    parse: async () => source,
    loadAssetBytes: async () => new Uint8Array([1, 2, 3]),
    recognizeImage: async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return { text: 'bounded', lines: [], engine: 'system' }
    },
    ocrConcurrency: 100
  })

  await runDocumentTranslationPipeline(
    { path: '/tmp/ocr-test.pdf', fileName: 'ocr-test.pdf', format: 'pdf', bytes: new Uint8Array([1]) },
    createDocumentTaskState('job-ocr-bounded', 1),
    new AbortController().signal,
    deps
  )

  assert.equal(maxInFlight, 4)
})
