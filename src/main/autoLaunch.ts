import { join } from 'node:path'

/** 开机自启动的落地方式。 */
export type AutoLaunchStrategy = 'login-item' | 'desktop-entry' | 'skipped' | 'unsupported'

/** 判断开机自启动落地方式所需的运行环境。 */
export interface AutoLaunchEnvironment {
  /** 当前 Node.js 平台标识。 */
  platform: NodeJS.Platform | string
  /** 应用是否已打包，开发模式下不写入系统登录项。 */
  packaged: boolean
}

/** 构造系统登录项参数所需的输入。 */
export interface LoginItemSettingsInput {
  /** 当前 Node.js 平台标识。 */
  platform: NodeJS.Platform | string
  /** 是否开启开机自启动。 */
  enabled: boolean
  /** 当前应用可执行文件路径。 */
  execPath: string
}

/** 系统登录项参数，字段与 Electron `app.setLoginItemSettings` 对齐。 */
export interface LoginItemSettingsPayload {
  /** 是否随系统登录启动。 */
  openAtLogin: boolean
  /** Windows 下显式指定的启动可执行文件路径。 */
  path?: string
  /** Windows 下启动时附加的命令行参数。 */
  args?: string[]
}

/** 构造 Linux 桌面自启动入口所需的输入。 */
export interface LinuxAutostartEntryInput {
  /** 应用显示名称。 */
  appName: string
  /** 当前应用可执行文件路径。 */
  execPath: string
}

/**
 * 判断当前运行环境应使用的开机自启动落地方式。
 * @param environment 当前平台与打包状态。
 * @returns macOS/Windows 返回系统登录项，Linux 返回桌面入口，开发模式返回跳过，其他平台返回不支持。
 * @author zhenghq
 */
export function resolveAutoLaunchStrategy(environment: AutoLaunchEnvironment): AutoLaunchStrategy {
  if (!environment.packaged) return 'skipped'
  if (environment.platform === 'darwin' || environment.platform === 'win32') return 'login-item'
  if (environment.platform === 'linux') return 'desktop-entry'
  return 'unsupported'
}

/**
 * 构造传给系统登录项接口的参数。
 * @param input 平台、开关状态与可执行文件路径。
 * @returns 登录项参数；Windows 显式携带可执行文件路径以兼容安装目录变化。
 * @author zhenghq
 */
export function buildLoginItemSettings(input: LoginItemSettingsInput): LoginItemSettingsPayload {
  if (input.platform === 'win32') {
    return { openAtLogin: input.enabled, path: input.execPath, args: [] }
  }
  return { openAtLogin: input.enabled }
}

/**
 * 计算 Linux XDG 自启动桌面入口文件路径。
 * @param homeDirectory 当前用户的主目录。
 * @param applicationId 应用唯一标识，用作桌面入口文件名。
 * @returns 自启动桌面入口文件的完整路径。
 * @author zhenghq
 */
export function resolveLinuxAutostartEntryPath(
  homeDirectory: string,
  applicationId: string
): string {
  return join(homeDirectory, '.config', 'autostart', `${applicationId}.desktop`)
}

/**
 * 生成 Linux 自启动桌面入口文件内容。
 * @param input 应用名称与可执行文件路径。
 * @returns 符合 Desktop Entry 规范的文件内容，Exec 路径加引号以兼容空格。
 * @author zhenghq
 */
export function buildLinuxAutostartEntry(input: LinuxAutostartEntryInput): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${input.appName}`,
    `Exec="${input.execPath}"`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n')
}
