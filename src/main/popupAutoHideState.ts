/**
 * 判断当前弹窗是否应安排自动隐藏。
 *
 * 音标交互只暂停隐藏计时，不修改弹窗的固定状态；因此这里把固定、计时配置和
 * 音标交互作为三个独立条件判断，避免调用方误把音标交互当成固定弹窗。
 * @param state 当前固定状态、自动隐藏毫秒数和音标交互状态。
 * @returns 需要安排自动隐藏时返回 true。
 * @author zhenghq
 */
export function shouldSchedulePopupHide(state: {
  /** 用户是否固定了翻译弹窗。 */
  pinned: boolean
  /** 当前自动隐藏毫秒数，0 表示不自动隐藏。 */
  autoHideMs: number
  /** 音标卡或原文发音交互是否处于激活状态。 */
  pronunciationInteractionActive: boolean
}): boolean {
  return !state.pinned && state.autoHideMs > 0 && !state.pronunciationInteractionActive
}

/** 音标交互状态迁移结果。 */
export type PronunciationInteractionTransition = 'unchanged' | 'pause' | 'resume'

/**
 * 比较音标交互状态，避免重复 IPC 上报重置已经开始的自动隐藏计时。
 * @param nextActive 本次上报的交互状态。
 * @param currentActive 主进程当前记录的交互状态。
 * @returns 无变化、暂停计时或恢复计时。
 * @author zhenghq
 */
export function resolvePronunciationInteractionTransition(
  nextActive: boolean,
  currentActive: boolean
): PronunciationInteractionTransition {
  if (nextActive === currentActive) return 'unchanged'
  // 第二个参数是主进程当前状态：由激活转为未激活时应恢复计时，反之则暂停。
  return currentActive ? 'resume' : 'pause'
}
