import type { Rectangle } from 'electron'
import { translateMain } from './messages'

/** 阅读器允许加载的远程协议。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Google Docs 编辑器文档地址匹配规则。
 *
 * 编辑器视图的正文由 canvas 绘制，DOM 内不存在正文字符节点，网页翻译无法提取；
 * `mobilebasic` 是 Google Docs 的服务端 HTML 导出视图，正文以真实文本节点输出。
 */
const GOOGLE_DOCS_EDITOR_PATH = /^\/document\/(?:u\/(\d+)\/)?d\/([\w-]+)\/edit\/?$/u

/**
 * 把 Google Docs 编辑器地址转换为服务端 HTML 导出视图地址。
 *
 * Google Docs 编辑器把正文绘制在 canvas 上，DOM 中没有可提取、可写回的文本节点，
 * 因此网页翻译既提取不到正文，也无法把译文写回。`mobilebasic` 是同一文档的服务端
 * HTML 渲染视图，正文以真实 `<h1>/<p>/<span>/<table>` 文本节点输出，且标题 id 与
 * 编辑器锚点（如 `#heading=h.xxx` 对应 `id="h.xxx"`）一致，可直接复用现有文本提取与
 * 原位写回链路。
 *
 * 仅转换文档（document）类型且路径为编辑视图的地址；表格、幻灯片、已发布地址、
 * 其他域名以及已经是 HTML 视图的地址都保持原样。
 * @param value 规范化后的阅读器 URL。
 * @returns 可提取正文文本的 HTML 视图地址；无需转换时返回原地址。
 * @author zhenghq
 */
export function toWebReaderHtmlViewUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return value
  }
  if (parsed.hostname !== 'docs.google.com') return value
  const match = GOOGLE_DOCS_EDITOR_PATH.exec(parsed.pathname)
  if (!match) return value
  const accountPrefix = match[1] ? `/u/${match[1]}` : ''
  parsed.pathname = `/document${accountPrefix}/d/${match[2]}/mobilebasic`
  // 编辑器标题锚点形如 #heading=h.xxx，HTML 视图中对应元素的 id 是 h.xxx；
  // 其余锚点（如书签）在 HTML 视图中没有等价目标，直接丢弃避免定位失败。
  const heading = /^#heading=(h\.[\w-]+)$/u.exec(parsed.hash)
  parsed.hash = heading ? `#${heading[1]}` : ''
  return parsed.toString()
}

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
    throw new Error(translateMain('webReader.error.invalidUrl'))
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(translateMain('webReader.error.onlyHttp'))
  }
  if (!parsed.hostname) throw new Error(translateMain('webReader.error.invalidUrl'))
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
