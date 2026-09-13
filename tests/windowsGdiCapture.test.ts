import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bgraToRgba,
  buildBitmapInfo,
  captureWindowsOcrPngPreferGdi,
  captureWindowsRegionAsPngGdi,
  getKoffiGdiCapture,
  resetKoffiBindingCacheForTests,
  BITMAPINFO_FIELDS,
  KOFFI_BUILTIN_TYPE_NAMES,
  KOFFI_BINDING_RETRY_INTERVAL_MS,
  REGISTERED_TYPE_NAMES,
  WIN32_PROTOTYPES,
  WINDOWS_GDI_CAPTURE_SOURCE,
  WINDOWS_GDI_FALLBACK_SOURCE,
  setKoffiBindingClockForTests,
  type WindowsGdiCaptureDeps,
  type GdiCaptureFn,
  type KoffiLoader,
  type KoffiLike
} from '../src/main/windowsGdiCapture.ts'
import { ScreenCaptureError } from '../src/main/screenCapture'
import { decodePng } from '../src/main/pngCodec'

/**
 * 构造可注入依赖：注入 mock GDI 采集函数，返回预置 BGRA 像素数据。
 * @param overrides 覆盖默认行为的依赖子集。
 * @returns 完整依赖对象。
 * @author zhenghq
 */
function makeDeps(overrides: Partial<WindowsGdiCaptureDeps> & { captureGdi?: GdiCaptureFn } = {}): WindowsGdiCaptureDeps {
  const defaultCapture: GdiCaptureFn = async (x, y, width, height) => {
    // 返回 2×2 纯蓝像素的 BGRA 数据用于测试
    const data = new Uint8Array(width * height * 4)
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 0xff      // B
      data[i + 1] = 0x00  // G
      data[i + 2] = 0x00  // R
      data[i + 3] = 0x00  // A（bgraToRgba 会设为 0xff）
    }
    return { data, width, height }
  }
  return {
    platform: 'win32',
    captureGdi: defaultCapture,
    ...overrides
  }
}

/**
 * 校验 BGRA → RGBA 通道交换：B 和 R 互换，alpha 固定 0xff。
 * @returns 无返回值。
 * @author zhenghq
 */
test('bgraToRgba 应正确交换 B 和 R 通道', () => {
  const bgra = new Uint8Array([
    0xff, 0x00, 0x00, 0x00, // BGRA: 蓝
    0x00, 0xff, 0x00, 0x00, // BGRA: 绿
  ])
  const rgba = bgraToRgba(bgra, 2, 1)
  assert.equal(rgba.width, 2)
  assert.equal(rgba.height, 1)
  assert.equal(rgba.data[0], 0x00)  // R ← 原 B 的反位置
  assert.equal(rgba.data[1], 0x00)  // G
  assert.equal(rgba.data[2], 0xff)  // B ← 原 B
  assert.equal(rgba.data[3], 0xff)  // A = 255
  assert.equal(rgba.data[4], 0x00)  // R
  assert.equal(rgba.data[5], 0xff)  // G
  assert.equal(rgba.data[6], 0x00)  // B
  assert.equal(rgba.data[7], 0xff)  // A
})

/**
 * 校验 captureWindowsRegionAsPngGdi 调用注入的 captureGdi 函数并返回 PNG 字节。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('captureWindowsRegionAsPngGdi 应调用注入的 captureGdi 并返回 PNG', async () => {
  let capturedArgs: { x: number; y: number; width: number; height: number } | null = null
  const png = await captureWindowsRegionAsPngGdi(
    { x: 0, y: 0, width: 1920, height: 1080 },
    1.5,
    makeDeps({
      captureGdi: async (x, y, width, height) => {
        capturedArgs = { x, y, width, height }
        const data = new Uint8Array(width * height * 4)
        for (let i = 0; i < data.length; i += 4) {
          data[i] = 0x41      // B
          data[i + 1] = 0x42  // G
          data[i + 2] = 0x43  // R
          data[i + 3] = 0x00  // A
        }
        return { data, width, height }
      }
    })
  )
  // 坐标应按 scaleFactor 换算为物理像素
  assert.deepEqual(capturedArgs, { x: 0, y: 0, width: 2880, height: 1620 })
  // 返回值应为合法 PNG
  assert.ok(png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47)
  // 解码后尺寸应正确
  const img = decodePng(png)
  assert.equal(img.width, 2880)
  assert.equal(img.height, 1620)
  // 第一个像素的 R 通道应为 0x43（原 BGRA 的 B=0x41 交换后变成 R=0x43）
  assert.equal(img.data[0], 0x43)
  assert.equal(img.data[1], 0x42)
  assert.equal(img.data[2], 0x41)
  assert.equal(img.data[3], 0xff)
})

/**
 * 校验多显示器物理坐标偏移正确传递。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('captureWindowsRegionAsPngGdi 应支持多显示器坐标偏移', async () => {
  let capturedX = -1
  let capturedY = -1
  await captureWindowsRegionAsPngGdi(
    { x: 1920, y: 0, width: 1920, height: 1080 },
    1,
    makeDeps({
      captureGdi: async (x, y, width, height) => {
        capturedX = x
        capturedY = y
        return { data: new Uint8Array(width * height * 4), width, height }
      }
    })
  )
  assert.equal(capturedX, 1920)
  assert.equal(capturedY, 0)
})

/**
 * 校验 GDI 采集失败时归类为 no-source 错误。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('captureWindowsRegionAsPngGdi 失败应归类为 no-source', async () => {
  await assert.rejects(
    captureWindowsRegionAsPngGdi(
      { x: 0, y: 0, width: 1920, height: 1080 },
      1,
      makeDeps({
        captureGdi: async () => { throw new Error('BitBlt 失败') }
      })
    ),
    (error: unknown) => error instanceof ScreenCaptureError && error.code === 'no-source'
  )
})

/**
 * 校验非 Windows 平台调用直接抛出 no-source 错误。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('非 Windows 平台调用应拒绝执行', async () => {
  await assert.rejects(
    captureWindowsRegionAsPngGdi(
      { x: 0, y: 0, width: 1920, height: 1080 },
      1,
      makeDeps({ platform: 'linux' })
    ),
    (error: unknown) => error instanceof ScreenCaptureError && error.code === 'no-source'
  )
})

/**
 * 校验当 deps.captureGdi 未注入时，模块尝试加载 koffi FFI。
 * 在非 Windows 环境下 koffi 加载会失败，应抛出 no-source 错误而非崩溃。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('captureGdi 未注入时应在 Windows 以外平台安全报错', async () => {
  await assert.rejects(
    captureWindowsRegionAsPngGdi(
      { x: 0, y: 0, width: 100, height: 100 },
      1,
      { platform: 'linux' }
    ),
    (error: unknown) => error instanceof ScreenCaptureError && error.code === 'no-source'
  )
})

/**
 * 解析 koffi 函数原型字符串，提取返回类型与各参数类型（忽略调用约定、函数名与参数名）。
 * @param prototype koffi 原型字符串，形如 `bool __stdcall BitBlt(HDC hdc, DWORD rop)`。
 * @returns 类型名列表，多词类型（如 `unsigned int`）以单个空格连接。
 * @author zhenghq
 */
function extractPrototypeTypeNames(prototype: string): string[] {
  const normalized = prototype.replace(/__stdcall\b/g, ' ').replace(/\s+/g, ' ').trim()
  const matched = normalized.match(/^(.+?)\s+([A-Za-z_]\w*)\s*\((.*)\)$/u)
  assert.ok(matched, `原型格式无法解析: ${prototype}`)
  const [, returnPart, , paramPart] = matched as RegExpMatchArray
  const types: string[] = [returnPart.replace(/\*/g, ' ').trim()]
  for (const rawParam of paramPart.split(',')) {
    const param = rawParam.trim()
    if (!param) continue
    // 参数写法为 `类型 [*]参数名`，去掉指针符号后丢弃最后一个标识符（参数名）
    const tokens = param.replace(/\*/g, ' ').trim().split(/\s+/u)
    assert.ok(tokens.length >= 2, `参数缺少类型或名称: ${param}`)
    types.push(tokens.slice(0, -1).join(' '))
  }
  return types
}

/**
 * 构造记录 API 调用的桩 koffi，用于校验绑定契约且不依赖真实 DLL。
 * @returns 桩 koffi 与调用记录。
 * @author zhenghq
 */
function createStubKoffi(): { koffi: KoffiLike; calls: string[]; prototypes: string[]; lastGetDIBitsArgs: unknown[] } {
  const calls: string[] = []
  const prototypes: string[] = []
  const lastGetDIBitsArgs: unknown[] = []
  const fakeHandle = {}
  const koffi: KoffiLike = {
    load(path: string) {
      calls.push(`load:${path}`)
      return {
        func(prototype: string) {
          calls.push('func')
          prototypes.push(prototype)
          const name = prototype.match(/\b([A-Za-z_]\w*)\s*\(/)?.[1] ?? ''
          return (...args: unknown[]) => {
            calls.push(name)
            if (name === 'GetDC') return fakeHandle
            if (name === 'CreateCompatibleDC') return fakeHandle
            if (name === 'CreateCompatibleBitmap') return fakeHandle
            if (name === 'SelectObject') return fakeHandle
            if (name === 'BitBlt') return true
            if (name === 'GetDIBits') {
              lastGetDIBitsArgs.splice(0, lastGetDIBitsArgs.length, ...args)
              const height = Number(args[3] ?? 0)
              return height
            }
            if (name === 'SetProcessDpiAwarenessContext') return true
            return true
          }
        }
      }
    },
    pointer(name: string) {
      calls.push(`pointer:${name}`)
      return name
    },
    opaque() {
      calls.push('opaque')
      return 'opaque'
    },
    struct(name: string) {
      calls.push(`struct:${name}`)
      return name
    },
    alias(name: string, type: string) {
      calls.push(`alias:${name}:${type}`)
      return name
    },
    as(value: unknown) {
      calls.push('as')
      return value
    }
  }
  return { koffi, calls, prototypes, lastGetDIBitsArgs }
}

/**
 * 校验全部 Win32 原型只引用 koffi 内建原语或本模块注册名，禁止未注册的 dword 等别名。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Win32 原型类型名必须属于内建原语或已注册别名', () => {
  const allowed = new Set<string>([...KOFFI_BUILTIN_TYPE_NAMES, ...REGISTERED_TYPE_NAMES])
  const seen: string[] = []
  for (const [name, prototype] of Object.entries(WIN32_PROTOTYPES)) {
    for (const typeName of extractPrototypeTypeNames(prototype)) {
      seen.push(typeName)
      assert.ok(
        allowed.has(typeName),
        `${name} 原型包含未注册类型名 ${typeName}: ${prototype}`
      )
      // dword 是本次故障的直接原因：koffi 无此内建名，必须写成已注册的 DWORD 别名
      assert.notEqual(typeName, 'dword', `${name} 不得使用未注册的小写 dword`)
    }
  }
  // 回归保护：DWORD 必须真实出现在原型中，避免测试因原型被改写而空转
  assert.ok(seen.includes('DWORD'))
})

/**
 * 校验注入桩 koffi 后每个函数原型都带 __stdcall。
 * @returns 无返回值。
 * @author zhenghq
 */
test('注入桩 koffi 时应为全部 Win32 原型标注 __stdcall', () => {
  resetKoffiBindingCacheForTests()
  const stub = createStubKoffi()
  getKoffiGdiCapture(() => stub.koffi)
  assert.equal(stub.prototypes.length, Object.keys(WIN32_PROTOTYPES).length)
  for (const prototype of stub.prototypes) {
    assert.match(prototype, /__stdcall\b/u, `缺少 stdcall: ${prototype}`)
  }
  resetKoffiBindingCacheForTests()
})

/**
 * 校验绑定加载路径不调用 koffi.write / koffi.alloc 这类当前版本不匹配的 API。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('GDI 绑定不得调用 koffi.write 或不带 length 的 alloc', async () => {
  resetKoffiBindingCacheForTests()
  const stub = createStubKoffi()
  const capture = getKoffiGdiCapture(() => stub.koffi)
  await capture(0, 0, 2, 2)
  assert.equal(stub.calls.includes('write'), false)
  assert.equal(stub.calls.some((item) => item.startsWith('alloc')), false)
  assert.ok(stub.calls.includes('alias:DWORD:uint32_t'))
  assert.ok(stub.calls.includes('struct:BITMAPINFO'))
  resetKoffiBindingCacheForTests()
})

/**
 * 校验 GetDIBits 以结构体对象传入 lpbi，且 biHeight 为负、32bpp、无压缩。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('GetDIBits 应以结构体指针传入负高度 32bpp BITMAPINFO', async () => {
  resetKoffiBindingCacheForTests()
  const stub = createStubKoffi()
  const capture = getKoffiGdiCapture(() => stub.koffi)
  await capture(10, 20, 8, 6)
  const lpbi = stub.lastGetDIBitsArgs[5] as Record<string, number>
  assert.equal(typeof lpbi, 'object')
  assert.equal(lpbi.biHeight, -6)
  assert.equal(lpbi.biBitCount, 32)
  assert.equal(lpbi.biCompression, 0)
  assert.equal(lpbi.biWidth, 8)
  assert.equal(lpbi.biSize, 40)
  const expected = buildBitmapInfo(8, 6)
  assert.deepEqual(lpbi, expected)
  for (const field of Object.keys(BITMAPINFO_FIELDS)) {
    assert.ok(field in lpbi, `缺少字段 ${field}`)
  }
  resetKoffiBindingCacheForTests()
})

/**
 * 校验优先 GDI 成功时不走回退，来源标识为原生 GDI。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('captureWindowsOcrPngPreferGdi 成功时应使用 GDI 来源', async () => {
  let fallbackCalled = false
  const result = await captureWindowsOcrPngPreferGdi(
    { x: 0, y: 0, width: 2, height: 2 },
    1,
    {
      ...makeDeps(),
      captureFallback: async () => {
        fallbackCalled = true
        return Buffer.from('fallback')
      }
    }
  )
  assert.equal(fallbackCalled, false)
  assert.equal(result.source, WINDOWS_GDI_CAPTURE_SOURCE)
  assert.ok(result.png[0] === 0x89 && result.png[1] === 0x50)
})

/**
 * 校验 GDI 失败时调用回退路径并记录降级来源。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('captureWindowsOcrPngPreferGdi 在 GDI 失败时应回退并标记降级 source', async () => {
  const fallbackPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  let seenFailure = ''
  const result = await captureWindowsOcrPngPreferGdi(
    { x: 0, y: 0, width: 2, height: 2 },
    1,
    {
      ...makeDeps({
        captureGdi: async () => {
          throw new Error('Unknown or invalid type name \'dword\'')
        }
      }),
      captureFallback: async () => fallbackPng,
      onGdiFailure: (message) => {
        seenFailure = message
      }
    }
  )
  assert.match(seenFailure, /dword/u)
  assert.equal(result.source, WINDOWS_GDI_FALLBACK_SOURCE)
  assert.equal(result.png, fallbackPng)
})

/**
 * 校验 GDI 与回退均失败时归类 no-source，错误信息包含两侧原因。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('captureWindowsOcrPngPreferGdi 双路径失败应归类 no-source', async () => {
  await assert.rejects(
    captureWindowsOcrPngPreferGdi(
      { x: 0, y: 0, width: 2, height: 2 },
      1,
      {
        ...makeDeps({
          captureGdi: async () => {
            throw new Error('BitBlt 失败')
          }
        }),
        captureFallback: async () => {
          throw new Error('helper exe 退出码 1')
        }
      }
    ),
    (error: unknown) =>
      error instanceof ScreenCaptureError &&
      error.code === 'no-source' &&
      /GDI 失败/.test(error.message) &&
      /回退失败/.test(error.message)
  )
})

/**
 * 校验绑定加载失败后不会永久降级：冷却时间过后再次调用会重新尝试加载，
 * 避免首次预热（例如被杀毒软件拦截）失败后每次截图都永久走 1.5-3 秒的 PowerShell 回退。
 * @returns 无返回值。
 * @author zhenghq
 */
test('GDI 绑定失败后应在冷却时间后允许重试', () => {
  resetKoffiBindingCacheForTests()
  const now = 1_000_000
  setKoffiBindingClockForTests(() => now)
  try {
    let attempts = 0
    const failingLoader: KoffiLoader = () => {
      attempts += 1
      throw new Error('首次绑定被杀毒软件拦截')
    }
    assert.throws(() => getKoffiGdiCapture(failingLoader), /koffi 绑定加载失败/u)
    assert.equal(attempts, 1)

    // 冷却期内保持快速失败，不重复付出加载失败代价。
    assert.throws(() => getKoffiGdiCapture(failingLoader), /koffi 绑定加载失败/u)
    assert.equal(attempts, 1)

    // 冷却期结束后必须重新尝试加载，而不是永久降级到 PowerShell 回退。
    setKoffiBindingClockForTests(() => now + KOFFI_BINDING_RETRY_INTERVAL_MS)
    assert.throws(() => getKoffiGdiCapture(failingLoader), /koffi 绑定加载失败/u)
    assert.equal(attempts, 2)
  } finally {
    setKoffiBindingClockForTests(null)
    resetKoffiBindingCacheForTests()
  }
})

/**
 * 校验重试加载时不会重复注册 koffi 具名类型：koffi 对同名 pointer/struct/alias
 * 会抛 "Duplicate type name"，若每次重试都重新注册，重试必然失败并永久降级。
 * @returns 无返回值。
 * @author zhenghq
 */
test('GDI 绑定重试不得重复注册具名类型', () => {
  resetKoffiBindingCacheForTests()
  const now = 2_000_000
  setKoffiBindingClockForTests(() => now)
  try {
    const registered = new Set<string>()
    const fakeHandle = {}
    let failFuncBinding = true
    // 真实环境里 require('koffi') 命中 Node 模块缓存，重试拿到的是同一个实例，
    // 因此具名类型注册表在两次尝试之间是共享的。
    const stub = {
      load: () => ({
        func: (prototype: string) => {
          // 首次绑定在具名类型注册完成之后、绑定 BitBlt 时中断，
          // 这是最接近真实的失败形态：类型已进 koffi 全局注册表。
          if (failFuncBinding && prototype.includes('BitBlt')) {
            throw new Error('首次绑定中断')
          }
          return (...args: unknown[]) => {
            void args
            return fakeHandle
          }
        }
      }),
      pointer: (name: string) => {
        if (registered.has(name)) throw new Error(`Duplicate type name '${name}'`)
        registered.add(name)
        return name
      },
      opaque: () => 'opaque',
      struct: (name: string) => {
        if (registered.has(name)) throw new Error(`Duplicate type name '${name}'`)
        registered.add(name)
        return name
      },
      alias: (name: string) => {
        if (registered.has(name)) throw new Error(`Duplicate type name '${name}'`)
        registered.add(name)
        return name
      },
      as: (value: unknown) => value
    } as KoffiLike

    let attempts = 0
    const loader: KoffiLoader = () => {
      attempts += 1
      // 第二次尝试才放开 BitBlt，模拟用户放行 / DLL 释放后绑定成功。
      if (attempts >= 2) failFuncBinding = false
      return stub
    }

    assert.throws(() => getKoffiGdiCapture(loader), /koffi 绑定加载失败/u)
    setKoffiBindingClockForTests(() => now + KOFFI_BINDING_RETRY_INTERVAL_MS)
    // 重试必须成功：不能因为重复注册 HWND / BITMAPINFO 再次抛 Duplicate type name。
    assert.doesNotThrow(() => getKoffiGdiCapture(loader))
    assert.equal(attempts, 2)
  } finally {
    setKoffiBindingClockForTests(null)
    resetKoffiBindingCacheForTests()
  }
})
