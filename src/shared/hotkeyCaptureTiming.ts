const WINDOWS_HOTKEY_RELEASE_DELAY_MS = 120

/**
 * 解析全局快捷键触发后开始取词前的等待时间。
 * Windows 的全局快捷键回调在按键按下阶段触发，需要等待 Alt、Ctrl、Shift 或 Win 键释放，
 * 避免后续模拟 Ctrl+C 时被组合成 Ctrl+Alt+C 等错误快捷键。
 * @param platform 当前 Node.js 平台标识。
 * @returns Windows 返回修饰键释放等待时间，其他平台返回 0。
 * @author zhenghq
 */
export function resolveHotkeyCaptureDelay(platform: NodeJS.Platform): number {
  return platform === 'win32' ? WINDOWS_HOTKEY_RELEASE_DELAY_MS : 0
}
