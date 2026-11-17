import { parentPort, workerData } from 'node:worker_threads'
import { enumerateWindowsScreenshotWindows, type WindowsScreenshotOptions } from './windowsScreenshotWindows'

/** 执行 Windows 同步枚举并向主线程返回候选；无参数，返回异步完成结果。@author zhenghq */
async function startScreenshotWindowWorker(): Promise<void> {
  if (!parentPort) return
  const result = await enumerateWindowsScreenshotWindows(workerData as WindowsScreenshotOptions)
  parentPort.postMessage(result)
}

void startScreenshotWindowWorker()
