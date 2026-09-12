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
