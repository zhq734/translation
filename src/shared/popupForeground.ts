/**
 * 翻译弹窗前台焦点归还策略。
 *
 * Windows 上翻译结果到达时弹窗会被 win.show() 激活并成为前台窗口，
 * 此后再次按快捷键取词，WM_COPY 与注入的 Ctrl+C 都会发往弹窗而非源应用，
 * 剪贴板哨兵始终不变，最终报「取词超时」。
 * 对已在前台的窗口再次调用 showInactive 不会交还焦点，必须显式让弹窗退出前台。
 * macOS 的 LSUIElement/accessory 策略下 win.show() 不改变前台应用，无需处理。
 *
 * @author zhenghq
 */

/** 归还前台焦点后等待前台应用重新接管焦点的时间（毫秒）。 */
export const POPUP_FOREGROUND_RESTORE_SETTLE_MS = 60

/**
 * 程序化激活弹窗后，吸收源应用迟到失焦的时间窗口（毫秒）。
 *
 * 点击“译”按钮取词时，先把前台交还给源应用再激活结果弹窗；但 macOS 的
 * 前台切换是异步的，源应用真正接管 key window 往往晚于本应用激活弹窗。
 * 这段迟到的失焦会被误判为“用户点击外部”，导致结果弹窗一闪即关。
 * 实机采样显示迟到失焦约在 700ms 内到达，窗口取 1000ms 覆盖该抖动。
 */
export const POPUP_RESULT_ACTIVATION_SETTLE_MS = 1000

/**
 * 吸收迟到失焦后重新聚焦弹窗的延迟（毫秒）。
 *
 * 迟到失焦后弹窗虽可见但已失去 key window；若不重新聚焦，后续点击外部
 * 不会再产生 blur，未固定弹窗将无法自动关闭。延迟略大于一帧，确保
 * 源应用的前台切换已经收尾，重新聚焦不会再被同一批事件打断。
 */
export const POPUP_RESULT_ACTIVATION_REFOCUS_DELAY_MS = 50

/**
 * 判断取词前是否需要主动归还前台焦点给源应用。
 * 仅 Windows 且弹窗当前处于激活（前台）状态时需要归还；
 * 弹窗本就以非激活方式显示时焦点仍在源应用，无需干预。
 * @param platform 当前 Node.js 平台标识。
 * @param popupActivated 弹窗当前是否可见且处于激活状态。
 * @returns 需要归还前台焦点时返回 true。
 * @author zhenghq
 */
export function shouldRestoreForegroundBeforeCapture(
  platform: NodeJS.Platform,
  popupActivated: boolean
): boolean {
  return platform === 'win32' && popupActivated
}

/**
 * 判断取词失败提示弹窗是否应以激活方式显示。
 *
 * macOS 上失败提示若调用 win.show() 激活本应用，提示自动隐藏时本应用仍是前台应用，
 * 系统会把应用内下一个窗口（通常是设置页）提升为 key window 并顶到其它应用之上。
 * 改用 showInactive() 显示提示不会改变前台应用，收尾隐藏时走「本应用已不在最前」的安全分支。
 * Windows 上失败提示需要正常激活弹窗，且不存在上述 key window 提升问题，保持原有行为。
 * @param platform 当前 Node.js 平台标识。
 * @returns 失败提示仍需激活弹窗时返回 true。
 * @author zhenghq
 */
export function shouldActivatePopupForCaptureFailure(platform: NodeJS.Platform): boolean {
  return platform !== 'darwin'
}

/**
 * 判断 macOS 取词前是否需要让已激活的结果弹窗主动退出前台。
 *
 * 第一次取词成功后，翻译结果弹窗通过 `win.show()` 激活本应用并成为最前应用；
 * 此时再次按快捷键，注入的复制键与 AX 焦点读取都会落在弹窗上而非源应用，
 * 剪贴板哨兵始终不变，最终报「取词超时」。这与 Windows 的回归是同一根因，
 * 区别只是 macOS 需要把前台精确交还给记录的源应用（`open -b`），而不是 blur。
 * @param platform 当前 Node.js 平台标识。
 * @param popupActivated 弹窗当前是否可见且处于激活状态。
 * @returns 需要先让结果弹窗退出前台时返回 true。
 * @author zhenghq
 */
export function shouldDeactivatePopupBeforeMacCapture(
  platform: NodeJS.Platform,
  popupActivated: boolean
): boolean {
  return platform === 'darwin' && popupActivated
}
