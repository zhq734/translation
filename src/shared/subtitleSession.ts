/**
 * 实时字幕会话的共享协议。
 *
 * sidecar 与 Electron 主进程之间只交换低频文本事件；音频采样始终停留在
 * sidecar 内，避免高频 PCM 进入主进程。
 */

/** 实时字幕音频来源。 */
export type RealtimeSubtitleAudioSource = 'system' | 'microphone' | 'both'

/** 实时字幕 ASR 提供商。 */
export type RealtimeSubtitleAsrProvider = 'deepgram' | 'whisper' | 'websocket'

/**
 * 判断未知值是否为受支持的实时字幕 ASR 提供商。
 * @param value 待校验值。
 * @returns 是否为受支持的提供商。
 * @author zhenghq
 */
export function isRealtimeSubtitleAsrProvider(
  value: unknown
): value is RealtimeSubtitleAsrProvider {
  return value === 'deepgram' || value === 'whisper' || value === 'websocket'
}

/** 实时字幕显示模式。 */
export type RealtimeSubtitleDisplayMode = 'source' | 'target' | 'bilingual'

/** 字幕窗需要同步的视觉设置。 */
export interface RealtimeSubtitleWindowAppearance {
  /** 显示模式。 */
  displayMode: RealtimeSubtitleDisplayMode
  /** 字号。 */
  fontSize: number
  /** 文字颜色。 */
  textColor: string
  /** 是否点击穿透。 */
  clickThrough: boolean
}

/** 字幕窗局部鼠标交互状态。 */
export type RealtimeSubtitleMouseInteractionScope = 'toolbar' | 'window'

/** 点击穿透时主进程轮询到的指针位置及其拖拽命中状态。 */
export interface RealtimeSubtitlePointerPoint {
  /** 全局指针 x 坐标。 */
  x: number
  /** 全局指针 y 坐标。 */
  y: number
  /** 指针是否位于拖拽按钮命中区内。 */
  insideDragArea: boolean
}

/** 实时字幕会话状态。 */
export type RealtimeSubtitleSessionState = 'idle' | 'starting' | 'running' | 'paused' | 'stopping'

/** 当前音频活动与语音识别结果的对应关系。 */
export type RealtimeSubtitleAudioActivity = 'idle' | 'speech-pending' | 'speech-detected'

/** 实时字幕错误分类。 */
export type RealtimeSubtitleErrorCode =
  | 'permission-denied'
  | 'device-unavailable'
  | 'unsupported-platform'
  | 'network'
  | 'auth'
  | 'invalid-request'
  | 'sidecar-unavailable'
  | 'unknown'

/** 一条已提交的字幕段落。 */
export interface RealtimeSubtitleSegment {
  /** 段落标识，用于丢弃迟到译文。 */
  id: string
  /** 当前原文。 */
  sourceText: string
  /** 当前译文；为空表示尚未得到译文。 */
  translatedText: string
  /** 段落状态。 */
  status: 'partial' | 'translating' | 'translated' | 'error'
  /** 更新时间戳（毫秒）。 */
  updatedAt: number
}

/** sidecar 输出事件。 */
export type SubtitleSidecarEvent =
  | { type: 'ready' }
  | { type: 'partial'; text: string; lang?: string }
  | { type: 'final'; text: string; lang?: string }
  | { type: 'level'; rms: number }
  | { type: 'status'; state: RealtimeSubtitleSessionState }
  | { type: 'error'; code: RealtimeSubtitleErrorCode; message?: string }

/** 主进程发送给 sidecar 的控制命令。 */
export type SubtitleSidecarCommand =
  | {
      /** 启动命令标识。 */
      cmd: 'start'
      /** 音频来源。 */
      source: RealtimeSubtitleAudioSource
      /** ASR 提供商。 */
      asr: RealtimeSubtitleAsrProvider
      /** 识别语言，auto 表示自动检测。 */
      lang: string
    }
  | { cmd: 'pause' }
  | { cmd: 'resume' }
  | { cmd: 'stop' }

/** 实时字幕会话快照。 */
export interface RealtimeSubtitleSnapshot {
  /** 当前会话状态。 */
  state: RealtimeSubtitleSessionState
  /** 当前音频来源。 */
  audioSource: RealtimeSubtitleAudioSource
  /** 当前显示模式。 */
  displayMode: RealtimeSubtitleDisplayMode
  /** 是否正在显示字幕窗。 */
  windowVisible: boolean
  /** 当前原文预览。 */
  sourceText: string
  /** 当前译文。 */
  translatedText: string
  /** 当前音频是否活跃，以及是否已经识别到语音。 */
  audioActivity: RealtimeSubtitleAudioActivity
  /** 已提交段落，按时间从旧到新。 */
  segments: RealtimeSubtitleSegment[]
  /** 面向用户的错误信息。 */
  error?: string
  /** 结构化的错误分类，供界面选择修复入口。 */
  errorCode?: RealtimeSubtitleErrorCode
}

/** 实时字幕窗口视图模型，仅包含可直接渲染的文本与状态。 */
export interface RealtimeSubtitleViewModel {
  /** 当前会话状态。 */
  state: RealtimeSubtitleSessionState
  /** 当前显示模式。 */
  displayMode: RealtimeSubtitleDisplayMode
  /** 当前需要展示的原文；target 模式下为空。 */
  sourceText: string
  /** 当前需要展示的译文；source 模式下为空。 */
  translatedText: string
  /** 当前段落状态。 */
  status: RealtimeSubtitleSegment['status'] | 'empty'
  /** 当前音频活动提示；有声音但无语音时用于区分纯音乐与采集故障。 */
  audioActivity: RealtimeSubtitleAudioActivity
  /** 是否显示空态。 */
  empty: boolean
  /** 面向用户的错误文案。 */
  error: string
}

/**
 * 将实时字幕快照转换为字幕窗视图模型。
 * @param snapshot 主进程会话快照。
 * @returns 按显示模式裁剪后的可渲染视图。
 * @author zhenghq
 */
export function createRealtimeSubtitleViewModel(
  snapshot: RealtimeSubtitleSnapshot
): RealtimeSubtitleViewModel {
  const latest = snapshot.segments.at(-1)
  // 段落是字幕的权威来源；快照中的全局译文可能落后于新段落的创建，
  // 若继续回退到全局值，会把上一句译文带进当前句。
  const sourceText = latest ? latest.sourceText : snapshot.sourceText
  const translatedText = latest ? latest.translatedText : snapshot.translatedText
  const status = latest?.status ?? (sourceText ? 'partial' : 'empty')
  return {
    state: snapshot.state,
    displayMode: snapshot.displayMode,
    sourceText: snapshot.displayMode === 'target' ? '' : sourceText,
    translatedText: snapshot.displayMode === 'source' ? '' : translatedText,
    status,
    audioActivity: snapshot.audioActivity,
    empty: !sourceText && !translatedText,
    error: snapshot.error ?? ''
  }
}

/** 将 sidecar 控制命令编码为一行 JSON。 */
export function encodeSubtitleSidecarCommand(command: SubtitleSidecarCommand): string {
  return `${JSON.stringify(command)}\n`
}

/**
 * 解析 sidecar stdout 的单行事件。
 * @param line sidecar 输出行。
 * @returns 合法事件；空行、非法 JSON 或未知类型返回 null。
 * @author zhenghq
 */
export function parseSubtitleSidecarLine(line: string): SubtitleSidecarEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  switch (record.type) {
    case 'ready':
      return { type: 'ready' }
    case 'partial':
    case 'final': {
      if (typeof record.text !== 'string' || !record.text.trim()) return null
      return {
        type: record.type,
        text: record.text.trim(),
        ...(typeof record.lang === 'string' && record.lang.trim()
          ? { lang: record.lang.trim() }
          : {})
      }
    }
    case 'level': {
      const rawLevel = record.rms
      if (typeof rawLevel !== 'number' || !Number.isFinite(rawLevel)) return null
      return { type: 'level', rms: Math.min(1, Math.max(0, rawLevel)) }
    }
    case 'status':
      // sidecar 使用 stopped 表示会话结束，主进程统一归一化为可重连的 idle 状态。
      if (record.state === 'stopped') return { type: 'status', state: 'idle' }
      return isSessionState(record.state)
        ? { type: 'status', state: record.state }
        : null
    case 'error':
      return isErrorCode(record.code)
        ? {
            type: 'error',
            code: record.code,
            ...(typeof record.message === 'string' && record.message.trim()
              ? { message: record.message.trim() }
              : {})
          }
        : null
    default:
      return null
  }
}

/**
 * 把 sidecar 的 partial/final 事件归并为可渲染字幕段落。
 * partial 覆盖当前预览，final 固化当前段落并开启下一段。
 * @param segments 已有段落。
 * @param event partial 或 final 事件。
 * @param nextId 新段落标识生成器。
 * @param now 当前时间戳。
 * @returns 更新后的段落与新段落标识。
 * @author zhenghq
 */
export function mergeSubtitleSegments(
  segments: RealtimeSubtitleSegment[],
  event: Extract<SubtitleSidecarEvent, { type: 'partial' | 'final' }>,
  nextId: () => string,
  now = Date.now()
): { segments: RealtimeSubtitleSegment[]; activeId: string | null } {
  const next = segments.map((segment) => ({ ...segment }))
  // 只有最后一个段落仍处于 partial 时才是当前句。向后扫描历史段落会让
  // 迟到的预览回调把旧句重新标成 partial 后，新句继续覆盖旧句原文。
  const last = next.at(-1)
  const active = last?.status === 'partial' ? last : undefined
  if (event.type === 'partial') {
    if (active) {
      active.sourceText = event.text
      active.updatedAt = now
      return { segments: next, activeId: active.id }
    }
    const segment: RealtimeSubtitleSegment = {
      id: nextId(),
      sourceText: event.text,
      translatedText: '',
      status: 'partial',
      updatedAt: now
    }
    next.push(segment)
    return { segments: next.slice(-20), activeId: segment.id }
  }

  if (active) {
    active.sourceText = event.text
    active.status = 'translating'
    active.updatedAt = now
    return { segments: next.slice(-20), activeId: active.id }
  }
  const segment: RealtimeSubtitleSegment = {
    id: nextId(),
    sourceText: event.text,
    translatedText: '',
    status: 'translating',
    updatedAt: now
  }
  next.push(segment)
  return { segments: next.slice(-20), activeId: segment.id }
}

/** 判断值是否为合法音频来源。 */
export function isAudioSource(value: unknown): value is RealtimeSubtitleAudioSource {
  return value === 'system' || value === 'microphone' || value === 'both'
}

/** 判断值是否为合法显示模式。 */
export function isDisplayMode(value: unknown): value is RealtimeSubtitleDisplayMode {
  return value === 'source' || value === 'target' || value === 'bilingual'
}

/** 判断值是否为合法会话状态。 */
export function isSessionState(value: unknown): value is RealtimeSubtitleSessionState {
  return value === 'idle' || value === 'starting' || value === 'running' ||
    value === 'paused' || value === 'stopping'
}

/** 判断值是否为合法错误分类。 */
export function isErrorCode(value: unknown): value is RealtimeSubtitleErrorCode {
  return value === 'permission-denied' || value === 'device-unavailable' ||
    value === 'unsupported-platform' || value === 'network' || value === 'auth' ||
    value === 'invalid-request' || value === 'sidecar-unavailable' || value === 'unknown'
}
