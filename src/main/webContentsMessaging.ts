import type { WebContents } from 'electron'
import { isDisposedWebFrameError } from '../shared/webTranslationErrors'

/**
 * 向仍然存活的 Electron WebContents 发送一条消息。
 * @param contents 目标 WebContents，可以为空。
 * @param channel IPC 通道名称。
 * @param payload 要发送的消息载荷。
 * @returns 成功发送时返回 true；目标已销毁或发送期间被销毁时返回 false。
 * @author zhenghq
 */
export function sendToAliveWebContents(
  contents: Pick<WebContents, 'isDestroyed' | 'send'> | null | undefined,
  channel: string,
  payload: unknown
): boolean {
  try {
    if (!contents || contents.isDestroyed()) return false
    contents.send(channel, payload)
    return true
  } catch (error) {
    if (isDisposedWebFrameError(error)) return false
    throw error
  }
}
