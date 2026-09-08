/**
 * OCR 屏幕快照像素工具模块。
 *
 * 把「像素格式转换」「选区裁剪矩形换算」「选区 PNG 编码」从主进程 index.ts 抽出，
 * 使截图预览链路可以在不经过整屏 JS PNG 编解码的前提下完成裁剪与 OCR 预处理：
 * - 预览：GDI BGRA 直接交给 nativeImage，不走 encodePng
 * - 识别/翻译：先裁选区再放大编码，避免对整屏调用 encodePng / decodePng
 *
 * @author zhenghq
 */

import { resizeRgbaForOcr, type RgbaImage } from '../shared/imagePreprocess'
import { encodePng } from './pngCodec'
import {
  computeCropRect,
  resolveCroppedRectForWindows,
  type CaptureBounds
} from './screenCapture'

/** Windows GDI 采集来源标识前缀：该来源的快照为物理像素直采。 */
export const WINDOWS_GDI_SOURCE_PREFIX = 'windows-gdi'

/**
 * 将 BGRA 缓冲的 alpha 通道原地填充为 255（不透明）。
 * Win32 GetDIBits 返回的 32 位位图 alpha 恒为 0，直接交给 Chromium 会得到全透明图像；
 * 这里原地修改而不复制，避免 4K 整屏多出一次 30MB 级别的内存拷贝。
 * @param bgra BGRA 像素缓冲（会被原地修改）。
 * @returns 传入的同一个缓冲，便于链式调用。
 * @author zhenghq
 */
export function forceOpaqueBgra(bgra: Uint8Array): Uint8Array {
  for (let i = 3; i < bgra.length; i += 4) {
    bgra[i] = 0xff
  }
  return bgra
}

/**
 * 将 BGRA 像素数据转换为 RGBA 图像。
 * Win32 GetDIBits 返回的 32 位位图为 BGRA 顺序，需交换 B 与 R 通道；
 * alpha 统一置为 255，避免 GDI 未写 alpha 导致图像全透明。
 * @param bgra BGRA 像素数据。
 * @param width 图像宽度（像素）。
 * @param height 图像高度（像素）。
 * @returns RGBA 图像。
 * @author zhenghq
 */
export function bgraToRgba(bgra: Uint8Array, width: number, height: number): RgbaImage {
  const rgba = new Uint8Array(bgra.length)
  for (let i = 0; i < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2]
    rgba[i + 1] = bgra[i + 1]
    rgba[i + 2] = bgra[i]
    rgba[i + 3] = 0xff
  }
  return { width, height, data: rgba }
}

/**
 * 按快照来源换算选区在快照图像内的裁剪矩形。
 * Windows GDI 快照是物理像素直采，其余平台是 desktopCapturer 缩略图，
 * 两者都按「显示器矩形 → 图像尺寸」的实际比例对齐。
 * @param source 快照来源标识。
 * @param bounds 用户选区（全局屏幕坐标）。
 * @param snapshotBounds 快照对应的显示器矩形（全局屏幕坐标）。
 * @param imageWidth 快照图像宽度（像素）。
 * @param imageHeight 快照图像高度（像素）。
 * @returns 快照图像像素坐标下的裁剪矩形。
 * @author zhenghq
 */
export function resolveSnapshotCropRect(
  source: string,
  bounds: CaptureBounds,
  snapshotBounds: CaptureBounds,
  imageWidth: number,
  imageHeight: number
): CaptureBounds {
  return source.startsWith(WINDOWS_GDI_SOURCE_PREFIX)
    ? resolveCroppedRectForWindows(bounds, snapshotBounds, imageWidth, imageHeight)
    : computeCropRect(bounds, snapshotBounds, imageWidth, imageHeight)
}

/**
 * 将已裁剪的选区图像按 OCR 倍率放大后编码为 PNG。
 * 只对选区（而不是整屏）调用 encodePng，把编码耗时压到与选区面积成正比。
 * @param selection 已裁剪出的选区 RGBA 图像。
 * @param ocrScale OCR 放大倍率。
 * @returns 选区 PNG 字节。
 * @author zhenghq
 */
export function encodeOcrSelectionPng(selection: RgbaImage, ocrScale: number): Buffer {
  const scaled = resizeRgbaForOcr(selection, ocrScale)
  return encodePng(scaled)
}
