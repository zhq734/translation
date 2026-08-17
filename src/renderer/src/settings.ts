import { LANGUAGES } from '../../shared/langs'
import { isCopyShortcut } from '../../shared/copyShortcutBehavior'
import type {
  DingTalkCheckStatus,
  MicrosoftCheckStatus,
  Settings,
  TriggerMode,
  UpdateStatus
} from '../../shared/types'

const targetLang = document.getElementById('target-lang') as HTMLSelectElement
const sourceLang = document.getElementById('source-lang') as HTMLSelectElement
const triggerMode = document.getElementById('trigger-mode') as HTMLSelectElement
const triggerHint = document.getElementById('trigger-hint') as HTMLElement
const hotkey = document.getElementById('hotkey') as HTMLInputElement
const autohide = document.getElementById('autohide') as HTMLSelectElement
const proxyMode = document.getElementById('proxy-mode') as HTMLSelectElement
const proxyRules = document.getElementById('proxy-rules') as HTMLInputElement
const proxyBypassRules = document.getElementById('proxy-bypass-rules') as HTMLInputElement
const dingTalkEnabled = document.getElementById('dingtalk-enabled') as HTMLInputElement
const dingTalkCorpId = document.getElementById('dingtalk-corp-id') as HTMLInputElement
const dingTalkClientId = document.getElementById('dingtalk-client-id') as HTMLInputElement
const dingTalkClientSecret = document.getElementById('dingtalk-client-secret') as HTMLInputElement
const dingTalkSecretStatus = document.getElementById('dingtalk-secret-status') as HTMLElement
const dingTalkSave = document.getElementById('dingtalk-save') as HTMLButtonElement
const dingTalkClearSecret = document.getElementById('dingtalk-clear-secret') as HTMLButtonElement
const dingTalkCheck = document.getElementById('dingtalk-check') as HTMLButtonElement
const dingTalkStatus = document.getElementById('dingtalk-status') as HTMLElement
const microsoftEnabled = document.getElementById('microsoft-enabled') as HTMLInputElement
const microsoftCheck = document.getElementById('microsoft-check') as HTMLButtonElement
const microsoftStatus = document.getElementById('microsoft-status') as HTMLElement
const deeplxUrl = document.getElementById('deeplx-url') as HTMLInputElement
const deeplxStatus = document.getElementById('deeplx-status') as HTMLElement
const deeplxCheck = document.getElementById('deeplx-check') as HTMLButtonElement
const dockerCmd = document.getElementById('docker-cmd') as HTMLTextAreaElement
const dockerCopy = document.getElementById('docker-copy') as HTMLButtonElement
const openDoc = document.getElementById('open-doc') as HTMLButtonElement
const stopServiceButton = document.getElementById('stop-service') as HTMLButtonElement
const currentVersion = document.getElementById('current-version') as HTMLElement
const latestVersion = document.getElementById('latest-version') as HTMLElement
const updateProgress = document.getElementById('update-progress') as HTMLElement
const updateProgressBar = document.getElementById('update-progress-bar') as HTMLProgressElement
const updateProgressText = document.getElementById('update-progress-text') as HTMLElement
const updateStatus = document.getElementById('update-status') as HTMLElement
const updateInstallHint = document.getElementById('update-install-hint') as HTMLElement
const checkUpdateButton = document.getElementById('check-update') as HTMLButtonElement
const updateActionButton = document.getElementById('update-action') as HTMLButtonElement
const openReleaseButton = document.getElementById('open-release') as HTMLButtonElement
const schemaVersion = document.getElementById('schema-version') as HTMLElement
const savedEl = document.getElementById('saved') as HTMLElement

type SettingsTabId = 'general' | 'dingtalk' | 'microsoft' | 'deeplx' | 'advanced' | 'about'
type SettingsTabHistoryMode = 'none' | 'replace' | 'push'

const SETTINGS_TAB_IDS: SettingsTabId[] = [
  'general',
  'dingtalk',
  'microsoft',
  'deeplx',
  'advanced',
  'about'
]
const SETTINGS_TAB_STORAGE_KEY = 'selection-translator.settings.active-tab'
const settingsTabButtons = [
  ...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')
]
const settingsTabPanels = [
  ...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')
]

let flashTimer: ReturnType<typeof setTimeout> | null = null
let latestUpdateStatus: UpdateStatus | null = null

/**
 * 判断字符串是否为受支持的设置页 Tab 标识。
 * @param value 待校验的 Tab 标识。
 * @returns 是合法 Tab 标识时返回 true。
 * @author zhenghq
 */
function isSettingsTabId(value: string | null): value is SettingsTabId {
  return value !== null && SETTINGS_TAB_IDS.some((tabId) => tabId === value)
}

/**
 * 从当前 URL 查询参数读取设置页 Tab。
 * @returns 查询参数中的合法 Tab；不存在或不合法时返回 null。
 * @author zhenghq
 */
function readSettingsTabFromQuery(): SettingsTabId | null {
  const tabId = new URLSearchParams(window.location.search).get('tab')
  return isSettingsTabId(tabId) ? tabId : null
}

/**
 * 从本地缓存读取上次打开的设置页 Tab。
 * @returns 缓存中的合法 Tab；缓存不可用或内容不合法时返回 null。
 * @author zhenghq
 */
function readStoredSettingsTab(): SettingsTabId | null {
  try {
    const tabId = window.localStorage.getItem(SETTINGS_TAB_STORAGE_KEY)
    return isSettingsTabId(tabId) ? tabId : null
  } catch {
    return null
  }
}

/**
 * 将当前设置页 Tab 写入本地缓存。
 * @param tabId 当前激活的 Tab 标识。
 * @returns 无返回值。
 * @author zhenghq
 */
function storeSettingsTab(tabId: SettingsTabId): void {
  try {
    window.localStorage.setItem(SETTINGS_TAB_STORAGE_KEY, tabId)
  } catch {
    // 本地缓存不可用时仍允许用户正常切换 Tab。
  }
}

/**
 * 将当前设置页 Tab 同步到 URL，以支持前进后退恢复页面状态。
 * @param tabId 当前激活的 Tab 标识。
 * @param historyMode 历史记录更新方式。
 * @returns 无返回值。
 * @author zhenghq
 */
function syncSettingsTabToHistory(
  tabId: SettingsTabId,
  historyMode: SettingsTabHistoryMode
): void {
  if (historyMode === 'none') return

  try {
    const url = new URL(window.location.href)
    url.searchParams.set('tab', tabId)
    if (historyMode === 'push') {
      window.history.pushState({ settingsTab: tabId }, '', url)
      return
    }
    window.history.replaceState({ settingsTab: tabId }, '', url)
  } catch {
    // 某些文件协议环境不支持 History API 时保持 Tab 切换可用。
  }
}

/**
 * 激活指定设置页 Tab，并同步按钮、面板、缓存及 URL 状态。
 * @param tabId 需要激活的 Tab 标识。
 * @param focusTab 是否将键盘焦点移动到激活的 Tab。
 * @param historyMode 历史记录更新方式。
 * @returns 无返回值。
 * @author zhenghq
 */
function activateSettingsTab(
  tabId: SettingsTabId,
  focusTab: boolean,
  historyMode: SettingsTabHistoryMode
): void {
  let activeButton: HTMLButtonElement | undefined
  for (const button of settingsTabButtons) {
    const active = button.dataset.tab === tabId
    button.ariaSelected = String(active)
    button.tabIndex = active ? 0 : -1
    if (active) activeButton = button
  }

  for (const panel of settingsTabPanels) {
    panel.hidden = panel.dataset.tabPanel !== tabId
  }

  storeSettingsTab(tabId)
  syncSettingsTabToHistory(tabId, historyMode)
  if (focusTab) activeButton?.focus()
}

/**
 * 处理设置页 Tab 点击切换。
 * @param event 鼠标点击事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleSettingsTabClick(event: MouseEvent): void {
  const tabId = (event.currentTarget as HTMLButtonElement).dataset.tab ?? null
  if (!isSettingsTabId(tabId)) return
  activateSettingsTab(tabId, false, 'push')
}

/**
 * 处理设置页 Tab 的方向键、Home 和 End 键盘导航。
 * @param event 键盘事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleSettingsTabKeydown(event: KeyboardEvent): void {
  const currentTabId = (event.currentTarget as HTMLButtonElement).dataset.tab ?? null
  if (!isSettingsTabId(currentTabId)) return

  const currentIndex = SETTINGS_TAB_IDS.indexOf(currentTabId)
  let nextIndex: number | null = null
  if (event.key === 'ArrowLeft') {
    nextIndex = (currentIndex - 1 + SETTINGS_TAB_IDS.length) % SETTINGS_TAB_IDS.length
  } else if (event.key === 'ArrowRight') {
    nextIndex = (currentIndex + 1) % SETTINGS_TAB_IDS.length
  } else if (event.key === 'Home') {
    nextIndex = 0
  } else if (event.key === 'End') {
    nextIndex = SETTINGS_TAB_IDS.length - 1
  }

  if (nextIndex === null) return
  event.preventDefault()
  activateSettingsTab(SETTINGS_TAB_IDS[nextIndex], true, 'push')
}

/**
 * 初始化设置页 Tab、状态恢复和浏览器历史导航监听。
 * @returns 无返回值。
 * @author zhenghq
 */
function initializeSettingsTabs(): void {
  const initialTab = readSettingsTabFromQuery() ?? readStoredSettingsTab() ?? 'general'
  activateSettingsTab(initialTab, false, 'replace')

  for (const button of settingsTabButtons) {
    button.addEventListener('click', handleSettingsTabClick)
    button.addEventListener('keydown', handleSettingsTabKeydown)
  }

  window.addEventListener('popstate', () => {
    activateSettingsTab(readSettingsTabFromQuery() ?? 'general', false, 'none')
  })
}

/**
 * 短暂显示设置保存结果。
 * @param message 提示内容。
 * @returns 无返回值。
 * @author zhenghq
 */
function flash(message: string): void {
  savedEl.textContent = message
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    savedEl.textContent = ''
  }, 1800)
}

/**
 * 保存设置补丁并显示结果。
 * @param patch 设置补丁。
 * @returns 保存完成后的 Promise。
 * @author zhenghq
 */
async function save(patch: Partial<Settings>): Promise<void> {
  try {
    await window.api.setSettings(patch)
    flash('已保存并生效')
  } catch (error) {
    flash(`保存失败：${(error as Error).message || '未知错误'}`)
  }
}

/**
 * 根据触发方式显示对应的交互说明。
 * @param mode 当前触发方式。
 * @returns 无返回值。
 * @author zhenghq
 */
function updateTriggerHint(mode: TriggerMode): void {
  const hints: Record<TriggerMode, string> = {
    auto: '选中文字后自动打开翻译弹窗；需要 macOS 辅助功能权限。',
    button: '每次划词都显示“译”按钮；只有点击按钮后才会打开或更新翻译弹窗。',
    hotkey: '划词后不会自动弹出内容，需要按下下方配置的全局快捷键。'
  }
  triggerHint.textContent = hints[mode]
}

/**
 * 根据代理模式启用或禁用自定义代理输入框。
 * @param mode 当前代理模式。
 * @returns 无返回值。
 * @author zhenghq
 */
function updateProxyFields(mode: string): void {
  const custom = mode === 'custom'
  proxyRules.disabled = !custom
  proxyBypassRules.disabled = !custom
}

/**
 * 将完整设置同步到页面控件。
 * @param settings 当前完整设置。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderSettings(settings: Settings): void {
  targetLang.value = settings.targetLang
  sourceLang.value = settings.sourceLang
  triggerMode.value = settings.triggerMode
  hotkey.value = settings.hotkey
  deeplxUrl.value = settings.deepLxUrl
  proxyMode.value = settings.proxyMode
  proxyRules.value = settings.proxyRules
  proxyBypassRules.value = settings.proxyBypassRules
  dingTalkEnabled.checked = settings.dingTalkEnabled
  dingTalkCorpId.value = settings.dingTalkCorpId
  dingTalkClientId.value = settings.dingTalkClientId
  dingTalkClientSecret.value = ''
  dingTalkSecretStatus.textContent = settings.dingTalkSecretConfigured
    ? 'Secret 已安全配置；留空保存将保留原值'
    : 'Secret 未配置'
  dingTalkSecretStatus.className = settings.dingTalkSecretConfigured
    ? 'field-hint dingtalk-secret-status configured'
    : 'field-hint dingtalk-secret-status'
  dingTalkClearSecret.disabled = !settings.dingTalkSecretConfigured
  microsoftEnabled.checked = settings.microsoftEnabled
  schemaVersion.textContent = `配置 v${settings.schemaVersion}`

  if (![...autohide.options].some((option) => option.value === String(settings.autoHideMs))) {
    autohide.add(new Option(`自定义 (${settings.autoHideMs}ms)`, String(settings.autoHideMs)))
  }
  autohide.value = String(settings.autoHideMs)
  updateTriggerHint(settings.triggerMode)
  updateProxyFields(settings.proxyMode)
}

/**
 * 初始化设置页语言选项、当前设置和 Docker 命令。
 * @returns 初始化完成后的 Promise。
 * @author zhenghq
 */
async function initialize(): Promise<void> {
  for (const language of [{ code: 'auto', label: '自动中英互译' }, ...LANGUAGES]) {
    targetLang.add(new Option(language.label, language.code))
  }
  for (const language of [{ code: 'auto', label: '自动检测' }, ...LANGUAGES]) {
    sourceLang.add(new Option(language.label, language.code))
  }

  renderSettings(await window.api.getSettings())
  dockerCmd.value = await window.api.getDockerCommand(1189)
  renderUpdateStatus(await window.api.getUpdateStatus())
}

/**
 * 将字节数格式化为适合更新进度显示的文本。
 * @param bytes 字节数。
 * @returns 自动选择 B、KB、MB 或 GB 后的文本。
 * @author zhenghq
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** unitIndex
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

/**
 * 将主进程自动更新状态渲染为版本、进度和可执行操作。
 * @param status 当前自动更新状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderUpdateStatus(status: UpdateStatus): void {
  latestUpdateStatus = status
  currentVersion.textContent = `v${status.currentVersion}`
  latestVersion.textContent = status.latestVersion ? `v${status.latestVersion}` : '尚未检查'
  updateStatus.textContent = status.message
  updateStatus.className = status.phase === 'error'
    ? 'status update-status offline'
    : status.phase === 'not-available' || status.phase === 'downloaded'
      ? 'status update-status online'
      : 'status update-status'

  const busy = status.phase === 'checking' || status.phase === 'downloading'
  checkUpdateButton.disabled = busy || status.phase === 'disabled'
  updateActionButton.disabled = busy
  updateActionButton.hidden = status.phase !== 'available' && status.phase !== 'downloaded'
  if (status.phase === 'downloaded') {
    updateActionButton.textContent = '立即重启升级'
  } else if (status.installMode === 'manual') {
    updateActionButton.textContent = '打开下载页'
  } else {
    updateActionButton.textContent = '下载并安装'
  }

  const progress = status.progress
  updateProgress.hidden = !progress || (status.phase !== 'downloading' && status.phase !== 'downloaded')
  if (progress) {
    const percent = Math.max(0, Math.min(100, progress.percent))
    updateProgressBar.value = percent
    updateProgressText.textContent = progress.total > 0
      ? `${percent.toFixed(1)}% · ${formatBytes(progress.transferred)} / ${formatBytes(progress.total)} · ${formatBytes(progress.bytesPerSecond)}/s`
      : `${percent.toFixed(1)}%`
  }

  if (status.phase === 'disabled') {
    updateInstallHint.textContent = '开发环境不会访问更新服务，请使用正式安装包验证自动更新。'
  } else if (status.installMode === 'manual') {
    updateInstallHint.textContent = '当前系统不满足自动安装条件，检测到新版本后会打开 GitHub Release 手动安装。'
  } else {
    updateInstallHint.textContent = '检测到新版本后由你确认下载；下载完成后可立即重启并完成升级。'
  }
}

/**
 * 主动检查 GitHub Release 最新版本并刷新页面状态。
 * @returns 检查完成后的 Promise。
 * @author zhenghq
 */
async function checkApplicationUpdate(): Promise<void> {
  try {
    renderUpdateStatus(await window.api.checkForUpdates())
  } catch (error) {
    updateStatus.textContent = `检查更新失败：${(error as Error).message || '未知错误'}`
    updateStatus.className = 'status update-status offline'
  }
}

/**
 * 根据当前状态下载更新、打开手动下载页或重启安装。
 * @returns 操作完成后的 Promise。
 * @author zhenghq
 */
async function runUpdateAction(): Promise<void> {
  if (latestUpdateStatus?.phase === 'downloaded') {
    window.api.installUpdate()
    return
  }
  try {
    renderUpdateStatus(await window.api.downloadUpdate())
  } catch (error) {
    updateStatus.textContent = `更新操作失败：${(error as Error).message || '未知错误'}`
    updateStatus.className = 'status update-status offline'
  }
}

/**
 * 在系统默认浏览器中打开项目 GitHub Release 页面。
 * @returns 页面打开完成后的 Promise。
 * @author zhenghq
 */
async function openApplicationRelease(): Promise<void> {
  try {
    await window.api.openUpdatePage()
  } catch (error) {
    updateStatus.textContent = `无法打开发布页：${(error as Error).message || '未知错误'}`
    updateStatus.className = 'status update-status offline'
  }
}

/**
 * 保存目标语言。
 * @returns 无返回值。
 * @author zhenghq
 */
function saveTargetLanguage(): void {
  void save({ targetLang: targetLang.value })
}

/**
 * 保存源语言。
 * @returns 无返回值。
 * @author zhenghq
 */
function saveSourceLanguage(): void {
  void save({ sourceLang: sourceLang.value })
}

/**
 * 保存划词触发方式并更新说明。
 * @returns 无返回值。
 * @author zhenghq
 */
function saveTriggerMode(): void {
  const value = triggerMode.value as TriggerMode
  updateTriggerHint(value)
  void save({ triggerMode: value })
}

/**
 * 保存全局快捷键。
 * @returns 无返回值。
 * @author zhenghq
 */
function saveHotkey(): void {
  const accelerator = hotkey.value.trim()
  if (isCopyShortcut(accelerator)) {
    flash('Ctrl+C / Command+C 保留给系统复制，请换一个翻译快捷键')
    hotkey.focus()
    hotkey.select()
    return
  }
  void save({ hotkey: accelerator })
}

/**
 * 保存弹窗自动隐藏时长。
 * @returns 无返回值。
 * @author zhenghq
 */
function saveAutoHide(): void {
  void save({ autoHideMs: Number(autohide.value) })
}

/**
 * 保存代理模式并更新自定义输入框状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function saveProxyMode(): void {
  updateProxyFields(proxyMode.value)
  void save({ proxyMode: proxyMode.value as Settings['proxyMode'] })
}

/**
 * 保存自定义代理规则。
 * @returns 无返回值。
 * @author zhenghq
 */
function saveProxyRules(): void {
  void save({ proxyRules: proxyRules.value.trim() })
}

/**
 * 保存代理绕过规则。
 * @returns 无返回值。
 * @author zhenghq
 */
function saveProxyBypassRules(): void {
  void save({ proxyBypassRules: proxyBypassRules.value.trim() })
}

/**
 * 设置钉钉操作按钮的忙碌状态，避免用户重复提交请求。
 * @param busy 是否正在执行异步操作。
 * @returns 无返回值。
 * @author zhenghq
 */
function setDingTalkBusy(busy: boolean): void {
  dingTalkSave.disabled = busy
  dingTalkCheck.disabled = busy
  dingTalkClearSecret.disabled = busy || !dingTalkSecretStatus.classList.contains('configured')
}

/**
 * 将钉钉检测结果展示为结构化状态提示。
 * @param status 主进程返回的脱敏检测状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderDingTalkStatus(status: DingTalkCheckStatus): void {
  dingTalkStatus.textContent = status.ok ? `✓ ${status.message}` : `✗ ${status.message}`
  dingTalkStatus.className = status.ok
    ? 'status dingtalk-status online'
    : 'status dingtalk-status offline'
  dingTalkStatus.dataset.code = status.code
}

/**
 * 保存钉钉启用状态、应用标识和可选的新 ClientSecret。
 * @returns 保存完成后的 Promise。
 * @author zhenghq
 */
async function saveDingTalkConfig(): Promise<void> {
  setDingTalkBusy(true)
  try {
    const settings = await window.api.setDingTalkConfig({
      enabled: dingTalkEnabled.checked,
      corpId: dingTalkCorpId.value,
      clientId: dingTalkClientId.value,
      clientSecret: dingTalkClientSecret.value
    })
    renderSettings(settings)
    flash('钉钉配置已保存并生效')
  } catch (error) {
    flash(`钉钉配置保存失败：${(error as Error).message || '未知错误'}`)
  } finally {
    setDingTalkBusy(false)
  }
}

/**
 * 确认后显式清除主进程安全保存的钉钉 ClientSecret。
 * @returns 清除完成后的 Promise。
 * @author zhenghq
 */
async function clearDingTalkClientSecret(): Promise<void> {
  if (!window.confirm('确定清除已保存的钉钉 ClientSecret 吗？清除后钉钉翻译将暂停使用。')) return

  setDingTalkBusy(true)
  try {
    const settings = await window.api.clearDingTalkSecret()
    renderSettings(settings)
    dingTalkStatus.textContent = 'Secret 已清除，请重新配置后检测'
    dingTalkStatus.className = 'status dingtalk-status'
    delete dingTalkStatus.dataset.code
    flash('钉钉 ClientSecret 已清除')
  } catch (error) {
    flash(`清除失败：${(error as Error).message || '未知错误'}`)
  } finally {
    setDingTalkBusy(false)
  }
}

/**
 * 检测已保存的钉钉凭证、鉴权和文本翻译链路。
 * @returns 检测完成后的 Promise。
 * @author zhenghq
 */
async function checkDingTalkConfig(): Promise<void> {
  setDingTalkBusy(true)
  dingTalkStatus.textContent = '检测中…'
  dingTalkStatus.className = 'status dingtalk-status'
  delete dingTalkStatus.dataset.code
  try {
    renderDingTalkStatus(await window.api.checkDingTalk())
  } catch (error) {
    renderDingTalkStatus({
      ok: false,
      code: 'service',
      message: (error as Error).message || '检测失败，请稍后重试'
    })
  } finally {
    setDingTalkBusy(false)
  }
}

/**
 * 设置微软翻译控件的忙碌状态，避免重复保存或检测。
 * @param busy 是否正在执行异步操作。
 * @returns 无返回值。
 * @author zhenghq
 */
function setMicrosoftBusy(busy: boolean): void {
  microsoftEnabled.disabled = busy
  microsoftCheck.disabled = busy
}

/**
 * 将微软翻译检测结果展示为结构化状态提示。
 * @param status 主进程返回的脱敏检测状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderMicrosoftStatus(status: MicrosoftCheckStatus): void {
  microsoftStatus.textContent = status.ok ? `✓ ${status.message}` : `✗ ${status.message}`
  microsoftStatus.className = status.ok
    ? 'status microsoft-status online'
    : 'status microsoft-status offline'
  microsoftStatus.dataset.code = status.code
}

/**
 * 通过普通设置接口保存免订阅微软翻译启用状态。
 * @returns 保存完成后的 Promise。
 * @author zhenghq
 */
async function saveMicrosoftEnabled(): Promise<void> {
  setMicrosoftBusy(true)
  try {
    const settings = await window.api.setSettings({ microsoftEnabled: microsoftEnabled.checked })
    renderSettings(settings)
    microsoftStatus.textContent = settings.microsoftEnabled ? '已启用，建议检测当前可用性' : '通道已关闭'
    microsoftStatus.className = 'status microsoft-status'
    delete microsoftStatus.dataset.code
    flash('微软翻译启用状态已保存并生效')
  } catch (error) {
    renderSettings(await window.api.getSettings())
    flash(`微软翻译启用状态保存失败：${(error as Error).message || '未知错误'}`)
  } finally {
    setMicrosoftBusy(false)
  }
}

/**
 * 检测免订阅微软 Bing 网页鉴权和文本翻译链路。
 * @returns 检测完成后的 Promise。
 * @author zhenghq
 */
async function checkMicrosoftConfig(): Promise<void> {
  setMicrosoftBusy(true)
  microsoftStatus.textContent = '检测中…'
  microsoftStatus.className = 'status microsoft-status'
  delete microsoftStatus.dataset.code
  try {
    renderMicrosoftStatus(await window.api.checkMicrosoft())
  } catch (error) {
    renderMicrosoftStatus({
      ok: false,
      code: 'service',
      message: (error as Error).message || '检测失败，请稍后重试'
    })
  } finally {
    setMicrosoftBusy(false)
  }
}

/**
 * 保存自建 DeepLX 地址。
 * @returns 无返回值。
 * @author zhenghq
 */
function saveDeepLxUrl(): void {
  void save({ deepLxUrl: deeplxUrl.value.trim() })
}

/**
 * 检测自建 DeepLX 服务在线状态。
 * @returns 检测完成后的 Promise。
 * @author zhenghq
 */
async function checkDeepLxStatus(): Promise<void> {
  deeplxStatus.textContent = '检测中…'
  deeplxStatus.className = 'status'
  const status = await window.api.checkDeepLx(deeplxUrl.value)
  if (status.online) {
    deeplxStatus.textContent = '✓ 在线'
    deeplxStatus.className = 'status online'
  } else {
    deeplxStatus.textContent = '✗ 离线：' + (status.message || '无法连接')
    deeplxStatus.className = 'status offline'
  }
}

/**
 * 复制 DeepLX Docker 部署命令。
 * @returns 复制完成后的 Promise。
 * @author zhenghq
 */
async function copyDockerCommand(): Promise<void> {
  window.api.copy(dockerCmd.value)
  flash('已复制命令')
}

/**
 * 打开 DeepLX 部署文档。
 * @returns 无返回值。
 * @author zhenghq
 */
function openDeployDocument(): void {
  window.api.openDeployDoc()
}

/**
 * 确认后关闭设置窗口并停止后台翻译服务。
 * @returns 无返回值。
 * @author zhenghq
 */
function requestStopService(): void {
  const confirmed = window.confirm(
    '停止服务后，托盘图标和划词翻译功能都会退出。需要使用时请重新启动应用。确定停止吗？'
  )
  if (!confirmed) return
  window.api.stopService()
}

initializeSettingsTabs()

targetLang.addEventListener('change', saveTargetLanguage)
sourceLang.addEventListener('change', saveSourceLanguage)
triggerMode.addEventListener('change', saveTriggerMode)
hotkey.addEventListener('change', saveHotkey)
autohide.addEventListener('change', saveAutoHide)
proxyMode.addEventListener('change', saveProxyMode)
proxyRules.addEventListener('change', saveProxyRules)
proxyBypassRules.addEventListener('change', saveProxyBypassRules)
dingTalkSave.addEventListener('click', () => void saveDingTalkConfig())
dingTalkClearSecret.addEventListener('click', () => void clearDingTalkClientSecret())
dingTalkCheck.addEventListener('click', () => void checkDingTalkConfig())
microsoftEnabled.addEventListener('change', () => void saveMicrosoftEnabled())
microsoftCheck.addEventListener('click', () => void checkMicrosoftConfig())
deeplxUrl.addEventListener('change', saveDeepLxUrl)
deeplxCheck.addEventListener('click', () => void checkDeepLxStatus())
dockerCopy.addEventListener('click', () => void copyDockerCommand())
openDoc.addEventListener('click', openDeployDocument)
stopServiceButton.addEventListener('click', requestStopService)
checkUpdateButton.addEventListener('click', () => void checkApplicationUpdate())
updateActionButton.addEventListener('click', () => void runUpdateAction())
openReleaseButton.addEventListener('click', () => void openApplicationRelease())
window.api.onSettingsChanged(renderSettings)
window.api.onUpdateStatusChanged(renderUpdateStatus)

void initialize()
