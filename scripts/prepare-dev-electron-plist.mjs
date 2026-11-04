import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronAppPath = join(root, 'node_modules', 'electron', 'dist', 'Electron.app')
const infoPlistPath = join(electronAppPath, 'Contents', 'Info.plist')

/** 开发模式下 TCC 使用的权限用途说明。 */
const usageDescriptions = {
  NSScreenCaptureUsageDescription: '实时字幕需要采集系统音频，请允许屏幕录制权限。',
  NSMicrophoneUsageDescription: '实时字幕在您选择麦克风或混合音频来源时需要使用麦克风。'
}

/**
 * 执行 PlistBuddy 并返回是否成功。
 * @param args PlistBuddy 参数。
 * @returns 命令成功时返回 true。
 * @author zhenghq
 */
function runPlistBuddy(args) {
  const result = spawnSync('/usr/libexec/PlistBuddy', args, { encoding: 'utf8' })
  return result.status === 0
}

/**
 * 为开发态 Electron 补齐屏幕录制与麦克风用途说明。
 *
 * macOS TCC 会以 Electron.app 作为责任应用；缺少用途说明时，sidecar 请求
 * 屏幕录制或麦克风权限可能被系统拒绝，最终只会表现为“组件异常退出”。
 *
 * @returns 无返回值。
 * @author zhenghq
 */
function prepareDevElectronPlist() {
  if (process.platform !== 'darwin') return
  if (!existsSync(infoPlistPath)) {
    throw new Error(`未找到开发态 Electron Info.plist: ${infoPlistPath}`)
  }

  for (const [key, value] of Object.entries(usageDescriptions)) {
    const readArgs = ['-c', `Print :${key}`, infoPlistPath]
    if (runPlistBuddy(readArgs)) {
      runPlistBuddy(['-c', `Set :${key} ${value}`, infoPlistPath])
      continue
    }
    runPlistBuddy(['-c', `Add :${key} string ${value}`, infoPlistPath])
  }

  // 修改 Info.plist 会使 Electron 预置的 ad-hoc 签名失效；必须重新签名，
  // 否则 macOS 可能把授权记录绑定到不稳定的代码身份，导致已授权后仍拒绝采集。
  const signResult = spawnSync('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    electronAppPath
  ], { encoding: 'utf8' })
  if (signResult.status !== 0) {
    throw new Error(`开发态 Electron 重新签名失败: ${signResult.stderr || signResult.stdout}`)
  }
}

prepareDevElectronPlist()
