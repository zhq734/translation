import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import {
  DocumentWorkspaceTaskService,
  type DocumentWorkspaceTaskServiceDependencies
} from '../src/main/documentWorkspaceTaskService.ts'
import type { DocumentFormat, DocumentModel } from '../src/shared/documentTypes.ts'
import type {
  DocumentWorkspaceSnapshot,
  DocumentWorkspaceTranslationUpdate
} from '../src/shared/documentWorkspace.ts'

/**
 * 构造一个带图片资源的文档模型，模拟解析器输出。
 * @param format 文档格式。
 * @param path 源文件路径。
 * @param renderPending 扫描 PDF 页面是否等待栅格化。
 * @returns 文档模型。
 * @author zhenghq
 */
function imageDocument(format: DocumentFormat, path: string, renderPending: boolean): DocumentModel {
  const assetId = `${format}-image-asset`
  const blockId = `${format}-image-block`
  return {
    schemaVersion: 1,
    documentId: `${format}-integration-document`,
    source: {
      path,
      fileName: path.split('/').at(-1) ?? `sample.${format}`,
      format,
      sha256: `${format}-fixture`,
      size: 16
    },
    metadata: { direction: 'auto' },
    pages: [{
      pageId: `${format}-page-1`,
      index: 0,
      width: 600,
      height: 800,
      blocks: [{
        kind: 'image',
        blockId,
        readingOrder: 0,
        translatable: false,
        assetId,
        bbox: { x: 20, y: 30, width: 560, height: 740 },
        ...(renderPending ? { renderPending: true } : {})
      }]
    }],
    assets: [{
      assetId,
      kind: 'image',
      mimeType: 'image/png',
      sha256: `${format}-asset-sha`,
      byteLength: 8,
      width: 600,
      height: 800
    }],
    warnings: []
  }
}

/**
 * 构造可被文件头校验识别的扫描 PDF 夹具。
 * @returns PDF 字节。
 * @author zhenghq
 */
function scannedPdfBytes(): Uint8Array {
  return new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n')
}

/**
 * 构造包含 DOCX 必需 OOXML 条目的最小 ZIP 包。
 * @returns DOCX 字节。
 * @author zhenghq
 */
async function docxBytes(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>')
  zip.file('word/media/image1.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' })
}

/**
 * 等待任务进入终态，避免依赖固定延时。
 * @param events 已收集的任务事件。
 * @returns 终态快照。
 * @author zhenghq
 */
async function waitForTerminal(events: DocumentWorkspaceSnapshot[]): Promise<DocumentWorkspaceSnapshot> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const terminal = events.findLast((event) => (
      event.task.status === 'completed' ||
      event.task.status === 'partial' ||
      event.task.status === 'cancelled' ||
      event.task.status === 'failed'
    ))
    if (terminal) return terminal
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for document integration task')
}

/**
 * 运行扫描 PDF 或 DOCX 图片的完整链路，并验证 OCR、增量翻译与导出。
 * @param format 待验证格式。
 * @returns 无返回值。
 * @author zhenghq
 */
async function runIntegration(format: 'pdf' | 'docx'): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `document-integration-${format}-`))
  const path = join(directory, `sample.${format}`)
  const bytes = format === 'pdf' ? scannedPdfBytes() : await docxBytes()
  await writeFile(path, bytes)
  const events: DocumentWorkspaceSnapshot[] = []
  const updates: DocumentWorkspaceTranslationUpdate[] = []
  const exportModels: DocumentModel[] = []
  const ocrInputs: Uint8Array[] = []
  const exportPath = join(directory, `translated-${format}.pdf`)
  let exportDependencies: Parameters<DocumentWorkspaceTaskServiceDependencies['exportPdf']>[1] | undefined
  const dependencies: DocumentWorkspaceTaskServiceDependencies = {
    isApprovedPath: (candidate) => candidate === path,
    sendProgress: (snapshot) => events.push(snapshot),
    sendTranslationUpdate: (update) => updates.push(update),
    sendCompleted: (snapshot) => events.push(snapshot),
    parse: async (input, registerAssetBytes) => {
      assert.equal(input.format, format)
      registerAssetBytes?.(`${format}-image-asset`, new Uint8Array([1, 2, 3, 4]))
      return imageDocument(format, path, format === 'pdf')
    },
    recognizeImage: async (imageBytes) => {
      ocrInputs.push(imageBytes)
      return {
        text: format === 'pdf' ? 'Scanned PDF body' : 'Embedded DOCX image',
        lines: [{
          text: format === 'pdf' ? 'Scanned PDF body' : 'Embedded DOCX image',
          confidence: 0.98
        }],
        engine: 'system'
      }
    },
    loadAssetBytes: async () => null,
    translate: async (text) => `译文：${text}`,
    loadFontBytes: async () => new Uint8Array([1, 2, 3]),
    exportPdf: async (model, deps) => {
      exportModels.push(model)
      exportDependencies = deps
      return { bytes: new TextEncoder().encode('%PDF-1.7\nexport\n'), warnings: [] }
    },
    showSaveDialog: async () => ({ canceled: false, filePath: exportPath }),
    writeFile: async (target, data) => writeFile(target, data),
    rename: async (source, target) => {
      await rm(target, { force: true })
      await import('node:fs/promises').then(({ rename }) => rename(source, target))
    },
    unlink: async (target) => rm(target, { force: true }),
    maxFileBytes: () => 1024 * 1024
  }
  const service = new DocumentWorkspaceTaskService(dependencies)
  try {
    const accepted = await service.run({ path, generation: 1 })
    assert.equal(accepted.accepted, true)
    const completed = await waitForTerminal(events)
    assert.equal(completed.task.status, 'completed')
    assert.equal(completed.percent, 100)
    assert.equal(completed.completionReport?.status, 'completed')

    assert.equal(ocrInputs.length, 1)
    assert.ok(ocrInputs[0]!.byteLength > 0)
    const sourceImage = completed.source?.pages[0]?.blocks[0]
    assert.equal(sourceImage?.kind, 'image')
    assert.equal(sourceImage?.kind === 'image' ? sourceImage.ocrRegions?.[0]?.status : null, 'recognized')
    const translatedImage = completed.translation?.pages[0]?.blocks[0]
    assert.equal(translatedImage?.kind === 'image' ? translatedImage.ocrRegions?.[0]?.translatedText : null,
      format === 'pdf' ? '译文：Scanned PDF body' : '译文：Embedded DOCX image')
    assert.ok(updates.length > 0, '翻译完成后必须推送块级增量')
    assert.ok(updates.every((update) => update.jobId === completed.jobId && update.generation === 1))
    assert.ok(updates.some((update) => update.blockId === `${format}-image-block`))

    const exported = await service.exportPdf({
      jobId: completed.jobId,
      generation: completed.generation,
      mode: 'complete',
      layout: 'translation'
    })
    assert.deepEqual(exported, { status: 'saved', filePath: exportPath })
    assert.equal(exportModels.length, 1)
    assert.equal(exportModels[0]?.source.format, format)
    assert.ok(exportDependencies)
    assert.equal(new TextDecoder().decode(await readFile(exportPath)), '%PDF-1.7\nexport\n')
  } finally {
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}

test('扫描 PDF 必须完成解析、OCR、翻译、块级增量展示与 PDF 导出', async () => {
  await runIntegration('pdf')
})

test('DOCX 内嵌图片必须完成解析、OCR、翻译、块级增量展示与 PDF 导出', async () => {
  await runIntegration('docx')
})
