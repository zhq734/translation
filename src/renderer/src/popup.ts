import { LANGUAGES, langLabel } from '../../shared/langs'
import {
  isTranslationProviderAvailable,
  TRANSLATION_PROVIDERS,
  translationProviderLabel
} from '../../shared/translationProviders'
import type { Settings, TranslatePayload } from '../../shared/types'

const sourceLangEl = document.getElementById('source-lang') as HTMLSelectElement
const targetLangEl = document.getElementById('target-lang') as HTMLSelectElement
const resultEl = document.getElementById('result') as HTMLElement
const originalEl = document.getElementById('original') as HTMLElement
const statusEl = document.getElementById('status') as HTMLElement
const translationProviderEl = document.getElementById('translation-provider') as HTMLSelectElement
const copyBtn = document.getElementById('copy') as HTMLButtonElement
const pinBtn = document.getElementById('pin') as HTMLButtonElement
const settingsBtn = document.getElementById('open-settings') as HTMLButtonElement
const closeBtn = document.getElementById('close') as HTMLButtonElement

let lastTranslation = ''
let lastOriginal = ''
let statusTimer: ReturnType<typeof setTimeout> | null = null
let pinned = false
let currentSettings: Settings | null = null

/**
 * 初始化源语言和目标语言下拉选项，并加载持久化设置。
 * @returns 初始化完成后的 Promise。
 * @author zhenghq
 */
async function initializeSelectors(): Promise<void> {
  const sourceOptions = [{ code: 'auto', label: '自动检测' }, ...LANGUAGES]
  const targetOptions = [{ code: 'auto', label: '自动中英互译' }, ...LANGUAGES]
  for (const language of sourceOptions) {
    sourceLangEl.add(new Option(language.label, language.code))
  }
  for (const language of targetOptions) {
    targetLangEl.add(new Option(language.label, language.code))
  }

  const settings = await window.api.getSettings()
  currentSettings = settings
  sourceLangEl.value = settings.sourceLang
  targetLangEl.value = settings.targetLang
  renderTranslationProviderOptions(settings)
}

/**
 * 根据当前配置渲染翻译 API 下拉项，未启用或未配置的 API 保持可见但不可选择。
 * @param settings 当前完整设置。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderTranslationProviderOptions(settings: Settings): void {
  translationProviderEl.replaceChildren()
  translationProviderEl.add(new Option('自动选择', 'auto'))
  for (const provider of TRANSLATION_PROVIDERS) {
    const available = isTranslationProviderAvailable(provider.id, settings)
    const option = new Option(
      available ? provider.label : `${provider.label}（未启用）`,
      provider.id
    )
    option.disabled = !available
    translationProviderEl.add(option)
  }
  translationProviderEl.value = settings.preferredTranslationProvider
  if (!translationProviderEl.value) translationProviderEl.value = 'auto'
  renderTranslationProviderResult()
}

/**
 * 在下拉框选中项中展示首选 API 与本次实际使用 API，降级时不改变持久化首选项。
 * @param actualProvider 本次实际完成翻译的 API。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderTranslationProviderResult(actualProvider?: TranslatePayload['provider']): void {
  const preferredProvider = currentSettings?.preferredTranslationProvider ?? 'auto'
  const selectedOption = translationProviderEl.selectedOptions[0]
  if (!selectedOption) return

  const preferredLabel = translationProviderLabel(preferredProvider)
  if (!actualProvider) {
    selectedOption.textContent = preferredLabel
    translationProviderEl.title = `首选翻译 API：${preferredLabel}`
    return
  }

  const actualLabel = translationProviderLabel(actualProvider)
  if (preferredProvider === 'auto') {
    selectedOption.textContent = `自动 · ${actualLabel}`
    translationProviderEl.title = `自动选择，实际使用：${actualLabel}`
    return
  }
  if (preferredProvider !== actualProvider) {
    selectedOption.textContent = `${preferredLabel} → ${actualLabel}`
    translationProviderEl.title = `首选 ${preferredLabel} 已熔断或不可用，实际使用：${actualLabel}`
    return
  }
  selectedOption.textContent = preferredLabel
  translationProviderEl.title = `首选并实际使用：${preferredLabel}`
}

/**
 * 在弹窗底部短暂显示操作状态。
 * @param message 状态提示内容。
 * @returns 无返回值。
 * @author zhenghq
 */
function flashStatus(message: string): void {
  statusEl.textContent = message
  if (statusTimer) clearTimeout(statusTimer)
  statusTimer = setTimeout(() => {
    statusEl.textContent = ''
    statusTimer = null
  }, 1400)
}

/**
 * 回显翻译负载携带的语言偏好，避免自动解析后的实际目标覆盖“自动中英互译”。
 * @param payload 翻译状态或结果。
 * @returns 无返回值。
 * @author zhenghq
 */
function syncLanguageSelectors(payload: TranslatePayload): void {
  if (payload.sourcePreference) sourceLangEl.value = payload.sourcePreference
  if (payload.targetPreference) targetLangEl.value = payload.targetPreference
}

/**
 * 将翻译状态或结果渲染到常驻弹窗。
 * @param payload 翻译状态或结果。
 * @returns 无返回值。
 * @author zhenghq
 */
function render(payload: TranslatePayload): void {
  syncLanguageSelectors(payload)
  if (payload.original) lastOriginal = payload.original

  if (payload.loading) {
    renderTranslationProviderResult()
    resultEl.textContent = '正在翻译…'
    resultEl.classList.add('loading')
    originalEl.textContent = payload.original ?? lastOriginal
    copyBtn.style.display = 'none'
    statusEl.textContent = payload.targetLang
      ? `正在翻译为${langLabel(payload.targetLang)}…`
      : '正在翻译…'
    return
  }

  resultEl.classList.remove('loading')
  if (!payload.ok) {
    renderTranslationProviderResult()
    resultEl.textContent = payload.error ?? '未知错误'
    originalEl.textContent = lastOriginal
    copyBtn.style.display = 'none'
    statusEl.textContent = '翻译失败'
    return
  }

  const sourceName = payload.detectedLang
    ? langLabel(payload.detectedLang)
    : payload.sourceLang === 'auto'
      ? '自动检测'
      : langLabel(payload.sourceLang ?? '')
  const targetName = langLabel(payload.targetLang ?? '')
  renderTranslationProviderResult(payload.provider)

  resultEl.textContent = payload.translation ?? ''
  originalEl.textContent = payload.original ?? lastOriginal
  copyBtn.style.display = ''
  statusEl.textContent = `${sourceName} → ${targetName}`
}

/**
 * 使用当前下拉框语言偏好重新翻译弹窗中的原文。
 * @returns 重新翻译完成后的 Promise。
 * @author zhenghq
 */
async function retranslateWithCurrentLanguages(): Promise<void> {
  if (!lastOriginal) return
  sourceLangEl.disabled = true
  targetLangEl.disabled = true
  try {
    await window.api.retranslate(sourceLangEl.value, targetLangEl.value)
  } catch {
    flashStatus('重新翻译失败')
  } finally {
    sourceLangEl.disabled = false
    targetLangEl.disabled = false
  }
}

/**
 * 保存用户选择的首选翻译 API，并立即使用新优先级重新翻译当前文本。
 * @returns 保存与重译完成后的 Promise。
 * @author zhenghq
 */
async function changeTranslationProvider(): Promise<void> {
  const previousProvider = currentSettings?.preferredTranslationProvider ?? 'auto'
  translationProviderEl.disabled = true
  try {
    currentSettings = await window.api.setSettings({
      preferredTranslationProvider: translationProviderEl.value as Settings['preferredTranslationProvider']
    })
    renderTranslationProviderOptions(currentSettings)
    if (lastOriginal) await retranslateWithCurrentLanguages()
    else flashStatus(`已优先使用${translationProviderLabel(currentSettings.preferredTranslationProvider)}`)
  } catch {
    translationProviderEl.value = previousProvider
    flashStatus('翻译 API 切换失败')
  } finally {
    translationProviderEl.disabled = false
  }
}

/**
 * 同步主进程广播的设置变化，使翻译 API 可用状态和首选项保持最新。
 * @param settings 最新完整设置。
 * @returns 无返回值。
 * @author zhenghq
 */
function syncSettings(settings: Settings): void {
  currentSettings = settings
  renderTranslationProviderOptions(settings)
}

/**
 * 复制当前译文到系统剪贴板。
 * @returns 无返回值。
 * @author zhenghq
 */
function copyTranslation(): void {
  if (!lastTranslation) return
  window.api.copy(lastTranslation)
  flashStatus('已复制')
}

/**
 * 更新图钉按钮的视觉状态和无障碍属性。
 * @param value 弹窗是否已固定。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderPinnedState(value: boolean): void {
  pinned = value
  pinBtn.setAttribute('aria-pressed', String(value))
  pinBtn.title = value ? '取消固定弹窗' : '固定弹窗'
  pinBtn.setAttribute('aria-label', pinBtn.title)
}

/**
 * 切换翻译弹窗的固定状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function togglePinned(): void {
  renderPinnedState(!pinned)
  window.api.setPinned(pinned)
}

/**
 * 打开应用设置页面。
 * @returns 无返回值。
 * @author zhenghq
 */
function openSettings(): void {
  window.api.openSettings()
}

/**
 * 关闭翻译弹窗。
 * @returns 无返回值。
 * @author zhenghq
 */
function closePopup(): void {
  window.api.hide()
}

/**
 * 响应键盘快捷操作，按 Esc 显式关闭弹窗。
 * @param event 键盘事件。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closePopup()
}

window.api.onResult((payload) => {
  lastTranslation = payload.translation ?? ''
  render(payload)
})

sourceLangEl.addEventListener('change', () => void retranslateWithCurrentLanguages())
targetLangEl.addEventListener('change', () => void retranslateWithCurrentLanguages())
translationProviderEl.addEventListener('change', () => void changeTranslationProvider())
copyBtn.addEventListener('click', copyTranslation)
pinBtn.addEventListener('click', togglePinned)
settingsBtn.addEventListener('click', openSettings)
closeBtn.addEventListener('click', closePopup)
document.addEventListener('keydown', handleKeydown)
window.api.onPinnedChanged(renderPinnedState)
window.api.onSettingsChanged(syncSettings)
renderPinnedState(false)

void initializeSelectors()
