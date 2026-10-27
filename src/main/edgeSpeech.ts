import { randomBytes } from 'node:crypto'
import type { EdgeSpeechResult } from '../shared/types'
import { translateMain } from './messages'

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const EDGE_BASE_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
const EDGE_GEC_VERSION = '2-143.0.3650.75'
const EDGE_BROWSER_MAJOR_VERSION = '143'
const DEFAULT_TIMEOUT_MS = 20_000

const UINT32_MASK = 0xFFFF_FFFF
const SHA256_INITIAL = [
  0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
  0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19
] as const
const SHA256_STATE = [
  0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A,
  0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2
] as const
const SHA256_SCHEDULE = [
  0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA,
  0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6,
  0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33,
  0xD258B060, 0x72766564
] as const
const SHA256_ROUND_CONSTANTS = [
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5,
  0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
  0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3,
  0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC,
  0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
  0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7,
  0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13,
  0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
  0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3,
  0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5,
  0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
  0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208,
  0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2
] as const
const SHA256_ADJUSTMENT = 0xC9DC06A7
const SHA256_SIGMA0_ADJUSTMENT = 0x059C0B80
const SHA256_SIGMA1_ADJUSTMENT = 0x000B92C0
const CS64_COEFFICIENTS = [
  [0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D],
  [0x3BEB65BC, 0x29514038], [0xC89C5933, 0xB328CBDF],
  [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C],
  [0xE92491B1, 0x607801C6], [0xF0A5B9D5, 0x82B2C1FB],
  [0x06064CF3, 0xFA51A3DA], [0xDA79FA60, 0x207CC464],
  [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61],
  [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167]
] as const
const CS64_FACTOR = 0x82893933
const CS64_ADJUSTMENT0 = 0xF2F90B1A
const CS64_ADJUSTMENT1 = 0x0B1A0000

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
  const languageCode = language.trim().split('-')[0].toLowerCase()
  const xmlLanguage = EDGE_VOICE_BY_LANGUAGE[languageCode]
    ? languageCode === 'zh' ? 'zh-CN' : `${languageCode}-${edgeVoiceForLanguage(language).split('-')[1]}`
    : 'en-US'
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${xmlLanguage}"><voice name="${voice}"><prosody rate="+0%" volume="+0%" pitch="+0Hz">${escapeSsmlText(text)}</prosody></voice></speak>`
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
 * 计算带服务端时间校正的 Windows 文件时间字符串。
 * @param date 当前时间。
 * @returns 向下取整到五分钟的 100 纳秒时间戳。
 * @author zhenghq
 */
function edgeWindowsTimestamp(date: Date): string {
  const windowsSeconds = Math.floor(date.getTime() / 1000) + 11_644_473_600
  const roundedSeconds = Math.floor(windowsSeconds / 300) * 300
  return (BigInt(roundedSeconds) * 10_000_000n).toString()
}

/**
 * 将 32 位无符号整数拆成小端十六进制文本。
 * @param value 待编码整数。
 * @returns 8 位大写十六进制文本。
 * @author zhenghq
 */
function littleEndianHex(value: number): string {
  const normalized = value >>> 0
  const bytes = [
    normalized & 0xFF,
    (normalized >>> 8) & 0xFF,
    (normalized >>> 16) & 0xFF,
    (normalized >>> 24) & 0xFF
  ]
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
}

/**
 * 将 32 位整数循环左移 16 位。
 * @param value 待旋转整数。
 * @returns 旋转后的 32 位无符号整数。
 * @author zhenghq
 */
function rotateLeft16(value: number): number {
  const normalized = value >>> 0
  return (((normalized << 16) | (normalized >>> 16)) >>> 0)
}

/**
 * 将 32 位整数循环右移指定位数。
 * @param value 待旋转整数。
 * @param shift 右移位数。
 * @returns 旋转后的 32 位无符号整数。
 * @author zhenghq
 */
function rotateRight(value: number, shift: number): number {
  const normalized = value >>> 0
  return ((normalized >>> shift) | (normalized << (32 - shift))) >>> 0
}

/**
 * 按小端顺序把字节拆为 32 位整数，并在奇数长度时补零。
 * @param data 待拆分的字节。
 * @returns 32 位整数数组。
 * @author zhenghq
 */
function littleEndianWords(data: Uint8Array): number[] {
  const paddedLength = data.length + ((4 - (data.length % 4)) % 4)
  const padded = new Uint8Array(paddedLength)
  padded.set(data)
  const words: number[] = []
  for (let offset = 0; offset < padded.length; offset += 4) {
    words.push(
      (padded[offset] ?? 0)
      | ((padded[offset + 1] ?? 0) << 8)
      | ((padded[offset + 2] ?? 0) << 16)
      | ((padded[offset + 3] ?? 0) << 24)
    )
  }
  if (words.length % 2 === 1) words.push(0)
  return words
}

/**
 * 计算 Edge v2 token 的 SHA-256 小写 sigma0。
 * @param value 输入整数。
 * @returns 32 位小 sigma0 结果。
 * @author zhenghq
 */
function sha256Sigma0(value: number): number {
  return ((value >>> 7) ^ (value << 25) ^ (value >>> 18) ^ (value << 14) ^ (value >>> 3)) >>> 0
}

/**
 * 计算 Edge v2 token 的 SHA-256 小 sigma1。
 * @param value 输入整数。
 * @returns 32 位小 sigma1 结果。
 * @author zhenghq
 */
function sha256Sigma1(value: number): number {
  return ((value >>> 17) ^ (value << 15) ^ (value >>> 19) ^ (value << 13) ^ (value >>> 10)) >>> 0
}

/**
 * 扩展 SHA-256 消息字。
 * @param words 消息字数组。
 * @param firstWord 开始扩展的位置。
 * @returns 无返回值。
 * @author zhenghq
 */
function expandSha256Schedule(words: number[], firstWord = 16): void {
  for (let index = firstWord; index < 64; index += 1) {
    const x = words[index - 2] ?? 0
    const y = words[index - 15] ?? 0
    words.push(
      (sha256Sigma1(x) + (words[index - 7] ?? 0) + sha256Sigma0(y) + (words[index - 16] ?? 0))
      >>> 0
    )
  }
}

/**
 * 执行 Edge v2 token 所需的 SHA-256 轮函数。
 * @param state 初始状态。
 * @param words 消息字。
 * @param firstRound 开始轮次。
 * @returns 更新后的八个工作寄存器。
 * @author zhenghq
 */
function sha256Rounds(
  state: readonly number[],
  words: readonly number[],
  firstRound = 0
): number[] {
  let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = state
  const constants = firstRound === 14
    ? [...SHA256_ROUND_CONSTANTS.slice(0, 14), SHA256_ADJUSTMENT, ...SHA256_ROUND_CONSTANTS.slice(15)]
    : [...SHA256_ROUND_CONSTANTS]
  for (let index = firstRound; index < 64; index += 1) {
    const t1 = (
      h
      + (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25))
      + (g ^ (e & (f ^ g)))
      + (constants[index] ?? 0)
      + (words[index] ?? 0)
    ) >>> 0
    const t2 = (
      (rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22))
      + ((a & b) | (c & (a | b)))
    ) >>> 0
    h = g
    g = f
    f = e
    e = (d + t1) >>> 0
    d = c
    c = b
    b = a
    a = (t1 + t2) >>> 0
  }
  return [a, b, c, d, e, f, g, h]
}

/**
 * 计算 Edge v2 token 的定制 SHA-256 初始状态。
 * @param data token 原文前七个字节。
 * @returns SHA-256 初始状态。
 * @author zhenghq
 */
function sha256InitialState(data: Uint8Array): number[] {
  const words: number[] = new Array(16).fill(0)
  words[14] = ((data[0] ?? 0) << 16) | ((data[1] ?? 0) << 8) | (data[2] ?? 0)
  words[15] = ((data[3] ?? 0) << 24) | ((data[4] ?? 0) << 16) | ((data[5] ?? 0) << 8) | (data[6] ?? 0)
  for (let index = 16; index < 30; index += 1) {
    let value = SHA256_SCHEDULE[index - 16] ?? 0
    if (index - 2 >= 14) {
      const sigma = sha256Sigma1(words[index - 2] ?? 0)
      value += index === 16 ? (sigma ^ SHA256_SIGMA1_ADJUSTMENT) : sigma
    }
    if (index - 7 >= 14) value += words[index - 7] ?? 0
    if (index - 15 >= 14) {
      const sigma = sha256Sigma0(words[index - 15] ?? 0)
      value += index === 29 ? (sigma ^ SHA256_SIGMA0_ADJUSTMENT) : sigma
    }
    words.push(value >>> 0)
  }
  words.push((
    sha256Sigma1(words[28] ?? 0)
    + (words[23] ?? 0)
    + sha256Sigma0(words[15] ?? 0)
    + (words[14] ?? 0)
    + SHA256_ADJUSTMENT
    - (SHA256_ROUND_CONSTANTS[14] ?? 0)
  ) >>> 0)
  expandSha256Schedule(words, 31)
  const working = sha256Rounds(SHA256_STATE, words, 14)
  return SHA256_INITIAL.map((value, index) => (value + (working[index] ?? 0)) >>> 0)
}

/**
 * 计算 Edge v2 token 的定制 SHA-256 摘要。
 * @param data token 原文。
 * @returns 32 字节摘要。
 * @author zhenghq
 */
function edgeTokenSha256(data: Uint8Array): Uint8Array {
  if (data.length < 7) throw new Error('Edge token data is too short')
  const length = 57 + data.length
  const zeroPadding = ((55 - length) % 64 + 64) % 64
  const paddedLength = data.length + 2 + zeroPadding
  const padded = new Uint8Array(paddedLength)
  padded.set(data.subarray(7))
  padded[data.length - 7] = 0x80
  const bitLength = BigInt(length * 8)
  for (let index = 0; index < 8; index += 1) {
    padded[padded.length - 1 - index] = Number((bitLength >> BigInt(index * 8)) & 0xFFn)
  }
  let state = sha256InitialState(data.subarray(0, 7))
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words: number[] = []
    for (let index = 0; index < 16; index += 1) {
      const position = offset + index * 4
      words.push(
        (((padded[position] ?? 0) << 24)
        | ((padded[position + 1] ?? 0) << 16)
        | ((padded[position + 2] ?? 0) << 8)
        | (padded[position + 3] ?? 0)) >>> 0
      )
    }
    expandSha256Schedule(words)
    const working = sha256Rounds(state, words)
    state = state.map((value, index) => (value + (working[index] ?? 0)) >>> 0)
  }
  const digest = new Uint8Array(32)
  state.forEach((value, index) => {
    digest[index * 4] = (value >>> 24) & 0xFF
    digest[index * 4 + 1] = (value >>> 16) & 0xFF
    digest[index * 4 + 2] = (value >>> 8) & 0xFF
    digest[index * 4 + 3] = value & 0xFF
  })
  return digest
}

/**
 * 计算 Edge v2 token 的 CS64 摘要。
 * @param data token 原文。
 * @param digest 已计算的 SHA-256 摘要。
 * @returns 两个 32 位摘要字。
 * @author zhenghq
 */
function edgeTokenCs64(data: Uint8Array, digest: Uint8Array): [number, number] {
  const keyA = ((digest[0] ?? 0) | ((digest[1] ?? 0) << 8) | ((digest[2] ?? 0) << 16) | ((digest[3] ?? 0) << 24) | 1) >>> 0
  const keyB = ((digest[4] ?? 0) | ((digest[5] ?? 0) << 8) | ((digest[6] ?? 0) << 16) | ((digest[7] ?? 0) << 24) | 1) >>> 0
  const factors = [Math.imul(keyA, CS64_FACTOR) >>> 0, Math.imul(keyB, CS64_FACTOR) >>> 0]
  const terms = CS64_COEFFICIENTS.map(([coefficient], index) => Math.imul(coefficient, factors[index % 2] ?? 0) >>> 0)
  const offsets = CS64_COEFFICIENTS.map(([, offset]) => offset >>> 0)
  const input = new Uint8Array(data.length + 1)
  input[0] = 0
  input.set(data, 1)
  littleEndianWords(input).forEach((word, index) => {
    let term = Math.imul(word, index % 2 === 0 ? keyA : keyB) >>> 0
    let offset = Math.imul(rotateLeft16(word), index % 2 === 0 ? 0xEF0569FB : 0xC31713DB) >>> 0
    if (index === 0) {
      term = (term + Math.imul(CS64_ADJUSTMENT0, factors[0] ?? 0)) >>> 0
      offset = (offset + CS64_ADJUSTMENT1) >>> 0
    }
    terms.push(term)
    offsets.push(offset)
  })
  let swapAcc = 0
  let swapLast = 0
  let state = 0
  let acc = 0
  for (let index = 0; index < terms.length; index += 2) {
    let x = terms[index] ?? 0
    let y = terms[index + 1] ?? 0
    let t = rotateLeft16(((offsets[index] ?? 0) + x) >>> 0)
    let q = Math.imul(t, 0x76F50F34) >>> 0
    swapAcc = (swapAcc + ((Math.imul(rotateLeft16(q), 0xC3EFEA97) + q) >>> 0)) >>> 0
    t = rotateLeft16(((offsets[index + 1] ?? 0) + y) >>> 0)
    q = Math.imul(t, 0x1881CE3C) >>> 0
    swapLast = (Math.imul(rotateLeft16(q), 0x35BD1EC9) + q) >>> 0
    swapAcc = (swapAcc + swapLast) >>> 0

    state = (Math.imul(state, keyA) + x) >>> 0
    state = Math.imul(rotateLeft16(state), 0xCF98B111) >>> 0
    state = Math.imul(rotateLeft16(state), 0x87085B9F) >>> 0
    state = Math.imul(rotateLeft16(state), 0x12CEB96D) >>> 0
    state = Math.imul(rotateLeft16(state), 0x257E1D83) >>> 0
    acc = (acc + state) >>> 0
    t = (Math.imul(state, keyB) + y) >>> 0
    t = Math.imul(rotateLeft16(t), 0xA27416F5) >>> 0
    t = Math.imul(rotateLeft16(t), 0xD38396FF) >>> 0
    state = Math.imul(rotateLeft16(Math.imul(rotateLeft16(t), 0x7C932B89) >>> 0), 0xBFA49F69) >>> 0
    acc = (acc + state) >>> 0
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0]
}

/**
 * 生成 Edge 服务当前要求的 Sec-MS-GEC 校验值。
 * @param date 当前时间。
 * @returns 16 位 CS64 与 64 位 SHA-256 组成的 v2 校验值。
 * @author zhenghq
 */
function generateSecMsGec(date: Date): string {
  const data = new TextEncoder().encode(`${edgeWindowsTimestamp(date)}${TRUSTED_CLIENT_TOKEN}`)
  const digest = edgeTokenSha256(data)
  const [first, second] = edgeTokenCs64(data, digest)
  const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
  return `${littleEndianHex(first)}${littleEndianHex(second)}-${sha256}`
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
    if (!text.trim()) return { ok: false, error: translateMain('speech.error.emptyText') }
    if (signal?.aborted) return { ok: false, error: translateMain('speech.error.cancelled') }

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
      return { ok: false, error: translateMain('speech.error.connectionFailed') }
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

      const abort = (): void => finish({ ok: false, error: translateMain('speech.error.cancelled') })
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => finish({ ok: false, error: translateMain('speech.error.timeout') }), timeoutMs)
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
              : { ok: false, error: translateMain('speech.error.noAudio') })
          }
          return
        }
        const audio = parseAudioFrame(event.data)
        if (audio && audio.length > 0) chunks.push(audio)
      }
      socket.onerror = (): void => finish({ ok: false, error: translateMain('speech.error.connectionFailed') })
      socket.onclose = (): void => {
        if (!settled) finish(chunks.length > 0
          ? { ok: true, audio: concatBytes(chunks), mimeType: 'audio/mpeg' }
          : { ok: false, error: translateMain('speech.error.connectionClosed') })
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
