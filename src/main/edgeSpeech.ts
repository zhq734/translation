import { createHash, randomBytes } from 'node:crypto'
import type { EdgeSpeechResult } from '../shared/types'

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const EDGE_BASE_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
const EDGE_GEC_VERSION = '1-143.0.3650.75'
const EDGE_BROWSER_MAJOR_VERSION = '143'
const DEFAULT_TIMEOUT_MS = 20_000

/** Edge WebSocket 握手使用的请求头。 */
export type EdgeSpeechSocketHeaders = Record<string, string>

/** Edge WebSocket 的最小可测试接口。 */
export interface EdgeSpeechSocket {
  readyState: number
  binaryType: string
  onopen: (() => void) | null
  onmessage: ((event: { data: string | ArrayBuffer | Uint8Array }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  send(data: string): void
  close(): void
  dispose?(): void
}

interface EdgeSpeechClientOptions {
  socketFactory?: (
    url: string,
    headers: EdgeSpeechSocketHeaders
  ) => EdgeSpeechSocket | Promise<EdgeSpeechSocket>
  timeoutMs?: number
  now?: () => Date
  connectionId?: () => string
  muid?: () => string
}

const EDGE_VOICE_BY_LANGUAGE: Readonly<Record<string, string>> = {
  zh: 'zh-CN-XiaoxiaoNeural',
  en: 'en-US-JennyNeural',
  ja: 'ja-JP-NanamiNeural',
  ko: 'ko-KR-SunHiNeural',
  fr: 'fr-FR-DeniseNeural',
  de: 'de-DE-KatjaNeural',
  es: 'es-ES-ElviraNeural'
}

/**
 * 根据目标语言选择固定的 Edge 神经网络音色。
 * @param language 项目语言代码或 BCP 47 语言代码。
 * @returns Edge 音色名称，未知语言回退英文音色。
 * @author zhenghq
 */
export function edgeVoiceForLanguage(language: string): string {
  const prefix = language.trim().toLowerCase().split('-')[0]
  return EDGE_VOICE_BY_LANGUAGE[prefix] ?? EDGE_VOICE_BY_LANGUAGE.en
}

/**
 * 将简短 Edge 音色标识转换为浏览器实际发送的完整 SSML 音色名称。
 * @param voice 简短音色标识或已经完整的音色名称。
 * @returns Edge 服务兼容的完整音色名称，未知格式保持原值。
 * @author zhenghq
 */
export function edgeVoiceToSsmlName(voice: string): string {
  const match = /^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$/u.exec(voice)
  if (!match) return voice
  const [, language, baseRegion, regionalName] = match
  const separatorIndex = regionalName.indexOf('-')
  const region = separatorIndex >= 0
    ? `${baseRegion}-${regionalName.slice(0, separatorIndex)}`
    : baseRegion
  const name = separatorIndex >= 0
    ? regionalName.slice(separatorIndex + 1)
    : regionalName
  return `Microsoft Server Speech Text to Speech Voice (${language}-${region}, ${name})`
}

/**
 * 转义 SSML 中的用户文本，避免译文改变 XML 结构。
 * @param text 待转义的译文。
 * @returns 可放入 SSML 文本节点的安全字符串。
 * @author zhenghq
 */
function escapeSsmlText(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;')
}

/**
 * 构造 Edge 在线语音使用的 SSML 请求。
 * @param text 待朗读的译文。
 * @param language 目标语言代码。
 * @returns 包含固定音色和正常一倍语速的 SSML。
 * @author zhenghq
 */
export function buildEdgeSpeechSsml(text: string, language: string): string {
  const voice = edgeVoiceToSsmlName(edgeVoiceForLanguage(language))
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${voice}"><prosody rate="+0%" volume="+0%" pitch="+0Hz">${escapeSsmlText(text)}</prosody></voice></speak>`
}

/**
 * 生成 Edge 协议需要的时间戳文本。
 * @param date 当前时间。
 * @returns JavaScript 风格的 UTC 时间文本。
 * @author zhenghq
 */
function edgeTimestamp(date: Date): string {
  return date.toUTCString().replace(', ', ' ').replace(' GMT', ' GMT+0000 (Coordinated Universal Time)')
}

/**
 * 生成 Edge 服务要求的 Sec-MS-GEC 校验值。
 * @param date 当前时间。
 * @returns 大写 SHA-256 校验值。
 * @author zhenghq
 */
function generateSecMsGec(date: Date): string {
  const windowsSeconds = Math.floor(date.getTime() / 1000) + 11_644_473_600
  const roundedTicks = Math.floor(windowsSeconds / 300) * 300 * 10_000_000
  return createHash('sha256')
    .update(`${roundedTicks}${TRUSTED_CLIENT_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase()
}

/**
 * 生成 Edge WebSocket 请求标识。
 * @param connectionId 可选的测试或调用方标识生成器。
 * @returns 小写十六进制连接标识。
 * @author zhenghq
 */
function defaultConnectionId(): string {
  return randomBytes(16).toString('hex')
}

/**
 * 生成 Edge 握手 Cookie 使用的浏览器 MUID。
 * @returns 大写十六进制 MUID。
 * @author zhenghq
 */
function defaultMuid(): string {
  return randomBytes(16).toString('hex').toUpperCase()
}

/**
 * 构造与 Edge 浏览器扩展一致的 WebSocket 握手请求头。
 * @param muid 当前请求使用的匿名浏览器标识。
 * @returns Edge 在线语音握手请求头。
 * @author zhenghq
 */
function buildEdgeSocketHeaders(muid: string): EdgeSpeechSocketHeaders {
  return {
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${EDGE_BROWSER_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${EDGE_BROWSER_MAJOR_VERSION}.0.0.0`,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    Cookie: `muid=${muid};`
  }
}

/**
 * 生成 Edge WebSocket 的握手地址。
 * @param date 当前时间。
 * @param connectionId 连接标识。
 * @returns 带有临时校验参数的 WebSocket 地址。
 * @author zhenghq
 */
function buildEdgeSocketUrl(date: Date, connectionId: string): string {
  const params = new URLSearchParams({
    TrustedClientToken: TRUSTED_CLIENT_TOKEN,
    ConnectionId: connectionId,
    'Sec-MS-GEC': generateSecMsGec(date),
    'Sec-MS-GEC-Version': EDGE_GEC_VERSION
  })
  return `${EDGE_BASE_URL}?${params.toString()}`
}

/**
 * 构造 Edge WebSocket 的命令消息。
 * @param path Edge 协议路径。
 * @param body 命令正文。
 * @param contentType 内容类型。
 * @param requestId 请求标识。
 * @param timestamp 当前时间文本。
 * @returns Edge 协议文本帧。
 * @author zhenghq
 */
function edgeCommand(
  path: string,
  body: string,
  contentType: string,
  requestId: string,
  timestamp: string
): string {
  const requestHeader = path === 'ssml' ? `X-RequestId:${requestId}\r\n` : ''
  return `${requestHeader}Content-Type:${contentType}\r\nX-Timestamp:${timestamp}Z\r\nPath:${path}\r\n\r\n${body}`
}

/**
 * 从 Edge 二进制音频帧中提取 MP3 数据。
 * @param value WebSocket 收到的二进制数据。
 * @returns 音频内容；帧不是音频时返回 null。
 * @author zhenghq
 */
function parseAudioFrame(value: ArrayBuffer | Uint8Array): Uint8Array | null {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  if (bytes.byteLength < 2) return null
  const headerLength = (bytes[0] << 8) | bytes[1]
  if (headerLength + 2 > bytes.byteLength) return null
  const header = new TextDecoder().decode(bytes.slice(2, 2 + headerLength))
  if (!/(?:^|\r\n)Path:audio(?:\r\n|$)/u.test(header)) return null
  const contentType = /(?:^|\r\n)Content-Type:([^\r\n]+)/u.exec(header)?.[1]?.trim()
  if (contentType && contentType !== 'audio/mpeg') return null
  return bytes.slice(2 + headerLength)
}

/**
 * 创建 Edge 在线语音客户端。
 * @param options WebSocket、超时和时间生成器配置。
 * @returns 支持合成与取消的 Edge 客户端。
 * @author zhenghq
 */
export function createEdgeSpeechClient(options: EdgeSpeechClientOptions = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = options.now ?? (() => new Date())
  const connectionId = options.connectionId ?? defaultConnectionId
  const muid = options.muid ?? defaultMuid
  const socketFactory = options.socketFactory ?? ((
    url: string,
    _headers: EdgeSpeechSocketHeaders
  ): EdgeSpeechSocket => {
    const socket = new globalThis.WebSocket(url) as unknown as EdgeSpeechSocket
    socket.binaryType = 'arraybuffer'
    return socket
  })

  /**
   * 请求 Edge 服务生成临时 MP3 音频。
   * @param text 待朗读译文。
   * @param language 目标语言代码。
   * @param signal 可选取消信号。
   * @returns 临时音频或脱敏错误。
   * @author zhenghq
   */
  async function synthesize(
    text: string,
    language: string,
    signal?: AbortSignal
  ): Promise<EdgeSpeechResult> {
    if (!text.trim()) return { ok: false, error: '朗读文本为空' }
    if (signal?.aborted) return { ok: false, error: 'Edge 语音请求已取消' }

    const currentDate = now()
    console.log('[edge-speech] WebSocket 请求开始', {
      language,
      textLength: text.trim().length
    })
    let socket: EdgeSpeechSocket
    try {
      const socketResult = socketFactory(
        buildEdgeSocketUrl(currentDate, connectionId()),
        buildEdgeSocketHeaders(muid())
      )
      socket = socketResult instanceof Promise ? await socketResult : socketResult
    } catch {
      console.error('[edge-speech] WebSocket 创建失败')
      return { ok: false, error: 'Edge 语音服务连接失败' }
    }
    const requestId = randomBytes(16).toString('hex')
    const timestamp = edgeTimestamp(currentDate)
    const chunks: Uint8Array[] = []
    let timer: ReturnType<typeof setTimeout> | null = null
    let settled = false

    return await new Promise<EdgeSpeechResult>((resolve) => {
      const finish = (result: EdgeSpeechResult): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        socket.onopen = null
        socket.onmessage = null
        socket.onerror = null
        socket.onclose = null
        if (socket.readyState < 2) socket.close()
        socket.dispose?.()
        console.log('[edge-speech] WebSocket 请求结束', {
          ok: result.ok,
          audioBytes: result.audio?.byteLength ?? 0,
          error: result.error
        })
        resolve(result)
      }

      const abort = (): void => finish({ ok: false, error: 'Edge 语音请求已取消' })
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => finish({ ok: false, error: 'Edge 语音请求超时' }), timeoutMs)
      socket.onopen = (): void => {
        console.log('[edge-speech] WebSocket 已连接，发送 speech.config 和 ssml')
        socket.send(edgeCommand(
          'speech.config',
          '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}',
          'application/json; charset=utf-8',
          requestId,
          timestamp
        ))
        socket.send(edgeCommand(
          'ssml',
          buildEdgeSpeechSsml(text, language),
          'application/ssml+xml',
          requestId,
          timestamp
        ))
      }
      socket.onmessage = (event): void => {
        if (typeof event.data === 'string') {
          if (/(?:^|\r\n)Path:turn\.end(?:\r\n|$)/u.test(event.data)) {
            const audio = chunks.length > 0
              ? concatBytes(chunks)
              : new Uint8Array()
            finish(audio.length > 0
              ? { ok: true, audio, mimeType: 'audio/mpeg' }
              : { ok: false, error: 'Edge 语音服务未返回音频' })
          }
          return
        }
        const audio = parseAudioFrame(event.data)
        if (audio && audio.length > 0) chunks.push(audio)
      }
      socket.onerror = (): void => finish({ ok: false, error: 'Edge 语音服务连接失败' })
      socket.onclose = (): void => {
        if (!settled) finish(chunks.length > 0
          ? { ok: true, audio: concatBytes(chunks), mimeType: 'audio/mpeg' }
          : { ok: false, error: 'Edge 语音服务连接已关闭' })
      }
    })
  }

  return { synthesize }
}

/**
 * 合并多个音频片段为一个临时字节数组。
 * @param chunks 音频片段列表。
 * @returns 合并后的音频数据。
 * @author zhenghq
 */
function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
