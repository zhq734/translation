import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentModel } from '../src/shared/documentTypes.ts'
import {
  applyDocumentManualTranslationEdits,
  collectDocumentManualTranslationEdits,
  createDocumentManualTextBlockEdits,
  createDocumentManualTocEdits,
  normalizeDocumentManualTranslationEdits,
  preserveDocumentManualTranslationEdits,
  setDocumentManualTranslationText,
  type DocumentManualTranslationEdit
} from '../src/shared/documentManualTranslationEdits.ts'

/**
 * 构造覆盖普通文本、表格文本和 OCR 区域的手动译文测试模型。
 * @returns 可递归定位的文档模型。
 * @author zhenghq
 */
function model(): DocumentModel {
  return {
    schemaVersion: 1,
    documentId: 'manual-edit-document',
    source: {
      path: '/tmp/manual-edit.pdf',
      fileName: 'manual-edit.pdf',
      format: 'pdf',
      sha256: 'fixture',
      size: 2048,
      pageCount: 1
    },
    metadata: { direction: 'ltr' },
    pages: [{
      pageId: 'page-1',
      index: 0,
      width: 612,
      height: 792,
      blocks: [
        {
          kind: 'text',
          blockId: 'text-1',
          readingOrder: 0,
          translatable: true,
          role: 'paragraph',
          runs: [{ runId: 'run-1', text: '自动译文' }]
        },
        {
          kind: 'table',
          blockId: 'table-1',
          readingOrder: 1,
          translatable: false,
          rows: [{
            rowId: 'row-1',
            cells: [{
              cellId: 'cell-1',
              rowSpan: 1,
              colSpan: 1,
              blocks: [{
                kind: 'text',
                blockId: 'cell-text-1',
                readingOrder: 0,
                translatable: true,
                role: 'paragraph',
                runs: [{ runId: 'cell-run-1', text: '单元格自动译文' }]
              }]
            }]
          }]
        },
        {
          kind: 'image',
          blockId: 'image-1',
          readingOrder: 2,
          translatable: false,
          assetId: 'asset-1',
          ocrRegions: [{
            regionId: 'region-1',
            pageId: 'page-1',
            blockId: 'image-1',
            assetId: 'asset-1',
            bbox: { x: 0, y: 0, width: 1, height: 1 },
            text: 'Scanned',
            status: 'recognized',
            translatedText: '自动 OCR 译文'
          }]
        }
      ]
    }],
    assets: [],
    warnings: []
  }
}

/**
 * 构造普通 run 的手动编辑。
 * @returns 手动编辑条目。
 * @author zhenghq
 */
function runEdit(): DocumentManualTranslationEdit {
  return { pageId: 'page-1', blockId: 'text-1', runId: 'run-1', text: '人工译文' }
}

test('手动译文编辑必须规范化并拒绝目标不唯一、ID 非法或超量输入', () => {
  assert.deepEqual(normalizeDocumentManualTranslationEdits([runEdit()]), [runEdit()])
  assert.equal(normalizeDocumentManualTranslationEdits([{ ...runEdit(), regionId: 'region-1' }]), null)
  assert.equal(normalizeDocumentManualTranslationEdits([{ pageId: ' ', blockId: 'text-1', runId: 'run-1', text: 'x' }]), null)
  assert.equal(normalizeDocumentManualTranslationEdits([{ ...runEdit(), runId: 'bad\nid' }]), null)
  assert.equal(normalizeDocumentManualTranslationEdits([{ ...runEdit(), text: 'line\rcontrol' }]), null)
  assert.equal(normalizeDocumentManualTranslationEdits([{ ...runEdit(), text: 'line\n\tok' }]), null)
  assert.equal(normalizeDocumentManualTranslationEdits(Array.from({ length: 10_001 }, () => runEdit())), null)
})

test('手动译文编辑必须递归写入普通文本、表格内部与 OCR 区域', () => {
  const edits: DocumentManualTranslationEdit[] = [
    runEdit(),
    { pageId: 'page-1', blockId: 'cell-text-1', runId: 'cell-run-1', text: '单元格人工译文' },
    { pageId: 'page-1', blockId: 'image-1', regionId: 'region-1', text: '人工 OCR 译文' }
  ]

  const applied = applyDocumentManualTranslationEdits(model(), edits)
  assert.ok(applied)
  const text = applied.pages[0]!.blocks[0]!
  const table = applied.pages[0]!.blocks[1]!
  const image = applied.pages[0]!.blocks[2]!
  assert.equal(text.kind, 'text')
  assert.equal(table.kind, 'table')
  assert.equal(image.kind, 'image')
  if (text.kind !== 'text' || table.kind !== 'table' || image.kind !== 'image') return
  assert.deepEqual(text.runs[0], {
    runId: 'run-1',
    text: '人工译文',
    manuallyEdited: true
  })
  const cellText = table.rows[0]!.cells[0]!.blocks[0]!
  assert.equal(cellText.kind, 'text')
  if (cellText.kind !== 'text') return
  assert.equal(cellText.runs[0]?.text, '单元格人工译文')
  assert.equal(cellText.runs[0]?.manuallyEdited, true)
  assert.equal(image.ocrRegions?.[0]?.translatedText, '人工 OCR 译文')
  assert.equal(image.ocrRegions?.[0]?.manuallyEdited, true)
})

test('手动译文编辑缺少目标时必须整体失败且不修改输入模型', () => {
  const source = model()
  assert.equal(applyDocumentManualTranslationEdits(source, [{
    pageId: 'page-1',
    blockId: 'missing-block',
    runId: 'run-1',
    text: 'x'
  }]), null)
  assert.equal(source.pages[0]!.blocks[0]!.kind, 'text')
  if (source.pages[0]!.blocks[0]!.kind === 'text') {
    assert.equal(source.pages[0]!.blocks[0]!.runs[0]?.text, '自动译文')
  }
})

test('手动编辑收集器只返回已经标记的手改目标并保留表格递归路径', () => {
  const edited = applyDocumentManualTranslationEdits(model(), [
    runEdit(),
    { pageId: 'page-1', blockId: 'cell-text-1', runId: 'cell-run-1', text: '单元格人工译文' },
    { pageId: 'page-1', blockId: 'image-1', regionId: 'region-1', text: '人工 OCR 译文' }
  ])
  assert.ok(edited)
  assert.deepEqual(collectDocumentManualTranslationEdits(edited), [
    { pageId: 'page-1', blockId: 'text-1', runId: 'run-1', text: '人工译文' },
    { pageId: 'page-1', blockId: 'cell-text-1', runId: 'cell-run-1', text: '单元格人工译文' },
    { pageId: 'page-1', blockId: 'image-1', regionId: 'region-1', text: '人工 OCR 译文' }
  ])
})

test('设置手改文本必须返回不可变新模型并同步手改标记', () => {
  const source = model()
  const updated = setDocumentManualTranslationText(source, {
    pageId: 'page-1',
    blockId: 'text-1',
    runId: 'run-1',
    text: '人工修改'
  })
  assert.ok(updated)
  assert.notEqual(updated, source)
  assert.equal(updated.pages[0]!.blocks[0]!.kind, 'text')
  if (updated.pages[0]!.blocks[0]!.kind === 'text') {
    assert.equal(updated.pages[0]!.blocks[0]!.runs[0]?.text, '人工修改')
    assert.equal(updated.pages[0]!.blocks[0]!.runs[0]?.manuallyEdited, true)
  }
  assert.equal(source.pages[0]!.blocks[0]!.kind, 'text')
  if (source.pages[0]!.blocks[0]!.kind === 'text') {
    assert.equal(source.pages[0]!.blocks[0]!.runs[0]?.text, '自动译文')
  }
})

test('目录标题手改必须聚合成一次原子编辑，并清空其余可见 run', () => {
  const source = model()
  const firstBlock = source.pages[0]!.blocks[0]!
  assert.equal(firstBlock.kind, 'text')
  if (firstBlock.kind !== 'text') return
  firstBlock.toc = { pageNumber: '1' }
  firstBlock.runs = [
    { runId: 'toc-title-1', text: '自动' },
    { runId: 'toc-title-2', text: '目录' },
    { runId: 'toc-page', text: '1', protected: true }
  ]

  assert.deepEqual(createDocumentManualTocEdits(source, 'page-1', 'text-1', '人工目录'), [
    { pageId: 'page-1', blockId: 'text-1', runId: 'toc-title-1', text: '人工目录' },
    { pageId: 'page-1', blockId: 'text-1', runId: 'toc-title-2', text: '' }
  ])
  const updated = applyDocumentManualTranslationEdits(
    source,
    createDocumentManualTocEdits(source, 'page-1', 'text-1', '人工目录')
  )
  assert.ok(updated)
  assert.equal(updated.pages[0]!.blocks[0]!.kind, 'text')
  if (updated.pages[0]!.blocks[0]!.kind !== 'text') return
  assert.deepEqual(updated.pages[0]!.blocks[0]!.runs.map((run) => run.text), ['人工目录', '', '1'])
  assert.equal(updated.pages[0]!.blocks[0]!.runs[0]?.manuallyEdited, true)
  assert.equal(updated.pages[0]!.blocks[0]!.runs[1]?.manuallyEdited, true)
})

test('普通文本块手改必须聚合到首个可编辑 run，并清空其余可编辑 run', () => {
  const source = model()
  const textBlock = source.pages[0]!.blocks[0]!
  assert.equal(textBlock.kind, 'text')
  if (textBlock.kind !== 'text') return
  textBlock.runs = [
    { runId: 'run-1', text: '自动' },
    { runId: 'run-2', text: '译文' }
  ]

  assert.deepEqual(createDocumentManualTextBlockEdits(source, 'page-1', 'text-1', '人工整块译文'), [
    { pageId: 'page-1', blockId: 'text-1', runId: 'run-1', text: '人工整块译文' },
    { pageId: 'page-1', blockId: 'text-1', runId: 'run-2', text: '' }
  ])
  const updated = applyDocumentManualTranslationEdits(
    source,
    createDocumentManualTextBlockEdits(source, 'page-1', 'text-1', '人工整块译文')
  )
  assert.ok(updated)
  const updatedBlock = updated.pages[0]!.blocks[0]!
  assert.equal(updatedBlock.kind, 'text')
  if (updatedBlock.kind !== 'text') return
  assert.deepEqual(updatedBlock.runs.map((run) => run.text), ['人工整块译文', ''])
  assert.equal(updatedBlock.runs.every((run) => run.manuallyEdited === true), true)
})

test('快照合并必须保留当前手改，并在 incoming 缺少译文时保留已有译文', () => {
  const current = model()
  const edited = applyDocumentManualTranslationEdits(current, [
    runEdit(),
    { pageId: 'page-1', blockId: 'cell-text-1', runId: 'cell-run-1', text: '单元格人工译文' },
    { pageId: 'page-1', blockId: 'image-1', regionId: 'region-1', text: '人工 OCR 译文' }
  ])
  assert.ok(edited)
  const incoming = model()
  incoming.pages[0]!.blocks[0]!.kind === 'text'
  const incomingText = incoming.pages[0]!.blocks[0]!
  if (incomingText.kind === 'text') incomingText.runs[0]!.text = '流式新译文'
  const incomingTable = incoming.pages[0]!.blocks[1]!
  if (incomingTable.kind === 'table') {
    const cellText = incomingTable.rows[0]!.cells[0]!.blocks[0]!
    if (cellText.kind === 'text') cellText.runs[0]!.text = '单元格流式新译文'
  }
  const incomingImage = incoming.pages[0]!.blocks[2]!
  if (incomingImage.kind === 'image') incomingImage.ocrRegions![0]!.translatedText = '流式 OCR 新译文'

  const merged = preserveDocumentManualTranslationEdits(edited, incoming)
  assert.ok(merged)
  const mergedText = merged.pages[0]!.blocks[0]!
  assert.equal(mergedText.kind, 'text')
  if (mergedText.kind === 'text') {
    assert.equal(mergedText.runs[0]?.text, '人工译文')
    assert.equal(mergedText.runs[0]?.manuallyEdited, true)
  }
  const mergedTable = merged.pages[0]!.blocks[1]!
  if (mergedTable.kind === 'table') {
    const cellText = mergedTable.rows[0]!.cells[0]!.blocks[0]!
    if (cellText.kind === 'text') assert.equal(cellText.runs[0]?.text, '单元格人工译文')
  }
  const mergedImage = merged.pages[0]!.blocks[2]!
  if (mergedImage.kind === 'image') assert.equal(mergedImage.ocrRegions?.[0]?.translatedText, '人工 OCR 译文')
  assert.notEqual(merged, edited)
  assert.notEqual(merged, incoming)

  const preserved = preserveDocumentManualTranslationEdits(edited, undefined)
  assert.deepEqual(preserved, edited)
  assert.notEqual(preserved, edited)
})
