/**
 * macOS 让窗口在所有工作区可见时使用的统一选项。
 *
 * Electron 的 `setVisibleOnAllWorkspaces` 默认会在 `UIElementApplication` 与
 * `ForegroundApplication` 之间转换进程类型，而这次转换每次调用都会短暂隐藏窗口和 Dock 图标。
 * 本应用会在设置窗口打开期间显示 Dock 图标，因此只要「译」按钮、翻译弹窗、OCR 覆盖窗口或
 * 截图提示窗口在设置窗口打开后被创建，设置窗口与 Dock 图标就会被一起隐藏，用户表现为
 * 「打开应用后设置页和 Dock 图标自动关闭」。应用已自行管理 macOS 激活策略
 * （见 `dockVisibility.ts`），窗口层级由各自的 `setAlwaysOnTop` 保证，故统一跳过该转换。
 *
 * 新增任何调用 `setVisibleOnAllWorkspaces` 的窗口都必须复用本选项。
 *
 * @author zhenghq
 */
export const ALL_WORKSPACES_VISIBILITY_OPTIONS = {
  /** 允许窗口显示在其它应用的全屏窗口之上。 */
  visibleOnFullScreen: true,
  /** 跳过会隐藏窗口与 Dock 图标的进程类型转换。 */
  skipTransformProcessType: true
} as const
