/**
 * Windows GDI 原生截屏模块（koffi FFI 方案）。
 *
 * 通过 koffi 直接加载 gdi32.dll / user32.dll，在 Node.js 主进程内调用
 * Win32 GDI API（BitBlt + GetDIBits）完成屏幕采集，彻底消除 spawn 进程
 * 与文件 I/O 开销，将截图延迟从 3 秒+降到百毫秒级。
 *
 * 采集流程：
 * 1. SetProcessDpiAwarenessContext(-4) 设置 Per-Monitor DPI awareness
 * 2. GetDC(NULL) 获取屏幕 DC
 * 3. CreateCompatibleDC 创建兼容内存 DC
 * 4. CreateCompatibleBitmap 创建与屏幕兼容的位图
 * 5. SelectObject 选入位图
 * 6. BitBlt 从屏幕 DC 拷贝到内存 DC
 * 7. GetDIBits 以 BGRA 格式提取像素数据
 * 8. 转换 BGRA → RGBA，用 encodePng 编码为 PNG
 *
 * 所有 GDI 句柄用完后立即释放，避免资源泄漏。
 *
 * @author zhenghq
 */

import type { RgbaImage } from '../shared/imagePreprocess'
import type { CaptureBounds } from './screenCapture'
import { ScreenCaptureError } from './screenCapture'
import { encodePng } from './pngCodec'

/** BGRA 像素数据回调签名，用于依赖注入测试。 */
export interface GdiCaptureFn {
  /**
   * 通过 Win32 GDI 采集屏幕指定区域，返回 BGRA 像素数据。
   * @param x 物理屏幕 x 坐标。
   * @param y 物理屏幕 y 坐标。
   * @param width 采集区域宽度（像素）。
   * @param height 采集区域高度（像素）。
   * @returns BGRA 像素数据与尺寸；失败时抛出错误。
   */
  (x: number, y: number, width: number, height: number): Promise<{ data: Uint8Array; width: number; height: number }>
}

/** koffi 模块最小接口，仅覆盖本模块用到的成员，便于测试注入桩实现。 */
export interface KoffiLike {
  /** 加载动态库，返回库句柄。 */
  load(path: string): { func(prototype: string): (...args: unknown[]) => unknown }
  /** 注册命名指针类型。 */
  pointer(name: string, ref: unknown): unknown
  /** 创建不透明类型。 */
  opaque(): unknown
  /** 注册命名结构体类型。 */
  struct(name: string, def: Record<string, string>): unknown
  /** 注册类型别名。 */
  alias(name: string, type: string): unknown
  /** 将值按指定类型做指针转换。 */
  as(value: unknown, type: unknown): unknown
}

/** koffi 模块加载器签名，默认 require('koffi')，测试可注入桩。 */
export type KoffiLoader = () => KoffiLike

/** Windows GDI 截屏可注入依赖，便于单元测试替换 FFI 调用。 */
export interface WindowsGdiCaptureDeps {
  /** 运行平台标识。 */
  platform: NodeJS.Platform
  /** GDI 采集函数，默认由 koffi FFI 实现，测试可注入 mock。 */
  captureGdi?: GdiCaptureFn
  /** koffi 模块加载器，默认 require('koffi')，测试可注入桩以校验绑定契约。 */
  loadKoffi?: KoffiLoader
}

/**
 * 本模块在 koffi 中注册的自定义类型名集合。
 * 原型字符串只允许引用 koffi 内建原语或该集合中的名字；
 * 直接使用未注册的 Win32 别名（如 dword）会让 koffi 在解析原型时抛
 * "Unknown or invalid type name"，导致整个绑定加载失败。
 */
export const REGISTERED_TYPE_NAMES = [
  'HWND',
  'HDC',
  'HBITMAP',
  'HGDIOBJ',
  'BITMAPINFO',
  'DWORD'
] as const

/**
 * koffi 3.x 内建原语类型名集合，用于绑定契约测试校验原型字符串。
 * 与 koffi 文档 "Number types" / "String types" 章节保持一致。
 */
export const KOFFI_BUILTIN_TYPE_NAMES = [
  'void', 'bool', 'char', 'uchar', 'unsigned char',
  'char16', 'char16_t', 'char32', 'char32_t',
  'short', 'ushort', 'unsigned short',
  'int', 'uint', 'unsigned int',
  'long', 'ulong', 'unsigned long',
  'longlong', 'long long', 'ulonglong', 'unsigned long long',
  'int8', 'int8_t', 'uint8', 'uint8_t',
  'int16', 'int16_t', 'uint16', 'uint16_t',
  'int32', 'int32_t', 'uint32', 'uint32_t',
  'int64', 'int64_t', 'uint64', 'uint64_t',
  'intptr', 'intptr_t', 'uintptr', 'uintptr_t',
  'size_t', 'float', 'double', 'float32', 'float64',
  'str', 'str16', 'str32', 'string', 'string16', 'string32',
  'wchar', 'wchar_t'
] as const

/**
 * 本模块声明的全部 Win32 函数原型。
 * 集中导出以便绑定契约测试在非 Windows 环境校验类型名与调用约定，
 * 无需真实加载 koffi 或执行 GDI 调用。
 * @author zhenghq
 */
export const WIN32_PROTOTYPES = {
  SetProcessDpiAwarenessContext: 'bool __stdcall SetProcessDpiAwarenessContext(void *value)',
  SetProcessDPIAware: 'bool __stdcall SetProcessDPIAware()',
  GetDC: 'HDC __stdcall GetDC(HWND hwnd)',
  ReleaseDC: 'int __stdcall ReleaseDC(HWND hwnd, HDC hdc)',
  CreateCompatibleDC: 'HDC __stdcall CreateCompatibleDC(HDC hdc)',
  CreateCompatibleBitmap: 'HBITMAP __stdcall CreateCompatibleBitmap(HDC hdc, int width, int height)',
  SelectObject: 'HGDIOBJ __stdcall SelectObject(HDC hdc, HGDIOBJ obj)',
  DeleteObject: 'bool __stdcall DeleteObject(HGDIOBJ obj)',
  DeleteDC: 'bool __stdcall DeleteDC(HDC hdc)',
  BitBlt:
    'bool __stdcall BitBlt(HDC hdcDest, int xDest, int yDest, int width, int height, HDC hdcSrc, int xSrc, int ySrc, DWORD rop)',
  GetDIBits:
    'int __stdcall GetDIBits(HDC hdc, HBITMAP hbm, uint start, uint cLines, void *lpvBits, BITMAPINFO *lpbi, uint usage)'
} as const

/** BITMAPINFOHEADER 字段定义（40 字节，32bpp BI_RGB 无调色板）。 */
export const BITMAPINFO_FIELDS: Record<string, string> = {
  biSize: 'uint32',
  biWidth: 'int32',
  biHeight: 'int32',
  biPlanes: 'uint16',
  biBitCount: 'uint16',
  biCompression: 'uint32',
  biSizeImage: 'uint32',
  biXPelsPerMeter: 'int32',
  biYPelsPerMeter: 'int32',
  biClrUsed: 'uint32',
  biClrImportant: 'uint32'
}

/** koffi 模块惰性加载状态。 */
let koffiModule: GdiCaptureFn | null = null

/** koffi 加载失败错误信息。 */
let koffiLoadError: string | null = null

/**
 * 重置 koffi 绑定缓存，仅供测试使用。
 * 生产代码不调用：加载失败在进程内是终态，避免每次截图重复付出失败代价。
 * @returns 无返回值。
 * @author zhenghq
 */
export function resetKoffiBindingCacheForTests(): void {
  koffiModule = null
  koffiLoadError = null
}

/**
 * 构造 GetDIBits 所需的 BITMAPINFO 值。
 * biHeight 取负值表示 top-down DIB，保证行序从上到下、通道顺序为 BGRA。
 * @param width 图像宽度（像素）。
 * @param height 图像高度（像素）。
 * @returns BITMAPINFO 字段值对象。
 * @author zhenghq
 */
export function buildBitmapInfo(width: number, height: number): Record<string, number> {
  return {
    biSize: 40,
    biWidth: width,
    biHeight: -height,
    biPlanes: 1,
    biBitCount: 32,
    biCompression: 0,
    biSizeImage: width * height * 4,
    biXPelsPerMeter: 0,
    biYPelsPerMeter: 0,
    biClrUsed: 0,
    biClrImportant: 0
  }
}

/**
 * 惰性加载 koffi FFI 模块，返回 GDI 采集函数。
 * 首次调用时加载 koffi 并绑定 Win32 API；后续调用直接返回缓存的函数。
 * 加载失败时记录错误，后续调用不再重试（修复绑定后需重启进程才生效）。
 * @param loadKoffi koffi 模块加载器，默认 require('koffi')。
 * @returns GDI 采集函数。
 * @author zhenghq
 */
export function getKoffiGdiCapture(loadKoffi?: KoffiLoader): GdiCaptureFn {
  if (koffiModule) return koffiModule
  if (koffiLoadError) throw new Error(koffiLoadError)
  try {
    const koffi = loadKoffi
      ? loadKoffi()
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      : (require('koffi') as KoffiLike)
    const user32 = koffi.load('user32.dll')
    const gdi32 = koffi.load('gdi32.dll')

    // ---- 类型注册 ----
    // 句柄注册为具名不透明指针；DWORD 必须显式 alias，koffi 不预置 Win32 别名。
    koffi.pointer('HWND', koffi.opaque())
    koffi.pointer('HDC', koffi.opaque())
    koffi.pointer('HBITMAP', koffi.opaque())
    koffi.pointer('HGDIOBJ', koffi.opaque())
    koffi.alias('DWORD', 'uint32_t')
    koffi.struct('BITMAPINFO', BITMAPINFO_FIELDS)

    // ---- user32 函数 ----
    const SetProcessDpiAwarenessContext = user32.func(WIN32_PROTOTYPES.SetProcessDpiAwarenessContext)
    const SetProcessDPIAware = user32.func(WIN32_PROTOTYPES.SetProcessDPIAware)
    const GetDC = user32.func(WIN32_PROTOTYPES.GetDC)
    const ReleaseDC = user32.func(WIN32_PROTOTYPES.ReleaseDC)

    // ---- gdi32 函数 ----
    const CreateCompatibleDC = gdi32.func(WIN32_PROTOTYPES.CreateCompatibleDC)
    const CreateCompatibleBitmap = gdi32.func(WIN32_PROTOTYPES.CreateCompatibleBitmap)
    const SelectObject = gdi32.func(WIN32_PROTOTYPES.SelectObject)
    const DeleteObject = gdi32.func(WIN32_PROTOTYPES.DeleteObject)
    const DeleteDC = gdi32.func(WIN32_PROTOTYPES.DeleteDC)
    const BitBlt = gdi32.func(WIN32_PROTOTYPES.BitBlt)
    const GetDIBits = gdi32.func(WIN32_PROTOTYPES.GetDIBits)

    // DPI awareness 只需设置一次（进程级别）。
    // -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2，旧系统回退 SetProcessDPIAware。
    const PER_MONITOR_DPI_AWARE = koffi.as(-4, koffi.pointer('DPI_AWARENESS_CONTEXT', koffi.opaque()))
    if (!SetProcessDpiAwarenessContext(PER_MONITOR_DPI_AWARE)) {
      SetProcessDPIAware()
    }

    /**
     * 通过 GDI BitBlt + GetDIBits 采集屏幕指定区域的 BGRA 像素数据。
     * 所有句柄用完后释放，避免 GDI 泄漏。
     * @param x 物理屏幕 x 坐标。
     * @param y 物理屏幕 y 坐标。
     * @param width 采集宽度（像素）。
     * @param height 采集高度（像素）。
     * @returns BGRA 像素数据与尺寸。
     * @author zhenghq
     */
    koffiModule = async function captureGdi(
      x: number, y: number, width: number, height: number
    ): Promise<{ data: Uint8Array; width: number; height: number }> {
      const hdcScreen = GetDC(null)
      if (!hdcScreen) {
        throw new Error('GetDC 失败：无法获取屏幕设备上下文')
      }
      const hdcMem = CreateCompatibleDC(hdcScreen)
      if (!hdcMem) {
        ReleaseDC(null, hdcScreen)
        throw new Error('CreateCompatibleDC 失败')
      }
      const hBitmap = CreateCompatibleBitmap(hdcScreen, width, height)
      if (!hBitmap) {
        DeleteDC(hdcMem)
        ReleaseDC(null, hdcScreen)
        throw new Error('CreateCompatibleBitmap 失败')
      }
      const hOld = SelectObject(hdcMem, hBitmap)

      // SRCCOPY = 0x00CC0020
      const SRCCOPY = 0x00CC0020
      const ok = BitBlt(hdcMem, 0, 0, width, height, hdcScreen, x, y, SRCCOPY)
      if (!ok) {
        SelectObject(hdcMem, hOld)
        DeleteObject(hBitmap)
        DeleteDC(hdcMem)
        ReleaseDC(null, hdcScreen)
        throw new Error('BitBlt 失败')
      }

      // BITMAPINFO 以 JS 对象按结构体指针传入，由 koffi 负责编组；
      // GDI 调用返回后不再持有该指针，无需 koffi.alloc 提供稳定地址。
      const bi = buildBitmapInfo(width, height)
      const pixels = Buffer.alloc(width * height * 4)

      // DIB_RGB_COLORS = 0
      const scanLines = GetDIBits(hdcMem, hBitmap, 0, height, pixels, bi, 0) as number

      // 释放所有 GDI 资源
      SelectObject(hdcMem, hOld)
      DeleteObject(hBitmap)
      DeleteDC(hdcMem)
      ReleaseDC(null, hdcScreen)

      if (!scanLines) {
        throw new Error('GetDIBits 失败：无法获取像素数据')
      }

      return { data: new Uint8Array(pixels), width, height }
    }

    return koffiModule
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    koffiLoadError = `koffi 绑定加载失败（进程内不再重试，修复后需重启应用）: ${detail}`
    throw new Error(koffiLoadError)
  }
}

/**
 * 将 BGRA 像素数据转换为 RGBA。
 * Win32 GetDIBits 返回的 32 位位图格式为 BGRA（蓝-绿-红-alpha），
 * 需要交换 B 和 R 通道以匹配 RgbaImage 要求的 RGBA 顺序。
 * @param bgra BGRA 像素数据。
 * @param width 图像宽度。
 * @param height 图像高度。
 * @returns RGBA 图像。
 * @author zhenghq
 */
export function bgraToRgba(bgra: Uint8Array, width: number, height: number): RgbaImage {
  const rgba = new Uint8Array(bgra.length)
  for (let i = 0; i < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2]     // R ← B
    rgba[i + 1] = bgra[i + 1] // G
    rgba[i + 2] = bgra[i]     // B ← R
    rgba[i + 3] = 0xff        // A = 255（不透明）
  }
  return { width, height, data: rgba }
}

/**
 * 通过 koffi FFI 直接调用 Win32 GDI API 采集屏幕区域为 PNG。
 *
 * 与旧方案（spawn PowerShell / spawn C# helper exe）相比：
 * - 零进程启动开销（无需 spawn 任何外部进程）
 * - 零文件 I/O（直接内存中获取像素 → encodePng → 返回 Buffer）
 * - 延迟从 3 秒+降到 ~50-100ms
 *
 * @param displayBounds 目标显示器矩形（虚拟屏幕坐标）。
 * @param scaleFactor 目标显示器缩放因子。
 * @param deps 可注入依赖（测试用）。
 * @returns PNG 图片字节。
 * @author zhenghq
 */
export async function captureWindowsRegionAsPngGdi(
  displayBounds: CaptureBounds,
  scaleFactor: number,
  deps: WindowsGdiCaptureDeps
): Promise<Buffer> {
  if (deps.platform !== 'win32') {
    throw new ScreenCaptureError('no-source', '仅 Windows 支持 GDI 原生截屏')
  }
  const scale = scaleFactor || 1
  const x = Math.round(displayBounds.x * scale)
  const y = Math.round(displayBounds.y * scale)
  const width = Math.max(1, Math.round(displayBounds.width * scale))
  const height = Math.max(1, Math.round(displayBounds.height * scale))

  try {
    const captureFn = deps.captureGdi ?? getKoffiGdiCapture(deps.loadKoffi)
    const { data, width: imgW, height: imgH } = await captureFn(x, y, width, height)
    const rgba = bgraToRgba(data, imgW, imgH)
    return encodePng(rgba)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ScreenCaptureError('no-source', `GDI 截屏失败: ${message}`)
  }
}

/** GDI 原生采集成功时的来源标识。 */
export const WINDOWS_GDI_CAPTURE_SOURCE = 'windows-gdi-copyscreen'

/** GDI 失败后回退到 PowerShell / helper exe 时的来源标识。 */
export const WINDOWS_GDI_FALLBACK_SOURCE = 'windows-gdi-fallback-powershell'

/** Windows OCR 采集优先 GDI、失败回退时可注入的依赖。 */
export interface WindowsOcrPreferGdiDeps extends WindowsGdiCaptureDeps {
  /**
   * GDI 失败后的回退采集函数，通常指向 captureWindowsRegionAsPng。
   * @param displayBounds 目标显示器矩形。
   * @param scaleFactor 显示器缩放因子。
   * @returns PNG 图片字节。
   */
  captureFallback(displayBounds: CaptureBounds, scaleFactor: number): Promise<Buffer>
  /**
   * GDI 失败时的诊断回调，用于记录降级原因。
   * @param message GDI 失败详情。
   * @returns 无返回值。
   */
  onGdiFailure?(message: string): void
}

/**
 * 优先走 koffi GDI 原生截屏；绑定或采集失败时回退 PowerShell / helper exe。
 * 两条路径都失败时归类为 no-source，错误信息同时包含两侧原因。
 * @param displayBounds 目标显示器矩形（虚拟屏幕坐标）。
 * @param scaleFactor 目标显示器缩放因子。
 * @param deps 可注入依赖（测试用）。
 * @returns PNG 字节与采集来源标识。
 * @author zhenghq
 */
export async function captureWindowsOcrPngPreferGdi(
  displayBounds: CaptureBounds,
  scaleFactor: number,
  deps: WindowsOcrPreferGdiDeps
): Promise<{ png: Buffer; source: string }> {
  try {
    const png = await captureWindowsRegionAsPngGdi(displayBounds, scaleFactor, deps)
    return { png, source: WINDOWS_GDI_CAPTURE_SOURCE }
  } catch (gdiError) {
    const gdiMessage = gdiError instanceof Error ? gdiError.message : String(gdiError)
    deps.onGdiFailure?.(gdiMessage)
    try {
      const png = await deps.captureFallback(displayBounds, scaleFactor)
      return { png, source: WINDOWS_GDI_FALLBACK_SOURCE }
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      throw new ScreenCaptureError(
        'no-source',
        `无法获取屏幕截图: GDI 失败（${gdiMessage}）；回退失败（${fallbackMessage}）`
      )
    }
  }
}
