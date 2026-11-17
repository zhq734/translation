import type { ScreenshotWindowCandidate } from '../shared/screenshotWindowSelection'

/** 原生窗口句柄以指针宽度整数表示，不读取任何标题。 */
export type WindowsScreenshotHandle = number | bigint
/** Win32 RECT 使用物理像素坐标。 */
export interface WindowsScreenshotRect { left: number; top: number; right: number; bottom: number }
/** 全局屏幕坐标点。 */
type Point = { x: number; y: number }
/** 显示器边界为 Electron DIP，而非物理像素。 */
type Display = { bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number }

/** 原生枚举的可注入接口；DWM 方法可缺省，兼容 Win7。 */
export interface WindowsScreenshotBindings {
  /** 按从前到后顺序调用回调；参数为窗口回调，返回枚举是否完整成功。@author zhenghq */
  enumWindows(callback: (handle: WindowsScreenshotHandle) => boolean): boolean
  /** 查询句柄对应窗口的可见状态；参数为句柄，返回是否可见。@author zhenghq */
  isWindowVisible(handle: WindowsScreenshotHandle): boolean
  /** 查询句柄对应窗口的最小化状态；参数为句柄，返回是否最小化。@author zhenghq */
  isIconic(handle: WindowsScreenshotHandle): boolean
  /** 查询窗口隐藏状态；参数为句柄，返回是否 cloaked，不支持时返回 false。@author zhenghq */
  isWindowCloaked?(handle: WindowsScreenshotHandle): boolean
  /** 查询 DWM 可见物理边界；参数为句柄，返回 RECT 或失败时 null。@author zhenghq */
  getDwmWindowBounds?(handle: WindowsScreenshotHandle): WindowsScreenshotRect | null
  /** 查询常规物理边界；参数为句柄，返回 RECT 或失败时 null。@author zhenghq */
  getWindowRect(handle: WindowsScreenshotHandle): WindowsScreenshotRect | null
}

/** 仅声明所需 koffi 接口，避免模块导入时加载 native。 */
export interface WindowsScreenshotKoffi {
  /** 加载 DLL；参数为路径，返回可绑定函数的库对象。@author zhenghq */
  load(path: string): {
    /** 创建原生函数；参数为约定、名称、返回类型和参数类型，返回调用函数。@author zhenghq */
    func(convention: string, name: string, result: unknown, args: unknown[]): (...values: unknown[]) => unknown
  }
  /** 创建匿名结构体；参数为字段定义，返回类型对象。@author zhenghq */
  struct(definition: Record<string, string>): unknown
  /** 创建指针类型；参数为目标类型，返回指针类型。@author zhenghq */
  pointer(type: unknown): unknown
  /** 标记输出参数；参数为指针类型，返回方向标记。@author zhenghq */
  out(type: unknown): unknown
  /** 创建匿名回调原型；参数为约定、返回类型和参数类型，返回回调类型。@author zhenghq */
  proto(convention: string, result: string, args: string[]): unknown
}

/** 枚举选项；生产调用不需要传平台，测试可注入 Windows 平台与绑定。 */
export interface WindowsScreenshotOptions {
  displays: Display[]
  /** 当前截图屏幕的 DIP 与物理边界，跨屏窗口先裁剪物理交集再按同一缩放转换。 */
  targetDisplay?: Display & { physicalBounds: Display['bounds'] }
  /** 将物理屏幕点转为全局 DIP；参数为物理点，返回 DIP 点。@author zhenghq */
  screenToDipPoint?: (point: Point) => Point
  bindings?: WindowsScreenshotBindings
  /** 惰性加载 koffi；无参数，返回 koffi 最小接口。@author zhenghq */
  loadKoffi?: () => WindowsScreenshotKoffi
  excludedWindowIds?: Iterable<string>
  platform?: NodeJS.Platform
}

/**
 * 惰性绑定 Win32 API，DWM 加载或符号失败不影响 user32 回退。
 * @param loadKoffi 可注入的 koffi 加载器。
 * @returns 原生绑定，失败时返回 null；不读取或记录窗口标题。
 * @author zhenghq
 */
function loadBindings(loadKoffi?: WindowsScreenshotOptions['loadKoffi']): WindowsScreenshotBindings | null {
  try {
    // 仅在 Windows 枚举入口通过平台检查后执行，模块导入本身不加载 DLL。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = loadKoffi ? loadKoffi() : require('koffi') as WindowsScreenshotKoffi
    const user32 = koffi.load('user32.dll')
    // 匿名类型不会与 GDI 模块或再次枚举注册的类型重名。
    const rectType = koffi.struct({ left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
    const outRect = koffi.out(koffi.pointer(rectType))
    const enumProc = koffi.proto('__stdcall', 'int', ['uintptr', 'intptr'])
    const EnumWindows = user32.func('__stdcall', 'EnumWindows', 'int', [koffi.pointer(enumProc), 'intptr'])
    const IsWindowVisible = user32.func('__stdcall', 'IsWindowVisible', 'int', ['uintptr'])
    const IsIconic = user32.func('__stdcall', 'IsIconic', 'int', ['uintptr'])
    const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'int', ['uintptr', outRect])
    let dwmBounds: ((...args: unknown[]) => unknown) | undefined
    let dwmCloaked: ((...args: unknown[]) => unknown) | undefined
    try {
      const dwm = koffi.load('dwmapi.dll')
      // 分别声明输出类型，避免 void* 丢失 RECT/BOOL 的解码方向和大小。
      dwmBounds = dwm.func('__stdcall', 'DwmGetWindowAttribute', 'int32', ['uintptr', 'uint32', outRect, 'uint32'])
      dwmCloaked = dwm.func('__stdcall', 'DwmGetWindowAttribute', 'int32', [
        'uintptr', 'uint32', koffi.out(koffi.pointer('uint32')), 'uint32'
      ])
    } catch {
      // Win7、DWM 禁用或缺失导出时仍使用 GetWindowRect。
    }
    return {
      /** 枚举全部顶层窗口；参数为回调，返回 Win32 枚举成功状态。@author zhenghq */
      enumWindows(callback) {
        /** 把 JS 布尔返回值转换为 Win32 BOOL；参数为句柄，返回是否继续。@author zhenghq */
        const onWindow = (handle: WindowsScreenshotHandle): number => callback(handle) ? 1 : 0
        // 同步 EnumWindows 只在调用期间使用回调，koffi 自动释放瞬态回调槽。
        return Boolean(EnumWindows(onWindow, 0))
      },
      /** 查询可见状态；参数为句柄，返回可见布尔值。@author zhenghq */
      isWindowVisible(handle) { return Boolean(IsWindowVisible(handle)) },
      /** 查询最小化状态；参数为句柄，返回最小化布尔值。@author zhenghq */
      isIconic(handle) { return Boolean(IsIconic(handle)) },
      /** 查询 DWM 隐藏状态；参数为句柄，返回隐藏状态，不支持则 false。@author zhenghq */
      isWindowCloaked(handle) {
        if (!dwmCloaked) return false
        const cloaked = [0]
        return dwmCloaked(handle, 14, cloaked, 4) === 0 && cloaked[0] !== 0
      },
      /** 查询可见边界；参数为句柄，返回 DWM RECT，失败则 null。@author zhenghq */
      getDwmWindowBounds(handle) {
        if (!dwmBounds) return null
        const rect = { left: 0, top: 0, right: 0, bottom: 0 }
        return dwmBounds(handle, 9, rect, 16) === 0 ? rect : null
      },
      /** 查询窗口边界；参数为句柄，返回常规 RECT，失败则 null。@author zhenghq */
      getWindowRect(handle) {
        const rect = { left: 0, top: 0, right: 0, bottom: 0 }
        return GetWindowRect(handle, rect) ? rect : null
      }
    }
  } catch {
    return null
  }
}

/**
 * 校验物理 RECT 是否有限且有面积。
 * @param rect 可能缺失或失效的边界。
 * @returns 是否可以继续转换。
 * @author zhenghq
 */
function validRect(rect: WindowsScreenshotRect | null | undefined): rect is WindowsScreenshotRect {
  return !!rect && [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)
    && rect.right > rect.left && rect.bottom > rect.top
}

/**
 * 根据相接或边缘对齐的 DIP 显示器推导某个轴的物理原点。
 * @param displays 有效显示器列表。
 * @param axis 要转换的坐标轴。
 * @returns 与显示器顺序对应的物理原点；无法推导的布局按自身比例近似。
 * @author zhenghq
 */
function physicalOrigins(displays: Display[], axis: 'x' | 'y'): number[] {
  const size = axis === 'x' ? 'width' : 'height'
  const origins: Array<number | undefined> = displays.map((display) => display.bounds[axis] === 0 ? 0 : undefined)
  for (let pass = 0; pass < displays.length; pass++) {
    for (let index = 0; index < displays.length; index++) {
      if (origins[index] !== undefined) continue
      const current = displays[index]
      const start = current.bounds[axis]
      const end = start + current.bounds[size]
      for (let neighbour = 0; neighbour < displays.length; neighbour++) {
        const origin = origins[neighbour]
        if (origin === undefined) continue
        const other = displays[neighbour]
        const otherStart = other.bounds[axis]
        const otherEnd = otherStart + other.bounds[size]
        if (start === otherStart) origins[index] = origin
        else if (start === otherEnd) origins[index] = origin + other.bounds[size] * other.scaleFactor
        else if (end === otherStart) origins[index] = origin - current.bounds[size] * current.scaleFactor
        else if (end === otherEnd) origins[index] = origin + other.bounds[size] * other.scaleFactor - current.bounds[size] * current.scaleFactor
        if (origins[index] !== undefined) break
      }
    }
  }
  return origins.map((origin, index) => origin ?? displays[index].bounds[axis] * displays[index].scaleFactor)
}

/**
 * 创建物理屏幕点到全局 DIP 的转换，优先使用 Electron 的真实混合 DPI 映射。
 * @param options 显示器和可注入转换函数。
 * @returns 转换函数，缺少可用显示器时返回 null。
 * @author zhenghq
 */
function pointConverter(options: WindowsScreenshotOptions): ((point: Point) => Point) | null {
  if (options.targetDisplay) {
    const { bounds, physicalBounds, scaleFactor } = options.targetDisplay
    return (point) => ({ x: bounds.x + (point.x - physicalBounds.x) / scaleFactor,
      y: bounds.y + (point.y - physicalBounds.y) / scaleFactor })
  }
  if (options.screenToDipPoint) return options.screenToDipPoint
  const displays = options.displays.filter(({ bounds, scaleFactor }) =>
    [bounds.x, bounds.y, bounds.width, bounds.height, scaleFactor].every(Number.isFinite)
    && bounds.width > 0 && bounds.height > 0 && scaleFactor > 0)
  if (displays.length === 0) return null
  const xs = physicalOrigins(displays, 'x')
  const ys = physicalOrigins(displays, 'y')
  /**
   * 以最近显示器的物理原点转换点，不再按主屏缩放全局坐标。
   * @param point 物理坐标；窗口越界时使用最近显示器作外推。
   * @returns 全局 DIP 坐标。
   * @author zhenghq
   */
  return (point: Point): Point => {
    let nearest = 0
    let distance = Infinity
    for (let index = 0; index < displays.length; index++) {
      const display = displays[index]
      const dx = Math.max(xs[index] - point.x, 0, point.x - xs[index] - display.bounds.width * display.scaleFactor)
      const dy = Math.max(ys[index] - point.y, 0, point.y - ys[index] - display.bounds.height * display.scaleFactor)
      const squared = dx * dx + dy * dy
      if (squared < distance) { nearest = index; distance = squared }
    }
    const { bounds, scaleFactor } = displays[nearest]
    // 显示器信息不足以唯一推导任意混合 DPI 排列；生产必须注入 screenToDipPoint。
    return { x: bounds.x + (point.x - xs[nearest]) / scaleFactor, y: bounds.y + (point.y - ys[nearest]) / scaleFactor }
  }
}

/**
 * 枚举用于截图吸附的窗口，返回从前到后排列的全局 DIP 候选。
 * @param options 显示器、坐标转换、排除列表及可注入原生绑定。
 * @returns 当前有效窗口列表；不支持的平台或原生失败时返回空列表。
 * @author zhenghq
 */
export async function enumerateWindowsScreenshotWindows(
  options: WindowsScreenshotOptions
): Promise<ScreenshotWindowCandidate[]> {
  if ((options.platform ?? process.platform) !== 'win32') return []
  try {
    const convert = pointConverter(options)
    if (!convert) return []
    const bindings = options.bindings ?? loadBindings(options.loadKoffi)
    if (!bindings) return []
    const excluded = new Set(options.excludedWindowIds)
    const candidates: ScreenshotWindowCandidate[] = []
    let nextZOrder = 0
    /**
     * 收集一个有效窗口；局部异常只跳过该窗口，不中止剩余枚举。
     * @param handle 原生窗口句柄。
     * @returns 始终继续枚举。
     * @author zhenghq
     */
    const collect = (handle: WindowsScreenshotHandle): boolean => {
      const zOrder = nextZOrder++
      try {
        const id = String(handle)
        if (!handle || excluded.has(id) || !bindings.isWindowVisible(handle) || bindings.isIconic(handle)) return true
        try { if (bindings.isWindowCloaked?.(handle)) return true } catch { /* Win7 不支持该属性。 */ }
        let rect: WindowsScreenshotRect | null | undefined
        try { rect = bindings.getDwmWindowBounds?.(handle) } catch { /* DWM 不可用，继续回退。 */ }
        if (!validRect(rect)) rect = bindings.getWindowRect(handle)
        if (!validRect(rect)) return true
        if (options.targetDisplay) {
          const physical = options.targetDisplay.physicalBounds
          rect = { left: Math.max(rect.left, physical.x), top: Math.max(rect.top, physical.y),
            right: Math.min(rect.right, physical.x + physical.width), bottom: Math.min(rect.bottom, physical.y + physical.height) }
          if (!validRect(rect)) return true
        }
        // 每个物理端点只转换一次；保持全局 DIP，裁剪和局部化由共享模块负责。
        const start = convert({ x: rect.left, y: rect.top })
        const end = convert({ x: rect.right, y: rect.bottom })
        const bounds = { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y }
        if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return true
        candidates.push({ id, appName: '', bounds, zOrder })
      } catch {
        // 窗口可能在枚举过程中销毁，不记录原生异常或用户信息。
      }
      return true
    }
    return bindings.enumWindows(collect) ? candidates : []
  } catch {
    return []
  }
}
