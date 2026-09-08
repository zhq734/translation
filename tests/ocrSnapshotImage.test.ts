import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  bgraToRgba,
  encodeOcrSelectionPng,
  forceOpaqueBgra,
  resolveSnapshotCropRect
} from '../src/main/ocrSnapshotImage.ts'
import { decodePng } from '../src/main/pngCodec'
import { ScreenCaptureError } from '../src/main/screenCapture'

/**
 * 校验 alpha 填充原地复用缓冲，避免整屏像素再拷贝一份。
 * @returns 无返回值。
 * @author zhenghq
 */
test('forceOpaqueBgra 应原地把 alpha 通道填成 255', () => {
  const bgra = new Uint8Array([0x10, 0x20, 0x30, 0x00, 0x40, 0x50, 0x60, 0x00])
  const result = forceOpaqueBgra(bgra)
  assert.equal(result, bgra, '应返回同一个缓冲，不额外分配')
  assert.deepEqual(Array.from(bgra), [0x10, 0x20, 0x30, 0xff, 0x40, 0x50, 0x60, 0xff])
})

/**
 * 校验纯红像素在 BGRA → RGBA 转换后仍是红色，防止预览发蓝。
 * @returns 无返回值。
 * @author zhenghq
 */
test('bgraToRgba 对纯红像素不得反转成蓝色', () => {
  // GDI 的纯红 (255, 0, 0) 在 BGRA 内存中是 B=0, G=0, R=255
  const bgra = new Uint8Array([0x00, 0x00, 0xff, 0x00])
  const rgba = bgraToRgba(bgra, 1, 1)
  assert.deepEqual(Array.from(rgba.data), [0xff, 0x00, 0x00, 0xff])
})

/**
 * 校验 Windows GDI 快照按物理像素比例换算裁剪矩形。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveSnapshotCropRect 对 Windows GDI 快照应按物理像素换算', () => {
  const rect = resolveSnapshotCropRect(
    'windows-gdi-copyscreen-preview',
    { x: 100, y: 50, width: 200, height: 100 },
    { x: 0, y: 0, width: 1280, height: 720 },
    2560,
    1440
  )
  assert.deepEqual(rect, { x: 200, y: 100, width: 400, height: 200 })
})

/**
 * 校验非 Windows 快照仍走缩略图比例换算。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveSnapshotCropRect 对缩略图快照应按图像比例换算', () => {
  const rect = resolveSnapshotCropRect(
    'electron-desktopCapturer-preview',
    { x: 640, y: 360, width: 320, height: 180 },
    { x: 0, y: 0, width: 1280, height: 720 },
    1280,
    720
  )
  assert.deepEqual(rect, { x: 640, y: 360, width: 320, height: 180 })
})

/**
 * 校验选区完全落在显示器之外时抛出既有越界错误。
 * @returns 无返回值。
 * @author zhenghq
 */
test('resolveSnapshotCropRect 选区越界应抛出 out-of-bounds', () => {
  assert.throws(
    () => resolveSnapshotCropRect(
      'windows-gdi-copyscreen-preview',
      { x: 5000, y: 5000, width: 100, height: 100 },
      { x: 0, y: 0, width: 1280, height: 720 },
      1280,
      720
    ),
    (error: unknown) => error instanceof ScreenCaptureError && error.code === 'out-of-bounds'
  )
})

/**
 * 校验选区 PNG 编码保持像素等价（倍率 1 时不重采样）。
 * @returns 无返回值。
 * @author zhenghq
 */
test('encodeOcrSelectionPng 倍率 1 时应保持像素等价', () => {
  const data = new Uint8Array(2 * 2 * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 0xff
    data[i + 1] = 0x80
    data[i + 2] = 0x10
    data[i + 3] = 0xff
  }
  const png = encodeOcrSelectionPng({ width: 2, height: 2, data }, 1)
  const decoded = decodePng(png)
  assert.equal(decoded.width, 2)
  assert.equal(decoded.height, 2)
  assert.deepEqual(Array.from(decoded.data.subarray(0, 4)), [0xff, 0x80, 0x10, 0xff])
})

/**
 * 校验选区 PNG 编码按 OCR 倍率放大，供识别与翻译复用。
 * @returns 无返回值。
 * @author zhenghq
 */
test('encodeOcrSelectionPng 应按 OCR 倍率放大选区', () => {
  const data = new Uint8Array(4 * 4 * 4).fill(0xff)
  const png = encodeOcrSelectionPng({ width: 4, height: 4, data }, 2)
  const decoded = decodePng(png)
  assert.equal(decoded.width, 8)
  assert.equal(decoded.height, 8)
})

/**
 * 校验选区编码模块只处理选区，不把整屏图像交给 JS PNG 编码器。
 * @returns 无返回值。
 * @author zhenghq
 */
test('ocrSnapshotImage 不应解码整屏 PNG', () => {
  const source = readFileSync('src/main/ocrSnapshotImage.ts', 'utf8')
  assert.doesNotMatch(source, /decodePng\(/u)
})
