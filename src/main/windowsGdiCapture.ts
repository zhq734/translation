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

/** Windows GDI 截屏可注入依赖，便于单元测试替换 FFI 调用。 */
export interface WindowsGdiCaptureDeps {
  /** 运行平台标识。 */
  platform: NodeJS.Platform
  /** GDI 采集函数，默认由 koffi FFI 实现，测试可注入 mock。 */
  captureGdi?: GdiCaptureFn
}

/** koffi 模块惰性加载状态。 */
let koffiModule: GdiCaptureFn | null = null

/** koffi 加载失败错误信息。 */
let koffiLoadError: string | null = null

/**
 * 惰性加载 koffi FFI 模块，返回 GDI 采集函数。
 * 首次调用时加载 koffi 并绑定 Win32 API；后续调用直接返回缓存的函数。
 * 加载失败时记录错误，后续调用不再重试。
 * @returns GDI 采集函数。
 * @author zhenghq
 */
function getKoffiGdiCapture(): GdiCaptureFn {
  if (koffiModule) return koffiModule
  if (koffiLoadError) throw new Error(koffiLoadError)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    const gdi32 = koffi.load('gdi32.dll')

    // ---- 类型定义 ----
    const HWND = koffi.pointer('HWND', koffi.opaque())
    const HDC = koffi.pointer('HDC', koffi.opaque())
    const HBITMAP = koffi.pointer('HBITMAP', koffi.opaque())
    const HGDIOBJ = koffi.pointer('HGDIOBJ', koffi.opaque())

    // ---- user32 函数 ----
    const SetProcessDpiAwarenessContext = user32.func(
      'bool SetProcessDpiAwarenessContext(void *value)'
    )
    const SetProcessDPIAware = user32.func('bool SetProcessDPIAware()')
    const GetDC = user32.func('HDC GetDC(HWND hwnd)')
    const ReleaseDC = user32.func('int ReleaseDC(HWND hwnd, HDC hdc)')

    // ---- gdi32 函数 ----
    const CreateCompatibleDC = gdi32.func('HDC CreateCompatibleDC(HDC hdc)')
    const CreateCompatibleBitmap = gdi32.func('HBITMAP CreateCompatibleBitmap(HDC hdc, int width, int height)')
    const SelectObject = gdi32.func('HGDIOBJ SelectObject(HDC hdc, HGDIOBJ obj)')
    const DeleteObject = gdi32.func('bool DeleteObject(HGDIOBJ obj)')
    const DeleteDC = gdi32.func('bool DeleteDC(HDC hdc)')
    const BitBlt = gdi32.func(
      'bool BitBlt(HDC hdcDest, int xDest, int yDest, int width, int height, HDC hdcSrc, int xSrc, int ySrc, dword rop)'
    )
    const GetDIBits = gdi32.func(
      'int GetDIBits(HDC hdc, HBITMAP hbm, uint start, uint cLines, void *lpvBits, void *lpbi, uint usage)'
    )

    // BITMAPINFO 结构（40 字节头部 + 不含色彩表）
    const BITMAPINFO = koffi.struct('BITMAPINFO', {
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
    })

    // DPI awareness 只需设置一次（进程级别）
    const PER_MONITOR_DPI_AWARE = koffi.as(-4, koffi.pointer('void'))
    SetProcessDpiAwarenessContext(PER_MONITOR_DPI_AWARE) || SetProcessDPIAware()

    /**
     * 通过 GDI BitBlt + GetDIBits 采集屏幕指定区域的 BGRA 像素数据。
     * 所有句柄用完后释放，避免 GDI 泄漏。
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

      // 构造 BITMAPINFO，biHeight 为负数表示 top-down DIB（BGRA 顺序）
      const bi = {
        biSize: 40,
        biWidth: width,
        biHeight: -height, // 负值 = top-down，行序从上到下
        biPlanes: 1,
        biBitCount: 32,
        biCompression: 0, // BI_RGB
        biSizeImage: width * height * 4,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0
      }
      const bufSize = width * height * 4
      const pixels = Buffer.alloc(bufSize)
      const info = koffi.alloc(BITMAPINFO)
      koffi.write(info, bi)

      const result = GetDIBits(hdcMem, hBitmap, 0, height, pixels, info, 0 /* DIB_RGB_COLORS */)

      // 释放所有 GDI 资源
      SelectObject(hdcMem, hOld)
      DeleteObject(hBitmap)
      DeleteDC(hdcMem)
      ReleaseDC(null, hdcScreen)

      if (result === 0 || result === 0) {
        throw new Error('GetDIBits 失败：无法获取像素数据')
      }

      return { data: new Uint8Array(pixels), width, height }
    }

    return koffiModule
  } catch (error) {
    koffiLoadError = `koffi 加载失败: ${error instanceof Error ? error.message : String(error)}`
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
    const captureFn = deps.captureGdi ?? getKoffiGdiCapture()
    const { data, width: imgW, height: imgH } = await captureFn(x, y, width, height)
    const rgba = bgraToRgba(data, imgW, imgH)
    return encodePng(rgba)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ScreenCaptureError('no-source', `GDI 截屏失败: ${message}`)
  }
}
