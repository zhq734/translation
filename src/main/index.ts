import {
  app,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  ipcMain,
  clipboard,
  shell,
  BrowserWindow,
  desktopCapturer,
  safeStorage,
  screen,
  dialog,
  type NativeImage,
  type SourcesOptions
} from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { cropRgba, resizeRgbaForOcr } from '../shared/imagePreprocess'
import { loadSettings, saveSettings, getSettings } from './settings'
import {
  captureSelection,
  captureSelectionByNativeOnly,
  PermissionError,
  checkAccessibilityPermission
} from './capture'
import {
  checkDingTalk as checkDingTalkTranslation,
  checkMicrosoft as checkMicrosoftTranslation,
  configureTranslationFetch,
  resetDingTalkTranslationRuntime,
  resetMicrosoftTranslationRuntime,
  resetAiTranslationRuntime,
  translate
} from './translate'
import { applyTranslationProxy, createTranslationWebSocket, translationFetch } from './network'
import { createEdgeSpeechClient } from './edgeSpeech'
import {
  createPopup,
  showPopup,
  hidePopup,
  isPopupVisible,
  isPointInsidePopup,
  getPopupCloseVersion,
  setPopupPinned,
  showManualTranslationPopup
} from './popup'
import {
  createSelectionButton,
  showSelectionButton,
  hideSelectionButton,
  isSelectionButtonVisible,
  isPointInsideSelectionButton
} from './selectionButton'
import { startAutoTrigger, stopAutoTrigger } from './autoTrigger'
import { LANGUAGES } from '../shared/langs'
import { isCopyShortcut } from '../shared/copyShortcutBehavior'
import {
  decideSelectionAction,
  resolveSelectionCaptureFailureMessage,
  resolveLanguagePair,
  type SelectionGesture
} from '../shared/selectionBehavior'
import {
  SelectionCaptureCoordinator,
  type SelectionCaptureResult
} from '../shared/selectionCaptureCoordinator'
import type {
  DingTalkCheckStatus,
  DingTalkConfigPatch,
  MicrosoftCheckStatus,
  AiConfigPatch,
  AiCheckStatus,
  AiModelListResult,
  Settings,
  DeepLxStatus,
  MacOSQuarantineResult,
  UpdateStatus,
  ManualTranslateRequest,
  TranslationOrigin,
  TranslatePayload
} from '../shared/types'
import type { EdgeSpeechResult } from '../shared/types'
import { validateManualTranslationText } from '../shared/manualTranslationBehavior'
import { DingTalkCredentialStore } from './dingtalkCredentials'
import { DingTalkConfigurationService } from './dingtalkConfig'
import { AiCredentialStore } from './aiCredentials'
import { AiConfigurationService } from './aiConfig'
import { AiModelDiscoveryService } from './aiModelDiscovery'
import { AiCheckService } from './aiCheck'
import {
  isMacOSDiskImageExecution,
  shouldOpenSettingsOnInitialLaunch
} from './appLifecycle'
import { createApplicationUpdateManager } from './updater'
import type { UpdateManager } from './updateManager'
import { removeMacOSApplicationQuarantine } from './macQuarantine'
import {
  captureRegionAsPng,
  computeCropRect,
  ScreenCaptureError,
  type CaptureBounds
} from './screenCapture'
import { decodePng, encodePng } from './pngCodec'
import { OcrDispatcher } from './ocrDispatcher'
import { createSystemOcrEngine } from './systemOcr'
import { PaddleOcrEngine } from './paddleOcr'
import { resolveBundledOcrModelAssets } from './ocrModelAssets'
import { TesseractOcrEngine } from './tesseractOcr'
import { preprocessOcrImageBytes } from './ocrImagePreprocess'
import { translateOcrResult } from './ocrTranslate'
import { readClipboardImage } from './clipboardImage'
import { OcrEngineError } from '../shared/ocrEngine'
import type { OcrErrorCode, OcrSelectionBounds, OcrStatus } from '../shared/types'

const isMac = process.platform === 'darwin'
const execFileP = promisify(execFile)
const PRELOAD_PATH = join(__dirname, '../preload/index.js')
const DOCKER_IMAGE = 'ghcr.io/owo-network/deeplx:latest'
const SELECTION_SETTLE_DELAY_MS = 80
const UPDATE_CHECK_DELAY_MS = 5000
const MIN_OCR_SELECTION_SIZE = 8
const OCR_TIMEOUT_MS = 30000

let tray: Tray | null = null
let settingsWin: BrowserWindow | null = null
let ocrSelectionWin: BrowserWindow | null = null
let dingTalkConfiguration: DingTalkConfigurationService | null = null
let aiConfiguration: AiConfigurationService | null = null
let aiModelDiscovery: AiModelDiscoveryService | null = null
let aiCheckService: AiCheckService | null = null
let updateManager: UpdateManager | null = null
const edgeSpeechClient = createEdgeSpeechClient({ socketFactory: createTranslationWebSocket })
const edgeSpeechRequests = new Map<string, AbortController>()
let latestTranslationRequest = 0
let latestSelectionGesture = 0
let latestOcrSnapshot: { png: Buffer; bounds: CaptureBounds; source: string } | null = null
// 按钮显示期间用只读直读做后台预取，点击按钮时优先消费缓存；
// 只有预取未取到文本时才走完整取词管线（直读 + 复制兜底）。
const selectionCapture = new SelectionCaptureCoordinator(
  captureSelection,
  captureSelectionByNativeOnly
)
let lastSelectedText = ''
let lastSelectionAnchor: { x: number; y: number } | undefined
let lastOcrText = ''
let lastOcrAnchor: { x: number; y: number } | undefined
let lastOcrEngine: TranslatePayload['ocrEngine'] | undefined

/**
 * 返回已初始化的钉钉配置服务。
 * @returns 主进程钉钉配置服务。
 * @author zhenghq
 */
function getDingTalkConfiguration(): DingTalkConfigurationService {
  if (!dingTalkConfiguration) throw new Error('钉钉配置服务尚未初始化')
  return dingTalkConfiguration
}

/**
 * 获取已初始化的 AI 配置服务实例。
 * @returns AI 配置服务实例。
 * @author zhenghq
 */
function getAiConfiguration(): AiConfigurationService {
  if (!aiConfiguration) throw new Error('AI 配置服务尚未初始化')
  return aiConfiguration
}

/**
 * 返回已初始化的自动更新管理器。
 * @returns 自动更新管理器。
 * @author zhenghq
 */
function getUpdateManager(): UpdateManager {
  if (!updateManager) throw new Error('自动更新服务尚未初始化')
  return updateManager
}

/**
 * 通过主进程请求 Edge 在线语音并隔离请求取消状态。
 * @param requestId Renderer 请求标识。
 * @param text 待朗读译文。
 * @param language 目标语言代码。
 * @returns 临时音频或脱敏错误。
 * @author zhenghq
 */
async function synthesizeEdgeSpeech(
  requestId: string,
  text: string,
  language: string
): Promise<EdgeSpeechResult> {
  const normalizedText = String(text ?? '').trim()
  if (!normalizedText) return { ok: false, error: '朗读文本为空' }
  console.log('[edge-speech] IPC 请求开始', {
    requestId,
    language,
    textLength: normalizedText.length
  })
  const controller = new AbortController()
  edgeSpeechRequests.set(requestId, controller)
  try {
    const result = await edgeSpeechClient.synthesize(normalizedText, String(language ?? ''), controller.signal)
    console.log('[edge-speech] IPC 请求完成', {
      requestId,
      ok: result.ok,
      audioBytes: result.audio?.byteLength ?? 0,
      error: result.error
    })
    return result
  } catch {
    console.error('[edge-speech] IPC 请求异常', { requestId })
    return { ok: false, error: 'Edge 语音服务暂不可用' }
  } finally {
    edgeSpeechRequests.delete(requestId)
  }
}

/**
 * 取消主进程中尚未完成的 Edge 语音请求。
 * @param requestId Renderer 请求标识。
 * @returns 无返回值。
 * @author zhenghq
 */
function cancelEdgeSpeech(requestId: string): void {
  edgeSpeechRequests.get(String(requestId))?.abort()
  edgeSpeechRequests.delete(String(requestId))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  const initialization = app.whenReady()
    .then(() => onReady())
    .catch(handleApplicationInitializationFailure)
  app.on('second-instance', () => {
    void initialization.then((initialized) => {
      if (!initialized) return
      openSettings()
    })
  })
  if (isMac) {
    // macOS 通过 Finder 重新打开运行中的应用时通常只激活已有进程，不会创建第二实例。
    app.on('activate', () => {
      void initialization.then((initialized) => {
        if (!initialized) return
        openSettings()
      })
    })
  }
}

/**
 * 统一处理应用启动初始化异常，避免应用在无 Dock、无菜单栏入口的状态下继续驻留。
 * @param error 启动初始化过程中抛出的异常。
 * @returns 固定返回 false，表示应用未完成初始化。
 * @author zhenghq
 */
function handleApplicationInitializationFailure(error: unknown): false {
  const message = error instanceof Error ? error.message : String(error)
  console.error('[main] 应用初始化失败:', error)
  dialog.showErrorBox('划词翻译启动失败', `应用无法完成启动：${message}`)
  app.quit()
  return false
}

/**
 * 根据设置切换 macOS Dock 栏图标和应用激活策略。
 * @param showDockIcon 是否显示 Dock 栏图标。
 * @returns 无返回值。
 * @author zhenghq
 */
function applyMacOSDockVisibility(showDockIcon: boolean): void {
  if (!isMac) return
  app.setActivationPolicy(showDockIcon ? 'regular' : 'accessory')
  if (showDockIcon) {
    void app.dock?.show()
    return
  }
  app.dock?.hide()
}

/**
 * 将 macOS 应用配置为菜单栏应用，并按用户设置控制 Dock 栏图标。
 * @param showDockIcon 是否显示 Dock 栏图标。
 * @returns 无返回值。
 * @author zhenghq
 */
function configureMacOSMenuBarApplication(showDockIcon: boolean): void {
  if (!isMac) return
  applyMacOSDockVisibility(showDockIcon)
  Menu.setApplicationMenu(null)
}

/**
 * 提示从 macOS 磁盘镜像启动的用户先完成应用安装。
 * @returns 用户明确选择继续运行时返回 true，选择退出或非磁盘镜像启动时返回相应结果。
 * @author zhenghq
 */
async function confirmMacOSInstalledApplicationLaunch(): Promise<boolean> {
  if (!isMacOSDiskImageExecution(process.platform, process.execPath)) return true

  const result = await dialog.showMessageBox({
    type: 'warning',
    title: '请先安装划词翻译',
    message: '当前应用正在从磁盘镜像运行',
    detail: '请先将“划词翻译”复制到“应用程序”文件夹，再从“应用程序”启动，避免重装后旧实例持续运行。',
    buttons: ['退出应用', '仍然运行'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return result.response === 1
}

/**
 * 初始化主进程窗口、全局监听、托盘和 IPC。
 * @returns 初始化完成时返回 true；用户选择退出磁盘镜像实例时返回 false。
 * @author zhenghq
 */
async function onReady(): Promise<boolean> {
  configureMacOSMenuBarApplication(false)
  if (!(await confirmMacOSInstalledApplicationLaunch())) {
    app.quit()
    return false
  }

  loadSettings()
  configureMacOSMenuBarApplication(getSettings().showDockIcon)
  createTray()
  dingTalkConfiguration = new DingTalkConfigurationService({
    getSettings,
    saveSettings,
    credentialStore: new DingTalkCredentialStore(
      join(app.getPath('userData'), 'credentials.json'),
      safeStorage
    ),
    onSettingsChanged: (settings) => {
      tray?.setContextMenu(buildTrayMenu())
      broadcast('settings:changed', settings)
    },
    resetTranslationRuntime: resetDingTalkTranslationRuntime
  })
  dingTalkConfiguration.initialize()
  aiConfiguration = new AiConfigurationService({
    getSettings,
    saveSettings,
    credentialStore: new AiCredentialStore(
      join(app.getPath('userData'), 'ai-credentials.json'),
      safeStorage
    ),
    onSettingsChanged: (settings) => {
      tray?.setContextMenu(buildTrayMenu())
      broadcast('settings:changed', settings)
    },
    resetTranslationRuntime: resetAiTranslationRuntime
  })
  aiConfiguration.initialize()
  aiModelDiscovery = new AiModelDiscoveryService({ fetch: translationFetch })
  aiCheckService = new AiCheckService({ fetch: translationFetch })
  await applyTranslationProxy(getSettings())
  configureTranslationFetch(translationFetch)
  updateManager = await createApplicationUpdateManager((status) => {
    broadcast('updater:status', status)
  })
  console.log(
    '[main] 启动完成 autoTrigger =',
    getSettings().triggerMode === 'auto',
    'triggerMode =',
    getSettings().triggerMode,
    'hotkey =',
    getSettings().hotkey,
    'proxyMode =',
    getSettings().proxyMode
  )
  createPopup(PRELOAD_PATH)
  createSelectionButton(PRELOAD_PATH)
  registerGlobalShortcuts(getSettings())
  applySelectionListener()
  registerIpc()
  if (shouldOpenSettingsOnInitialLaunch(process.platform)) openSettings()

  // 避免自动更新网络请求与应用首次启动初始化争用资源。
  setTimeout(() => void checkForApplicationUpdates(), UPDATE_CHECK_DELAY_MS)

  // 启动后检测权限：若已开启始终自动翻译但未授权，主动引导。
  setTimeout(() => void warnIfNoAccessibility(), 1500)
  return true
}

/**
 * 加载渲染页面，开发模式使用 Vite 服务，生产模式使用构建文件。
 * @param win 目标窗口。
 * @param html HTML 文件名。
 * @returns 无返回值。
 * @author zhenghq
 */
function loadRendererHtml(win: BrowserWindow, html: string): void {
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${html}`)
  } else {
    void win.loadFile(join(__dirname, `../renderer/${html}`))
  }
}

/**
 * 注册全局翻译与 OCR 快捷键。
 * @param settings 当前设置。
 * @returns 无返回值。
 * @author zhenghq
 */
function registerGlobalShortcuts(settings: Settings): void {
  globalShortcut.unregisterAll()
  registerShortcut(settings.hotkey)
  registerOcrShortcut(settings.ocrHotkey)
}

/**
 * 注册全局划词翻译快捷键。
 * @param accelerator Electron 快捷键描述。
 * @returns 无返回值。
 * @author zhenghq
 */
function registerShortcut(accelerator: string): void {
  if (!accelerator) return
  if (isCopyShortcut(accelerator)) {
    console.warn('[selection-translator] Ctrl+C / Command+C 为系统复制快捷键，不注册为翻译快捷键')
    return
  }
  const ok = globalShortcut.register(accelerator, onHotkey)
  if (!ok) {
    console.warn(`[selection-translator] 快捷键注册失败: ${accelerator}`)
  }
}

/**
 * 注册全局 OCR 截图快捷键。
 * @param accelerator Electron 快捷键描述。
 * @returns 无返回值。
 * @author zhenghq
 */
function registerOcrShortcut(accelerator: string): void {
  if (!accelerator) return
  if (isCopyShortcut(accelerator)) {
    console.warn('[selection-translator] Ctrl+C / Command+C 为系统复制快捷键，不注册为 OCR 快捷键')
    return
  }
  const ok = globalShortcut.register(accelerator, onOcrHotkey)
  if (!ok) {
    console.warn(`[selection-translator] OCR 快捷键注册失败: ${accelerator}`)
  }
}

/**
 * 响应全局快捷键并翻译当前选中文字。
 * @returns 无返回值。
 * @author zhenghq
 */
function onHotkey(): void {
  latestSelectionGesture += 1
  hideSelectionButton()
  queueSelectionTranslation()
}

/**
 * 响应全局 OCR 快捷键并打开截图框选窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
function onOcrHotkey(): void {
  latestSelectionGesture += 1
  hideSelectionButton()
  void openOcrSelection()
}

/**
 * 安排一次选区处理动作；按钮模式显示图标并后台只读预取文本，完整取词等用户点击确认。
 * @param anchor 选区按钮或翻译弹窗使用的屏幕锚点。
 * @returns 无返回值。
 * @author zhenghq
 */
function scheduleSelectionAction(anchor: { x: number; y: number }): void {
  const gestureId = ++latestSelectionGesture
  selectionCapture.invalidate()
  hideSelectionButton()
  lastSelectionAnchor = anchor
  const action = decideSelectionAction(isPopupVisible(), getSettings().triggerMode)
  if (action === 'ignore') return

  if (action === 'show-button') {
    showSelectionButton(anchor)
    // 按钮显示期间后台只读直读预取文本：不注入复制键、不写剪贴板，
    // 避免用户把鼠标移到“译”按钮期间选区失效，导致点击后复制兜底超时。
    void selectionCapture.prepare(anchor)
    return
  }

  setTimeout(() => {
    if (gestureId !== latestSelectionGesture) return
    queueSelectionTranslation(anchor)
  }, SELECTION_SETTLE_DELAY_MS)
}

/**
 * 处理按钮模式的双击选词：立即显示“译”按钮，再用只读直读后台预取选中文字。
 * 全程不发送复制快捷键、不写剪贴板；预取成功时供点击按钮直接消费，失败时由完整取词兜底。
 * @param gesture 当前双击选词手势及按钮锚点。
 * @returns 选区检查完成后的 Promise。
 * @author zhenghq
 */
async function scheduleDoubleClickSelectionButton(gesture: SelectionGesture): Promise<void> {
  const gestureId = ++latestSelectionGesture
  selectionCapture.invalidate()
  hideSelectionButton()
  lastSelectionAnchor = gesture.anchor

  // 双击场景先显示按钮，避免系统辅助功能直读失败时用户完全看不到入口。
  showSelectionButton(gesture.anchor)

  // 按钮显示后再等待系统提交选区并做只读预取；不发送复制快捷键、不写剪贴板。
  // 预取结果只用于点击时消费，失败时由点击流程继续走完整取词兜底。
  const prepared = await selectionCapture.prepare(gesture.anchor, SELECTION_SETTLE_DELAY_MS)
  if (gestureId !== latestSelectionGesture || getSettings().triggerMode !== 'button') return
  // 预取结果只用于缓存，按钮已经显示；点击时会优先消费缓存，空结果则继续完整取词。
  void prepared
}

/**
 * 响应一次全局划词动作，决定显示图标还是直接自动翻译。
 * 按钮模式的双击先无复制检查选区，常规拖拽只显示“译”按钮，不在用户确认前模拟系统复制。
 * @param gesture 划词拖拽及选区锚点信息。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleSelectionGesture(gesture: SelectionGesture): void {
  if (isOcrSelectionVisible() ||
      isPointInsidePopup(gesture.start) ||
      isPointInsidePopup(gesture.end) ||
      isPointInsideSelectionButton(gesture.start) ||
      isPointInsideSelectionButton(gesture.end)) {
    return
  }

  if (gesture.clicks >= 2 && getSettings().triggerMode === 'button') {
    void scheduleDoubleClickSelectionButton(gesture)
    return
  }

  scheduleSelectionAction(gesture.anchor)
}

/**
 * 响应全局鼠标按下事件，在“译”按钮被按下时立即捕获选中文字，避免源应用先清除选区。
 * 其他位置的鼠标按下会使已失效的选区缓存和“译”按钮立即消失。
 * @param point 鼠标按下时的屏幕坐标。
 * @returns 鼠标事件是否已被“译”按钮消费。
 * @author zhenghq
 */
function handleSelectionPointerDown(point: { x: number; y: number }): boolean {
  if (isOcrSelectionVisible()) return true
  if (isPointInsideSelectionButton(point)) {
    void translateSelectionButton()
    return true
  }
  latestSelectionGesture += 1
  selectionCapture.invalidate()
  hideSelectionButton()
  return false
}

/**
 * 响应用户复制快捷键，立即取消待处理或正在进行的自动取词，避免覆盖用户剪贴板。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleCopyShortcut(): void {
  latestSelectionGesture += 1
  selectionCapture.invalidate()
  hideSelectionButton()
}

/**
 * 响应用户粘贴快捷键，立即取消待处理或正在进行的选区取词。
 * @returns 无返回值。
 * @author zhenghq
 */
function handlePasteShortcut(): void {
  latestSelectionGesture += 1
  selectionCapture.invalidate()
  hideSelectionButton()
}

/**
 * 捕获当前选中文字，并在取词完成后执行翻译。
 * @param anchor 本次选区右上角锚点。
 * @returns 无返回值。
 * @author zhenghq
 */
function queueSelectionTranslation(anchor?: { x: number; y: number }): void {
  void selectionCapture.capture(anchor).then((result) => {
    if (result) handleSelectionCaptureResult(result)
  })
}

/**
 * 响应“译”按钮点击，随后才向当前前台应用发送一次复制快捷键并开始翻译。
 * @returns 翻译触发流程完成后的 Promise。
 * @author zhenghq
 */
async function translateSelectionButton(): Promise<void> {
  if (!isSelectionButtonVisible()) return
  latestSelectionGesture += 1
  hideSelectionButton()
  // 优先消费按钮显示期间预取的缓存文本，避免点击瞬间原生选区已失效导致复制兜底超时；
  // 预取未取到文本或从未预取时，再走完整取词管线（直读 + 复制兜底）。
  const prepared = await selectionCapture.consumePreparedOrWait()
  const result = prepared?.text
    ? prepared
    : await selectionCapture.capture(lastSelectionAnchor)
  selectionCapture.invalidate()
  if (result) handleSelectionCaptureResult(result)
}

/**
 * 处理取词结果，统一展示权限错误、空选区提示或启动翻译。
 * @param result 选中文字捕获结果。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleSelectionCaptureResult(result: SelectionCaptureResult): void {
  if (result.error) {
    handleTranslateError(result.error, getSettings(), result.anchor)
    return
  }
  if (!result.text) {
    const settings = getSettings()
    showPopup(
      {
        ok: false,
        error: resolveSelectionCaptureFailureMessage(result.reason, result.hasImage),
        sourcePreference: settings.sourceLang,
        targetPreference: settings.targetLang,
        targetLang: settings.targetLang
      },
      2000,
      result.anchor
    )
    return
  }

  void translateText(result.text, result.anchor)
}

/**
 * 翻译指定文本，并使用请求序号和关闭版本阻止旧结果覆盖新结果或重新打开已关闭弹窗。
 * @param text 待翻译文本。
 * @param anchor 首次展示弹窗时使用的选区锚点。
 * @param preferences 可选的语言偏好。
 * @param origin 翻译来源。
 * @returns 翻译流程完成后的 Promise。
 * @author zhenghq
 */
async function translateText(
  text: string,
  anchor?: { x: number; y: number },
  preferences?: { sourceLang: string; targetLang: string },
  origin: TranslationOrigin = 'selection'
): Promise<void> {
  const settings = getSettings()
  const sourcePreference = preferences?.sourceLang ?? settings.sourceLang
  const targetPreference = preferences?.targetLang ?? settings.targetLang
  const pair = resolveLanguagePair(text, sourcePreference, targetPreference)
  const requestSettings: Settings = {
    ...settings,
    sourceLang: pair.sourceLang,
    targetLang: pair.targetLang
  }
  const requestId = ++latestTranslationRequest
  const closeVersion = getPopupCloseVersion()

  if (origin === 'selection') {
    lastSelectedText = text
    if (anchor) lastSelectionAnchor = anchor
  }

  showPopup(
    {
      ok: true,
      origin,
      requestId,
      loading: true,
      original: text,
      sourceLang: pair.sourceLang,
      targetLang: pair.targetLang,
      sourcePreference,
      targetPreference,
      ocrText: origin === 'ocr' ? text : undefined,
      ocrRawText: origin === 'ocr' ? text : undefined,
      ocrEngine: origin === 'ocr' ? lastOcrEngine : undefined
    },
    0,
    anchor
  )

  try {
    const dingTalkCredentials = settings.dingTalkEnabled
      ? getDingTalkConfiguration().getCredentialsSnapshot()
      : null
    const aiApiKey = settings.aiEnabled ? getAiConfiguration().getApiKey() : null
    const output = await translate(text, requestSettings, dingTalkCredentials, aiApiKey)
    if (requestId !== latestTranslationRequest || closeVersion !== getPopupCloseVersion()) return
    showPopup(
      {
        ok: true,
        origin,
        requestId,
        original: text,
        translation: output.translation,
        detectedLang: output.detectedLang,
        sourceLang: pair.sourceLang,
        targetLang: pair.targetLang,
        sourcePreference,
        targetPreference,
        provider: output.provider,
        channel: output.channel,
        ocrText: origin === 'ocr' ? text : undefined,
        ocrRawText: origin === 'ocr' ? text : undefined,
        ocrEngine: origin === 'ocr' ? lastOcrEngine : undefined
      },
      settings.autoHideMs,
      anchor
    )
  } catch (e) {
    if (requestId !== latestTranslationRequest || closeVersion !== getPopupCloseVersion()) return
    handleTranslateError(
      e as Error,
      requestSettings,
      anchor,
      { sourceLang: sourcePreference, targetLang: targetPreference },
      { origin, requestId, original: text }
    )
  }
}

/**
 * 展示翻译异常，并在缺少辅助功能权限时打开系统设置。
 * @param err 翻译或取词异常。
 * @param settings 当前翻译设置。
 * @param anchor 弹窗定位锚点。
 * @param preferences 弹窗中需要回显的语言偏好。
 * @param context 翻译来源、请求序号和原文上下文。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleTranslateError(
  err: Error,
  settings: Settings,
  anchor?: { x: number; y: number },
  preferences?: { sourceLang: string; targetLang: string },
  context?: { origin: TranslationOrigin; requestId: number; original: string }
): void {
  const common = {
    origin: context?.origin ?? 'selection',
    requestId: context?.requestId,
    original: context?.original,
    sourcePreference: preferences?.sourceLang ?? settings.sourceLang,
    targetPreference: preferences?.targetLang ?? settings.targetLang,
    targetLang: settings.targetLang,
    ocrText: context?.origin === 'ocr' ? context.original : undefined,
    ocrRawText: context?.origin === 'ocr' ? context.original : undefined,
    ocrEngine: context?.origin === 'ocr' ? lastOcrEngine : undefined
  }
  if (err instanceof PermissionError) {
    showPopup(
      {
        ok: false,
        error: '需要「辅助功能」权限。请在弹出的系统设置中勾选本应用后重试。',
        ...common
      },
      8000,
      anchor
    )
    openAccessibilitySettings()
  } else {
    showPopup(
      { ok: false, error: err.message || '翻译失败', ...common },
      5000,
      anchor
    )
  }
}

/**
 * 显示并固定手动翻译模式，取消自动隐藏并通知 Renderer 聚焦原文输入框。
 * @returns 无返回值。
 * @author zhenghq
 */
function openManualTranslation(): void {
  setPopupPinned(true)
  showManualTranslationPopup()
}

/**
 * 计算覆盖所有显示器的 OCR 框选窗口边界。
 * @returns 覆盖全部显示器的矩形。
 * @author zhenghq
 */
function getOcrSelectionWindowBounds(): CaptureBounds {
  const displays = screen.getAllDisplays()
  return displays.reduce((area, display) => {
    const bounds = display.bounds
    const x1 = Math.min(area.x, bounds.x)
    const y1 = Math.min(area.y, bounds.y)
    const x2 = Math.max(area.x + area.width, bounds.x + bounds.width)
    const y2 = Math.max(area.y + area.height, bounds.y + bounds.height)
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
  }, { ...screen.getPrimaryDisplay().bounds })
}

/**
 * 创建或返回 OCR 框选透明覆盖窗口。
 * @returns OCR 框选窗口。
 * @author zhenghq
 */
function getOcrSelectionWindow(): BrowserWindow {
  if (ocrSelectionWin && !ocrSelectionWin.isDestroyed()) return ocrSelectionWin
  ocrSelectionWin = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  ocrSelectionWin.setAlwaysOnTop(true, 'screen-saver')
  ocrSelectionWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  ocrSelectionWin.on('closed', () => {
    ocrSelectionWin = null
  })
  ocrSelectionWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (process.env['ELECTRON_RENDERER_URL']) {
    ocrSelectionWin.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/selection.html`)
  } else {
    ocrSelectionWin.loadFile(join(__dirname, '../renderer/selection.html'))
  }
  return ocrSelectionWin
}

/**
 * 判断 OCR 框选窗口当前是否可见，用于屏蔽普通划词监听。
 * @returns OCR 框选窗口是否正在显示。
 * @author zhenghq
 */
function isOcrSelectionVisible(): boolean {
  return Boolean(ocrSelectionWin && !ocrSelectionWin.isDestroyed() && ocrSelectionWin.isVisible())
}

/**
 * OCR 框选结束后恢复普通划词监听。
 * @returns 无返回值。
 * @author zhenghq
 */
function restoreSelectionListenerAfterOcr(): void {
  applySelectionListener()
}

/**
 * 隐藏 OCR 框选窗口，并返回隐藏前是否可见。
 * @returns 隐藏前 OCR 框选窗口是否可见。
 * @author zhenghq
 */
function hideOcrSelectionWindow(): boolean {
  const wasVisible = isOcrSelectionVisible()
  ocrSelectionWin?.hide()
  return wasVisible
}

/**
 * 打开 OCR 框选窗口：先采集鼠标所在显示器快照，再把快照交给 Renderer 调整选区。
 * @returns 打开流程完成后的 Promise。
 * @author zhenghq
 */
async function openOcrSelection(): Promise<void> {
  latestSelectionGesture += 1
  selectionCapture.invalidate()
  stopAutoTrigger()
  hideSelectionButton()
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const anchor = screen.getCursorScreenPoint()
  try {
    const snapshot = await captureOcrPreviewSnapshot(display.bounds)
    latestOcrSnapshot = snapshot
    const payload = {
      imageDataUrl: `data:image/png;base64,${snapshot.png.toString('base64')}`,
      bounds: snapshot.bounds
    }
    const win = getOcrSelectionWindow()
    win.setBounds(display.bounds)
    win.show()
    win.focus()
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('ocr-selection:start', payload)
    })
    if (!win.webContents.isLoading()) win.webContents.send('ocr-selection:start', payload)
  } catch (error) {
    restoreSelectionListenerAfterOcr()
    const settings = getSettings()
    const code = resolveOcrErrorCode(error)
    const message = error instanceof Error ? error.message : '无法获取屏幕截图'
    showPopup({
      ok: false,
      origin: 'ocr',
      original: '',
      error: message,
      ocrCode: code,
      sourcePreference: settings.sourceLang,
      targetPreference: settings.targetLang,
      targetLang: settings.targetLang
    }, code === 'permission' ? 8000 : 5000, anchor)
    if (code === 'permission') {
      void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    }
  }
}

/**
 * 取消 OCR 框选并隐藏覆盖窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
function cancelOcrSelection(): void {
  const wasVisible = hideOcrSelectionWindow()
  latestOcrSnapshot = null
  if (wasVisible) restoreSelectionListenerAfterOcr()
}

/**
 * 校验 Renderer 提交的 OCR 框选区域，并转换为全局屏幕坐标。
 * @param value Renderer 提交的未知选区。
 * @returns 全局屏幕坐标下的有效选区。
 * @author zhenghq
 */
function normalizeOcrSelectionBounds(value: unknown): CaptureBounds | null {
  if (!value || typeof value !== 'object') return null
  const bounds = value as Partial<OcrSelectionBounds>
  const x = Number(bounds.x)
  const y = Number(bounds.y)
  const width = Number(bounds.width)
  const height = Number(bounds.height)
  if (![x, y, width, height].every(Number.isFinite)) return null
  if (width < MIN_OCR_SELECTION_SIZE || height < MIN_OCR_SELECTION_SIZE) return null
  const windowBounds = ocrSelectionWin?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 }
  return {
    x: Math.round(windowBounds.x + x),
    y: Math.round(windowBounds.y + y),
    width: Math.round(width),
    height: Math.round(height)
  }
}

/**
 * 将 OCR 异常转换为弹窗可展示的细分错误码。
 * @param error 待分类的异常。
 * @returns OCR 错误码。
 * @author zhenghq
 */
function resolveOcrErrorCode(error: unknown): OcrErrorCode {
  if (error instanceof ScreenCaptureError && error.code === 'permission') return 'permission'
  if (error instanceof OcrEngineError) return error.code
  return 'engine-unavailable'
}

/**
 * 创建本次 OCR 调度器，按设置决定是否启用 Tesseract 兜底。
 * @param settings 当前设置。
 * @returns OCR 调度器。
 * @author zhenghq
 */
function createOcrDispatcher(settings: Settings): OcrDispatcher {
  const paddleModelAssets = resolveBundledOcrModelAssets(app.getAppPath())
  return new OcrDispatcher({
    platform: process.platform,
    engines: {
      system: createSystemOcrEngine(),
      paddle: paddleModelAssets.ready
        ? new PaddleOcrEngine({ models: paddleModelAssets.models })
        : null,
      tesseract: settings.ocrTesseractEnabled
        ? new TesseractOcrEngine({ tessDataPath: join(app.getPath('userData'), 'tessdata') })
        : null
    }
  })
}

/**
 * 返回 OCR 引擎与模型资产状态，供设置页展示当前可用性和许可。
 * @returns OCR 状态。
 * @author zhenghq
 */
async function getOcrStatus(): Promise<OcrStatus> {
  const paddleModelAssets = resolveBundledOcrModelAssets(app.getAppPath())
  const systemEngine = createSystemOcrEngine()
  const paddleEngine = paddleModelAssets.ready
    ? new PaddleOcrEngine({ models: paddleModelAssets.models })
    : null
  const tesseractEngine = new TesseractOcrEngine({
    tessDataPath: join(app.getPath('userData'), 'tessdata')
  })
  const [systemAvailable, paddleAvailable, tesseractAvailable] = await Promise.all([
    Promise.resolve(systemEngine?.isAvailable() ?? false).catch(() => false),
    Promise.resolve(paddleEngine?.isAvailable() ?? false).catch(() => false),
    Promise.resolve(tesseractEngine.isAvailable()).catch(() => false)
  ])
  return {
    systemAvailable,
    paddleAvailable,
    tesseractAvailable,
    modelName: paddleModelAssets.metadata.name,
    modelVersion: paddleModelAssets.metadata.version,
    license: paddleModelAssets.metadata.license,
    distribution: paddleModelAssets.ready ? 'bundled' : 'unavailable',
    message: paddleModelAssets.ready
      ? (paddleAvailable
          ? `${paddleModelAssets.metadata.name} 兼容模型资产已就绪，PaddleOCR 主链路可用`
          : `${paddleModelAssets.metadata.name} 兼容模型资产已就绪，但 PaddleOCR runtime 暂不可用`)
      : `${paddleModelAssets.message}，将优先使用系统 OCR 或 Tesseract 兜底`
  }
}

/**
 * 根据 OCR 翻译结果更新弹窗。
 * @param result OCR 翻译结果。
 * @param settings 当前设置。
 * @param requestId 请求序号。
 * @param anchor 弹窗锚点。
 * @returns 无返回值。
 * @author zhenghq
 */
function showOcrTranslationResult(
  result: Awaited<ReturnType<typeof translateOcrResult>>,
  settings: Settings,
  requestId: number,
  anchor: { x: number; y: number }
): void {
  const sourcePreference = settings.sourceLang
  const targetPreference = settings.targetLang
  const code = result.ocrCode === 'cancelled' ? 'timeout' : result.ocrCode
  lastOcrEngine = result.ocrEngine
  if (result.ocrText) {
    lastOcrText = result.ocrText
    lastOcrAnchor = anchor
  }
  if (code || result.error) {
    showPopup({
      ok: false,
      origin: 'ocr',
      requestId,
      original: result.ocrText,
      error: result.error ?? '未识别到可翻译文字',
      ocrText: result.ocrText,
      ocrRawText: result.ocrRawText,
      ocrEngine: result.ocrEngine,
      ocrCode: code,
      sourcePreference,
      targetPreference,
      targetLang: settings.targetLang
    }, 5000, anchor)
    return
  }
  const pair = resolveLanguagePair(result.ocrText, sourcePreference, targetPreference)
  showPopup({
    ok: true,
    origin: 'ocr',
    requestId,
    original: result.ocrText,
    translation: result.translation,
    detectedLang: result.detectedLang,
    sourceLang: pair.sourceLang,
    targetLang: pair.targetLang,
    sourcePreference,
    targetPreference,
    provider: result.provider as never,
    channel: result.channel,
    ocrText: result.ocrText,
    ocrRawText: result.ocrRawText,
    ocrEngine: result.ocrEngine
  }, settings.autoHideMs, anchor)
}

/**
 * 对 PNG 图片字节执行 OCR 识别与翻译，并复用现有多通道翻译管道。
 * @param imageBytes PNG 图片字节。
 * @param settings 当前设置。
 * @returns OCR 翻译结果。
 * @author zhenghq
 */
async function processOcrImageBytes(
  imageBytes: Buffer,
  settings: Settings
): Promise<Awaited<ReturnType<typeof translateOcrResult>>> {
  const dispatcher = createOcrDispatcher(settings)
  const preparedImageBytes = preprocessOcrImageBytes(imageBytes, settings.ocrScale)
  const ocr = await dispatcher.recognize({
    imageBytes: preparedImageBytes,
    language: settings.ocrLang,
    timeoutMs: OCR_TIMEOUT_MS
  }, settings.ocrEnginePreference)
  return translateOcrResult(ocr, settings, {
    translate: async (text, requestSettings) => {
      const dingTalkCredentials = settings.dingTalkEnabled
        ? getDingTalkConfiguration().getCredentialsSnapshot()
        : null
      const aiApiKey = settings.aiEnabled ? getAiConfiguration().getApiKey() : null
      return translate(text, requestSettings ?? settings, dingTalkCredentials, aiApiKey)
    }
  })
}

/**
 * 记录 OCR 输入图片诊断信息，但不把截图图片持久化到本地。
 * @param imageBytes 实际送入 OCR 的 PNG 字节。
 * @param bounds 框选区域。
 * @param source 截图来源。
 * @returns 诊断记录完成后的 Promise。
 * @author zhenghq
 */
async function logOcrCaptureDiagnostic(imageBytes: Buffer, bounds: CaptureBounds, source: string): Promise<void> {
  const sha1 = createHash('sha1').update(imageBytes).digest('hex').slice(0, 12)
  console.log('[ocr] 截图完成', {
    source,
    bytes: imageBytes.length,
    sha1,
    bounds
  })
}

/**
 * 使用 macOS 原生 screencapture 采集框选区域，避免 Electron desktopCapturer 截到自身遮罩缓存。
 * @param bounds 全局屏幕坐标下的框选区域。
 * @returns PNG 图片字节。
 * @author zhenghq
 */
async function captureMacRegionAsPng(bounds: CaptureBounds): Promise<Buffer> {
  const path = join(
    tmpdir(),
    `selection-translator-ocr-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.png`
  )
  const rect = [
    Math.round(bounds.x),
    Math.round(bounds.y),
    Math.max(1, Math.round(bounds.width)),
    Math.max(1, Math.round(bounds.height))
  ].join(',')
  try {
    await execFileP('screencapture', ['-x', '-R', rect, path], { timeout: 5000 })
    return await readFile(path)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/permission|privacy|denied|not authorized/i.test(message)) {
      throw new ScreenCaptureError('permission', '需要屏幕录制权限')
    }
    throw new ScreenCaptureError('no-source', `无法获取屏幕截图: ${message}`)
  } finally {
    await unlink(path).catch(() => undefined)
  }
}

/**
 * 打开 OCR 选择器前采集一张屏幕快照，后续用户只在这张快照上调整区域。
 * @param bounds 需要快照的显示器区域。
 * @returns 快照 PNG、对应屏幕区域和采集来源。
 * @author zhenghq
 */
async function captureOcrPreviewSnapshot(
  bounds: CaptureBounds
): Promise<{ png: Buffer; bounds: CaptureBounds; source: string }> {
  if (process.platform === 'darwin') {
    const png = await captureMacRegionAsPng(bounds)
    return { png, bounds, source: 'macos-screencapture-preview' }
  }
  const image = await captureRegionAsPng(bounds, { ocrScale: 1 }, {
    getSources: (options) => desktopCapturer.getSources(options as SourcesOptions),
    getDisplayNearestPoint: (point) => screen.getDisplayNearestPoint(point),
    getPrimaryDisplay: () => screen.getPrimaryDisplay(),
    platform: process.platform
  })
  return { png: image.png, bounds, source: 'electron-desktopCapturer-preview' }
}

/**
 * 采集 OCR 框选区域 PNG。macOS 优先使用系统 screencapture，其余平台使用 Electron desktopCapturer。
 * @param bounds 全局屏幕坐标下的框选区域。
 * @param settings 当前设置。
 * @returns PNG 图片字节。
 * @author zhenghq
 */
async function captureOcrSelectionPng(bounds: CaptureBounds, settings: Settings): Promise<Buffer> {
  if (process.platform === 'darwin') {
    const png = await captureMacRegionAsPng(bounds)
    await logOcrCaptureDiagnostic(png, bounds, 'macos-screencapture')
    return png
  }
  const image = await captureRegionAsPng(bounds, { ocrScale: settings.ocrScale }, {
    getSources: (options) => desktopCapturer.getSources(options as SourcesOptions),
    getDisplayNearestPoint: (point) => screen.getDisplayNearestPoint(point),
    getPrimaryDisplay: () => screen.getPrimaryDisplay(),
    platform: process.platform
  })
  await logOcrCaptureDiagnostic(image.png, bounds, 'electron-desktopCapturer')
  return image.png
}

/**
 * 从已采集的 OCR 屏幕快照中裁剪用户确认的区域，并按 OCR 倍率放大。
 * @param bounds 用户确认的全局屏幕坐标区域。
 * @param settings 当前设置。
 * @returns 裁剪并预处理后的 PNG 图片字节。
 * @author zhenghq
 */
async function cropOcrSnapshotSelection(bounds: CaptureBounds, settings: Settings): Promise<Buffer> {
  const snapshot = latestOcrSnapshot
  if (!snapshot) {
    throw new ScreenCaptureError('no-source', '截图已失效，请重新截图')
  }
  const fullImage = decodePng(snapshot.png)
  const cropRect = computeCropRect(bounds, snapshot.bounds, fullImage.width, fullImage.height)
  const cropped = cropRgba(fullImage, cropRect)
  const scaled = resizeRgbaForOcr(cropped, settings.ocrScale)
  const png = encodePng(scaled)
  await logOcrCaptureDiagnostic(png, bounds, `${snapshot.source}-crop`)
  latestOcrSnapshot = null
  return png
}

/**
 * 处理 OCR 框选提交：截图、识别、翻译并展示弹窗。
 * @param value Renderer 提交的选区。
 * @returns 翻译流程完成后的 Promise。
 * @author zhenghq
 */
async function submitOcrSelection(value: unknown): Promise<void> {
  const bounds = normalizeOcrSelectionBounds(value)
  const ocrSelectionWasVisible = hideOcrSelectionWindow()
  let selectionListenerRestored = false
  const restoreSelectionListener = (): void => {
    if (!ocrSelectionWasVisible || selectionListenerRestored) return
    restoreSelectionListenerAfterOcr()
    selectionListenerRestored = true
  }
  if (!bounds) {
    latestOcrSnapshot = null
    restoreSelectionListener()
    return
  }
  const settings = getSettings()
  const requestId = ++latestTranslationRequest
  const anchor = { x: bounds.x + bounds.width, y: bounds.y + bounds.height }
  const closeVersion = getPopupCloseVersion()
  try {
    const imageBytes = await cropOcrSnapshotSelection(bounds, settings)
    restoreSelectionListener()
    showPopup({
      ok: true,
      origin: 'ocr',
      requestId,
      loading: true,
      original: '正在识别屏幕区域…',
      sourcePreference: settings.sourceLang,
      targetPreference: settings.targetLang,
      targetLang: settings.targetLang
    }, 0, anchor)
    const result = await processOcrImageBytes(imageBytes, settings)
    if (requestId !== latestTranslationRequest || closeVersion !== getPopupCloseVersion()) return
    showOcrTranslationResult(result, settings, requestId, anchor)
  } catch (error) {
    latestOcrSnapshot = null
    restoreSelectionListener()
    if (requestId !== latestTranslationRequest || closeVersion !== getPopupCloseVersion()) return
    const code = resolveOcrErrorCode(error)
    const message = error instanceof Error ? error.message : 'OCR 识别失败'
    showPopup({
      ok: false,
      origin: 'ocr',
      requestId,
      original: '',
      error: message,
      ocrCode: code,
      sourcePreference: settings.sourceLang,
      targetPreference: settings.targetLang,
      targetLang: settings.targetLang
    }, code === 'permission' ? 8000 : 5000, anchor)
    if (code === 'permission') {
      void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    }
  }
}

/**
 * 读取剪贴板图片并执行 OCR 翻译；无图片时给出专用提示。
 * @returns 翻译流程完成后的 Promise。
 * @author zhenghq
 */
async function translateClipboardImage(): Promise<void> {
  const settings = getSettings()
  const anchor = screen.getCursorScreenPoint()
  const requestId = ++latestTranslationRequest
  const closeVersion = getPopupCloseVersion()
  const clipboardImage = readClipboardImage(clipboard)
  if (clipboardImage.kind !== 'image' || !clipboardImage.png) {
    showPopup({
      ok: false,
      origin: 'ocr',
      requestId,
      original: '',
      error: '剪贴板中没有图片',
      ocrCode: 'no-clipboard-image',
      sourcePreference: settings.sourceLang,
      targetPreference: settings.targetLang,
      targetLang: settings.targetLang
    }, 5000, anchor)
    return
  }

  showPopup({
    ok: true,
    origin: 'ocr',
    requestId,
    loading: true,
    original: '正在识别剪贴板图片…',
    sourcePreference: settings.sourceLang,
    targetPreference: settings.targetLang,
    targetLang: settings.targetLang
  }, 0, anchor)

  try {
    const result = await processOcrImageBytes(clipboardImage.png, settings)
    if (requestId !== latestTranslationRequest || closeVersion !== getPopupCloseVersion()) return
    showOcrTranslationResult(result, settings, requestId, anchor)
  } catch (error) {
    if (requestId !== latestTranslationRequest || closeVersion !== getPopupCloseVersion()) return
    const code = resolveOcrErrorCode(error)
    const message = error instanceof Error ? error.message : 'OCR 识别失败'
    showPopup({
      ok: false,
      origin: 'ocr',
      requestId,
      original: '',
      error: message,
      ocrCode: code,
      sourcePreference: settings.sourceLang,
      targetPreference: settings.targetLang,
      targetLang: settings.targetLang
    }, 5000, anchor)
  }
}

/**
 * 校验并提交手动翻译请求，非法输入只返回脱敏错误且不调用翻译运行时。
 * @param request Renderer 传入的未知请求负载。
 * @returns 翻译流程完成后的 Promise。
 * @author zhenghq
 */
async function translateManualRequest(request: unknown): Promise<void> {
  const raw = request && typeof request === 'object'
    ? request as Partial<ManualTranslateRequest>
    : {}
  const text = raw.text
  const validationError = validateManualTranslationText(text)
  const settings = getSettings()
  const sourceLang = typeof raw.sourceLang === 'string' && raw.sourceLang
    ? raw.sourceLang
    : settings.sourceLang
  const targetLang = typeof raw.targetLang === 'string' && raw.targetLang
    ? raw.targetLang
    : settings.targetLang

  if (validationError) {
    const requestId = ++latestTranslationRequest
    showPopup({
      ok: false,
      origin: 'manual',
      requestId,
      original: typeof text === 'string' ? text : '',
      sourcePreference: sourceLang,
      targetPreference: targetLang,
      targetLang,
      error: validationError
    }, 0)
    return
  }

  await translateText(text as string, undefined, { sourceLang, targetLang }, 'manual')
}

/**
 * 根据触发方式启停全局划词监听；仅快捷键模式不需要监听鼠标拖拽。
 * @returns 无返回值。
 * @author zhenghq
 */
function applySelectionListener(): void {
  latestSelectionGesture += 1
  selectionCapture.invalidate()
  stopAutoTrigger()
  hideSelectionButton()
  if (getSettings().triggerMode !== 'hotkey') {
    startAutoTrigger(
      handleSelectionGesture,
      handleSelectionPointerDown,
      handleCopyShortcut,
      handlePasteShortcut
    )
  }
}

/**
 * 检查自动翻译模式所需的辅助功能权限，并在未授权时提示用户。
 * @returns 检查流程完成后的 Promise。
 * @author zhenghq
 */
async function warnIfNoAccessibility(): Promise<void> {
  if (getSettings().triggerMode !== 'auto') return
  const ok = await checkAccessibilityPermission()
  if (!ok) {
    const settings = getSettings()
    showPopup(
      {
        ok: false,
        error: '需要「辅助功能」权限才能划词取词与自动翻译。请在系统设置中勾选本应用（开发模式为 Electron）后重启。',
        sourcePreference: settings.sourceLang,
        targetPreference: settings.targetLang,
        targetLang: settings.targetLang
      },
      10000
    )
    openAccessibilitySettings()
  }
}

/**
 * 打开 macOS 辅助功能授权页面。
 * @returns 无返回值。
 * @author zhenghq
 */
function openAccessibilitySettings(): void {
  void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
}

// ---- 设置窗口 ----

/**
 * 创建或复用设置窗口。
 * @returns 设置窗口实例。
 * @author zhenghq
 */
function createSettingsWindow(): BrowserWindow {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show()
    settingsWin.focus()
    return settingsWin
  }

  settingsWin = new BrowserWindow({
    width: 640,
    height: 820,
    minWidth: 480,
    minHeight: 600,
    title: '划词翻译 · 设置',
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.platform === 'win32') settingsWin.removeMenu()
  loadRendererHtml(settingsWin, 'settings.html')
  settingsWin.on('closed', () => {
    settingsWin = null
  })
  return settingsWin
}

/**
 * 打开设置窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
function openSettings(): void {
  createSettingsWindow()
}

// ---- 自建 DeepLX 集成 ----

/**
 * 检测自建 DeepLX 服务是否可用。
 * @param url DeepLX 翻译端点。
 * @returns 服务在线状态。
 * @author zhenghq
 */
async function checkDeepLx(url: string): Promise<DeepLxStatus> {
  const normalizedUrl = (url || '').trim()
  if (!normalizedUrl) return { url: '', online: false, message: '未配置地址' }
  try {
    const response = await translationFetch(normalizedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'ping', source_lang: 'en', target_lang: 'zh' }),
      signal: AbortSignal.timeout(3000)
    })
    const json = (await response.json()) as { code?: number; message?: string }
    if (json?.code === 200) return { url: normalizedUrl, online: true }
    return {
      url: normalizedUrl,
      online: false,
      message: json?.message || `HTTP ${response.status}`
    }
  } catch (e) {
    const message = (e as Error).message || String(e)
    return {
      url: normalizedUrl,
      online: false,
      message: message.includes('abort') ? '连接超时' : message
    }
  }
}

/**
 * 生成 DeepLX Docker 部署命令。
 * @param port 映射到本机的端口。
 * @returns 可复制执行的 Docker 命令。
 * @author zhenghq
 */
function buildDockerCommand(port: number): string {
  const normalizedPort = Number.isInteger(port) && port > 0 ? port : 1189
  return [
    'docker run -d \\',
    '  --name deeplx \\',
    '  --restart unless-stopped \\',
    `  -p ${normalizedPort}:1188 \\`,
    '  -e TOKEN=你的dl_session值 \\',
    `  ${DOCKER_IMAGE}`
  ].join('\n')
}

/**
 * 打开本地 DeepLX 部署文档，失败时回退到项目主页。
 * @returns 无返回值。
 * @author zhenghq
 */
function openDeployDoc(): void {
  const docPath = join(__dirname, '../../docs/deeplx-selfhost.md')
  void shell.openPath(docPath).then((errorMessage) => {
    if (errorMessage) {
      void shell.openExternal('https://github.com/OwO-Network/DeepLX')
    }
  })
}

// ---- 自动更新 ----

/**
 * 静默检查 GitHub Release 最新版本，并让状态事件负责界面更新。
 * @returns 检查完成后的自动更新状态。
 * @author zhenghq
 */
async function checkForApplicationUpdates(): Promise<UpdateStatus> {
  return getUpdateManager().checkForUpdates()
}

/**
 * 下载新版本；手动 macOS 安装模式下保存并打开 DMG。
 * @returns 操作完成后的自动更新状态。
 * @author zhenghq
 */
async function downloadApplicationUpdate(): Promise<UpdateStatus> {
  return getUpdateManager().downloadUpdate()
}

/**
 * 安装已经下载完成的更新并重新启动应用。
 * @returns 无返回值。
 * @author zhenghq
 */
function installApplicationUpdate(): void {
  getUpdateManager().installUpdate()
}

/**
 * 使用系统默认浏览器打开 GitHub Release 页面。
 * @returns 页面打开完成后的 Promise。
 * @author zhenghq
 */
async function openApplicationReleasePage(): Promise<void> {
  await getUpdateManager().openReleasePage()
}

/**
 * 在用户确认已完成手动覆盖安装后，解除固定 macOS 应用的隔离属性。
 * @returns 解除隔离属性的结构化结果。
 * @author zhenghq
 */
async function removeApplicationQuarantine(): Promise<MacOSQuarantineResult> {
  if (!isMac) return removeMacOSApplicationQuarantine()

  const result = await dialog.showMessageBox({
    type: 'warning',
    title: '确认解除 macOS 隔离属性',
    message: '请先下载 DMG 并将“划词翻译”拖入“应用程序”覆盖旧版本',
    detail: '确认已完成覆盖安装后继续。此操作只处理 /Applications/划词翻译.app，不会调用 sudo，也不能修复代码签名不匹配。',
    buttons: ['取消', '已完成安装，继续'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  if (result.response !== 1) {
    return { ok: false, message: '已取消解除 macOS 隔离属性' }
  }
  return removeMacOSApplicationQuarantine()
}

/**
 * 保存钉钉公开配置和可选 ClientSecret，并在成功后广播脱敏设置。
 * @param patch 钉钉配置补丁。
 * @returns 保存后的脱敏设置。
 * @author zhenghq
 */
function applyDingTalkConfig(patch: DingTalkConfigPatch): Settings {
  return getDingTalkConfiguration().applyPatch(patch)
}

/**
 * 显式清除钉钉 ClientSecret，并在成功后广播脱敏设置。
 * @returns 清除后的脱敏设置。
 * @author zhenghq
 */
function clearDingTalkSecret(): Settings {
  return getDingTalkConfiguration().clearSecret()
}

/**
 * 检测钉钉安全存储、凭证和文本翻译链路。
 * @returns 结构化脱敏检测状态。
 * @author zhenghq
 */
function checkDingTalk(): Promise<DingTalkCheckStatus> {
  const configuration = getDingTalkConfiguration()
  if (configuration.getCredentialError()) {
    return Promise.resolve({
      ok: false,
      code: 'storage-unavailable',
      message: '钉钉凭证无法安全读取，请重新配置'
    })
  }
  return checkDingTalkTranslation(configuration.getCredentialsSnapshot(false))
}

/**
 * 检测免订阅微软 Bing 在线翻译链路。
 * @returns 结构化脱敏检测状态。
 * @author zhenghq
 */
function checkMicrosoft(): Promise<MicrosoftCheckStatus> {
  return checkMicrosoftTranslation()
}

/**
 * 保存 AI 公共配置及可选新 API Key，并在成功后广播脱敏设置。
 * @param patch AI 配置补丁。
 * @returns 保存后的脱敏设置。
 * @author zhenghq
 */
function applyAiConfig(patch: AiConfigPatch): Settings {
  return getAiConfiguration().applyPatch(patch)
}

/**
 * 显式清除 AI API Key，并在成功后广播脱敏设置。
 * @returns 清除后的脱敏设置。
 * @author zhenghq
 */
function clearAiApiKey(): Settings {
  return getAiConfiguration().clearApiKey()
}

/**
 * 根据当前 AI 配置加载模型列表。
 * @returns 结构化脱敏模型列表结果。
 * @author zhenghq
 */
async function listAiModels(): Promise<AiModelListResult> {
  if (!aiModelDiscovery) throw new Error('AI 模型发现服务尚未初始化')
  const settings = getSettings()
  return aiModelDiscovery.listModels({
    protocol: settings.aiProtocol,
    baseUrl: settings.aiBaseUrl,
    apiKey: getAiConfiguration().getApiKey()
  })
}

/**
 * 检测 AI 配置能否完成一次最小翻译请求。
 * @returns 结构化脱敏检测状态。
 * @author zhenghq
 */
function checkAi(): Promise<AiCheckStatus> {
  if (!aiCheckService) throw new Error('AI 检测服务尚未初始化')
  return aiCheckService.check({
    settings: getSettings(),
    apiKey: getAiConfiguration().getApiKey()
  })
}

// ---- IPC ----

/**
 * 向所有窗口广播设置变化。
 * @param channel IPC 通道名。
 * @param payload 广播数据。
 * @returns 无返回值。
 * @author zhenghq
 */
function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}

/**
 * 保存设置补丁并同步快捷键、托盘及所有渲染窗口。
 * @param patch 设置补丁。
 * @returns 保存后的完整设置。
 * @author zhenghq
 */
async function applySettingsPatch(patch: Partial<Settings>): Promise<Settings> {
  if (patch.hotkey !== undefined && isCopyShortcut(String(patch.hotkey))) {
    throw new Error('Ctrl+C / Command+C 是系统复制快捷键，不能设为翻译快捷键')
  }
  if (patch.ocrHotkey !== undefined && isCopyShortcut(String(patch.ocrHotkey))) {
    throw new Error('Ctrl+C / Command+C 是系统复制快捷键，不能设为 OCR 快捷键')
  }

  const previous = getSettings()
  const safePatch = { ...patch }
  delete safePatch.dingTalkEnabled
  delete safePatch.dingTalkCorpId
  delete safePatch.dingTalkClientId
  delete safePatch.dingTalkSecretConfigured
  // 普通 settings:set 不接受 AI 敏感字段，API Key 与 aiApiKeyConfigured 由专用 IPC 管理。
  delete (safePatch as Record<string, unknown>).aiApiKey
  delete (safePatch as Record<string, unknown>).aiApiKeyConfigured
  const aiFieldChanged =
    (patch.aiEnabled !== undefined && patch.aiEnabled !== previous.aiEnabled) ||
    (patch.aiProtocol !== undefined && patch.aiProtocol !== previous.aiProtocol) ||
    (patch.aiBaseUrl !== undefined && patch.aiBaseUrl !== previous.aiBaseUrl) ||
    (patch.aiModel !== undefined && patch.aiModel !== previous.aiModel)
  const settings = saveSettings(safePatch)
  if (
    (patch.hotkey !== undefined && settings.hotkey !== previous.hotkey) ||
    (patch.ocrHotkey !== undefined && settings.ocrHotkey !== previous.ocrHotkey)
  ) {
    registerGlobalShortcuts(settings)
  }
  if (patch.triggerMode !== undefined && settings.triggerMode !== previous.triggerMode) {
    applySelectionListener()
    if (settings.triggerMode === 'auto') void warnIfNoAccessibility()
  }
  if (patch.showDockIcon !== undefined && settings.showDockIcon !== previous.showDockIcon) {
    applyMacOSDockVisibility(settings.showDockIcon)
  }
  if (patch.proxyMode !== undefined ||
      patch.proxyRules !== undefined ||
      patch.proxyBypassRules !== undefined) {
    await applyTranslationProxy(settings)
  }
  if (patch.microsoftEnabled !== undefined &&
      settings.microsoftEnabled !== previous.microsoftEnabled) {
    resetMicrosoftTranslationRuntime()
  }
  if (aiFieldChanged) {
    resetAiTranslationRuntime()
    aiModelDiscovery?.clearCache()
  }
  tray?.setContextMenu(buildTrayMenu())
  broadcast('settings:changed', settings)
  return settings
}

/**
 * 注册悬浮窗、设置页和 DeepLX 相关 IPC。
 * @returns 无返回值。
 * @author zhenghq
 */
function registerIpc(): void {
  ipcMain.on('popup:copy', (_event, text: unknown) => {
    clipboard.writeText(String(text ?? ''))
  })
  ipcMain.on('popup:hide', () => hidePopup())
  ipcMain.on('popup:set-pinned', (_event, pinned: unknown) => {
    setPopupPinned(Boolean(pinned))
  })
  ipcMain.on('settings:open', () => openSettings())
  ipcMain.on('settings:stop-service', () => stopApplicationService())
  ipcMain.on('selection:translate', () => {
    void translateSelectionButton()
  })
  ipcMain.on('ocr-selection:open', () => {
    void openOcrSelection()
  })
  ipcMain.on('ocr-selection:cancel', () => cancelOcrSelection())
  ipcMain.on('ocr-selection:submit', (_event, bounds: unknown) => {
    void submitOcrSelection(bounds)
  })
  ipcMain.on('ocr-clipboard:translate', () => {
    void translateClipboardImage()
  })
  ipcMain.on('manual-translate:open-request', () => openManualTranslation())
  ipcMain.handle('manual-translate:submit', (_event, request: unknown) =>
    translateManualRequest(request)
  )
  ipcMain.on('speech:edge-cancel', (_event, requestId: unknown) => {
    cancelEdgeSpeech(String(requestId ?? ''))
  })
  ipcMain.handle('speech:edge-synthesize', (_event, requestId: unknown, text: unknown, language: unknown) =>
    synthesizeEdgeSpeech(String(requestId ?? ''), String(text ?? ''), String(language ?? ''))
  )
  ipcMain.handle('popup:retranslate', async (_event, sourceLang: string, targetLang: string, origin?: TranslationOrigin) => {
    const sourcePreference = sourceLang || 'auto'
    const targetPreference = targetLang || 'auto'
    await applySettingsPatch({ sourceLang: sourcePreference, targetLang: targetPreference })
    const text = origin === 'ocr' ? lastOcrText : lastSelectedText
    const anchor = origin === 'ocr' ? lastOcrAnchor : lastSelectionAnchor
    if (!text) return
    await translateText(text, anchor, {
      sourceLang: sourcePreference,
      targetLang: targetPreference
    }, origin === 'ocr' ? 'ocr' : 'selection')
  })

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_event, patch: Partial<Settings>) => applySettingsPatch(patch))
  ipcMain.handle('dingtalk:configure', (_event, patch: DingTalkConfigPatch) =>
    applyDingTalkConfig(patch)
  )
  ipcMain.handle('dingtalk:clear-secret', () => clearDingTalkSecret())
  ipcMain.handle('dingtalk:check', () => checkDingTalk())
  ipcMain.handle('microsoft:check', () => checkMicrosoft())
  ipcMain.handle('ai:configure', (_event, patch: AiConfigPatch) => applyAiConfig(patch))
  ipcMain.handle('ai:clear-key', () => clearAiApiKey())
  ipcMain.handle('ai:list-models', () => listAiModels())
  ipcMain.handle('ai:check', () => checkAi())
  ipcMain.handle('ocr:get-status', () => getOcrStatus())

  ipcMain.handle('deeplx:check', (_event, url: string) => checkDeepLx(url))
  ipcMain.handle('deeplx:docker-command', (_event, port: number) => buildDockerCommand(port))
  ipcMain.on('deeplx:open-doc', () => openDeployDoc())
  ipcMain.handle('updater:get-status', () => getUpdateManager().getStatus())
  ipcMain.handle('updater:check', () => checkForApplicationUpdates())
  ipcMain.handle('updater:download', () => downloadApplicationUpdate())
  ipcMain.on('updater:install', () => installApplicationUpdate())
  ipcMain.handle('updater:open-release', () => openApplicationReleasePage())
  ipcMain.handle('updater:remove-quarantine', () => removeApplicationQuarantine())
}

// ---- 托盘 ----

/**
 * 停止划词翻译后台服务并退出应用。
 * @returns 无返回值。
 * @author zhenghq
 */
function stopApplicationService(): void {
  app.quit()
}

/**
 * 加载适配当前操作系统的翻译主题托盘图标。
 * @returns 已加载的托盘图标。
 * @author zhenghq
 */
function loadTrayIcon(): NativeImage {
  const filename = isMac ? 'trayTemplate.png' : 'tray.png'
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'build', filename))
  if (icon.isEmpty()) {
    throw new Error(`无法加载托盘图标: ${filename}`)
  }
  if (isMac) icon.setTemplateImage(true)
  return icon
}

/**
 * 创建仅显示模板图标的菜单栏状态项，减少 macOS 菜单栏占用宽度。
 * @returns 无返回值。
 * @author zhenghq
 */
function createTray(): void {
  tray = new Tray(loadTrayIcon())
  tray.setToolTip('划词翻译')
  tray.setContextMenu(buildTrayMenu())
}

/**
 * 构建包含触发方式开关、自动中英互译和手动语言选项的托盘菜单。
 * @returns Electron 托盘菜单。
 * @author zhenghq
 */
function buildTrayMenu(): Menu {
  const settings = getSettings()

  const targetOptions = [{ code: 'auto', label: '自动中英互译' }, ...LANGUAGES]
  const targetSubmenu = targetOptions.map((language) => ({
    label: language.label,
    type: 'radio' as const,
    checked: settings.targetLang.toLowerCase() === language.code.toLowerCase(),
    click: () => void applySettingsPatch({ targetLang: language.code })
  }))

  const sourceOptions = [{ code: 'auto', label: '自动检测' }, ...LANGUAGES]
  const sourceSubmenu = sourceOptions.map((language) => ({
    label: language.label,
    type: 'radio' as const,
    checked: settings.sourceLang.toLowerCase() === language.code.toLowerCase(),
    click: () => void applySettingsPatch({ sourceLang: language.code })
  }))

  return Menu.buildFromTemplate([
    { label: `划词翻译   ${settings.hotkey}`, enabled: false },
    { type: 'separator' },
    { label: '手动翻译…', click: () => openManualTranslation() },
    { label: '截图 OCR 翻译…', click: () => openOcrSelection() },
    { label: '剪贴板图片 OCR 翻译…', click: () => void translateClipboardImage() },
    { type: 'separator' },
    {
      label: '划词后自动显示“译”按钮',
      type: 'checkbox',
      checked: settings.triggerMode === 'button',
      click: (menuItem) =>
        void applySettingsPatch({ triggerMode: menuItem.checked ? 'button' : 'hotkey' })
    },
    { type: 'separator' },
    { label: '目标语言', submenu: targetSubmenu },
    { label: '源语言', submenu: sourceSubmenu },
    { type: 'separator' },
    { label: '设置', click: () => openSettings() },
    { label: '退出', click: () => stopApplicationService() }
  ])
}

/**
 * 应用退出前停止全局监听、注销快捷键并移除托盘图标。
 * @returns 无返回值。
 * @author zhenghq
 */
function cleanupBeforeQuit(): void {
  stopAutoTrigger()
  globalShortcut.unregisterAll()
  tray?.destroy()
  tray = null
}

app.on('before-quit', cleanupBeforeQuit)
