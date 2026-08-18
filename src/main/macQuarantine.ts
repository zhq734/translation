import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { MacOSQuarantineResult } from '../shared/types'

/** 应用安装到“应用程序”目录后所使用的固定路径。 */
export const MACOS_APPLICATION_PATH = '/Applications/划词翻译.app'

/** macOS xattr 命令的绝对路径，避免通过 shell 解析用户输入。 */
const XATTR_COMMAND = '/usr/bin/xattr'
const execFileAsync = promisify(execFile)

/** 可注入的 xattr 命令执行器，供单元测试替换真实系统调用。 */
export type MacOSQuarantineCommandRunner = (
  command: string,
  args: string[]
) => Promise<void>

/** 解除 macOS 应用隔离属性所需的可替换参数。 */
export interface MacOSQuarantineOptions {
  /** 当前 Node.js 平台。 */
  platform?: NodeJS.Platform
  /** 待处理的应用路径；生产调用必须使用固定应用路径。 */
  applicationPath?: string
  /** 执行 xattr 的命令函数。 */
  runCommand?: MacOSQuarantineCommandRunner
}

/**
 * 使用系统 xattr 命令执行解除隔离属性操作。
 * @param command 要执行的命令绝对路径。
 * @param args 命令参数列表。
 * @returns 命令执行完成后的 Promise。
 * @author zhenghq
 */
async function runXattrCommand(command: string, args: string[]): Promise<void> {
  await execFileAsync(command, args)
}

/**
 * 将异常转换为长度受限的用户可读错误文本。
 * @param error 命令执行异常。
 * @returns 清理后的错误文本。
 * @author zhenghq
 */
function formatCommandError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/gu, ' ').trim().slice(0, 240) || '未知错误'
}

/**
 * 仅在用户指定固定的“应用程序/划词翻译.app”路径时允许执行命令。
 * @param platform 当前 Node.js 平台。
 * @param applicationPath 待处理的应用路径。
 * @returns 平台和路径均符合安全限制时返回 true。
 * @author zhenghq
 */
function isAllowedMacOSApplicationPath(
  platform: NodeJS.Platform,
  applicationPath: string
): boolean {
  return platform === 'darwin' && applicationPath === MACOS_APPLICATION_PATH
}

/**
 * 在用户确认后解除固定 macOS 应用的 quarantine 属性。
 * @param options 平台、应用路径和命令执行器覆盖项。
 * @returns 结构化的执行结果和用户提示。
 * @author zhenghq
 */
export async function removeMacOSApplicationQuarantine(
  options: MacOSQuarantineOptions = {}
): Promise<MacOSQuarantineResult> {
  const platform = options.platform ?? process.platform
  const applicationPath = options.applicationPath ?? MACOS_APPLICATION_PATH
  const runCommand = options.runCommand ?? runXattrCommand
  const manualCommand = `xattr -dr com.apple.quarantine "${MACOS_APPLICATION_PATH}"`

  if (platform !== 'darwin') {
    return { ok: false, message: '仅 macOS 支持解除应用隔离属性' }
  }
  if (!isAllowedMacOSApplicationPath(platform, applicationPath)) {
    return {
      ok: false,
      message: `为避免误操作，只允许处理 ${MACOS_APPLICATION_PATH}`
    }
  }

  try {
    await runCommand(XATTR_COMMAND, ['-dr', 'com.apple.quarantine', applicationPath])
    return { ok: true, message: '已解除 /Applications/划词翻译.app 的 macOS 隔离属性' }
  } catch (error) {
    const errorMessage = formatCommandError(error)
    if (/No such xattr/iu.test(errorMessage)) {
      return { ok: true, message: '应用本来就没有隔离属性（com.apple.quarantine）' }
    }
    return {
      ok: false,
      message: `解除应用隔离属性失败：${errorMessage}。可手动执行：${manualCommand}`
    }
  }
}
