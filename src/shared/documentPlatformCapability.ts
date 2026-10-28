/**
 * 文档翻译平台能力探测。
 *
 * 文档链路依赖现代 PDF.js 与原生 Canvas，Windows 7 兼容构建无法安全加载这些依赖。
 * 该模块只包含纯函数，主进程与 Renderer 必须使用同一判定结果，避免入口可见但功能不可用。
 *
 * @author zhenghq
 */

/** 文档翻译不可用原因。 */
export type DocumentPlatformUnsupportedReason =
  | 'windows-7-unsupported'
  | 'unsupported-platform'
  | 'unsupported-architecture'

/** 文档翻译平台能力结果。 */
export interface DocumentPlatformCapability {
  /** 当前平台是否允许启用文档翻译。 */
  supported: boolean
  /** 不支持时的稳定原因码；支持时为 null。 */
  reason: DocumentPlatformUnsupportedReason | null
}

/** 平台能力探测输入。 */
export interface DocumentPlatformInput {
  /** Node.js 平台标识。 */
  platform: NodeJS.Platform
  /** 操作系统版本字符串。 */
  release: string
  /** CPU 架构。 */
  arch: NodeJS.Architecture
  /** 构建期环境变量。 */
  env: Record<string, string | undefined>
}

/** 支持文档翻译的 Node.js 平台。 */
const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(['darwin', 'win32', 'linux'])

/** 支持文档翻译的 CPU 架构。 */
const SUPPORTED_ARCHITECTURES = new Set<NodeJS.Architecture>(['x64', 'arm64'])

/**
 * 判断给定平台与系统版本是否为 Windows 7。
 * @param platform Node.js 平台标识。
 * @param release 操作系统版本字符串。
 * @returns 仅在 win32 且主次版本均为 6.1 时返回 true。
 * @author zhenghq
 */
function isWindows7Version(platform: NodeJS.Platform, release: string): boolean {
  if (platform !== 'win32') return false
  const match = /^(\d+)\.(\d+)/u.exec(String(release ?? '').trim())
  return match?.[1] === '6' && match[2] === '1'
}

/**
 * 根据平台、系统版本、架构和构建标记判断文档翻译能力。
 * @param input 平台能力探测输入。
 * @returns 是否支持以及不支持时的稳定原因码。
 * @author zhenghq
 */
export function detectDocumentPlatformCapability(
  input: DocumentPlatformInput
): DocumentPlatformCapability {
  if (input.env['WIN7_BUILD'] === '1' || isWindows7Version(input.platform, input.release)) {
    return { supported: false, reason: 'windows-7-unsupported' }
  }
  if (!SUPPORTED_PLATFORMS.has(input.platform)) {
    return { supported: false, reason: 'unsupported-platform' }
  }
  if (!SUPPORTED_ARCHITECTURES.has(input.arch)) {
    return { supported: false, reason: 'unsupported-architecture' }
  }
  return { supported: true, reason: null }
}

/**
 * 读取当前运行时的文档翻译能力。
 * @param input 可注入的平台信息；省略时读取当前 Node.js 运行时。
 * @returns 当前平台是否支持文档翻译。
 * @author zhenghq
 */
export function getDocumentPlatformCapability(
  input: DocumentPlatformInput = {
    platform: process.platform,
    release: process.getSystemVersion(),
    arch: process.arch,
    env: process.env
  }
): DocumentPlatformCapability {
  return detectDocumentPlatformCapability(input)
}

