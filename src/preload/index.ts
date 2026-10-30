import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Locale } from '../shared/i18n/locale'
import type {
  Api,
  LogEntry,
  TranslatePayload,
  TranslateDeltaPayload,
  PopupAutoSizeRequest,
  ManualTranslateRequest,
  Settings,
  DeepLxStatus,
  DeepLxConfigPatch,
  DingTalkConfigPatch,
  AiConfigPatch,
  AiCheckStatus,
  AiModelListResult,
  MacOSQuarantineResult,
  UpdateStatus,
  EdgeSpeechResult,
  PronunciationAudioResult,
  PronunciationResult,
  OcrSelectionBeginPayload,
  OcrSelectionReadyPayload,
  OcrSelectionBounds,
  OcrSelectionFailedPayload,
  OcrSelectionSnapshotPayload,
  OcrStatus,
  ScreenshotToastKind,
  ScreenshotOcrActionRequest,
  ScreenshotOcrActionResult,
  ScreenshotAnnotatedExportRequest,
  ScreenshotExportImageRequest,
  ScreenshotExportImageResult,
  ScreenshotOcrRecognizeResult,
  WebReaderState,
  WebPagePdfExportResult,
  WebTranslationExtractionPayload,
  WebTranslationMode,
  WebTranslationProgressPayload,
  WebTranslationRunPayload,
  WebTranslationRunRequest,
  WebViewBounds,
  CaptureDiagnosticsSummary,
  GlobalShortcutRegistrationState
  , DocumentFileSelectionResult
  , DocumentPlatformCapability
  , DocumentAssetResult
  , DocumentExportRequest
  , DocumentExportResult
  , DocumentRunRequest
  , DocumentRunResult
  , DocumentSourceResult
  , DocumentWorkspaceSnapshot
  , DocumentWorkspaceTranslationUpdate
} from '../shared/types'

/** 同步读取主进程当前已解析的界面语言，供首屏脚本在 DOM 渲染前使用。 */
function getSelectionTranslatorLocale(): Locale {
  try {
    const locale = ipcRenderer.sendSync('i18n:get-current-locale')
    return locale === 'zh-CN' ? 'zh-CN' : 'en-US'
  } catch {
    // 同步通道不可用时保持英文兜底，避免 preload 异常导致整个 API 未暴露。
    return 'en-US'
  }
}

contextBridge.exposeInMainWorld('getSelectionTranslatorLocale', getSelectionTranslatorLocale)

/**
 * 同步读取主进程是否启用 Windows 7 兼容外观。
 * @returns 当前运行时启用 Win7 兼容模式时返回 true。
 * @author zhenghq
 */
function getSelectionTranslatorWin7Compatibility(): boolean {
  try {
    return ipcRenderer.sendSync('app:get-win7-compatibility') === true
  } catch {
    // 同步通道不可用时保持现代系统外观，避免 preload 异常阻断其余 API。
    return false
  }
}

contextBridge.exposeInMainWorld(
  'getSelectionTranslatorWin7Compatibility',
  getSelectionTranslatorWin7Compatibility
)

const api: Api = {
  /**
   * 最小化当前受信任窗口。
   * @returns 无返回值。
   * @author zhenghq
   */
  windowMinimize() {
    ipcRenderer.send('window:minimize')
  },
  /**
   * 切换当前受信任窗口的最大化或恢复状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  windowToggleMaximize() {
    ipcRenderer.send('window:toggle-maximize')
  },
  /**
   * 关闭当前受信任窗口。
   * @returns 无返回值。
   * @author zhenghq
   */
  windowClose() {
    ipcRenderer.send('window:close')
  },
  /**
   * 读取当前受信任窗口是否已最大化。
   * @returns 最大化状态。
   * @author zhenghq
   */
  windowIsMaximized() {
    return ipcRenderer.invoke('window:is-maximized')
  },
  /**
   * 订阅当前受信任窗口的最大化状态变化。
   * @param callback 最大化状态回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onWindowMaximizedChanged(callback: (maximized: boolean) => void) {
    const listener = (_event: unknown, maximized: boolean): void => callback(maximized)
    ipcRenderer.on('window:maximized-changed', listener)
    return () => ipcRenderer.removeListener('window:maximized-changed', listener)
  },
  /**
   * 订阅翻译结果。
   * @param callback 翻译负载回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onResult(callback: (payload: TranslatePayload) => void) {
    const listener = (_event: unknown, payload: TranslatePayload): void => callback(payload)
    ipcRenderer.on('translate:result', listener)
    return () => ipcRenderer.removeListener('translate:result', listener)
  },
  /**
   * 订阅流式翻译增量。
   * @param callback 增量负载回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onTranslateDelta(callback: (payload: TranslateDeltaPayload) => void) {
    const listener = (_event: unknown, payload: TranslateDeltaPayload): void => callback(payload)
    ipcRenderer.on('translate:delta', listener)
    return () => ipcRenderer.removeListener('translate:delta', listener)
  },
  /**
   * 订阅主进程打开手动翻译模式的通知。
   * @param callback 手动翻译打开回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onManualTranslateOpen(callback: () => void) {
    const listener = (): void => callback()
    ipcRenderer.on('manual-translate:open', listener)
    return () => ipcRenderer.removeListener('manual-translate:open', listener)
  },
  /**
   * 订阅主进程切回划词翻译模式的通知。
   * @param callback 划词模式打开回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onSelectionMode(callback: () => void) {
    const listener = (): void => callback()
    ipcRenderer.on('popup:selection-mode', listener)
    return () => ipcRenderer.removeListener('popup:selection-mode', listener)
  },
  /**
   * 请求主进程显示并固定手动翻译模式。
   * @returns 无返回值。
   * @author zhenghq
   */
  openManualTranslate() {
    ipcRenderer.send('manual-translate:open-request')
  },
  /**
   * 复制文本到系统剪贴板。
   * @param text 待复制文本。
   * @returns 无返回值。
   * @author zhenghq
   */
  copy(text: string) {
    ipcRenderer.send('popup:copy', text)
  },
  /**
   * 读取系统剪贴板中的纯文本。
   * @returns 剪贴板文本；无文本时返回空字符串。
   * @author zhenghq
   */
  readClipboardText(): Promise<string> {
    return ipcRenderer.invoke('clipboard:read-text')
  },
  /**
   * 查询单个英文单词的 IPA 音标。
   * @param word 已由 Renderer 识别出的英文单词。
   * @returns 主进程返回的脱敏音标结果。
   * @author zhenghq
   */
  lookupPronunciation: (word: string, requestId?: string): Promise<PronunciationResult> =>
    ipcRenderer.invoke('pronunciation:lookup', word, requestId),
  /**
   * 下载当前音标结果中已登记的词典音频。
   * @param word 当前查询词。
   * @param variantId 主进程返回的变体标识。
   * @returns 临时音频字节或脱敏错误。
   * @author zhenghq
   */
  fetchPronunciationAudio: (
    word: string,
    variantId: string,
    requestId?: string
  ): Promise<PronunciationAudioResult> =>
    ipcRenderer.invoke('pronunciation:audio', word, variantId, requestId),
  /**
   * 取消当前音标查询或音频下载。
   * @param requestId Renderer 生成的请求 ID。
   * @returns 无返回值。
   * @author zhenghq
   */
  cancelPronunciationRequest(requestId: string): void {
    ipcRenderer.send('pronunciation:cancel', requestId)
  },
  /**
   * 通知主进程暂停或恢复音标交互期间的自动隐藏。
   * @param active 是否处于音标交互状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  setPronunciationInteraction(active: boolean): void {
    ipcRenderer.send('pronunciation:interaction', active)
  },
  /**
   * 关闭翻译弹窗。
   * @returns 无返回值。
   * @author zhenghq
   */
  hide() {
    ipcRenderer.send('popup:hide')
  },
  /**
   * 请求主进程按内容自然尺寸调整弹窗大小。
   * @param size 目标尺寸。
   * @returns 无返回值。
   * @author zhenghq
   */
  resizePopup(size: PopupAutoSizeRequest) {
    ipcRenderer.send('popup:resize', size)
  },
  /**
   * 从翻译弹窗打开设置窗口。
   * @returns 无返回值。
   * @author zhenghq
   */
  openSettings() {
    ipcRenderer.send('settings:open')
  },
  /**
   * 打开或聚焦独立文档翻译工作台。
   * @returns 无返回值。
   * @author zhenghq
   */
  openDocumentWorkspace() {
    ipcRenderer.send('document:open')
  },
  /**
   * 通过主进程文件选择器导入并校验一个本地文档。
   * @returns 选择、取消或拒绝结果。
   * @author zhenghq
   */
  selectDocumentFile: (): Promise<DocumentFileSelectionResult> =>
    ipcRenderer.invoke('document:select-file'),
  /**
   * 通过主进程文件选择器一次导入并校验多个本地文档。
   * @returns 每个候选文件的选择、取消或拒绝结果。
   * @author zhenghq
   */
  selectDocumentFiles: (): Promise<DocumentFileSelectionResult[]> =>
    ipcRenderer.invoke('document:select-files'),
  /**
   * 重新校验拖放得到的本地路径，并在主进程登记为当前窗口可运行文件。
   * @param path 拖放文件对应的本地绝对路径。
   * @returns 选择、取消或拒绝结果。
   * @author zhenghq
   */
  approveDocumentFile: (path: string): Promise<DocumentFileSelectionResult> =>
    ipcRenderer.invoke('document:approve-file', path),
  /**
   * 重新校验拖放得到的多个本地路径，并在主进程登记为当前窗口可运行文件。
   * @param paths 拖放文件对应的本地绝对路径列表。
   * @returns 每个候选文件的选择或拒绝结果。
   * @author zhenghq
   */
  approveDocumentFiles: (paths: string[]): Promise<DocumentFileSelectionResult[]> =>
    ipcRenderer.invoke('document:approve-files', paths),
  /**
   * 查询当前平台是否允许启用文档翻译。
   * @returns 平台能力结果。
   * @author zhenghq
   */
  getDocumentPlatformCapability: (): Promise<DocumentPlatformCapability> =>
    ipcRenderer.invoke('document:get-platform-capability'),
  /**
   * 启动当前文档窗口已批准文件的翻译任务。
   * @param request 文件路径、任务代际与可选语言偏好。
   * @returns 主进程是否接受任务。
   * @author zhenghq
   */
  runDocument: (request: DocumentRunRequest): Promise<DocumentRunResult> =>
    ipcRenderer.invoke('document:run', request),
  /**
   * 使用新代际重新翻译当前文档中的失败项。
   * @param generation Renderer 生成的新任务代际。
   * @returns 主进程是否接受重试。
   * @author zhenghq
   */
  retryFailedDocument: (generation: number): Promise<DocumentRunResult> =>
    ipcRenderer.invoke('document:retry-failed', generation),
  /**
   * 取消当前文档翻译任务。
   * @param jobId 任务标识。
   * @param generation 任务代际。
   * @returns 是否实际发出了取消请求。
   * @author zhenghq
   */
  cancelDocument: (jobId: string, generation: number): Promise<boolean> =>
    ipcRenderer.invoke('document:cancel', jobId, generation),
  /**
   * 校验当前任务并导出完整或已确认的部分 PDF。
   * @param request 当前任务标识、代际与导出模式。
   * @returns 保存、取消或拒绝结果。
   * @author zhenghq
   */
  exportDocumentPdf: (request: DocumentExportRequest): Promise<DocumentExportResult> =>
    ipcRenderer.invoke('document:export-pdf', request),
  /**
   * 读取当前任务中的受控图片资源。
   * @param assetId 解析阶段生成的资源标识。
   * @returns 资源字节或稳定错误分类。
   * @author zhenghq
   */
  getDocumentAsset: (assetId: string): Promise<DocumentAssetResult> =>
    ipcRenderer.invoke('document:get-asset', assetId),
  /**
   * 读取当前活动 PDF 任务的原始字节，供 PDF.js 原生预览。
   * @returns 受控源文件读取结果。
   * @author zhenghq
   */
  getDocumentSource: (): Promise<DocumentSourceResult> =>
    ipcRenderer.invoke('document:get-source'),
  /**
   * 订阅文档翻译进度事件。
   * @param callback 进度快照回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onDocumentProgress(callback: (snapshot: DocumentWorkspaceSnapshot) => void) {
    const listener = (_event: unknown, snapshot: DocumentWorkspaceSnapshot): void => callback(snapshot)
    ipcRenderer.on('document:progress', listener)
    return () => ipcRenderer.removeListener('document:progress', listener)
  },
  /**
   * 订阅单个文档翻译区块的增量事件。
   * @param callback 块级译文更新回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onDocumentBlockTranslated(callback: (update: DocumentWorkspaceTranslationUpdate) => void) {
    const listener = (_event: unknown, update: DocumentWorkspaceTranslationUpdate): void => callback(update)
    ipcRenderer.on('document:block-translated', listener)
    return () => ipcRenderer.removeListener('document:block-translated', listener)
  },
  /**
   * 订阅文档翻译终态事件。
   * @param callback 终态快照回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onDocumentCompleted(callback: (snapshot: DocumentWorkspaceSnapshot) => void) {
    const listener = (_event: unknown, snapshot: DocumentWorkspaceSnapshot): void => callback(snapshot)
    ipcRenderer.on('document:completed', listener)
    return () => ipcRenderer.removeListener('document:completed', listener)
  },
  /**
   * 从 Electron 拖放 File 对象读取受信任的本地路径。
   * @param file Renderer 拖放事件中的文件对象。
   * @returns 文件绝对路径；非本地文件返回空字符串。
   * @author zhenghq
   */
  getDocumentDroppedFilePath(file: File): string {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  /**
   * 打开内置网页翻译阅读器。
   * @param url 可选初始 URL。
   * @returns 无返回值。
   * @author zhenghq
   */
  openWebReader(url?: string) {
    ipcRenderer.send('webview:open', url)
  },
  /**
   * 关闭内置网页翻译阅读器。
   * @returns 无返回值。
   * @author zhenghq
   */
  closeWebReader() {
    ipcRenderer.send('webview:close')
  },
  /**
   * 导航到地址栏提交的网页。
   * @param url 用户输入的 URL。
   * @returns 导航状态。
   * @author zhenghq
   */
  navigateWebReader: (url: string): Promise<WebReaderState> => ipcRenderer.invoke('webview:navigate', url),
  /** 阅读器后退。 */
  webViewBack: (): void => ipcRenderer.send('webview:back'),
  /** 阅读器前进。 */
  webViewForward: (): void => ipcRenderer.send('webview:forward'),
  /** 刷新当前网页。 */
  webViewReload: (): void => ipcRenderer.send('webview:reload'),
  /**
   * 同步原生 WebContentsView 矩形。
   * @param bounds Renderer 占位区矩形。
   * @returns 无返回值。
   * @author zhenghq
   */
  webViewSetBounds: (bounds: WebViewBounds): void => ipcRenderer.send('webview:set-bounds', bounds),
  /** 显式提取当前网页。 */
  webTranslateExtract: (): Promise<WebTranslationExtractionPayload> => ipcRenderer.invoke('web-translate:extract'),
  /**
   * 启动网页批量翻译。
   * @param request 可选翻译范围。
   * @returns 批量翻译结果。
   * @author zhenghq
   */
  webTranslateRun: (request?: WebTranslationRunRequest): Promise<WebTranslationRunPayload> =>
    ipcRenderer.invoke('web-translate:run', request),
  /** 取消网页批量翻译。 */
  webTranslateCancel: (): void => ipcRenderer.send('web-translate:cancel'),
  /**
   * 设置网页原文或译文展示模式。
   * @param mode 原文或译文模式。
   * @returns 写回统计。
   * @author zhenghq
   */
  webTranslateSetMode: (mode: WebTranslationMode) => ipcRenderer.invoke('web-translate:set-mode', mode),
  /**
   * 将当前网页译文导出为带水印 PDF。
   * @returns 保存、取消或拒绝结果。
   * @author zhenghq
   */
  exportWebPagePdf: (): Promise<WebPagePdfExportResult> =>
    ipcRenderer.invoke('web-translate:export-pdf'),
  /**
   * 订阅阅读器导航状态。
   * @param callback 状态回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onWebReaderState(callback: (state: WebReaderState) => void) {
    const listener = (_event: unknown, state: WebReaderState): void => callback(state)
    ipcRenderer.on('web-reader:state', listener)
    return () => ipcRenderer.removeListener('web-reader:state', listener)
  },
  /**
   * 订阅网页翻译进度。
   * @param callback 进度回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onWebTranslateProgress(callback: (progress: WebTranslationProgressPayload) => void) {
    const listener = (_event: unknown, progress: WebTranslationProgressPayload): void => callback(progress)
    ipcRenderer.on('web-translate:progress', listener)
    return () => ipcRenderer.removeListener('web-translate:progress', listener)
  },
  /** 订阅页面内容更新提示。 */
  onWebTranslatePageUpdated(callback: (updated: boolean) => void) {
    const listener = (_event: unknown, updated: boolean): void => callback(updated)
    ipcRenderer.on('web-translate:page-updated', listener)
    return () => ipcRenderer.removeListener('web-translate:page-updated', listener)
  },
  /**
   * 停止后台翻译服务并退出应用。
   * @returns 无返回值。
   * @author zhenghq
   */
  stopService() {
    ipcRenderer.send('settings:stop-service')
  },
  /**
   * 设置翻译弹窗是否固定。
   * @param pinned 是否固定弹窗。
   * @returns 无返回值。
   * @author zhenghq
   */
  setPinned(pinned: boolean) {
    ipcRenderer.send('popup:set-pinned', pinned)
  },
  /**
   * 订阅翻译弹窗固定状态变化。
   * @param callback 固定状态回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onPinnedChanged(callback: (pinned: boolean) => void) {
    const listener = (_event: unknown, pinned: boolean): void => callback(pinned)
    ipcRenderer.on('popup:pinned', listener)
    return () => ipcRenderer.removeListener('popup:pinned', listener)
  },
  /**
   * 订阅主进程完成弹窗隐藏的通知。
   * @param callback 弹窗隐藏后的清理回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onPopupHidden(callback: () => void) {
    const listener = (): void => callback()
    ipcRenderer.on('popup:hidden', listener)
    return () => ipcRenderer.removeListener('popup:hidden', listener)
  },
  /**
   * 翻译当前选中文字。
   * @returns 无返回值。
   * @author zhenghq
   */
  translateSelection() {
    ipcRenderer.send('selection:translate')
  },
  /**
   * 请求主进程打开 OCR 框选窗口。
   * @returns 无返回值。
   * @author zhenghq
   */
  openOcrSelection() {
    ipcRenderer.send('ocr-selection:open')
  },
  /**
   * 请求主进程读取剪贴板图片并进行 OCR 翻译。
   * @returns 无返回值。
   * @author zhenghq
   */
  translateClipboardImage() {
    ipcRenderer.send('ocr-clipboard:translate')
  },
  /**
   * 订阅 OCR 框选模式开始通知：覆盖窗口已显示但屏幕快照尚未就绪。
   * @param callback 框选开始回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onOcrSelectionBegin(callback: (payload: OcrSelectionBeginPayload) => void) {
    const listener = (_event: unknown, payload: OcrSelectionBeginPayload): void => callback(payload)
    ipcRenderer.on('ocr-selection:begin', listener)
    return () => ipcRenderer.removeListener('ocr-selection:begin', listener)
  },
  /**
   * 确认 Renderer 已清理旧截图会话并完成新会话初始化。
   * @param payload 当前截图会话序号。
   * @returns 无返回值。
   * @author zhenghq
   */
  confirmOcrSelectionReady(payload: OcrSelectionReadyPayload) {
    ipcRenderer.send('ocr-selection:ready', payload)
  },
  /**
   * 订阅 OCR 屏幕快照就绪通知，用于填充覆盖层背景图。
   * @param callback 快照就绪回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onOcrSelectionSnapshot(callback: (payload: OcrSelectionSnapshotPayload) => void) {
    const listener = (_event: unknown, payload: OcrSelectionSnapshotPayload): void => callback(payload)
    ipcRenderer.on('ocr-selection:snapshot', listener)
    return () => ipcRenderer.removeListener('ocr-selection:snapshot', listener)
  },
  /**
   * 订阅 OCR 屏幕采集失败通知，覆盖窗口需立即退出框选模式。
   * @param callback 采集失败回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onOcrSelectionFailed(callback: (payload: OcrSelectionFailedPayload) => void) {
    const listener = (_event: unknown, payload: OcrSelectionFailedPayload): void => callback(payload)
    ipcRenderer.on('ocr-selection:failed', listener)
    return () => ipcRenderer.removeListener('ocr-selection:failed', listener)
  },
  /**
   * 提交 OCR 框选截图区域。
   * @param bounds 框选区域。
   * @returns 无返回值。
   * @author zhenghq
   */
  submitOcrSelection(bounds: OcrSelectionBounds) {
    ipcRenderer.send('ocr-selection:submit', bounds)
  },
  /**
   * 取消 OCR 框选。
   * @returns 无返回值。
   * @author zhenghq
   */
  cancelOcrSelection() {
    ipcRenderer.send('ocr-selection:cancel')
  },
  /**
   * 请求对当前截图选区执行文字识别，不关闭截图窗口。
   * @param request 截图动作请求负载。
   * @returns 无返回值。
   * @author zhenghq
   */
  recognizeOcrSelection(request: ScreenshotOcrActionRequest) {
    ipcRenderer.send('ocr-selection:recognize', request)
  },
  /**
   * 请求将当前截图选区送入现有 OCR 翻译流程。
   * @param request 截图动作请求负载。
   * @returns 无返回值。
   * @author zhenghq
   */
  translateOcrSelection(request: ScreenshotOcrActionRequest) {
    ipcRenderer.send('ocr-selection:translate', request)
  },
  /**
   * 请求将当前截图选区图片复制到系统剪贴板。
   * @param request 截图动作请求负载。
   * @returns 无返回值。
   * @author zhenghq
   */
  copyOcrSelectionImage(request: ScreenshotOcrActionRequest) {
    ipcRenderer.send('ocr-selection:copy-image', request)
  },
  /**
   * 请求将当前截图选区图片保存到本地磁盘。
   * @param request 截图动作请求负载。
   * @returns 无返回值。
   * @author zhenghq
   */
  saveOcrSelectionImage(request: ScreenshotOcrActionRequest) {
    ipcRenderer.send('ocr-selection:save-image', request)
  },
  /**
   * 请求将 Renderer 合成的带标注 PNG 复制到系统剪贴板。
   * @param request 带标注导出请求。
   * @returns 无返回值。
   * @author zhenghq
   */
  copyAnnotatedOcrSelectionImage(request: ScreenshotAnnotatedExportRequest) {
    ipcRenderer.send('ocr-selection:copy-annotated-image', request)
  },
  /**
   * 请求将 Renderer 合成的带标注 PNG 保存到本地磁盘。
   * @param request 带标注导出请求。
   * @returns 无返回值。
   * @author zhenghq
   */
  saveAnnotatedOcrSelectionImage(request: ScreenshotAnnotatedExportRequest) {
    ipcRenderer.send('ocr-selection:save-annotated-image', request)
  },
  /**
   * 请求主进程按当前选区返回原始分辨率 PNG，供带标注导出合成底图。
   * @param request 原图导出请求负载。
   * @returns 原始分辨率选区 PNG data URL。
   * @author zhenghq
   */
  requestOcrSelectionExportImage(
    request: ScreenshotExportImageRequest
  ): Promise<ScreenshotExportImageResult> {
    return ipcRenderer.invoke('ocr-selection:export-image', request)
  },
  /**
   * 订阅截图文字识别结果事件。
   * @param callback 识别结果回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onOcrRecognizeResult(callback: (result: ScreenshotOcrRecognizeResult) => void) {
    const listener = (_event: unknown, result: ScreenshotOcrRecognizeResult): void =>
      callback(result)
    ipcRenderer.on('ocr-selection:recognize-result', listener)
    return () => ipcRenderer.removeListener('ocr-selection:recognize-result', listener)
  },
  /**
   * 订阅截图图片复制/保存动作反馈事件。
   * @param callback 动作反馈回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onOcrActionResult(callback: (result: ScreenshotOcrActionResult) => void) {
    const listener = (_event: unknown, result: ScreenshotOcrActionResult): void =>
      callback(result)
    ipcRenderer.on('ocr-selection:action-result', listener)
    return () => ipcRenderer.removeListener('ocr-selection:action-result', listener)
  },
  /**
   * 请求主进程展示独立的截图动作提示窗口。
   * @param payload 提示文本与停留时长。
   * @returns 无返回值。
   * @author zhenghq
   */
  showScreenshotToast(payload: { message: string; kind?: ScreenshotToastKind; displayTimeMs?: number }) {
    ipcRenderer.send('screenshot-toast:show', payload)
  },
  /**
   * 提示窗口渲染进程回传尺寸测量结果，请求主进程居中显示窗口。
   * @param payload 测得的内容尺寸与停留时长。
   * @returns 无返回值。
   * @author zhenghq
   */
  showScreenshotToastWindow(payload: { width: number; height: number; displayTimeMs: number }) {
    ipcRenderer.send('screenshot-toast:show-window', payload)
  },
  /**
   * 订阅主进程转发到提示窗口的展示事件。
   * @param callback 展示回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onShowScreenshotToast(callback: (payload: { message: string; kind: ScreenshotToastKind; displayTimeMs: number }) => void) {
    const listener = (_event: unknown, payload: { message: string; kind: ScreenshotToastKind; displayTimeMs: number }): void =>
      callback(payload)
    ipcRenderer.on('screenshot-toast:show', listener)
    return () => ipcRenderer.removeListener('screenshot-toast:show', listener)
  },
  /**
   * 使用手动语言偏好重新翻译当前文本。
   * @param sourceLang 源语言偏好。
   * @param targetLang 目标语言偏好。
   * @param origin 当前翻译来源。
   * @returns 重新翻译完成后的 Promise。
   * @author zhenghq
   */
  retranslate: (sourceLang: string, targetLang: string, origin?: TranslatePayload['origin']) =>
    ipcRenderer.invoke('popup:retranslate', sourceLang, targetLang, origin),
  /**
   * 提交手动翻译请求。
   * @param request 手动原文和语言偏好。
   * @returns 翻译流程完成后的 Promise。
   * @author zhenghq
   */
  translateManual: (request: ManualTranslateRequest): Promise<void> =>
    ipcRenderer.invoke('manual-translate:submit', request),

  /**
   * 请求主进程生成 Edge 在线语音临时音频。
   * @param text 待朗读译文。
   * @param language 目标语言代码。
   * @param requestId 可选请求标识，由 Renderer 生成并用于取消。
   * @param ipa 可选 IPA 音标；提供时由 Edge 按音素精确合成。
   * @returns 临时音频或脱敏错误。
   * @author zhenghq
   */
  synthesizeEdgeSpeech: (
    text: string,
    language: string,
    requestId?: string,
    ipa?: string
  ): Promise<EdgeSpeechResult> =>
    ipcRenderer.invoke(
      'speech:edge-synthesize',
      requestId || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text,
      language,
      ipa
    ),

  /**
   * 取消主进程中指定的 Edge 在线语音请求。
   * @param requestId Renderer 生成的请求标识。
   * @returns 无返回值。
   * @author zhenghq
   */
  cancelEdgeSpeech: (requestId: string): void => ipcRenderer.send('speech:edge-cancel', requestId),

  /**
   * 获取完整设置。
   * @returns 当前设置。
   * @author zhenghq
   */
  getSettings: () => ipcRenderer.invoke('settings:get'),
  /**
   * 保存设置补丁。
   * @param patch 设置补丁。
   * @returns 保存后的设置。
   * @author zhenghq
   */
  setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:set', patch),
  /**
   * 查询全局快捷键最近一次注册状态。
   * @returns 各快捷键的注册状态。
   * @author zhenghq
   */
  getShortcutRegistrationStates: (): Promise<GlobalShortcutRegistrationState[]> =>
    ipcRenderer.invoke('shortcuts:get-registration'),
  /**
   * 订阅全局快捷键注册状态变化。
   * @param callback 注册状态回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onShortcutRegistrationChanged(callback: (states: GlobalShortcutRegistrationState[]) => void) {
    const listener = (_event: unknown, states: GlobalShortcutRegistrationState[]): void => callback(states)
    ipcRenderer.on('shortcuts:registration-changed', listener)
    return () => ipcRenderer.removeListener('shortcuts:registration-changed', listener)
  },
  /**
   * 订阅设置变化。
   * @param callback 设置变化回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onSettingsChanged(callback: (settings: Settings) => void) {
    const listener = (_event: unknown, settings: Settings): void => callback(settings)
    ipcRenderer.on('settings:changed', listener)
    return () => ipcRenderer.removeListener('settings:changed', listener)
  },
  /**
   * 获取内存缓冲中的近期主进程日志。
   * @returns 按时间升序排列的结构化日志条目。
   * @author zhenghq
   */
  getLogHistory: (): Promise<LogEntry[]> => ipcRenderer.invoke('logs:get-history'),
  /**
   * 订阅主进程日志增量推送。
   * @param callback 日志条目批次回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onLogEntry(callback: (entries: LogEntry[]) => void) {
    const listener = (_event: unknown, entries: LogEntry[]): void => callback(entries)
    ipcRenderer.on('logs:entry', listener)
    return () => ipcRenderer.removeListener('logs:entry', listener)
  },
  /**
   * 弹出保存对话框导出当日日志文件。
   * @returns 保存路径；用户取消时返回 null。
   * @author zhenghq
   */
  exportLogs: (): Promise<string | null> => ipcRenderer.invoke('logs:export'),
  /**
   * 获取近两天取词诊断聚合摘要。
   * @returns 两天聚合摘要。
   * @author zhenghq
   */
  getCaptureDiagnosticsSummary: (): Promise<CaptureDiagnosticsSummary> =>
    ipcRenderer.invoke('capture-diagnostics:get-summary'),
  /**
   * 弹出保存对话框导出取词诊断 JSON。
   * @returns 保存路径；用户取消时返回 null。
   * @author zhenghq
   */
  exportCaptureDiagnostics: (): Promise<string | null> =>
    ipcRenderer.invoke('capture-diagnostics:export'),
  /**
   * 获取 OCR 引擎与模型资产状态。
   * @returns OCR 状态。
   * @author zhenghq
   */
  getOcrStatus: (): Promise<OcrStatus> => ipcRenderer.invoke('ocr:get-status'),
  /**
   * 保存 DeepLX 多地址。
   * @param patch DeepLX 配置补丁。
   * @returns 保存后的设置。
   * @author zhenghq
   */
  setDeepLxConfig: (patch: DeepLxConfigPatch): Promise<Settings> =>
    ipcRenderer.invoke('deeplx:configure', patch),
  /**
   * 检测当前保存的 DeepLX 服务。
   * @returns 多地址汇总状态。
   * @author zhenghq
   */
  checkDeepLx: (): Promise<DeepLxStatus> => ipcRenderer.invoke('deeplx:check'),
  /**
   * 保存钉钉公开配置和可选 ClientSecret。
   * @param patch 钉钉配置补丁。
   * @returns 保存后的脱敏设置。
   * @author zhenghq
   */
  setDingTalkConfig: (patch: DingTalkConfigPatch): Promise<Settings> =>
    ipcRenderer.invoke('dingtalk:configure', patch),
  /**
   * 显式清除钉钉 ClientSecret。
   * @returns 清除后的脱敏设置。
   * @author zhenghq
   */
  clearDingTalkSecret: (): Promise<Settings> => ipcRenderer.invoke('dingtalk:clear-secret'),
  /**
   * 检测钉钉 Token 和文本翻译链路。
   * @returns 结构化脱敏检测状态。
   * @author zhenghq
   */
  checkDingTalk: () => ipcRenderer.invoke('dingtalk:check'),
  /**
   * 检测免订阅微软 Bing 在线翻译链路。
   * @returns 结构化脱敏检测状态。
   * @author zhenghq
   */
  checkMicrosoft: () => ipcRenderer.invoke('microsoft:check'),
  /**
   * 保存 AI 公共配置及可选新 API Key。
   * @param patch AI 配置补丁。
   * @returns 保存成功后的脱敏公开设置。
   * @author zhenghq
   */
  setAiConfig: (patch: AiConfigPatch): Promise<Settings> => ipcRenderer.invoke('ai:configure', patch),
  /**
   * 显式清除已保存的 AI API Key。
   * @returns 清除后的脱敏公开设置。
   * @author zhenghq
   */
  clearAiApiKey: (): Promise<Settings> => ipcRenderer.invoke('ai:clear-key'),
  /**
   * 根据当前 AI 配置加载模型列表。
   * @returns 结构化脱敏模型列表结果。
   * @author zhenghq
   */
  listAiModels: (): Promise<AiModelListResult> => ipcRenderer.invoke('ai:list-models'),
  /**
   * 检测 AI 配置能否完成一次最小翻译请求。
   * @returns 结构化脱敏检测状态。
   * @author zhenghq
   */
  checkAi: (): Promise<AiCheckStatus> => ipcRenderer.invoke('ai:check'),
  /**
   * 生成 DeepLX Docker 命令。
   * @param port 本机映射端口。
   * @returns Docker 命令。
   * @author zhenghq
   */
  getDockerCommand: (port: number): Promise<string> =>
    ipcRenderer.invoke('deeplx:docker-command', port),
  /**
   * 打开 DeepLX 部署文档。
   * @returns 无返回值。
   * @author zhenghq
   */
  openDeployDoc: () => ipcRenderer.send('deeplx:open-doc'),
  /**
   * 获取当前自动更新状态。
   * @returns 当前自动更新状态。
   * @author zhenghq
   */
  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('updater:get-status'),
  /**
   * 主动检查 GitHub Release 最新版本。
   * @returns 检查请求发出后的自动更新状态。
   * @author zhenghq
   */
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke('updater:check'),
  /**
   * 下载新版本；手动 macOS 模式下保存并打开 DMG。
   * @returns 操作完成后的自动更新状态。
   * @author zhenghq
   */
  downloadUpdate: (): Promise<UpdateStatus> => ipcRenderer.invoke('updater:download'),
  /**
   * 取消正在进行的更新下载，回到可重新下载状态。
   * @returns 取消操作完成后的自动更新状态。
   * @author zhenghq
   */
  cancelUpdateDownload: (): Promise<UpdateStatus> =>
    ipcRenderer.invoke('updater:cancel-download'),
  /**
   * 安装已下载更新并重新启动应用。
   * @returns 无返回值。
   * @author zhenghq
   */
  installUpdate: () => ipcRenderer.send('updater:install'),
  /**
   * 打开 GitHub Release 页面。
   * @returns 页面打开完成后的 Promise。
   * @author zhenghq
   */
  openUpdatePage: (): Promise<void> => ipcRenderer.invoke('updater:open-release'),
  /**
   * 请求主进程在用户确认后解除固定 macOS 应用的隔离属性。
   * @returns 解除操作的结构化结果。
   * @author zhenghq
   */
  removeMacOSQuarantine: (): Promise<MacOSQuarantineResult> =>
    ipcRenderer.invoke('updater:remove-quarantine'),
  /**
   * 订阅自动更新状态变化。
   * @param callback 自动更新状态回调。
   * @returns 取消订阅方法。
   * @author zhenghq
   */
  onUpdateStatusChanged(callback: (status: UpdateStatus) => void) {
    const listener = (_event: unknown, status: UpdateStatus): void => callback(status)
    ipcRenderer.on('updater:status', listener)
    return () => ipcRenderer.removeListener('updater:status', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
