import { BrowserWindow, ipcMain } from 'electron'
import { validateAnnotatedExportPayload } from '../screenshotExportPayload'
import type { ScreenshotPinWindowManager } from '../screenshotPinWindow'
import type {
  ScreenshotExportImageRequest,
  ScreenshotOcrActionRequest,
  ScreenshotPinContextMenuRequest,
  ScreenshotPinCreateRequest,
  ScreenshotPinCreateResult,
  ScreenshotPinDragRequest,
  ScreenshotPinWheelRequest,
  ScreenshotToastKind
} from '../../shared/types'

/** OCR、截图贴图与截图提示 IPC 注册依赖。 */
export interface OcrIpcDependencies {
  /** 打开 OCR 框选窗口。 */
  requestOcrSelection(autoTranslate: boolean): void
  /** 返回当前 OCR 会话序号。 */
  getOcrSelectionSessionId(): number
  /** 标记 OCR 覆盖窗口已就绪。 */
  resolveOcrSelectionReady(ready: boolean): void
  /** 判断 OCR 覆盖窗口 IPC 来源。 */
  isOcrSelectionSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean
  /** 返回当前贴图窗口管理器。 */
  getScreenshotPinManager(): ScreenshotPinWindowManager | null
  /** 取消 OCR 框选。 */
  cancelOcrSelection(): void
  /** 提交 OCR 框选。 */
  submitOcrSelection(value: unknown): Promise<void>
  /** 识别当前截图选区。 */
  recognizeOcrSelectionAction(value: unknown): Promise<void>
  /** 翻译当前截图选区。 */
  translateOcrSelectionAction(value: unknown): Promise<void>
  /** 复制当前截图选区。 */
  copyOcrSelectionImageAction(value: unknown): Promise<void>
  /** 保存当前截图选区。 */
  saveOcrSelectionImageAction(value: unknown): Promise<void>
  /** 复制带标注截图。 */
  copyAnnotatedOcrSelectionImageAction(value: unknown): Promise<void>
  /** 保存带标注截图。 */
  saveAnnotatedOcrSelectionImageAction(value: unknown): Promise<void>
  /** 结束当前截图会话。 */
  finishScreenshotSession(): void
  /** 返回贴图请求非法提示。 */
  getInvalidPinPayloadMessage(): string
  /** 登记仍在处理中的截图动作请求。 */
  markActiveRequest(requestId: string, sessionId: number): void
  /** 按当前会话选区裁剪原始分辨率 PNG。 */
  cropCurrentOcrSelectionPng(bounds: unknown): Buffer
  /** 创建截图会话过期错误。 */
  createScreenshotExpiredError(): Error
  /** 展示截图动作提示。 */
  showScreenshotToast(
    message: string,
    displayTimeMs?: number,
    kind?: ScreenshotToastKind
  ): void
  /** 处理提示窗口回传的尺寸并显示。 */
  handleScreenshotToastShowWindow(value: unknown): void
  /** 读取剪贴板图片并执行 OCR 翻译。 */
  translateClipboardImage(): Promise<void>
}

/**
 * 校验截图动作请求负载：动作、请求 ID 与选区矩形必须齐全有效。
 * @param value Renderer 提交的未知请求负载。
 * @returns 校验后的截图动作请求；非法时返回 null。
 * @author zhenghq
 */
export function normalizeScreenshotActionRequest(
  value: unknown
): ScreenshotOcrActionRequest | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<ScreenshotOcrActionRequest>
  const actions = ['recognize', 'translate', 'copy-image', 'save-image'] as const
  if (!actions.includes(raw.action as (typeof actions)[number])) return null
  if (typeof raw.requestId !== 'string' || !raw.requestId.trim()) return null
  if (!Number.isInteger(raw.sessionId) || (raw.sessionId as number) <= 0) return null
  if (!raw.bounds || typeof raw.bounds !== 'object') return null
  return raw as ScreenshotOcrActionRequest
}

/**
 * 校验原始分辨率原图导出请求：会话序号与选区矩形必须齐全有效。
 * @param value Renderer 提交的未知请求负载。
 * @returns 校验后的原图导出请求；非法时返回 null。
 * @author zhenghq
 */
export function normalizeScreenshotExportImageRequest(
  value: unknown
): ScreenshotExportImageRequest | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<ScreenshotExportImageRequest>
  if (!Number.isInteger(raw.sessionId) || (raw.sessionId as number) <= 0) return null
  if (!raw.bounds || typeof raw.bounds !== 'object') return null
  return raw as ScreenshotExportImageRequest
}

/**
 * 判断请求是否属于当前截图会话，避免旧窗口消息重新激活截图动作。
 * @param request 已校验的截图请求。
 * @param sessionId 当前截图会话序号。
 * @returns 是否属于当前会话。
 * @author zhenghq
 */
export function isCurrentScreenshotRequest(
  request: ScreenshotOcrActionRequest,
  sessionId: number
): boolean {
  return request.sessionId === sessionId
}

/**
 * 注册 OCR 框选、截图动作、贴图与提示 IPC。
 * @param dependencies OCR 会话、截图动作和贴图窗口依赖。
 * @returns 无返回值。
 * @author zhenghq
 */
export function registerOcrIpc(dependencies: OcrIpcDependencies): void {
  /**
   * 校验贴图窗口 IPC 来源、贴图实例与请求结构。
   * @param event IPC 事件。
   * @param pinId 请求携带的贴图实例标识。
   * @returns 来源为指定贴图窗口时返回 true。
   * @author zhenghq
   */
  const isScreenshotPinSender = (event: Electron.IpcMainEvent, pinId: number): boolean => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return Boolean(win && dependencies.getScreenshotPinManager()?.ownsWindow(win, pinId))
  }

  /**
   * 将当前带标注截图创建为置顶贴图窗口。
   * @param event IPC 事件。
   * @param value 贴图创建请求。
   * @returns 创建结果与当前贴图数量。
   * @author zhenghq
   */
  const createScreenshotPin = async (
    event: Electron.IpcMainInvokeEvent,
    value: unknown
  ): Promise<ScreenshotPinCreateResult> => {
    const manager = dependencies.getScreenshotPinManager()
    if (!dependencies.isOcrSelectionSender(event) || !manager) {
      return { ok: false, count: 0, error: dependencies.getInvalidPinPayloadMessage() }
    }
    const sessionId = (value as { sessionId?: unknown } | null)?.sessionId
    if (typeof sessionId !== 'number' || sessionId !== dependencies.getOcrSelectionSessionId()) {
      return { ok: false, count: manager.count(), error: dependencies.getInvalidPinPayloadMessage() }
    }
    const result = await manager.create(value as ScreenshotPinCreateRequest)
    if (result.ok) {
      dependencies.finishScreenshotSession()
      dependencies.cancelOcrSelection()
    }
    return result
  }

  ipcMain.on('ocr-selection:open', () => {
    dependencies.requestOcrSelection(false)
  })
  ipcMain.on('ocr-selection:ready', (_event, payload: unknown) => {
    const sessionId = (payload as { sessionId?: unknown })?.sessionId
    if (typeof sessionId !== 'number' || sessionId !== dependencies.getOcrSelectionSessionId()) return
    dependencies.resolveOcrSelectionReady(true)
  })
  ipcMain.handle('ocr-selection:create-pin', (event, value: unknown) =>
    createScreenshotPin(event, value)
  )
  ipcMain.on('screenshot-pin:drag', (event, request: unknown) => {
    const raw = request as { pinId?: unknown } | null
    if (typeof raw?.pinId !== 'number' || !isScreenshotPinSender(event, raw.pinId)) return
    dependencies.getScreenshotPinManager()?.drag(request as ScreenshotPinDragRequest)
  })
  ipcMain.on('screenshot-pin:wheel', (event, request: unknown) => {
    const raw = request as { pinId?: unknown } | null
    if (typeof raw?.pinId !== 'number' || !isScreenshotPinSender(event, raw.pinId)) return
    dependencies.getScreenshotPinManager()?.wheel(request as ScreenshotPinWheelRequest)
  })
  ipcMain.on('screenshot-pin:close', (event, pinId: unknown) => {
    if (typeof pinId !== 'number' || !isScreenshotPinSender(event, pinId)) return
    dependencies.getScreenshotPinManager()?.close(pinId)
  })
  ipcMain.on('screenshot-pin:context-menu', (event, request: unknown) => {
    const raw = request as { pinId?: unknown } | null
    if (typeof raw?.pinId !== 'number' || !isScreenshotPinSender(event, raw.pinId)) return
    dependencies.getScreenshotPinManager()?.showContextMenu(request as ScreenshotPinContextMenuRequest)
  })
  ipcMain.on('ocr-selection:cancel', () => dependencies.cancelOcrSelection())
  ipcMain.on('ocr-selection:submit', (_event, bounds: unknown) => {
    void dependencies.submitOcrSelection(bounds)
  })
  ipcMain.on('ocr-selection:recognize', (_event, request: unknown) => {
    const normalized = normalizeScreenshotActionRequest(request)
    if (normalized && normalized.sessionId === dependencies.getOcrSelectionSessionId()) {
      dependencies.markActiveRequest(normalized.requestId, normalized.sessionId)
    }
    void dependencies.recognizeOcrSelectionAction(request)
  })
  ipcMain.on('ocr-selection:translate', (_event, request: unknown) => {
    void dependencies.translateOcrSelectionAction(request)
  })
  ipcMain.on('ocr-selection:copy-image', (_event, request: unknown) => {
    const normalized = normalizeScreenshotActionRequest(request)
    if (normalized && normalized.sessionId === dependencies.getOcrSelectionSessionId()) {
      dependencies.markActiveRequest(normalized.requestId, normalized.sessionId)
    }
    void dependencies.copyOcrSelectionImageAction(request)
  })
  ipcMain.on('ocr-selection:save-image', (_event, request: unknown) => {
    const normalized = normalizeScreenshotActionRequest(request)
    if (normalized && normalized.sessionId === dependencies.getOcrSelectionSessionId()) {
      dependencies.markActiveRequest(normalized.requestId, normalized.sessionId)
    }
    void dependencies.saveOcrSelectionImageAction(request)
  })
  ipcMain.on('ocr-selection:copy-annotated-image', (_event, request: unknown) => {
    const validated = validateAnnotatedExportPayload(request)
    if (validated.ok && validated.request.sessionId === dependencies.getOcrSelectionSessionId()) {
      dependencies.markActiveRequest(validated.request.requestId, validated.request.sessionId)
    }
    void dependencies.copyAnnotatedOcrSelectionImageAction(request)
  })
  ipcMain.on('ocr-selection:save-annotated-image', (_event, request: unknown) => {
    const validated = validateAnnotatedExportPayload(request)
    if (validated.ok && validated.request.sessionId === dependencies.getOcrSelectionSessionId()) {
      dependencies.markActiveRequest(validated.request.requestId, validated.request.sessionId)
    }
    void dependencies.saveAnnotatedOcrSelectionImageAction(request)
  })
  // 带标注导出的底图必须使用原始分辨率像素：预览图可能经过编码/缩放，直接复用会发糊。
  // 这里只在用户点击复制/保存时按需裁剪并编码，成本不落在「快捷键 → 可拖拽」热路径上。
  ipcMain.handle('ocr-selection:export-image', (_event, request: unknown) => {
    const normalized = normalizeScreenshotExportImageRequest(request)
    if (!normalized || normalized.sessionId !== dependencies.getOcrSelectionSessionId()) {
      throw dependencies.createScreenshotExpiredError()
    }
    // 导出必须与 OCR 共用同一条原始像素通道：Windows 上 cropCurrentOcrSelectionPng 会
    // 优先使用 GDI BGRA 原始字节，绕开 nativeImage 的平台相关通道契约，避免红蓝颠倒。
    const png = dependencies.cropCurrentOcrSelectionPng(normalized.bounds)
    return { dataUrl: `data:image/png;base64,${png.toString('base64')}` }
  })
  ipcMain.on('screenshot-toast:show', (_event, payload: unknown) => {
    const raw = payload as { message?: string; kind?: ScreenshotToastKind; displayTimeMs?: number }
    if (typeof raw?.message === 'string' && raw.message.trim()) {
      dependencies.showScreenshotToast(raw.message, raw.displayTimeMs, raw.kind)
    }
  })
  ipcMain.on('screenshot-toast:show-window', (_event, payload: unknown) => {
    dependencies.handleScreenshotToastShowWindow(payload)
  })
  ipcMain.on('ocr-clipboard:translate', () => {
    void dependencies.translateClipboardImage()
  })
}
