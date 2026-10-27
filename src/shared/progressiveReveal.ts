/** 渐进展示状态，完整文本与已揭示长度分离，便于复制和朗读始终使用完整译文。 */
export interface ProgressiveRevealState {
  /** 完整最终译文。 */
  fullText: string
  /** 当前已经揭示的字符数。 */
  visibleLength: number
  /** 是否为最终确定结果；缓存命中会使用更短步进。 */
  settled: boolean
}

/**
 * 创建空的渐进展示状态。
 * @returns 初始状态。
 * @author zhenghq
 */
export function createProgressiveRevealState(): ProgressiveRevealState {
  return { fullText: '', visibleLength: 0, settled: false }
}

/**
 * 追加流式片段，保留完整文本且不改变已揭示长度。
 * @param state 当前状态。
 * @param chunk 新增译文片段。
 * @returns 追加后的状态。
 * @author zhenghq
 */
export function appendProgressiveText(
  state: ProgressiveRevealState,
  chunk: string
): ProgressiveRevealState {
  return { ...state, fullText: state.fullText + chunk }
}

/**
 * 用最终完整译文校正状态，保留不超过新长度的揭示进度。
 * @param state 当前状态。
 * @param fullText 最终完整译文。
 * @param settled 是否为缓存命中或最终确定结果。
 * @returns 校正后的状态。
 * @author zhenghq
 */
export function finalizeProgressiveText(
  state: ProgressiveRevealState,
  fullText: string,
  settled = true
): ProgressiveRevealState {
  return {
    fullText,
    visibleLength: Math.min(state.visibleLength, fullText.length),
    settled
  }
}

/**
 * 按指定步长推进揭示长度，不越过完整文本。
 * @param state 当前状态。
 * @param step 本次推进的字符数。
 * @returns 推进后的状态。
 * @author zhenghq
 */
export function nextRevealLength(
  state: ProgressiveRevealState,
  step: number
): ProgressiveRevealState {
  const visibleLength = Math.min(state.fullText.length, state.visibleLength + Math.max(1, step))
  return { ...state, visibleLength }
}

/**
 * 根据文本长度与是否缓存命中计算逐字揭示间隔，长文本自动加速。
 * @param textLength 完整译文长度。
 * @param cached 是否来自缓存。
 * @returns 毫秒间隔，始终为正数。
 * @author zhenghq
 */
export function resolveRevealStepMs(textLength: number, cached: boolean): number {
  if (cached) return 8
  if (textLength <= 0) return 24
  if (textLength > 2000) return 4
  if (textLength > 600) return 8
  if (textLength > 200) return 12
  return 24
}

/**
 * 判断流式或打字机展示状态中是否已经有可保留的部分译文。
 * @param state 当前渐进展示状态。
 * @returns 存在非空完整或已揭示文本时返回 true。
 * @author zhenghq
 */
export function shouldPreservePartialReveal(state: ProgressiveRevealState): boolean {
  return state.fullText.length > 0 || state.visibleLength > 0
}

/**
 * 在请求失败但已展示部分译文时收束状态，立即完整揭示已有内容。
 * @param state 当前渐进展示状态。
 * @returns 已完整揭示并标记为最终确定的状态。
 * @author zhenghq
 */
export function settleProgressiveText(state: ProgressiveRevealState): ProgressiveRevealState {
  return {
    fullText: state.fullText,
    visibleLength: state.fullText.length,
    settled: true
  }
}
