import { app, dialog, shell, type BrowserWindow } from 'electron'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Settings } from '../shared/types'
import {
  getDocumentPlatformCapability,
  getDocumentPlatformUnsupportedMessageKey
} from '../shared/documentPlatformCapability'
import { openDocumentExportFolder } from './documentExportFolder'

/** 文档运行时按需加载，避免 Win7 主进程启动时 require 被裁掉的 PDF 依赖。 */
export interface DocumentMainRuntime {
  /** 文档解析入口。 */
  parseDocument: typeof import('./documentParser').parseDocument
  /** PDF 页面栅格化器工厂。 */
  createProductionPdfRasterizer: typeof import('./documentPdfRuntime').createProductionPdfRasterizer
  /** PDF 导出入口。 */
  exportDocumentToPdf: typeof import('./documentPdfExport').exportDocumentToPdf
  /** 内置 CJK 字体加载器。 */
  loadDocumentPdfFontBytes: typeof import('./documentPdfFont').loadDocumentPdfFontBytes
  /** 文档任务服务构造器。 */
  DocumentWorkspaceTaskService: typeof import('./documentWorkspaceTaskService').DocumentWorkspaceTaskService
  /** 历史文档资源服务构造器。 */
  DocumentApprovedResourceService: typeof import('./documentApprovedResourceService').DocumentApprovedResourceService
  /** 历史文档导出服务构造器。 */
  DocumentApprovedExportService: typeof import('./documentApprovedExportService').DocumentApprovedExportService
  /** 文档翻译缓存存储构造器。 */
  DocumentTranslationCacheStore: typeof import('./documentTranslationCache').DocumentTranslationCacheStore
  /** 文档任务历史存储构造器。 */
  DocumentTaskHistoryStore: typeof import('./documentTaskHistory').DocumentTaskHistoryStore
  /** 历史与恢复 Tab 的受控资源读取服务。 */
  approvedResourceService: import('./documentApprovedResourceService').DocumentApprovedResourceService
  /** 历史与恢复 Tab 的单语译文导出服务。 */
  approvedExportService: import('./documentApprovedExportService').DocumentApprovedExportService
}

/** 文档运行时控制器依赖。 */
export interface DocumentRuntimeControllerDependencies {
  /** 判断路径是否已由当前文档窗口批准。 */
  isApprovedPath(path: string): boolean
  /** 返回当前文档工作台窗口；窗口关闭时返回 null。 */
  getWorkspaceWindow(): BrowserWindow | null
  /** 使用主进程当前语言翻译文案。 */
  translate(messageKey: string): string
  /** 读取当前应用设置。 */
  getSettings(): Settings
}

/**
 * 管理文档解析、导出、翻译缓存和任务历史的按需运行时。
 * @author zhenghq
 */
export class DocumentRuntimeController {
  private runtimePromise: Promise<DocumentMainRuntime> | null = null
  private translationCache: import('./documentTranslationCache').DocumentTranslationCacheStore | null = null
  private taskHistory: import('./documentTaskHistory').DocumentTaskHistoryStore | null = null

  /**
   * 创建文档运行时控制器。
   * @param dependencies 主进程注入的窗口、审批、设置和文案依赖。
   * @author zhenghq
   */
  constructor(private readonly dependencies: DocumentRuntimeControllerDependencies) {}

  /**
   * 按需加载文档翻译运行时。
   *
   * Win7 安装包会排除 PDF.js、Canvas、pdf-lib 与字体资源，因此这些模块不能在
   * 主进程启动图中静态引用。只有平台能力校验通过后才加载；加载失败会清除缓存，
   * 让后续请求可以重试并避免把半初始化状态永久保留。
   * @returns 已初始化且可复用的文档运行时。
   * @author zhenghq
   */
  async load(): Promise<DocumentMainRuntime> {
    const capability = getDocumentPlatformCapability()
    if (!capability.supported) {
      const messageKey = getDocumentPlatformUnsupportedMessageKey(capability)
        ?? 'document.error.unsupportedPlatform'
      throw new Error(this.dependencies.translate(messageKey))
    }
    this.runtimePromise ??= (async () => {
      const [
        { parseDocument },
        { createProductionPdfRasterizer },
        { exportDocumentToPdf },
        { loadDocumentPdfFontBytes },
        { DocumentWorkspaceTaskService },
        { DocumentApprovedResourceService },
        { createWorkerPdfAssetParseRunner },
        { DocumentApprovedExportService },
        { DocumentTranslationCacheStore },
        { DocumentTaskHistoryStore }
      ] = await Promise.all([
        import('./documentParser'),
        import('./documentPdfRuntime'),
        import('./documentPdfExport'),
        import('./documentPdfFont'),
        import('./documentWorkspaceTaskService'),
        import('./documentApprovedResourceService'),
        import('./documentApprovedAssetParseWorkerRunner'),
        import('./documentApprovedExportService'),
        import('./documentTranslationCache'),
        import('./documentTaskHistory')
      ])
      const approvedResourceService = new DocumentApprovedResourceService({
        isApprovedPath: (path) => this.dependencies.isApprovedPath(path),
        // 受控资源的 PDF 全量重解析必须放在独立线程，否则 15s+ 的同步解析会冻结整个应用。
        parsePdfAsset: createWorkerPdfAssetParseRunner()
      })
      const approvedExportService = new DocumentApprovedExportService({
        validateSource: (request) => approvedResourceService.validateSource(request),
        getAsset: (request) => approvedResourceService.getAsset(request),
        loadFontBytes: () => loadDocumentPdfFontBytes({
          isPackaged: app.isPackaged,
          appPath: app.getAppPath(),
          resourcesPath: process.resourcesPath
        }),
        exportPdf: (model, dependencies, options) => exportDocumentToPdf(model, dependencies, {
          includeOcrTextLayer: options?.includeOcrTextLayer !== false
        }),
        showSaveDialog: async (suggestedName) => {
          const window = this.dependencies.getWorkspaceWindow()
          const result = window
            ? await dialog.showSaveDialog(window, {
              title: this.dependencies.translate('document.export'),
              defaultPath: suggestedName,
              filters: [{ name: 'PDF', extensions: ['pdf'] }]
            })
            : await dialog.showSaveDialog({
              title: this.dependencies.translate('document.export'),
              defaultPath: suggestedName,
              filters: [{ name: 'PDF', extensions: ['pdf'] }]
            })
          return {
            canceled: result.canceled,
            ...(result.filePath ? { filePath: result.filePath } : {})
          }
        },
        writeFile: async (path, bytes) => {
          await writeFile(path, bytes)
        },
        rename: async (source, target) => {
          await rename(source, target)
        },
        unlink,
        openExportFolder: async (filePath) => {
          const opened = await openDocumentExportFolder(filePath, {
            showItemInFolder: (targetPath) => shell.showItemInFolder(targetPath),
            openPath: (path) => shell.openPath(path)
          })
          if (!opened) throw new Error('open-export-folder-failed')
        }
      })
      return {
        parseDocument,
        createProductionPdfRasterizer,
        exportDocumentToPdf,
        loadDocumentPdfFontBytes,
        DocumentWorkspaceTaskService,
        DocumentApprovedResourceService,
        DocumentApprovedExportService,
        DocumentTranslationCacheStore,
        DocumentTaskHistoryStore,
        approvedResourceService,
        approvedExportService
      }
    })().catch((error) => {
      this.runtimePromise = null
      throw error
    })
    return this.runtimePromise
  }

  /**
   * 返回主进程共享的文档翻译缓存，并在首次访问时按当前设置创建。
   * @param runtime 已加载的文档运行时。
   * @returns 文档翻译缓存存储。
   * @author zhenghq
   */
  getTranslationCacheStore(
    runtime: DocumentMainRuntime
  ): import('./documentTranslationCache').DocumentTranslationCacheStore {
    const settings = this.dependencies.getSettings()
    const configuration = {
      maxBytes: settings.documentTranslationCacheMaxBytes,
      maxAgeMs: settings.documentTranslationCacheMaxAgeDays * 24 * 60 * 60 * 1000
    }
    if (!this.translationCache) {
      this.translationCache = new runtime.DocumentTranslationCacheStore({
        directory: join(app.getPath('userData'), 'document-translation-cache'),
        ...configuration
      })
    } else {
      void this.applyTranslationCacheConfiguration(settings).catch((error) => {
        console.error('[document-cache] 同步缓存配置失败:', (error as Error).message)
      })
    }
    return this.translationCache
  }

  /**
   * 在缓存已经创建时立即应用最新容量与保留期；尚未加载文档运行时则无需处理。
   * @param settings 当前完整设置。
   * @returns 配置已应用时返回 true，缓存尚未创建时返回 false。
   * @author zhenghq
   */
  async applyTranslationCacheConfiguration(settings: Settings): Promise<boolean> {
    if (!this.translationCache) return false
    await this.translationCache.configure({
      maxBytes: settings.documentTranslationCacheMaxBytes,
      maxAgeMs: settings.documentTranslationCacheMaxAgeDays * 24 * 60 * 60 * 1000
    })
    return true
  }

  /**
   * 返回主进程共享的文档任务历史存储。
   * @param runtime 已加载的文档运行时。
   * @returns 文档任务历史存储。
   * @author zhenghq
   */
  getTaskHistoryStore(
    runtime: DocumentMainRuntime
  ): import('./documentTaskHistory').DocumentTaskHistoryStore {
    this.taskHistory ??= new runtime.DocumentTaskHistoryStore({
      directory: join(app.getPath('userData'), 'document-task-history'),
      maxEntries: 100
    })
    return this.taskHistory
  }
}

/**
 * 创建文档运行时控制器的便捷入口。
 * @param dependencies 主进程注入的窗口、审批、设置和文案依赖。
 * @returns 文档运行时控制器实例。
 * @author zhenghq
 */
export function createDocumentRuntimeController(
  dependencies: DocumentRuntimeControllerDependencies
): DocumentRuntimeController {
  return new DocumentRuntimeController(dependencies)
}
