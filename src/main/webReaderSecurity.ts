import type { Rectangle } from 'electron'

/** 阅读器允许加载的远程协议。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * 规范化并校验阅读器 URL，避免危险协议进入远程 WebContentsView。
 * @param value 用户输入的 URL。
 * @returns 可供 Electron 加载的绝对 URL。
 * @author zhenghq
 */
export function normalizeWebReaderUrl(value: string): string {
  const input = String(value ?? '').trim()
  const candidate = /^[a-z][a-z\d+.-]*:/iu.test(input) ? input : `https://${input}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('请输入有效的网页地址')
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('网页阅读器仅支持 HTTP 或 HTTPS 地址')
  }
  if (!parsed.hostname) throw new Error('请输入有效的网页地址')
  return parsed.toString()
}

/**
 * 将 Renderer 占位区矩形裁剪到 BrowserWindow 内容区，防止原生 View 越界。
 * @param bounds Renderer 上报的矩形。
 * @param contentSize 窗口内容区大小。
 * @returns 安全的整数矩形。
 * @author zhenghq
 */
export function sanitizeWebViewBounds(
  bounds: Pick<Rectangle, 'x' | 'y' | 'width' | 'height'>,
  contentSize: Pick<Rectangle, 'width' | 'height'>
): Rectangle {
  const x = Math.max(0, Math.round(Number(bounds.x) || 0))
  const y = Math.max(0, Math.round(Number(bounds.y) || 0))
  const width = Math.max(0, Math.min(Math.round(Number(bounds.width) || 0), Math.max(0, Math.round(contentSize.width) - x)))
  const height = Math.max(0, Math.min(Math.round(Number(bounds.height) || 0), Math.max(0, Math.round(contentSize.height) - y)))
  return { x, y, width, height }
}

/**
 * 判断新窗口或导航请求是否属于安全网页协议。
 * @param value 待检查的 URL。
 * @returns 允许加载时返回 true。
 * @author zhenghq
 */
export function isAllowedWebReaderUrl(value: string): boolean {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(value).protocol)
  } catch {
    return false
  }
}
