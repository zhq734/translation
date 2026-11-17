import assert from 'node:assert/strict'
import test from 'node:test'
import { enumerateWindowsScreenshotWindowsInWorker } from '../src/main/screenshotWindowWorkerClient.ts'

/** 校验无响应线程超时退出且不会堵住调用方；无参数，返回异步断言结果。@author zhenghq */
test('原生窗口线程无响应时终止并回退到拖拽', async () => {
  let terminated = 0
  const result = await enumerateWindowsScreenshotWindowsInWorker('unused', { displays: [] }, {
    timeoutMs: 10,
    createWorker: () => ({ on() { return this }, terminate() { terminated += 1; return Promise.resolve(0) } })
  })
  assert.deepEqual(result, [])
  assert.equal(terminated, 1)
})
