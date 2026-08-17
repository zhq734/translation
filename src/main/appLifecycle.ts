/**
 * 判断应用是否从 macOS 挂载卷中的磁盘镜像路径运行。
 * @param platform 当前 Node.js 平台标识。
 * @param executablePath 当前应用可执行文件的完整路径。
 * @returns 仅当平台为 macOS 且路径位于 `/Volumes/` 下时返回 true。
 * @author zhenghq
 */
export function isMacOSDiskImageExecution(
  platform: NodeJS.Platform,
  executablePath: string
): boolean {
  if (platform !== 'darwin') return false
  return executablePath.replace(/\/{2,}/gu, '/').startsWith('/Volumes/')
}

/**
 * 判断应用首次启动时是否应主动打开设置窗口。
 * @param platform 当前 Node.js 平台标识。
 * @returns Windows 和 Linux 返回 true，macOS 返回 false。
 * @author zhenghq
 */
export function shouldOpenSettingsOnInitialLaunch(platform: NodeJS.Platform): boolean {
  return platform !== 'darwin'
}
