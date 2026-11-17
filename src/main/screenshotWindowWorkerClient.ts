import { Worker } from 'node:worker_threads'
import type { WindowsScreenshotOptions } from './windowsScreenshotWindows'
import type { ScreenshotWindowCandidate } from '../shared/screenshotWindowSelection'

/** 原生候选线程的最小可注入接口。 */
interface CandidateWorker {
  /** 注册结果或错误事件；参数为事件及监听器，返回线程接口。@author zhenghq */
  on(event: string, listener: (...values: any[]) => void): CandidateWorker
  /** 结束线程；无参数，返回退出码 Promise。@author zhenghq */
  terminate(): Promise<number>
}

/**
 * 在独立线程内同步枚举 Win32，避免 DLL/系统卡顿阻塞截图主进程；超时不做进程内回退。
 * @param workerPath 构建后的线程入口。
 * @param options 可结构化克隆的屏幕、目标物理边界和排除编号。
 * @param deps 可选测试线程工厂及预算。
 * @returns 有效候选列表，超时或线程失败为空。
 * @author zhenghq
 */
export function enumerateWindowsScreenshotWindowsInWorker(
  workerPath: string, options: WindowsScreenshotOptions,
  deps: { timeoutMs?: number; createWorker?: () => CandidateWorker } = {}
): Promise<ScreenshotWindowCandidate[]> {
  return new Promise((resolve) => {
    let worker: CandidateWorker
    try {
      worker = deps.createWorker ? deps.createWorker() : new Worker(workerPath, { workerData: options })
    } catch {
      resolve([])
      return
    }
    let settled = false
    const finish = (result: ScreenshotWindowCandidate[]): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate().catch(() => {})
      resolve(result)
    }
    const timer = setTimeout(() => finish([]), deps.timeoutMs ?? 200)
    worker.on('message', (result) => finish(Array.isArray(result) ? result : []))
    worker.on('error', () => finish([]))
    worker.on('exit', () => finish([]))
  })
}
