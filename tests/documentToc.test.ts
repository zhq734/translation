import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentModel, DocumentTextBlock } from '../src/shared/documentTypes.ts'
import {
  buildDocumentTocItems,
  resolveDocumentTocTarget
} from '../src/renderer/src/documentViewer.ts'

/**
 * 创建文本区块测试数据。
 * @param blockId 区块标识。
 * @param text 文本内容。
 * @param options 可选的语义角色、字号与保护片段。
 * @returns 文本区块。
 * @author zhenghq
 */
function textBlock(
  blockId: string,
  text: string,
  options: {
    role?: DocumentTextBlock['role']
    fontSize?: number
    fontWeight?: number
    tocPageNumber?: string
    protectedText?: string
  } = {}
): DocumentTextBlock {
  return {
    kind: 'text',
    blockId,
    readingOrder: 0,
    translatable: options.tocPageNumber === undefined,
    role: options.role ?? 'paragraph',
    ...(options.tocPageNumber === undefined ? {} : { toc: { pageNumber: options.tocPageNumber } }),
    runs: [
      {
        runId: `${blockId}-title`,
        text,
        style: {
          ...(options.fontSize === undefined ? {} : { fontSize: options.fontSize }),
          ...(options.fontWeight === undefined ? {} : { fontWeight: options.fontWeight })
        }
      },
      ...(options.protectedText === undefined
        ? []
        : [{ runId: `${blockId}-protected`, text: options.protectedText, protected: true }])
    ]
  }
}

/**
 * 创建包含指定页面的文档模型。
 * @param format 源文件格式。
 * @param pages 页面标题与区块内容。
 * @returns 文档模型。
 * @author zhenghq
 */
function model(
  format: 'pdf' | 'docx',
  pages: Array<{ title?: string; blocks: DocumentTextBlock[] }>
): DocumentModel {
  return {
    schemaVersion: 1,
    documentId: `toc-${format}`,
    source: {
      path: `/tmp/toc.${format}`,
      fileName: `toc.${format}`,
      format,
      sha256: `toc-${format}-sha`,
      size: 1024
    },
    metadata: { direction: 'ltr' },
    pages: pages.map((page, index) => ({
      pageId: `page-${index + 1}`,
      index,
      width: 600,
      height: 800,
      ...(page.title ? { title: page.title } : {}),
      blocks: page.blocks.map((block, blockIndex) => ({ ...block, readingOrder: blockIndex }))
    })),
    assets: [],
    warnings: []
  }
}

test('PDF 显式目录只使用非保护标题文本定位真实章节锚点', () => {
  const document = model('pdf', [
    {
      blocks: [
        textBlock('toc-item', 'Chapter One', {
          tocPageNumber: '2',
          protectedText: '........................2'
        })
      ]
    },
    {
      blocks: [
        textBlock('chapter-one', 'Chapter One', { role: 'heading', fontSize: 22 })
      ]
    }
  ])

  assert.deepEqual(buildDocumentTocItems(document), [{
    title: 'Chapter One',
    target: {
      pageId: 'page-2',
      pageIndex: 1,
      pageNumber: 2,
      blockId: 'chapter-one'
    }
  }])
})

test('PDF 缺少显式目录时应按字号层级生成章节锚点', () => {
  const document = model('pdf', [{
    blocks: [
      textBlock('paragraph-before', 'This is body copy with enough text to establish the body size.', { fontSize: 10 }),
      textBlock('section-heading', '2. Installation', { fontSize: 20, fontWeight: 700 }),
      textBlock('paragraph-after', 'Continue reading the installation chapter body copy.', { fontSize: 10 })
    ]
  }])

  assert.deepEqual(buildDocumentTocItems(document), [{
    title: '2. Installation',
    target: {
      pageId: 'page-1',
      pageIndex: 0,
      pageNumber: 1,
      blockId: 'section-heading'
    }
  }])
})

test('DOCX 标题应直接进入目录，不依赖打印目录页', () => {
  const document = model('docx', [{
    blocks: [
      textBlock('docx-heading', '项目配置说明', { role: 'heading', fontSize: 20, fontWeight: 700 }),
      textBlock('docx-paragraph', '普通正文内容。', { fontSize: 12 })
    ]
  }])

  assert.deepEqual(buildDocumentTocItems(document), [{
    title: '项目配置说明',
    target: {
      pageId: 'page-1',
      pageIndex: 0,
      pageNumber: 1,
      blockId: 'docx-heading'
    }
  }])
})

test('目录记录页码有偏移时应继续按标题搜索真实锚点', () => {
  const document = model('pdf', [
    { blocks: [] },
    { blocks: [] },
    { blocks: [textBlock('chapter-three', 'Chapter Three', { role: 'heading', fontSize: 22 })] }
  ])

  assert.deepEqual(resolveDocumentTocTarget(document, 'Chapter Three', '2'), {
    pageId: 'page-3',
    pageIndex: 2,
    pageNumber: 3,
    blockId: 'chapter-three'
  })
})

test('显式目录标题位于表格单元格内时仍能找到真实锚点', () => {
  const nestedHeading = textBlock('nested-heading', '表格章节', { role: 'heading', fontSize: 20 })
  const document = model('docx', [
    {
      blocks: [
        textBlock('toc-entry', '表格章节', { tocPageNumber: '2', protectedText: '……2' })
      ]
    },
    {
      blocks: [{
        kind: 'table',
        blockId: 'table-1',
        readingOrder: 0,
        translatable: false,
        rows: [{
          cells: [{
            cellId: 'cell-1',
            blocks: [{ ...nestedHeading, readingOrder: 0 }]
          }]
        }]
      }]
    }
  ])

  assert.deepEqual(resolveDocumentTocTarget(document, '表格章节', '2'), {
    pageId: 'page-2',
    pageIndex: 1,
    pageNumber: 2,
    blockId: 'nested-heading'
  })
})
