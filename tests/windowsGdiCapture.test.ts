import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bgraToRgba,
  captureWindowsRegionAsPngGdi,
  type WindowsGdiCaptureDeps,
  type GdiCaptureFn
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
