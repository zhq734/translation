import { LANGUAGES } from '../../shared/langs'
import { isCopyShortcut } from '../../shared/copyShortcutBehavior'
import type { DingTalkCheckStatus, Settings, TriggerMode } from '../../shared/types'

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
const deeplxUrl = document.getElementById('deeplx-url') as HTMLInputElement
const deeplxStatus = document.getElementById('deeplx-status') as HTMLElement
const deeplxCheck = document.getElementById('deeplx-check') as HTMLButtonElement
const dockerCmd = document.getElementById('docker-cmd') as HTMLTextAreaElement
const dockerCopy = document.getElementById('docker-copy') as HTMLButtonElement
const openDoc = document.getElementById('open-doc') as HTMLButtonElement
const stopServiceButton = document.getElementById('stop-service') as HTMLButtonElement
const schemaVersion = document.getElementById('schema-version') as HTMLElement
const savedEl = document.getElementById('saved') as HTMLElement

let flashTimer: ReturnType<typeof setTimeout> | null = null

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
deeplxUrl.addEventListener('change', saveDeepLxUrl)
deeplxCheck.addEventListener('click', () => void checkDeepLxStatus())
dockerCopy.addEventListener('click', () => void copyDockerCommand())
openDoc.addEventListener('click', openDeployDocument)
stopServiceButton.addEventListener('click', requestStopService)
window.api.onSettingsChanged(renderSettings)

void initialize()
