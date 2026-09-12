/** macOS Dock 图标显示状态输入。 */
export interface DockVisibilityState {
  /** 用户是否开启 Dock 图标功能；该设置唯一决定呈现方式。 */
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
 * 根据用户设置解析 macOS 激活策略与 Dock 图标的配对呈现方式。
 * macOS 的 regular 策略与 dock.hide() 互斥，因此只允许 regular/可见和 accessory/隐藏两种组合。
 * 设置窗口和网页阅读器状态仅为兼容既有调用保留，不得覆盖用户设置。
 * @param state Dock 图标设置和常规窗口状态。
 * @returns 与用户设置匹配的激活策略和 Dock 可见性组合。
 * @author zhenghq
 */
export function resolveMacOSDockPresentation(
  state: DockVisibilityState
): MacOSDockPresentation {
  return state.showDockIcon
    ? { policy: 'regular', dockVisible: true }
    : { policy: 'accessory', dockVisible: false }
}
