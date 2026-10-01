/** macOS Dock 图标显示状态输入。 */
export interface DockVisibilityState {
  /** 用户是否开启常规窗口存在期间显示 Dock 图标的功能。 */
  showDockIcon: boolean
  /** 设置窗口是否处于打开状态。 */
  settingsOpen: boolean
  /** 网页翻译窗口是否处于打开状态。 */
  webReaderOpen: boolean
}

/** macOS 应用激活策略与 Dock 图标可见性的自洽组合。 */
export type MacOSDockPresentation =
  | { policy: 'regular'; dockVisible: true }
  | { policy: 'accessory'; dockVisible: false }

/**
 * 根据用户设置和常规窗口状态解析 macOS 激活策略与 Dock 图标的配对呈现方式。
 * macOS 的 regular 策略与 dock.hide() 互斥，因此只允许 regular/可见和 accessory/隐藏两种组合。
 * 用户开启功能且设置窗口或网页翻译窗口仍存在时必须保持 regular。
 * 关闭设置窗口时若翻译窗口仍打开，切换为 accessory 会重新排列应用内窗口层级，
 * 把仍在使用的翻译窗口压到其它应用之后，因此必须等所有常规窗口关闭后再隐藏 Dock。
 * @param state Dock 图标设置和常规窗口状态。
 * @returns 与用户设置及常规窗口状态匹配的激活策略和 Dock 可见性组合。
 * @author zhenghq
 */
export function resolveMacOSDockPresentation(
  state: DockVisibilityState
): MacOSDockPresentation {
  return state.showDockIcon && (state.settingsOpen || state.webReaderOpen)
    ? { policy: 'regular', dockVisible: true }
    : { policy: 'accessory', dockVisible: false }
}
