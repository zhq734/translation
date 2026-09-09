/**
 * Windows 前台窗口跟踪模块（koffi FFI 方案）。
 *
 * 取词依赖「前台窗口就是源应用」这一前提：WM_COPY 发给焦点控件，
 * 注入的 Ctrl+C 也落在前台窗口上。翻译结果到达时弹窗被 win.show() 激活，
 * 弹窗自己变成前台窗口，此后再次按快捷键取词就会打在弹窗上而取不到词。
 *
 * Chromium 的 win.blur() 只是放弃焦点，由系统按 Z-order 启发式挑选下一个
 * 前台窗口，不保证回到源应用。这里在弹窗激活前记录源应用的 HWND，
 * 取词前用 SetForegroundWindow 精确交还，让取词目标可确定。
 *
 * 所有 FFI 调用失败都降级为空操作，绝不阻断取词主流程。
 *
 * @author zhenghq
 */

import type { KoffiLike, KoffiLoader } from './windowsGdiCapture'

/**
 * 本模块声明的 Win32 函数原型。
 * 句柄统一用 koffi 内建的 void * 表达，避免依赖 windowsGdiCapture 中
 * 注册的具名类型（重复注册同名类型会让 koffi 抛错）。
 */
export const WIN32_FOREGROUND_PROTOTYPES = {
  GetForegroundWindow: 'void * __stdcall GetForegroundWindow()',
  SetForegroundWindow: 'bool __stdcall SetForegroundWindow(void *hwnd)',
  IsWindow: 'bool __stdcall IsWindow(void *hwnd)'
} as const

/** 前台窗口 FFI 绑定最小接口，便于单元测试注入桩实现。 */
export interface WindowsForegroundBindings {
  /** 返回当前前台窗口句柄；无前台窗口时返回空值。 */
  getForegroundWindow: () => unknown
  /** 把指定窗口设为前台窗口。 */
  setForegroundWindow: (handle: unknown) => boolean
  /** 判断窗口句柄是否仍然有效。 */
  isWindow: (handle: unknown) => boolean
}

/** 前台窗口跟踪器构造选项。 */
export interface WindowsForegroundTrackerOptions {
  /** 运行平台标识。 */
  platform: NodeJS.Platform
  /** 直接注入的 FFI 绑定，测试用；省略时惰性加载 koffi。 */
  bindings?: WindowsForegroundBindings
  /** koffi 模块加载器，默认 require('koffi')。 */
  loadKoffi?: KoffiLoader
}

/** 前台窗口跟踪器：记录源应用窗口并在取词前精确交还焦点。 */
export interface WindowsForegroundTracker {
  /**
   * 记录当前前台窗口，供随后恢复。
   * @returns 成功记录到有效窗口时返回 true。
   */
  remember: () => boolean
  /**
   * 把焦点交还给已记录的窗口，并消费该记录。
   * @returns 成功交还时返回 true。
   */
  restore: () => boolean
}

/**
 * 惰性加载 koffi 并绑定前台窗口相关的 user32 函数。
 * @param loadKoffi koffi 模块加载器，默认 require('koffi')。
 * @returns 绑定成功时返回绑定集合；加载或绑定失败时返回 null。
 * @author zhenghq
 */
function loadForegroundBindings(loadKoffi?: KoffiLoader): WindowsForegroundBindings | null {
  try {
    const koffi = loadKoffi
      ? loadKoffi()
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      : (require('koffi') as KoffiLike)
    const user32 = koffi.load('user32.dll')
    const GetForegroundWindow = user32.func(WIN32_FOREGROUND_PROTOTYPES.GetForegroundWindow)
    const SetForegroundWindow = user32.func(WIN32_FOREGROUND_PROTOTYPES.SetForegroundWindow)
    const IsWindow = user32.func(WIN32_FOREGROUND_PROTOTYPES.IsWindow)
    return {
      getForegroundWindow: () => GetForegroundWindow(),
      setForegroundWindow: (handle) => Boolean(SetForegroundWindow(handle)),
      isWindow: (handle) => Boolean(IsWindow(handle))
    }
  } catch (error) {
    console.warn(
      `[foreground] user32 绑定不可用，跳过前台焦点恢复: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return null
  }
}

/**
 * 创建 Windows 前台窗口跟踪器；非 Windows 平台返回空操作实现。
 * @param options 构造选项，可注入平台、FFI 绑定与 koffi 加载器。
 * @returns 前台窗口跟踪器。
 * @author zhenghq
 */
export function createWindowsForegroundTracker(
  options: WindowsForegroundTrackerOptions
): WindowsForegroundTracker {
  if (options.platform !== 'win32') {
    return { remember: () => false, restore: () => false }
  }

  let bindings: WindowsForegroundBindings | null | undefined = options.bindings
  let bindingFailed = false
  let rememberedWindow: unknown = null

  /**
   * 获取 FFI 绑定，首次调用时惰性加载；加载失败后不再重试。
   * @returns 可用的绑定；不可用时返回 null。
   * @author zhenghq
   */
  const ensureBindings = (): WindowsForegroundBindings | null => {
    if (bindings) return bindings
    if (bindingFailed) return null
    bindings = loadForegroundBindings(options.loadKoffi)
    if (!bindings) bindingFailed = true
    return bindings
  }

  return {
    /**
     * 记录当前前台窗口，弹窗激活前调用。
     * @returns 成功记录到有效窗口时返回 true。
     * @author zhenghq
     */
    remember(): boolean {
      const api = ensureBindings()
      if (!api) return false
      try {
        const handle = api.getForegroundWindow()
        if (!handle) return false
        rememberedWindow = handle
        return true
      } catch {
        return false
      }
    },

    /**
     * 把焦点交还给记录的源应用窗口，并清空记录避免重复抢焦点。
     * @returns 成功交还时返回 true。
     * @author zhenghq
     */
    restore(): boolean {
      const handle = rememberedWindow
      rememberedWindow = null
      if (!handle) return false
      const api = ensureBindings()
      if (!api) return false
      try {
        // 窗口可能在翻译期间被用户关闭，交还前先校验句柄仍有效。
        if (!api.isWindow(handle)) return false
        return api.setForegroundWindow(handle)
      } catch {
        return false
      }
    }
  }
}
