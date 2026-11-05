/**
 * 实时字幕会话的共享协议。
 *
 * sidecar 与 Electron 主进程之间只交换低频文本事件；音频采样始终停留在
 * sidecar 内，避免高频 PCM 进入主进程。
 */

/** 实时字幕音频来源。 */
export type RealtimeSubtitleAudioSource = 'system' | 'microphone' | 'both'

/** 实时字幕 ASR 提供商。 */
export type RealtimeSubtitleAsrProvider =
  | 'deepgram'
  | 'whisper'
  | 'websocket'
  | 'alibaba'
  | 'custom-dashscope'
  | 'custom-openai'
  | 'gemini'

/**
 * 判断未知值是否为受支持的实时字幕 ASR 提供商。
 * @param value 待校验值。
 * @returns 是否为受支持的提供商。
 * @author zhenghq
 */
export function isRealtimeSubtitleAsrProvider(
  value: unknown
): value is RealtimeSubtitleAsrProvider {
  return value === 'deepgram' ||
    value === 'whisper' ||
    value === 'websocket' ||
    value === 'alibaba' ||
    value === 'custom-dashscope' ||
    value === 'custom-openai' ||
    value === 'gemini'
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

/** 字幕 cue 切分选项。 */
export interface SplitSubtitleCueOptions {
  /** 单条 cue 的最大字符数，默认 32。 */
  maxLength?: number
  /** 切分后单条 cue 的期望最短字符数，默认按最大长度动态计算。 */
  minLength?: number
  /** sidecar 根据词级时间戳计算出的停顿边界，使用 Unicode 字符偏移。 */
  pauseBoundaries?: readonly number[]
}

/** 字幕切分候选边界。 */
interface SubtitleCueBoundary {
  /** 边界在 cue 内的字符偏移。 */
  index: number
  /** 越小越优先。 */
  priority: number
}

/** 字幕 cue 默认最大字符数，兼顾中文字幕可读性与长句翻译质量。 */
const DEFAULT_SUBTITLE_CUE_MAX_LENGTH = 32

/** 实时 partial 草稿在显示层最多保留的 cue 数量。 */
const REALTIME_PARTIAL_VISIBLE_CUE_COUNT = 1

/** 语义连接词优先级从长到短，避免短词先匹配掉更长短语。 */
const SUBTITLE_SEMANTIC_CONNECTORS = [
  '与此同时',
  '也可以',
  '还可以',
  '可以在',
  '此外',
  '另外',
  '同时',
  '以及',
  '但是',
  '不过',
  '因此',
  '所以',
  '包括',
  '截至',
  '例如',
  '比如',
  '而且',
  '然后',
  '其中'
] as const

/** 句末标点。 */
const SUBTITLE_SENTENCE_ENDINGS = new Set(['。', '！', '？', '!', '?', '；', ';'])

/** 句内停顿标点。 */
const SUBTITLE_CLAUSE_ENDINGS = new Set(['，', '、', '：', ',', ':'])

/** 可跟随在句末标点后的闭合符号。 */
const SUBTITLE_CLOSING_MARKS = new Set(['”', '’', '"', "'", '）', ')', ']', '】', '》'])

/**
 * 把一条长 final 拆成适合双语字幕展示的 cue。
 *
 * 切分优先级为：ASR 停顿边界、句末标点、句内标点、语义连接词、
 * 英文空格，最后才按长度兜底。所有 cue 按顺序拼接后与输入文本完全一致。
 * @param text 待切分的识别文本。
 * @param options 最大长度、最短长度与停顿边界。
 * @returns 按原文顺序排列的 cue；空白文本返回空数组。
 * @author zhenghq
 */
export function splitSubtitleCue(
  text: string,
  options: SplitSubtitleCueOptions = {}
): string[] {
  const normalized = text.trim()
  if (!normalized) return []

  const characters = Array.from(normalized)
  const maxLength = normalizePositiveInteger(options.maxLength, DEFAULT_SUBTITLE_CUE_MAX_LENGTH)
  const defaultMinLength = Math.max(4, Math.min(8, Math.floor(maxLength / 3)))
  const minLength = Math.min(
    maxLength,
    normalizePositiveInteger(options.minLength, defaultMinLength)
  )
  const pauseBoundaries = normalizePauseBoundaries(options.pauseBoundaries, characters.length)
  const sentenceRanges = findSentenceRanges(characters)
  const cues: string[] = []

  for (const range of sentenceRanges) {
    const sentence = characters.slice(range.start, range.end).join('')
    if (Array.from(sentence).length <= maxLength) {
      cues.push(sentence)
      continue
    }
    const localPauses = pauseBoundaries
      .filter((boundary) => boundary > range.start && boundary < range.end)
      .map((boundary) => boundary - range.start)
    cues.push(...subdivideLongSubtitleCue(sentence, maxLength, minLength, localPauses))
  }

  return cues
}

/**
 * 把可选数值规范为正整数。
 * @param value 原始数值。
 * @param fallback 缺省值。
 * @returns 大于零的整数。
 * @author zhenghq
 */
function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback
}

/**
 * 过滤、排序并去重停顿边界。
 * @param boundaries 原始 Unicode 字符偏移。
 * @param textLength 文本字符长度。
 * @returns 合法且按升序排列的边界。
 * @author zhenghq
 */
function normalizePauseBoundaries(
  boundaries: readonly number[] | undefined,
  textLength: number
): number[] {
  if (!boundaries?.length) return []
  return [...new Set(boundaries)]
    .filter((boundary) => Number.isInteger(boundary) && boundary > 0 && boundary < textLength)
    .sort((left, right) => left - right)
}

/**
 * 按句末标点计算完整句子范围。
 * @param characters 文本字符数组。
 * @returns 句子起止范围，结束位置不包含在范围内。
 * @author zhenghq
 */
function findSentenceRanges(characters: string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let start = 0
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? ''
    const isEnglishPeriod = character === '.' &&
      (index + 1 === characters.length || /\s/u.test(characters[index + 1] ?? ''))
    if (!SUBTITLE_SENTENCE_ENDINGS.has(character) && !isEnglishPeriod) continue
    let end = index + 1
    while (end < characters.length && SUBTITLE_CLOSING_MARKS.has(characters[end] ?? '')) {
      end += 1
    }
    if (end > start) ranges.push({ start, end })
    start = end
    index = end - 1
  }
  if (start < characters.length) ranges.push({ start, end: characters.length })
  return ranges.filter((range) => range.end > range.start)
}

/**
 * 对超过最大长度的单句继续按自然边界切分。
 * @param text 单句文本。
 * @param maxLength 最大字符数。
 * @param minLength 期望最短字符数。
 * @param pauseBoundaries 相对单句起点的停顿边界。
 * @returns 切分后的 cue。
 * @author zhenghq
 */
function subdivideLongSubtitleCue(
  text: string,
  maxLength: number,
  minLength: number,
  pauseBoundaries: readonly number[]
): string[] {
  const characters = Array.from(text)
  const cues: string[] = []
  let start = 0

  while (characters.length - start > maxLength) {
    const remainingLength = characters.length - start
    const hardLimit = Math.min(maxLength, remainingLength - Math.min(minLength, remainingLength - 1))
    const candidates = collectSubtitleCueBoundaries(
      characters,
      start,
      hardLimit,
      minLength,
      pauseBoundaries
    )
    const target = start + maxLength
    const selected = candidates
      .map((candidate) => ({
        ...candidate,
        score: candidate.priority + Math.abs(target - candidate.index)
      }))
      .sort((left, right) => left.score - right.score || right.index - left.index)[0]
    const fallback = findHardSubtitleBoundary(characters, start, target, minLength)
    const end = selected?.index ?? fallback
    if (end <= start) break
    cues.push(characters.slice(start, end).join(''))
    start = end
  }

  if (start < characters.length) cues.push(characters.slice(start).join(''))
  return cues
}

/**
 * 收集当前窗口内的自然切分边界。
 * @param characters 完整字符数组。
 * @param start 当前 cue 起点。
 * @param hardLimit 当前窗口允许的最大终点。
 * @param minLength 最短长度。
 * @param pauseBoundaries 相对整段文本的停顿边界。
 * @returns 候选边界列表。
 * @author zhenghq
 */
function collectSubtitleCueBoundaries(
  characters: string[],
  start: number,
  hardLimit: number,
  minLength: number,
  pauseBoundaries: readonly number[]
): SubtitleCueBoundary[] {
  const candidates: SubtitleCueBoundary[] = []
  const minimumIndex = start + minLength
  const pushCandidate = (index: number, priority: number): void => {
    if (index < minimumIndex || index > hardLimit) return
    if (isProtectedSubtitleBoundary(characters, index)) return
    candidates.push({ index, priority })
  }

  for (const boundary of pauseBoundaries) {
    pushCandidate(start + boundary, 0)
  }
  for (let index = start; index < hardLimit; index += 1) {
    const character = characters[index] ?? ''
    if (SUBTITLE_CLAUSE_ENDINGS.has(character)) {
      pushCandidate(advancePastClosingMarks(characters, index + 1), 2)
    } else if (character === '.' &&
      index + 1 < characters.length &&
      /\s/u.test(characters[index + 1] ?? '')) {
      pushCandidate(index + 1, 2)
    }
    if (isSemanticSubtitleBoundary(characters, index)) {
      pushCandidate(index, 4)
    }
    if (/\s/u.test(character)) {
      pushCandidate(index + 1, 8)
    }
  }
  return candidates
}

/**
 * 跳过一个标点后的闭合符号。
 * @param characters 字符数组。
 * @param index 标点后的位置。
 * @returns 闭合符号之后的位置。
 * @author zhenghq
 */
function advancePastClosingMarks(characters: string[], index: number): number {
  let next = index
  while (next < characters.length && SUBTITLE_CLOSING_MARKS.has(characters[next] ?? '')) {
    next += 1
  }
  return next
}

/**
 * 判断当前位置是否为语义连接词的起点。
 * @param characters 字符数组。
 * @param index 待判断位置。
 * @returns 是否应在该位置之前切分。
 * @author zhenghq
 */
function isSemanticSubtitleBoundary(characters: string[], index: number): boolean {
  if (index <= 0) return false
  const suffix = characters.slice(index, index + 8).join('')
  return SUBTITLE_SEMANTIC_CONNECTORS.some((connector) => suffix.startsWith(connector))
}

/**
 * 判断边界是否位于英文单词、数字或日期内部。
 * @param characters 字符数组。
 * @param index 边界位置。
 * @returns 是否受保护。
 * @author zhenghq
 */
function isProtectedSubtitleBoundary(characters: string[], index: number): boolean {
  if (index <= 0 || index >= characters.length) return false
  const text = characters.join('')
  const characterOffsets: number[] = []
  let offset = 0
  for (const character of characters) {
    characterOffsets.push(offset)
    offset += character.length
  }
  const protectedPattern = /[A-Za-z0-9]+(?:[._'/-][A-Za-z0-9]+)*/gu
  for (const match of text.matchAll(protectedPattern)) {
    const matchStart = match.index
    const matchEnd = matchStart + match[0].length
    const boundaryOffset = characterOffsets[index]
    if (boundaryOffset === undefined) continue
    if (boundaryOffset > matchStart && boundaryOffset < matchEnd) return true
  }
  return false
}

/**
 * 在自然边界不足时寻找不破坏单词的硬切点。
 * @param characters 字符数组。
 * @param start 当前 cue 起点。
 * @param target 期望终点。
 * @param minLength 最短长度。
 * @returns 可安全切分的位置。
 * @author zhenghq
 */
function findHardSubtitleBoundary(
  characters: string[],
  start: number,
  target: number,
  minLength: number
): number {
  const minimumIndex = start + minLength
  for (let index = Math.min(target, characters.length); index > minimumIndex; index -= 1) {
    if (!isProtectedSubtitleBoundary(characters, index)) return index
  }
  for (let index = target + 1; index < characters.length; index += 1) {
    if (!isProtectedSubtitleBoundary(characters, index)) return index
  }
  return Math.min(target, characters.length)
}

/** sidecar 输出事件。 */
export type SubtitleSidecarEvent =
  | { type: 'ready' }
  | {
      type: 'partial'
      text: string
      lang?: string
      /** 提供商在同一会话中返回的原生译文；没有时由主进程文字翻译补齐。 */
      translatedText?: string
      /** 原生译文的语言代码。 */
      translatedLang?: string
    }
  | {
      type: 'final'
      text: string
      lang?: string
      /** 词级时间戳计算出的停顿边界，使用 final 文本的 Unicode 字符偏移。 */
      pauseBoundaries?: number[]
      /** 提供商在同一会话中返回的原生译文；没有时由主进程文字翻译补齐。 */
      translatedText?: string
      /** 原生译文的语言代码。 */
      translatedLang?: string
    }
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
      /** 目标翻译语言；支持原生翻译的提供商据此在识别会话内返回译文。 */
      targetLang?: string
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
  /** 展示锁固定的段落标识；未设置时按最新段落展示。 */
  displaySegmentId?: string | null
  /** 面向用户的错误信息。 */
  error?: string
  /** 结构化的错误分类，供界面选择修复入口。 */
  errorCode?: RealtimeSubtitleErrorCode
}

/** 字幕窗口中的一条可渲染段落轨。 */
export interface RealtimeSubtitleViewModelSegment {
  /** 段落标识。 */
  segmentId: string
  /** 当前轨道原文；target 模式下为空。 */
  sourceText: string
  /** 当前轨道译文；source 模式下为空。 */
  translatedText: string
  /** 段落状态。 */
  status: RealtimeSubtitleSegment['status']
}

/** 实时字幕窗口视图模型，仅包含可直接渲染的文本与状态。 */
export interface RealtimeSubtitleViewModel {
  /** 当前会话状态。 */
  state: RealtimeSubtitleSessionState
  /** 当前展示段落标识；没有段落时为空。 */
  segmentId: string | null
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
  /** 上一句已确认字幕；没有可展示历史时为空。 */
  committed?: RealtimeSubtitleViewModelSegment | null
  /** 展示锁期间同时暴露的最新实时草稿；通常为空。 */
  live?: RealtimeSubtitleViewModelSegment | null
}

/**
 * 按显示模式裁剪一条字幕段落轨。
 * @param segment 待裁剪段落。
 * @param displayMode 当前显示模式。
 * @returns 可直接渲染的轨道；没有可见文本时返回 null。
 * @author zhenghq
 */
function createViewModelSegment(
  segment: RealtimeSubtitleSegment | undefined,
  displayMode: RealtimeSubtitleDisplayMode
): RealtimeSubtitleViewModelSegment | null {
  if (!segment) return null
  const sourceText = displayMode === 'target'
    ? ''
    : segment.status === 'partial'
      ? getVisiblePartialSourceText(segment.sourceText)
      : segment.sourceText
  // partial 与 final 一样按显示模式展示译文；主进程只把当前可见 cue 的
  // 预览译文写回段落，避免累计草稿的旧译文串到新分段。
  const translatedText = displayMode === 'source' ? '' : segment.translatedText
  if (!sourceText && !translatedText) return null
  return {
    segmentId: segment.id,
    sourceText,
    translatedText,
    status: segment.status
  }
}

/**
 * 将持续累计的 partial 草稿裁剪为最近一条可读 cue。
 * @param sourceText 宿主保留的完整 partial 草稿。
 * @returns 最近一条 cue；空白文本返回空字符串。
 * @author zhenghq
 */
export function getVisiblePartialSourceText(sourceText: string): string {
  const cues = splitSubtitleCue(sourceText, { maxLength: DEFAULT_SUBTITLE_CUE_MAX_LENGTH })
  return cues.slice(-REALTIME_PARTIAL_VISIBLE_CUE_COUNT).join('')
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
  const display = snapshot.displaySegmentId
    ? snapshot.segments.find((segment) => segment.id === snapshot.displaySegmentId)
    : undefined
  const primary = display ?? latest
  // 段落是字幕的权威来源；快照中的全局译文可能落后于新段落的创建，
  // 若继续回退到全局值，会把上一句译文带进当前句。
  const sourceText = primary
    ? primary.status === 'partial'
      ? getVisiblePartialSourceText(primary.sourceText)
      : primary.sourceText
    : snapshot.sourceText
  const translatedText = primary ? primary.translatedText : snapshot.translatedText
  const status = primary?.status ?? (sourceText ? 'partial' : 'empty')
  const primaryIndex = primary
    ? snapshot.segments.findIndex((segment) => segment.id === primary.id)
    : -1
  const liveSegment = latest && latest.id !== primary?.id ? latest : undefined
  const previous = primaryIndex > 0 ? snapshot.segments[primaryIndex - 1] : undefined
  const latestIsDraft = primary?.status === 'partial' || primary?.status === 'translating'
  const committedSource = liveSegment
    ? primary
    : latestIsDraft && previous?.status !== 'partial'
      ? previous
      : undefined
  const committed = createViewModelSegment(committedSource, snapshot.displayMode)
  const live = createViewModelSegment(liveSegment, snapshot.displayMode)
  const visibleSourceText = snapshot.displayMode === 'target' ? '' : sourceText
  const visibleTranslatedText = snapshot.displayMode === 'source' ? '' : translatedText
  return {
    state: snapshot.state,
    segmentId: primary?.id ?? null,
    displayMode: snapshot.displayMode,
    sourceText: visibleSourceText,
    translatedText: visibleTranslatedText,
    status,
    audioActivity: snapshot.audioActivity,
    empty: !visibleSourceText && !visibleTranslatedText && !committed && !live,
    error: snapshot.error ?? '',
    committed,
    live
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
      const translatedText = typeof record.translatedText === 'string'
        ? record.translatedText.trim()
        : ''
      const pauseBoundaries = record.type === 'final'
        ? normalizeParsedPauseBoundaries(record.pauseBoundaries, Array.from(record.text.trim()).length)
        : []
      return {
        type: record.type,
        text: record.text.trim(),
        ...(typeof record.lang === 'string' && record.lang.trim()
          ? { lang: record.lang.trim() }
          : {}),
        ...(pauseBoundaries.length ? { pauseBoundaries } : {}),
        ...(translatedText ? { translatedText } : {}),
        ...(typeof record.translatedLang === 'string' && record.translatedLang.trim()
          ? { translatedLang: record.translatedLang.trim() }
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
 * 解析 sidecar 输出的停顿边界，丢弃非法、越界和重复偏移。
 * @param value 原始 JSON 值。
 * @param textLength 字幕文本的 Unicode 字符长度。
 * @returns 升序排列的合法停顿边界。
 * @author zhenghq
 */
function normalizeParsedPauseBoundaries(value: unknown, textLength: number): number[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value)]
    .filter((boundary): boundary is number =>
      typeof boundary === 'number' &&
      Number.isInteger(boundary) &&
      boundary > 0 &&
      boundary < textLength
    )
    .sort((left, right) => left - right)
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
  const translatedText = event.translatedText?.trim() ?? ''
  const hasNativeTranslation = Boolean(translatedText)
  // 只有最后一个段落仍处于 partial 时才是当前句。向后扫描历史段落会让
  // 迟到的预览回调把旧句重新标成 partial 后，新句继续覆盖旧句原文。
  const last = next.at(-1)
  const active = last?.status === 'partial' ? last : undefined
  if (event.type === 'partial') {
    if (active) {
      active.sourceText = event.text
      if (translatedText) active.translatedText = translatedText
      active.updatedAt = now
      return { segments: next, activeId: active.id }
    }
    const segment: RealtimeSubtitleSegment = {
      id: nextId(),
      sourceText: event.text,
      translatedText,
      status: 'partial',
      updatedAt: now
    }
    next.push(segment)
    return { segments: next.slice(-20), activeId: segment.id }
  }

  if (active) {
    active.sourceText = event.text
    if (translatedText) active.translatedText = translatedText
    active.status = hasNativeTranslation ? 'translated' : 'translating'
    active.updatedAt = now
    return { segments: next.slice(-20), activeId: active.id }
  }
  const segment: RealtimeSubtitleSegment = {
    id: nextId(),
    sourceText: event.text,
    translatedText,
    status: hasNativeTranslation ? 'translated' : 'translating',
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
