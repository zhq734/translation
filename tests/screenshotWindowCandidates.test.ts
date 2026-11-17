import assert from 'node:assert/strict'
import test from 'node:test'
import { collectScreenshotWindowCandidates } from '../src/main/screenshotWindowCandidates.ts'

const bounds = { x: -1200, y: 0, width: 1200, height: 800 }
const candidate = { id: '1', appName: '应用', bounds: { x: -1250, y: 10, width: 600, height: 300 }, zOrder: 0 }

/** 校验原生全局 DIP 只局部化一次；无参数，返回异步断言结果。@author zhenghq */
test('候选协调器按平台调用并裁剪到起始显示器', async () => {
  const result = await collectScreenshotWindowCandidates({
    platform: 'darwin', bounds, enumerateMacos: async () => [candidate],
    enumerateWindows: async () => { throw new Error('不应调用 Windows') }
  })
  assert.deepEqual(result[0].bounds, { x: 0, y: 10, width: 550, height: 300 })
})

/** 校验异常、不支持平台及超时降级；无参数，返回异步断言结果。@author zhenghq */
test('候选失败或超时返回空数组，不阻断截图', async () => {
  const enumerateWindows = async () => { throw new Error('枚举失败') }
  assert.deepEqual(await collectScreenshotWindowCandidates({ platform: 'win32', bounds, enumerateWindows }), [])
  assert.deepEqual(await collectScreenshotWindowCandidates({ platform: 'linux', bounds, enumerateWindows }), [])
  assert.deepEqual(await collectScreenshotWindowCandidates({
    platform: 'darwin', bounds, timeoutMs: 10, enumerateMacos: () => new Promise(() => {})
  }), [])
})
