import { session, type Session } from 'electron'
import { buildProxyConfig } from '../shared/proxySettings'
import type { Settings } from '../shared/types'

let translationSession: Session | null = null

/**
 * 获取翻译请求专用的 Electron 网络会话。
 * @returns 翻译网络会话。
 * @author zhenghq
 */
function getTranslationSession(): Session {
  if (!translationSession) {
    translationSession = session.fromPartition('translation-network')
  }
  return translationSession
}

/**
 * 将当前代理设置应用到翻译网络会话，并关闭旧代理遗留的连接池。
 * @param settings 当前完整设置。
 * @returns 代理应用完成后的 Promise。
 * @author zhenghq
 */
export async function applyTranslationProxy(settings: Settings): Promise<void> {
  const currentSession = getTranslationSession()
  await currentSession.setProxy(buildProxyConfig(settings))
  await currentSession.closeAllConnections()
  console.log('[network] 代理模式已应用:', settings.proxyMode)
}

/**
 * 使用翻译专用会话和已配置的代理发送网络请求。
 * @param input 请求地址或 Request 对象。
 * @param init 请求参数。
 * @returns 网络响应。
 * @author zhenghq
 */
export function translationFetch(input: string | Request, init?: RequestInit): Promise<Response> {
  return getTranslationSession().fetch(input, init) as Promise<Response>
}
