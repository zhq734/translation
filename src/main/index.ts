import {
  app,
  Tray,
  Menu,
  nativeImage,
  net,
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
  type SourcesOptions,
  type BrowserView
} from 'electron'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { loadSettings, saveSettings, getSettings } from './settings'
import { markHotkeyTrigger, recordTranslationUsage, recordWebPageUsage } from './usageReporter'
import { maybeSendInstallUpgradeNotification } from './installUpgradeNotification'
import { createAppLogger, type LogEntry } from './logging'
import { createMainI18nRuntime, type MainI18nRuntime } from './i18n'
import { createTranslator } from '../shared/i18n'
import {
  captureSelection,
  captureSelectionByNativeOnly,
  captureSelectionAfterButtonClick,
  PermissionError,
  checkAccessibilityPermission,
  hasScreenRecordingPermission,
  setPendingCopyModifierRelease,
  setPendingMacOSCommandWasDown
} from './capture'
import { recordCaptureDiagnostic, queryFrontmostApp, getCaptureDiagnosticsStore } from './captureDiagnostics'
import {
  checkDingTalk as checkDingTalkTranslation,
  checkMicrosoft as checkMicrosoftTranslation,
  configureTranslationFetch,
  resetDingTalkTranslationRuntime,
  resetMicrosoftTranslationRuntime,
  resetAiTranslationRuntime,
  resetDeepLxTranslationRuntime,
  translate,
  translateStream
} from './translate'
import { applyTranslationProxy, createTranslationWebSocket, translationFetch } from './network'
import { createEdgeSpeechClient } from './edgeSpeech'
import { PronunciationService } from './pronunciationService'
import { iscorevocDictionary } from './iscorevocDictionary'
import { PronunciationRequestRegistry } from './pronunciationRequests'
import {
  createPopup,
  showPopup,
  sendPopupDelta,
  hidePopup,
  hidePopupForInternalWindowSwitch,
  dismissPopupOnExternalPointerDown,
  isPopupVisible,
  isPopupPinned,
  isPopupActivated,
  isPopupHoldingKeyWindow,
  deactivatePopupForCapture,
  beginPopupSettingsOpenGuard,
  endPopupSettingsOpenGuard,
  isPopupSettingsOpenGuardActive,
  suppressExternalPointerDismissForButtonClick,
  isPointInsidePopup,
  getPopupCloseVersion,
  setPopupPinned,
  setPronunciationInteraction,
  showManualTranslationPopup,
  resizePopup
} from './popup'
import {
  forgetFrontmostApp,
  handBackFrontmostApp,
  handBackKeyWindowToFrontmostApp,
  handBackFrontmostThen,
  isMacAppActiveByEvents,
  isOwnWindowHoldingKeyWindow,
  readFrontmostAppSnapshot,
  rememberFrontmostApp,
  rememberFrontmostAppIfInactiveAsync,
  rememberFrontmostWindowAtPoint
} from './macForeground'
import {
  createSelectionButton,
  showSelectionButton,
  hideSelectionButton,
  isSelectionButtonVisible,
  isPointInsideSelectionButton
} from './selectionButton'
import {
  resetAutoTriggerPointerState,
  startAutoTrigger,
  stopAutoTrigger
} from './autoTrigger'
import { SelectionListenerController } from './selectionListenerController'
import { registerWindowControls } from './windowControls'
import { LANGUAGES } from '../shared/langs'
import { isCopyShortcut } from '../shared/copyShortcutBehavior'
import {
  collectShortcutRegistrationStates,
  findShortcutConflict,
  type GlobalShortcutId,
  type GlobalShortcutRegistrationState
} from './globalShortcutRegistry'
import {
  resolveHotkeyCaptureDelay,
  resolveHotkeyModifiers,
  shouldReleaseHotkeyModifiersBeforeCopy
} from '../shared/hotkeyCaptureTiming'
import { shouldPrefetchSelectionForButton } from '../shared/platformCapture'
import {
  ACTIVATE_DIAGNOSTIC_PREFIX,
  captureSyncStack,
  createActivateSourceRecord,
  formatActivateDiagnosticLog,
  logCandidateProbe
} from '../shared/activateDiagnostics'
import {
  POPUP_FOREGROUND_RESTORE_SETTLE_MS,
  shouldActivatePopupForCaptureFailure,
  shouldRestoreForegroundBeforeCapture
} from '../shared/popupForeground'
import {
  decideSelectionAction,
  resolveSelectionCaptureFailureMessage,
  resolveLanguagePair,
  isSelectionGestureInsideOwnWindows,
  isPointInsideBounds,
  type ScreenBounds,
  type SelectionGesture
} from '../shared/selectionBehavior'
import {
  findOwnWindowHit,
  resolveAppFrontmostForExclusion,
  resolveOwnWindowExclusion,
  type OwnWindowCandidate
} from '../shared/selectionOwnWindow'
import {
  canTreatActivateAsDockLaunch,
  classifySelectionPointerDown,
  SelectionInteractionController,
  type PointerDownResult
} from '../shared/selectionInteraction'
import {
  SelectionCaptureCoordinator,
  type SelectionCaptureContext,
  type SelectionCaptureResult
} from '../shared/selectionCaptureCoordinator'
import {
  recordCaptureOutcome,
  resetCopyTimeoutTracker
} from './copyTimeoutTracker'
import type {
  DingTalkCheckStatus,
  DingTalkConfigPatch,
  MicrosoftCheckStatus,
  AiConfigPatch,
  AiCheckStatus,
  AiModelListResult,
  DeepLxConfigPatch,
  Settings,
  DeepLxStatus,
  MacOSQuarantineResult,
  OcrEnginePreference,
  UpdateStatus,
  ManualTranslateRequest,
  TranslationOrigin,
  TranslatePayload,
  TranslateDeltaPayload
} from '../shared/types'
import type { EdgeSpeechResult } from '../shared/types'
import type { WebImageCandidate } from '../shared/webPageTranslation'
import { validateManualTranslationText } from '../shared/manualTranslationBehavior'
import { isPopupAutoSizeRequest } from '../shared/popupAutoSize'
import { DingTalkCredentialStore } from './dingtalkCredentials'
import { DingTalkConfigurationService } from './dingtalkConfig'
import { AiCredentialStore } from './aiCredentials'
import { AiConfigurationService } from './aiConfig'
import { AiModelDiscoveryService } from './aiModelDiscovery'
import { AiCheckService } from './aiCheck'
import { DeepLxConfigurationService } from './deepLxConfig'
import { DeepLxCheckService } from './deepLxCheck'
import {
  isMacOSDiskImageExecution,
  shouldOpenSettingsOnInitialLaunch
} from './appLifecycle'
import type { UpdateManager } from './updateManager'
import { removeMacOSApplicationQuarantine } from './macQuarantine'
import {
  captureRegionAsPng,
  ScreenCaptureError,
  type CaptureBounds
} from './screenCapture'
import {
  captureWindowsOcrPngPreferGdi,
  captureWindowsOcrPreviewPreferGdi,
  warmUpWindowsGdiCapture,
  type WindowsPixelCapture,
  type WindowsPreviewCapture
} from './windowsGdiCapture'
import {
  captureWindowsRegionAsPng,
  prewarmWindowsCaptureHelper,
  type WindowsScreenCaptureDeps
} from './windowsScreenCapture'
import {
  cropBgraSelectionPng,
  resolveSnapshotCropRect
} from './ocrSnapshotImage'
import type { OcrDispatcher, OcrEnginePreferenceState } from './ocrDispatcher'
import {
  handleOcrSelectionWindowClosed,
  handleOcrSelectionWindowHide
} from './ocrSelectionWindowEvents'
import { recognizeAdaptiveOcr } from './adaptiveOcr'
import { createWebImageSource, type WebImageResponse, type WebImageSource } from './webImageSource'
import { evaluateOcrQuality } from '../shared/ocrQuality'
import {
  buildOcrSessionResultKey,
  OcrSessionResultCache
} from './ocrSessionResultCache'
import { validateAnnotatedExportPayload } from './screenshotExportPayload'
import { translateOcrResult } from './ocrTranslate'
import { readClipboardImage } from './clipboardImage'
import { isWindows7CompatibilityRuntime } from './platformCompatibility'
import { OcrEngineError, type OcrRecognizeResult } from '../shared/ocrEngine'
import { cleanOcrText } from '../shared/ocrText'
import type {
  OcrErrorCode,
  OcrSelectionBounds,
  OcrSelectionFailedPayload,
  OcrStatus,
  ScreenshotExportImageRequest,
  ScreenshotOcrActionRequest,
  ScreenshotOcrErrorCode,
  ScreenshotToastKind,
  WebTranslationMode,
  WebTranslationRunRequest,
  WebViewBounds
} from '../shared/types'
import { WebReaderManager } from './webReaderWindow'
import { resolveMacOSDockPresentation, type MacOSDockPresentation } from './dockVisibility'
import { ALL_WORKSPACES_VISIBILITY_OPTIONS } from './windowWorkspaceVisibility'
import { suspendSettingsWindowFocusForPopupHide } from './settingsWindowPopupHideGuard'
import {
  buildLinuxAutostartEntry,
  buildLoginItemSettings,
  resolveAutoLaunchStrategy,
  resolveLinuxAutostartEntryPath
} from './autoLaunch'

const isMac = process.platform === 'darwin'
const execFileP = promisify(execFile)
/**
 * promisified spawn：启动进程并等待退出，返回退出码与 stdout/stderr。
 * 用于直接 spawn 预编译的 Windows 截图 helper exe。
 * @author zhenghq
 */
const spawnP = (executable: string, args: string[], options?: { timeout?: number; windowsHide?: boolean }): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })
    child.on('error', reject)
    child.on('close', (code: number | null) => resolve({ exitCode: code ?? -1, stdout, stderr }))
  })
}
const PRELOAD_PATH = join(__dirname, '../preload/index.js')
/** 应用唯一标识，与 electron-builder 的 appId 保持一致，用于 Linux 自启动桌面入口命名。 */
const APP_ID = 'com.selection.translator'
const DOCKER_IMAGE = 'ghcr.io/owo-network/deeplx:latest'
/** 自动翻译与按钮定位等待选区稳定的时长（毫秒）。 */
const SELECTION_SETTLE_DELAY_MS = 80
/**
 * 划词状态空档的 activate 抑制时长（毫秒）。
 *
 * 划词流程从手势结束到翻译结果上屏、再到结果弹窗关闭都可能让 macOS 派发
 * 内部 activate；每次内部窗口动作都会把抑制截止时间向后顺延该时长，覆盖
 * 事件派发延迟。取值只需覆盖单次派发延迟，不能过长，否则会吞掉用户紧接着
 * 的真实 Dock 点击。
 */
const SELECTION_ACTIVATION_SUPPRESS_MS = 500

/**
 * activate 回调在进入异步边界前采集的同步来源指纹。
 * @author zhenghq
 */
interface ActivateSourceProbe {
  /** 同步调用栈。 */
  stack: string
  /** 精确到毫秒的本地时间戳。 */
  timestampMs: number
  /** Electron activate 回调提供的可见窗口标记。 */
  hasVisibleWindows?: boolean
}

/**
 * 设置页临时提升到 screen-saver 层级后的自动回收时间（毫秒）。
 *
 * nonactivating panel 在 macOS 上不保证派发 blur；若只依赖 blur 降级，
 * 设置页会长期保持最高层级，划词时概率性浮到最前。显式置前后必须有界回收。
 */
const SETTINGS_PANEL_RAISE_LEVEL_TIMEOUT_MS = 400
const UPDATE_CHECK_DELAY_MS = 5000
const MIN_OCR_SELECTION_SIZE = 8
const OCR_TIMEOUT_MS = 30000

/**
 * 等待指定毫秒后继续，用于让系统完成焦点等异步状态切换。
 * @param ms 等待时长（毫秒）；小于等于 0 时立即返回。
 * @returns 等待完成后的 Promise。
 * @author zhenghq
 */
function waitFor(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 等待源窗口快照任务完成。
 *
 * 窗口读取包含 lsappinfo 与 CGWindowList 子进程调用，任务本身对每一步都设置了
 * 硬超时，因此这里直接等待任务即可保持整体有界；不能再叠加更短的入口超时，
 * 否则慢枚举会被提前截断，后续 AX 读取与复制激活只能拿到应用级上下文。
 * @param task 正在执行的窗口快照任务。
 * @returns 任务成功完成时返回 true；无任务或任务失败时返回 false。
 * @author zhenghq
 */
async function waitForSelectionWindowSnapshot(
  task: Promise<unknown> | undefined
): Promise<boolean> {
  if (!task) return false
  return task.then(() => true, () => false)
}

/**
 * 让出一次事件循环。
 *
 * Windows 上 win.show() 只是向系统投递显示请求，窗口真正上屏与合成需要主进程
 * 消息循环继续运转。若紧接着同步执行整屏 toDataURL，消息循环被阻塞，
 * 窗口反而要等编码结束才可见；先让出一次事件循环可以让窗口完成上屏。
 * @returns 下一轮事件循环开始后完成的 Promise。
 * @author zhenghq
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

let tray: Tray | null = null
let settingsWin: BrowserWindow | null = null
let ocrSelectionWin: BrowserWindow | null = null
const ocrSelectionWindowReadyPromises = new WeakMap<BrowserWindow, Promise<void>>()
let pendingOcrSelectionReady: {
  sessionId: number
  resolve: (ready: boolean) => void
  timer: NodeJS.Timeout
} | null = null
let screenshotToastWin: BrowserWindow | null = null
let screenshotToastHideTimer: NodeJS.Timeout | null = null
let dockIconEnabled = false
/**
 * 最近一次成功应用的 macOS 激活策略与 Dock 可见性。
 * 用于跳过重复切换：关闭网页翻译等场景会重复刷新 Dock 状态，
 * 而重复调用 `setActivationPolicy` / `dock.hide()` 会再次隐藏窗口，
 * 迫使下面的保留逻辑重新 `show()+focus()` 设置页，表现为设置页无缘无故弹到最前。
 */
let appliedMacOSDockPresentation: MacOSDockPresentation | null = null
let webReaderWindowOpen = false
let dingTalkConfiguration: DingTalkConfigurationService | null = null
let aiConfiguration: AiConfigurationService | null = null
let deepLxConfiguration: DeepLxConfigurationService | null = null
let deepLxCheckService: DeepLxCheckService | null = null
let aiModelDiscovery: AiModelDiscoveryService | null = null
let aiCheckService: AiCheckService | null = null
let updateManager: UpdateManager | null = null
let webReader: WebReaderManager | null = null
/** 主进程当前界面语言运行时；应用设置加载后初始化。 */
let mainI18n: MainI18nRuntime | null = null

/**
 * 注册首屏语言同步 IPC，供 preload 在页面脚本执行前取得当前语言。
 * @returns 无返回值。
 * @author zhenghq
 */
function registerLocaleIpc(): void {
  ipcMain.on('i18n:get-current-locale', (event) => {
    event.returnValue = mainI18n?.locale ?? 'en-US'
  })
}

/**
 * 使用当前界面语言翻译主进程用户可见文案。
 * 初始化完成前回退到英文目录，保证启动早期对话框不会出现中文硬编码。
 * @param key 语义化词条 key。
 * @param params 可选插值参数。
 * @returns 当前语言下的词条文本。
 * @author zhenghq
 */
function t(key: string, params?: Record<string, string | number>): string {
  if (mainI18n) return mainI18n.translator.t(key, params)
  return createTranslator('en-US').t(key, params)
}

const edgeSpeechClient = createEdgeSpeechClient({ socketFactory: createTranslationWebSocket })
const edgeSpeechRequests = new Map<string, AbortController>()
/** 主进程音标查询与受信任音频代理；网络请求复用现有翻译代理配置。 */
const pronunciationService = new PronunciationService({
  fetch: translationFetch,
  ieltsDictionary: iscorevocDictionary
})
/** 当前 Renderer 发起且尚未完成的音标查询与音频请求。 */
const pronunciationRequests = new PronunciationRequestRegistry()
let latestTranslationRequest = 0
let latestSelectionGesture = 0
/** 最近一次全局快捷键注册结果，供设置页查询和展示。 */
let shortcutRegistrationStates: GlobalShortcutRegistrationState[] = []
/** 最近一次划词相关内部动作的状态空档抑制截止时间戳；0 表示无抑制。 */
let selectionActivationSuppressUntil = 0
/**
 * 设置页显式置前代际。
 *
 * 启动首开、Dock、托盘与弹窗内打开设置都属于显式置前，但新建/复用分支需要
 * 等待页面就绪、Dock 策略刷新与事件循环让出，最终 moveTop()/focus() 往往在
 * 数十到数百毫秒之后才执行。若用户在这段窗口期内已经开始下一次划词，延迟到达
 * 的置前会把设置页（以及 app.dock.show() 激活的整个应用）顶到划词应用之上。
 * 每次划词内部动作开始时递增本代际，使尚未收尾的置前动作自动失效。
 */
let settingsBringToFrontEpoch = 0
/** 保护期内被延后的 macOS Dock 显示定时器；重复请求时重置。 */
let pendingMacOSDockShowTimer: ReturnType<typeof setTimeout> | null = null
/** 保护期内被延后的 macOS Dock 呈现重放定时器；与仅显示 Dock 的定时器分开，避免互相取消。 */
let pendingMacOSDockVisibilityTimer: ReturnType<typeof setTimeout> | null = null
let latestOcrSnapshot: OcrSnapshot | null = null
// OCR 框选会话自增序号：begin 与 snapshot 共用，Renderer 据此丢弃跨会话残留事件。
let ocrSelectionSessionSeq = 0
// 记录截图窗口进行中的识别/复制/保存请求，用于取消、关闭和新会话时丢弃旧回调。
const activeScreenshotOcrRequests = new Map<string, number>()
// 会话级 OCR 识别结果缓存：只保留最近一次识别结果，供同一会话、同一选区、
// 同一 OCR 设置下的翻译动作复用，避免「先识别再翻译」把同一张图识别两遍。
const ocrSessionResultCache = new OcrSessionResultCache()
// 统一记录普通选区、翻译与 OCR 的交互状态，避免窗口显隐和异步流程之间出现竞态。
const selectionInteraction = new SelectionInteractionController()
let ocrInteractionToken: number | null = null
/**
 * 本轮截图开始前应用是否已是 macOS 前台应用。
 * 覆盖窗口显示时会把应用激活到最前，隐藏时系统又把应用内下一个窗口（通常是设置页）
 * 提升为 key window 顶到所有应用之上；因此截图前应用不在最前时，收尾必须把前台交还回去，
 * 否则用户会看到「截屏复制后设置页自动弹出」。
 */
let ocrSessionAppWasFrontmost = true
/**
 * 退化方案里恢复应用内窗口的延迟（毫秒）。
 * app.hide() 由 macOS 异步生效，同一 tick（含 setTimeout 0）内 app.show() 会被随后的隐藏动作覆盖，
 * 窗口会一直不可见（真机采样验证过），因此必须留出足够间隔。
 */
const FRONT_RESTORE_DELAY_MS = 60
/** 退化方案的校验延迟（毫秒）：隐藏生效较慢时补一次 app.show()，避免窗口一直不可见。 */
const FRONT_RESTORE_VERIFY_DELAY_MS = 180
/** OCR 预览采集超时阈值：覆盖窗口已显示但迟迟拿不到快照时按采集失败收尾。 */
const OCR_PREVIEW_CAPTURE_TIMEOUT_MS = 5000
/** 截图运行时预热延迟：让启动关键路径先完成，再在空闲时创建覆盖窗口与绑定 GDI。 */
const SCREENSHOT_PREWARM_DELAY_MS = 1500
// 按钮显示期间用只读直读做后台预取，点击按钮时只消费已经完成的有效缓存；
// 预取未完成或为空时立即取消它，并通过按钮专用管线优先发送复制快捷键。
const selectionCapture = new SelectionCaptureCoordinator(
  captureSelection,
  captureSelectionByNativeOnly,
  captureSelectionAfterButtonClick,
  {
    onDiagnostic: (input) => {
      // 惰性查询前台应用标识，取词结果不等待它；查询失败兜底为 unknown。
      void queryFrontmostApp().then(({ app }) => {
        recordCaptureDiagnostic({
          at: input.at,
          entry: input.entry ?? 'button',
          platform: input.platform,
          level: input.level,
          reason: input.reason,
          elapsedMs: input.elapsedMs,
          app,
          windowLocate: input.windowLocate,
          windowCount: input.windowCount,
          windowMatched: input.windowMatched
        })
      })
    }
  }
)
const selectionListenerController = new SelectionListenerController({
  start: () => startAutoTrigger(
    handleSelectionGesture,
    handleSelectionPointerDown,
    handleCopyShortcut,
    handlePasteShortcut
  ),
  stop: () => stopAutoTrigger(),
  log: (message) => console.warn(message)
})
let lastSelectedText = ''
let lastSelectionAnchor: { x: number; y: number } | undefined
/** 最近一次划词或快捷键记录的源窗口上下文，供按钮与自动路径复用。 */
let lastSelectionWindowContext: SelectionCaptureContext | undefined
/** 最近一次源窗口快照任务；按钮与自动入口在取词前做有界等待。 */
let selectionWindowSnapshotTask: Promise<unknown> | undefined
/** 源窗口快照任务对应的划词手势序号，防止旧任务覆盖新一轮上下文。 */
let selectionWindowSnapshotGestureId = 0
let lastOcrText = ''
let lastOcrAnchor: { x: number; y: number } | undefined
let lastOcrEngine: TranslatePayload['ocrEngine'] | undefined

/** 自动 OCR 最近一次成功引擎，在应用生命周期内沿用，失败时再按顺序降级。 */
const ocrEnginePreferenceState: OcrEnginePreferenceState = {}

/**
 * 返回已初始化的钉钉配置服务。
 * @returns 主进程钉钉配置服务。
 * @author zhenghq
 */
function getDingTalkConfiguration(): DingTalkConfigurationService {
  if (!dingTalkConfiguration) throw new Error(t('app.serviceNotInitialized.dingtalk'))
  return dingTalkConfiguration
}

/**
 * 获取已初始化的 AI 配置服务实例。
 * @returns AI 配置服务实例。
 * @author zhenghq
 */
function getAiConfiguration(): AiConfigurationService {
  if (!aiConfiguration) throw new Error(t('app.serviceNotInitialized.aiConfig'))
  return aiConfiguration
}

/**
 * 获取已初始化的 DeepLX 配置服务。
 * @returns DeepLX 配置服务实例。
 * @author zhenghq
 */
function getDeepLxConfiguration(): DeepLxConfigurationService {
  if (!deepLxConfiguration) throw new Error(t('app.serviceNotInitialized.deepLx'))
  return deepLxConfiguration
}

/**
 * 返回已初始化的自动更新管理器。
 * @returns 自动更新管理器。
 * @author zhenghq
 */
function getUpdateManager(): UpdateManager {
  if (!updateManager) throw new Error(t('app.serviceNotInitialized.update'))
  return updateManager
}

/**
 * 返回已初始化的网页阅读器管理器。
 * @returns 网页阅读器管理器。
 * @author zhenghq
 */
function getWebReader(): WebReaderManager {
  if (!webReader) throw new Error(t('app.serviceNotInitialized.webReader'))
  return webReader
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
  if (!normalizedText) return { ok: false, error: t('error.edgeSpeechEmptyText') }
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
    return { ok: false, error: t('error.edgeSpeechUnavailable') }
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

/**
 * 规范化 Renderer 传入的音标请求 ID，避免异常长值或非字符串进入主进程注册表。
 * @param value 未信任请求 ID。
 * @returns 合法请求 ID；非法时返回空字符串。
 * @author zhenghq
 */
function normalizePronunciationRequestId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= 128 ? normalized : ''
}

/**
 * 采集设置窗口当前的可见性布尔值，供 activate 来源诊断打点使用。
 * @returns 设置窗口存在、未销毁且可见时返回 true，否则返回 false。
 * @author zhenghq
 */
function isSettingsWindowVisibleForProbe(): boolean {
  return Boolean(settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible())
}

/**
 * 判断本次 activate 事件是否为用户真正的 Dock 激活操作。
 * macOS 的 activate 会在应用内任意窗口被激活时触发，包括划词过程中显示的
 * “译”按钮与翻译弹窗。若不加区分就打开设置窗口，会在用户划词时突然抢走
 * 前台应用焦点，导致原生选区失效、随后取词失败。
 * @param probe activate 回调在进入异步边界前采集的同步指纹。
 * @returns 交互状态、内部窗口、OCR 暂停和激活租约均为空闲时返回 true。
 * @author zhenghq
 */
function shouldTreatActivateAsDockLaunch(probe: ActivateSourceProbe): boolean {
  const decision = canTreatActivateAsDockLaunch({
    interactionState: selectionInteraction.snapshot().state,
    selectionButtonVisible: isSelectionButtonVisible(),
    popupVisible: isPopupVisible(),
    hiServicesRepairRunning,
    ocrVisible: isOcrSelectionVisible(),
    listenerPausedForOcr: selectionListenerController.isPausedForOcr(),
    selectionActivationSuppressUntil
  })
  // 来源取证必须先于判定日志输出：同步栈已经由调用方在事件回调入口采集，
  // 这里只做校验与序列化；任何诊断异常都不得中断 activate 原有流程。
  try {
    const diagnostic = createActivateSourceRecord({
      timestampMs: probe.timestampMs,
      decision: decision.allowed ? 'allow' : 'ignore',
      reason: decision.allowed ? undefined : decision.reason ?? 'unknown',
      stack: probe.stack,
      event: { hasVisibleWindows: probe.hasVisibleWindows }
    })
    if (diagnostic.ok) {
      console.log(formatActivateDiagnosticLog(diagnostic.record))
    } else {
      console.log(`${ACTIVATE_DIAGNOSTIC_PREFIX} dropped: ${diagnostic.error}`)
    }
  } catch (error) {
    console.log(
      '[activate-diagnostics] output failed:',
      error instanceof Error ? error.message : String(error)
    )
  }
  if (decision.allowed) {
    // 放行路径也要留痕：只有记录判定依据，才能事后区分真实 Dock 启动
    // 与收尾窗口期漏网的内部 activate。
    console.log('[main] activate 按 Dock 启动处理:', JSON.stringify(decision.checks ?? {}))
  } else {
    console.log(`[main] 忽略内部 activate: ${decision.reason ?? 'unknown'}`)
  }
  return decision.allowed
}

/**
 * 续期划词内部动作的 activate 抑制。
 *
 * 只应在确实由划词流程引发的内部窗口显隐/焦点变化前后调用。每次调用只把
 * 截止时间向后顺延一个短窗口，不会把用户紧接着点击 Dock 的真实激活永久拦截。
 * @returns 无返回值。
 * @author zhenghq
 */
function suppressSelectionActivationWindowGap(): void {
  selectionActivationSuppressUntil = Date.now() + SELECTION_ACTIVATION_SUPPRESS_MS
  // 划词内部动作开始即宣告“当前用户交互属于划词”：任何仍在等待 await 收尾的
  // 设置页显式置前都必须立即失效，不能在用户已经开始划词后再把窗口顶到最前。
  settingsBringToFrontEpoch += 1
}

/**
 * 处理翻译弹窗关闭生命周期的内部窗口收尾。
 *
 * 关闭开始与真实隐藏完成时都必须续期划词 activate 抑制，并立即回收设置页
 * 临时提升的层级，防止异步前台交还期间或隐藏后的迟到 activate 把设置页置前。
 * @returns 无返回值。
 * @author zhenghq
 */
function handlePopupInternalWindowTransition(): void {
  suppressSelectionActivationWindowGap()
  lowerSettingsPanelRaiseLevel()
}

/** 当前翻译弹窗隐藏期间持有的设置页焦点恢复函数；未启用保护时为 null。 */
let restoreSettingsWindowFocusAfterPopupHide: (() => void) | null = null

/**
 * 在翻译弹窗真实隐藏前暂时撤销设置页的 key window 候选资格。
 *
 * 仅覆盖 win.hide() 前后的同步窗口期，避免 macOS 把同应用后台设置页提升到最前；
 * 不参与取词生命周期，也不使用定时器或异步恢复。
 * @returns 无返回值。
 * @author zhenghq
 */
function suspendSettingsWindowFocusBeforePopupHide(): void {
  restoreSettingsWindowFocusAfterPopupHide?.()
  restoreSettingsWindowFocusAfterPopupHide = suspendSettingsWindowFocusForPopupHide(
    process.platform,
    settingsWin
  )
}

/**
 * 在翻译弹窗真实隐藏后恢复设置页的 key window 候选资格。
 * @returns 无返回值。
 * @author zhenghq
 */
function restoreSettingsWindowFocusAfterPopupHideCallback(): void {
  restoreSettingsWindowFocusAfterPopupHide?.()
  restoreSettingsWindowFocusAfterPopupHide = null
}

/**
 * 处理翻译弹窗关闭开始。
 *
 * 先回收设置页临时层级并挂起后台设置页的 key window 候选资格，再让弹窗进入
 * 异步前台交还；两个动作都必须在关闭入口同步完成，不能等待 handBack。
 * @returns 无返回值。
 * @author zhenghq
 */
function handlePopupCloseStart(): void {
  handlePopupInternalWindowTransition()
  suspendSettingsWindowFocusBeforePopupHide()
}

/**
 * 处理翻译弹窗真实隐藏完成。
 *
 * 先恢复设置页焦点能力，再续期内部 activate 抑制并回收层级，覆盖 hide() 后
 * 可能迟到的系统激活事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handlePopupCloseEnd(): void {
  restoreSettingsWindowFocusAfterPopupHideCallback()
  handlePopupInternalWindowTransition()
}

/**
 * 判断当前是否处于划词置前保护期。
 *
 * 划词手势结束到按钮/弹窗状态生效之间存在短暂空档，activate 判定可能呈现
 * “全空闲”而被误判为 Dock 点击；同时 Dock 策略刷新与设置页延迟置前都可能
 * 在这个窗口期把整个应用激活到最前。保护期复用 activate 抑制租约，保证这些
 * 内部动作被推迟而不是当作显式用户入口执行。
 * @returns 保护期仍然有效时返回 true。
 * @author zhenghq
 */
function isSelectionWindowRaiseGuardActive(): boolean {
  return selectionActivationSuppressUntil > Date.now()
}

/**
 * 释放当前交互 token。
 * @param token 需要释放的交互 token。
 * @returns 无返回值。
 * @author zhenghq
 */
function releaseSelectionInteraction(token: number): void {
  const released = selectionInteraction.release(token)
  // 翻译结果通常在划词手势 1~3 秒后才上屏，最初的短抑制窗口早已过期。
  // 释放交互 token 后系统可能派发一次迟到 activate，必须在收尾处再次续期，
  // 否则它会被误判为 Dock 点击并把已打开的设置页拉到最前。
  if (released) {
    suppressSelectionActivationWindowGap()
  }
}

/**
 * 使当前普通选区流程失效并返回新 token。
 * @returns 交互流程被失效时返回新的 token；OCR 独占期间返回 null。
 * @author zhenghq
 */
function invalidateSelectionFlowWithFocusCleanup(): number | null {
  const invalidatedToken = selectionInteraction.invalidateSelectionFlow()
  return invalidatedToken
}

/**
 * 激活已有网页阅读器页面；没有尚未关闭的页面时打开设置窗口。
 * 调用方已经通过 shouldTreatActivateAsDockLaunch() 排除内部窗口激活；
 * 能走到这里的是用户点击 Dock 图标，属于显式入口。
 * @returns 无返回值。
 * @author zhenghq
 */
function activateExistingPageOrOpenSettings(): void {
  // 记录显式入口：该函数此前完全静默，无法判断设置页置前是否由 activate 走到这里。
  logCandidateProbe('settings-activate-entry', isSettingsWindowVisibleForProbe())
  // activate 判定存在短暂状态空档：检查时可能刚好全空闲，但事件派发时用户
  // 已经开始划词。此时若继续置前阅读器或设置页，就会把它们顶到划词应用之上。
  if (isSelectionWindowRaiseGuardActive()) return
  // activate 判定存在短暂状态空档，可能把内部动作误放行。focusExistingWindow()
  // 对已可见且未最小化的阅读器只返回 true、不重新 show()+focus()，因此即便
  // 误放行也不会把后台阅读器顶到划词应用之上；不可见或最小化时仍会正常恢复，
  // 保证真实 Dock 启动可用。被其它应用遮挡时的强制置前改由显式快捷键入口负责。
  if (webReader?.focusExistingWindow()) return
  // 设置页分支必须与阅读器分支对称：已可见且未最小化的设置页不得再执行
  // show()+moveTop()+focus()。真机日志显示 6 次迟到 activate 误放行后都走到
  // settings-reuse-raise，把已可见设置页重新顶到划词应用之上。activate 判定
  // 存在状态空档，无法与真实 Dock 点击区分，因此这里对已可见窗口只保留其现有
  // 层级，不再主动置前；被其它应用遮挡时的强制置前改由托盘/弹窗内显式入口负责。
  if (settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible() && !settingsWin.isMinimized()) {
    return
  }
  // activate 已经由 shouldTreatActivateAsDockLaunch() 过滤，能走到这里说明是
  // 用户点击 Dock 图标，属于显式入口。必须复用并置前已有设置页；此前传 false
  // 会让窗口保持后台层级，日志显示“按 Dock 启动处理”但界面毫无反应。
  void openSettings({ bringToFront: true })
    .then(async () => {
      const target = settingsWin
      if (!target || target.isDestroyed() || !target.isVisible()) return
      // Dock 激活事件可能在第一次 show/focus 之后才完成系统窗口重排，复用分支
      // 缺少新建分支的最终置前；让出一轮事件循环再补一次，避免设置页随即失焦。
      await yieldToEventLoop()
      if (settingsWin !== target || target.isDestroyed() || !target.isVisible()) return
      // 等待期间用户可能已经开始下一次划词；此时补置前同样会抢走划词前台。
      if (isSelectionWindowRaiseGuardActive()) return
      // activate 路径复用已可见设置页时不得提升到 screen-saver：普通窗口的
      // moveTop() 已足以把设置页放到最前，最高层级提升只会放大误判后果。
      showOwnWindowForInteraction(target, { raiseLevel: false })
    })
    .catch((error: unknown) => {
      console.error('[settings] Dock 激活打开设置窗口失败:', error)
    })
}

// ---- 主进程日志层 ----
// 尽早初始化：包装 console 输出，按天滚动落盘并保留最近 1 天，供设置窗口实时查看。
// 必须放在其余模块日志输出之前，确保启动期日志也被采集。
// @author zhenghq
const appLogger = createAppLogger({ logDir: app.getPath('logs') })

/**
 * 向存活的设置窗口推送增量日志；窗口未打开时不做任何推送。
 * @param entries 同 tick 聚合后的日志条目。
 * @returns 无返回值。
 * @author zhenghq
 */
function pushLogEntries(entries: LogEntry[]): void {
  if (!settingsWin || settingsWin.isDestroyed()) return
  settingsWin.webContents.send('logs:entry', entries)
}

appLogger.subscribe(pushLogEntries)

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
      void openSettings()
    })
  })
  if (isMac) {
    // macOS 通过 Finder 重新打开运行中的应用时通常只激活已有进程，不会创建第二实例。
    app.on('activate', (_event, hasVisibleWindows) => {
      // 调用栈必须在进入任何异步边界之前采集：延迟到 then/await 之后再取栈，
      // 派发者帧已经出栈，只剩事件循环帧，无法指认内部 activate 的来源。
      const activateStack = captureSyncStack()
      const activateTimestampMs = Date.now()
      void initialization.then((initialized) => {
        if (!initialized) return
        // 划词交互中的窗口激活也会触发 activate，此时不能打开设置窗口抢走选区。
        if (!shouldTreatActivateAsDockLaunch({
          stack: activateStack,
          timestampMs: activateTimestampMs,
          hasVisibleWindows
        })) return
        activateExistingPageOrOpenSettings()
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
  dialog.showErrorBox(
    t('app.startupFailed.title'),
    t('app.startupFailed.message', { message })
  )
  app.quit()
  return false
}

/**
 * 加载 macOS Dock 使用的自定义应用图标，避免应用从菜单栏形态恢复时回退为 Electron 默认图标。
 * @returns 已加载的应用图标。
 * @author zhenghq
 */
function loadMacOSDockIcon(): NativeImage {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    throw new Error(t('error.dockIconLoadFailed', { message: iconPath }))
  }
  return icon
}

/**
 * 根据用户设置和常规窗口状态成对切换 macOS 激活策略与 Dock 图标可见性。
 * regular 策略必须显示 Dock，accessory 策略必须隐藏 Dock；用户开启功能且任一常规窗口存在时显示图标。
 * 设置窗口关闭但网页翻译窗口仍打开时必须保持当前激活策略，避免重排窗口层级把翻译页压到最下层。
 * @param showDockIcon 用户保存的 Dock 图标设置。
 * @returns 无返回值。
 * @author zhenghq
 */
async function applyMacOSDockVisibility(showDockIcon: boolean): Promise<void> {
  if (!isMac) return
  dockIconEnabled = showDockIcon
  // 划词保护期内必须完全推迟 Dock 呈现切换：setActivationPolicy()/dock.hide()
  // 会重排窗口层级，dock.show() 会激活整个应用，均可能把设置页顶到前台应用之上。
  if (isSelectionWindowRaiseGuardActive()) {
    scheduleMacOSDockVisibilityAfterSelectionGuard()
    return
  }
  const presentation = resolveMacOSDockPresentation({
    showDockIcon,
    settingsOpen: Boolean(settingsWin && !settingsWin.isDestroyed()),
    webReaderOpen: webReaderWindowOpen
  })
  // 呈现方式没有变化时必须直接返回：关闭网页翻译等场景会重复刷新 Dock 状态，
  // 重复切换激活策略会再次重排窗口层级，可能把设置页顶到前台应用之上。
  if (
    appliedMacOSDockPresentation?.policy === presentation.policy &&
    appliedMacOSDockPresentation.dockVisible === presentation.dockVisible
  ) {
    return
  }
  app.setActivationPolicy(presentation.policy)
  if (presentation.dockVisible) {
    try {
      app.dock?.setIcon(loadMacOSDockIcon())
      // app.dock.show() 会把整个应用激活到最前，连带把设置页与阅读器顶到
      // 划词应用之上。划词保护期内必须延后这次激活，等保护期结束再补执行。
      if (isSelectionWindowRaiseGuardActive()) {
        scheduleMacOSDockShowAfterSelectionGuard()
      } else {
        // 调用前后各打一条：用于区分“进入本次刷新前应用已被激活”与
        // “dock.show() 本身激活应用”，打点不改变 await 顺序。
        logCandidateProbe('dock-show-sync-before', isSettingsWindowVisibleForProbe())
        await app.dock?.show()
        logCandidateProbe('dock-show-sync-after', isSettingsWindowVisibleForProbe())
      }
    } catch (error) {
      console.error('[main] 恢复 macOS Dock 图标失败:', error)
    }
    appliedMacOSDockPresentation = presentation
    return
  }
  await app.dock?.hide()
  appliedMacOSDockPresentation = presentation
}

/**
 * 根据设置同步系统开机自启动状态。
 * macOS/Windows 写入系统登录项，Linux 写入 XDG 自启动桌面入口，开发模式与其他平台跳过。
 * @param enabled 是否开启开机自启动。
 * @returns 无返回值。
 * @author zhenghq
 */
function applyAutoLaunch(enabled: boolean): void {
  const strategy = resolveAutoLaunchStrategy({
    platform: process.platform,
    packaged: app.isPackaged
  })
  if (strategy === 'skipped' || strategy === 'unsupported') {
    console.log(`[autoLaunch] 当前环境不写入自启动配置: ${strategy}`)
    return
  }
  try {
    if (strategy === 'login-item') {
      app.setLoginItemSettings(
        buildLoginItemSettings({
          platform: process.platform,
          enabled,
          execPath: process.execPath
        })
      )
      return
    }
    const entryPath = resolveLinuxAutostartEntryPath(homedir(), APP_ID)
    if (!enabled) {
      rmSync(entryPath, { force: true })
      return
    }
    mkdirSync(dirname(entryPath), { recursive: true })
    writeFileSync(
      entryPath,
      buildLinuxAutostartEntry({ appName: app.getName(), execPath: process.execPath }),
      { mode: 0o644 }
    )
  } catch (error) {
    console.error('[autoLaunch] 同步开机自启动失败:', (error as Error).message)
  }
}

/**
 * 根据当前设置和常规窗口状态刷新 macOS Dock 图标。
 * @returns 无返回值。
 * @author zhenghq
 */
async function refreshMacOSDockVisibility(): Promise<void> {
  await applyMacOSDockVisibility(dockIconEnabled)
}

/**
 * 在划词置前保护期结束后补执行被延后的 macOS Dock 显示。
 *
 * `app.dock.show()` 会激活整个应用，是划词期间窗口被顶到最前的直接来源之一。
 * 保护期内只能先把 Dock 呈现登记为已应用，等用户划词交互结束再真正显示，
 * 避免内部刷新把整个应用拉到前台。
 * @returns 无返回值。
 * @author zhenghq
 */
function scheduleMacOSDockShowAfterSelectionGuard(): void {
  if (!isMac) return
  if (pendingMacOSDockShowTimer) clearTimeout(pendingMacOSDockShowTimer)
  const delayMs = Math.max(0, selectionActivationSuppressUntil - Date.now()) + 20
  pendingMacOSDockShowTimer = setTimeout(() => {
    pendingMacOSDockShowTimer = null
    // 保护期被新的划词动作续期、或划词交互仍在进行时继续等待：
    // 连续快速划词会在两次交互之间出现短暂空闲，只在保护期计时会过早重放并激活应用。
    if (
      isSelectionWindowRaiseGuardActive() ||
      selectionInteraction.snapshot().state !== 'idle'
    ) {
      scheduleMacOSDockShowAfterSelectionGuard()
      return
    }
    logCandidateProbe('dock-show-delayed', isSettingsWindowVisibleForProbe())
    const showPromise = app.dock?.show()
    if (showPromise) {
      void showPromise.catch((error: unknown) => {
        console.error('[main] 划词结束后恢复 macOS Dock 图标失败:', error)
      })
    }
  }, delayMs)
}

/**
 * 在划词置前保护期结束后重新应用一次 macOS Dock 呈现。
 *
 * 保护期内 Dock 策略切换与窗口保留都会改变 z-order；这里只登记“稍后重放”，
 * 不在划词过程中做任何激活、显示或置前动作。重放时会重新解析当前窗口状态，
 * 因此期间设置页/阅读器的开关变化也不会丢失。
 * @returns 无返回值。
 * @author zhenghq
 */
function scheduleMacOSDockVisibilityAfterSelectionGuard(): void {
  if (!isMac) return
  if (pendingMacOSDockVisibilityTimer) clearTimeout(pendingMacOSDockVisibilityTimer)
  const delayMs = Math.max(0, selectionActivationSuppressUntil - Date.now()) + 20
  pendingMacOSDockVisibilityTimer = setTimeout(() => {
    pendingMacOSDockVisibilityTimer = null
    if (
      isSelectionWindowRaiseGuardActive() ||
      selectionInteraction.snapshot().state !== 'idle'
    ) {
      scheduleMacOSDockVisibilityAfterSelectionGuard()
      return
    }
    void refreshMacOSDockVisibility().catch((error: unknown) => {
      console.error('[main] 划词结束后刷新 macOS Dock 呈现失败:', error)
    })
  }, delayMs)
}

/**
 * 将 macOS 应用配置为菜单栏应用，并按用户设置控制 Dock 栏图标。
 * 首次启动即将打开设置页且用户开启 Dock 图标时，延后到设置窗口创建后再切换，避免先隐藏再恢复导致窗口失焦或关闭。
 * @param showDockIcon 是否显示 Dock 栏图标。
 * @param settingsWillOpen 是否即将打开首次设置窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
async function configureMacOSMenuBarApplication(
  showDockIcon: boolean,
  settingsWillOpen: boolean
): Promise<void> {
  if (!isMac) return
  dockIconEnabled = showDockIcon
  if (!showDockIcon || !settingsWillOpen) await applyMacOSDockVisibility(showDockIcon)
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
    title: t('dialog.installFromDiskImage.title'),
    message: t('dialog.installFromDiskImage.message'),
    detail: t('dialog.installFromDiskImage.detail'),
    buttons: [t('dialog.installFromDiskImage.exit'), t('dialog.installFromDiskImage.continue')],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return result.response === 1
}

/**
 * 空闲预热截图运行时：提前创建并加载 OCR 覆盖窗口、在 Windows 上提前绑定 koffi/GDI。
 * 首次 new BrowserWindow + 加载 selection.html 在 Windows 上常见数百毫秒，
 * koffi 首次 require 还可能被杀毒扫描拖慢；把这部分成本从快捷键热路径挪到启动空闲期。
 * 任何失败只打日志，不影响应用启动，首次真实截图会再次尝试。
 * @returns 无返回值。
 * @author zhenghq
 */
function prewarmScreenshotRuntime(): void {
  if (isWindows7CompatibilityRuntime()) return
  setTimeout(() => {
    try {
      // 预创建保持隐藏；openOcrSelection 会复用同一实例。
      getOcrSelectionWindow()
    } catch (error) {
      console.log('[ocr] 覆盖窗口预创建失败', error instanceof Error ? error.message : error)
    }
    try {
      const warmed = warmUpWindowsGdiCapture(process.platform)
      if (warmed) console.log('[ocr] GDI 采集预热完成')
    } catch (error) {
      console.log('[ocr] GDI 采集预热失败', error instanceof Error ? error.message : error)
    }
    // 慢回退路径的 helper exe 也要提前编译：缺失时首次回退采集会在截图热路径上
    // 现场调用 csc，额外增加 1~3 秒。这里只编译并落盘，失败静默，真实采集仍会按需重试。
    void prewarmWindowsCaptureHelper(buildWindowsScreenCaptureDeps()).then((ready) => {
      if (ready) console.log('[ocr] helper exe 预热完成')
    })
  }, SCREENSHOT_PREWARM_DELAY_MS)
}

/**
 * 初始化主进程窗口、全局监听、托盘和 IPC。
 * @returns 初始化完成时返回 true；用户选择退出磁盘镜像实例时返回 false。
 * @author zhenghq
 */
async function onReady(): Promise<boolean> {
  if (!(await confirmMacOSInstalledApplicationLaunch())) {
    app.quit()
    return false
  }

  loadSettings()
  mainI18n = createMainI18nRuntime({
    getUiLocale: () => getSettings().uiLocale,
    localeSources: {
      preferredSystemLanguages: app.getPreferredSystemLanguages(),
      systemLocale: app.getSystemLocale(),
      appLocale: app.getLocale(),
      env: process.env
    },
    onLocaleChanged: () => refreshLocalizedApplicationChrome()
  })
  // 窗口创建早于 registerIpc，必须在这里先注册同步语言通道，保证 preload 首屏可用。
  registerLocaleIpc()
  const openSettingsOnInitialLaunch = shouldOpenSettingsOnInitialLaunch(process.platform)
  await configureMacOSMenuBarApplication(
    getSettings().showDockIcon,
    openSettingsOnInitialLaunch
  )
  applyAutoLaunch(getSettings().autoLaunch)
  createTray()
  dingTalkConfiguration = new DingTalkConfigurationService({
    getSettings,
    saveSettings,
    credentialStore: new DingTalkCredentialStore(
      join(app.getPath('userData'), 'credentials.json'),
      safeStorage
    ),
    onSettingsChanged: (settings) => {
      refreshTrayMenu()
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
      refreshTrayMenu()
      broadcast('settings:changed', settings)
    },
    resetTranslationRuntime: resetAiTranslationRuntime
  })
  aiConfiguration.initialize()
  deepLxConfiguration = new DeepLxConfigurationService({
    getSettings,
    saveSettings,
    onSettingsChanged: (settings) => {
      refreshTrayMenu()
      broadcast('settings:changed', settings)
    },
    resetTranslationRuntime: resetDeepLxTranslationRuntime
  })
  aiModelDiscovery = new AiModelDiscoveryService({ fetch: translationFetch })
  aiCheckService = new AiCheckService({ fetch: translationFetch })
  deepLxCheckService = new DeepLxCheckService({ fetch: translationFetch })
  await applyTranslationProxy(getSettings())
  configureTranslationFetch(translationFetch)
  webReader = new WebReaderManager({
    preloadPath: PRELOAD_PATH,
    loadRenderer: loadRendererHtml,
    getSettings,
    createImageSource: (view, signal) => createWebReaderImageSource(view, signal),
    recognizeImage: async (bytes, candidate) => {
      const settings = getSettings()
      const dispatcher = await createOcrDispatcher(settings)
      const ocr = await recognizeAdaptiveOcr(
        {
          imageBytes: bytes,
          maxScale: settings.ocrScale,
          language: settings.ocrLang
        },
        {
          recognize: (preparedImageBytes) =>
            dispatcher.recognize({
              imageBytes: preparedImageBytes,
              language: settings.ocrLang,
              timeoutMs: OCR_TIMEOUT_MS
              // 现代平台继续使用 settings.ocrEnginePreference；Win7 由 resolveOcrEnginePreference 强制 Tesseract。
            }, resolveOcrEnginePreference(settings))
        }
      )
      const text = cleanOcrText(ocr.text ?? '')
      // 复用统一质量评价：噪声或明显语言不匹配的识别结果按空文本处理，
      // 交由图片管道计入跳过，不进入翻译通道。
      const quality = evaluateOcrQuality(ocr, settings.ocrLang)
      if (!quality.valid || quality.languageMismatch) return { text: '', score: 0 }
      return { text, score: quality.averageConfidence ?? Math.min(1, quality.textScore / 10) }
    },
    onWindowStateChanged: (open) => {
      webReaderWindowOpen = open
      void refreshMacOSDockVisibility()
    },
    onInternalWindowFocusLost: () => {
      const focusedWindow = BrowserWindow.getFocusedWindow()
      // 阅读器显式置前会临时提升到 screen-saver；一旦失焦就立即归还普通层级，
      // 不能只依赖 400ms 定时器。统一回收器会忽略未被提升过的设置页。
      lowerSettingsPanelRaiseLevel()
      // 阅读器 blur 可能只是把焦点交给设置页或另一个自有窗口，这仍属于应用内部
      // 切换，不能解除保护。只有焦点为空或已离开全部自有窗口时才恢复弹窗失焦语义。
      if (focusedWindow && (focusedWindow === settingsWin || webReader?.ownsWindow(focusedWindow))) return
      endPopupSettingsOpenGuard()
    },
    hasVisibleSettingsWindow: () => Boolean(
      settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible()
    ),
    bringToFrontToOwnWindow: (window) => {
      // 阅读器显式置前与设置页共用窗口级入口：普通窗口下必须 show()/focus()
      // 激活目标窗口自身，禁止调用 app.focus() 把同应用其它窗口一起带到最前。
      showOwnWindowForInteraction(window, { raiseLevel: true })
    },
    translate: async (text, sourceLang, targetLang) => {
      const settings = { ...getSettings(), sourceLang, targetLang }
      const dingTalkCredentials = settings.dingTalkEnabled
        ? getDingTalkConfiguration().getCredentialsSnapshot()
        : null
      const aiApiKey = settings.aiEnabled ? getAiConfiguration().getApiKey() : null
      const output = await translate(
        text,
        settings,
        dingTalkCredentials,
        aiApiKey
      )
      recordWebPageUsage(output.provider)
      return { translation: output.translation, provider: output.provider, channel: output.channel }
    }
  })
  if (isWindows7CompatibilityRuntime()) {
    // Win7 包不加载 electron-updater，只用 GitHub Release API 检查是否有新版 Win7 安装包。
    const { UpdateManager } = await import('./updateManager')
    const { Win7UpdateDriver } = await import('./win7UpdateDriver')
    updateManager = new UpdateManager({
      driver: new Win7UpdateDriver({
        currentVersion: app.getVersion(),
        fetch: translationFetch
      }),
      currentVersion: app.getVersion(),
      enabled: app.isPackaged,
      // manual 模式发现新版后由 UpdateManager 设置 updateAction: 'open-release'。
      installMode: 'manual',
      releaseUrl: 'https://github.com/zhq734/translation/releases/latest',
      isOnline: () => net.isOnline(),
      getTranslator: () => mainI18n?.translator ?? createTranslator('zh-CN'),
      openExternal: async (url) => {
        await shell.openExternal(url)
      },
      onStatusChanged: (status) => {
        broadcast('updater:status', status)
      }
    })
  } else {
    const { createApplicationUpdateManager } = await import('./updater')
    updateManager = await createApplicationUpdateManager(
      (status) => {
        broadcast('updater:status', status)
      },
      // electron-updater 的日志（含离线时的 ERR_INTERNET_DISCONNECTED）统一汇入
      // 主进程日志层，不再由 electron-updater 直接输出到 console 刷屏。
      // @author zhenghq
      { warn: (message) => appLogger.append('warn', [message], 'electron-updater') }
    )
  }
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
  createPopup({
    preloadPath: PRELOAD_PATH,
    onWindowShown: suppressSelectionActivationWindowGap,
    onPopupHidden: () => pronunciationRequests.cancelAll(),
    onPopupCloseStart: handlePopupCloseStart,
    onPopupCloseEnd: handlePopupCloseEnd
  })
  createSelectionButton(PRELOAD_PATH, suppressSelectionActivationWindowGap)
  registerGlobalShortcuts(getSettings())
  applySelectionListener()
  registerIpc()
  // 应用启动是明确的用户入口：设置页必须主动放到最前，不能被其它应用遮挡。
  // 该置前只通过统一窗口级入口影响设置窗口自身，不会拉起翻译弹窗等其它窗口。
  if (openSettingsOnInitialLaunch) await openSettings({ bringToFront: true })

  // 避免自动更新网络请求与应用首次启动初始化争用资源。
  setTimeout(() => void checkForApplicationUpdates(), UPDATE_CHECK_DELAY_MS)

  // 提前创建 Toast 窗口，避免首次复制/保存时临时创建窗口和加载页面造成提示延迟。
  getScreenshotToastWindow()
  // 启动后检测权限：若已开启始终自动翻译但未授权，主动引导。
  setTimeout(() => void warnIfNoAccessibility(), 1500)
  // 避免安装/升级通知网络请求与启动初始化争用资源；失败静默且不阻塞。
  setTimeout(() => void maybeSendInstallUpgradeNotification(), 1_500)
  prewarmScreenshotRuntime()
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
  shortcutRegistrationStates = collectShortcutRegistrationStates(settings, {
    unregisterAll: () => globalShortcut.unregisterAll(),
    register: (accelerator) => globalShortcut.register(accelerator, () => onGlobalShortcut(accelerator))
  })
  broadcast('shortcuts:registration-changed', shortcutRegistrationStates)
}

/**
 * 分发全局快捷键动作。
 * @param accelerator Electron 快捷键描述。
 * @returns 无返回值。
 * @author zhenghq
 */
function onGlobalShortcut(accelerator: string): void {
  const settings = getSettings()
  if (accelerator === settings.hotkey) {
    onHotkey()
  } else if (accelerator === settings.ocrHotkey) {
    onOcrHotkey()
  } else if (accelerator === settings.manualTranslationHotkey) {
    void openManualTranslation()
  } else if (accelerator === settings.webReaderHotkey) {
    openWebReaderFromShortcut()
  }
}

/**
 * 响应全局快捷键并翻译当前选中文字。
 * @returns 无返回值。
 * @author zhenghq
 */
function onHotkey(): void {
  latestSelectionGesture += 1
  markHotkeyTrigger()
  selectionCapture.markEntry('hotkey')
  invalidateSelectionFlowWithFocusCleanup()
  const interactionToken = selectionInteraction.beginTranslation()
  hideSelectionButton()
  // 快捷键取词与按钮取词一样：结果弹窗会以 show() 激活本应用，隐藏时必须把
  // 前台交还给用户触发快捷键时正在使用的应用。记录必须早于显示读取弹窗，
  // 否则弹窗已激活本应用，快照只能读到自身而失去精确交还目标。
  lastSelectionWindowContext = undefined
  selectionCapture.setWindowContext(undefined)
  const interactionSnapshot = selectionInteraction.snapshot()
  const windowSnapshotGestureId = latestSelectionGesture
  const windowSnapshotTask = rememberFrontmostWindowAtPoint(screen.getCursorScreenPoint())
  selectionWindowSnapshotTask = windowSnapshotTask
  selectionWindowSnapshotGestureId = windowSnapshotGestureId
  void windowSnapshotTask.then((recorded) => {
    if (windowSnapshotGestureId !== latestSelectionGesture) return
    const current = selectionInteraction.snapshot()
    if (!recorded ||
        current.state !== interactionSnapshot.state ||
        current.token !== interactionSnapshot.token) return
    lastSelectionWindowContext = {
      bundleId: recorded.snapshot.bundleId,
      pid: recorded.snapshot.pid,
      windowNumber: recorded.snapshot.windowNumber,
      bounds: recorded.snapshot.bounds,
      titleFingerprint: recorded.snapshot.titleFingerprint,
      windowLocate: recorded.snapshot.windowLocate,
      // 入口层若已执行精确交还，复制链路不得再次激活同一窗口。
      windowActivationSettled: false
    }
    selectionCapture.setWindowContext(lastSelectionWindowContext)
  })
  const popupCloseVersion = showSelectionReadingPopup()
  const captureDelay = resolveHotkeyCaptureDelay(process.platform)
  const hotkeyModifiers = resolveHotkeyModifiers(getSettings().hotkey, process.platform)
  if (process.platform === 'darwin') {
    setPendingMacOSCommandWasDown(hotkeyModifiers.includes('meta'))
  }
  // Windows 的全局快捷键在按键按下阶段回调，用户此时仍按住 Alt、Control 等修饰键，
  // 注入的复制快捷键会与这些残留修饰键叠加成其他组合而不触发复制，导致取词超时。
  // 先登记这些修饰键，模拟复制前会显式释放左右两侧按键。
  if (shouldReleaseHotkeyModifiersBeforeCopy(process.platform)) {
    setPendingCopyModifierRelease(hotkeyModifiers)
  }
  // 快捷键在 macOS 上无修饰键释放等待；若窗口枚举尚未完成就开始取词，
  // AX helper 会拿不到窗口编号。只等待有硬超时的窗口快照任务，不阻塞弹窗显示。
  if (captureDelay === 0 && process.platform === 'darwin') {
    void windowSnapshotTask.then(() => {
      if (!selectionInteraction.isCurrent(interactionToken)) return
      if (popupCloseVersion !== getPopupCloseVersion()) return
      selectionCapture.setWindowContext(lastSelectionWindowContext)
      void queueSelectionTranslation(undefined, interactionToken, false, popupCloseVersion)
    })
    return
  }
  if (captureDelay > 0) {
    // Windows 先非激活显示读取弹窗，再等待快捷键修饰键释放并直接发送 Ctrl+C 取词。
    setTimeout(
      () => {
        // 等待修饰键释放期间，用户可能复制/粘贴、切换触发模式或开始新一轮划词。
        // 旧定时器必须先确认本次交互仍持有所有权，再启动取词；否则会绕过
        // queueSelectionTranslation() 的延迟 token 校验，干扰新的取词流程。
        if (!selectionInteraction.isCurrent(interactionToken)) return
        void queueSelectionTranslation(undefined, interactionToken, true, popupCloseVersion)
      },
      captureDelay
    )
    return
  }
  void queueSelectionTranslation(undefined, interactionToken, false, popupCloseVersion)
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
 * 收集当前自有窗口候选，供应用级门禁与矩形排除共同判定。
 * 只统计承载用户交互的普通窗口；翻译弹窗与“译”按钮有各自的命中判定，
 * 需要保留原有的点击消费与选区失效行为，不能并入这里统一忽略。
 * @returns 设置页与网页阅读器的候选信息。
 * @author zhenghq
 */
function collectOwnWindowCandidates(): OwnWindowCandidate[] {
  const settingsFocused = Boolean(
    settingsWin &&
    !settingsWin.isDestroyed() &&
    settingsWin.isVisible() &&
    settingsWin.isFocused()
  )
  const settingsBounds = settingsFocused && settingsWin ? settingsWin.getBounds() : null
  const webReaderFocused = Boolean(webReader?.isWindowFocused())
  return [
    { name: 'settings', focused: settingsFocused, bounds: settingsBounds },
    {
      name: 'webReader',
      focused: webReaderFocused,
      bounds: webReaderFocused ? (webReader?.getVisibleBounds() ?? null) : null
    }
  ]
}

/**
 * 解析当前可用于排除划词的自有窗口与应用级门禁状态。
 *
 * 全局钩子无法区分事件来源，设置窗口、网页阅读器等窗口内的点击与拖动
 * 若不排除会被误判为跨应用划词，进而反复触发取词并打断真正的划词流程。
 * 但必须先做应用级门禁：macOS 在应用失活后仍可能让 key window 保持 `isFocused() === true`，
 * 此时后台窗口的整块矩形会吞掉用户在其他应用里的划词起点，表现为划词完全无响应。
 * @returns 应用级门禁状态与通过门禁的自有窗口列表。
 * @author zhenghq
 */
function resolveOwnWindowExclusionState(): {
  appFrontmost: boolean
  windows: readonly OwnWindowCandidate[]
} {
  const appFrontmost = resolveAppFrontmostForExclusion(process.platform, isMacAppActiveByEvents())
  return { appFrontmost, windows: resolveOwnWindowExclusion(appFrontmost, collectOwnWindowCandidates()) }
}

/**
 * 收集当前可排除划词的自有窗口矩形。
 * @returns 允许按矩形排除划词的自有窗口边界列表。
 * @author zhenghq
 */
function getFocusedOwnWindowBounds(): ScreenBounds[] {
  return resolveOwnWindowExclusionState()
    .windows
    .map((candidate) => candidate.bounds)
    .filter((bounds): bounds is ScreenBounds => bounds !== null)
}

/**
 * 判断屏幕坐标是否位于当前持有焦点的应用自有窗口内部。
 * @param point 待判断的屏幕坐标。
 * @returns 坐标位于持有焦点的自有窗口内部时返回 true。
 * @author zhenghq
 */
function isPointInsideFocusedOwnWindow(point: { x: number; y: number }): boolean {
  return findOwnWindowHit(point, resolveOwnWindowExclusionState().windows) !== null
}

/**
 * 判断屏幕坐标是否落在当前可见的设置窗口内部。
 *
 * 该判定不依赖窗口焦点：设置窗口的 focus 事件可能晚于全局 mousedown 到达，
 * 此时 `isFocused()` 仍为 false，但点击确实发生在应用内部，不能按弹窗外部点击
 * 处理。调用方必须同时确认处于设置打开保护期；保护期会在设置窗口失焦、隐藏或
 * 销毁时解除，因此后台设置窗口不会长期吞掉其它应用里的真实点击。
 * @param point 待判断的屏幕坐标。
 * @returns 坐标位于可见设置窗口内部时返回 true。
 * @author zhenghq
 */
function isPointInsideVisibleSettingsWindow(point: { x: number; y: number }): boolean {
  if (!settingsWin || settingsWin.isDestroyed() || !settingsWin.isVisible()) return false
  return isPointInsideBounds(point, settingsWin.getBounds())
}

/**
 * 判断屏幕坐标是否落在当前可见的网页阅读器窗口内部。
 *
 * 阅读器的 focus 事件可能晚于全局 mousedown 到达，此时 `isFocused()` 仍为 false，
 * 但点击确实发生在应用内部，不能按翻译弹窗外部点击处理。否则弹窗的关闭收尾
 * 可能走前台交还退化路径，把刚打开的阅读器一起隐藏。
 * @param point 待判断的屏幕坐标。
 * @returns 坐标位于可见网页阅读器窗口内部时返回 true。
 * @author zhenghq
 */
function isPointInsideVisibleWebReaderWindow(point: { x: number; y: number }): boolean {
  const bounds = webReader?.getVisibleBounds()
  return bounds !== null && bounds !== undefined && isPointInsideBounds(point, bounds)
}

/**
 * 描述自有窗口命中详情，定位划词被内部窗口矩形静默吞掉的具体来源。
 * 仅矩形判定无法区分是设置页还是网页阅读器，也无法确认应用是否真的在最前，
 * 因此日志需要同时给出窗口名、边界与应用激活状态。
 * @param point 待判断的屏幕坐标。
 * @returns 命中描述；未命中任何自有窗口时返回 null。
 * @author zhenghq
 */
function describeFocusedOwnWindowHit(point: { x: number; y: number }): string | null {
  const state = resolveOwnWindowExclusionState()
  const hit = findOwnWindowHit(point, state.windows)
  if (!hit?.bounds) return null
  const { bounds } = hit
  return `${hit.name} bounds=${bounds.x},${bounds.y},${bounds.width}x${bounds.height} appActive=${state.appFrontmost}`
}

/**
 * 描述被应用级门禁抑制掉的自有窗口命中。
 *
 * 应用失活时若仍命中自有窗口矩形，说明修复前这里会把外部划词起点吞掉；
 * 该日志只在异常状态出现时打印，用于实机确认门禁确实拦截了误判。
 * @param point 待判断的屏幕坐标。
 * @returns 抑制描述；未发生抑制时返回 null。
 * @author zhenghq
 */
function describeSuppressedOwnWindowHit(point: { x: number; y: number }): string | null {
  // 先做最廉价的布尔判断，应用在最前时（绝大多数点击）直接返回，避免热路径上的多余窗口查询。
  if (resolveAppFrontmostForExclusion(process.platform, isMacAppActiveByEvents())) return null
  const suppressed = findOwnWindowHit(point, resolveOwnWindowExclusion(true, collectOwnWindowCandidates()))
  if (!suppressed?.bounds) return null
  const { bounds } = suppressed
  return `${suppressed.name} bounds=${bounds.x},${bounds.y},${bounds.width}x${bounds.height}`
}

/**
 * 安排一次选区处理动作；按钮模式显示图标，支持快速预取的平台后台只读取词。
 * @param anchor 选区按钮或翻译弹窗使用的屏幕锚点。
 * @returns 无返回值。
 * @author zhenghq
 */
function scheduleSelectionAction(anchor: { x: number; y: number }): void {
  // 划词属于内部交互：先续期 activate 抑制租约并回收设置页临时置顶层级，
  // 避免鼠标抬起后的内部 activate 或残留 screen-saver 层级把设置页顶到最前。
  suppressSelectionActivationWindowGap()
  lowerSettingsPanelRaiseLevel()
  const gestureId = ++latestSelectionGesture
  invalidateSelectionFlowWithFocusCleanup()
  selectionCapture.invalidate()
  hideSelectionButton()
  lastSelectionAnchor = anchor
  const action = decideSelectionAction(isPopupVisible(), getSettings().triggerMode)
  if (action === 'ignore') return

  // 记录本次划词时用户正在使用的源应用与源窗口：结果弹窗在 macOS 上会以
  // show() 激活本应用，隐藏时必须把前台交还给这个应用/窗口，否则下一次取词的
  // Command+C 会打在本应用或微信错误窗口上而超时。必须在显示“译”按钮 /
  // 读取弹窗之前读取，此时本应用尚未抢占前台，读到的才是真实源窗口。
  lastSelectionWindowContext = undefined
  selectionCapture.setWindowContext(undefined)
  const windowSnapshotTask = rememberFrontmostWindowAtPoint(anchor)
  selectionWindowSnapshotTask = windowSnapshotTask
  selectionWindowSnapshotGestureId = gestureId
  void windowSnapshotTask.then((recorded) => {
    if (!recorded || gestureId !== latestSelectionGesture) return
    lastSelectionWindowContext = {
      bundleId: recorded.snapshot.bundleId,
      pid: recorded.snapshot.pid,
      windowNumber: recorded.snapshot.windowNumber,
      bounds: recorded.snapshot.bounds,
      titleFingerprint: recorded.snapshot.titleFingerprint,
      windowLocate: recorded.snapshot.windowLocate,
      // 入口层若已执行精确交还，复制链路不得再次激活同一窗口。
      windowActivationSettled: false
    }
    selectionCapture.setWindowContext(lastSelectionWindowContext)
    // 按钮预取会锁定启动时的窗口上下文，必须等快照写入后再开始，否则首轮
    // AX helper 与复制前激活都只能拿到应用级信息，微信多窗口仍会读错窗口。
    if (action === 'show-button' && shouldPrefetchSelectionForButton(process.platform)) {
      void selectionCapture.prepare(anchor)
    }
  })

  if (action === 'show-button') {
    selectionInteraction.showButton()
    showSelectionButton(anchor)
    return
  }

  selectionCapture.markEntry('auto')
  const interactionToken = selectionInteraction.beginTranslation()
  setTimeout(() => {
    if (gestureId !== latestSelectionGesture || !selectionInteraction.isCurrent(interactionToken)) return
    void queueSelectionTranslation(anchor, interactionToken)
  }, SELECTION_SETTLE_DELAY_MS)
}

/**
 * 响应一次全局划词动作，决定显示图标还是直接自动翻译。
 * 双击与拖拽都只是手势来源，按钮模式下统一走 scheduleSelectionAction：
 * 立即显示“译”按钮并后台只读预取，点击时预取命中即用、未命中再走复制兜底。
 * 这样 IDEA 等不通过 Accessibility 暴露选区文本的自绘应用也能正常双击取词。
 * @param gesture 划词拖拽及选区锚点信息。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleSelectionGesture(gesture: SelectionGesture): void {
  const ocrActive = selectionInteraction.snapshot().state === 'ocr-selecting' || isOcrSelectionVisible()
  const focusedOwnWindow = isSelectionGestureInsideOwnWindows(gesture, getFocusedOwnWindowBounds())
  const popupHit = isPointInsidePopup(gesture.start) || isPointInsidePopup(gesture.end)
  const buttonHit =
    isPointInsideSelectionButton(gesture.start) || isPointInsideSelectionButton(gesture.end)
  if (ocrActive || focusedOwnWindow || popupHit || buttonHit) {
    const reasons: string[] = []
    if (ocrActive) reasons.push('ocr')
    if (focusedOwnWindow) reasons.push('focused-own-window')
    if (popupHit) reasons.push('popup')
    if (buttonHit) reasons.push('selection-button')
    console.log(
      `[selection] 忽略划词手势 reasons=${reasons.join(',')} startX=${Math.round(gesture.start.x)} startY=${Math.round(gesture.start.y)} endX=${Math.round(gesture.end.x)} endY=${Math.round(gesture.end.y)}`
    )
    return
  }

  const settings = getSettings()
  if (gesture.clicks >= 2 && settings.triggerMode === 'button') {
    if (!settings.doubleClickSelectionButtonEnabled) return
  }

  scheduleSelectionAction(gesture.anchor)
}

/**
 * 响应全局鼠标按下事件，在“译”按钮被按下时立即捕获选中文字，避免源应用先清除选区。
 * 其他位置的鼠标按下会使已失效的选区缓存和“译”按钮立即消失。
 * @param point 鼠标按下时的屏幕坐标。
 * @returns 外部应用返回 track，自有窗口返回 ignore，按钮或 OCR 返回 consume。
 * @author zhenghq
 */
function handleSelectionPointerDown(point: { x: number; y: number }, button = 1): PointerDownResult {
  // 非左键（右键/中键/侧键）只允许隐藏按钮与取消选区，绝不能当作点击“译”按钮：
  // 否则右键点在按钮上会直接注入复制快捷键并弹出翻译。
  const primaryButton = button === 1
  const ocrActive = selectionInteraction.snapshot().state === 'ocr-selecting' || isOcrSelectionVisible()
  const selectionButtonHit = isPointInsideSelectionButton(point)
  const popupHit = isPointInsidePopup(point)
  // 第二次从翻译弹窗点击“设置/翻译页面”时，设置页或阅读器窗口可能已经
  // 可见并与弹窗坐标区域重叠。全局 mousedown 会先于按钮 IPC 到达；若继续
  // 进入分类或内部窗口兜底，弹窗可能被提前隐藏，后续 IPC 失去宿主窗口，
  // 表现为第二次点击直接关闭。弹窗自身命中必须在分类前短路。
  if (popupHit && primaryButton) return 'ignore'
  // 设置窗口的 focus 事件可能晚于全局 mousedown 到达，此时 isFocused() 仍为 false，
  // 点击设置页会被误分类为弹窗外部点击并关闭翻译弹窗。处于设置打开保护期时，
  // 直接按可见矩形把这次按下识别为应用内点击。这里不能叠加应用激活事件门禁：
  // macOS 的 did-become-active 可能晚于全局 mousedown，设置窗口已经获得焦点时
  // 事件状态仍为 false，会把点击设置页误判为外部点击并触发 hidePopup 交还前台。
  // 保护期由设置窗口失焦/隐藏/销毁解除，因此后台设置窗口不会长期吞掉其它应用点击。
  const settingsWindowHit = isPopupSettingsOpenGuardActive() &&
    isPointInsideVisibleSettingsWindow(point)
  const focusedOwnWindowHit = settingsWindowHit || isPointInsideFocusedOwnWindow(point)
  const result = classifySelectionPointerDown({
    ocrActive,
    selectionButtonHit,
    popupHit,
    // 翻译弹窗内部的拖动也属于应用内交互，按下阶段直接忽略，
    // 避免 mouseup 时再被拼成一次跨应用划词。
    focusedOwnWindowHit
  })
  // 外部应用的正常按下是绝对多数，不逐条记录；只有按 track 继续跟踪、
  // 却落在已失活自有窗口矩形内的场景需要留痕，用于实机确认门禁生效。
  if (result === 'track') {
    // 点击可见设置页属于应用内交互，不是弹窗外部点击。全局按下必须直接忽略，
    // 不得调用任何 hidePopup 入口：弹窗是否需要关闭由设置页打开流程的显式语义决定。
    if (isPopupVisible() && isPointInsideVisibleSettingsWindow(point)) {
      return 'ignore'
    }
    // 网页阅读器与设置页同属应用内部窗口，命中可见阅读器时同样只忽略本次按下，
    // 不得继续走外部点击关闭兜底，否则阅读器会被一起隐藏。
    if (isPopupVisible() && isPointInsideVisibleWebReaderWindow(point)) {
      return 'ignore'
    }
    // 弹窗已经失去 key window 时，用户点击外部不会再产生 blur，弹窗会一直
    // 留在屏上且前台不归还。这里在全局按下阶段兜底关闭，保证归还流程一定执行。
    dismissPopupOnExternalPointerDown(point)
    // 应用失活却落在自有窗口矩形内，正是修复前划词被静默吞掉的场景；
    // 这里按 track 继续跟踪说明门禁生效，记录一行便于实机确认。
    const suppressedDetail = describeSuppressedOwnWindowHit(point)
    if (suppressedDetail) {
      console.log(
        `[selection] pointerdown 应用失活，已抑制自有窗口矩形排除 hit=${suppressedDetail} x=${Math.round(point.x)} y=${Math.round(point.y)}`
      )
    }
  }
  if (result === 'consume' && selectionButtonHit && primaryButton) {
    void translateSelectionButton()
  }
  // 非左键不参与“点击按钮”语义，但必须继续走下面的隐藏/取消逻辑，
  if (result === 'consume' && primaryButton) return result
  // OCR 框选进行中的非左键（常见于“右键取消”手势）只丢弃本次框选，不得清空
  // 已经预取好的选区缓存，否则随后的点击“译”按钮只能退回复制兜底。
  if (result === 'consume' && ocrActive && !selectionButtonHit) return result
  // 焦点在设置窗口等自有窗口内时的点击属于应用内交互，不参与跨应用取词，
  // 也不应清空当前已捕获的选区缓存，否则设置页操作会让划词结果丢失。
  if (result === 'ignore' && primaryButton) return result
  latestSelectionGesture += 1
  invalidateSelectionFlowWithFocusCleanup()
  selectionCapture.invalidate()
  hideSelectionButton()
  return primaryButton ? 'track' : 'ignore'
}

/**
 * 响应用户复制快捷键，立即取消待处理或正在进行的自动取词，避免覆盖用户剪贴板。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleCopyShortcut(): void {
  latestSelectionGesture += 1
  invalidateSelectionFlowWithFocusCleanup()
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
  invalidateSelectionFlowWithFocusCleanup()
  selectionCapture.invalidate()
  hideSelectionButton()
}

/**
 * 非激活显示选区读取状态，使源应用继续保持焦点以便随后复制取词。
 * @param anchor 弹窗定位锚点；省略时使用当前鼠标位置。
 * @returns 显示读取状态时的弹窗关闭版本号，用于阻止关闭后的异步结果重新打开弹窗。
 * @author zhenghq
 */
function showSelectionReadingPopup(anchor?: { x: number; y: number }): number {
  const settings = getSettings()
  // 显示读取弹窗之前，若旧弹窗已经激活，先让出前台焦点，避免弹窗保持最前。
  // Windows 需要把前台焦点交还源窗口；macOS 需要让 panel 退出 key window。
  // Linux 无复制兜底，不干预焦点。
  const popupHoldingKeyWindow = process.platform === 'darwin'
    ? isPopupHoldingKeyWindow()
    : isPopupActivated()
  if (shouldRestoreForegroundBeforeCapture(process.platform, popupHoldingKeyWindow)) {
    deactivatePopupForCapture()
  }
  // 以非激活方式显示读取状态弹窗。弹窗已可见且已被激活（上次翻译结果调用了
  // win.show()）时，showPopup 的降级分支会调用 win.showInactive() 归还前台焦点
  // 给源应用；弹窗未激活时仅更新内容。两种情况都不关闭弹窗。
  const popupCloseVersion = getPopupCloseVersion()
  showPopup(
    {
      ok: true,
      origin: 'selection',
      loading: true,
      loadingMessage: t('selection.loadingReading'),
      sourcePreference: settings.sourceLang,
      targetPreference: settings.targetLang,
      targetLang: settings.targetLang
    },
    0,
    anchor,
    false
  )
  // showPopup(activate=false) 之后 panel 仍可能成为 key window：shownInactive
  // 记账标志只代表调用方式，不能证明焦点已经交还。必须在显示完成后按真实焦点
  // 状态再确认一次，确保随后注入的 Command+C 落到源应用而不是自有弹窗。
  // 该时序空窗仅存在于 macOS nonactivating panel，Windows 保持既有行为不变。
  if (process.platform === 'darwin' && isPopupHoldingKeyWindow()) {
    deactivatePopupForCapture()
  }
  return popupCloseVersion
}

/**
 * 捕获当前选中文字，并在取词完成后执行翻译。
 * @param anchor 本次选区右上角锚点。
 * @param interactionToken 已经取得所有权的交互 token；省略时创建新的翻译流程。
 * @param directCapture 是否跳过原生直读并直接执行复制取词。
 * @param popupCloseVersion 读取弹窗显示时的关闭版本；变化后丢弃异步结果。
 * @returns 取词与翻译流程安排完成后的 Promise。
 * @author zhenghq
 */
async function queueSelectionTranslation(
  anchor?: { x: number; y: number },
  interactionToken?: number,
  directCapture = false,
  popupCloseVersion?: number
): Promise<void> {
  if (selectionInteraction.snapshot().state === 'ocr-selecting') return
  if (popupCloseVersion !== undefined &&
      popupCloseVersion !== getPopupCloseVersion()) return
  const token = interactionToken ?? selectionInteraction.beginTranslation()
  // 按钮/自动入口可能在窗口快照尚未完成时启动：有界等待最新任务，并把快照
  // 重新写入协调器。协调器会在 enqueue 时复制上下文，晚到的异步写入不能
  // 自动修复已排队请求，因此必须在 capture 前完成同步。
  if (selectionWindowSnapshotGestureId === latestSelectionGesture) {
    await waitForSelectionWindowSnapshot(selectionWindowSnapshotTask)
  }
  selectionCapture.setWindowContext(lastSelectionWindowContext)
  // 自动模式取词不经过 showSelectionReadingPopup()：上一个常驻翻译弹窗、设置页
  // 或网页阅读器等任意自有窗口都可能仍持有 macOS key window，此时注入的
  // Command+C 会打在自家窗口而不是源应用，导致剪贴板哨兵不变并报取词超时。
  // 共用取词入口在启动 capture（注入复制键）之前按真实 key window 归属再交还
  // 一次；Windows / Linux 既有行为保持不变。
  if (process.platform === 'darwin' && isOwnWindowHoldingKeyWindow()) {
    // 弹窗持有 key window 时先走弹窗专用失活，同时覆盖设置页等普通自有窗口。
    if (isPopupHoldingKeyWindow()) deactivatePopupForCapture()
    const handedBack = await handBackKeyWindowToFrontmostApp()
    if (handedBack && lastSelectionWindowContext) {
      // 入口层已经完成源窗口激活；同一轮复制兜底不得再次切换微信窗口。
      lastSelectionWindowContext = {
        ...lastSelectionWindowContext,
        windowActivationSettled: true
      }
      selectionCapture.setWindowContext(lastSelectionWindowContext)
    }
    // key window 交还是异步生效的：等待系统把焦点真正还给源应用后再启动取词，
    // 避免复制键仍落在自有弹窗上。等待期间交互可能被取消或关闭，必须复核后再继续。
    await waitFor(POPUP_FOREGROUND_RESTORE_SETTLE_MS)
    if (!selectionInteraction.isCurrent(token)) return
    if (popupCloseVersion !== undefined &&
        popupCloseVersion !== getPopupCloseVersion()) {
      // 等待期间弹窗被关闭：本次取词已失效，按既有取消语义释放交互 token，
      // 避免读取弹窗已关闭却仍残留 capturing 状态。
      releaseSelectionInteraction(token)
      return
    }
  }
  const capture = directCapture
    ? selectionCapture.captureDirect(anchor)
    : selectionCapture.capture(anchor)
  void capture.then((result) => {
    if (!selectionInteraction.isCurrent(token)) return
    if (popupCloseVersion !== undefined &&
        popupCloseVersion !== getPopupCloseVersion()) {
      releaseSelectionInteraction(token)
      return
    }
    if (result) {
      handleSelectionCaptureResult(result, token)
      return
    }
    // 取词被取消或覆盖时结果为 null：读取状态弹窗没有后续结果可以收尾，
    // 若不在这里显式关闭，它会一直留在屏上且前台不归还，后续划词的“译”按钮
    // 会被应用级状态吞掉（与外部点击漏关是同一类残留）。
    hidePopup(true, 'stale-token')
    releaseSelectionInteraction(token)
  })
}

/**
 * 响应“译”按钮点击，随后才向当前前台应用发送一次复制快捷键并开始翻译。
 * @returns 翻译触发流程完成后的 Promise。
 * @author zhenghq
 */
async function translateSelectionButton(): Promise<void> {
  if (!isSelectionButtonVisible()) return
  // 按钮点击的全局按下可能被钩子重放 / 延迟派发：第一次事件已隐藏按钮并显示
  // 读取弹窗，迟到事件分类时按钮不可见，会被当成外部点击关闭弹窗。必须在隐藏
  // 按钮和显示弹窗前开启很短的抑制窗口，只吞掉同一次点击的迟到按下。
  // 记录按钮点击坐标：只抑制落在按钮原位置附近的迟到 / 重放按下，
  // 用户在其它位置的真实点击仍会立即关闭弹窗。
  suppressExternalPointerDismissForButtonClick(screen.getCursorScreenPoint())
  setPendingMacOSCommandWasDown(false)
  // 点击“译”按钮同样属于划词内部流程，续期租约覆盖弹窗显隐带来的 activate。
  suppressSelectionActivationWindowGap()
  selectionCapture.markEntry('button')
  const interactionToken = selectionInteraction.beginButtonCapture()
  if (interactionToken === null) return
  const anchor = lastSelectionAnchor
  // 快速点击按钮时窗口快照可能仍在读取；等待任务按自身硬超时结束，随后复用
  // 已记录的窗口上下文，确保 AX 直读与复制前窗口激活使用同一目标窗口。
  await waitForSelectionWindowSnapshot(selectionWindowSnapshotTask)
  selectionCapture.setWindowContext(lastSelectionWindowContext)
  latestSelectionGesture += 1
  hideSelectionButton()
  const popupWasActivated = shouldRestoreForegroundBeforeCapture(
    process.platform,
    process.platform === 'darwin' ? isPopupHoldingKeyWindow() : isPopupActivated()
  )
  try {
    const popupCloseVersion = showSelectionReadingPopup(anchor)
    // 弹窗刚从前台失活时，Windows 需要几十毫秒才把焦点交回源应用；
    // 不等待就注入复制键会打在旧焦点上，导致剪贴板哨兵不变而报取词超时。
    if (popupWasActivated) {
      await waitFor(POPUP_FOREGROUND_RESTORE_SETTLE_MS)
      if (!selectionInteraction.isCurrent(interactionToken) ||
          popupCloseVersion !== getPopupCloseVersion()) return
    }
    // macOS 的 key window 切换是异步的：showInactive() 返回时 panel 可能仍短暂
    // 持有焦点；设置页、网页阅读器等任意自有窗口也可能持有 key window。等待窗口
    // 结束后按真实 key window 归属复核一次，确保注入 Command+C 前焦点已经真正
    // 回到源应用，而不是打在自家窗口上。
    if (process.platform === 'darwin' && isOwnWindowHoldingKeyWindow()) {
      if (isPopupHoldingKeyWindow()) deactivatePopupForCapture()
      const handedBack = await handBackKeyWindowToFrontmostApp()
      if (handedBack && lastSelectionWindowContext) {
        // 入口层已经激活过源窗口；把结果写回上下文，复制兜底不得再次激活。
        lastSelectionWindowContext = {
          ...lastSelectionWindowContext,
          windowActivationSettled: true
        }
        selectionCapture.setWindowContext(lastSelectionWindowContext)
      }
      await waitFor(POPUP_FOREGROUND_RESTORE_SETTLE_MS)
      if (!selectionInteraction.isCurrent(interactionToken) ||
          popupCloseVersion !== getPopupCloseVersion()) return
    }
    // 先在很短的有界窗口内消费只读预取：已完成的缓存立即命中，尚未完成的预取最多再等
    // PREPARED_PREFETCH_WAIT_MS，避免快速点击时丢弃即将产出的原生取词结果。
    // 窗口到期仍无文本时才取消预取并走按钮专用取词，绝不无界等待 AX/UIA 直读。
    const consumption = await selectionCapture.consumePreparedBounded()
    console.log(
      `[capture] button-prefetch status=${consumption.status} waitedMs=${consumption.waitedMs}`
    )
    if (!selectionInteraction.isCurrent(interactionToken) ||
        popupCloseVersion !== getPopupCloseVersion()) return
    const result = consumption.result ?? await selectionCapture.captureFromButton(anchor)
    if (!selectionInteraction.isCurrent(interactionToken) ||
        popupCloseVersion !== getPopupCloseVersion()) return
    selectionCapture.invalidate()
    if (result) handleSelectionCaptureResult(result, interactionToken, true)
    else hidePopup(true, 'capture-null')
  } finally {
    if (selectionInteraction.isCurrent(interactionToken) &&
        selectionInteraction.snapshot().state === 'capturing') {
      releaseSelectionInteraction(interactionToken)
    }
  }
}

/**
 * 处理取词结果，统一展示权限错误、空选区提示或启动翻译。
 * @param result 选中文字捕获结果。
 * @param interactionToken 当前取词流程 token；省略时仅处理结果而不管理交互状态。
 * @param trackMacCopyTimeout 是否追踪 macOS 按钮复制兜底的连续超时。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleSelectionCaptureResult(
  result: SelectionCaptureResult,
  interactionToken?: number,
  trackMacCopyTimeout = false
): void {
  const shouldAutoRepairHiServices = trackMacCopyTimeout && recordCaptureOutcome(result)
  if (result.error) {
    handleTranslateError(result.error, getSettings(), result.anchor)
    if (interactionToken !== undefined) releaseSelectionInteraction(interactionToken)
    return
  }
  if (!result.text) {
    const settings = getSettings()
    // macOS 不能激活本应用：失败提示自动隐藏时会把设置页提升为 key window 顶到最前。
    showPopup(
      {
        ok: false,
        error: resolveSelectionCaptureFailureMessage(
          result.reason,
          result.hasImage,
          mainI18n?.translator
        ),
        sourcePreference: settings.sourceLang,
        targetPreference: settings.targetLang,
        targetLang: settings.targetLang
      },
      2000,
      result.anchor,
      shouldActivatePopupForCaptureFailure(process.platform)
    )
    if (interactionToken !== undefined) releaseSelectionInteraction(interactionToken)
    if (shouldAutoRepairHiServices) void autoRepairMacHiServices()
    return
  }

  if (interactionToken !== undefined) {
    selectionInteraction.transition(interactionToken, 'translating')
  }
  void translateText(result.text, result.anchor, undefined, 'selection', interactionToken)
}

/**
 * 翻译指定文本，并使用请求序号和关闭版本阻止旧结果覆盖新结果或重新打开已关闭弹窗。
 * @param text 待翻译文本。
 * @param anchor 首次展示弹窗时使用的选区锚点。
 * @param preferences 可选的语言偏好。
 * @param origin 翻译来源。
 * @param interactionToken 当前选区交互 token；省略时不释放选区交互状态。
 * @returns 翻译流程完成后的 Promise。
 * @author zhenghq
 */
async function translateText(
  text: string,
  anchor?: { x: number; y: number },
  preferences?: { sourceLang: string; targetLang: string },
  origin: TranslationOrigin = 'selection',
  interactionToken?: number
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
    anchor,
    // 选区取词刚通过 open -b 交还前台，加载态若立即 win.show() 会与交还动作
    // 竞争并产生迟到的 blur；等最终翻译结果到达后再激活，避免弹窗一闪即关。
    origin !== 'selection'
  )

  try {
    const dingTalkCredentials = settings.dingTalkEnabled
      ? getDingTalkConfiguration().getCredentialsSnapshot()
      : null
    const aiApiKey = settings.aiEnabled ? getAiConfiguration().getApiKey() : null
    let deltaSequence = 0
    const output = await translateStream(
      text,
      requestSettings,
      dingTalkCredentials,
      aiApiKey,
      {
        onDelta: (delta) => {
          if (requestId !== latestTranslationRequest || closeVersion !== getPopupCloseVersion()) return
          const payload: TranslateDeltaPayload = {
            origin,
            requestId,
            delta,
            sequence: deltaSequence,
            final: false
          }
          deltaSequence += 1
          sendPopupDelta(payload)
        }
      }
    )
    if (requestId !== latestTranslationRequest || closeVersion !== getPopupCloseVersion()) return
    recordTranslationUsage(origin, output.provider)
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
  } finally {
    if (interactionToken !== undefined) releaseSelectionInteraction(interactionToken)
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
        error: t('error.accessibilityPermission'),
        ...common
      },
      8000,
      anchor
    )
    openAccessibilitySettings()
  } else {
    showPopup(
      { ok: false, error: err.message || t('error.translationFailed'), ...common },
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
async function openManualTranslation(): Promise<void> {
  // 托盘入口触发时本应用未必已在前台：弹窗 show() 会激活应用，
  // 若没有源应用记录，关闭弹窗时系统会把设置页提升为 key window 顶到最前。
  await rememberFrontmostAppIfInactiveAsync()
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
    // 创建时就铺满全部显示器：Electron 默认以 800×600 创建窗口，若等到显示前才
    // setBounds 撑到全屏，Windows 会把这次尺寸变化渲染成「由小放大」的动作，
    // 空快照画布合成出的黑块也随之放大闪过。创建即全屏后窗口从第一帧就是最终尺寸。
    ...getOcrSelectionWindowBounds(),
    show: false,
    frame: false,
    transparent: true,
    // 透明窗口必须显式声明全透明原生背景色：Windows 上未声明时首帧会按默认
    // 背景色合成，用户看到的就是窗口上屏瞬间整屏闪一下大黑框。与翻译弹窗保持同一约定。
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    // macOS 上普通无边框窗口会被系统钳制在菜单栏下方：setBounds 传入 y = 0 时实际会被抬到
    // workArea.y（本机为 33），窗口永远盖不住菜单栏。开启该选项后才能让覆盖窗口真正对齐
    // display.bounds 的 (0, 0)，这也是替代 setSimpleFullScreen 的关键——简单全屏会切换应用
    // 呈现模式并让系统隐藏菜单栏与 Dock 栏，采集到的快照本身就缺失这两个区域。
    // 该选项仅 macOS 生效，其它平台会被忽略。
    enableLargerThanScreen: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  ocrSelectionWin.setAlwaysOnTop(true, 'screen-saver')
  ocrSelectionWin.setVisibleOnAllWorkspaces(true, ALL_WORKSPACES_VISIBILITY_OPTIONS)
  // 覆盖层可能被隐藏、关闭等旁路收尾（含异常路径），这里兜底恢复全局划词监听，
  // 避免钩子停在暂停状态导致划词与双击不再显示“译”按钮；恢复函数自身幂等。
  //
  // 注意 hide 与 closed 的语义差异：hide 只代表窗口暂时不可见，截图会话可能仍在进行
  // （翻译流程正是先隐藏覆盖窗口、再裁剪快照），因此 hide MUST NOT 释放当前会话快照，
  // 否则 Windows 上同步派发的 hide 事件会让紧随其后的裁剪取不到图，报「截图已失效」。
  // 快照的释放只属于 closed、取消、完成、新会话与采集失败等真正的会话终止点。
  ocrSelectionWin.on('hide', () => {
    handleOcrSelectionWindowHide({
      resolveReady: resolveOcrSelectionReady,
      clearActiveRequests: () => activeScreenshotOcrRequests.clear(),
      restoreSelectionListener: restoreSelectionListenerAfterOcr
    })
  })
  ocrSelectionWin.on('closed', () => {
    ocrSelectionWin = null
    handleOcrSelectionWindowClosed({
      resolveReady: resolveOcrSelectionReady,
      clearActiveRequests: () => activeScreenshotOcrRequests.clear(),
      releaseSnapshot: () => {
        latestOcrSnapshot = null
        ocrSessionResultCache.clear()
      },
      restoreSelectionListener: restoreSelectionListenerAfterOcr
    })
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
 * 等待 Renderer 完成当前截图会话的 UI 清理确认。
 * @param win OCR 框选窗口。
 * @param sessionId 当前截图会话序号。
 * @returns 收到匹配确认且窗口仍可用时返回 true，超时或窗口关闭时返回 false。
 * @author zhenghq
 */
function waitForOcrSelectionReady(win: BrowserWindow, sessionId: number): Promise<boolean> {
  if (pendingOcrSelectionReady) resolveOcrSelectionReady(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingOcrSelectionReady?.sessionId === sessionId) pendingOcrSelectionReady = null
      resolve(false)
    }, 1000)
    pendingOcrSelectionReady = { sessionId, resolve, timer }
    if (win.isDestroyed()) resolveOcrSelectionReady(false)
  })
}

/**
 * 结束当前 Renderer 会话确认等待，避免窗口关闭或新会话开始时悬挂。
 * @param ready 是否已完成会话清理。
 * @returns 无返回值。
 * @author zhenghq
 */
function resolveOcrSelectionReady(ready: boolean): void {
  const pending = pendingOcrSelectionReady
  if (!pending) return
  pendingOcrSelectionReady = null
  clearTimeout(pending.timer)
  pending.resolve(ready)
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
 * 等待 OCR 覆盖窗口完成首屏加载，避免空白透明窗口先显示造成遮罩闪烁。
 * @param win OCR 覆盖窗口。
 * @returns 页面 ready 后完成的 Promise。
 * @author zhenghq
 */
function whenOcrSelectionWindowReady(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return Promise.reject(new Error('ocr-overlay-destroyed'))
  if (!win.webContents.isLoading()) return Promise.resolve()
  const existing = ocrSelectionWindowReadyPromises.get(win)
  if (existing) return existing

  const ready = new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      win.webContents.removeListener('did-finish-load', onFinish)
      win.webContents.removeListener('did-fail-load', onFail)
      win.removeListener('closed', onClosed)
      ocrSelectionWindowReadyPromises.delete(win)
    }
    const succeed = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onFinish = (): void => succeed()
    const onFail = (_event: Electron.Event, errorCode: number, errorDescription: string): void => {
      fail(new Error(`ocr-overlay-load-failed:${errorCode}:${errorDescription}`))
    }
    const onClosed = (): void => fail(new Error('ocr-overlay-closed'))

    win.webContents.once('did-finish-load', onFinish)
    win.webContents.once('did-fail-load', onFail)
    win.once('closed', onClosed)
  })
  ocrSelectionWindowReadyPromises.set(win, ready)
  return ready
}

/**
 * 创建或返回独立的截图动作提示窗口。
 * 提示窗口与截图覆盖层解耦：截图窗口关闭后提示仍独立存活，到时间后自行隐藏。
 * @returns 截图提示窗口。
 * @author zhenghq
 */
function getScreenshotToastWindow(): BrowserWindow {
  if (screenshotToastWin && !screenshotToastWin.isDestroyed()) return screenshotToastWin
  screenshotToastWin = new BrowserWindow({
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
    focusable: false,
    hasShadow: false,
    width: 260,
    height: 56,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  screenshotToastWin.setAlwaysOnTop(true, 'screen-saver')
  screenshotToastWin.setVisibleOnAllWorkspaces(true, ALL_WORKSPACES_VISIBILITY_OPTIONS)
  // 纯提示窗口不得拦截鼠标：胶囊贴在屏幕下方，若不透传点击会挡住用户对该区域的操作。
  screenshotToastWin.setIgnoreMouseEvents(true)
  screenshotToastWin.on('closed', () => {
    if (screenshotToastHideTimer) {
      clearTimeout(screenshotToastHideTimer)
      screenshotToastHideTimer = null
    }
    screenshotToastWin = null
    // Toast 窗口异常关闭时也必须释放自己的暂停原因，避免全局划词监听永久停用。
    selectionListenerController.resume('screenshot-toast')
  })
  screenshotToastWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (process.env['ELECTRON_RENDERER_URL']) {
    screenshotToastWin.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/toast.html`)
  } else {
    screenshotToastWin.loadFile(join(__dirname, '../renderer/toast.html'))
  }
  return screenshotToastWin
}

/**
 * 展示独立的截图动作提示窗口：转发消息给提示窗口渲染进程，
 * 由渲染进程完成尺寸测量后再通过 `screenshot-toast:show-window` 居中显示。
 * @param message 提示文本。
 * @param displayTimeMs 停留时长（毫秒）。
 * @param kind 语义状态，供提示窗口选择图标与配色。
 * @returns 无返回值。
 * @author zhenghq
 */
function showScreenshotToast(
  message: string,
  displayTimeMs = 1500,
  kind: ScreenshotToastKind = 'success'
): void {
  // 在异步 Toast 渲染和尺寸测量前立即暂停，避免截图窗口关闭时“译”图标闪现。
  selectionListenerController.pause('screenshot-toast')
  const win = getScreenshotToastWindow()
  const show = (): void => {
    win.webContents.send('screenshot-toast:show', { message, kind, displayTimeMs })
  }
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', show)
  } else {
    show()
  }
}

/**
 * 处理提示窗口回传的尺寸测量结果：调整窗口大小、居中到当前屏幕并显示，
 * 同时安排到时间后自动隐藏。
 * @param value 提示窗口渲染进程回传的尺寸与停留时长。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleScreenshotToastShowWindow(value: unknown): void {
  const win = screenshotToastWin
  if (!win || win.isDestroyed()) return
  // 新提示到达时先取消旧的隐藏任务，避免旧定时器抢先把本次提示隐藏。
  if (screenshotToastHideTimer) {
    clearTimeout(screenshotToastHideTimer)
    screenshotToastHideTimer = null
  }
  const raw = value as { width?: number; height?: number; displayTimeMs?: number }
  // 渲染进程回传的是胶囊本体尺寸；这里补上提示页四周各 4px 留白，保证圆角与入场位移不被裁切。
  const width = Math.min(Math.max(Math.ceil(raw.width ?? 0) + 8, 120), 480)
  const height = Math.min(Math.max(Math.ceil(raw.height ?? 0) + 8, 36), 120)
  const displayTimeMs = Math.max(raw.displayTimeMs ?? 1500, 500)
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  // 微信风格：轻量胶囊贴在屏幕下方居中。以 workArea 为基准，避免压住 Dock 栏。
  const area = display.workArea
  const x = Math.round(area.x + (area.width - width) / 2)
  const y = Math.round(area.y + area.height * 0.9 - height)
  win.setBounds({ x, y, width, height })
  win.showInactive()
  screenshotToastHideTimer = setTimeout(() => {
    if (screenshotToastWin && !screenshotToastWin.isDestroyed()) {
      screenshotToastWin.hide()
    }
    screenshotToastHideTimer = null
    selectionListenerController.resume('screenshot-toast')
  }, displayTimeMs)
}

/**
 * 暂停普通划词监听，供 OCR 框选期间独占鼠标事件。
 * 与 restoreSelectionListenerAfterOcr 配对记账，确保任何收尾路径都能恢复。
 * @returns 无返回值。
 * @author zhenghq
 */
function suspendSelectionListenerForOcr(): void {
  selectionListenerController.pause('ocr')
}

/**
 * OCR 框选结束后恢复普通划词监听。
 * 只要曾因 OCR 暂停就必须恢复：早期实现以“覆盖窗口曾可见”为前提，
 * 一旦窗口已提前隐藏，全局钩子会被永久停用，导致划词与双击彻底失效。
 * @param interactionToken 可选的 OCR 交互 token，用于拒绝旧流程清理新流程。
 * @returns 无返回值。
 * @author zhenghq
 */
function restoreSelectionListenerAfterOcr(interactionToken?: number): void {
  // 旧 OCR 请求的异常或关闭信号不能清理新 OCR 请求持有的 token。
  if (interactionToken !== undefined && ocrInteractionToken !== interactionToken) return
  selectionListenerController.resume('ocr')
  const token = ocrInteractionToken
  ocrInteractionToken = null
  if (token !== null) releaseSelectionInteraction(token)
}

/**
 * 隐藏 OCR 框选窗口，并返回隐藏前是否可见。
 * @returns 隐藏前 OCR 框选窗口是否可见。
 * @author zhenghq
 */
function hideOcrSelectionWindow(): boolean {
  const wasVisible = isOcrSelectionVisible()
  // 兜底清理：正常路径下 openOcrSelection 已不再进入简单全屏，但一旦窗口处于简单全屏状态，
  // 隐藏后系统仍把它视为全屏窗口，后续打开设置页或翻译页会导致 macOS 自动隐藏 Dock 栏，
  // 同时菜单栏也不会恢复。这里显式退出，避免任何遗留状态污染后续窗口。
  if (process.platform === 'darwin' && ocrSelectionWin && !ocrSelectionWin.isDestroyed() && ocrSelectionWin.isSimpleFullScreen()) {
    ocrSelectionWin.setSimpleFullScreen(false)
  }
  ocrSelectionWin?.hide()
  return wasVisible
}

/**
 * 判断指定 token 是否仍拥有当前这次 OCR 采集。
 * 用户取消、新会话开始或采集失败收尾都会清空 `ocrInteractionToken`，
 * 因此不能只看 selectionInteraction 的 token 自增，否则旧采集超时会污染新会话。
 * @param token 待校验的 OCR 交互 token。
 * @returns token 仍是当前采集时返回 true。
 * @author zhenghq
 */
function isCurrentOcrCapture(token: number): boolean {
  return ocrInteractionToken === token && selectionInteraction.isCurrent(token)
}

/**
 * 向已经 ready 的 OCR 覆盖窗口发送事件；页面未 ready 时直接跳过，避免各事件分别积压回调。
 * @param win 覆盖窗口。
 * @param channel IPC 频道名。
 * @param payload 事件负载。
 * @returns 无返回值。
 * @author zhenghq
 */
function sendToOcrSelectionWindow(win: BrowserWindow, channel: string, payload: unknown): void {
  if (win.isDestroyed()) return
  const sessionId = (payload as { sessionId?: unknown })?.sessionId
  // 页面加载期间不能补发旧会话事件；正常调用路径已由 ready 门禁保护。
  if (win.webContents.isLoading()) return
  if (typeof sessionId === 'number' && sessionId !== ocrSelectionSessionSeq) return
  win.webContents.send(channel, payload)
}

/**
 * 处理 OCR 预览采集失败：通知覆盖窗口退出框选、隐藏窗口、恢复划词监听并展示错误弹窗。
 * @param interactionToken 本次 OCR 交互 token。
 * @param error 采集失败的异常。
 * @param anchor 弹窗锚点（快捷键按下时的光标位置）。
 * @returns 无返回值。
 * @author zhenghq
 */
function failOcrSelectionCapture(interactionToken: number, error: unknown, anchor: { x: number; y: number }): void {
  // 旧采集的失败不得打断新会话。
  if (!isCurrentOcrCapture(interactionToken)) return
  const settings = getSettings()
  const code = resolveOcrErrorCode(error)
  const message = error instanceof Error ? error.message : t('error.screenCaptureFailed')
  const failedPayload: OcrSelectionFailedPayload = {
    sessionId: ocrSelectionSessionSeq,
    message,
    ocrCode: code
  }
  if (ocrSelectionWin && !ocrSelectionWin.isDestroyed()) {
    sendToOcrSelectionWindow(ocrSelectionWin, 'ocr-selection:failed', failedPayload)
  }
  latestOcrSnapshot = null
  ocrSessionResultCache.clear()
  const hideOverlay = (): void => {
    hideOcrSelectionWindow()
    restoreSelectionListenerAfterOcr(interactionToken)
  }
  const showErrorPopup = (): void => {
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
  }
  // macOS 上覆盖窗口是应用内最后一个 key window：直接隐藏会让系统把设置页提升为 key window
  // 并顶到其它应用之上，因此先显示错误弹窗接管 key window，再收起覆盖窗口。
  // 弹窗层级低于覆盖窗口（floating < screen-saver），先显示不会在覆盖层上露出。
  // Windows 保持原顺序：弹窗显示时机依赖覆盖窗口隐藏后的前台状态，改动会影响取词焦点。
  if (isMac) {
    showErrorPopup()
    hideOverlay()
  } else {
    hideOverlay()
    showErrorPopup()
  }
  if (code === 'permission') {
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  }
}

/**
 * 打开 OCR 框选窗口：先通知 Renderer 清理上一轮会话，再采集鼠标所在显示器快照并回填背景图。
 * Windows 与 macOS 在采集完成前保持覆盖窗口隐藏，避免系统截图把应用自身遮罩采入 OCR 输入；
 * Linux 保留先显示后采集的低延迟路径。
 * @returns 打开流程完成后的 Promise。
 * @author zhenghq
 */
async function openOcrSelection(): Promise<void> {
  // OCR 框选已经进行时拒绝重复入口，避免旧截图请求与新 token 互相恢复监听。
  if (selectionInteraction.snapshot().state === 'ocr-selecting') return
  // 覆盖窗口显示后应用会成为前台应用，这里先记录截图前的状态，供收尾时决定是否归还前台。
  ocrSessionAppWasFrontmost = BrowserWindow.getFocusedWindow() !== null
  // 采集截图前最前的应用：必须赶在覆盖窗口显示之前，且与随后的屏幕采集并发进行，
  // 收尾时才消费结果，因此不会额外增加覆盖窗口出现的延迟。
  // 截图前本应用已是最前时没有可交还的目标，同时清掉上一轮可能残留的记录，
  // 避免它把用户当前正在用的应用换掉。
  forgetFrontmostApp()
  const previousAppPromise = isMac && !ocrSessionAppWasFrontmost ? readFrontmostAppSnapshot() : null
  const hotkeyAt = Date.now()
  latestSelectionGesture += 1
  const interactionToken = selectionInteraction.beginOcrSelection()
  ocrInteractionToken = interactionToken
  // 每次打开都自增会话序号：begin 与 snapshot 携带同一序号，
  // Renderer 据此识别并丢弃上一次会话残留的选区与快照。
  ocrSelectionSessionSeq += 1
  const ocrSessionId = ocrSelectionSessionSeq
  selectionCapture.invalidate()
  suspendSelectionListenerForOcr()
  hideSelectionButton()
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const anchor = screen.getCursorScreenPoint()
  latestOcrSnapshot = null
  // 新会话必须作废上一轮识别结果，避免跨会话复用旧选区文本。
  ocrSessionResultCache.clear()

  const win = getOcrSelectionWindow()
  // 覆盖窗口使用外层无边框尺寸与显示器边界对齐；这里必须使用屏幕坐标下的 setBounds，
  // 否则 macOS 会把内容区域再次换算，导致快照画面整体向下偏移。
  // 窗口创建时已按全部显示器的联合边界铺满：目标显示器与当前边界一致时跳过 setBounds，
  // 避免多显示器切换时产生一次多余的窗口尺寸变化（Windows 上表现为放大动作）。
  const currentBounds = win.getBounds()
  if (currentBounds.x !== display.bounds.x || currentBounds.y !== display.bounds.y ||
      currentBounds.width !== display.bounds.width || currentBounds.height !== display.bounds.height) {
    win.setBounds(display.bounds)
  }
  // 这里刻意不进入 macOS 简单全屏（setSimpleFullScreen）。简单全屏会切换应用呈现模式，
  // 系统随之隐藏顶部菜单栏与底部 Dock 栏，于是紧随其后的 screencapture 快照本身就缺少
  // 这两个区域，用户看到的就是「截图时 Dock 栏和菜单栏消失」。
  // 覆盖窗口在创建时已开启 enableLargerThanScreen，setBounds(display.bounds) 可精确落到
  // (0, 0) 且 content area 与窗口边界一致，配合 screen-saver 层级即可盖住菜单栏与 Dock。
  let timeoutTimer: NodeJS.Timeout | null = null
  let timedOut = false
  try {
    await whenOcrSelectionWindowReady(win)
    if (!isCurrentOcrCapture(interactionToken)) {
      restoreSelectionListenerAfterOcr(interactionToken)
      return
    }
    // macOS 未授予「屏幕录制」权限时，screencapture 会被系统授权弹窗阻塞到 5 秒超时，
    // 只能报出误导性的「屏幕采集超时」。这里先做同步预检，立即按权限错误收尾并引导授权。
    if (!hasScreenRecordingPermission()) {
      throw new ScreenCaptureError('permission', t('error.screenRecordingPermission'))
    }
    // 复用窗口时必须先让 Renderer 清空上一轮选区、截图和面板内容，
    // 再显示窗口，避免旧画面在新一轮截图开始时短暂闪现。
    // 先登记 ready 等待，再发送 begin，避免 Renderer 同步回执时丢失确认。
    const rendererReadyPromise = waitForOcrSelectionReady(win, ocrSessionId)
    sendToOcrSelectionWindow(win, 'ocr-selection:begin', {
      sessionId: ocrSessionId,
      bounds: display.bounds
    })
    // Windows GDI BitBlt 与 macOS screencapture 都会读取当前屏幕合成结果；覆盖窗口若先显示，
    // 应用自身的半透明遮罩会进入快照，导致三个 OCR 引擎共享同一张无有效文字的输入图。
    // 两个平台都保持隐藏到采集完成；Linux 暂时保留先显示再采集的原有交互时序。
    const showBeforeCapture = !['win32', 'darwin'].includes(process.platform)
    let hotkeyToShowMs = 0
    if (showBeforeCapture) {
      win.show()
      win.focus()
      hotkeyToShowMs = Date.now() - hotkeyAt
    }

    timeoutTimer = setTimeout(() => {
      timedOut = true
      failOcrSelectionCapture(
        interactionToken,
        new ScreenCaptureError('no-source', t('error.screenCaptureTimeout')),
        anchor
      )
    }, OCR_PREVIEW_CAPTURE_TIMEOUT_MS)

    // begin 只清理隐藏窗口里的上一轮 UI 状态，不改变屏幕内容，因此不必串行等待回执：
    // 先把 begin 发出去让 Renderer 开始清理，紧接着采集屏幕，采集完成后再汇合回执。
    // 这样一次 IPC 往返与整轮 UI 重置都被藏进屏幕采集时间里，直接缩短按下快捷键到可拖拽的延迟。
    if (showBeforeCapture) {
      // Linux 保留「先清理旧会话、显示窗口，再采集」的原有交互时序。
      const readyBeforeShow = await rendererReadyPromise
      if (!readyBeforeShow || !isCurrentOcrCapture(interactionToken)) {
        restoreSelectionListenerAfterOcr(interactionToken)
        return
      }
    }
    const capturePromise = captureOcrPreviewSnapshot(display.bounds)
    const prepareMs = Date.now() - hotkeyAt
    const [rendererReady, preview] = await Promise.all([
      showBeforeCapture ? Promise.resolve(true) : rendererReadyPromise,
      capturePromise
    ])
    const rendererReadyMs = Date.now() - hotkeyAt
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (timedOut) return
    if (!rendererReady || !isCurrentOcrCapture(interactionToken)) {
      restoreSelectionListenerAfterOcr(interactionToken)
      return
    }
    // 采集期间若交互 token 被新流程取代或用户已取消，旧快照必须丢弃，并收回自己曾登记的暂停记账。
    if (!isCurrentOcrCapture(interactionToken)) {
      restoreSelectionListenerAfterOcr(interactionToken)
      return
    }
    if (!showBeforeCapture) {
      // 采集已经完成后再显示覆盖层，保证 Windows/macOS 不会把本窗口遮罩采进 OCR 快照。
      // 显示前收齐前台应用快照：此刻本应用还不是最前，读到的仍是截图前的应用。
      // 记录写进 macForeground 的共享状态：覆盖窗口收起后由翻译弹窗继续持有并最终交还。
      if (previousAppPromise) rememberFrontmostApp(await previousAppPromise)
      win.show()
      win.focus()
      hotkeyToShowMs = Date.now() - hotkeyAt
    }
    // show() 只是把显示请求投递给系统，紧接着同步执行预览负载构建会阻塞消息循环，
    // 窗口反而要等构建结束才上屏。先让出一次事件循环让窗口完成合成，再构建预览负载。
    await yieldToEventLoop()
    // Windows GDI 直采路径在这里只做一次结构化克隆（4K 约 40ms），不做任何编码；
    // 回退路径才需要 base64。屏幕像素此刻已经读取完成，覆盖窗口再构建负载不会被采进快照，
    // 所以放到显示之后执行，用户可以先看到遮罩开始框选。
    const { preview: previewPayload, previewEncodeMs } = preview.buildPreviewPayload()
    latestOcrSnapshot = preview.snapshot
    const sendStartedAt = Date.now()
    sendToOcrSelectionWindow(win, 'ocr-selection:snapshot', {
      sessionId: ocrSessionId,
      bounds: preview.snapshot.bounds,
      ...previewPayload
    })
    console.log('[ocr] 预览就绪', {
      source: preview.snapshot.source,
      hotkeyToShowMs,
      prepareMs,
      rendererReadyMs,
      captureMs: preview.captureMs,
      previewEncodeMs,
      ipcSendMs: Date.now() - sendStartedAt
    })
  } catch (error) {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (timedOut) return
    failOcrSelectionCapture(interactionToken, error, anchor)
  }
}

/**
 * 把 macOS 前台交还给截图前的应用，随后收起覆盖窗口。
 *
 * 覆盖窗口是应用内最后一个 key window：一旦隐藏，系统会把应用内下一个窗口（通常是设置页）
 * 提升为 key window 并顶到所有应用最前，用户表现为「截屏复制后设置页自动弹出」。
 * 交还细节（先激活源应用、确认失活后再隐藏）见 macForeground.handBackFrontmostThen。
 *
 * 拿不到源应用或激活无效时退化为隐藏应用再恢复：窗口会短暂消失，但同样不会让设置页留在最前。
 * @returns 无返回值。
 * @author zhenghq
 */
function returnFrontmostThenHideOcrSelection(): void {
  const sessionSeqAtReturn = ocrSelectionSessionSeq
  const hideOverlay = (): void => {
    // 期间又开了新截图会话时放弃收起，避免把新会话的覆盖窗口隐藏掉。
    if (ocrSelectionSessionSeq !== sessionSeqAtReturn) return
    hideOcrSelectionWindow()
  }
  handBackFrontmostThen(ocrSelectionWin, hideOverlay, () => {
    if (ocrSelectionSessionSeq !== sessionSeqAtReturn) return
    hideOverlay()
    restoreAppWindowsByHidingApp()
  })
}

/**
 * 退化方案：先隐藏应用让系统重新激活截图前的应用，再延后恢复应用内窗口。
 *
 * app.hide() 隐藏全部窗口（含正在展示的提示窗口），因此这条路径只在拿不到目标应用时使用；
 * 恢复用 app.show()（unhideWithoutActivation）：它不激活应用，也不把窗口提到前台应用之上，
 * 设置页会回到原本的层叠位置。
 * 注意不能改用 win.showInactive() 逐个恢复窗口——orderFront 会把窗口顶到前台应用之上，
 * 用户仍然会看到设置页盖在自己的应用上（真机用 CGWindowList 采样 z 序验证过）。
 * @returns 无返回值。
 * @author zhenghq
 */
function restoreAppWindowsByHidingApp(): void {
  const sessionSeqAtHide = ocrSelectionSessionSeq
  app.hide()
  const restoreAppWindows = (): void => {
    // 期间又开了新截图会话时放弃恢复，避免把窗口可见性改回上一次会话的状态。
    if (ocrSelectionSessionSeq !== sessionSeqAtHide) return
    app.show()
  }
  setTimeout(restoreAppWindows, FRONT_RESTORE_DELAY_MS)
  // app.hide() 生效较慢时首次 app.show() 会被覆盖，补一次校验恢复，避免窗口一直不可见。
  setTimeout(restoreAppWindows, FRONT_RESTORE_VERIFY_DELAY_MS)
}

/**
 * 取消 OCR 框选并隐藏覆盖窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
function cancelOcrSelection(): void {
  activeScreenshotOcrRequests.clear()
  resolveOcrSelectionReady(false)
  latestOcrSnapshot = null
  ocrSessionResultCache.clear()
  restoreSelectionListenerAfterOcr()
  const wasVisible = isOcrSelectionVisible()
  // 截图前应用不在最前时，覆盖窗口一隐藏设置页就会被顶到最前，
  // 因此这条路径先交还前台、再收起覆盖窗口（见 returnFrontmostThenHideOcrSelection）。
  if (wasVisible && !ocrSessionAppWasFrontmost) {
    ocrSessionAppWasFrontmost = true
    returnFrontmostThenHideOcrSelection()
    return
  }
  hideOcrSelectionWindow()
  ocrSessionAppWasFrontmost = true
}

/**
 * 结束当前截图会话但不隐藏覆盖窗口：
 * 供复制/保存成功后调用，先释放快照，
 * 全局划词监听延迟恢复以等待覆盖窗口关闭动画播完，
 * 避免新窗口（如独立 toast）被误判为划词触发"译"按钮。
 * @returns 无返回值。
 * @author zhenghq
 */
function finishScreenshotSession(): void {
  activeScreenshotOcrRequests.clear()
  latestOcrSnapshot = null
  ocrSessionResultCache.clear()
  // 划词监听由 toast 窗口统一接管：toast 显示期间保持暂停，隐藏后再恢复
}

/** 截图选区动作错误：携带细分错误码，便于截图窗口展示差异化提示。
 * @author zhenghq
 */
class ScreenshotSelectionError extends Error {
  /** 细分错误码。 */
  readonly code: ScreenshotOcrErrorCode

  /**
   * 创建截图选区动作错误。
   * @param code 细分错误码。
   * @param message 面向用户的描述。
   * @author zhenghq
   */
  constructor(code: ScreenshotOcrErrorCode, message: string) {
    super(message)
    this.name = 'ScreenshotSelectionError'
    this.code = code
  }
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

/** 单张网页图片允许的最大字节数（8 MB）。 */
const WEB_IMAGE_MAX_BYTES = 8 * 1024 * 1024
/** 单张网页图片允许的最大像素数（1600 万）。 */
const WEB_IMAGE_MAX_PIXELS = 16_000_000
/** 网页图片网络请求超时（毫秒）。 */
const WEB_IMAGE_REQUEST_TIMEOUT_MS = 15_000

/**
 * 为远程网页创建图片取图器：优先使用阅读器独立 Session 请求图片地址，
 * 失败或不可请求时回退到远程 View 的区域截图。
 * @param view 远程网页视图。
 * @param signal 任务取消信号。
 * @returns 图片取图器。
 * @author zhenghq
 */
function createWebReaderImageSource(view: BrowserView, signal?: AbortSignal): WebImageSource {
  const requestImage = async (url: string, requestSignal?: AbortSignal): Promise<WebImageResponse> => {
    const request = net.request({ url, session: view.webContents.session, useSessionCookies: true })
    return await new Promise<WebImageResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        request.abort()
        reject(new Error(t('error.imageRequestTimeout')))
      }, WEB_IMAGE_REQUEST_TIMEOUT_MS)
      const finish = (): void => { clearTimeout(timer) }
      requestSignal?.addEventListener('abort', () => {
        finish()
        request.abort()
        reject(new Error(t('error.imageRequestCancelled')))
      }, { once: true })
      request.on('error', (error) => { finish(); reject(error) })
      request.on('response', (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        response.on('error', (error) => { finish(); reject(error) })
        response.on('end', () => {
          finish()
          resolve({
            bytes: Buffer.concat(chunks),
            contentType: String(response.headers['content-type'] ?? '')
          })
        })
      })
      request.end()
    })
  }
  /**
   * 读取远程页面当前滚动位置与视口尺寸。
   * @returns 视口滚动位置与尺寸。
   * @author zhenghq
   */
  const resolveViewport = async (): Promise<{ scrollX: number; scrollY: number; width: number; height: number }> => {
    return await view.webContents.executeJavaScript(`(() => ({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight
    }))()`, true) as { scrollX: number; scrollY: number; width: number; height: number }
  }

  /**
   * 直接导出页面内 canvas 位图。
   *
   * Google Docs 等应用把整页正文画在 canvas 上，canvas 高度通常大于视口，
   * 区域截图只能截到可见的一小段；直接读取 canvas 位图可以拿到完整页面。
   * 跨域污染导致导出失败时返回 null，由调用方回退区域截图。
   *
   * @param candidate 图片候选。
   * @returns 位图字节与像素尺寸；无法导出时返回 null。
   * @author zhenghq
   */
  const readCanvasImage = async (candidate: WebImageCandidate): Promise<WebImageResponse | null> => {
    const anchor = JSON.stringify({
      selector: candidate.selector,
      shadowPath: candidate.shadowPath ?? []
    })
    const exported = await view.webContents.executeJavaScript(`(() => {
      const anchor = ${anchor};
      let element = null;
      try { element = document.querySelector(anchor.selector); } catch {}
      if (element && anchor.shadowPath.length > 0) {
        let current = element.shadowRoot;
        for (const index of anchor.shadowPath) {
          if (!current?.childNodes?.[index]) { current = null; break; }
          current = current.childNodes[index];
        }
        element = current;
      }
      if (!element || element.tagName !== 'CANVAS') return null;
      try {
        const dataUrl = element.toDataURL('image/png');
        if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image/png;base64,') !== 0) return null;
        return { base64: dataUrl.slice('data:image/png;base64,'.length), width: element.width, height: element.height };
      } catch {
        return null;
      }
    })()`, true) as { base64: string; width: number; height: number } | null
    if (!exported?.base64) return null
    const bytes = Buffer.from(exported.base64, 'base64')
    if (bytes.length === 0) return null
    return { bytes, contentType: 'image/png', width: exported.width, height: exported.height }
  }

  /**
   * 把候选滚动到页面内任意可滚动祖先的可见区域。
   *
   * `window.scrollTo` 只能影响文档滚动，Google Docs 这类应用的正文位于内层
   * `overflow: auto` 容器中，必须滚动真正的滚动祖先才能让候选进入可见区域。
   * 原始滚动位置保存在页面全局变量中，由 `restoreRevealed` 恢复。
   *
   * @param candidate 图片候选。
   * @returns 可见矩形（视口坐标）；无法进入可见区域时返回 null。
   * @author zhenghq
   */
  const revealVisibleRect = async (candidate: WebImageCandidate): Promise<{ x: number; y: number; width: number; height: number } | null> => {
    const anchor = JSON.stringify({
      selector: candidate.selector,
      shadowPath: candidate.shadowPath ?? [],
      x: Math.round(candidate.rect.x),
      y: Math.round(candidate.rect.y),
      width: Math.round(candidate.rect.width),
      height: Math.round(candidate.rect.height)
    })
    return await view.webContents.executeJavaScript(`(async () => {
      const anchor = ${anchor};
      const resolve = () => {
        let element = null;
        try { element = document.querySelector(anchor.selector); } catch {}
        if (element && anchor.shadowPath.length > 0) {
          let current = element.shadowRoot;
          for (const index of anchor.shadowPath) {
            if (!current?.childNodes?.[index]) return null;
            current = current.childNodes[index];
          }
          element = current;
        }
        return element?.nodeType === Node.ELEMENT_NODE ? element : null;
      };
      const scrollableAncestors = (element) => {
        const list = [];
        let current = element.parentElement;
        while (current && current !== document.documentElement) {
          const style = getComputedStyle(current);
          if (/(auto|scroll|overlay)/.test(style.overflowY) && current.scrollHeight > current.clientHeight + 1) list.push(current);
          current = current.parentElement;
        }
        return list;
      };
      const restore = [];
      const element = resolve();
      if (!element) return null;
      for (const scroller of scrollableAncestors(element)) {
        restore.push({ scroller, scrollTop: scroller.scrollTop, scrollLeft: scroller.scrollLeft });
      }
      // 同时记录文档滚动位置，避免无内层滚动容器时 window.scrollTo 无法还原。
      window.__selectionTranslatorWebImageReveal = {
        windowScroll: { scrollX: window.scrollX, scrollY: window.scrollY },
        scrollers: restore
      };
      const viewport = { scrollX: window.scrollX, scrollY: window.scrollY };
      if (restore.length === 0) {
        const targetY = Math.max(0, anchor.y - Math.round(window.innerHeight / 3));
        window.scrollTo({ left: viewport.scrollX, top: targetY, behavior: 'instant' });
      } else {
        // 逐层把候选对齐到各自滚动容器顶部，外层容器同样需要滚动。
        for (const scroller of restore) {
          const scrollerRect = scroller.scroller.getBoundingClientRect();
          const elementRect = element.getBoundingClientRect();
          scroller.scroller.scrollTop += Math.round(elementRect.top - scrollerRect.top);
        }
      }
      // 页面被隐藏时 requestAnimationFrame 可能永不触发，改用定时器等待合成器提交新画面。
      await new Promise((resolve) => setTimeout(resolve, 32));
      const rect = element.getBoundingClientRect();
      let clip = { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
      let current = element.parentElement;
      while (current) {
        const style = getComputedStyle(current);
        if (/(auto|scroll|overlay|hidden)/.test(style.overflowY) || /(auto|scroll|overlay|hidden)/.test(style.overflowX)) {
          const clipRect = current.getBoundingClientRect();
          clip = {
            top: Math.max(clip.top, clipRect.top),
            left: Math.max(clip.left, clipRect.left),
            right: Math.min(clip.right, clipRect.right),
            bottom: Math.min(clip.bottom, clipRect.bottom)
          };
        }
        current = current.parentElement;
      }
      const top = Math.max(rect.top, clip.top);
      const left = Math.max(rect.left, clip.left);
      const right = Math.min(rect.right, clip.right);
      const bottom = Math.min(rect.bottom, clip.bottom);
      if (right - left < 1 || bottom - top < 1) return null;
      return { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
    })()`, true) as { x: number; y: number; width: number; height: number } | null
  }

  /**
   * 恢复 `revealVisibleRect` 改变的滚动位置。
   * @returns 恢复完成后的 Promise。
   * @author zhenghq
   */
  const restoreRevealed = async (): Promise<void> => {
    await view.webContents.executeJavaScript(`(() => {
      const restore = window.__selectionTranslatorWebImageReveal;
      window.__selectionTranslatorWebImageReveal = null;
      if (!restore) return;
      for (const item of restore.scrollers || []) {
        if (!item?.scroller) continue;
        item.scroller.scrollTop = item.scrollTop;
        item.scroller.scrollLeft = item.scrollLeft;
      }
      const windowScroll = restore.windowScroll;
      if (windowScroll) {
        window.scrollTo({ left: windowScroll.scrollX, top: windowScroll.scrollY, behavior: 'instant' });
      }
    })()`, true)
  }

  return createWebImageSource({
    requestImage,
    captureRegion: async (rect, captureSignal) => {
      if (captureSignal?.aborted) throw new Error(t('error.imageCaptureCancelled'))
      const image = await view.webContents.capturePage(rect)
      return image.toPNG()
    },
    resolveViewport,
    readCanvasImage,
    revealVisibleRect,
    restoreRevealed,
    scrollIntoView: async (rect) => {
      return await view.webContents.executeJavaScript(`(async () => {
        const targetY = Math.max(0, ${JSON.stringify(Math.round(rect.y))} - Math.round(window.innerHeight / 3));
        // 页面可能声明 scroll-behavior: smooth，平滑动画结束前读取视口会取到错误区域，
        // 因此强制即时滚动，并在滚动位置稳定后再交由截图读取。
        window.scrollTo({ left: window.scrollX, top: targetY, behavior: 'instant' });
        // capturePage 在滚动后立即调用会返回滚动前的旧帧，等待两次绘制确保合成器已提交新画面。
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        // 页面底部图片可能受最大滚动距离限制而无法到达目标位置，
        // 因此以候选矩形是否进入视口作为成功判据，而非精确匹配目标滚动值。
        const top = ${JSON.stringify(Math.round(rect.y))} - window.scrollY;
        const left = ${JSON.stringify(Math.round(rect.x))} - window.scrollX;
        return top + ${JSON.stringify(Math.round(rect.height))} > 0 && top < window.innerHeight &&
          left + ${JSON.stringify(Math.round(rect.width))} > 0 && left < window.innerWidth;
      })()`, true) as boolean
    },
    restoreScroll: async (scrollX, scrollY) => {
      await view.webContents.executeJavaScript(
        `window.scrollTo({ left: ${JSON.stringify(Math.round(scrollX))}, top: ${JSON.stringify(Math.round(scrollY))}, behavior: 'instant' })`,
        true
      )
    },
    maxBytes: WEB_IMAGE_MAX_BYTES,
    maxPixels: WEB_IMAGE_MAX_PIXELS,
    signal
  })
}

/**
 * 解析当前运行环境实际使用的 OCR 引擎偏好。
 * Win7 兼容包只携带 Tesseract.js WASM 运行时，必须忽略用户选择的系统或 PaddleOCR 引擎。
 * @param settings 当前设置。
 * @returns Win7 固定返回 Tesseract，其它平台返回用户设置。
 * @author zhenghq
 */
function resolveOcrEnginePreference(settings: Settings): OcrEnginePreference {
  return isWindows7CompatibilityRuntime() ? 'tesseract' : settings.ocrEnginePreference
}

/**
 * 创建本次 OCR 调度器，按设置决定是否启用 Tesseract 兜底。
 * @param settings 当前设置。
 * @returns OCR 调度器。
 * @author zhenghq
 */
async function createOcrDispatcher(settings: Settings): Promise<OcrDispatcher> {
  // Win7 包只保留 Tesseract.js 与 WebAssembly 核心，避免加载任何 OCR 原生模块。
  if (isWindows7CompatibilityRuntime()) {
    const [{ OcrDispatcher }, { TesseractOcrEngine, resolveTesseractLangPath, resolveTesseractWorkerPath }] = await Promise.all([
      import('./ocrDispatcher'),
      import('./tesseractOcr')
    ])
    return new OcrDispatcher({
      platform: process.platform,
      enginePreferenceState: ocrEnginePreferenceState,
      engines: {
        tesseract: new TesseractOcrEngine({
          tessDataPath: join(app.getPath('userData'), 'tessdata'),
          langPath: resolveTesseractLangPath(process.env['TESSERACT_LANG_PATH']),
          bundledLangPath: join(process.resourcesPath, 'tessdata'),
          workerPath: resolveTesseractWorkerPath(process.resourcesPath, app.isPackaged)
        })
      }
    })
  }
  // 仅在现代包中按需加载 OCR 原生依赖，Win7 包完全不触碰这些模块。
  const [{ OcrDispatcher }, { createSystemOcrEngine }, { PaddleOcrEngine }, { resolveBundledOcrModelAssets }, { TesseractOcrEngine }] = await Promise.all([
    import('./ocrDispatcher'),
    import('./systemOcr'),
    import('./paddleOcr'),
    import('./ocrModelAssets'),
    import('./tesseractOcr')
  ])
  const paddleModelAssets = resolveBundledOcrModelAssets(app.getAppPath())
  return new OcrDispatcher({
    platform: process.platform,
    enginePreferenceState: ocrEnginePreferenceState,
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
  if (isWindows7CompatibilityRuntime()) {
    return {
      win7Compatibility: true,
      systemAvailable: false,
      paddleAvailable: false,
      tesseractAvailable: true,
      modelName: 'Tesseract.js',
      modelVersion: '7.x',
      license: 'Apache-2.0',
      distribution: 'bundled',
      message: t('windows7.ocrTesseractOnly')
    }
  }
  const [{ createSystemOcrEngine }, { PaddleOcrEngine }, { resolveBundledOcrModelAssets }, { TesseractOcrEngine }] = await Promise.all([
    import('./systemOcr'),
    import('./paddleOcr'),
    import('./ocrModelAssets'),
    import('./tesseractOcr')
  ])
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
          ? t('ocr.assetsReady', { name: paddleModelAssets.metadata.name })
          : t('ocr.assetsRuntimeUnavailable', { name: paddleModelAssets.metadata.name }))
      : t('ocr.assetsFallback', { message: paddleModelAssets.message })
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
      error: result.error ?? t('error.noTranslatableText'),
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
 * 把已得到的 OCR 结果接入现有多通道翻译管道。
 *
 * 识别动作与翻译动作共用本入口：命中会话识别结果缓存时直接复用识别结果，
 * 未命中时才由 processOcrImageBytes 先识别再调用这里，保证两条路径的
 * 清洗、质量门禁与翻译通道选择语义完全一致。
 * @param ocr OCR 识别结果。
 * @param settings 当前设置。
 * @returns OCR 翻译结果。
 * @author zhenghq
 */
async function translateRecognizedOcrResult(
  ocr: OcrRecognizeResult,
  settings: Settings
): Promise<Awaited<ReturnType<typeof translateOcrResult>>> {
  return translateOcrResult(ocr, settings, {
    translate: async (text, requestSettings) => {
      const dingTalkCredentials = settings.dingTalkEnabled
        ? getDingTalkConfiguration().getCredentialsSnapshot()
        : null
      const aiApiKey = settings.aiEnabled ? getAiConfiguration().getApiKey() : null
      return translate(
        text,
        requestSettings ?? settings,
        dingTalkCredentials,
        aiApiKey
      )
    }
  })
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
  const dispatcher = await createOcrDispatcher(settings)
  const ocr = await recognizeAdaptiveOcr(
    {
      imageBytes,
      maxScale: settings.ocrScale,
      language: settings.ocrLang
    },
    {
      recognize: (preparedImageBytes) =>
        dispatcher.recognize({
          imageBytes: preparedImageBytes,
          language: settings.ocrLang,
          timeoutMs: OCR_TIMEOUT_MS
        }, resolveOcrEnginePreference(settings))
    }
  )
  return translateRecognizedOcrResult(ocr, settings)
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
      throw new ScreenCaptureError('permission', t('error.screenRecordingPermission'))
    }
    throw new ScreenCaptureError('no-source', t('error.screenCaptureFailedDetail', { message }))
  } finally {
    await unlink(path).catch(() => undefined)
  }
}

/**
 * 采集 Windows 指定显示器区域：优先 koffi GDI 原生直采，绑定或采集失败时
 * 回退既有 helper exe / PowerShell 路径，保证单点绑定错误不会让截屏整体不可用。
 * @param bounds 目标显示器矩形（虚拟屏幕坐标）。
 * @returns PNG 字节与采集来源标识（回退时来源体现降级）。
 * @author zhenghq
 */
async function captureWindowsOcrRegion(bounds: CaptureBounds): Promise<{ png: Buffer; source: string }> {
  return await captureWindowsOcrPngPreferGdi(bounds, resolveWindowsCaptureScale(bounds), buildWindowsOcrCaptureDeps())
}

/**
 * 解析 Windows 采集所用的显示器缩放因子：按选区中心点定位所在显示器。
 * @param bounds 目标区域（虚拟屏幕逻辑坐标）。
 * @returns 显示器缩放因子，取不到时按 1 处理。
 * @author zhenghq
 */
function resolveWindowsCaptureScale(bounds: CaptureBounds): number {
  const display = screen.getDisplayNearestPoint({
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2)
  })
  return display?.scaleFactor ?? 1
}

/**
 * 构造 Windows 采集的可注入依赖：GDI 失败时回退 helper exe / PowerShell 并记录降级日志。
 * 预览路径与最终选区路径共用同一份回退策略，避免两条链路的降级行为出现分歧。
 * @returns Windows 采集依赖。
 * @author zhenghq
 */
function buildWindowsOcrCaptureDeps(): {
  platform: NodeJS.Platform
  captureFallback(displayBounds: CaptureBounds, scale: number): Promise<Buffer>
  onGdiFailure(message: string): void
} {
  return {
    platform: process.platform,
    captureFallback: (displayBounds, scale) =>
      captureWindowsRegionAsPng(displayBounds, scale, buildWindowsScreenCaptureDeps()),
    onGdiFailure: (message) => {
      // console 已被 appLogger 接管，warn 会同时进入应用日志文件
      console.warn('[ocr] GDI 截屏失败，回退 helper exe / PowerShell', { message })
    }
  }
}

/**
 * 构造 Windows 屏幕采集的 IO 依赖。
 *
 * 采集热路径与空闲预热共用同一份依赖，保证预热写入的 helper exe 缓存路径
 * 与真实回退采集读取的路径完全一致，避免预热与使用落在不同目录而失效。
 * @returns Windows 屏幕采集依赖。
 * @author zhenghq
 */
function buildWindowsScreenCaptureDeps(): WindowsScreenCaptureDeps {
  return {
    platform: process.platform,
    execFile: execFileP,
    readFile,
    unlink,
    tmpDir: tmpdir,
    spawn: spawnP
  }
}

/**
 * 采集 Windows OCR 预览：优先 GDI 物理像素直采（不做 PNG 编码），
 * koffi 绑定或 GDI 调用失败时回退 helper exe / PowerShell 的 PNG 产物。
 * @param bounds 目标显示器矩形（虚拟屏幕逻辑坐标）。
 * @returns 像素或 PNG 形态的采集结果与来源标识。
 * @author zhenghq
 */
async function captureWindowsOcrPreview(bounds: CaptureBounds): Promise<WindowsPreviewCapture> {
  return await captureWindowsOcrPreviewPreferGdi(
    bounds,
    resolveWindowsCaptureScale(bounds),
    buildWindowsOcrCaptureDeps()
  )
}

/** OCR 屏幕快照：主进程持有可直接裁剪的内存图像，避免为裁剪重新解码整屏 PNG。 */
interface OcrSnapshot {
  /** 快照内存图像（物理像素）。 */
  image: NativeImage
  /** Windows GDI 原始 BGRA 像素；OCR 裁剪时优先使用，避免 nativeImage 通道契约差异。 */
  pixels?: WindowsPixelCapture
  /** 快照对应的显示器矩形（全局屏幕逻辑坐标）。 */
  bounds: CaptureBounds
  /** 采集来源标识，决定裁剪坐标换算规则。 */
  source: string
}

/** OCR 预览负载：编码图或 Windows 原始像素，二者互斥。 */
type OcrPreviewPayload =
  | { imageDataUrl: string; pixels?: undefined }
  | { pixels: WindowsPixelCapture; imageDataUrl?: undefined }

/** OCR 预览采集结果：快照本体与分阶段耗时，预览负载构建延迟到窗口显示之后再执行。 */
interface OcrPreviewCapture {
  /** 主进程持有的内存快照。 */
  snapshot: OcrSnapshot
  /** 屏幕采集耗时（毫秒）。 */
  captureMs: number
  /**
   * 构建供覆盖层背景显示使用的预览负载。
   *
   * 微信式截图不做任何重编码：抓屏得到的位图原样贴到覆盖层上屏。
   * Windows GDI 直采路径直接返回 BGRA 原始像素，既省掉编码耗时，
   * 也不存在降采样或 JPEG 压缩带来的画质损失；实测 4K 主进程序列化约 40ms。
   * 回退路径只有 PNG 字节，仍编码为 data URL（体积小、耗时可接受）。
   * 屏幕像素一旦读取完成，覆盖窗口再显示就不会被采进快照，因此负载构建可以安全地
   * 推迟到窗口显示之后执行，让用户先看到遮罩并开始框选。
   * @returns 预览负载与本次构建耗时（毫秒）。
   */
  buildPreviewPayload(): { preview: OcrPreviewPayload; previewEncodeMs: number }
}

/**
 * 打开 OCR 选择器后采集一张屏幕快照，后续用户只在这张快照上调整区域。
 * Windows 优先把 GDI 的 BGRA 直接交给 nativeImage，由 Chromium 原生编码器生成预览，
 * 不再对整屏调用 JS 版 encodePng；koffi 绑定失败时回退 helper exe / PowerShell 的 PNG 产物。
 * macOS / Linux 复用各自既有 PNG 采集来源。
 * @param bounds 需要快照的显示器区域。
 * @returns 内存快照、延迟编码回调与采集耗时。
 * @author zhenghq
 */
async function captureOcrPreviewSnapshot(bounds: CaptureBounds): Promise<OcrPreviewCapture> {
  const captureStartedAt = Date.now()
  if (process.platform === 'win32') {
    // Windows 优先 koffi GDI 直采物理像素；绑定失败时回退 helper exe / PowerShell，
    // 绕开 desktopCapturer/DXGI 缩略图在高 DPI 下的行错位彩色条纹问题。
    const captured = await captureWindowsOcrPreview(bounds)
    const captureMs = Date.now() - captureStartedAt
    // 整屏 4K 位图上传给 Chromium 约 10ms、PNG 解码更久，旧实现把它放在 win.show() 之前，
    // 直接推迟窗口出现。这里改为惰性建图：屏幕像素已经读进内存，覆盖窗口先上屏，
    // 真正需要 nativeImage 时（快速裁剪等按需动作）才建图，用户观感更快。
    // 注意：预览显示不再需要 nativeImage，原始像素由渲染层直接上屏。
    const createImage = (): NativeImage =>
      captured.kind === 'pixels'
        ? nativeImage.createFromBitmap(
            Buffer.from(
              captured.pixels.data.buffer,
              captured.pixels.data.byteOffset,
              captured.pixels.data.byteLength
            ),
            { width: captured.pixels.width, height: captured.pixels.height }
          )
        : nativeImage.createFromBuffer(captured.png)
    let image: NativeImage | null = null
    const resolveImage = (): NativeImage => {
      image ??= createImage()
      return image
    }
    return {
      snapshot: {
        get image(): NativeImage {
          return resolveImage()
        },
        pixels: captured.kind === 'pixels' ? captured.pixels : undefined,
        bounds,
        source: `${captured.source}-preview`
      },
      captureMs,
      buildPreviewPayload: () => {
        const encodeStartedAt = Date.now()
        // GDI 直采成功时直接下传原始 BGRA 像素：不编码、不降采样，画质与抓屏完全一致，
        // 也没有 PNG/JPEG 编码阻塞主进程的问题（微信截图即此思路）。
        // 只有回退路径拿不到像素时才退化为 PNG data URL，此时不做重编码、体积也可控。
        if (captured.kind === 'pixels') {
          return {
            preview: { pixels: captured.pixels },
            previewEncodeMs: Date.now() - encodeStartedAt
          }
        }
        const previewDataUrl = `data:image/png;base64,${captured.png.toString('base64')}`
        return {
          preview: { imageDataUrl: previewDataUrl },
          previewEncodeMs: Date.now() - encodeStartedAt
        }
      }
    }
  }
  if (process.platform === 'darwin') {
    const png = await captureMacRegionAsPng(bounds)
    const captureMs = Date.now() - captureStartedAt
    return {
      snapshot: { image: nativeImage.createFromBuffer(png), bounds, source: 'macos-screencapture-preview' },
      captureMs,
      // macOS 采集产物本身就是 PNG，base64 只是字符串转换；仍然延后到显示之后，
      // 避免整屏 base64（约 10-30MB 字符串）拖慢覆盖窗口出现。
      buildPreviewPayload: () => {
        const encodeStartedAt = Date.now()
        const previewDataUrl = `data:image/png;base64,${png.toString('base64')}`
        return {
          preview: { imageDataUrl: previewDataUrl },
          previewEncodeMs: Date.now() - encodeStartedAt
        }
      }
    }
  }
  const image = await captureRegionAsPng(bounds, { ocrScale: 1 }, {
    getSources: (options) => desktopCapturer.getSources(options as SourcesOptions),
    getDisplayNearestPoint: (point) => screen.getDisplayNearestPoint(point),
    getPrimaryDisplay: () => screen.getPrimaryDisplay(),
    platform: process.platform
  })
  const captureMs = Date.now() - captureStartedAt
  return {
    snapshot: {
      image: nativeImage.createFromBuffer(image.png),
      bounds,
      source: 'electron-desktopCapturer-preview'
    },
    captureMs,
    buildPreviewPayload: () => {
      const encodeStartedAt = Date.now()
      const previewDataUrl = `data:image/png;base64,${image.png.toString('base64')}`
      return {
        preview: { imageDataUrl: previewDataUrl },
        previewEncodeMs: Date.now() - encodeStartedAt
      }
    }
  }
}

/**
 * 从内存快照中裁出选区并编码为原始分辨率 PNG。
 * 先用 Chromium 原生 crop 取出选区，再只对选区做通道转换与 PNG 编码，
 * 不对整屏调用 decodePng / encodePng。
 * @param snapshot 当前内存快照。
 * @param bounds 用户选区（全局屏幕坐标）。
 * @returns 保持原始分辨率的选区 PNG 字节。
 * @author zhenghq
 */
function cropSnapshotSelectionPng(
  snapshot: OcrSnapshot,
  bounds: CaptureBounds
): Buffer {
  if (snapshot.pixels) {
    return cropBgraSelectionPng(
      snapshot.pixels.data,
      snapshot.pixels.width,
      snapshot.pixels.height,
      snapshot.source,
      bounds,
      snapshot.bounds
    )
  }
  const { width, height } = snapshot.image.getSize()
  const rect = resolveSnapshotCropRect(snapshot.source, bounds, snapshot.bounds, width, height)
  // 直接使用 Chromium 原生 nativeImage 裁剪与 PNG 编码，绕过 getBitmap() 在 Retina
  // 显示器上返回物理像素与 getSize() 逻辑点数不匹配导致的像素错乱问题。
  return snapshot.image.crop(rect).toPNG()
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
  if (process.platform === 'win32') {
    // Windows 优先 GDI 原生采集；失败回退 helper exe / PowerShell，避免 DXGI 行错位彩条。
    const captured = await captureWindowsOcrRegion(bounds)
    await logOcrCaptureDiagnostic(captured.png, bounds, captured.source)
    return captured.png
  }
  const image = await captureRegionAsPng(bounds, { ocrScale: 1 }, {
    getSources: (options) => desktopCapturer.getSources(options as SourcesOptions),
    getDisplayNearestPoint: (point) => screen.getDisplayNearestPoint(point),
    getPrimaryDisplay: () => screen.getPrimaryDisplay(),
    platform: process.platform
  })
  await logOcrCaptureDiagnostic(image.png, bounds, 'electron-desktopCapturer')
  return image.png
}

/**
 * 从已采集的 OCR 屏幕快照中裁剪用户确认的区域，并保持原始分辨率。
 *
 * 本入口是翻译流程的专用路径，成功裁剪后会消费（释放）快照；识别、复制图片与保存图片
 * 走的 cropCurrentOcrSelectionPng / cropCurrentOcrSelectionPngFast 只读不消费，
 * 保证同一会话内这些动作可以多次读取同一份快照。
 * @param bounds 用户确认的全局屏幕坐标区域。
 * @returns 原始分辨率的裁剪 PNG 图片字节。
 * @author zhenghq
 */
async function cropOcrSnapshotSelection(bounds: CaptureBounds): Promise<Buffer> {
  const snapshot = latestOcrSnapshot
  if (!snapshot) {
    throw new ScreenCaptureError('no-source', t('error.screenshotExpired'))
  }
  // 只裁选区再编码：整屏 decodePng / encodePng 在 2K/4K 上各要数百毫秒，属于纯浪费。
  const png = cropSnapshotSelectionPng(snapshot, bounds)
  await logOcrCaptureDiagnostic(png, bounds, `${snapshot.source}-crop`)
  latestOcrSnapshot = null
  return png
}

/**
 * 校验截图动作请求负载：动作、请求 ID 与选区矩形必须齐全有效。
 * @param value Renderer 提交的未知请求负载。
 * @returns 校验后的截图动作请求；非法时返回 null。
 * @author zhenghq
 */
function normalizeScreenshotActionRequest(value: unknown): ScreenshotOcrActionRequest | null {
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
function normalizeScreenshotExportImageRequest(
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
 * @returns 是否属于当前会话。
 * @author zhenghq
 */
function isCurrentScreenshotRequest(request: ScreenshotOcrActionRequest): boolean {
  return request.sessionId === ocrSelectionSessionSeq
}

/**
 * 从当前 OCR 屏幕快照中裁剪用户当前调整后的选区，不消费快照、不重新截屏。
 * 识别、复制图片和保存图片统一走此入口，保证三个动作针对同一选区；
 * OCR 放大由后续识别入口统一执行。
 * @param value Renderer 提交的选区矩形（截图窗口内逻辑坐标）。
 * @returns 保持原始分辨率的裁剪 PNG 图片字节。
 * @author zhenghq
 */
function cropCurrentOcrSelectionPng(value: unknown): Buffer {
  const bounds = normalizeOcrSelectionBounds(value)
  if (!bounds) {
    throw new ScreenshotSelectionError('invalid-selection', t('error.invalidSelection'))
  }
  const snapshot = latestOcrSnapshot
  if (!snapshot) {
    throw new ScreenshotSelectionError('snapshot-expired', t('error.screenshotExpired'))
  }
  return cropSnapshotSelectionPng(snapshot, bounds)
}

/**
 * 从当前 OCR 屏幕快照中快速裁剪用户当前调整后的选区：
 * 使用 Chromium 原生 nativeImage 裁剪并编码 PNG，不做 OCR 放大预处理，
 * 避免主线程被 JS 版 PNG 解码与双线性缩放阻塞，供复制/保存动作使用。
 * @param value Renderer 提交的选区矩形（截图窗口内逻辑坐标）。
 * @returns 原分辨率裁剪后的 PNG 图片字节。
 * @author zhenghq
 */
function cropCurrentOcrSelectionPngFast(value: unknown): Buffer {
  const bounds = normalizeOcrSelectionBounds(value)
  if (!bounds) {
    throw new ScreenshotSelectionError('invalid-selection', t('error.invalidSelection'))
  }
  const snapshot = latestOcrSnapshot
  if (!snapshot) {
    throw new ScreenshotSelectionError('snapshot-expired', t('error.screenshotExpired'))
  }
  const { width, height } = snapshot.image.getSize()
  const cropRect = resolveSnapshotCropRect(snapshot.source, bounds, snapshot.bounds, width, height)
  return snapshot.image.crop(cropRect).toPNG()
}

/**
 * 判断截图窗口是否仍然持有指定请求：窗口未销毁且请求未被取消/关闭清理。
 * @param requestId Renderer 生成的请求 ID。
 * @returns 请求是否仍然有效。
 * @author zhenghq
 */
function isScreenshotOcrRequestActive(requestId: string, sessionId: number): boolean {
  return activeScreenshotOcrRequests.get(requestId) === sessionId &&
    sessionId === ocrSelectionSessionSeq &&
    Boolean(ocrSelectionWin && !ocrSelectionWin.isDestroyed())
}

/**
 * 将截图动作异常转换为细分错误码。
 * @param error 捕获到的异常。
 * @returns 截图动作细分错误码。
 * @author zhenghq
 */
function resolveScreenshotActionErrorCode(error: unknown): ScreenshotOcrErrorCode {
  if (error instanceof ScreenshotSelectionError) return error.code
  if (error instanceof OcrEngineError) return error.code
  if (error instanceof ScreenCaptureError) {
    return error.code === 'permission' ? 'permission' : 'snapshot-expired'
  }
  return 'engine-unavailable'
}

/**
 * 向截图窗口发送文字识别结果，仅在请求仍有效时写回，避免旧回调覆盖新会话。
 * @param result 识别结果事件负载。
 * @returns 无返回值。
 * @author zhenghq
 */
function sendScreenshotRecognizeResult(result: {
  requestId: string
  sessionId?: number
  ok: boolean
  text?: string
  engine?: 'system' | 'paddle' | 'tesseract'
  code?: ScreenshotOcrErrorCode
  error?: string
}): void {
  const sessionId = result.sessionId ?? ocrSelectionSessionSeq
  if (!isScreenshotOcrRequestActive(result.requestId, sessionId)) return
  ocrSelectionWin?.webContents.send('ocr-selection:recognize-result', { ...result, sessionId })
}

/**
 * 向截图窗口发送图片复制/保存动作反馈，仅在请求仍有效时写回。
 * @param result 动作反馈事件负载。
 * @returns 无返回值。
 * @author zhenghq
 */
function sendScreenshotActionResult(result: {
  requestId: string
  sessionId?: number
  action: 'copy-image' | 'save-image'
  ok: boolean
  canceled?: boolean
  filePath?: string
  code?: ScreenshotOcrErrorCode
  error?: string
}): void {
  const sessionId = result.sessionId ?? ocrSelectionSessionSeq
  if (!isScreenshotOcrRequestActive(result.requestId, sessionId)) return
  ocrSelectionWin?.webContents.send('ocr-selection:action-result', { ...result, sessionId })
}

/**
 * 处理截图“文字识别”动作：裁剪当前选区并执行 OCR，只回传文本、引擎与错误状态。
 * 截图窗口保持打开，原始 PNG 不发送给 Renderer。
 * @param value Renderer 提交的截图动作请求负载。
 * @returns 识别流程完成后的 Promise。
 * @author zhenghq
 */
async function recognizeOcrSelectionAction(value: unknown): Promise<void> {
  const request = normalizeScreenshotActionRequest(value)
  if (!request || !isCurrentScreenshotRequest(request)) return
  const settings = getSettings()
  try {
    // 先归一化到全局屏幕坐标，缓存键与翻译动作使用同一坐标系；
    // 若等到识别结束后再归一化，期间窗口移动会让两边键不一致而永远无法命中。
    const sessionBounds = normalizeOcrSelectionBounds(request.bounds)
    const png = cropCurrentOcrSelectionPng(request.bounds)
    const dispatcher = await createOcrDispatcher(settings)
    const ocr = await recognizeAdaptiveOcr(
      {
        imageBytes: png,
        maxScale: settings.ocrScale,
        language: settings.ocrLang
      },
      {
        recognize: (preparedImageBytes) =>
          dispatcher.recognize({
            imageBytes: preparedImageBytes,
            language: settings.ocrLang,
            timeoutMs: OCR_TIMEOUT_MS
          }, resolveOcrEnginePreference(settings))
      }
    )
    const text = cleanOcrText(ocr.text ?? '')
    // 只有非空文本才写入会话缓存：空结果可能是引擎瞬时波动，
    // 缓存它会让后续翻译直接判空，失去重试机会。
    if (text) {
      if (sessionBounds) {
        ocrSessionResultCache.set(
          buildOcrSessionResultKey(request.sessionId, sessionBounds, settings),
          // 缓存原始识别结果：翻译管道会重新清洗并计算质量分，
          // 若提前写入清洗文本会丢失弹窗用于排查的 ocrRawText。
          ocr
        )
      }
    }
    sendScreenshotRecognizeResult(
      text
        ? { requestId: request.requestId, sessionId: request.sessionId, ok: true, text, engine: ocr.engine }
        : { requestId: request.requestId, sessionId: request.sessionId, ok: false, code: 'empty', error: t('error.noRecognizedText') }
    )
  } catch (error) {
    sendScreenshotRecognizeResult({
      requestId: request.requestId,
      sessionId: request.sessionId,
      ok: false,
      code: resolveScreenshotActionErrorCode(error),
      error: error instanceof Error ? error.message : t('error.ocrFailed')
    })
  } finally {
    activeScreenshotOcrRequests.delete(request.requestId)
  }
}

/**
 * 处理截图“翻译”动作：沿用现有截图 OCR 翻译流程，隐藏截图窗口并打开翻译窗口。
 * @param value Renderer 提交的截图动作请求负载。
 * @returns 翻译流程完成后的 Promise。
 * @author zhenghq
 */
async function translateOcrSelectionAction(value: unknown): Promise<void> {
  const request = normalizeScreenshotActionRequest(value)
  if (!request || !isCurrentScreenshotRequest(request)) return
  activeScreenshotOcrRequests.clear()
  await submitOcrSelection(request.bounds)
}

/**
 * 处理截图“复制图片”动作：将当前选区 PNG 写入系统图片剪贴板，成功后退出截图。
 * @param value Renderer 提交的截图动作请求负载。
 * @returns 复制流程完成后的 Promise。
 * @author zhenghq
 */
async function copyOcrSelectionImageAction(value: unknown): Promise<void> {
  const request = normalizeScreenshotActionRequest(value)
  if (!request || !isCurrentScreenshotRequest(request)) return
  try {
    // 复制图片使用原分辨率与 Chromium 原生裁剪，跳过 OCR 放大预处理以保持主线程响应。
    const png = cropCurrentOcrSelectionPngFast(request.bounds)
    clipboard.writeImage(nativeImage.createFromBuffer(png))
    sendScreenshotActionResult({
      requestId: request.requestId,
      sessionId: request.sessionId,
      action: 'copy-image',
      ok: true
    })
    // 复制成功后结束截图会话：先释放快照与全局划词监听，
    // 提示由独立 toast 窗口展示，覆盖窗口由 Renderer 收到回执后淡出关闭。
    showScreenshotToast(t('toast.copiedToClipboard'), 1500)
    finishScreenshotSession()
  } catch (error) {
    sendScreenshotActionResult({
      requestId: request.requestId,
      sessionId: request.sessionId,
      action: 'copy-image',
      ok: false,
      code: error instanceof ScreenshotSelectionError || error instanceof ScreenCaptureError
        ? resolveScreenshotActionErrorCode(error)
        : 'clipboard-write-failed',
      error: error instanceof Error ? error.message : t('error.copyImageFailed')
    })
  } finally {
    activeScreenshotOcrRequests.delete(request.requestId)
  }
}

/**
 * 生成截图保存的默认 PNG 文件名（带时间戳）。
 * @returns 默认文件名。
 * @author zhenghq
 */
function buildScreenshotSaveFileName(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${t('screenshot.defaultFileNamePrefix')}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`
}

/**
 * 处理截图“保存到本地”动作：先弹出系统保存对话框，用户确认路径后再裁剪当前选区并写入 PNG，
 * 避免大图编码阻塞保存地址框的显示；取消对话框不视为错误并保持窗口打开，保存成功后退出截图。
 * @param value Renderer 提交的截图动作请求负载。
 * @returns 保存流程完成后的 Promise。
 * @author zhenghq
 */
async function saveOcrSelectionImageAction(value: unknown): Promise<void> {
  const request = normalizeScreenshotActionRequest(value)
  if (!request || !isCurrentScreenshotRequest(request)) return
  try {
    const win = ocrSelectionWin && !ocrSelectionWin.isDestroyed() ? ocrSelectionWin : undefined
    const result = win
      ? await dialog.showSaveDialog(win, {
          defaultPath: buildScreenshotSaveFileName(),
          filters: [{ name: t('screenshot.pngFilter'), extensions: ['png'] }]
        })
      : await dialog.showSaveDialog({
          defaultPath: buildScreenshotSaveFileName(),
        filters: [{ name: t('screenshot.pngFilter'), extensions: ['png'] }]
      })
    // 保存对话框阻塞期间窗口可能已关闭或请求已失效，仅写回仍有效的请求。
    if (result.canceled || !result.filePath) {
      sendScreenshotActionResult({
        requestId: request.requestId,
        sessionId: request.sessionId,
        action: 'save-image',
        ok: true,
        canceled: true
      })
      return
    }
    if (!isScreenshotOcrRequestActive(request.requestId, request.sessionId)) return
    // 用户确认路径后再执行同步裁剪和 PNG 编码，避免保存地址框出现前被大图处理阻塞。
    // 保存图片使用原分辨率与 Chromium 原生裁剪，跳过 OCR 放大预处理。
    const png = cropCurrentOcrSelectionPngFast(request.bounds)
    await writeFile(result.filePath, png)
    sendScreenshotActionResult({
      requestId: request.requestId,
      sessionId: request.sessionId,
      action: 'save-image',
      ok: true,
      filePath: result.filePath
    })
    // 保存成功后结束截图会话：先释放快照与全局划词监听，
    // 提示由独立 toast 窗口展示，覆盖窗口由 Renderer 收到回执后淡出关闭。
    showScreenshotToast(t('toast.savedToDisk'), 1500)
    finishScreenshotSession()
  } catch (error) {
    sendScreenshotActionResult({
      requestId: request.requestId,
      sessionId: request.sessionId,
      action: 'save-image',
      ok: false,
      code: error instanceof ScreenshotSelectionError || error instanceof ScreenCaptureError
        ? resolveScreenshotActionErrorCode(error)
        : 'save-failed',
      error: error instanceof Error ? error.message : t('error.saveImageFailed')
    })
  } finally {
    activeScreenshotOcrRequests.delete(request.requestId)
  }
}

/**
 * 处理带标注截图“复制图片”动作：校验 Renderer 合成的 PNG 后写入系统剪贴板。
 * @param value Renderer 提交的带标注导出请求。
 * @returns 复制流程完成后的 Promise。
 * @author zhenghq
 */
async function copyAnnotatedOcrSelectionImageAction(value: unknown): Promise<void> {
  const validated = validateAnnotatedExportPayload(value)
  if (!validated.ok) {
    sendScreenshotActionResult({
      requestId: typeof (value as { requestId?: unknown })?.requestId === 'string'
        ? (value as { requestId: string }).requestId
        : '',
      action: 'copy-image',
      ok: false,
      code: 'invalid-export-payload',
      error: validated.error
    })
    return
  }
  const request = validated.request
  if (!isCurrentScreenshotRequest(request)) return
  try {
    clipboard.writeImage(nativeImage.createFromBuffer(request.png))
    sendScreenshotActionResult({
      requestId: request.requestId,
      sessionId: request.sessionId,
      action: 'copy-image',
      ok: true
    })
    showScreenshotToast(t('toast.copiedToClipboard'), 1500)
    finishScreenshotSession()
  } catch (error) {
    sendScreenshotActionResult({
      requestId: request.requestId,
      sessionId: request.sessionId,
      action: 'copy-image',
      ok: false,
      code: 'clipboard-write-failed',
      error: error instanceof Error ? error.message : t('error.copyImageFailed')
    })
  } finally {
    activeScreenshotOcrRequests.delete(request.requestId)
  }
}

/**
 * 处理带标注截图“保存到本地”动作：校验 PNG、弹出保存对话框并写入文件。
 * @param value Renderer 提交的带标注导出请求。
 * @returns 保存流程完成后的 Promise。
 * @author zhenghq
 */
async function saveAnnotatedOcrSelectionImageAction(value: unknown): Promise<void> {
  const validated = validateAnnotatedExportPayload(value)
  if (!validated.ok) {
    sendScreenshotActionResult({
      requestId: typeof (value as { requestId?: unknown })?.requestId === 'string'
        ? (value as { requestId: string }).requestId
        : '',
      action: 'save-image',
      ok: false,
      code: 'invalid-export-payload',
      error: validated.error
    })
    return
  }
  const request = validated.request
  if (!isCurrentScreenshotRequest(request)) return
  try {
    const win = ocrSelectionWin && !ocrSelectionWin.isDestroyed() ? ocrSelectionWin : undefined
    const result = win
      ? await dialog.showSaveDialog(win, {
          defaultPath: buildScreenshotSaveFileName(),
          filters: [{ name: t('screenshot.pngFilter'), extensions: ['png'] }]
        })
      : await dialog.showSaveDialog({
          defaultPath: buildScreenshotSaveFileName(),
          filters: [{ name: t('screenshot.pngFilter'), extensions: ['png'] }]
        })
    if (result.canceled || !result.filePath) {
      sendScreenshotActionResult({
        requestId: request.requestId,
        sessionId: request.sessionId,
        action: 'save-image',
        ok: true,
        canceled: true
      })
      return
    }
    if (!isScreenshotOcrRequestActive(request.requestId, request.sessionId)) return
    await writeFile(result.filePath, request.png)
    sendScreenshotActionResult({
      requestId: request.requestId,
      sessionId: request.sessionId,
      action: 'save-image',
      ok: true,
      filePath: result.filePath
    })
    showScreenshotToast(t('toast.savedToDisk'), 1500)
    finishScreenshotSession()
  } catch (error) {
    sendScreenshotActionResult({
      requestId: request.requestId,
      sessionId: request.sessionId,
      action: 'save-image',
      ok: false,
      code: 'save-failed',
      error: error instanceof Error ? error.message : t('error.saveImageFailed')
    })
  } finally {
    activeScreenshotOcrRequests.delete(request.requestId)
  }
}

/**
 * 处理 OCR 框选提交：截图、识别、翻译并展示弹窗。
 * @param value Renderer 提交的选区。
 * @returns 翻译流程完成后的 Promise。
 * @author zhenghq
 */
async function submitOcrSelection(value: unknown): Promise<void> {
  const bounds = normalizeOcrSelectionBounds(value)
  // 恢复自身幂等且不依赖窗口可见状态，避免任何早退路径把全局钩子留在停用状态。
  const restoreSelectionListener = (): void => {
    restoreSelectionListenerAfterOcr()
  }
  if (!bounds) {
    latestOcrSnapshot = null
    ocrSessionResultCache.clear()
    hideOcrSelectionWindow()
    restoreSelectionListener()
    return
  }
  const settings = getSettings()
  const requestId = ++latestTranslationRequest
  const anchor = { x: bounds.x + bounds.width, y: bounds.y + bounds.height }
  const closeVersion = getPopupCloseVersion()
  // 缓存键里的会话序号必须与识别动作写入时一致；提交时该序号仍是当前会话。
  const sessionId = ocrSelectionSessionSeq
  // 会话识别结果必须在显示 loading 之前取出：一来命中时可以给出准确的提示文案，
  // 二来即使 hide 事件同步派发也不影响已取到的结果。
  const cached = ocrSessionResultCache.get(
    buildOcrSessionResultKey(sessionId, bounds, settings)
  )
  const showLoadingPopup = (original = t('selection.loadingRecognizing')): void => {
    showPopup({
      ok: true,
      origin: 'ocr',
      requestId,
      loading: true,
      original,
      sourcePreference: settings.sourceLang,
      targetPreference: settings.targetLang,
      targetLang: settings.targetLang
    }, 0, anchor)
  }
  // macOS 上覆盖窗口是应用内最后一个 key window：一旦隐藏，系统会把应用内下一个窗口
  // （通常是设置页）提升为 key window 并顶到其它应用之上。
  // 因此先显示「正在识别」弹窗接管 key window，再收起覆盖窗口；
  // 弹窗层级低于覆盖窗口（floating < screen-saver），先显示不会在覆盖层上露出。
  // 其它平台保持原顺序：立即收起覆盖窗口，采集完成后再显示弹窗。
  if (isMac) showLoadingPopup(cached ? t('selection.loadingTranslating') : undefined)
  hideOcrSelectionWindow()
  try {
    // 命中会话识别结果时直接进入翻译管道：同一会话、同一选区、同一 OCR 设置下
    // 重识别只会得到相同文本，白白多花 200–600ms。查询必须早于裁剪，因为
    // cropOcrSnapshotSelection 会消费快照；直接翻译（未先识别）时缓存为空，仍走原路径。
    if (cached) {
      ocrSessionResultCache.clear()
      // 命中路径跳过了 cropOcrSnapshotSelection，必须在这里显式释放快照，
      // 否则翻译结束后整屏快照会一直驻留到下一次会话开始。
      latestOcrSnapshot = null
      // 与未命中路径一致：无论 hide 事件是否同步派发，都显式恢复普通划词监听。
      restoreSelectionListener()
      // 未命中路径在裁剪完成后为 Windows 显示 loading 弹窗；命中路径跳过了裁剪，
      // 这里补上同样的反馈，避免翻译期间界面上没有任何进度提示。
      if (!isMac) showLoadingPopup(t('selection.loadingTranslating'))
      const cachedResult = await translateRecognizedOcrResult(cached, settings)
      if (requestId !== latestTranslationRequest || closeVersion !== getPopupCloseVersion()) return
      showOcrTranslationResult(cachedResult, settings, requestId, anchor)
      return
    }
    const imageBytes = await cropOcrSnapshotSelection(bounds)
    restoreSelectionListener()
    if (!isMac) showLoadingPopup()
    const result = await processOcrImageBytes(imageBytes, settings)
    if (requestId !== latestTranslationRequest || closeVersion !== getPopupCloseVersion()) return
    showOcrTranslationResult(result, settings, requestId, anchor)
  } catch (error) {
    latestOcrSnapshot = null
    ocrSessionResultCache.clear()
    restoreSelectionListener()
    if (requestId !== latestTranslationRequest || closeVersion !== getPopupCloseVersion()) return
    const code = resolveOcrErrorCode(error)
    const message = error instanceof Error ? error.message : t('error.ocrFailed')
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
  // 与手动翻译一致：显示弹窗前先记录源应用，供弹窗隐藏时交还前台。
  await rememberFrontmostAppIfInactiveAsync()
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
      error: t('error.noClipboardImage'),
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
    original: t('selection.loadingClipboardImage'),
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
    const message = error instanceof Error ? error.message : t('error.ocrFailed')
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
  const validationError = validateManualTranslationText(text, mainI18n?.translator)
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
  lowerSettingsPanelRaiseLevel()
  invalidateSelectionFlowWithFocusCleanup()
  selectionCapture.invalidate()
  hideSelectionButton()
  selectionListenerController.setMode(getSettings().triggerMode)
  if (getSettings().triggerMode !== 'hotkey' && !selectionListenerController.isRunning()) {
    console.warn('[autoTrigger] 划词监听未能启动，划词与双击将不可用，快捷键仍可使用')
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
        error: t('error.accessibilityPermissionAuto'),
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

/**
 * 重启 macOS hiservices 系统服务，修复模拟按键注入失效。
 * hiservices 半故障时所有第三方应用的 CGEvent/System Events 注入都会到不了前台，
 * 表现为划词取词反复超时；杀掉该服务后系统会自动重启并恢复注入。
 * @returns 修复命令执行完成的 Promise。
 * @author zhenghq
 */
function restartMacHiServices(): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile('pkill', ['-9', '-f', 'com.apple.hiservices-xpcservice'], (error) => {
      // pkill 返回 1 表示未找到进程，此时仍重建应用侧监听，避免控制器保留失效状态。
      if (error && error.code !== 1) {
        resolve({ ok: false, error: error.message })
        return
      }
      setTimeout(() => {
        selectionListenerController.restart()
        resolve({ ok: true })
      }, 500)
    })
  })
}

/** hiservices 修复流程是否正在执行，避免连续超时重复重启服务。 */
let hiServicesRepairRunning = false

/**
 * 执行一次 macOS hiservices 自动修复。
 *
 * 该路径完全静默：不显示原生对话框，也不调用应用级前台交还，避免修复动作
 * 本身把设置页或其它自有窗口提升到前台。执行期间只记录日志。
 * @returns 修复流程完成后的 Promise。
 * @author zhenghq
 */
async function autoRepairMacHiServices(): Promise<void> {
  if (hiServicesRepairRunning || process.platform !== 'darwin') return
  hiServicesRepairRunning = true
  resetCopyTimeoutTracker()
  try {
    console.warn('[main] 连续取词超时，自动重启 macOS hiservices 服务')
    const repairResult = await restartMacHiServices()
    if (repairResult.ok) {
      console.log('[main] macOS hiservices 自动修复完成')
    } else {
      console.error('[main] macOS hiservices 自动修复失败:', repairResult.error)
    }
  } finally {
    resetCopyTimeoutTracker()
    // 重启监听与系统服务重建可能派发迟到的内部 activate；修复结束前续期一次，
    // 避免该 activate 在 hiServicesRepairRunning 复位后被误判为 Dock 点击。
    suppressSelectionActivationWindowGap()
    hiServicesRepairRunning = false
  }
}

/**
 * 从托盘菜单手动执行一次 hiservices 修复。
 * @returns 修复流程完成后的 Promise。
 * @author zhenghq
 */
async function repairMacHiServicesManually(): Promise<void> {
  await autoRepairMacHiServices()
}

// ---- 设置窗口 ----

/**
 * 等待窗口完成首帧渲染，确保页面已应用持久化主题后再上屏。
 * @param win 待显示的窗口。
 * @returns 窗口可以安全显示时完成的 Promise。
 * @author zhenghq
 */
function whenWindowReadyToShow(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (!win.isDestroyed()) {
        win.removeListener('ready-to-show', finish)
        win.removeListener('closed', finish)
        win.webContents.removeListener('did-fail-load', finish)
      }
      resolve()
    }
    win.once('ready-to-show', finish)
    win.once('closed', finish)
    win.webContents.once('did-fail-load', finish)
    // 渲染进程异常崩溃时 ready-to-show 与 did-fail-load 都不会触发，兜底超时避免窗口永不显示。
    timer = setTimeout(finish, 2000)
  })
}

/**
 * 把自有窗口提升为可交互窗口，只影响目标窗口自身。
 *
 * macOS 上窗口层级单位是应用：调用 app.focus() 会把同应用所有可见窗口一起
 * 提到最前。内部窗口置前一律走本入口，禁止在窗口置前路径调用 app.focus()。
 * 设置页与网页阅读器已回退普通 BrowserWindow，显式置前需要先 show() 让
 * 目标窗口自身成为可交互窗口，再 moveTop()/focus()；翻译弹窗等非激活 panel
 * 才继续使用 showInactive() 保持不激活应用的语义。
 * @param win 待提升的自有窗口。
 * @param options.focus 是否让目标窗口取得键盘焦点；缺省为 true。
 * @param options.restore 是否先恢复最小化窗口；缺省为 true。
 * @param options.moveTop 是否在 macOS 上用 moveTop() 把目标窗口提到 z-order 最前；缺省为 true。
 * @param options.raiseLevel 是否在 macOS 上临时把面板提升到 screen-saver 层级；缺省为 false。
 * @returns 无返回值。
 * @author zhenghq
 */
function showOwnWindowForInteraction(
  win: BrowserWindow,
  options: { focus?: boolean; restore?: boolean; moveTop?: boolean; raiseLevel?: boolean } = {}
): void {
  if (win.isDestroyed()) return
  const focus = options.focus ?? true
  const restore = options.restore ?? true
  const moveTop = options.moveTop ?? true
  const raiseLevel = options.raiseLevel ?? false
  if (restore && win.isMinimized()) win.restore()
  // nonactivating panel 的 show() 只让窗口成为 key window，不会激活应用。
  // 若仍保持 normal level，它会排在当前前台应用窗口之后，用户看到 isFocused=true
  // 却看不到窗口。floating 仍可能被当前前台应用的普通窗口压住，显式入口必须临时
  // 提升到 screen-saver，确保不激活应用也能把目标窗口越过当前前台应用。
  if (isMac && raiseLevel) {
    win.setAlwaysOnTop(true, 'screen-saver')
    // 设置页与网页阅读器共用本入口，回收器必须知道本次被提升的是哪个窗口；
    // 否则阅读器提升后无法在定时器或划词入口降回普通层级。
    raisedInteractionWindows.add(win)
    scheduleSettingsPanelRaiseLevelReset()
  }
  // 当前统一入口只服务设置页与网页阅读器，两者都是普通 BrowserWindow。
  // 普通窗口显式置前必须使用 show() 让目标窗口成为可交互窗口；showInactive()
  // 不会取得键盘焦点，窗口会继续留在其它应用后面。翻译弹窗等非激活 panel
  // 仍由各自模块直接 showInactive()，不经过本入口。
  win.show()
  // moveTop() 只调整目标窗口自身的 z-order，不激活应用，也不会拉起同应用
  // 其它可见窗口，因此能补齐“显式打开窗口放到最前”的窗口级语义。
  if (isMac && moveTop) win.moveTop()
  if (focus) win.focus()
}

/** 曾通过统一入口临时提升到最高层级的自有窗口；回收后自动清空。 */
const raisedInteractionWindows = new Set<BrowserWindow>()

/**
 * 输出设置窗口在 macOS panel 置前流程中的状态，供真机排查层级与焦点问题。
 * @param phase 当前置前阶段。
 * @returns 无返回值。
 * @author zhenghq
 */
function logSettingsPanelBringToFront(phase: string): void {
  if (!isMac || !settingsWin || settingsWin.isDestroyed()) return
  console.log(
    '[main] 设置页置前阶段:',
    phase,
    JSON.stringify({
      isVisible: settingsWin.isVisible(),
      isFocused: settingsWin.isFocused(),
      isMinimized: settingsWin.isMinimized(),
      isAlwaysOnTop: settingsWin.isAlwaysOnTop(),
      bounds: settingsWin.getBounds(),
      appActive: isMacAppActiveByEvents()
    })
  )
}

/** 设置页临时置顶层级的自动回收定时器；重复显式置前时重置。 */
let settingsPanelRaiseLevelTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 立即把设置页从临时置顶层级降回普通窗口语义。
 *
 * 显式置前会临时把设置页提升到 screen-saver，以保证 nonactivating panel
 * 能越过当前前台应用；该层级只服务于一次显式置前，不能在划词等内部流程中残留。
 * 本函数可被有界定时器、设置页失焦和划词入口共同调用，重复调用是幂等的。
 * @returns 无返回值。
 * @author zhenghq
 */
function lowerSettingsPanelRaiseLevel(): void {
  if (!isMac) return
  if (settingsPanelRaiseLevelTimer) {
    clearTimeout(settingsPanelRaiseLevelTimer)
    settingsPanelRaiseLevelTimer = null
  }
  for (const win of raisedInteractionWindows) {
    if (win.isDestroyed()) {
      raisedInteractionWindows.delete(win)
      continue
    }
    if (win.isAlwaysOnTop()) win.setAlwaysOnTop(false)
  }
  raisedInteractionWindows.clear()
}

/**
 * 为设置页的临时置顶层级安排有界回收。
 *
 * 不能只依赖 blur：nonactivating panel 获得键盘焦点后，系统可能不会在切到
 * 其它应用时派发 blur，导致设置页长期保持 screen-saver 层级，划词时浮到最前。
 * 定时器到期后无条件降级，保证层级只服务于本次显式置前。
 * @returns 无返回值。
 * @author zhenghq
 */
function scheduleSettingsPanelRaiseLevelReset(): void {
  if (!isMac) return
  if (settingsPanelRaiseLevelTimer) clearTimeout(settingsPanelRaiseLevelTimer)
  settingsPanelRaiseLevelTimer = setTimeout(() => {
    settingsPanelRaiseLevelTimer = null
    for (const win of raisedInteractionWindows) {
      if (!win.isDestroyed()) win.setAlwaysOnTop(false)
    }
    raisedInteractionWindows.clear()
  }, SETTINGS_PANEL_RAISE_LEVEL_TIMEOUT_MS)
}

/**
 * 创建或复用设置窗口。
 * @param bringToFront 是否把设置窗口置前并聚焦；仅后台建窗等非用户入口传 false。
 * @param source 打开来源；弹窗内显式点击时传 `popup`，允许越过划词自动置前保护。
 * @returns 设置窗口实例。
 * @author zhenghq
 */
async function createSettingsWindow(
  bringToFront: boolean,
  source?: 'popup'
): Promise<BrowserWindow> {
  // 弹窗内点击设置入口是显式用户操作。hidePopupForInternalWindowSwitch() 会续期
  // 划词 activate 抑制，但该抑制只用于拦截划词流程的自动 activate；用户此刻主动
  // 点击设置页必须豁免，否则设置窗口会保持后台层级，看起来“没有拉到最前”。
  const explicitPopupSource = source === 'popup'
  // 记录本次显式置前的代际：划词动作会在 suppressSelectionActivationWindowGap()
  // 中递增代际，使已经进入 await 等待的旧置前动作在收尾时自动失效。
  const bringToFrontEpochAtStart = settingsBringToFrontEpoch
  if (settingsWin && !settingsWin.isDestroyed()) {
    const existingWindow = settingsWin
    await refreshMacOSDockVisibility()
    if (settingsWin !== existingWindow || existingWindow.isDestroyed()) return existingWindow
    // 最小化的窗口 isVisible() 仍为 true，必须先恢复再聚焦，否则 Dock 激活看似无反应。
    if (settingsWin.isMinimized()) {
      // 划词已经开始（或本次置前已被新划词代际失效）时不得恢复并置前：
      // restore() 会把窗口重新排到前台应用之上，连带把阅读器一起带上来。
      if (
        bringToFront &&
        !explicitPopupSource &&
        (bringToFrontEpochAtStart !== settingsBringToFrontEpoch ||
          isSelectionWindowRaiseGuardActive())
      ) {
        return settingsWin
      }
      showOwnWindowForInteraction(settingsWin, { raiseLevel: bringToFront })
      return settingsWin
    }
    if (settingsWin.isVisible()) {
      // 内部 activate 只负责让设置页存在，不把已可见窗口强制置前。
      if (!bringToFront) return settingsWin
      // 用户已经开始划词时，本次置前已经过期：只保持可见，不 moveTop/focus。
      if (
        !explicitPopupSource &&
        (bringToFrontEpochAtStart !== settingsBringToFrontEpoch ||
          isSelectionWindowRaiseGuardActive())
      ) {
        return settingsWin
      }
      // 只提升设置窗口自身，不激活整个应用，避免把翻译弹窗一起带到最前。
      // activate 路径（非弹窗内显式点击）不得把已可见设置页提升到 screen-saver：
      // 真机日志显示迟到 activate 误放行后，正是这里对普通窗口执行
      // show()+moveTop()+focus()+screen-saver，把设置页顶到划词应用之上。最高
      // 层级只保留给弹窗内显式点击等真实用户入口，activate 路径改用窗口级
      // moveTop() 表达“放到最前”，不再越过整个前台应用。
      logCandidateProbe('settings-reuse-raise', settingsWin.isVisible())
      showOwnWindowForInteraction(settingsWin, { raiseLevel: explicitPopupSource })
      return settingsWin
    }
    // 窗口可能被用户隐藏后重新打开，只提升设置窗口自身。
    if (
      bringToFront &&
      !explicitPopupSource &&
      (bringToFrontEpochAtStart !== settingsBringToFrontEpoch ||
        isSelectionWindowRaiseGuardActive())
    ) {
      return settingsWin
    }
    showOwnWindowForInteraction(settingsWin, { raiseLevel: bringToFront })
    return settingsWin
  }

  const createdWindow = new BrowserWindow({
    width: 900,
    height: 820,
    minWidth: 640,
    minHeight: 600,
    title: t('settings.windowTitle'),
    frame: false,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    show: false,
    backgroundColor: '#f5f7fa',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  settingsWin = createdWindow
  // 必须在 loadRendererHtml 之前挂载监听，否则页面加载过快会漏掉 ready-to-show。
  const readyToShow = whenWindowReadyToShow(createdWindow)

  if (process.platform === 'win32') settingsWin.removeMenu()
  loadRendererHtml(settingsWin, 'settings.html')
  // 设置页切换 Tab、拖拽滚动条或输入控件时，macOS 可能在窗口边界切换处漏发 mouseup。
  // 焦点事件可能晚于外部应用的 mousedown 到达，清理必须限定为起始于设置窗口内部的手势。
  settingsWin.on('focus', () => {
    // 从翻译弹窗打开设置时，必须保证设置窗口取得焦点后仍处于保护期：
    // 复用已可见窗口可能不再派发 focus，因此 IPC 入口已提前开启保护，
    // 这里再次开启用于重置状态，确保随后到达的弹窗 blur 一定被吸收。
    beginPopupSettingsOpenGuard()
    const settingsBounds = settingsWin && !settingsWin.isDestroyed()
      ? settingsWin.getBounds()
      : undefined
    resetAutoTriggerPointerState(settingsBounds)
  })
  settingsWin.on('blur', () => {
    // 显式置前时临时提升的 screen-saver 层级必须在失焦后归还普通窗口语义，
    // 否则设置页会长期悬浮在其它应用之上。
    if (isMac && !createdWindow.isDestroyed()) {
      lowerSettingsPanelRaiseLevel()
    }
    // 设置窗口失焦说明焦点已经离开应用内部窗口切换阶段，恢复弹窗正常的外部点击语义。
    endPopupSettingsOpenGuard()
    const settingsBounds = settingsWin && !settingsWin.isDestroyed()
      ? settingsWin.getBounds()
      : undefined
    resetAutoTriggerPointerState(settingsBounds)
  })
  settingsWin.on('hide', () => {
    // 隐藏后设置窗口不再接收点击，必须解除保护，避免弹窗永久忽略失焦。
    endPopupSettingsOpenGuard()
    const settingsBounds = settingsWin && !settingsWin.isDestroyed()
      ? settingsWin.getBounds()
      : undefined
    resetAutoTriggerPointerState(settingsBounds)
  })
  settingsWin.on('closed', () => {
    // 窗口销毁后不会再有失焦/隐藏事件，必须在此清理窗口级状态。
    lowerSettingsPanelRaiseLevel()
    endPopupSettingsOpenGuard()
    resetAutoTriggerPointerState()
    if (settingsWin === createdWindow) {
      settingsWin = null
    }
    void refreshMacOSDockVisibility()
  })
  // 主题运行时需异步读取主进程设置，若在首帧渲染前 show()，用户会先看到默认主题
  // 再切回已保存主题。等待首帧就绪让页面带着持久化主题一次性上屏。
  await readyToShow
  if (settingsWin !== createdWindow || createdWindow.isDestroyed()) return createdWindow
  // 首帧就绪等待期间用户可能已经开始划词。此时禁止走显式置前：macOS panel 的
  // showInactive()/moveTop()/focus() 都会把设置页排到当前前台应用之上，进而把
  // 同应用的阅读器一起带上来。改用不提升层级、不聚焦的 show()，panel 既不激活
  // 应用也不会越过前台应用，只让设置窗口安静上屏；后续 Dock 刷新与最终置前同样
  // 受保护期约束，不会再把窗口顶到最前。
  if (
    !explicitPopupSource &&
    (bringToFrontEpochAtStart !== settingsBringToFrontEpoch ||
      isSelectionWindowRaiseGuardActive() ||
      selectionInteraction.snapshot().state !== 'idle')
  ) {
    showOwnWindowForInteraction(settingsWin, { focus: false, moveTop: false, raiseLevel: false })
    await refreshMacOSDockVisibility()
    return createdWindow
  }
  // panel 的 show()/focus() 只让设置窗口自身成为 key window，不激活应用。
  // 非显式后台建窗时 bringToFront 为 false：只让窗口存在，不抢焦点、
  // 不用 moveTop 越过用户当前正在使用的应用；启动首开等显式入口才置前。
  showOwnWindowForInteraction(settingsWin, {
    focus: bringToFront,
    moveTop: bringToFront,
    raiseLevel: bringToFront
  })
  // 必须等设置窗口真正显示后再刷新 Dock 呈现：新建分支的 settingsWin 在首帧前
  // 已非空但窗口不可见，若提前切到 accessory 并 dock.hide()，窗口会被系统吞掉，
  // 启动时的设置页会因此一直不出现。显示后再刷新可让保留逻辑兜住可见窗口。
  await refreshMacOSDockVisibility()
  if (settingsWin !== createdWindow || createdWindow.isDestroyed()) return createdWindow
  // Dock 策略切换会重排窗口层级；刷新后必须再走一次统一置前入口，保证启动首开
  // 的设置页最终位于 z-order 最前，而不是只恢复可见性。
  if (bringToFront) {
    // app.setActivationPolicy()/dock.hide() 对窗口层级的重排可能在当前 tick 之后
    // 才完全生效。让出一轮事件循环后做最终置前，避免紧随其后的 moveTop 被系统覆盖。
    await yieldToEventLoop()
    if (settingsWin !== createdWindow || createdWindow.isDestroyed()) return createdWindow
    // 等待期间用户可能已经开始划词。此时绝不能再 moveTop()/focus()，否则会把
    // 设置页顶到用户正在划词的其它应用之上，正是本变更要消除的偶现根因。
    if (
      !explicitPopupSource &&
      (bringToFrontEpochAtStart !== settingsBringToFrontEpoch ||
        isSelectionWindowRaiseGuardActive())
    ) {
      return createdWindow
    }
    showOwnWindowForInteraction(settingsWin, { raiseLevel: true })
    logSettingsPanelBringToFront('initial-launch-final')
  }
  return settingsWin
}

/**
 * 打开设置窗口。
 * @param options 打开选项；`bringToFront` 为 false 时复用已可见窗口不会强制置顶。
 * @param options.source 打开来源；弹窗内显式点击时传 `popup`。
 * @returns 无返回值。
 * @author zhenghq
 */
async function openSettings(options: { bringToFront?: boolean; source?: 'popup' } = {}): Promise<void> {
  await createSettingsWindow(options.bringToFront ?? true, options.source)
}

/**
 * 处理从翻译弹窗发起的打开设置请求。
 *
 * 设置窗口 show()/focus() 会抢走翻译弹窗焦点，弹窗因此收到一次 blur。
 * 必须在创建/聚焦设置窗口之前开启失焦保护，覆盖 blur 早于设置窗口 focus
 * 到达的平台事件顺序，避免翻译弹窗把这次应用内部窗口切换误判为点击外部
 * 并自动关闭。保护由设置窗口的 focus/blur/hide/closed 生命周期解除；
 * 打开失败时不会产生这些事件，必须在此显式解除，避免弹窗永久忽略失焦。
 * @returns 无返回值。
 * @author zhenghq
 */
function openSettingsFromPopup(): void {
  // 未固定时沿用「打开设置页后弹窗自动关闭」的既有行为：弹窗保持可见会让后续
  // 点击设置页落入全局按下关闭兜底，而 hidePopup() 的前台交还退化路径可能把
  // 设置页一起隐藏。固定（图钉）表示用户显式要求弹窗保持可见，内部窗口切换
  // 不得清掉 pinned 并关闭弹窗，只让设置窗口自身置前即可。
  if (!isPopupPinned()) hidePopupForInternalWindowSwitch()
  // 第二次打开时设置页已经可见，复用窗口的 show()/focus() 不保证再次派发
  // focus 事件；必须在隐藏弹窗后重新开启保护，覆盖复用窗口路径上的迟到 blur。
  beginPopupSettingsOpenGuard()
  void openSettings({ bringToFront: true, source: 'popup' }).catch((error: unknown) => {
    endPopupSettingsOpenGuard()
    // 打开设置失败时无需打断用户当前翻译：保护已解除，后续失焦恢复既有语义；
    // 记录错误便于排查窗口创建失败（例如渲染进程加载异常）。
    console.error('[settings] 打开设置窗口失败:', error)
  })
}

/**
 * 处理从翻译弹窗发起的打开网页阅读器请求。
 *
 * 网页阅读器 show()/focus() 会抢走翻译弹窗焦点，与打开设置页一样属于应用内部
 * 窗口切换。必须先只隐藏翻译弹窗自身，避免后续点击阅读器落入弹窗的全局按下
 * 关闭兜底，并防止 hidePopup() 的前台交还退化路径把阅读器一起隐藏。
 * @param url 可选的初始网页地址。
 * @returns 无返回值。
 * @author zhenghq
 */
function openWebReaderFromPopup(url?: string): void {
  // 与打开设置页一致：固定弹窗在打开阅读器时必须保持可见且保持 pinned，
  // 仅未固定时沿用内部窗口切换自动关闭弹窗的既有行为。
  if (!isPopupPinned()) hidePopupForInternalWindowSwitch()
  // 第二次打开时阅读器已经可见，复用窗口同样不保证再次派发 focus 事件。
  // 必须在隐藏弹窗后开启保护，避免阅读器接管焦点时的迟到 blur 关闭弹窗。
  beginPopupSettingsOpenGuard()
  void getWebReader().open(url, { bringToFront: true }).catch((error: unknown) => {
    endPopupSettingsOpenGuard()
    const message = error instanceof Error ? error.message : t('error.openWebReader')
    dialog.showErrorBox(t('error.webTranslation'), message)
  })
}

/**
 * 通过全局快捷键打开或聚焦空白网页翻译阅读器，不读取当前浏览器地址。
 * @returns 无返回值。
 * @author zhenghq
 */
function openWebReaderFromShortcut(): void {
  const reader = getWebReader()
  if (reader.focusOrOpenExistingWindow()) return
  void reader.open().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : t('error.openWebReader')
    dialog.showErrorBox(t('error.webTranslation'), message)
  })
}

// ---- 自建 DeepLX 集成 ----

/**
 * 检测当前保存的所有自建 DeepLX 服务。
 * @returns 多地址汇总在线状态。
 * @author zhenghq
 */
function checkDeepLx(): Promise<DeepLxStatus> {
  if (!deepLxCheckService) throw new Error(t('app.serviceNotInitialized.deepLxCheck'))
  return deepLxCheckService.check(getSettings().deepLxUrl)
}

/**
 * 保存 DeepLX 多地址。
 * @param patch DeepLX 配置补丁。
 * @returns 保存后的脱敏设置。
 * @author zhenghq
 */
function applyDeepLxConfig(patch: DeepLxConfigPatch): Settings {
  return getDeepLxConfiguration().applyPatch(patch)
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
    '  -e TOKEN=' + t('deepLx.dockerPlaceholder') + ' \\',
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
 * 取消正在进行的更新下载，回到可重新下载状态。
 * @returns 取消操作完成后的更新状态。
 * @author zhenghq
 */
async function cancelApplicationUpdateDownload(): Promise<UpdateStatus> {
  return getUpdateManager().cancelDownload()
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
    title: t('dialog.quarantine.title'),
    message: t('dialog.quarantine.message'),
    detail: t('dialog.quarantine.detail'),
    buttons: [t('common.cancel'), t('dialog.quarantine.confirm')],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  if (result.response !== 1) {
    return { ok: false, message: t('dialog.quarantine.cancelled') }
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
      message: t('error.dingTalkCredentialsUnavailable')
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
  if (!aiModelDiscovery) throw new Error(t('app.serviceNotInitialized.aiModelDiscovery'))
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
  if (!aiCheckService) throw new Error(t('app.serviceNotInitialized.aiCheck'))
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
 * 校验来自 Renderer 的原生 View 矩形。
 * @param value 未信任的 IPC 负载。
 * @returns 负载合法时返回 true。
 * @author zhenghq
 */
function isWebViewBounds(value: unknown): value is WebViewBounds {
  if (!value || typeof value !== 'object') return false
  const bounds = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every((key) => typeof bounds[key] === 'number' && Number.isFinite(bounds[key]))
}

/**
 * 校验来自 Renderer 的网页翻译范围参数。
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
 * 校验来自 Renderer 的网页显示模式。
 * @param value 未信任的 IPC 负载。
 * @returns 模式合法时返回 true。
 * @author zhenghq
 */
function isWebTranslationMode(value: unknown): value is WebTranslationMode {
  return value === 'source' || value === 'target' || value === 'bilingual'
}

/**
 * 保存设置补丁并同步快捷键、托盘及所有渲染窗口。
 * @param patch 设置补丁。
 * @returns 保存后的完整设置。
 * @author zhenghq
 */
async function applySettingsPatch(patch: Partial<Settings>): Promise<Settings> {
  if (patch.hotkey !== undefined && isCopyShortcut(String(patch.hotkey))) {
    throw new Error(t('error.copyShortcutAsTranslationHotkey'))
  }
  if (patch.ocrHotkey !== undefined && isCopyShortcut(String(patch.ocrHotkey))) {
    throw new Error(t('error.copyShortcutAsOcrHotkey'))
  }

  const previous = getSettings()
  const shortcutPatch: Partial<Pick<Settings, GlobalShortcutId>> = {}
  for (const id of ['hotkey', 'ocrHotkey', 'manualTranslationHotkey', 'webReaderHotkey'] as GlobalShortcutId[]) {
    if (patch[id] !== undefined) shortcutPatch[id] = String(patch[id]).trim()
  }
  const shortcutCandidate = { ...previous, ...shortcutPatch }
  for (const id of Object.keys(shortcutPatch) as GlobalShortcutId[]) {
    const conflict = findShortcutConflict(id, shortcutCandidate[id], shortcutCandidate)
    if (conflict?.kind === 'copy') {
      throw new Error(t('error.shortcutConflictCopy'))
    }
    if (conflict?.kind === 'duplicate') {
      throw new Error(t('error.shortcutConflictDuplicate'))
    }
  }
  const safePatch = { ...patch }
  delete safePatch.deepLxUrl
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
    (patch.ocrHotkey !== undefined && settings.ocrHotkey !== previous.ocrHotkey) ||
    (patch.manualTranslationHotkey !== undefined && settings.manualTranslationHotkey !== previous.manualTranslationHotkey) ||
    (patch.webReaderHotkey !== undefined && settings.webReaderHotkey !== previous.webReaderHotkey)
  ) {
    registerGlobalShortcuts(settings)
  }
  if (patch.triggerMode !== undefined && settings.triggerMode !== previous.triggerMode) {
    applySelectionListener()
    if (settings.triggerMode === 'auto') void warnIfNoAccessibility()
  }
  if (patch.showDockIcon !== undefined && settings.showDockIcon !== previous.showDockIcon) {
    await applyMacOSDockVisibility(settings.showDockIcon)
  }
  if (patch.autoLaunch !== undefined && settings.autoLaunch !== previous.autoLaunch) {
    applyAutoLaunch(settings.autoLaunch)
  }
  if (patch.proxyMode !== undefined ||
      patch.proxyRules !== undefined ||
      patch.proxyBypassRules !== undefined) {
    await applyTranslationProxy(settings)
    await webReader?.applyProxy(settings)
  }
  if (patch.microsoftEnabled !== undefined &&
      settings.microsoftEnabled !== previous.microsoftEnabled) {
    resetMicrosoftTranslationRuntime()
  }
  if (patch.ocrEnginePreference !== undefined && settings.ocrEnginePreference !== previous.ocrEnginePreference) {
    delete ocrEnginePreferenceState.preferredEngine
  }
  if (aiFieldChanged) {
    resetAiTranslationRuntime()
    aiModelDiscovery?.clearCache()
  }
  mainI18n?.refresh()
  refreshLocalizedApplicationChrome()
  broadcast('settings:changed', settings)
  return settings
}

/**
 * 注册悬浮窗、设置页和 DeepLX 相关 IPC。
 * @returns 无返回值。
 * @author zhenghq
 */
function registerIpc(): void {
  registerWindowControls({
    isAllowedWindow: (window) => window === settingsWin || Boolean(webReader?.ownsWindow(window)),
    closeWindow: (window) => {
      // 网页阅读器关闭前必须先把 macOS 前台交还给源应用，
      // 否则最后一个 key window 销毁时系统会把设置页提升到最前。
      if (webReader?.ownsWindow(window)) {
        webReader.close()
        return
      }
      window.close()
    }
  })
  ipcMain.on('popup:copy', (_event, text: unknown) => {
    clipboard.writeText(String(text ?? ''))
  })
  ipcMain.on('popup:hide', () => hidePopup(true, 'renderer-ipc'))
  ipcMain.on('popup:resize', (_event, size: unknown) => {
    if (isPopupAutoSizeRequest(size)) resizePopup(size)
  })
  ipcMain.on('popup:set-pinned', (_event, pinned: unknown) => {
    setPopupPinned(Boolean(pinned))
  })
  /**
   * 查询单个英文单词的音标；主进程再次校验输入，避免 Renderer 绕过词形边界。
   * @param _event IPC 事件对象。
   * @param word Renderer 传入的待查询单词。
   * @returns 脱敏音标结果。
   * @author zhenghq
   */
  ipcMain.handle('pronunciation:lookup', (_event, word: unknown, requestId: unknown) => {
    const normalized = typeof word === 'string' ? word.trim() : ''
    if (!normalized || normalized.length > 64) {
      return {
        status: 'unsupported',
        word: normalized.slice(0, 64),
        language: 'en',
        variants: [],
        source: 'dictionaryapi'
      }
    }
    const normalizedRequestId = normalizePronunciationRequestId(requestId)
    if (!normalizedRequestId) return pronunciationService.lookup(normalized)
    const controller = new AbortController()
    return pronunciationRequests.run(
      normalizedRequestId,
      controller,
      pronunciationService.lookup(normalized, controller.signal)
    )
  })
  /**
   * 下载当前已缓存音标变体的音频；变体 ID 必须由主进程查询结果生成。
   * @param _event IPC 事件对象。
   * @param word 当前查询词。
   * @param variantId 已登记的变体标识。
   * @returns 临时音频字节或脱敏错误。
   * @author zhenghq
   */
  ipcMain.handle('pronunciation:audio', (_event, word: unknown, variantId: unknown, requestId: unknown) => {
    const normalizedWord = typeof word === 'string' ? word.trim() : ''
    const normalizedVariantId = typeof variantId === 'string' ? variantId.trim() : ''
    if (!normalizedWord || normalizedWord.length > 64 || !normalizedVariantId) {
      return { ok: false, error: 'Pronunciation audio is unavailable' }
    }
    const normalizedRequestId = normalizePronunciationRequestId(requestId)
    if (!normalizedRequestId) return pronunciationService.getAudio(normalizedWord, normalizedVariantId)
    const controller = new AbortController()
    return pronunciationRequests.run(
      normalizedRequestId,
      controller,
      pronunciationService.getAudio(normalizedWord, normalizedVariantId, controller.signal)
    )
  })
  /**
   * 取消 Renderer 尚未完成的音标查询或音频下载。
   * @param _event IPC 事件对象。
   * @param requestId Renderer 生成的请求 ID。
   * @returns 无返回值。
   * @author zhenghq
   */
  ipcMain.on('pronunciation:cancel', (_event, requestId: unknown) => {
    const normalized = normalizePronunciationRequestId(requestId)
    if (normalized) pronunciationRequests.cancel(normalized)
  })
  /**
   * 接收音标交互状态，仅暂停或恢复自动隐藏，不改变弹窗固定状态。
   * @param _event IPC 事件对象。
   * @param active Renderer 上报的交互状态。
   * @returns 无返回值。
   * @author zhenghq
   */
  ipcMain.on('pronunciation:interaction', (_event, active: unknown) => {
    setPronunciationInteraction(active === true)
  })
  ipcMain.on('settings:open', () => openSettingsFromPopup())
  ipcMain.on('webview:open', (_event, url: unknown) => {
    openWebReaderFromPopup(typeof url === 'string' && url.trim() ? url : undefined)
  })
  ipcMain.on('webview:close', () => getWebReader().close())
  ipcMain.handle('webview:navigate', (_event, url: unknown) => {
    if (typeof url !== 'string' || !url.trim()) throw new Error(t('error.invalidWebUrl'))
    return getWebReader().navigate(url)
  })
  ipcMain.on('webview:back', () => getWebReader().back())
  ipcMain.on('webview:forward', () => getWebReader().forward())
  ipcMain.on('webview:reload', () => getWebReader().reload())
  ipcMain.on('webview:set-bounds', (_event, bounds: unknown) => {
    if (isWebViewBounds(bounds)) getWebReader().setBounds(bounds)
  })
  ipcMain.handle('web-translate:extract', () => getWebReader().extract())
  ipcMain.handle('web-translate:run', (_event, request: unknown) =>
    getWebReader().run(isWebTranslationRunRequest(request) ? request : {})
  )
  ipcMain.on('web-translate:cancel', () => getWebReader().cancel())
  ipcMain.handle('web-translate:set-mode', (_event, mode: unknown) => {
    if (!isWebTranslationMode(mode)) throw new Error(t('error.invalidWebMode'))
    return getWebReader().setMode(mode)
  })
  ipcMain.on('settings:stop-service', () => stopApplicationService())
  ipcMain.on('selection:translate', () => {
    void translateSelectionButton()
  })
  ipcMain.on('ocr-selection:open', () => {
    void openOcrSelection()
  })
  ipcMain.on('ocr-selection:ready', (_event, payload: unknown) => {
    const sessionId = (payload as { sessionId?: unknown })?.sessionId
    if (typeof sessionId !== 'number' || sessionId !== ocrSelectionSessionSeq) return
    resolveOcrSelectionReady(true)
  })
  ipcMain.on('ocr-selection:cancel', () => cancelOcrSelection())
  ipcMain.on('ocr-selection:submit', (_event, bounds: unknown) => {
    void submitOcrSelection(bounds)
  })
  ipcMain.on('ocr-selection:recognize', (_event, request: unknown) => {
    const normalized = normalizeScreenshotActionRequest(request)
    if (normalized && normalized.sessionId === ocrSelectionSessionSeq) activeScreenshotOcrRequests.set(normalized.requestId, normalized.sessionId)
    void recognizeOcrSelectionAction(request)
  })
  ipcMain.on('ocr-selection:translate', (_event, request: unknown) => {
    void translateOcrSelectionAction(request)
  })
  ipcMain.on('ocr-selection:copy-image', (_event, request: unknown) => {
    const normalized = normalizeScreenshotActionRequest(request)
    if (normalized && normalized.sessionId === ocrSelectionSessionSeq) activeScreenshotOcrRequests.set(normalized.requestId, normalized.sessionId)
    void copyOcrSelectionImageAction(request)
  })
  ipcMain.on('ocr-selection:save-image', (_event, request: unknown) => {
    const normalized = normalizeScreenshotActionRequest(request)
    if (normalized && normalized.sessionId === ocrSelectionSessionSeq) activeScreenshotOcrRequests.set(normalized.requestId, normalized.sessionId)
    void saveOcrSelectionImageAction(request)
  })
  ipcMain.on('ocr-selection:copy-annotated-image', (_event, request: unknown) => {
    const validated = validateAnnotatedExportPayload(request)
    if (validated.ok && validated.request.sessionId === ocrSelectionSessionSeq) activeScreenshotOcrRequests.set(validated.request.requestId, validated.request.sessionId)
    void copyAnnotatedOcrSelectionImageAction(request)
  })
  ipcMain.on('ocr-selection:save-annotated-image', (_event, request: unknown) => {
    const validated = validateAnnotatedExportPayload(request)
    if (validated.ok && validated.request.sessionId === ocrSelectionSessionSeq) activeScreenshotOcrRequests.set(validated.request.requestId, validated.request.sessionId)
    void saveAnnotatedOcrSelectionImageAction(request)
  })
  // 带标注导出的底图必须使用原始分辨率像素：预览图可能经过编码/缩放，直接复用会发糊。
  // 这里只在用户点击复制/保存时按需裁剪并编码，成本不落在「快捷键 → 可拖拽」热路径上。
  ipcMain.handle('ocr-selection:export-image', (_event, request: unknown) => {
    const normalized = normalizeScreenshotExportImageRequest(request)
    if (!normalized || normalized.sessionId !== ocrSelectionSessionSeq) {
      throw new ScreenshotSelectionError('snapshot-expired', t('error.screenshotExpired'))
    }
    // 导出必须与 OCR 共用同一条原始像素通道：Windows 上 cropCurrentOcrSelectionPng 会
    // 优先使用 GDI BGRA 原始字节，绕开 nativeImage 的平台相关通道契约，避免红蓝颠倒。
    const png = cropCurrentOcrSelectionPng(normalized.bounds)
    return { dataUrl: `data:image/png;base64,${png.toString('base64')}` }
  })
  ipcMain.on('screenshot-toast:show', (_event, payload: unknown) => {
    const raw = payload as { message?: string; kind?: ScreenshotToastKind; displayTimeMs?: number }
    if (typeof raw?.message === 'string' && raw.message.trim()) {
      showScreenshotToast(raw.message, raw.displayTimeMs, raw.kind)
    }
  })
  ipcMain.on('screenshot-toast:show-window', (_event, payload: unknown) => {
    handleScreenshotToastShowWindow(payload)
  })
  ipcMain.on('ocr-clipboard:translate', () => {
    void translateClipboardImage()
  })
  ipcMain.on('manual-translate:open-request', () => void openManualTranslation())
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
  ipcMain.handle('shortcuts:get-registration', () => shortcutRegistrationStates)
  /**
   * 返回内存环形缓冲中的全部近期日志，供日志查看界面初始化展示。
   * @returns 按时间升序排列的结构化日志条目。
   * @author zhenghq
   */
  ipcMain.handle('logs:get-history', () => appLogger.getHistory())
  /**
   * 弹出保存对话框，将当日日志文件复制到用户选定路径。
   * @returns 导出结果：成功返回保存路径，取消返回 null。
   * @author zhenghq
   */
  ipcMain.handle('logs:export', async (): Promise<string | null> => {
    const source = appLogger.getLogFilePath()
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: t('dialog.exportLogs.title'),
      defaultPath: `main-${new Date().toISOString().slice(0, 10)}.log`
    })
    if (canceled || !filePath) return null
    await copyFile(source, filePath)
    return filePath
  })
  /**
   * 返回近两天取词诊断聚合摘要，供设置页诊断卡片展示。
   * @returns 两天聚合摘要。
   * @author zhenghq
   */
  ipcMain.handle('capture-diagnostics:get-summary', () => {
    const data = getCaptureDiagnosticsStore().getSummary()
    const days: Record<string, unknown> = {}
    for (const [date, bucket] of Object.entries(data.days)) {
      days[date] = bucket.summary
    }
    return { days }
  })
  /**
   * 弹出保存对话框，将近两天诊断聚合与原始样本导出为 JSON 文件。
   * @returns 导出结果：成功返回保存路径，取消返回 null。
   * @author zhenghq
   */
  ipcMain.handle('capture-diagnostics:export', async (): Promise<string | null> => {
    const data = getCaptureDiagnosticsStore().getExportData()
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: t('dialog.exportDiagnostics.title'),
      defaultPath: `capture-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || !filePath) return null
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
    return filePath
  })
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

  ipcMain.handle('deeplx:configure', (_event, patch: DeepLxConfigPatch) =>
    applyDeepLxConfig(patch)
  )
  ipcMain.handle('deeplx:check', () => checkDeepLx())
  ipcMain.handle('deeplx:docker-command', (_event, port: number) => buildDockerCommand(port))
  ipcMain.on('deeplx:open-doc', () => openDeployDoc())
  ipcMain.handle('updater:get-status', () => getUpdateManager().getStatus())
  ipcMain.handle('updater:check', () => checkForApplicationUpdates())
  ipcMain.handle('updater:download', () => downloadApplicationUpdate())
  ipcMain.handle('updater:cancel-download', () => cancelApplicationUpdateDownload())
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
    throw new Error(t('error.trayIconLoadFailed', { message: filename }))
  }
  if (isMac) icon.setTemplateImage(true)
  return icon
}

/**
 * 创建仅显示模板图标的菜单栏状态项，减少 macOS 菜单栏占用宽度。
 * 左键单击或双击图标时直接打开设置主页面，右键仍弹出托盘菜单。
 * @returns 无返回值。
 * @author zhenghq
 */
function createTray(): void {
  tray = new Tray(loadTrayIcon())
  tray.setToolTip(t('app.name'))
  if (isMac) {
    // macOS 上 setContextMenu 会让左键点击也弹出菜单，因此改为右键事件时动态弹出
    tray.on('right-click', () => tray?.popUpContextMenu(buildTrayMenu()))
  } else {
    tray?.setContextMenu(buildTrayMenu())
  }
  tray.on('click', () => void openSettings())
  tray.on('double-click', () => void openSettings())
}

/**
 * 构建包含触发方式开关、自动中英互译和手动语言选项的托盘菜单。
 * @returns Electron 托盘菜单。
 * @author zhenghq
 */
function buildTrayMenu(): Menu {
  const settings = getSettings()
  const t = mainI18n?.translator ?? {
    t: (key: string) => key
  }

  const targetOptions = [{ code: 'auto', label: t.t('menu.autoBilingual') }, ...LANGUAGES]
  const targetSubmenu = targetOptions.map((language) => ({
    label: language.label,
    type: 'radio' as const,
    checked: settings.targetLang.toLowerCase() === language.code.toLowerCase(),
    click: () => void applySettingsPatch({ targetLang: language.code })
  }))

  const sourceOptions = [{ code: 'auto', label: t.t('settings.sourceLang.auto') }, ...LANGUAGES]
  const sourceSubmenu = sourceOptions.map((language) => ({
    label: language.label,
    type: 'radio' as const,
    checked: settings.sourceLang.toLowerCase() === language.code.toLowerCase(),
    click: () => void applySettingsPatch({ sourceLang: language.code })
  }))

  return Menu.buildFromTemplate([
    { label: `${t.t('app.name')}   ${settings.hotkey}`, enabled: false },
    { type: 'separator' },
    { label: t.t('menu.manualTranslation'), click: () => void openManualTranslation() },
    { label: t.t('menu.openWebTranslation'), enabled: settings.webTranslationEnabled, click: () => {
      void getWebReader().open().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : t.t('error.openWebReader')
        dialog.showErrorBox(t.t('error.webTranslation'), message)
      })
    } },
    {
      label: t.t('menu.screenshotOcr'),
      enabled: true,
      click: () => openOcrSelection()
    },
    {
      label: t.t('menu.clipboardImageOcr'),
      enabled: true,
      click: () => void translateClipboardImage()
    },
    { type: 'separator' },
    {
      label: t.t('menu.showSelectionButton'),
      type: 'checkbox',
      checked: settings.triggerMode === 'button',
      click: (menuItem) =>
        void applySettingsPatch({ triggerMode: menuItem.checked ? 'button' : 'hotkey' })
    },
    ...(isMac ? [{
      label: t.t('menu.repairMacSelectionService'),
      click: () => void repairMacHiServicesManually()
    }] : []),
    { type: 'separator' },
    { label: t.t('menu.targetLanguage'), submenu: targetSubmenu },
    { label: t.t('menu.sourceLanguage'), submenu: sourceSubmenu },
    { type: 'separator' },
    { label: t.t('menu.settings'), click: () => void openSettings() },
    { label: t.t('menu.quit'), click: () => stopApplicationService() }
  ])
}

/**
 * 在界面语言变化后同步主进程菜单、托盘和已打开窗口标题。
 * @returns 无返回值。
 * @author zhenghq
 */
function refreshLocalizedApplicationChrome(): void {
  const title = t('app.name')
  tray?.setToolTip(title)
  refreshTrayMenu()
  const settingsTitle = t('settings.windowTitle')
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setTitle(settingsTitle)
}

/**
 * 刷新非 macOS 平台预挂的托盘菜单；macOS 的菜单在右键时动态构建，无需刷新。
 * @returns 无返回值。
 * @author zhenghq
 */
function refreshTrayMenu(): void {
  if (!isMac) tray?.setContextMenu(buildTrayMenu())
}

/**
 * 应用退出前停止全局监听、注销快捷键并移除托盘图标。
 * @returns 无返回值。
 * @author zhenghq
 */
function cleanupBeforeQuit(): void {
  webReader?.dispose()
  webReader = null
  selectionInteraction.invalidate()
  selectionListenerController.stop()
  globalShortcut.unregisterAll()
  tray?.destroy()
  tray = null
}

app.on('before-quit', cleanupBeforeQuit)
