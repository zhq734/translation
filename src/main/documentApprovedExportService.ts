import { basename, extname } from 'node:path'
import type {
  DocumentApprovedAssetRequest,
  DocumentApprovedExportRequest,
  DocumentAssetResult,
  DocumentExportResult
} from '../shared/documentWorkspace.ts'
import type {
  DocumentBlock,
  DocumentFormat,
  DocumentImageBlock,
  DocumentModel
} from '../shared/documentTypes.ts'
import { writeDocumentFileAtomically } from './documentAtomicFile.ts'
import {
  DocumentPdfExportError,
  exportDocumentToPdf,
  type DocumentPdfExportResult
} from './documentPdfExport.ts'

/** 历史文档导出保存对话框结果。 */
export interface DocumentApprovedExportSaveDialogResult {
  /** 用户是否取消保存。 */
  canceled: boolean
  /** 用户选择的目标路径。 */
  filePath?: string
}

/** 已批准历史文档导出服务依赖。 */
export interface DocumentApprovedExportServiceDependencies {
  /** 重新校验源文件授权、大小、SHA-256 与实际格式。 */
  validateSource(request: DocumentApprovedExportRequest['source']): Promise<
    { ok: true; format: DocumentFormat } |
    { ok: false; code: 'source-not-approved' | 'source-changed' | 'source-not-found' }
  >
  /** 读取已批准源文件中的受控图片资源。 */
  getAsset(request: DocumentApprovedAssetRequest): Promise<DocumentAssetResult>
  /** 读取支持 CJK 的字体字节。 */
  loadFontBytes(): Promise<Uint8Array | null>
  /** 合成单语译文 PDF。 */
  exportPdf(
    model: DocumentModel,
    dependencies: {
      loadFontBytes(): Promise<Uint8Array | null>
      loadAssetBytes(assetId: string): Promise<Uint8Array | null>
    },
    options?: { includeOcrTextLayer?: boolean }
  ): Promise<DocumentPdfExportResult>
  /** 显示 PDF 保存对话框。 */
  showSaveDialog(suggestedName: string): Promise<DocumentApprovedExportSaveDialogResult>
  /** 写入临时 PDF。 */
  writeFile(path: string, bytes: Uint8Array): Promise<void>
  /** 原子替换最终 PDF。 */
  rename(source: string, target: string): Promise<void>
  /** 清理失败或取消后的临时文件。 */
  unlink(path: string): Promise<void>
  /** 在系统文件管理器中定位成功导出的文件。 */
  openExportFolder(filePath: string): Promise<void>
}

/** 图片资源在译文模型中的定位信息。 */
interface ApprovedImageLocation {
  /** 图片所在页面索引。 */
  pageIndex: number
  /** 图片区块。 */
  block: DocumentImageBlock
}

/**
 * 将错误映射为界面可识别的稳定导出错误码。
 * @param error 捕获的异常。
 * @returns 稳定错误码。
 * @author zhenghq
 */
function exportErrorCode(error: unknown): string {
  if (error instanceof DocumentPdfExportError) return error.code
  if (error && typeof error === 'object' && 'code' in error &&
    typeof error.code === 'string') return error.code
  return 'export-failed'
}

/**
 * 递归收集文档区块中的图片及其所属页面。
 * @param blocks 当前区块列表。
 * @param pageIndex 区块所在页面索引。
 * @param output 图片定位结果集合。
 * @returns 无返回值。
 * @author zhenghq
 */
function collectImageLocations(
  blocks: DocumentBlock[],
  pageIndex: number,
  output: ApprovedImageLocation[]
): void {
  for (const block of blocks) {
    if (block.kind === 'image') {
      output.push({ pageIndex, block })
      continue
    }
    if (block.kind !== 'table') continue
    for (const row of block.rows) {
      for (const cell of row.cells) collectImageLocations(cell.blocks, pageIndex, output)
    }
  }
}

/**
 * 构造安全的默认 PDF 文件名，避免 Renderer 提供的路径参与保存位置决策。
 * @param fileName 原始文件名。
 * @returns 仅包含文件名的建议输出名。
 * @author zhenghq
 */
function suggestedTranslatedFileName(fileName: string): string {
  const safeName = basename(fileName)
  const stem = safeName.slice(0, safeName.length - extname(safeName).length) || 'document'
  return `${stem}-translated.pdf`
}

/**
 * 导出已重新授权历史文档中的已保存译文。
 *
 * 服务不信任 Renderer 提供的路径或模型来源；导出前会重新校验源文件，
 * 并只使用已解析的 translation 模型合成单语 PDF。资源读取始终绑定源快照。
 * @author zhenghq
 */
export class DocumentApprovedExportService {
  private readonly dependencies: DocumentApprovedExportServiceDependencies
  /** 本会话最近一次历史文档成功导出的最终文件路径。 */
  private lastExportPath: string | null = null
  /** 本会话所有历史文档成功导出的最终文件路径，只用于校验 Renderer 回传的打开请求。 */
  private readonly exportedPaths = new Set<string>()

  /**
   * 创建历史文档导出服务。
   * @param dependencies 源校验、资源读取、字体、保存与写入依赖。
   * @author zhenghq
   */
  constructor(dependencies: DocumentApprovedExportServiceDependencies) {
    this.dependencies = dependencies
  }

  /**
   * 导出已批准历史文档的译文模型。
   * @param request 已规范化的源信息、文件名与译文模型。
   * @returns 保存、取消或拒绝结果。
   * @author zhenghq
   */
  async exportPdf(request: DocumentApprovedExportRequest): Promise<DocumentExportResult> {
    const validation = await this.dependencies.validateSource(request.source)
    if (!validation.ok) return { status: 'rejected', code: validation.code }
    if (validation.format !== request.source.format ||
      request.translation.source.format !== validation.format) {
      return { status: 'rejected', code: 'source-changed' }
    }

    const images: ApprovedImageLocation[] = []
    for (const page of request.translation.pages) {
      collectImageLocations(page.blocks, page.index, images)
    }
    const imageLocations = new Map<string, ApprovedImageLocation[]>()
    for (const image of images) {
      const entries = imageLocations.get(image.block.assetId) ?? []
      entries.push(image)
      imageLocations.set(image.block.assetId, entries)
    }

    const save = await this.dependencies.showSaveDialog(
      suggestedTranslatedFileName(request.fileName)
    )
    if (save.canceled || !save.filePath) return { status: 'cancelled' }

    try {
      const result = await this.dependencies.exportPdf(request.translation, {
        loadFontBytes: () => this.dependencies.loadFontBytes(),
        loadAssetBytes: async (assetId) => {
          const asset = request.translation.assets.find((candidate) =>
            candidate.assetId === assetId && candidate.kind === 'image')
          if (!asset) return null
          const locations = imageLocations.get(assetId) ?? []
          // PDF 图片必须按页面与 bbox 重新定位；无定位信息时不读取任意资源。
          for (const location of locations) {
            const assetRequest: DocumentApprovedAssetRequest = {
              ...request.source,
              assetId,
              assetSha256: asset.sha256,
              assetByteLength: asset.byteLength,
              ...(asset.storageKey ? { storageKey: asset.storageKey } : {}),
              ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
              ...(location.block.bbox
                ? { pageIndex: location.pageIndex, bbox: location.block.bbox }
                : {})
            }
            const loaded = await this.dependencies.getAsset(assetRequest)
            if (loaded.ok && loaded.bytes) return loaded.bytes
          }
          return null
        }
      }, { includeOcrTextLayer: true })
      await writeDocumentFileAtomically(save.filePath, result.bytes, {
        writeFile: (path, bytes) => this.dependencies.writeFile(path, bytes),
        rename: (source, target) => this.dependencies.rename(source, target),
        unlink: (path) => this.dependencies.unlink(path)
      })
      // 只有原子写入成功后才会更新目录入口，取消或失败时继续保留上一次成功路径。
      this.lastExportPath = save.filePath
      this.exportedPaths.add(save.filePath)
      return {
        status: 'saved',
        filePath: save.filePath,
        ...(result.warnings.length > 0 ? { warnings: result.warnings } : {})
      }
    } catch (error) {
      return { status: 'rejected', code: exportErrorCode(error) }
    }
  }

  /**
   * 在系统文件管理器中定位本会话最近一次成功导出的历史文档。
   * @returns 存在成功路径且文件管理器调用成功时返回 true。
   * @author zhenghq
   */
  async openLastExportFolder(): Promise<boolean> {
    if (!this.lastExportPath) return false
    try {
      await this.dependencies.openExportFolder(this.lastExportPath)
      return true
    } catch {
      return false
    }
  }

  /**
   * 打开本会话指定历史导出文件所在目录。
   * Renderer 只能回传主进程已记录的成功路径，不能借此打开任意本地位置。
   * @param filePath 主进程曾成功导出的历史文件路径。
   * @returns 文件属于本会话成功导出记录且文件管理器调用成功时返回 true。
   * @author zhenghq
   */
  async openExportFolder(filePath: string): Promise<boolean> {
    if (!this.exportedPaths.has(filePath)) return false
    try {
      await this.dependencies.openExportFolder(filePath)
      return true
    } catch {
      return false
    }
  }
}
