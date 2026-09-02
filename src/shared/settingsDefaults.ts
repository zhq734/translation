import type { AiProtocol, OcrEnginePreference, ProxyMode, Settings, SpeechProvider, TriggerMode, WebTranslationMode, WebTranslationScope } from './types'
import { DEFAULT_AI_BASE_URL, isAiProtocol, isOcrEnginePreference, normalizeOcrScale } from './types'
import { isTranslationProviderPreference } from './translationProviders'

export const SETTINGS_SCHEMA_VERSION = 16

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  targetLang: 'auto',
  sourceLang: 'auto',
  hotkey: 'Alt+T',
  autoHideMs: 0,
  deepLxUrl: '',
  triggerMode: 'button',
  doubleClickSelectionButtonEnabled: true,
  showDockIcon: false,
  autoLaunch: false,
  proxyMode: 'system',
  proxyRules: '',
  proxyBypassRules: '<local>;localhost;127.0.0.1',
  dingTalkEnabled: false,
  dingTalkCorpId: '',
  dingTalkClientId: '',
  dingTalkSecretConfigured: false,
  microsoftEnabled: false,
  aiEnabled: false,
  aiProtocol: 'ollama',
  aiBaseUrl: DEFAULT_AI_BASE_URL,
  aiModel: '',
  aiApiKeyConfigured: false,
  preferredTranslationProvider: 'auto',
  speechProvider: 'system',
  ocrEnginePreference: 'auto',
  ocrHotkey: 'Alt+O',
  ocrLang: 'auto',
  ocrScale: 1.25,
  ocrTesseractEnabled: true,
  webTranslationEnabled: true,
  webTranslationScope: 'all',
  webTranslationMaxBlocks: 1000,
  webTranslationMaxChars: 500000,
  webTranslationDefaultMode: 'target'
}

type LegacySettings = Partial<Settings> & {
  /** 第二版及更早版本使用的自动触发开关。 */
  autoTrigger?: boolean
}

/**
 * 判断触发方式是否为当前版本支持的值。
 * @param value 待校验的触发方式。
 * @returns 是否为合法触发方式。
 * @author zhenghq
 */
function isTriggerMode(value: unknown): value is TriggerMode {
  return value === 'auto' || value === 'button' || value === 'hotkey'
}

/**
 * 判断代理方式是否为当前版本支持的值。
 * @param value 待校验的代理方式。
 * @returns 是否为合法代理方式。
 * @author zhenghq
 */
function isProxyMode(value: unknown): value is ProxyMode {
  return value === 'system' || value === 'direct' || value === 'custom'
}

/**
 * 判断语音引擎是否为当前版本支持的值。
 * @param value 待校验的语音引擎。
 * @returns 是否为合法语音引擎。
 * @author zhenghq
 */
function isSpeechProvider(value: unknown): value is SpeechProvider {
  return value === 'system' || value === 'edge'
}

/**
 * 判断网页翻译范围是否合法。
 * @param value 待校验的值。
 * @returns 是否为合法网页翻译范围。
 * @author zhenghq
 */
function isWebTranslationScope(value: unknown): value is WebTranslationScope {
  return value === 'body' || value === 'all'
}

/**
 * 判断网页默认显示模式是否合法。
 * @param value 待校验的值。
 * @returns 是否为合法网页显示模式。
 * @author zhenghq
 */
function isWebTranslationMode(value: unknown): value is WebTranslationMode {
  return value === 'source' || value === 'target'
}

/**
 * 规范化网页翻译数值上限。
 * @param value 待规范化的值。
 * @param fallback 非有限数值的默认值。
 * @param maximum 允许的最大值。
 * @returns 处于一到最大值之间的整数。
 * @author zhenghq
 */
function normalizeWebLimit(value: unknown, fallback: number, maximum: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(maximum, Math.max(1, Math.floor(numeric)))
}

/**
 * 规范化 AI Base URL：去除首尾空白和末尾斜杠。
 * @param baseUrl 原始 Base URL。
 * @returns 规范化后的 Base URL。
 * @author zhenghq
 */
function normalizeAiBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "")
}

/**
 * 将磁盘中的设置规范化为当前版本，并兼容旧版 autoTrigger 配置。
 * @param rawSettings 磁盘读取到的未知版本设置。
 * @returns 当前版本的完整设置。
 * @author zhenghq
 */
export function normalizeSettings(rawSettings: LegacySettings = {}): Settings {
  const schemaVersion = Number(rawSettings.schemaVersion ?? 1)
  const merged = { ...DEFAULT_SETTINGS, ...rawSettings }
  let triggerMode: TriggerMode = isTriggerMode(rawSettings.triggerMode)
    ? rawSettings.triggerMode
    : rawSettings.autoTrigger
      ? 'auto'
      : 'button'

  // 第四版统一把第三版及更早配置迁移到按钮模式，后续版本升级保留用户选择。
  if (schemaVersion < 4) triggerMode = 'button'

  // 第十五版扩大网页翻译默认容量；仅迁移缺失字段和可确认的旧默认值，保留用户自定义限制。
  const webTranslationMaxBlocks = schemaVersion < 15 &&
    (rawSettings.webTranslationMaxBlocks === undefined || Number(rawSettings.webTranslationMaxBlocks) === 300)
    ? DEFAULT_SETTINGS.webTranslationMaxBlocks
    : normalizeWebLimit(merged.webTranslationMaxBlocks, DEFAULT_SETTINGS.webTranslationMaxBlocks, 5000)
  const webTranslationMaxChars = schemaVersion < 15 &&
    (rawSettings.webTranslationMaxChars === undefined || Number(rawSettings.webTranslationMaxChars) === 200000)
    ? DEFAULT_SETTINGS.webTranslationMaxChars
    : normalizeWebLimit(merged.webTranslationMaxChars, DEFAULT_SETTINGS.webTranslationMaxChars, 2000000)

  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    targetLang: schemaVersion < 2 ? 'auto' : String(merged.targetLang || 'auto'),
    sourceLang: String(merged.sourceLang || 'auto'),
    hotkey: String(merged.hotkey || ''),
    autoHideMs: schemaVersion < 2 ? 0 : Math.max(0, Number(merged.autoHideMs) || 0),
    deepLxUrl: String(merged.deepLxUrl || '').trim(),
    triggerMode,
    doubleClickSelectionButtonEnabled: merged.doubleClickSelectionButtonEnabled !== false,
    showDockIcon: rawSettings.showDockIcon === true,
    autoLaunch: rawSettings.autoLaunch === true,
    proxyMode: isProxyMode(rawSettings.proxyMode) ? rawSettings.proxyMode : 'system',
    proxyRules: String(merged.proxyRules || '').trim(),
    proxyBypassRules: String(merged.proxyBypassRules || '').trim(),
    dingTalkEnabled: rawSettings.dingTalkEnabled === true,
    dingTalkCorpId: String(merged.dingTalkCorpId || '').trim(),
    dingTalkClientId: String(merged.dingTalkClientId || '').trim(),
    dingTalkSecretConfigured: rawSettings.dingTalkSecretConfigured === true,
    microsoftEnabled: rawSettings.microsoftEnabled === true,
    preferredTranslationProvider: isTranslationProviderPreference(
      rawSettings.preferredTranslationProvider
    )
      ? rawSettings.preferredTranslationProvider
      : 'auto',
    aiEnabled: rawSettings.aiEnabled === true,
    aiProtocol: isAiProtocol(rawSettings.aiProtocol) ? rawSettings.aiProtocol : 'ollama',
    aiBaseUrl: normalizeAiBaseUrl(rawSettings.aiBaseUrl === undefined ? DEFAULT_AI_BASE_URL : String(merged.aiBaseUrl || "").trim()),
    aiModel: String(merged.aiModel || '').trim(),
    aiApiKeyConfigured: rawSettings.aiApiKeyConfigured === true,
    speechProvider: isSpeechProvider(rawSettings.speechProvider)
      ? rawSettings.speechProvider
      : 'system',
    ocrEnginePreference: isOcrEnginePreference(merged.ocrEnginePreference)
      ? merged.ocrEnginePreference
      : 'auto',
    ocrHotkey: String(merged.ocrHotkey || '').trim(),
    ocrLang: String(merged.ocrLang || 'auto').trim(),
    ocrScale: normalizeOcrScale(merged.ocrScale),
    ocrTesseractEnabled: merged.ocrTesseractEnabled !== false,
    webTranslationEnabled: merged.webTranslationEnabled !== false,
    // 第十四版将网页翻译默认范围扩展为全部可见文本，修复导航、按钮和标签遗漏。
    webTranslationScope: schemaVersion < 14
      ? 'all'
      : isWebTranslationScope(merged.webTranslationScope) ? merged.webTranslationScope : 'all',
    webTranslationMaxBlocks,
    webTranslationMaxChars,
    webTranslationDefaultMode: String(merged.webTranslationDefaultMode) === 'bilingual'
      ? 'target'
      : isWebTranslationMode(merged.webTranslationDefaultMode) ? merged.webTranslationDefaultMode : 'target'
  }
}
