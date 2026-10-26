/**
 * Windows 7 兼容运行时识别。
 *
 * Win7 安装包使用 Electron 22 构建，并通过 `WIN7_BUILD=1` 固定运行时行为；
 * 开发环境或其它打包方式则根据 Windows 内核版本 6.1 自动识别。
 *
 * @author zhenghq
 */
import { release } from 'node:os'

/**
 * 判断给定平台与系统版本是否属于 Windows 7。
 * @param platform Node.js 平台标识。
 * @param release 操作系统版本字符串。
 * @returns 仅在 win32 且主次版本均为 6.1 时返回 true。
 * @author zhenghq
 */
export function isWindows7Version(
  platform: NodeJS.Platform,
  release: string
): boolean {
  if (platform !== 'win32') return false
  const match = /^(\d+)\.(\d+)/u.exec(String(release ?? '').trim())
  return match?.[1] === '6' && match[2] === '1'
}

/**
 * 判断当前进程是否应启用 Windows 7 兼容运行时。
 * @param env 环境变量来源，默认使用 process.env。
 * @param platform 当前平台，默认使用 process.platform。
 * @param release 当前系统版本，默认使用 os.release()。
 * @returns Win7 构建标记或真实 Win7 系统均返回 true。
 * @author zhenghq
 */
export function isWindows7CompatibilityRuntime(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  release: string = readWindowsRelease()
): boolean {
  if (env['WIN7_BUILD'] === '1') return true
  return isWindows7Version(platform, release)
}

/**
 * 读取当前 Windows 内核版本。
 * @returns 版本字符串；读取失败时返回空字符串。
 * @author zhenghq
 */
function readWindowsRelease(): string {
  return release()
}
