import type {
  PronunciationDefinition,
  PronunciationResult,
  PronunciationVariant
} from '../../shared/types'

/** 音标卡当前所在的原文或译文区域。 */
export type PronunciationCardContext = 'source' | 'translation'

/** 音标卡的完整界面状态。 */
export interface PronunciationCardState {
  /** 卡片当前展示状态。 */
  status: 'hidden' | 'loading' | 'available' | 'unavailable' | 'unsupported'
  /** 当前查询词。 */
  word: string
  /** 当前查询序号，用于丢弃迟到结果。 */
  requestId: number
  /** 当前可展示的音标变体。 */
  variants: PronunciationVariant[]
  /** 当前音标卡所属的原文或译文区域。 */
  context: PronunciationCardContext
  /** 当前单词可展示的释义列表。 */
  definitions: PronunciationDefinition[]
  /** 最近一次查询失败原因，不包含底层异常。 */
  error?: string
}

/**
 * 创建初始隐藏的音标卡状态。
 * @returns 隐藏且无查询结果的卡片状态。
 * @author zhenghq
 */
export function createPronunciationCardState(): PronunciationCardState {
  return { status: 'hidden', word: '', requestId: 0, variants: [], context: 'source', definitions: [] }
}

/**
 * 开始一次新的单词音标查询。
 * @param state 当前卡片状态。
 * @param word 新的查询词。
 * @param requestId 新的查询序号。
 * @param context 当前音标卡所在的原文或译文区域。
 * @returns 加载态卡片状态。
 * @author zhenghq
 */
export function beginPronunciationLookup(
  state: PronunciationCardState,
  word: string,
  requestId: number,
  context: PronunciationCardContext = 'source'
): PronunciationCardState {
  return {
    status: 'loading',
    word,
    requestId: Math.max(state.requestId + 1, requestId),
    variants: [],
    context,
    definitions: []
  }
}

/**
 * 接收查询结果；迟到结果不得覆盖当前查询。
 * @param state 当前卡片状态。
 * @param requestId 结果对应的查询序号。
 * @param result 主进程返回的音标结果。
 * @returns 更新后的卡片状态。
 * @author zhenghq
 */
export function settlePronunciationLookup(
  state: PronunciationCardState,
  requestId: number,
  result: PronunciationResult
): PronunciationCardState {
  if (state.status === 'hidden' || requestId !== state.requestId) return state
  return {
    status: result.status === 'available' ? 'available' : result.status,
    word: result.word || state.word,
    requestId: state.requestId,
    variants: result.status === 'available' ? result.variants : [],
    context: state.context,
    definitions: result.status === 'available' ? result.definitions ?? [] : []
  }
}

/**
 * 关闭音标卡并清理当前查询状态。
 * @param _state 当前卡片状态。
 * @returns 初始隐藏状态。
 * @author zhenghq
 */
export function closePronunciationCard(_state: PronunciationCardState): PronunciationCardState {
  return createPronunciationCardState()
}
