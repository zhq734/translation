import { ipcMain } from 'electron'
import type { WebPagePdfExportResult, WebTranslationRunRequest, WebViewBounds } from '../../shared/types'
import { isWebTranslationMode } from '../../shared/webPageTranslation'
import type { WebReaderManager } from '../webReaderWindow'

/** 网页阅读器 IPC 注册依赖。 */
export interface WebReaderIpcDependencies {
  /** 从弹窗打开网页阅读器。 */
  openWebReader(url?: string): void
  /** 延迟服务就绪后执行阅读器操作。 */
  runWhenReady(action: () => void): void
  /** 等待服务就绪后返回网页阅读器。 */
  getReadyWebReader(): Promise<WebReaderManager>
  /** 返回当前网页阅读器。 */
  getWebReader(): WebReaderManager
  /** 判断 IPC 是否来自当前网页阅读器窗口。 */
  isWebReaderSender(sender: Electron.WebContents): boolean
  /** 返回无效网址提示。 */
  getInvalidUrlMessage(): string
  /** 返回无效显示模式提示。 */
  getInvalidModeMessage(): string
}

/**
 * 校验网页阅读器窗口尺寸。
 * @param value 未信任的 IPC 负载。
 * @returns 负载合法时返回 true。
 * @author zhenghq
 */
function isWebViewBounds(value: unknown): value is WebViewBounds {
  if (!value || typeof value !== 'object') return false
  const bounds = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every(
    (key) => typeof bounds[key] === 'number' && Number.isFinite(bounds[key])
  )
}

/**
 * 校验网页翻译范围、源语言和目标语言。
 * @param value 未信任的 IPC 负载。
 * @returns 负载合法时返回 true。
 * @author zhenghq
 */
function isWebTranslationRunRequest(value: unknown): value is WebTranslationRunRequest {
  if (value === undefined || value === null) return true
  if (typeof value !== 'object') return false
  const request = value as Record<string, unknown>
  const validScope = request.scope === undefined || request.scope === 'body' || request.scope === 'all'
  const validSource = request.sourceLang === undefined || typeof request.sourceLang === 'string'
  const validTarget = request.targetLang === undefined || typeof request.targetLang === 'string'
  return validScope && validSource && validTarget
}

/**
 * 注册网页阅读器导航、翻译和导出 IPC。
 * @param dependencies 阅读器窗口、延迟服务和校验提示依赖。
 * @returns 无返回值。
 * @author zhenghq
 */
export function registerWebReaderIpc(dependencies: WebReaderIpcDependencies): void {
  ipcMain.on('webview:open', (_event, url: unknown) => {
    if (typeof url === 'string' && url.trim()) {
      dependencies.openWebReader(url)
      return
    }
    dependencies.openWebReader()
  })
  ipcMain.on('webview:close', () => {
    dependencies.runWhenReady(() => dependencies.getWebReader().close())
  })
  ipcMain.handle('webview:navigate', async (_event, url: unknown) => {
    if (typeof url !== 'string' || !url.trim()) {
      throw new Error(dependencies.getInvalidUrlMessage())
    }
    return (await dependencies.getReadyWebReader()).navigate(url)
  })
  ipcMain.on('webview:back', () => {
    dependencies.runWhenReady(() => dependencies.getWebReader().back())
  })
  ipcMain.on('webview:forward', () => {
    dependencies.runWhenReady(() => dependencies.getWebReader().forward())
  })
  ipcMain.on('webview:reload', () => {
    dependencies.runWhenReady(() => dependencies.getWebReader().reload())
  })
  ipcMain.on('webview:set-bounds', (_event, bounds: unknown) => {
    if (!isWebViewBounds(bounds)) return
    dependencies.runWhenReady(() => dependencies.getWebReader().setBounds(bounds))
  })
  ipcMain.handle('web-translate:extract', async () =>
    (await dependencies.getReadyWebReader()).extract()
  )
  ipcMain.handle('web-translate:run', async (_event, request: unknown) =>
    (await dependencies.getReadyWebReader()).run(
      isWebTranslationRunRequest(request) ? request : {}
    )
  )
  ipcMain.on('web-translate:cancel', () => {
    dependencies.runWhenReady(() => dependencies.getWebReader().cancel())
  })
  ipcMain.handle('web-translate:set-mode', async (_event, mode: unknown) => {
    if (!isWebTranslationMode(mode)) throw new Error(dependencies.getInvalidModeMessage())
    return (await dependencies.getReadyWebReader()).setMode(mode)
  })
  /**
   * 将当前网页译文导出为带水印 PDF。
   * @param event IPC 事件对象。
   * @returns 保存、取消或拒绝结果。
   * @author zhenghq
   */
  ipcMain.handle('web-translate:export-pdf', async (event): Promise<WebPagePdfExportResult> => {
    if (!dependencies.isWebReaderSender(event.sender)) {
      return { status: 'rejected', code: 'unreadable' }
    }
    return (await dependencies.getReadyWebReader()).exportPdf()
  })
}
