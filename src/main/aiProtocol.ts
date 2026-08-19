import type { AiProtocol } from '../shared/types'

/** 统一 AI 翻译请求输入。 */
export interface AiTranslationRequestInput {
  /** AI 协议类型。 */
  protocol: AiProtocol
  /** 规范化前的 Base URL。 */
  baseUrl: string
  /** AI 模型名称。 */
  model: string
  /** 主进程读取的 API Key，可能为 null。 */
  apiKey: string | null
  /** 待翻译文本。 */
  text: string
  /** 已解析的源语言。 */
  sourceLang: string
  /** 已解析的目标语言。 */
  targetLang: string
}

/** 构造完成的 AI 请求。 */
export interface AiBuiltRequest {
  /** 请求方法。 */
  method: string
  /** 请求 URL。 */
  url: string
  /** 请求头。 */
  headers: Map<string, string>
  /** 请求体字符串。 */
  body: string
}

/**
 * 规范化 AI Base URL，去除首尾空白和末尾斜杠。
 * @param baseUrl 原始 Base URL。
 * @returns 规范化后的 Base URL。
 * @author zhenghq
 */
export function normalizeAiBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/u, '')
}

/**
 * 构造固定翻译系统提示，要求模型只输出译文。
 * @param sourceLang 源语言。
 * @param targetLang 目标语言。
 * @returns 翻译系统提示文本。
 * @author zhenghq
 */
function buildTranslationSystemPrompt(sourceLang: string, targetLang: string): string {
  return [
    '你是一个专业翻译引擎，请将用户输入的文本从',
    sourceLang,
    '翻译为',
    targetLang,
    '，只输出译文，保留换行和基本格式，不要输出解释、Markdown 代码块或额外引号。'
  ].join('')
}

/**
 * 根据协议构造统一 AI 翻译请求。
 * @param input 协议、Base URL、模型、凭证和语言信息。
 * @returns 可供网络请求使用的统一请求结构。
 * @author zhenghq
 */
export function buildAiTranslationRequest(input: AiTranslationRequestInput): AiBuiltRequest {
  const baseUrl = normalizeAiBaseUrl(input.baseUrl)
  const systemPrompt = buildTranslationSystemPrompt(input.sourceLang, input.targetLang)
  const headers = new Map<string, string>([['Content-Type', 'application/json']])

  switch (input.protocol) {
    case 'ollama': {
      const body = JSON.stringify({
        model: input.model,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: input.text }
        ]
      })
      return { method: 'POST', url: `${baseUrl}/api/chat`, headers, body }
    }
    case 'openai': {
      if (input.apiKey) headers.set('Authorization', `Bearer ${input.apiKey}`)
      const body = JSON.stringify({
        model: input.model,
        stream: false,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: input.text }
        ]
      })
      return { method: 'POST', url: `${baseUrl}/chat/completions`, headers, body }
    }
    case 'claude-code': {
      if (input.apiKey) headers.set('x-api-key', input.apiKey)
      headers.set('anthropic-version', '2023-06-01')
      const body = JSON.stringify({
        model: input.model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [
          { role: 'user', content: input.text }
        ]
      })
      return { method: 'POST', url: `${baseUrl}/v1/messages`, headers, body }
    }
    default: {
      throw new Error(`不支持的 AI 协议：${input.protocol}`)
    }
  }
}

/**
 * 从已解析的协议响应对象中异步解析出译文文本。
 * @param protocol AI 协议类型。
 * @param data 已解析的 JSON 对象。
 * @returns 去除首尾空白后的译文。
 * @author zhenghq
 */
export function extractAiTranslation(
  protocol: AiProtocol,
  data: Record<string, unknown>
): string {
  return extractTranslation(protocol, data)
}

/**
 * 同步从已解析的协议响应对象中提取译文。
 * @param protocol AI 协议类型。
 * @param data 已解析的 JSON 对象。
 * @returns 去除首尾空白后的译文。
 * @author zhenghq
 */
export function parseAiTranslationResponse(protocol: AiProtocol, data: Record<string, unknown>): string {
  return extractTranslation(protocol, data)
}

/**
 * 根据协议从已解析对象中提取译文文本。
 * @param protocol AI 协议类型。
 * @param data 已解析的 JSON 对象。
 * @returns 译文文本。
 * @author zhenghq
 */
function extractTranslation(protocol: AiProtocol, data: Record<string, unknown>): string {
  switch (protocol) {
    case 'ollama': {
      const message = data.message as { content?: string } | undefined
      return String(message?.content ?? '').trim()
    }
    case 'openai': {
      const choices = data.choices as Array<{ message?: { content?: string } }> | undefined
      return String(choices?.[0]?.message?.content ?? '').trim()
    }
    case 'claude-code': {
      const content = data.content as Array<{ type?: string; text?: string }> | undefined
      if (!Array.isArray(content)) return ''
      return content
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => String(block.text))
        .join('')
        .trim()
    }
    default:
      return ''
  }
}
