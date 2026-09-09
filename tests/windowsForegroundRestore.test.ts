import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WIN32_FOREGROUND_PROTOTYPES,
  createWindowsForegroundTracker
} from '../src/main/windowsForeground.ts'
import { KOFFI_BUILTIN_TYPE_NAMES } from '../src/main/windowsGdiCapture.ts'

/**
 * 从 Win32 原型字符串中提取全部类型名，用于校验只引用 koffi 内建原语。
 * @param prototype Win32 函数原型字符串。
 * @returns 原型中出现的类型名列表。
 * @author zhenghq
 */
function extractTypeNames(prototype: string): string[] {
  const withoutCall = prototype.replace(/__stdcall/gu, ' ')
  const cleaned = withoutCall.replace(/[()*,]/gu, ' ')
  const tokens = cleaned.split(/\s+/u).filter(Boolean)
  // 去掉函数名与形参名：只保留能在内建类型集合中命中的 token。
  return tokens.filter((token) => KOFFI_BUILTIN_TYPE_NAMES.includes(token as never))
}

/**
 * 校验前台窗口相关原型只使用 koffi 内建类型，避免运行时抛未知类型名。
 * @returns 无返回值。
 * @author zhenghq
 */
test('前台窗口 Win32 原型只能引用 koffi 内建类型', () => {
  const prototypes = Object.values(WIN32_FOREGROUND_PROTOTYPES)
  assert.ok(prototypes.length >= 3, '至少需要 Get/Set/IsWindow 三个原型')
  for (const prototype of prototypes) {
    assert.match(prototype, /__stdcall/u, `原型必须声明 __stdcall: ${prototype}`)
    assert.ok(extractTypeNames(prototype).length > 0, `原型应含内建类型: ${prototype}`)
    assert.doesNotMatch(prototype, /\bHWND\b|\bBOOL\b|\bDWORD\b/u,
      `原型不应引用未注册的 Win32 别名: ${prototype}`)
  }
})

/**
 * 校验非 Windows 平台不加载 FFI，记录与恢复均为安全空操作。
 * @returns 无返回值。
 * @author zhenghq
 */
test('非 Windows 平台前台窗口跟踪应为空操作', () => {
  let loaded = false
  const tracker = createWindowsForegroundTracker({
    platform: 'darwin',
    loadKoffi: () => {
      loaded = true
      throw new Error('不应加载 koffi')
    }
  })
  assert.equal(tracker.remember(), false, '非 Windows 记录应返回 false')
  assert.equal(tracker.restore(), false, '非 Windows 恢复应返回 false')
  assert.equal(loaded, false, '非 Windows 不应加载 koffi')
})

/**
 * 构造 Windows 前台窗口 FFI 桩，便于验证记录与恢复的调用序列。
 * @param handles 依次返回的前台窗口句柄。
 * @returns 桩绑定与调用记录。
 * @author zhenghq
 */
function createBindingsStub(handles: unknown[]): {
  bindings: {
    getForegroundWindow: () => unknown
    setForegroundWindow: (handle: unknown) => boolean
    isWindow: (handle: unknown) => boolean
  }
  setCalls: unknown[]
} {
  const setCalls: unknown[] = []
  let index = 0
  return {
    bindings: {
      getForegroundWindow: () => handles[index++] ?? null,
      setForegroundWindow: (handle: unknown) => {
        setCalls.push(handle)
        return true
      },
      isWindow: (handle: unknown) => Boolean(handle)
    },
    setCalls
  }
}

/**
 * 校验记录当前前台窗口后可原样恢复，取词焦点确定回到源应用。
 * @returns 无返回值。
 * @author zhenghq
 */
test('记录源应用前台窗口后应能精确恢复', () => {
  const sourceWindow = { id: 'source-app' }
  const { bindings, setCalls } = createBindingsStub([sourceWindow])
  const tracker = createWindowsForegroundTracker({ platform: 'win32', bindings })

  assert.equal(tracker.remember(), true, '记录前台窗口应成功')
  assert.equal(tracker.restore(), true, '恢复前台窗口应成功')
  assert.deepEqual(setCalls, [sourceWindow], '必须把焦点交回被记录的源窗口')
})

/**
 * 校验没有记录过窗口时恢复不会误调用 SetForegroundWindow。
 * @returns 无返回值。
 * @author zhenghq
 */
test('未记录窗口时恢复应直接返回 false', () => {
  const { bindings, setCalls } = createBindingsStub([])
  const tracker = createWindowsForegroundTracker({ platform: 'win32', bindings })

  assert.equal(tracker.restore(), false, '无记录时恢复应返回 false')
  assert.deepEqual(setCalls, [], '无记录时不应调用 SetForegroundWindow')
})

/**
 * 校验记录到空句柄时不写入状态，避免把焦点交给无效窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('前台窗口为空时不应记录', () => {
  const { bindings, setCalls } = createBindingsStub([null])
  const tracker = createWindowsForegroundTracker({ platform: 'win32', bindings })

  assert.equal(tracker.remember(), false, '空句柄不应记录成功')
  assert.equal(tracker.restore(), false, '空记录不应恢复')
  assert.deepEqual(setCalls, [], '空记录不应调用 SetForegroundWindow')
})

/**
 * 校验记录的窗口已经关闭时跳过恢复，并清空失效状态。
 * @returns 无返回值。
 * @author zhenghq
 */
test('记录的窗口已关闭时应跳过恢复并清空状态', () => {
  const closedWindow = { id: 'closed' }
  const setCalls: unknown[] = []
  const tracker = createWindowsForegroundTracker({
    platform: 'win32',
    bindings: {
      getForegroundWindow: () => closedWindow,
      setForegroundWindow: (handle: unknown) => {
        setCalls.push(handle)
        return true
      },
      isWindow: () => false
    }
  })

  assert.equal(tracker.remember(), true, '记录时窗口有效应成功')
  assert.equal(tracker.restore(), false, '窗口已关闭应跳过恢复')
  assert.deepEqual(setCalls, [], '窗口已关闭不应调用 SetForegroundWindow')
  assert.equal(tracker.restore(), false, '失效状态应已被清空')
})

/**
 * 校验恢复成功后状态被消费，重复恢复不会把焦点再次抢回旧窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('恢复成功后应消费记录避免重复抢焦点', () => {
  const sourceWindow = { id: 'source-app' }
  const { bindings, setCalls } = createBindingsStub([sourceWindow])
  const tracker = createWindowsForegroundTracker({ platform: 'win32', bindings })

  tracker.remember()
  assert.equal(tracker.restore(), true, '首次恢复应成功')
  assert.equal(tracker.restore(), false, '重复恢复应返回 false')
  assert.equal(setCalls.length, 1, 'SetForegroundWindow 只应调用一次')
})

/**
 * 校验 FFI 绑定加载失败时降级为空操作，不影响取词主流程。
 * @returns 无返回值。
 * @author zhenghq
 */
test('FFI 绑定不可用时应降级为空操作', () => {
  const tracker = createWindowsForegroundTracker({
    platform: 'win32',
    loadKoffi: () => {
      throw new Error('koffi 不可用')
    }
  })
  assert.equal(tracker.remember(), false, '绑定失败时记录应返回 false')
  assert.equal(tracker.restore(), false, '绑定失败时恢复应返回 false')
})
