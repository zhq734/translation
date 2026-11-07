/** 设置页显式置前门禁所需的状态快照。 */
export interface SettingsBringToFrontGateState {
  /** 设置页是否因外部划词被暂时隐藏。 */
  settingsWindowHiddenForSelection: boolean
  /** 是否来自翻译弹窗内的真实点击。 */
  explicitPopupSource: boolean
  /** 是否来自应用启动后的首次设置页打开。 */
  initialLaunchSource: boolean
  /** 当前是否处于划词置前保护期。 */
  selectionGuardActive: boolean
  /** 当前划词交互是否已经完全空闲。 */
  selectionInteractionIdle: boolean
  /** macOS 是否已通过事件确认应用处于激活状态。 */
  appActive: boolean
  /** 本次置前开始时的设置页置前代际。 */
  bringToFrontEpoch: number
  /** 当前最新的设置页置前代际。 */
  currentBringToFrontEpoch: number
  /** 本次请求携带的 Dock 激活代际；非 Dock 来源时缺省。 */
  dockActivationEpoch?: number
  /** 当前最新的 Dock 激活代际；应用失活或新的 Dock 激活都会递增。 */
  currentDockActivationEpoch: number
}

/**
 * 判断一次设置页显式置前是否仍可安全执行。
 *
 * macOS 可能先派发 activate、后派发 did-become-active。Dock 点击已经通过
 * activate 来源判定时，不能仅因激活事件短暂延迟就丢弃第一次请求；但应用真正
 * 失活或用户开始新的划词时，请求代际会变化，旧任务仍必须失效。
 * @param state 置前门禁状态快照。
 * @returns 仍可安全显示、聚焦或移动设置页时返回 true。
 * @author zhenghq
 */
export function shouldCompleteSettingsBringToFront(
  state: SettingsBringToFrontGateState
): boolean {
  if (state.settingsWindowHiddenForSelection) return false
  if (state.explicitPopupSource) return true
  // 启动首开只豁免启动阶段的应用激活事件噪声，不能越过划词保护期或进行中交互。
  if (state.initialLaunchSource) {
    return !state.selectionGuardActive && state.selectionInteractionIdle
  }
  // Dock 点击已经由 activate 判定证明是用户操作。did-become-active 可能晚于
  // activate 到达，因此只要本次 Dock 请求仍是最新代际，就允许先完成置前；
  // 若应用真正失活或发生新的 Dock 激活，did-resign-active/新请求会推进代际，
  // 旧请求随后会被拒绝。
  if (state.dockActivationEpoch !== undefined &&
    state.dockActivationEpoch !== state.currentDockActivationEpoch) {
    return false
  }
  const dockActivationIsCurrent = state.dockActivationEpoch !== undefined
  if (!state.appActive && !dockActivationIsCurrent) return false
  return state.bringToFrontEpoch === state.currentBringToFrontEpoch &&
    !state.selectionGuardActive &&
    state.selectionInteractionIdle
}
