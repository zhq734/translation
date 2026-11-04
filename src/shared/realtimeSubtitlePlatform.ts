/**
 * 实时字幕平台能力判断。
 *
 * 系统音频采集依赖 macOS 14.2+ 的 ScreenCaptureKit 音频能力，因此平台判断必须
 * 独立于 sidecar 是否已经构建，避免旧系统误启动子进程并触发无效权限请求。
 *
 * @author zhenghq
 */

/** 实时字幕平台能力。 */
export interface RealtimeSubtitlePlatformCapability {
  /** 当前平台是否支持实时字幕。 */
  supported: boolean
  /** 不支持时的稳定原因。 */
  reason: 'unsupported-platform' | 'macos-version-unsupported' | null
}

/** 平台能力探测输入。 */
export interface RealtimeSubtitlePlatformInput {
  /** Node.js 平台标识。 */
  platform: NodeJS.Platform
  /** 操作系统版本字符串。 */
  release: string
}

/** 读取系统版本的 Electron 运行时扩展。 */
interface ProcessWithSystemVersion {
  /** Electron 注入的系统版本读取方法。 */
  getSystemVersion?: () => string
}

/**
 * 解析 macOS 主版本号与次版本号。
 * @param release 系统版本字符串。
 * @returns 版本号元组；无法解析时返回 null。
 * @author zhenghq
 */
function parseMacOSVersion(release: string): readonly [number, number] | null {
  const match = /^(\d+)(?:\.(\d+))?/u.exec(String(release ?? '').trim())
  if (!match?.[1]) return null
  return [Number(match[1]), Number(match[2] ?? 0)]
}

/**
 * 判断当前平台是否支持实时字幕。
 * @param input 平台与系统版本。
 * @returns 平台能力和稳定原因。
 * @author zhenghq
 */
export function detectRealtimeSubtitlePlatformCapability(
  input: RealtimeSubtitlePlatformInput
): RealtimeSubtitlePlatformCapability {
  if (input.platform !== 'darwin') {
    return { supported: false, reason: 'unsupported-platform' }
  }
  const version = parseMacOSVersion(input.release)
  if (version === null || version[0] < 14 || (version[0] === 14 && version[1] < 2)) {
    return { supported: false, reason: 'macos-version-unsupported' }
  }
  return { supported: true, reason: null }
}

/**
 * 读取当前运行时的实时字幕能力。
 * @param input 可注入的平台信息。
 * @returns 当前平台能力。
 * @author zhenghq
 */
export function getRealtimeSubtitlePlatformCapability(
  input: RealtimeSubtitlePlatformInput = {
    platform: process.platform,
    release: (process as NodeJS.Process & ProcessWithSystemVersion).getSystemVersion?.() ??
      process.release.name
  }
): RealtimeSubtitlePlatformCapability {
  return detectRealtimeSubtitlePlatformCapability(input)
}
