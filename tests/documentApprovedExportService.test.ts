import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DocumentApprovedExportService,
  type DocumentApprovedExportServiceDependencies
} from '../src/main/documentApprovedExportService.ts'
import {
  DocumentPdfExportError,
  type DocumentPdfExportDependencies,
  type DocumentPdfExportResult
} from '../src/main/documentPdfExport.ts'
import type { DocumentModel } from '../src/shared/documentTypes.ts'
import type { DocumentApprovedExportRequest } from '../src/shared/documentWorkspace.ts'

/**
 * 构造历史文档单语导出测试请求。
 * @param format 源文件格式。
 * @returns 包含一页译文的导出请求。
 * @author zhenghq
 */
function createRequest(format: 'pdf' | 'docx' = 'pdf'): DocumentApprovedExportRequest {
  return {
    source: {
      path: `/tmp/history.${format}`,
      format,
      sourceSha256: 'a'.repeat(64),
      sourceSize: 128
    },
    fileName: `history.${format}`,
    translation: {
      schemaVersion: 1,
      documentId: 'history-document',
      source: {
        path: `/tmp/history.${format}`,
        fileName: `history.${format}`,
        format,
        sha256: 'a'.repeat(64),
        size: 128,
        pageCount: 1
      },
      metadata: { direction: 'ltr' },
      pages: [{
        pageId: 'page-1',
        index: 0,
        width: 612,
        height: 792,
        blocks: [{
          kind: 'text',
          blockId: 'block-1',
          readingOrder: 0,
          translatable: true,
          role: 'paragraph',
          runs: [{ runId: 'run-1', text: '仅导出译文' }]
        }]
      }],
      assets: [],
      warnings: []
    }
  }
}

/**
 * 构造可观察的历史导出服务依赖。
 * @param overrides 需要替换的依赖实现。
 * @returns 记录调用行为的服务依赖。
 * @author zhenghq
 */
function createDependencies(
  overrides: Partial<DocumentApprovedExportServiceDependencies> = {}
): DocumentApprovedExportServiceDependencies {
  return {
    validateSource: async () => ({ ok: true, format: 'pdf' }),
    getAsset: async () => ({ ok: false, code: 'asset-not-found' }),
    loadFontBytes: async () => null,
    exportPdf: async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      warnings: []
    }),
    showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/exported.pdf' }),
    writeFile: async () => undefined,
    rename: async () => undefined,
    unlink: async () => undefined,
    openExportFolder: async () => undefined,
    ...overrides
  }
}

test('历史导出只记录成功文件并允许打开最近一次导出目录', async () => {
  const opened: string[] = []
  const service = new DocumentApprovedExportService(createDependencies({
    openExportFolder: async (filePath) => {
      opened.push(filePath)
    }
  }))

  assert.equal(await service.openLastExportFolder(), false)
  assert.deepEqual(await service.exportPdf(createRequest()), {
    status: 'saved',
    filePath: '/tmp/exported.pdf'
  })
  assert.equal(await service.openLastExportFolder(), true)
  assert.deepEqual(opened, ['/tmp/exported.pdf'])
})

test('历史导出取消时不得记录可打开的导出目录', async () => {
  const opened: string[] = []
  const service = new DocumentApprovedExportService(createDependencies({
    showSaveDialog: async () => ({ canceled: true }),
    openExportFolder: async (filePath) => {
      opened.push(filePath)
    }
  }))

  assert.deepEqual(await service.exportPdf(createRequest()), { status: 'cancelled' })
  assert.equal(await service.openLastExportFolder(), false)
  assert.deepEqual(opened, [])
})

test('历史导出只能打开本会话实际成功写出的指定路径', async () => {
  const opened: string[] = []
  const service = new DocumentApprovedExportService(createDependencies({
    openExportFolder: async (filePath) => {
      opened.push(filePath)
    }
  }))

  assert.equal(await service.openExportFolder('/tmp/arbitrary.pdf'), false)
  await service.exportPdf(createRequest())
  assert.equal(await service.openExportFolder('/tmp/arbitrary.pdf'), false)
  assert.equal(await service.openExportFolder('/tmp/exported.pdf'), true)
  assert.deepEqual(opened, ['/tmp/exported.pdf'])
})

test('历史导出在源文件校验失败时直接拒绝且不打开保存框', async () => {
  for (const code of ['source-not-approved', 'source-changed', 'source-not-found'] as const) {
    let saveDialogCalls = 0
    const service = new DocumentApprovedExportService(createDependencies({
      validateSource: async () => ({ ok: false, code }),
      showSaveDialog: async () => {
        saveDialogCalls += 1
        return { canceled: false, filePath: '/tmp/exported.pdf' }
      }
    }))

    assert.deepEqual(await service.exportPdf(createRequest()), {
      status: 'rejected',
      code
    })
    assert.equal(saveDialogCalls, 0)
  }
})

test('历史导出在源文件或译文源格式变化时返回 source-changed', async () => {
  const actualFormatChanged = new DocumentApprovedExportService(createDependencies({
    validateSource: async () => ({ ok: true, format: 'docx' })
  }))
  assert.deepEqual(await actualFormatChanged.exportPdf(createRequest('pdf')), {
    status: 'rejected',
    code: 'source-changed'
  })

  const request = createRequest('pdf')
  request.translation.source.format = 'docx'
  const modelFormatChanged = new DocumentApprovedExportService(createDependencies())
  assert.deepEqual(await modelFormatChanged.exportPdf(request), {
    status: 'rejected',
    code: 'source-changed'
  })
})

test('历史导出在用户取消保存时不合成或写入 PDF', async () => {
  let exportCalls = 0
  let writeCalls = 0
  const service = new DocumentApprovedExportService(createDependencies({
    showSaveDialog: async () => ({ canceled: true }),
    exportPdf: async () => {
      exportCalls += 1
      return { bytes: new Uint8Array([1]), warnings: [] }
    },
    writeFile: async () => {
      writeCalls += 1
    }
  }))

  assert.deepEqual(await service.exportPdf(createRequest()), { status: 'cancelled' })
  assert.equal(exportCalls, 0)
  assert.equal(writeCalls, 0)
})

test('历史导出只把译文模型交给 PDF 合成并原子写入最终文件', async () => {
  const request = createRequest()
  const pdfBytes = new Uint8Array([37, 80, 68, 70])
  let exportedModel: DocumentModel | undefined
  let exportedDependencies: DocumentPdfExportDependencies | undefined
  let exportOptions: { includeOcrTextLayer?: boolean } | undefined
  let temporaryPath = ''
  let renameSource = ''
  let renameTarget = ''
  let unlinkCalls = 0
  const service = new DocumentApprovedExportService(createDependencies({
    exportPdf: async (model, dependencies, options) => {
      exportedModel = model
      exportedDependencies = dependencies
      exportOptions = options
      return { bytes: pdfBytes, warnings: [] }
    },
    writeFile: async (path, bytes) => {
      temporaryPath = path
      assert.deepEqual(bytes, pdfBytes)
    },
    rename: async (source, target) => {
      renameSource = source
      renameTarget = target
    },
    unlink: async () => {
      unlinkCalls += 1
    }
  }))

  assert.deepEqual(await service.exportPdf(request), {
    status: 'saved',
    filePath: '/tmp/exported.pdf'
  })
  assert.strictEqual(exportedModel, request.translation)
  assert.equal(exportedDependencies?.sourcePdfBytes, undefined)
  assert.equal(Object.hasOwn(exportedDependencies ?? {}, 'sourcePdfBytes'), false)
  assert.deepEqual(exportOptions, { includeOcrTextLayer: true })
  assert.match(temporaryPath, /^\/tmp\/exported\.pdf\..+\.tmp$/u)
  assert.equal(renameSource, temporaryPath)
  assert.equal(renameTarget, '/tmp/exported.pdf')
  assert.equal(unlinkCalls, 0)
})

test('历史导出必须按译文快照加载图片资源并保持稳定元数据', async () => {
  const request = createRequest()
  request.translation.pages[0]!.blocks = [{
    kind: 'image',
    blockId: 'image-block',
    readingOrder: 0,
    translatable: false,
    bbox: { x: 24, y: 32, width: 160, height: 90 },
    assetId: 'image-1',
    alt: '历史图片'
  }]
  request.translation.assets = [{
    assetId: 'image-1',
    kind: 'image',
    mimeType: 'image/png',
    sha256: 'b'.repeat(64),
    byteLength: 4,
    storageKey: 'word/media/image1.png'
  }]
  const assetBytes = new Uint8Array([4, 3, 2, 1])
  let requestedAsset: Parameters<DocumentApprovedExportServiceDependencies['getAsset']>[0] | undefined
  const service = new DocumentApprovedExportService(createDependencies({
    getAsset: async (assetRequest) => {
      requestedAsset = assetRequest
      return { ok: true, mimeType: 'image/png', bytes: assetBytes }
    },
    exportPdf: async (_model, dependencies) => {
      assert.deepEqual(await dependencies.loadAssetBytes('image-1'), assetBytes)
      assert.equal(await dependencies.loadAssetBytes('missing'), null)
      return { bytes: new Uint8Array([1]), warnings: [] }
    }
  }))

  assert.deepEqual(await service.exportPdf(request), {
    status: 'saved',
    filePath: '/tmp/exported.pdf'
  })
  assert.deepEqual(requestedAsset, {
    ...request.source,
    assetId: 'image-1',
    assetSha256: 'b'.repeat(64),
    assetByteLength: 4,
    storageKey: 'word/media/image1.png',
    mimeType: 'image/png',
    pageIndex: 0,
    bbox: { x: 24, y: 32, width: 160, height: 90 }
  })
})

test('历史导出必须把 PDF 合成异常映射为稳定错误码', async () => {
  const fontMissing = new DocumentApprovedExportService(createDependencies({
    exportPdf: async () => {
      throw new DocumentPdfExportError('font-missing', 'font unavailable')
    }
  }))
  assert.deepEqual(await fontMissing.exportPdf(createRequest()), {
    status: 'rejected',
    code: 'font-missing'
  })

  const unexpected = new DocumentApprovedExportService(createDependencies({
    exportPdf: async () => {
      throw new Error('internal detail')
    }
  }))
  assert.deepEqual(await unexpected.exportPdf(createRequest()), {
    status: 'rejected',
    code: 'export-failed'
  })
})

test('历史导出返回合成告警并在写入失败时清理临时文件', async () => {
  const warning = {
    code: 'asset-unavailable' as const,
    severity: 'warning' as const,
    message: '图片不可用'
  }
  const successful = new DocumentApprovedExportService(createDependencies({
    exportPdf: async () => ({
      bytes: new Uint8Array([1]),
      warnings: [warning]
    })
  }))
  assert.deepEqual(await successful.exportPdf(createRequest()), {
    status: 'saved',
    filePath: '/tmp/exported.pdf',
    warnings: [warning]
  })

  let unlinkCalls = 0
  const failedWrite = new DocumentApprovedExportService(createDependencies({
    writeFile: async () => {
      throw new Error('disk full')
    },
    unlink: async () => {
      unlinkCalls += 1
    }
  }))
  assert.deepEqual(await failedWrite.exportPdf(createRequest()), {
    status: 'rejected',
    code: 'export-failed'
  })
  assert.equal(unlinkCalls, 1)
})
