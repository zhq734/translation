import type { ProxyMode, Settings, TriggerMode } from './types'
import { isTranslationProviderPreference } from './translationProviders'

export const SETTINGS_SCHEMA_VERSION = 8

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  targetLang: 'auto',
  sourceLang: 'auto',
  hotkey: 'Alt+T',
  autoHideMs: 0,
  deepLxUrl: '',
  triggerMode: 'button',
  proxyMode: 'system',
  proxyRules: '',
  proxyBypassRules: '<local>;localhost;127.0.0.1',
  dingTalkEnabled: false,
  dingTalkCorpId: '',
  dingTalkClientId: '',
  dingTalkSecretConfigured: false,
  microsoftEnabled: false,
  preferredTranslationProvider: 'auto'
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

  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    targetLang: schemaVersion < 2 ? 'auto' : String(merged.targetLang || 'auto'),
    sourceLang: String(merged.sourceLang || 'auto'),
    hotkey: String(merged.hotkey || ''),
    autoHideMs: schemaVersion < 2 ? 0 : Math.max(0, Number(merged.autoHideMs) || 0),
    deepLxUrl: String(merged.deepLxUrl || '').trim(),
    triggerMode,
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
      : 'auto'
  }
}
