import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DOCUMENT_MAX_FILE_BYTES,
  detectDocumentFormat,
  validateDocumentFile
} from '../src/shared/documentFormat.ts'
import {
  DOCUMENT_MODEL_SCHEMA_VERSION,
  createDocumentBlockId,
  createDocumentPageId,
  parseDocumentModel,
  serializeDocumentModel,
  type DocumentModel
} from '../src/shared/documentTypes.ts'

/**
 * 构造用于格式探测的文本字节。
 * @param value 文本内容。
 * @returns UTF-8 编码的字节。
 * @author zhenghq
 */
function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

/**
 * 构造最小 PDF 文件头。
 * @returns PDF 签名字节。
 * @author zhenghq
 */
function pdfHeader(): Uint8Array {
  return bytes('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n')
}

/**
 * 构造带 DOCX 包内标记的 ZIP 文件头。
 * @returns 可用于格式探测的 DOCX 字节。
 * @author zhenghq
 */
function docxHeader(): Uint8Array {
  return new Uint8Array([
    0x50, 0x4b, 0x03, 0x04,
    ...bytes('[Content_Types].xml word/document.xml')
  ])
}

/**
 * 构造带 EPUB mimetype 的 ZIP 文件头。
 * @returns 可用于格式探测的 EPUB 字节。
 * @author zhenghq
 */
function epubHeader(): Uint8Array {
  return new Uint8Array([
    0x50, 0x4b, 0x03, 0x04,
    ...bytes('mimetype application/epub+zip META-INF/container.xml')
  ])
}

/**
 * 构造覆盖所有区块类型的稳定文档模型。
 * @returns 可序列化的文档模型。
 * @author zhenghq
 */
function createModel(): DocumentModel {
  const documentFingerprint = 'sha256:abc123'
  const pageId = createDocumentPageId(documentFingerprint, 0)
  return {
    schemaVersion: DOCUMENT_MODEL_SCHEMA_VERSION,
    documentId: 'document-1',
    source: {
      path: '/tmp/sample.pdf',
      fileName: 'sample.pdf',
      format: 'pdf',
      sha256: documentFingerprint,
      size: 2048,
      pageCount: 1
    },
    metadata: {
      title: 'Sample',
      author: 'zhenghq',
      direction: 'ltr'
    },
    pages: [{
      pageId,
      index: 0,
      width: 595,
      height: 842,
      blocks: [{
        kind: 'text',
        blockId: createDocumentBlockId(documentFingerprint, pageId, 0, 'text'),
        role: 'paragraph',
        readingOrder: 0,
        translatable: true,
        bbox: { x: 40, y: 60, width: 515, height: 42 },
        runs: [{ runId: 'run-1', text: 'Hello world', style: { fontSize: 12, color: '#111111' } }]
      }]
    }],
    assets: [],
    warnings: []
  }
}

test('文档格式探测应同时使用扩展名与文件头', () => {
  assert.equal(detectDocumentFormat('paper.PDF', pdfHeader()).format, 'pdf')
  assert.equal(detectDocumentFormat('report.docx', docxHeader()).format, 'docx')
  assert.equal(detectDocumentFormat('book.epub', epubHeader()).format, 'epub')
  assert.equal(detectDocumentFormat('page.htm', bytes('<!doctype html><html></html>')).format, 'html')
  assert.equal(detectDocumentFormat('README.md', bytes('# 标题')).format, 'markdown')
  assert.equal(detectDocumentFormat('data.json', bytes('{"title":"hello"}')).format, 'json')
  assert.equal(detectDocumentFormat('table.csv', bytes('name,value\nA,1')).format, 'csv')
  assert.equal(detectDocumentFormat('captions.srt', bytes('1\n00:00:00,000 --> 00:00:01,000\nHi')).format, 'srt')
  assert.equal(detectDocumentFormat('captions.vtt', bytes('WEBVTT\n\n00:00.000 --> 00:01.000\nHi')).format, 'vtt')
  assert.equal(detectDocumentFormat('notes.txt', bytes('plain text')).format, 'txt')
})

test('文档格式探测应拒绝未知格式、伪造文件头和二进制文本', () => {
  assert.deepEqual(detectDocumentFormat('slides.pptx', bytes('not a supported document')), {
    ok: false,
    code: 'unsupported-format'
  })
  assert.deepEqual(detectDocumentFormat('fake.pdf', bytes('not a pdf')), {
    ok: false,
    code: 'invalid-header',
    format: 'pdf'
  })
  assert.deepEqual(detectDocumentFormat('fake.docx', bytes('PK\u0003\u0004missing package marker')), {
    ok: false,
    code: 'invalid-header',
    format: 'docx'
  })
  assert.deepEqual(detectDocumentFormat('binary.txt', new Uint8Array([0, 1, 2, 3, 4, 5])), {
    ok: false,
    code: 'invalid-header',
    format: 'txt'
  })
})

test('无扩展名文件只应接受可可靠嗅探的格式', () => {
  assert.equal(detectDocumentFormat('download', pdfHeader()).format, 'pdf')
  assert.equal(detectDocumentFormat('download', bytes('<html><body>Hello</body></html>')).format, 'html')
  assert.deepEqual(detectDocumentFormat('download', bytes('unstructured text')), {
    ok: false,
    code: 'unsupported-format'
  })
})

test('文件校验应覆盖空文件、大小上限、不可读与格式白名单', () => {
  assert.deepEqual(validateDocumentFile({ fileName: 'empty.txt', size: 0, head: new Uint8Array() }), {
    ok: false,
    code: 'empty-file',
    format: 'txt'
  })
  assert.deepEqual(validateDocumentFile({
    fileName: 'huge.pdf',
    size: DOCUMENT_MAX_FILE_BYTES + 1,
    head: pdfHeader()
  }), {
    ok: false,
    code: 'too-large',
    format: 'pdf'
  })
  assert.deepEqual(validateDocumentFile({
    fileName: 'locked.pdf',
    size: 1024,
    head: pdfHeader(),
    readable: false
  }), {
    ok: false,
    code: 'unreadable',
    format: 'pdf'
  })

  const valid = validateDocumentFile({ fileName: 'notes.txt', size: 11, head: bytes('hello world') })
  assert.equal(valid.ok, true)
  assert.equal(valid.ok ? valid.format : null, 'txt')
  assert.equal(valid.ok ? valid.capabilities.exportPdf : null, true)
  assert.equal(valid.ok ? valid.capabilities.ocrEmbeddedImages : null, false)
})

test('页面与区块标识应在相同输入下稳定且在冲突时区分', () => {
  const firstPage = createDocumentPageId('sha256:abc123', 0)
  const secondPage = createDocumentPageId('sha256:abc123', 1)
  const firstBlock = createDocumentBlockId('sha256:abc123', firstPage, 0, 'text')
  const secondBlock = createDocumentBlockId('sha256:abc123', firstPage, 1, 'text')
  const tableBlock = createDocumentBlockId('sha256:abc123', firstPage, 0, 'table')

  assert.equal(firstPage, createDocumentPageId('sha256:abc123', 0))
  assert.match(firstPage, /^page-[a-f0-9]{12}$/u)
  assert.notEqual(firstPage, secondPage)
  assert.equal(firstBlock, createDocumentBlockId('sha256:abc123', firstPage, 0, 'text'))
  assert.match(firstBlock, /^block-[a-f0-9]{12}$/u)
  assert.notEqual(firstBlock, secondBlock)
  assert.notEqual(firstBlock, tableBlock)
  assert.notEqual(firstPage, createDocumentPageId('sha256:def456', 0))
})

test('文档模型应可稳定序列化并拒绝未知 schema 与损坏结构', () => {
  const model = createModel()
  const serialized = serializeDocumentModel(model)
  const parsed = parseDocumentModel(JSON.parse(serialized))

  assert.deepEqual(parsed, model)
  assert.equal(JSON.parse(serialized).schemaVersion, DOCUMENT_MODEL_SCHEMA_VERSION)
  assert.throws(
    () => parseDocumentModel({ ...model, schemaVersion: DOCUMENT_MODEL_SCHEMA_VERSION + 1 }),
    /schema/iu
  )
  assert.throws(() => parseDocumentModel({ ...model, pages: 'invalid' }), /pages/iu)
  assert.throws(
    () => parseDocumentModel({
      ...model,
      pages: [{ ...model.pages[0], blocks: [{ ...model.pages[0].blocks[0], kind: 'unknown' }] }]
    }),
    /block/iu
  )
})

test('文档模型应校验并保留 PDF 页面正文区边界', () => {
  const model = createModel()
  model.pages[0]!.contentArea = { left: 72, right: 540, center: 306 }

  const parsed = parseDocumentModel(JSON.parse(serializeDocumentModel(model)))
  assert.deepEqual(parsed.pages[0]!.contentArea, { left: 72, right: 540, center: 306 })
  assert.throws(
    () => parseDocumentModel({
      ...model,
      pages: [{ ...model.pages[0], contentArea: { left: 72, right: 'invalid', center: 306 } }]
    }),
    /contentArea\.right/iu
  )
})

test('文档模型应校验并保留 PDF 同行布局分组标识', () => {
  const model = createModel()
  model.pages[0]!.blocks[0]!.flowGroupId = 'page-group-1'

  const parsed = parseDocumentModel(JSON.parse(serializeDocumentModel(model)))
  assert.equal(parsed.pages[0]!.blocks[0]!.flowGroupId, 'page-group-1')
  assert.throws(
    () => parseDocumentModel({
      ...model,
      pages: [{
        ...model.pages[0],
        blocks: [{ ...model.pages[0]!.blocks[0], flowGroupId: '   ' }]
      }]
    }),
    /flowGroupId/iu
  )
})

test('文档模型应校验并保留目录页码', () => {
  const model = createModel()
  const block = model.pages[0]!.blocks[0]!
  assert.equal(block.kind, 'text')
  if (block.kind !== 'text') return
  block.toc = { pageNumber: '2' }

  const parsed = parseDocumentModel(JSON.parse(serializeDocumentModel(model)))
  const parsedBlock = parsed.pages[0]!.blocks[0]!
  assert.equal(parsedBlock.kind === 'text' ? parsedBlock.toc?.pageNumber : undefined, '2')
  assert.throws(
    () => parseDocumentModel({
      ...model,
      pages: [{
        ...model.pages[0],
        blocks: [{ ...block, toc: { pageNumber: '   ' } }]
      }]
    }),
    /toc\.pageNumber/iu
  )
  assert.throws(
    () => parseDocumentModel({
      ...model,
      pages: [{
        ...model.pages[0],
        blocks: [{ ...block, toc: { pageNumber: 2 } }]
      }]
    }),
    /toc\.pageNumber/iu
  )
})
