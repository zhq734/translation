import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildEdgeSpeechSsml,
  createEdgeSpeechClient,
  edgeVoiceForLanguage,
  edgeVoiceToSsmlName,
  type EdgeSpeechSocket
} from '../src/main/edgeSpeech.ts'

test('Edge 语音应按目标语言使用固定神经网络音色', () => {
  assert.equal(edgeVoiceForLanguage('ZH'), 'zh-CN-XiaoxiaoNeural')
  assert.equal(edgeVoiceForLanguage('zh-CN'), 'zh-CN-XiaoxiaoNeural')
  assert.equal(edgeVoiceForLanguage('EN'), 'en-US-JennyNeural')
  assert.equal(edgeVoiceForLanguage('ja-JP'), 'ja-JP-NanamiNeural')
  assert.equal(edgeVoiceForLanguage('unknown'), 'en-US-JennyNeural')
})

test('Edge 简短音色应转换为服务要求的完整音色名称', () => {
  assert.equal(
    edgeVoiceToSsmlName('zh-CN-XiaoxiaoNeural'),
    'Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoxiaoNeural)'
  )
  assert.equal(
    edgeVoiceToSsmlName('zh-CN-liaoning-XiaobeiNeural'),
    'Microsoft Server Speech Text to Speech Voice (zh-CN-liaoning, XiaobeiNeural)'
  )
  const fullName = 'Microsoft Server Speech Text to Speech Voice (en-US, JennyNeural)'
  assert.equal(edgeVoiceToSsmlName(fullName), fullName)
})

test('Edge SSML 应包含固定音色、正常一倍语速并转义用户文本', () => {
  const ssml = buildEdgeSpeechSsml('中文 <测试> & 内容', 'ZH')
  assert.match(
    ssml,
    /voice name=['"]Microsoft Server Speech Text to Speech Voice \(zh-CN, XiaoxiaoNeural\)['"]/u
  )
  assert.match(ssml, /rate=['"]\+0%['"]/u)
  assert.match(ssml, /中文 &lt;测试&gt; &amp; 内容/u)
  assert.doesNotMatch(ssml, /<测试>/u)
})

class FakeSocket implements EdgeSpeechSocket {
  readyState = 0
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.()
  }
}

function audioFrame(data: Uint8Array): ArrayBuffer {
  const header = new TextEncoder().encode('Content-Type:audio/mpeg\r\nPath:audio\r\n\r\n')
  const frame = new Uint8Array(2 + header.length + data.length)
  frame[0] = header.length >> 8
  frame[1] = header.length & 0xff
  frame.set(header, 2)
  frame.set(data, 2 + header.length)
  return frame.buffer
}

test('Edge 客户端应收集合成音频并在结束后返回临时音频数据', async () => {
  const socket = new FakeSocket()
  const socketArguments: unknown[][] = []
  const client = createEdgeSpeechClient({
    socketFactory: (...args: unknown[]) => {
      socketArguments.push(args)
      return socket
    },
    timeoutMs: 1000,
    now: () => new Date('2026-08-20T00:00:00.000Z'),
    connectionId: () => 'test-connection',
    muid: () => 'TEST-CONNECTION'
  })
  const resultPromise = client.synthesize('hello', 'EN')
  socket.open()
  socket.onmessage?.({ data: audioFrame(new Uint8Array([1, 2, 3])) })
  socket.onmessage?.({ data: 'Path:turn.end\r\n\r\n' })
  const result = await resultPromise
  assert.equal(result.ok, true)
  assert.deepEqual([...(result.audio ?? [])], [1, 2, 3])
  assert.equal(result.mimeType, 'audio/mpeg')
  assert.match(socket.sent[0] ?? '', /Path:speech\.config/u)
  assert.match(
    socket.sent[1] ?? '',
    /Microsoft Server Speech Text to Speech Voice \(en-US, JennyNeural\)/u
  )
  assert.deepEqual(socketArguments[0]?.[1], {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    Cookie: 'muid=TEST-CONNECTION;'
  })
})

test('Edge 客户端超时、空音频和取消都应返回脱敏错误', async () => {
  const timeoutSocket = new FakeSocket()
  const timeoutClient = createEdgeSpeechClient({
    socketFactory: () => timeoutSocket,
    timeoutMs: 5,
    now: () => new Date('2026-08-20T00:00:00.000Z')
  })
  const timeoutResult = await timeoutClient.synthesize('不要出现在错误里的原文', 'ZH')
  assert.equal(timeoutResult.ok, false)
  assert.match(timeoutResult.error ?? '', /超时/u)
  assert.doesNotMatch(timeoutResult.error ?? '', /不要出现在错误里的原文/u)

  const emptySocket = new FakeSocket()
  const emptyClient = createEdgeSpeechClient({ socketFactory: () => emptySocket, timeoutMs: 1000 })
  const emptyPromise = emptyClient.synthesize('empty', 'EN')
  emptySocket.open()
  emptySocket.onmessage?.({ data: 'Path:turn.end\r\n\r\n' })
  const emptyResult = await emptyPromise
  assert.equal(emptyResult.ok, false)
  assert.match(emptyResult.error ?? '', /音频/u)

  const cancelSocket = new FakeSocket()
  const cancelClient = createEdgeSpeechClient({ socketFactory: () => cancelSocket, timeoutMs: 1000 })
  const controller = new AbortController()
  const cancelPromise = cancelClient.synthesize('cancel', 'EN', controller.signal)
  cancelSocket.open()
  controller.abort()
  const cancelResult = await cancelPromise
  assert.equal(cancelResult.ok, false)
  assert.match(cancelResult.error ?? '', /取消/u)
})
