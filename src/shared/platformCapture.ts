export type SelectionCaptureStrategy =
  | 'macos-command-copy'
  | 'windows-control-copy'
  | 'linux-primary-selection'
  | 'unsupported'

/**
 * 根据操作系统选择全局取词实现，避免在非 macOS 平台调用 macOS 专属脚本。
 * @param platform Node.js 提供的操作系统平台标识。
 * @returns 当前平台对应的取词策略。
 * @author zhenghq
 */
export function resolveSelectionCaptureStrategy(
  platform: NodeJS.Platform
): SelectionCaptureStrategy {
  if (platform === 'darwin') return 'macos-command-copy'
  if (platform === 'win32') return 'windows-control-copy'
  if (platform === 'linux') return 'linux-primary-selection'
  return 'unsupported'
}
