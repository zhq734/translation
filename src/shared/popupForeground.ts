/**
 * 翻译弹窗前台焦点归还策略。
 *
 * Windows 上翻译结果到达时弹窗会被 win.show() 激活并成为前台窗口，
 * 此后再次按快捷键取词，WM_COPY 与注入的 Ctrl+C 都会发往弹窗而非源应用，
 * 剪贴板哨兵始终不变，最终报「取词超时」。
 * 对已在前台的窗口再次调用 showInactive 不会交还焦点，必须显式让弹窗退出前台。
 *
 * macOS 上翻译弹窗是 nonactivating panel：show()/focus() 只让弹窗自身成为
 * key window，不激活整个应用。但弹窗持有 key window 时，注入的 Command+C 仍会
 * 落在弹窗而不是源应用，剪贴板哨兵不变，最终报「取词超时」。因此取词前必须
 * 让自有 panel 退出 key 状态，把 key window 交还给源应用。
 *
 * @author zhenghq
 */

/** 归还前台焦点后等待前台应用重新接管焦点的时间（毫秒）。 */
export const POPUP_FOREGROUND_RESTORE_SETTLE_MS = 60

/**
 * 判断取词前是否需要主动归还前台焦点 / key window 给源应用。
 * Windows 与 macOS 在弹窗确实持有前台焦点时都需要归还：Windows 归还的是
 * 前台窗口，macOS 归还的是 key window。调用方必须传入真实焦点状态，
 * 不能传入“曾以非激活方式显示”之类的记账标志。
 * @param platform 当前 Node.js 平台标识。
 * @param popupActivated 弹窗当前是否可见且确实持有前台焦点 / key window。
 * @returns 需要归还前台焦点时返回 true。
 * @author zhenghq
 */
export function shouldRestoreForegroundBeforeCapture(
  platform: NodeJS.Platform,
  popupActivated: boolean
): boolean {
  if (platform === 'win32') return popupActivated
  // macOS：nonactivating panel 仍可能持有 key window，取词前必须显式让出，
  // 否则注入的 Command+C 会打在弹窗上。
  if (platform === 'darwin') return popupActivated
  return false
}

/**
 * 判断取词失败提示弹窗是否应以激活方式显示。
 *
 * macOS 上翻译弹窗是 nonactivating panel，showInactive() 会让窗口保持可见
 * 但无法取得键盘焦点；失败提示无需输入，仍应以非激活方式显示，避免改变
 * 用户当前前台应用。
 * Windows 上失败提示需要正常激活弹窗，且不存在上述 key window 提升问题，保持原有行为。
 * @param platform 当前 Node.js 平台标识。
 * @returns 失败提示仍需激活弹窗时返回 true。
 * @author zhenghq
 */
export function shouldActivatePopupForCaptureFailure(platform: NodeJS.Platform): boolean {
  return platform !== 'darwin'
}
