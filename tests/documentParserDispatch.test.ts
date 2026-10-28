import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDocument } from '../src/main/documentParser.ts'
import type { DocumentFormat, DocumentModel } from '../src/shared/documentTypes.ts'

/**
 * 构造测试用最小文档模型。
 * @param format 文档格式。
 * @returns 最小文档模型。
 * @author zhenghq
 */
function model(format: DocumentFormat): DocumentModel {
  return {
    schemaVersion: 1,
    documentId: `document-${format}`,
    source: {
      path: `/tmp/sample.${format}`,
      fileName: `sample.${format}`,
      format,
      sha256: 'fixture',
      size: 3
    },
    metadata: { direction: 'auto' },
    pages: [{ pageId: 'page-1', index: 0, width: 100, height: 100, blocks: [] }],
    assets: [],
    warnings: []
  }
}

test('统一解析调度器必须按格式选择对应解析器', async () => {
  const expected: Record<DocumentFormat, string> = {
    pdf: 'pdf',
    docx: 'docx',
    epub: 'epub',
    html: 'html',
    markdown: 'markdown',
    txt: 'txt',
    json: 'txt',
    csv: 'delimited',
    srt: 'subtitle',
    vtt: 'subtitle'
  }
  for (const format of Object.keys(expected) as DocumentFormat[]) {
    const calls: string[] = []
    const result = await parseDocument({
      path: `/tmp/sample.${format}`,
      fileName: `sample.${format}`,
      format,
      sha256: 'fixture',
      bytes: new Uint8Array([1, 2, 3])
    }, {
      parseText: async () => { calls.push('txt'); return model(format) },
      parseMarkdown: async () => { calls.push('markdown'); return model(format) },
      parseDelimited: async () => { calls.push('delimited'); return model(format) },
      parseSubtitle: async () => { calls.push('subtitle'); return model(format) },
      parseHtml: async () => { calls.push('html'); return model(format) },
      parsePdf: async () => { calls.push('pdf'); return model(format) },
      parseDocx: async () => { calls.push('docx'); return model(format) },
      parseEpub: async () => { calls.push('epub'); return model(format) }
    })
    assert.deepEqual(calls, [expected[format]], format)
    assert.equal(result.source.format, format)
  }
})

test('统一解析调度器必须把 PDF 栅格化函数透传并拒绝不支持的格式', async () => {
  let renderer: unknown
  let embeddedImageRenderer: unknown
  await parseDocument({
    path: '/tmp/sample.pdf',
    fileName: 'sample.pdf',
    format: 'pdf',
    sha256: 'fixture',
    bytes: new Uint8Array([1])
  }, {
    parseText: async () => model('txt'),
    parseMarkdown: async () => model('markdown'),
    parseDelimited: async () => model('csv'),
    parseSubtitle: async () => model('srt'),
    parseHtml: async () => model('html'),
    parsePdf: async (_input, options) => {
      renderer = options.renderPageToImage
      embeddedImageRenderer = options.renderEmbeddedImageToImage
      return model('pdf')
    },
    parseDocx: async () => model('docx'),
    parseEpub: async () => model('epub'),
    renderPageToImage: async () => new Uint8Array([1]),
    renderEmbeddedImageToImage: async () => new Uint8Array([2])
  })
  assert.equal(typeof renderer, 'function')
  assert.equal(typeof embeddedImageRenderer, 'function')

  await assert.rejects(() => parseDocument({
    path: '/tmp/sample.exe',
    fileName: 'sample.exe',
    format: 'exe' as DocumentFormat,
    sha256: 'fixture',
    bytes: new Uint8Array([1])
  }, {
    parseText: async () => model('txt'),
    parseMarkdown: async () => model('markdown'),
    parseDelimited: async () => model('csv'),
    parseSubtitle: async () => model('srt'),
    parseHtml: async () => model('html'),
    parsePdf: async () => model('pdf'),
    parseDocx: async () => model('docx'),
    parseEpub: async () => model('epub')
  }), /unsupported document format/u)
})
