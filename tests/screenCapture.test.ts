import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ScreenCaptureError,
  captureRegionAsPng,
  computeCropRect,
  getDisplayForBounds,
  intersectBounds,
  pickDisplaySource,
  type DisplayInfo,
  type ScreenCaptureDeps,
  type ScreenSource
} from '../src/main/screenCapture.ts'
import { encodePng } from '../src/main/pngCodec.ts'
import type { RgbaImage } from '../src/shared/imagePreprocess.ts'

const display = { id: 7, bounds: { x: 0, y: 0, width: 1000, height: 800 }, scaleFactor: 2 } satisfies DisplayInfo

/**
 * 构造测试依赖。
 * @param sources 注入的屏幕源列表。
 * @returns 屏幕采集依赖。
 * @author zhenghq
 */
function makeDeps(sources: ScreenSource[]): ScreenCaptureDeps {
  return {
    getSources: async () => sources,
    getDisplayNearestPoint: () => display,
    getPrimaryDisplay: () => display,
    platform: 'darwin'
  }
}

/**
 * 构造一个纯色 PNG 缩略图源。
 * @param width 缩略图宽度。
 * @param height 缩略图高度。
 * @param displayId 显示器标识。
 * @returns 屏幕源。
 * @author zhenghq
 */
function makeSource(width: number, height: number, displayId: number): ScreenSource {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 200
    data[i + 1] = 100
    data[i + 2] = 50
    data[i + 3] = 255
  }
  const image: RgbaImage = { width, height, data }
  return {
    display_id: displayId,
    thumbnail: {
      isEmpty: () => false,
      toPNG: () => encodePng(image)
    }
  }
}

/**
 * 校验选区与显示器的交集计算。
 * @returns 无返回值。
 * @author zhenghq
 */
test('交集计算应正确处理重叠与相离', () => {
  assert.deepEqual(
    intersectBounds({ x: 100, y: 100, width: 200, height: 200 }, { x: 150, y: 150, width: 200, height: 200 }),
    { x: 150, y: 150, width: 150, height: 150 }
  )
  assert.deepEqual(
    intersectBounds({ x: 0, y: 0, width: 10, height: 10 }, { x: 100, y: 100, width: 10, height: 10 }),
    { x: 100, y: 100, width: 0, height: 0 }
  )
})

/**
 * 校验按选区中心点选择显示器，缺失时回退主显示器。
 * @returns 无返回值。
 * @author zhenghq
 */
test('显示器选择应支持回退主显示器', () => {
  const deps: ScreenCaptureDeps = {
    getSources: async () => [],
    getDisplayNearestPoint: () => null,
    getPrimaryDisplay: () => display,
    platform: 'darwin'
  }
  assert.equal(getDisplayForBounds({ x: 10, y: 10, width: 10, height: 10 }, deps).id, 7)
})

/**
 * 校验按 scaleFactor 对齐的裁剪矩形计算。
 * @returns 无返回值。
 * @author zhenghq
 */
test('裁剪矩形应按缩放因子对齐像素坐标', () => {
  const rect = computeCropRect(
    { x: 100, y: 50, width: 200, height: 100 },
    display.bounds,
    2000,
    1600
  )
  assert.deepEqual(rect, { x: 200, y: 100, width: 400, height: 200 })
})

/**
 * 校验选区大部分在屏幕外时抛出越界错误。
 * @returns 无返回值。
 * @author zhenghq
 */
test('选区不在屏幕内应抛出越界错误', () => {
  assert.throws(
    () => computeCropRect({ x: 1500, y: 0, width: 200, height: 200 }, display.bounds, 2000, 1600),
    (error: unknown) => error instanceof ScreenCaptureError && error.code === 'out-of-bounds'
  )
})

/**
 * 校验裁剪矩形不会超出图像实际边界。
 * @returns 无返回值。
 * @author zhenghq
 */
test('裁剪矩形应夹取到图像边界内', () => {
  const rect = computeCropRect(
    { x: 990, y: 790, width: 100, height: 100 },
    display.bounds,
    2000,
    1600
  )
  assert.ok(rect.x + rect.width <= 2000)
  assert.ok(rect.y + rect.height <= 1600)
})

/**
 * 校验屏幕源选择优先按显示器 id 匹配，否则取首个非空缩略图。
 * @returns 无返回值。
 * @author zhenghq
 */
test('屏幕源选择应按 id 匹配并回退非空缩略图', () => {
  const sources = [makeSource(10, 10, 1), makeSource(10, 10, 7)]
  assert.equal(pickDisplaySource(sources, 7)?.display_id, 7)
  assert.equal(pickDisplaySource([makeSource(10, 10, 1)], 99)?.display_id, 1)
  assert.equal(pickDisplaySource([], 1), null)
})

/**
 * 校验 macOS 上缩略图为空时归类为屏幕录制权限错误。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('macOS 缩略图为空应归类为权限错误', async () => {
  const deps = makeDeps([{ display_id: 7, thumbnail: { isEmpty: () => true, toPNG: () => Buffer.alloc(0) } }])
  await assert.rejects(
    captureRegionAsPng({ x: 10, y: 10, width: 100, height: 100 }, {}, deps),
    (error: unknown) => error instanceof ScreenCaptureError && error.code === 'permission'
  )
})

/**
 * 校验端到端采集：按显示器缩放裁剪选区并输出 PNG。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('端到端采集应按选区裁剪并输出 PNG', async () => {
  const deps = makeDeps([makeSource(2000, 1600, 7)])
  const result = await captureRegionAsPng(
    { x: 100, y: 50, width: 200, height: 100 },
    { ocrScale: 1 },
    deps
  )
  assert.deepEqual(result.sourceSize, { width: 400, height: 200 })
  assert.ok(result.png.length > 8)
  assert.equal(result.displayId, 7)
})

/**
 * 校验采集时按设置放大图像。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('端到端采集应按设置放大图像', async () => {
  const deps = makeDeps([makeSource(2000, 1600, 7)])
  const result = await captureRegionAsPng(
    { x: 100, y: 50, width: 200, height: 100 },
    { ocrScale: 2 },
    deps
  )
  assert.deepEqual(result.ocrSize, { width: 800, height: 400 })
})
