import { LANGUAGES, langLabel } from '../../shared/langs'
import type { TranslatePayload } from '../../shared/types'

const sourceLangEl = document.getElementById('source-lang') as HTMLSelectElement
const targetLangEl = document.getElementById('target-lang') as HTMLSelectElement
const resultEl = document.getElementById('result') as HTMLElement
const originalEl = document.getElementById('original') as HTMLElement
const statusEl = document.getElementById('status') as HTMLElement
const copyBtn = document.getElementById('copy') as HTMLButtonElement
const pinBtn = document.getElementById('pin') as HTMLButtonElement
const settingsBtn = document.getElementById('open-settings') as HTMLButtonElement
const closeBtn = document.getElementById('close') as HTMLButtonElement

let lastTranslation = ''
let lastOriginal = ''
let statusTimer: ReturnType<typeof setTimeout> | null = null
let pinned = false

/**
 * 初始化源语言和目标语言下拉选项，并加载持久化设置。
 * @returns 初始化完成后的 Promise。
 * @author zhenghq
 */
async function initializeLanguageSelectors(): Promise<void> {
  const sourceOptions = [{ code: 'auto', label: '自动检测' }, ...LANGUAGES]
  const targetOptions = [{ code: 'auto', label: '自动中英互译' }, ...LANGUAGES]
  for (const language of sourceOptions) {
    sourceLangEl.add(new Option(language.label, language.code))
  }
  for (const language of targetOptions) {
    targetLangEl.add(new Option(language.label, language.code))
  }

  const settings = await window.api.getSettings()
  sourceLangEl.value = settings.sourceLang
  targetLangEl.value = settings.targetLang
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
  const channel = payload.channel && payload.channel !== '缓存' ? ` · ${payload.channel}` : ''

  resultEl.textContent = payload.translation ?? ''
  originalEl.textContent = payload.original ?? lastOriginal
  copyBtn.style.display = ''
  statusEl.textContent = `${sourceName} → ${targetName}${channel}`
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
copyBtn.addEventListener('click', copyTranslation)
pinBtn.addEventListener('click', togglePinned)
settingsBtn.addEventListener('click', openSettings)
closeBtn.addEventListener('click', closePopup)
document.addEventListener('keydown', handleKeydown)
window.api.onPinnedChanged(renderPinnedState)
renderPinnedState(false)

void initializeLanguageSelectors()
