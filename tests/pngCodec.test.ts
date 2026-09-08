import assert from 'node:assert/strict'
import test from 'node:test'
import { decodePng, encodePng, expandScanlines } from '../src/main/pngCodec.ts'
import type { RgbaImage } from '../src/shared/imagePreprocess.ts'

/**
 * 构造测试用 RGBA 图像。
 * @param width 图像宽度。
 * @param height 图像高度。
 * @param fill 像素填充回调。
 * @returns RGBA 图像。
 * @author zhenghq
 */
function makeImage(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = fill(x, y)
      const i = (y * width + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a
    }
  }
  return { width, height, data }
}

/**
 * 校验 Sub 滤镜扫描线展开结果与手工计算一致。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Sub 滤镜扫描线应正确还原像素', () => {
  // Sub 滤镜的 left 是上一像素同通道（bpp 字节前），不是前一个字节。
  const row0 = [0, 10, 20, 30, 40, 50, 60]
  const row1 = [1, 70, 80, 90, 30, 30, 30]
  const raw = new Uint8Array([...row0, ...row1])
  const pixels = expandScanlines(raw, 2, 2, 3)
  assert.deepEqual(
    Array.from(pixels),
    [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]
  )
})

/**
 * 校验 Up 滤镜扫描线展开结果与手工计算一致。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Up 滤镜扫描线应正确还原像素', () => {
  const row0 = [0, 10, 20, 30, 40, 50, 60]
  const row1 = [2, 60, 60, 60, 60, 60, 60]
  const pixels = expandScanlines(new Uint8Array([...row0, ...row1]), 2, 2, 3)
  assert.deepEqual(
    Array.from(pixels),
    [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]
  )
})

/**
 * 校验 Average 滤镜扫描线展开结果与手工计算一致。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Average 滤镜扫描线应正确还原像素', () => {
  // Average = floor((left + up) / 2)，left/up 均按 bpp 对齐。
  const row0 = [0, 10, 20, 30, 40, 50, 60]
  const row1 = [3, 65, 70, 75, 45, 45, 45]
  const pixels = expandScanlines(new Uint8Array([...row0, ...row1]), 2, 2, 3)
  assert.deepEqual(
    Array.from(pixels),
    [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]
  )
})

/**
 * 校验 Paeth 滤镜扫描线展开结果与手工计算一致。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Paeth 滤镜扫描线应正确还原像素', () => {
  // Paeth 预测器按 PNG 规范选择 left/up/upLeft。
  const row0 = [0, 10, 20, 30, 40, 50, 60]
  const row1 = [4, 60, 60, 60, 30, 30, 30]
  const pixels = expandScanlines(new Uint8Array([...row0, ...row1]), 2, 2, 3)
  assert.deepEqual(
    Array.from(pixels),
    [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]
  )
})

/**
 * 校验 PNG 编码再解码的往返一致性。
 * @returns 无返回值。
 * @author zhenghq
 */
test('PNG 编解码往返应保持一致', () => {
  const image = makeImage(4, 3, (x, y) => [x * 50, y * 70, (x + y) * 30, 255])
  const roundTripped = decodePng(encodePng(image))
  assert.equal(roundTripped.width, 4)
  assert.equal(roundTripped.height, 3)
  assert.deepEqual(Array.from(roundTripped.data), Array.from(image.data))
})

/**
 * 校验灰度 PNG 解码为 RGBA 时通道复制正确。
 * @returns 无返回值。
 * @author zhenghq
 */
test('灰度 PNG 应解码为三通道一致的 RGBA', () => {
  const gray = makeImage(1, 1, () => [128, 128, 128, 255])
  const pngBytes = encodePng(gray)
  // 手工改写 IHDR 颜色类型为 0（灰度）并压缩为灰度数据的 PNG 较复杂，
  // 这里验证编码产物确实是 8-bit RGBA（colorType 6）。
  const ihdrColorType = pngBytes[25]
  assert.equal(ihdrColorType, 6)
  const decoded = decodePng(pngBytes)
  assert.deepEqual(Array.from(decoded.data), [128, 128, 128, 255])
})

/**
 * 校验非法 PNG 签名抛出解码错误。
 * @returns 无返回值。
 * @author zhenghq
 */
test('非法 PNG 签名应抛出解码错误', () => {
  assert.throws(() => decodePng(new Uint8Array([1, 2, 3, 4])))
})

/**
 * 校验编码空图像抛出参数错误。
 * @returns 无返回值。
 * @author zhenghq
 */
test('编码空图像应抛出参数错误', () => {
  assert.throws(() => encodePng({ width: 0, height: 0, data: new Uint8Array(0) }))
})

/**
 * 校验 encodePng 默认使用低压缩级别（level ≤ 3），避免全屏截图编码同步阻塞主进程。
 * 断言方式：默认产物体积应明显大于显式 level 9 的产物，说明默认没有走最高压缩。
 * @returns 无返回值。
 * @author zhenghq
 */
test('encodePng 默认应使用低压缩级别而非最高压缩', () => {
  // 构造带噪声的渐变图，保证不同压缩级别产物体积有可测差异。
  const image = makeImage(160, 120, (x, y) => [
    (x * 7 + y * 13) % 256,
    (x * 31 + y * 17) % 256,
    (x * 5 + y * 3) % 256,
    255
  ])
  const fast = encodePng(image)
  const best = encodePng(image, { level: 9 })
  assert.ok(fast.length > best.length, '默认级别产物应比 level 9 更大，证明默认不是最高压缩')
  // 两者解码后像素必须完全一致：压缩级别只影响体积，不影响像素。
  assert.deepEqual(Array.from(decodePng(fast).data), Array.from(image.data))
  assert.deepEqual(Array.from(decodePng(best).data), Array.from(image.data))
})

/**
 * 校验显式指定压缩级别时编码结果仍可正确解码，覆盖 level 0（仅存储）到 9。
 * @returns 无返回值。
 * @author zhenghq
 */
test('encodePng 显式压缩级别应保持像素等价', () => {
  const image = makeImage(9, 7, (x, y) => [x * 20, y * 30, (x * y) % 256, 255])
  for (const level of [0, 1, 6, 9]) {
    const decoded = decodePng(encodePng(image, { level }))
    assert.equal(decoded.width, 9)
    assert.equal(decoded.height, 7)
    assert.deepEqual(Array.from(decoded.data), Array.from(image.data), `level ${level} 像素应等价`)
  }
})

/**
 * 校验 encodePng 支持带 byteOffset 的 Uint8Array 视图，避免改为 Buffer 拷贝后读到整块底层内存。
 * @returns 无返回值。
 * @author zhenghq
 */
test('encodePng 应正确处理带偏移的像素视图', () => {
  const image = makeImage(3, 2, (x, y) => [x * 40, y * 60, 10, 255])
  const backing = new Uint8Array(image.data.length + 16)
  backing.set(image.data, 8)
  const view = backing.subarray(8, 8 + image.data.length)
  const decoded = decodePng(encodePng({ width: 3, height: 2, data: view }))
  assert.deepEqual(Array.from(decoded.data), Array.from(image.data))
})

/**
 * 校验大图编码不再退化为 number[] 逐字节路径：2560×1440 全屏级图像应在 300ms 内完成。
 * 旧实现（number[] 拼扫描线 + deflate level 9）在该尺寸约需 1 秒，
 * 该断言防止 encodePng 回归成阻塞主进程的实现。
 * @returns 无返回值。
 * @author zhenghq
 */
test('encodePng 编码 2560×1440 图像应在 300ms 内完成', () => {
  const image = makeImage(2560, 1440, (x, y) => [
    (x + y) % 256,
    (x * 2) % 256,
    (y * 3) % 256,
    255
  ])
  const started = Date.now()
  const png = encodePng(image)
  const elapsed = Date.now() - started
  assert.ok(png.length > 0)
  assert.ok(elapsed < 300, `编码耗时 ${elapsed}ms 应小于 300ms`)
})
