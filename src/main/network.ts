import { session, type Session } from 'electron'
import { ProxyAgent, WebSocket } from 'undici'
import { buildProxyConfig } from '../shared/proxySettings'
import type { Settings } from '../shared/types'
import type { EdgeSpeechSocket, EdgeSpeechSocketHeaders } from './edgeSpeech'
import { edgeSpeechProxyUrl } from './networkProxy'

export { edgeSpeechProxyUrl } from './networkProxy'

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

/**
 * 使用翻译专用 Electron Session 的代理解析结果创建 Edge WebSocket。
 * @param url Edge WebSocket 握手地址。
 * @param headers 模拟 Edge 浏览器扩展的握手请求头。
 * @returns 已应用当前代理策略的 WebSocket 兼容对象。
 * @author zhenghq
 */
export async function createTranslationWebSocket(
  url: string,
  headers: EdgeSpeechSocketHeaders
): Promise<EdgeSpeechSocket> {
  const proxyResult = await getTranslationSession().resolveProxy(url.replace(/^wss:/u, 'https:'))
  const proxyUrl = edgeSpeechProxyUrl(proxyResult)
  if (proxyUrl === undefined) throw new Error('当前代理类型不支持 Edge 在线语音')
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : null
  const socket = new WebSocket(url, dispatcher ? { dispatcher, headers } : { headers })
  socket.binaryType = 'arraybuffer'
  return {
    get readyState() {
      return socket.readyState
    },
    get binaryType() {
      return socket.binaryType
    },
    set binaryType(value: string) {
      socket.binaryType = value === 'arraybuffer' ? 'arraybuffer' : 'blob'
    },
    get onopen() {
      return socket.onopen as (() => void) | null
    },
    set onopen(handler: (() => void) | null) {
      socket.onopen = handler
    },
    get onmessage() {
      return socket.onmessage as ((event: { data: string | ArrayBuffer | Uint8Array }) => void) | null
    },
    set onmessage(handler: ((event: { data: string | ArrayBuffer | Uint8Array }) => void) | null) {
      socket.onmessage = handler as typeof socket.onmessage
    },
    get onerror() {
      return socket.onerror as (() => void) | null
    },
    set onerror(handler: (() => void) | null) {
      socket.onerror = handler
    },
    get onclose() {
      return socket.onclose as (() => void) | null
    },
    set onclose(handler: (() => void) | null) {
      socket.onclose = handler
    },
    send(data: string): void {
      socket.send(data)
    },
    close(): void {
      socket.close()
    },
    dispose(): void {
      if (dispatcher) void dispatcher.close()
    }
  }
}
