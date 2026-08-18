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
  safeStorage,
  screen,
  dialog,
  type NativeImage
} from 'electron'
import { join } from 'node:path'
import { loadSettings, saveSettings, getSettings } from './settings'
import { captureSelection, PermissionError, checkAccessibilityPermission } from './capture'
import {
  checkDingTalk as checkDingTalkTranslation,
  checkMicrosoft as checkMicrosoftTranslation,
  configureTranslationFetch,
  resetDingTalkTranslationRuntime,
  resetMicrosoftTranslationRuntime,
  translate
} from './translate'
import { applyTranslationProxy, translationFetch } from './network'
import {
  createPopup,
  showPopup,
  hidePopup,
  isPopupVisible,
  isPointInsidePopup,
  getPopupCloseVersion,
  setPopupPinned
} from './popup'
import {
  createSelectionButton,
  showSelectionButton,
  hideSelectionButton,
  isPointInsideSelectionButton
} from './selectionButton'
import { startAutoTrigger, stopAutoTrigger } from './autoTrigger'
import { LANGUAGES } from '../shared/langs'
import { isCopyShortcut } from '../shared/copyShortcutBehavior'
import {
  decideSelectionAction,
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
  Settings,
  DeepLxStatus,
  UpdateStatus
} from '../shared/types'
import { DingTalkCredentialStore } from './dingtalkCredentials'
import { DingTalkConfigurationService } from './dingtalkConfig'
import {
  isMacOSDiskImageExecution,
  shouldOpenSettingsOnInitialLaunch
} from './appLifecycle'
import { createApplicationUpdateManager } from './updater'
import type { UpdateManager } from './updateManager'

const isMac = process.platform === 'darwin'
const PRELOAD_PATH = join(__dirname, '../preload/index.js')
const DOCKER_IMAGE = 'ghcr.io/owo-network/deeplx:latest'
const SELECTION_SETTLE_DELAY_MS = 80
const UPDATE_CHECK_DELAY_MS = 5000

let tray: Tray | null = null
let settingsWin: BrowserWindow | null = null
let dingTalkConfiguration: DingTalkConfigurationService | null = null
let updateManager: UpdateManager | null = null
let latestTranslationRequest = 0
let latestSelectionGesture = 0
const selectionCapture = new SelectionCaptureCoordinator(captureSelection)
let lastSelectedText = ''
let lastSelectionAnchor: { x: number; y: number } | undefined

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
 * 返回已初始化的自动更新管理器。
 * @returns 自动更新管理器。
 * @author zhenghq
 */
function getUpdateManager(): UpdateManager {
  if (!updateManager) throw new Error('自动更新服务尚未初始化')
  return updateManager
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
      if (isMac) {
        showTrayMenu()
      } else {
        openSettings()
      }
    })
  })
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
 * 将 macOS 应用配置为仅显示菜单栏图标的辅助应用。
 * @returns 无返回值。
 * @author zhenghq
 */
function configureMacOSMenuBarApplication(): void {
  if (!isMac) return
  app.setActivationPolicy('accessory')
  app.dock?.hide()
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
  configureMacOSMenuBarApplication()
  if (!(await confirmMacOSInstalledApplicationLaunch())) {
    app.quit()
    return false
  }

  loadSettings()
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
  registerShortcut(getSettings().hotkey)
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
 * 注册全局翻译快捷键。
 * @param accelerator Electron 快捷键描述。
 * @returns 无返回值。
 * @author zhenghq
 */
function registerShortcut(accelerator: string): void {
  globalShortcut.unregisterAll()
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
 * 安排一次选区捕获动作，等待前台应用完成鼠标划词后再取词。
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

  setTimeout(() => {
    if (gestureId !== latestSelectionGesture) return
    if (action === 'translate') {
      queueSelectionTranslation(anchor)
    } else {
      void prepareSelectionButton(anchor, gestureId)
    }
  }, SELECTION_SETTLE_DELAY_MS)
}

/**
 * 响应一次全局划词动作，决定显示图标还是直接自动翻译。
 * 按钮模式会先捕获选中文字，再显示“译”按钮，防止点击按钮导致原选区失效。
 * @param gesture 划词拖拽及选区锚点信息。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleSelectionGesture(gesture: SelectionGesture): void {
  if (isPointInsidePopup(gesture.start) ||
      isPointInsidePopup(gesture.end) ||
      isPointInsideSelectionButton(gesture.start) ||
      isPointInsideSelectionButton(gesture.end)) {
    return
  }

  scheduleSelectionAction(gesture.anchor)
}

/**
 * 响应全局鼠标按下事件，使已失效的选区缓存和“译”按钮立即消失。
 * 点击“译”按钮本身时保留窗口，确保按钮仍能收到点击事件。
 * @param point 鼠标按下时的屏幕坐标。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleSelectionPointerDown(point: { x: number; y: number }): void {
  if (isPointInsideSelectionButton(point)) return
  latestSelectionGesture += 1
  selectionCapture.invalidate()
  hideSelectionButton()
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
 * 在显示“译”按钮之前预取选中文字，避免点击按钮后原应用选区被清除。
 * @param anchor 本次选区右上角锚点。
 * @param gestureId 本次划词动作序号。
 * @returns 预取流程完成后的 Promise。
 * @author zhenghq
 */
async function prepareSelectionButton(
  anchor: { x: number; y: number },
  gestureId: number
): Promise<void> {
  if (gestureId !== latestSelectionGesture || getSettings().triggerMode !== 'button') return
  const result = await selectionCapture.prepare(anchor)
  if (!result || gestureId !== latestSelectionGesture) return
  if (!result.text || result.error) {
    hideSelectionButton()
    if (result.error) handleSelectionCaptureResult(result)
    return
  }
  if (getSettings().triggerMode !== 'button') return
  showSelectionButton(anchor)
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
 * 消费划词时预取的文字并开始翻译，不在按钮点击后重新模拟复制。
 * @returns 无返回值。
 * @author zhenghq
 */
function translatePreparedSelection(): void {
  const result = selectionCapture.consumePrepared()
  latestSelectionGesture += 1
  selectionCapture.invalidate()
  hideSelectionButton()
  handleSelectionCaptureResult(result ?? {
    text: '',
    anchor: lastSelectionAnchor
  })
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
        error: '未检测到选中文字，请重新划词后点击“译”按钮',
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
 * @param preferences 可选的手动语言偏好。
 * @returns 翻译流程完成后的 Promise。
 * @author zhenghq
 */
async function translateText(
  text: string,
  anchor?: { x: number; y: number },
  preferences?: { sourceLang: string; targetLang: string }
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

  lastSelectedText = text
  if (anchor) lastSelectionAnchor = anchor

  showPopup(
    {
      ok: true,
      loading: true,
      original: text,
      sourceLang: pair.sourceLang,
      targetLang: pair.targetLang,
      sourcePreference,
      targetPreference
    },
    0,
    anchor
  )

  try {
    const dingTalkCredentials = settings.dingTalkEnabled
      ? getDingTalkConfiguration().getCredentialsSnapshot()
      : null
    const output = await translate(text, requestSettings, dingTalkCredentials)
    if (requestId !== latestTranslationRequest || closeVersion !== getPopupCloseVersion()) return
    showPopup(
      {
        ok: true,
        original: text,
        translation: output.translation,
        detectedLang: output.detectedLang,
        sourceLang: pair.sourceLang,
        targetLang: pair.targetLang,
        sourcePreference,
        targetPreference,
        channel: output.channel
      },
      settings.autoHideMs,
      anchor
    )
  } catch (e) {
    if (requestId !== latestTranslationRequest || closeVersion !== getPopupCloseVersion()) return
    handleTranslateError(e as Error, requestSettings, anchor, {
      sourceLang: sourcePreference,
      targetLang: targetPreference
    })
  }
}

/**
 * 展示翻译异常，并在缺少辅助功能权限时打开系统设置。
 * @param err 翻译或取词异常。
 * @param settings 当前翻译设置。
 * @param anchor 弹窗定位锚点。
 * @param preferences 弹窗中需要回显的语言偏好。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleTranslateError(
  err: Error,
  settings: Settings,
  anchor?: { x: number; y: number },
  preferences?: { sourceLang: string; targetLang: string }
): void {
  const common = {
    sourcePreference: preferences?.sourceLang ?? settings.sourceLang,
    targetPreference: preferences?.targetLang ?? settings.targetLang,
    targetLang: settings.targetLang
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
 * 下载新版本；手动安装模式下打开 GitHub Release 页面。
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

  const previous = getSettings()
  const safePatch = { ...patch }
  delete safePatch.dingTalkEnabled
  delete safePatch.dingTalkCorpId
  delete safePatch.dingTalkClientId
  delete safePatch.dingTalkSecretConfigured
  const settings = saveSettings(safePatch)
  if (patch.hotkey !== undefined && settings.hotkey !== previous.hotkey) {
    registerShortcut(settings.hotkey)
  }
  if (patch.triggerMode !== undefined && settings.triggerMode !== previous.triggerMode) {
    applySelectionListener()
    if (settings.triggerMode === 'auto') void warnIfNoAccessibility()
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
    translatePreparedSelection()
  })
  ipcMain.handle('popup:retranslate', async (_event, sourceLang: string, targetLang: string) => {
    const sourcePreference = sourceLang || 'auto'
    const targetPreference = targetLang || 'auto'
    await applySettingsPatch({ sourceLang: sourcePreference, targetLang: targetPreference })
    if (!lastSelectedText) return
    await translateText(lastSelectedText, lastSelectionAnchor, {
      sourceLang: sourcePreference,
      targetLang: targetPreference
    })
  })

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_event, patch: Partial<Settings>) => applySettingsPatch(patch))
  ipcMain.handle('dingtalk:configure', (_event, patch: DingTalkConfigPatch) =>
    applyDingTalkConfig(patch)
  )
  ipcMain.handle('dingtalk:clear-secret', () => clearDingTalkSecret())
  ipcMain.handle('dingtalk:check', () => checkDingTalk())
  ipcMain.handle('microsoft:check', () => checkMicrosoft())

  ipcMain.handle('deeplx:check', (_event, url: string) => checkDeepLx(url))
  ipcMain.handle('deeplx:docker-command', (_event, port: number) => buildDockerCommand(port))
  ipcMain.on('deeplx:open-doc', () => openDeployDoc())
  ipcMain.handle('updater:get-status', () => getUpdateManager().getStatus())
  ipcMain.handle('updater:check', () => checkForApplicationUpdates())
  ipcMain.handle('updater:download', () => downloadApplicationUpdate())
  ipcMain.on('updater:install', () => installApplicationUpdate())
  ipcMain.handle('updater:open-release', () => openApplicationReleasePage())
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
 * 弹出状态栏图标对应的功能菜单，供 macOS 第二实例复用。
 * @returns 无返回值。
 * @author zhenghq
 */
function showTrayMenu(): void {
  tray?.popUpContextMenu()
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
