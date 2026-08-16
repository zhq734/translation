import type { ProxyMode } from './types'

/** Electron 可识别的代理配置子集。 */
export interface TranslationProxyConfig {
  mode: 'system' | 'direct' | 'fixed_servers'
  proxyRules?: string
  proxyBypassRules?: string
}

/** 构建代理配置所需的设置字段。 */
export interface ProxySettingsInput {
  proxyMode: ProxyMode
  proxyRules: string
  proxyBypassRules: string
}

/**
 * 将用户代理设置转换为 Electron Session 可识别的代理配置。
 * @param settings 用户保存的代理模式、规则和绕过规则。
 * @returns Electron 代理配置。
 * @author zhenghq
 */
export function buildProxyConfig(settings: ProxySettingsInput): TranslationProxyConfig {
  if (settings.proxyMode === 'direct') return { mode: 'direct' }
  if (settings.proxyMode === 'system') return { mode: 'system' }
  return {
    mode: 'fixed_servers',
    proxyRules: settings.proxyRules.trim(),
    proxyBypassRules: settings.proxyBypassRules.trim()
  }
}
