import assert from 'node:assert/strict'
import test from 'node:test'
import {
  enumerateWindowsScreenshotWindows,
  type WindowsScreenshotBindings,
  type WindowsScreenshotKoffi,
  type WindowsScreenshotOptions,
  type WindowsScreenshotRect
} from '../src/main/windowsScreenshotWindows'
import { normalizeScreenshotWindowCandidates } from '../src/shared/screenshotWindowSelection'

/** 校验混合 DPI 跨屏矩形按目标屏物理交集裁剪，不能把两端点按不同缩放转换；无参数，返回异步断言结果。@author zhenghq */
test('混合 DPI 跨屏窗口在目标副屏保持正确高度', async () => {
  const bounds = { x: -1280, y: 0, width: 1280, height: 720 }
  const result = await enumerateWindowsScreenshotWindows(makeOptions({
    targetDisplay: { bounds, physicalBounds: { x: -2560, y: 0, width: 2560, height: 1440 }, scaleFactor: 2 },
    screenToDipPoint: (point) => point.x < 0 ? { x: point.x / 2, y: point.y / 2 } : point,
    bindings: makeBindings({ enumWindows(callback) { callback(1); return true },
      getWindowRect() { return { left: -200, top: 200, right: 200, bottom: 600 } } })
  }))
  assert.deepEqual(normalizeScreenshotWindowCandidates(result, bounds)[0].bounds,
    { x: 1180, y: 100, width: 100, height: 200 })
})

/**
 * 创建可覆盖的窗口绑定，默认返回两个前后排列的普通窗口。
 * @param overrides 要替换的原生方法。
 * @returns 不访问操作系统的绑定。
 * @author zhenghq
 */
function makeBindings(overrides: Partial<WindowsScreenshotBindings> = {}): WindowsScreenshotBindings {
  return {
    /** 按前后顺序调用窗口回调，返回枚举成功状态。@author zhenghq */
    enumWindows(callback) { callback(11); callback(22); return true },
    /** 返回窗口的可见状态。@author zhenghq */
    isWindowVisible() { return true },
    /** 返回窗口是否最小化。@author zhenghq */
    isIconic() { return false },
    /** 返回窗口物理边界。@author zhenghq */
    getWindowRect() { return { left: 100, top: 80, right: 500, bottom: 380 } },
    ...overrides
  }
}

/**
 * 创建 Windows 平台枚举选项，默认使用注入绑定而非真实 DLL。
 * @param overrides 要替换的枚举选项。
 * @returns 测试选项。
 * @author zhenghq
 */
function makeOptions(overrides: Partial<WindowsScreenshotOptions> = {}): WindowsScreenshotOptions {
  return {
    platform: 'win32',
    displays: [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }],
    bindings: makeBindings(),
    ...overrides
  }
}

/** 验证不支持的平台直接返回空列表且不访问加载器或绑定。@author zhenghq */
test('macOS 和 Linux 不加载 koffi 或枚举 native 窗口', async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const results = await enumerateWindowsScreenshotWindows(makeOptions({
      platform,
      loadKoffi() { assert.fail('不允许加载 native') },
      bindings: makeBindings({ enumWindows() { assert.fail('不允许枚举 native') } })
    }))
    assert.deepEqual(results, [])
  }
})

/** 验证默认运行平台也不访问 native；无参数，返回完成后的 Promise。@author zhenghq */
test('省略 platform 时使用真实平台并在 macOS 安全降级', async () => {
  if (process.platform === 'win32') return
  assert.deepEqual(await enumerateWindowsScreenshotWindows(makeOptions({
    platform: undefined,
    bindings: undefined,
    loadKoffi() { assert.fail('非 Windows 不允许加载 native') }
  })), [])
})

/** 验证原生前后顺序、完整句柄和不读取窗口标题的匿名标签。@author zhenghq */
test('候选按 EnumWindows 前后顺序返回，句柄不截断且不读取标题', async () => {
  const results = await enumerateWindowsScreenshotWindows(makeOptions({
    bindings: makeBindings({ enumWindows(callback) { callback(0x20000000000001n); callback(22); return true } })
  }))
  assert.deepEqual(results.map(({ id, zOrder }) => ({ id, zOrder })), [
    { id: '9007199254740993', zOrder: 0 }, { id: '22', zOrder: 1 }
  ])
  assert.equal(results[0].appName, '')
  assert.deepEqual(results[0].bounds, { x: 100, y: 80, width: 400, height: 300 })
})

/** 验证隐藏、最小化、cloaked、零面积和排除窗口被过滤，普通弹窗仍保留。@author zhenghq */
test('过滤无效窗口和显式排除项，保留没有标题的普通弹窗', async () => {
  const bindings = makeBindings({
    enumWindows(callback) { for (let id = 1; id <= 7; id++) callback(id); return true },
    isWindowVisible(id) { return id !== 1 },
    isIconic(id) { return id === 2 },
    isWindowCloaked(id) { return id === 3 },
    getWindowRect(id) { return { left: 0, top: 0, right: id === 4 ? 0 : 200, bottom: 100 } }
  })
  for (const excludedWindowIds of [['5'], new Set(['5'])]) {
    const results = await enumerateWindowsScreenshotWindows(makeOptions({ bindings, excludedWindowIds }))
    assert.deepEqual(results.map(({ id, zOrder }) => ({ id, zOrder })), [{ id: '6', zOrder: 5 }, { id: '7', zOrder: 6 }])
  }
})

/** 验证有效 DWM 边界优先，不额外读取带阴影的 GetWindowRect。@author zhenghq */
test('优先 DWM 可见边界', async () => {
  const results = await enumerateWindowsScreenshotWindows(makeOptions({ bindings: makeBindings({
    getDwmWindowBounds() { return { left: 10, top: 20, right: 310, bottom: 220 } },
    getWindowRect() { assert.fail('已有 DWM 边界不应再次取 RECT') }
  }) }))
  assert.deepEqual(results[0].bounds, { x: 10, y: 20, width: 300, height: 200 })
})

/** 验证 DWM 缺失、失败或异常时使用 Win7 兼容 RECT。@author zhenghq */
test('DWM 缺失、失败、无效边界和异常均回退 GetWindowRect', async () => {
  const variants: Partial<WindowsScreenshotBindings>[] = [
    {}, { getDwmWindowBounds() { return null } },
    { getDwmWindowBounds() { throw new Error('DWM unavailable') } },
    { getDwmWindowBounds() { return { left: 0, top: 0, right: 0, bottom: 1 } } },
    { getDwmWindowBounds() { return { left: NaN, top: 0, right: 10, bottom: 1 } } },
    { isWindowCloaked() { throw new Error('Win7 不支持 cloaked') } }
  ]
  for (const variant of variants) {
    const results = await enumerateWindowsScreenshotWindows(makeOptions({ bindings: makeBindings(variant) }))
    assert.deepEqual(results[0].bounds, { x: 100, y: 80, width: 400, height: 300 })
  }
})

/** 验证窗口失效不会影响后续窗口，并且无效矩形不能进入候选。@author zhenghq */
test('单窗异常与无效物理 RECT 被忽略', async () => {
  const invalidRects: Array<WindowsScreenshotRect | null> = [
    null, { left: 10, top: 0, right: 1, bottom: 1 },
    { left: 0, top: 0, right: 10, bottom: Infinity },
    { left: 0, top: 0, right: 10, bottom: 0 }
  ]
  for (const rect of invalidRects) {
    const results = await enumerateWindowsScreenshotWindows(makeOptions({ bindings: makeBindings({
      getWindowRect(id) { return id === 11 ? rect : { left: 0, top: 0, right: 10, bottom: 10 } }
    }) }))
    assert.deepEqual(results.map(({ id }) => id), ['22'])
  }
  const results = await enumerateWindowsScreenshotWindows(makeOptions({ bindings: makeBindings({
    isWindowVisible(id) { if (id === 11) throw new Error('窗口已销毁'); return true }
  }) }))
  assert.deepEqual(results.map(({ id }) => id), ['22'])
})

/** 验证加载失败或枚举不完整时不返回半份候选。@author zhenghq */
test('native 加载及枚举失败降级为空列表', async () => {
  for (const options of [
    makeOptions({ bindings: undefined, loadKoffi() { throw new Error('missing native') } }),
    makeOptions({ bindings: makeBindings({ enumWindows(callback) { callback(11); return false } }) }),
    makeOptions({ bindings: makeBindings({ enumWindows() { throw new Error('枚举失败') } }) })
  ]) assert.deepEqual(await enumerateWindowsScreenshotWindows(options), [])
})

for (const scaleFactor of [1, 1.5, 2]) {
  /** 验证主屏物理坐标只转换一次，输出仍为全局 DIP。@author zhenghq */
  test(`缩放 ${scaleFactor} 的物理 RECT 转换为 DIP`, async () => {
    const results = await enumerateWindowsScreenshotWindows(makeOptions({
      displays: [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor }],
      bindings: makeBindings({ getWindowRect() { return { left: 120 * scaleFactor, top: 90 * scaleFactor, right: 420 * scaleFactor, bottom: 290 * scaleFactor } } })
    }))
    assert.deepEqual(results[0].bounds, { x: 120, y: 90, width: 300, height: 200 })
  })
}

/** 验证负坐标副屏使用自身物理原点和缩放，不按主屏比例除全局坐标。@author zhenghq */
test('负坐标副屏与主屏混合缩放', async () => {
  const results = await enumerateWindowsScreenshotWindows(makeOptions({
    displays: [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 },
      { bounds: { x: -1280, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 }
    ],
    bindings: makeBindings({ getWindowRect() { return { left: -1770, top: 150, right: -1320, bottom: 450 } } })
  }))
  assert.deepEqual(results[0].bounds, { x: -1180, y: 100, width: 300, height: 200 })
})

/** 验证右侧副屏物理原点来自主屏宽度，而非副屏 DIP 原点乘自身比例。@author zhenghq */
test('右侧混合 DPI 显示器不能重复缩放全局原点', async () => {
  const results = await enumerateWindowsScreenshotWindows(makeOptions({
    displays: [
      { bounds: { x: 1920, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 },
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 }
    ],
    bindings: makeBindings({ getWindowRect() { return { left: 3990, top: 150, right: 4440, bottom: 450 } } })
  }))
  assert.deepEqual(results[0].bounds, { x: 2020, y: 100, width: 300, height: 200 })
})

/** 验证上方负坐标显示器以及跨显示器窗口的两端转换。@author zhenghq */
test('上方负坐标与跨屏窗口仍输出全局 DIP', async () => {
  const above = await enumerateWindowsScreenshotWindows(makeOptions({
    displays: [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
      { bounds: { x: 0, y: -720, width: 1280, height: 720 }, scaleFactor: 2 }
    ],
    bindings: makeBindings({ getWindowRect() { return { left: 200, top: -1240, right: 800, bottom: -840 } } })
  }))
  assert.deepEqual(above[0].bounds, { x: 100, y: -620, width: 300, height: 200 })
  const spanning = await enumerateWindowsScreenshotWindows(makeOptions({
    displays: [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
      { bounds: { x: -1280, y: 0, width: 1280, height: 720 }, scaleFactor: 2 }
    ],
    bindings: makeBindings({ getWindowRect() { return { left: -200, top: 0, right: 200, bottom: 200 } } })
  }))
  assert.deepEqual(spanning[0].bounds, { x: -100, y: 0, width: 300, height: 200 })
})

/** 验证 Electron 注入转换优先，仅转换两个物理端点且不再除缩放。@author zhenghq */
test('screenToDipPoint 用于真实混合 DPI 原点，输出不重复转换', async () => {
  const calls: Array<{ x: number; y: number }> = []
  const results = await enumerateWindowsScreenshotWindows(makeOptions({
    displays: [{ bounds: { x: -1600, y: -200, width: 1600, height: 900 }, scaleFactor: 2 }],
    bindings: makeBindings({ enumWindows(callback) { callback(11); return true } }),
    screenToDipPoint(point) {
      calls.push(point)
      return { x: -1600 + (point.x - 100) / 1.5, y: -200 + (point.y - 80) / 1.5 }
    }
  }))
  assert.deepEqual(calls, [{ x: 100, y: 80 }, { x: 500, y: 380 }])
  assert.deepEqual({ ...results[0].bounds, width: 0 }, { x: -1600, y: -200, width: 0, height: 200 })
  // 负坐标端点相减有浮点舍入误差，但不得二次除以显示器缩放。
  assert.ok(Math.abs(results[0].bounds.width - 400 / 1.5) < 1e-9)
})

/** 验证无法换算时安全降级，Electron 转换不依赖显示器列表。@author zhenghq */
test('缺少有效显示器或转换返回非有限坐标时安全降级', async () => {
  assert.deepEqual(await enumerateWindowsScreenshotWindows(makeOptions({ displays: [] })), [])
  assert.deepEqual(await enumerateWindowsScreenshotWindows(makeOptions({ displays: [{ bounds: { x: 0, y: 0, width: 10, height: 10 }, scaleFactor: 0 }] })), [])
  assert.deepEqual(await enumerateWindowsScreenshotWindows(makeOptions({ screenToDipPoint() { return { x: NaN, y: 0 } } })), [])
  const results = await enumerateWindowsScreenshotWindows(makeOptions({ displays: [], screenToDipPoint(point) { return point } }))
  assert.equal(results.length, 2)
})

/**
 * 创建真实绑定路径使用的 koffi 桩，记录调用约定、输出类型和 DLL 加载。
 * @param mode 模拟 DWM 正常、DLL 缺失、符号缺失或属性失败。
 * @returns 可注入加载器的 koffi 与原生调用记录。
 * @author zhenghq
 */
function makeKoffi(mode: 'ok' | 'missing' | 'symbol-missing' | 'failed' | 'cloaked' | 'win7' | 'rect-failed' = 'ok') {
  const loads: string[] = []
  const calls: string[] = []
  const structs: Array<Record<string, unknown>> = []
  const koffi: WindowsScreenshotKoffi = {
    /** 记录匿名 RECT 成员并返回类型，避免和其他模块重名。@author zhenghq */
    struct(definition) { structs.push(definition); return { rect: true } },
    /** 返回指针类型用于原生函数声明。@author zhenghq */
    pointer(type) { return { pointer: type } },
    /** 返回输出标记，供桩校验结构体方向。@author zhenghq */
    out(type) { return { out: type } },
    /** 验证回调使用 stdcall 和指针宽度 HWND/LPARAM。@author zhenghq */
    proto(convention, result, args) {
      assert.equal(convention, '__stdcall'); assert.equal(result, 'int'); assert.deepEqual(args, ['uintptr', 'intptr'])
      return { callback: true }
    },
    /** 加载模拟 DLL，返回 Win32 原生绑定实现。@author zhenghq */
    load(path) {
      loads.push(path)
      if (path === 'dwmapi.dll' && mode === 'missing') throw new Error('Win7 DWM 不可用')
      return {
        /** 校验原生函数并创建模拟函数，参数包含可变输出缓冲区。@author zhenghq */
        func(convention, name, result, args) {
          assert.equal(convention, '__stdcall')
          assert.ok(!/WindowText|ClassName|WindowLong|Process/i.test(name), '不读取标题或排除普通弹窗')
          if (name === 'DwmGetWindowAttribute' && mode === 'symbol-missing') throw new Error('符号缺失')
          if (name === 'GetWindowRect') {
            assert.equal(result, 'int'); assert.deepEqual(args, ['uintptr', { out: { pointer: { rect: true } } }])
          }
          if (name === 'DwmGetWindowAttribute') { assert.equal(result, 'int32'); assert.equal(args[3], 'uint32') }
          /** 模拟回调与输出参数，返回真实 Win32 成功或失败代码。@author zhenghq */
          return (...values: unknown[]) => {
            calls.push(name)
            if (name === 'EnumWindows') { (values[0] as (id: bigint, param: number) => number)(11n, 0); return 1 }
            if (name === 'IsWindowVisible') return 1
            if (name === 'IsIconic') return 0
            if (name === 'GetWindowRect') {
              Object.assign(values[1] as object, { left: 100, top: 80, right: 500, bottom: 380 })
              return mode === 'rect-failed' ? 0 : 1
            }
            if (name === 'DwmGetWindowAttribute') {
              if (mode === 'failed' || mode === 'rect-failed') return -2147467259
              if (values[1] === 14) {
                assert.equal(values[3], 4)
                if (mode === 'win7') return -2147024809
                const output = values[2] as number[]
                output[0] = mode === 'cloaked' ? 2 : 0
              }
              else { assert.equal(values[1], 9); assert.equal(values[3], 16); Object.assign(values[2] as object, { left: 10, top: 20, right: 310, bottom: 220 }) }
              return 0
            }
            assert.fail(`未知 API: ${name}`)
          }
        }
      }
    }
  }
  return { koffi, loads, calls, structs }
}

/** 验证 native 绑定路径的 stdcall、回调、BOOL/HRESULT、输出缓冲与匿名类型。@author zhenghq */
test('注入 koffi 验证真实绑定契约与 DWM 优先', async () => {
  const stub = makeKoffi()
  for (let attempt = 0; attempt < 2; attempt++) {
    const results = await enumerateWindowsScreenshotWindows(makeOptions({ bindings: undefined, loadKoffi() { return stub.koffi } }))
    assert.deepEqual(results[0].bounds, { x: 10, y: 20, width: 300, height: 200 })
  }
  assert.deepEqual(stub.loads, ['user32.dll', 'dwmapi.dll', 'user32.dll', 'dwmapi.dll'])
  assert.equal(stub.calls.includes('GetWindowRect'), false)
  assert.deepEqual(stub.structs, [
    { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' },
    { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' }
  ])
})

for (const mode of ['missing', 'symbol-missing', 'failed', 'win7'] as const) {
  /** 验证旧版系统和关闭 DWM 时原生绑定回退成功。@author zhenghq */
  test(`native DWM ${mode} 时仍可枚举窗口`, async () => {
    const stub = makeKoffi(mode)
    const results = await enumerateWindowsScreenshotWindows(makeOptions({ bindings: undefined, loadKoffi() { return stub.koffi } }))
    assert.deepEqual(results[0].bounds, mode === 'win7'
      ? { x: 10, y: 20, width: 300, height: 200 }
      : { x: 100, y: 80, width: 400, height: 300 })
    assert.equal(stub.calls.includes('GetWindowRect'), mode !== 'win7')
  })
}

/** 验证真实 native 返回的 cloaked 标志和 GetWindowRect 失败代码不会泄漏候选。@author zhenghq */
test('native cloaked 非零标志及 RECT 返回零均过滤窗口', async () => {
  for (const mode of ['cloaked', 'rect-failed'] as const) {
    const stub = makeKoffi(mode)
    const results = await enumerateWindowsScreenshotWindows(makeOptions({ bindings: undefined, loadKoffi() { return stub.koffi } }))
    assert.deepEqual(results, [])
  }
})
