import type { AiProtocol } from '../shared/types'
import { AiError } from './aiErrors'
import { translateMain } from './messages'

/** 协议流式解析器对外接口。 */
export interface AiStreamParser {
  /**
   * 追加一段网络分片并返回本次解析出的文本增量。
   * @param chunk 网络分片文本。
   * @returns 本次新增的文本增量，可能为空数组。
   * @author zhenghq
   */
  push(chunk: string): string[]
  /**
   * 冲刷解析器内部缓冲区并返回剩余文本增量。
   * @returns 剩余文本增量，可能为空数组。
   * @author zhenghq
   */
  finish(): string[]
}

/**
 * 创建指定 AI 协议的流式解析器。
 * @param protocol AI 协议类型。
 * @returns 支持增量追加和结束冲刷的解析器。
 * @author zhenghq
 */
export function createAiStreamParser(protocol: AiProtocol): AiStreamParser {
  if (protocol === 'ollama') return new OllamaLineStreamParser()
  if (protocol === 'claude-code') return new SseStreamParser('claude-code')
  return new SseStreamParser('openai')
}

/**
 * 从协议 JSON 事件中提取文本增量，遇到错误事件时抛出脱敏异常。
 * @param protocol AI 协议类型。
 * @param data 已解析的事件对象。
 * @returns 文本增量；元数据或空增量返回空字符串。
 * @author zhenghq
 */
function extractStreamDelta(protocol: AiProtocol, data: Record<string, unknown>): string {
  if (data.error) {
    throw new AiError('service', translateMain('ai.error.serviceUnavailable'))
  }
  if (protocol === 'openai') {
    const choices = data.choices as Array<{ delta?: { content?: string } }> | undefined
    return String(choices?.[0]?.delta?.content ?? '')
  }
  if (protocol === 'claude-code') {
    if (data.type === 'error') {
      throw new AiError('service', translateMain('ai.error.serviceUnavailable'))
    }
    if (data.type !== 'content_block_delta') return ''
    const delta = data.delta as { type?: string; text?: string } | undefined
    if (delta?.type !== 'text_delta') return ''
    return String(delta.text ?? '')
  }
  return ''
}

/**
 * 解析 OpenAI 与 Claude Code 使用的 SSE 事件流。
 * @author zhenghq
 */
class SseStreamParser implements AiStreamParser {
  private buffer = ''
  private done = false

  constructor(private readonly protocol: AiProtocol) {}

  /**
   * 追加网络分片，按空行切分完整 SSE 事件并解析文本增量。
   * @param chunk 网络分片文本。
   * @returns 本次解析出的文本增量。
   * @author zhenghq
   */
  push(chunk: string): string[] {
    if (this.done) return []
    this.buffer += chunk
    const deltas: string[] = []
    let separator = this.buffer.search(/\r?\n\r?\n/u)
    while (separator >= 0) {
      const rawEvent = this.buffer.slice(0, separator)
      const separatorLength = this.buffer[separator] === '\r' ? 4 : 2
      this.buffer = this.buffer.slice(separator + separatorLength)
      const delta = this.parseEvent(rawEvent)
      if (delta) deltas.push(delta)
      separator = this.buffer.search(/\r?\n\r?\n/u)
    }
    return deltas
  }

  /**
   * 冲刷末尾尚未以空行结束的 SSE 事件。
   * @returns 剩余文本增量。
   * @author zhenghq
   */
  finish(): string[] {
    if (this.done || !this.buffer.trim()) {
      this.buffer = ''
      return []
    }
    const rawEvent = this.buffer
    this.buffer = ''
    const delta = this.parseEvent(rawEvent)
    return delta ? [delta] : []
  }

  /**
   * 解析单个 SSE 事件的所有 data 行。
   * @param rawEvent 不含事件分隔符的事件文本。
   * @returns 事件中的文本增量。
   * @author zhenghq
   */
  private parseEvent(rawEvent: string): string {
    const dataLines = rawEvent
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
    if (dataLines.length === 0) return ''
    const payload = dataLines.join('\n').trim()
    if (!payload) return ''
    if (payload === '[DONE]') {
      this.done = true
      return ''
    }
    let data: Record<string, unknown>
    try {
      data = JSON.parse(payload) as Record<string, unknown>
    } catch {
      // 非 JSON data 事件（心跳、注释等）按协议约定忽略。
      return ''
    }
    return extractStreamDelta(this.protocol, data)
  }
}

/**
 * 解析 Ollama /api/chat 使用的逐行 JSON 流。
 * @author zhenghq
 */
class OllamaLineStreamParser implements AiStreamParser {
  private buffer = ''
  private done = false

  /**
   * 追加网络分片，按换行切分完整 JSON 行并解析文本增量。
   * @param chunk 网络分片文本。
   * @returns 本次解析出的文本增量。
   * @author zhenghq
   */
  push(chunk: string): string[] {
    if (this.done) return []
    this.buffer += chunk
    const deltas: string[] = []
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      const delta = this.parseLine(line)
      if (delta) deltas.push(delta)
      newline = this.buffer.indexOf('\n')
    }
    return deltas
  }

  /**
   * 冲刷末尾没有换行的 JSON 行。
   * @returns 剩余文本增量。
   * @author zhenghq
   */
  finish(): string[] {
    if (this.done || !this.buffer.trim()) {
      this.buffer = ''
      return []
    }
    const line = this.buffer.trim()
    this.buffer = ''
    const delta = this.parseLine(line)
    return delta ? [delta] : []
  }

  /**
   * 解析单行 Ollama JSON。
   * @param line 去掉首尾空白的 JSON 行。
   * @returns 文本增量。
   * @author zhenghq
   */
  private parseLine(line: string): string {
    if (!line || this.done) return ''
    let data: Record<string, unknown>
    try {
      data = JSON.parse(line) as Record<string, unknown>
    } catch {
      return ''
    }
    if (data.error) {
      throw new AiError('service', translateMain('ai.error.serviceUnavailable'))
    }
    if (data.done === true) this.done = true
    const message = data.message as { content?: string } | undefined
    return String(message?.content ?? '')
  }
}
