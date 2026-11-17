import {
  normalizeScreenshotWindowCandidates,
  type ScreenshotWindowCandidate,
  type ScreenshotWindowRect
} from '../shared/screenshotWindowSelection'
import { enumerateMacosScreenshotWindows } from './macosScreenshotWindows'
import type { WindowsScreenshotOptions } from './windowsScreenshotWindows'
import { enumerateWindowsScreenshotWindowsInWorker } from './screenshotWindowWorkerClient'
import { join } from 'node:path'
import type { Screen } from 'electron'

/** 把 Electron 原生句柄转换为不截断的窗口编号；参数为句柄缓冲区，返回编号数组。@author zhenghq */
export function screenshotWindowHandleIds(handle: Buffer): string[] {
  return [handle.length >= 8 ? handle.readBigUInt64LE().toString() : handle.readUInt32LE().toString()]
}

/** 组装可克隆的目标屏物理边界；参数为 Electron screen、起始显示器和覆盖窗口句柄，返回线程枚举选项。@author zhenghq */
export function screenshotWindowsOptions(screen: Screen, display: { bounds: ScreenshotWindowRect; scaleFactor: number }, handle: Buffer): WindowsScreenshotOptions | undefined {
  if (process.platform !== 'win32') return undefined
  const physical = screen.dipToScreenRect(null, display.bounds)
  return { displays: screen.getAllDisplays(), targetDisplay: { ...display, physicalBounds: physical },
    excludedWindowIds: screenshotWindowHandleIds(handle) }
}

/** 候选协调依赖：平台枚举返回全局 DIP，未提供的适配器自动降级。 */
interface ScreenshotWindowCollectionOptions {
  platform: NodeJS.Platform
  bounds: ScreenshotWindowRect
  timeoutMs?: number
  enumerateMacos?: () => Promise<ScreenshotWindowCandidate[]>
  enumerateWindows?: () => Promise<ScreenshotWindowCandidate[]>
  windowsOptions?: WindowsScreenshotOptions
}

/**
 * 并发截图链路中的有界候选采集，异常/超时不影响原快照。
 * @param options 起始显示器、平台和原生枚举依赖。
 * @returns 本屏局部 DIP 候选数组，失败或不支持时为空。
 * @author zhenghq
 */
export async function collectScreenshotWindowCandidates(options: ScreenshotWindowCollectionOptions): Promise<ScreenshotWindowCandidate[]> {
  const enumerate = options.platform === 'darwin' ? options.enumerateMacos ?? (() => enumerateMacosScreenshotWindows())
    : options.platform === 'win32' ? options.enumerateWindows ?? (() => options.windowsOptions
      ? enumerateWindowsScreenshotWindowsInWorker(join(__dirname, 'screenshotWindowWorker.cjs'), options.windowsOptions) : Promise.resolve([])) : undefined
  if (!enumerate) return []
  const budget = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0
    ? Math.min(options.timeoutMs!, 500) : 250
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      Promise.resolve().then(enumerate),
      new Promise<ScreenshotWindowCandidate[]>((resolve) => { timer = setTimeout(() => resolve([]), budget) })
    ])
    return normalizeScreenshotWindowCandidates(result, options.bounds)
  } catch {
    return []
  } finally {
    if (timer) clearTimeout(timer)
  }
}
