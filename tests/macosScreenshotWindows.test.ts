import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  enumerateMacosScreenshotWindows,
  MACOS_SCREENSHOT_WINDOWS_TIMEOUT_MS
} from '../src/main/macosScreenshotWindows.ts'

/**
 * 创建截图 helper 的合法候选，边界为全局 DIP 而非截图像素。
 * @param overrides 需要覆盖的候选字段。
 * @returns 用于模拟 JSON 输出的候选对象。
 * @author zhenghq
 */
function makeCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '42',
    appName: 'Safari',
    bounds: { x: -1440, y: 32, width: 900, height: 700 },
    zOrder: 4,
    ...overrides
  }
}

/**
 * 校验新路径只调用独立命令一次，并透传路径与超时预算。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('截图枚举使用独立命令、全局 DIP、应用名且不泄漏标题', async () => {
  const calls: unknown[] = []
  const result = await enumerateMacosScreenshotWindows({
    helperPath: '/injected/window-helper',
    timeoutMs: 70,
    runHelper: async (path, args, timeoutMs) => {
      calls.push([path, args, timeoutMs])
      return JSON.stringify({ ok: true, windows: [makeCandidate({ title: '私密网页标题' })] })
    }
  })
  assert.deepEqual(calls, [['/injected/window-helper', ['screenshot-windows'], 70]])
  assert.deepEqual(result, [makeCandidate()])
  assert.equal(JSON.stringify(result).includes('私密网页标题'), false)
})

/**
 * 校验 helper 缺失及启动异常均静默降级，不调用取词重试。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('缺失 helper、ENOENT、非零退出和同步异常均返回空候选', async () => {
  assert.deepEqual(await enumerateMacosScreenshotWindows({ helperPath: '/missing/screenshot-helper' }), [])
  for (const error of [Object.assign(new Error('启动失败'), { code: 'ENOENT' }), new Error('退出失败')]) {
    let calls = 0
    assert.deepEqual(await enumerateMacosScreenshotWindows({
      runHelper: async () => { calls += 1; throw error }
    }), [])
    assert.equal(calls, 1)
  }
  assert.deepEqual(await enumerateMacosScreenshotWindows({
    runHelper: () => { throw new Error('同步异常') }
  }), [])
})

/**
 * 校验永不结束的注入依赖仍受外层预算限制且仅执行一次。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('冷启动和永不结束的 helper 在有界超时后返回空数组，不走 800ms 重试', async () => {
  let calls = 0
  const started = Date.now()
  assert.deepEqual(await enumerateMacosScreenshotWindows({
    timeoutMs: 15,
    runHelper: async () => { calls += 1; return new Promise<string>(() => undefined) }
  }), [])
  assert.equal(calls, 1)
  assert.ok(Date.now() - started < 500)
  assert.equal(MACOS_SCREENSHOT_WINDOWS_TIMEOUT_MS, 200)
})

/**
 * 校验超时之后才发生的拒绝也有错误处理，不污染后续请求。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('超时后的 helper 拒绝被吸收且新调用可正常返回', async () => {
  assert.deepEqual(await enumerateMacosScreenshotWindows({
    timeoutMs: 1,
    runHelper: async () => new Promise<string>((_resolve, reject) => {
      setTimeout(() => reject(new Error('迟到异常')), 15)
    })
  }), [])
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.deepEqual(await enumerateMacosScreenshotWindows({
    runHelper: async () => JSON.stringify({ ok: true, windows: [makeCandidate()] })
  }), [makeCandidate()])
})

/**
 * 校验畸形 JSON、失败响应与错误容器都不能成为候选。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('畸形 JSON 和非成功窗口数组均返回空候选', async () => {
  for (const stdout of ['', 'not-json', '{', 'null', '[]', '42',
    '{"ok":false,"windows":[]}', '{"windows":[]}', '{"ok":true,"windows":{}}']) {
    assert.deepEqual(await enumerateMacosScreenshotWindows({ runHelper: async () => stdout }), [])
  }
})

/**
 * 校验逐项过滤、重复编号去重、显式排除及从前到后的原始层级保留。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('候选按 zOrder 排序，过滤坏数据与排除 ID，并保留负坐标和原始层级', async () => {
  const front = makeCandidate({ id: '10', zOrder: 0 })
  const back = makeCandidate({ id: '11', zOrder: 9 })
  const windows = [back, null, makeCandidate({ id: '' }), makeCandidate({ id: 42 }),
    makeCandidate({ id: 'tiny', bounds: { x: 0, y: 0, width: 7, height: 500 } }),
    makeCandidate({ id: 'bad', bounds: { x: '0', y: 0, width: 500, height: 500 } }),
    makeCandidate({ id: 'nan', bounds: { x: 0, y: 0, width: null, height: 500 } }),
    makeCandidate({ id: 'negative', bounds: { x: 0, y: 0, width: 500, height: -1 } }),
    makeCandidate({ id: 'invalid-name', appName: 123 }),
    makeCandidate({ id: 'bad-order', zOrder: -1 }),
    makeCandidate({ id: 'fractional-order', zOrder: 1.5 }),
    makeCandidate({ id: 'excluded', zOrder: 1 }), front,
    makeCandidate({ id: '10', zOrder: 100 })]
  assert.deepEqual(await enumerateMacosScreenshotWindows({
    excludedWindowIds: ['excluded'],
    runHelper: async () => JSON.stringify({ ok: true, windows })
  }), [front, back])
  assert.deepEqual(await enumerateMacosScreenshotWindows({
    excludedWindowIds: new Set(['10']),
    runHelper: async () => JSON.stringify({ ok: true, windows: [front, back] })
  }), [back])
})

/**
 * 校验非有限 JSON 数字和错误超时配置不能突破默认预算。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('过滤溢出数字并把非有限超时恢复到默认预算', async () => {
  for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
    let budget = 0
    assert.deepEqual(await enumerateMacosScreenshotWindows({
      timeoutMs,
      runHelper: async (_path, _args, timeout) => {
        budget = timeout
        return '{"ok":true,"windows":[{"id":"42","appName":"Safari","zOrder":0,"bounds":{"x":1e999,"y":0,"width":900,"height":700}}]}'
      }
    }), [])
    assert.equal(budget, MACOS_SCREENSHOT_WINDOWS_TIMEOUT_MS)
  }
})

/**
 * 校验原生截图命令独立、只读且过滤不可见、透明、桌面与非普通窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('原生 screenshot-windows 独立枚举普通系统窗口，不读取窗口标题或激活应用', () => {
  const source = readFileSync('helpers/macos-window-helper/main.m', 'utf8')
  const start = source.indexOf('static NSArray<NSDictionary *> *EnumerateScreenshotWindows(')
  const end = source.indexOf('\n}', start)
  assert.ok(start >= 0 && end > start)
  const native = source.slice(start, end)
  assert.match(native, /kCGWindowListOptionOnScreenOnly/u)
  assert.match(native, /kCGWindowListExcludeDesktopElements/u)
  assert.match(native, /kCGWindowIsOnscreen/u)
  assert.match(native, /kCGWindowAlpha/u)
  assert.match(native, /layer\.intValue != 0/u)
  assert.match(native, /localizedName/u)
  assert.match(native, /kCGWindowOwnerName/u)
  assert.match(native, /@"zOrder": @\(index\)/u)
  assert.doesNotMatch(native, /kCGWindowName|AXUIElement|activateWithOptions|CGDisplayPixelsWide/u)
  const main = source.slice(source.indexOf('int main('))
  assert.ok(main.indexOf('@"screenshot-windows"') < main.indexOf('pid_t pid'), '无 PID 的新命令必须先分派')
})
