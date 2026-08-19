import { MANUAL_TRANSLATION_MAX_CHARS } from './types'

/** 手动翻译会话状态。 */
export interface ManualTranslationState {
  /** 当前输入框草稿。 */
  draft: string
  /** 最近一次明确提交的原文。 */
  submittedText: string
  /** 最近一次成功译文。 */
  translation: string
  /** 是否正在请求。 */
  loading: boolean
  /** 最近一次错误提示。 */
  error: string
  /** 当前译文是否因输入或设置变化而过期。 */
  stale: boolean
  /** 最近一次请求序号。 */
  requestId: number
}

/**
 * 创建空的手动翻译会话状态。
 * @returns 新的会话内状态。
 * @author zhenghq
 */
export function createManualTranslationState(): ManualTranslationState {
  return {
    draft: '',
    submittedText: '',
    translation: '',
    loading: false,
    error: '',
    stale: false,
    requestId: 0
  }
}

/**
 * 校验手动翻译原文并返回可展示的错误信息。
 * @param value 待校验的未知输入。
 * @returns 校验失败提示，合法时返回 null。
 * @author zhenghq
 */
export function validateManualTranslationText(value: unknown): string | null {
  if (typeof value !== 'string') return '原文格式无效'
  if (!value.trim()) return '请输入要翻译的原文'
  if (value.length > MANUAL_TRANSLATION_MAX_CHARS) {
    return `原文不能超过${MANUAL_TRANSLATION_MAX_CHARS}个字符`
  }
  return null
}

/**
 * 判断手动翻译是否可以提交。
 * @param state 当前手动翻译状态。
 * @returns 是否允许提交。
 * @author zhenghq
 */
export function canSubmitManualTranslation(state: ManualTranslationState): boolean {
  return !state.loading && validateManualTranslationText(state.draft) === null
}

/**
 * 处理用户编辑原文，保留旧译文但标记其已经过期。
 * @param state 当前手动翻译状态。
 * @param draft 新的输入草稿。
 * @returns 更新后的会话状态。
 * @author zhenghq
 */
export function updateManualDraft(
  state: ManualTranslationState,
  draft: string
): ManualTranslationState {
  return {
    ...state,
    draft,
    stale: state.translation.length > 0 && draft !== state.submittedText,
    error: ''
  }
}

/**
 * 清空手动翻译原文和译文状态。
 * @param state 当前状态，仅用于保持状态转换调用形式一致。
 * @returns 新的空状态。
 * @author zhenghq
 */
export function clearManualTranslation(state: ManualTranslationState): ManualTranslationState {
  void state
  return createManualTranslationState()
}

/**
 * 开始一次手动翻译请求，并递增请求序号。
 * @param state 当前手动翻译状态。
 * @returns 进入加载态后的状态。
 * @author zhenghq
 */
export function beginManualTranslation(state: ManualTranslationState): ManualTranslationState {
  return {
    ...state,
    submittedText: state.draft,
    loading: true,
    error: '',
    stale: false,
    requestId: state.requestId + 1
  }
}

/**
 * 接受仍然有效的手动翻译成功结果。
 * @param state 当前手动翻译状态。
 * @param requestId 返回结果所属请求序号。
 * @param translation 成功译文。
 * @returns 接受结果或保持不变后的状态。
 * @author zhenghq
 */
export function completeManualTranslation(
  state: ManualTranslationState,
  requestId: number,
  translation: string
): ManualTranslationState {
  if (requestId !== state.requestId) return state
  return { ...state, translation, loading: false, error: '', stale: false }
}

/**
 * 接受仍然有效的手动翻译失败结果。
 * @param state 当前手动翻译状态。
 * @param requestId 返回结果所属请求序号。
 * @param error 脱敏错误提示。
 * @returns 接受错误或保持不变后的状态。
 * @author zhenghq
 */
export function failManualTranslation(
  state: ManualTranslationState,
  requestId: number,
  error: string
): ManualTranslationState {
  if (requestId !== state.requestId) return state
  return { ...state, loading: false, error, stale: false }
}
