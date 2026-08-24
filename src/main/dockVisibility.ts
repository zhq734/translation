/** macOS Dock 图标显示状态输入。 */
export interface DockVisibilityState {
  /** 用户是否开启 Dock 图标功能。 */
  showDockIcon: boolean
  /** 设置窗口是否处于打开状态。 */
  settingsOpen: boolean
  /** 网页翻译窗口是否处于打开状态。 */
  webReaderOpen: boolean
}

/**
 * 判断当前是否应该显示 macOS Dock 图标。
 * @param state Dock 图标和业务窗口状态。
 * @returns 用户开启功能且设置页或网页翻译页打开时返回 true，否则返回 false。
 * @author zhenghq
 */
export function shouldShowMacOSDockIcon(state: DockVisibilityState): boolean {
  return state.showDockIcon && (state.settingsOpen || state.webReaderOpen)
}
