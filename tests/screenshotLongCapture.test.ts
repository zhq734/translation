import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LongCaptureStitcher,
  detectFixedRegions,
  locateScrollOffset,
  placeLongCapturePreview,
  placeLongCaptureStatusBar,
  resizeLongCapturePreview,
  rectanglesOverlap
} from '../src/shared/screenshotLongCapture'

/**
 * 构造指定行颜色的 RGBA 测试帧。
 * @param rows 每一行的灰度值。
 * @param width 图像宽度。
 * @returns 连续 RGBA 像素。
 * @author zhenghq
 */
function createFrame(rows: number[], width = 4): Uint8ClampedArray {
  const data = new Uint8ClampedArray(rows.length * width * 4)
  rows.forEach((value, y) => {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      data[offset] = value
      data[offset + 1] = value
      data[offset + 2] = value
      data[offset + 3] = 255
    }
  })
  return data
}

/**
 * 生成带有可识别纵向内容的滚动帧。
 * @param start 帧顶部对应的页面行。
 * @param height 视口高度。
 * @param width 图像宽度。
 * @returns 滚动帧像素。
 * @author zhenghq
 */
function createScrollFrame(start: number, height: number, width = 4): Uint8ClampedArray {
  return createFrame(Array.from({ length: height }, (_, index) => (start + index) % 251), width)
}

/**
 * 校验长截图能识别向下滚动的重叠区并只追加新内容。
 * @returns 无返回值。
 * @author zhenghq
 */
test('长截图应识别向下滚动偏移并拼接新增行', () => {
  const previous = createScrollFrame(10, 20)
  const next = createScrollFrame(14, 20)
  const match = locateScrollOffset(previous, next, 4, 20)
  assert.equal(match.confident, true)
  assert.equal(match.offset, 4)
  assert.equal(match.start, 16)
  assert.equal(match.end, 20)

  const stitcher = new LongCaptureStitcher(4, 20)
  assert.equal(stitcher.appendFrame(previous, 20), true)
  assert.equal(stitcher.appendFrame(next, 20), true)
  assert.equal(stitcher.height, 24)
  assert.equal(stitcher.offset, 4)
  assert.deepEqual([...stitcher.snapshot().slice(0, 4 * 4)], [...createFrame([10])])
})

/**
 * 校验完全相同的帧不会重复追加。
 * @returns 无返回值。
 * @author zhenghq
 */
test('长截图应忽略未滚动的重复帧', () => {
  const frame = createScrollFrame(30, 18)
  const match = locateScrollOffset(frame, frame, 4, 18)
  assert.equal(match.confident, true)
  assert.equal(match.offset, 0)
  assert.equal(match.start, 18)

  const stitcher = new LongCaptureStitcher(4, 18)
  assert.equal(stitcher.appendFrame(frame, 18), true)
  assert.equal(stitcher.appendFrame(frame, 18), false)
  assert.equal(stitcher.height, 18)
})

/**
 * 校验停住时采到重复帧不会把整屏误判为固定页眉，后续滚动仍可继续拼接。
 * @returns 无返回值。
 * @author zhenghq
 */
test('长截图在重复帧后仍应继续拼接滚动内容', () => {
  const first = createScrollFrame(30, 20)
  const stitcher = new LongCaptureStitcher(4, 20)
  assert.equal(stitcher.appendFrame(first, 20), true)
  assert.equal(stitcher.appendFrame(first, 20), false)
  assert.equal(stitcher.appendFrame(createScrollFrame(34, 20), 20), true)
  assert.equal(stitcher.height, 24)
  assert.equal(stitcher.offset, 4)
})

/**
 * 校验实时预览按比例降采样，且不会放大小于限制的图片。
 * @returns 无返回值。
 * @author zhenghq
 */
test('长截图实时预览应限制尺寸并保持宽高比', () => {
  const source = createFrame(Array.from({ length: 2000 }, (_, index) => index % 251), 100)
  const preview = resizeLongCapturePreview(source, 100, 2000, {
    maxWidth: 40,
    maxHeight: 80,
    maxPixels: 10_000
  })
  assert.equal(preview.width, 4)
  assert.equal(preview.height, 80)
  assert.equal(preview.data.length, preview.width * preview.height * 4)

  const small = createFrame([1, 2, 3], 2)
  const unchanged = resizeLongCapturePreview(small, 2, 3, {
    maxWidth: 40,
    maxHeight: 80,
    maxPixels: 10_000
  })
  assert.equal(unchanged.width, 2)
  assert.equal(unchanged.height, 3)
})

/**
 * 校验固定页眉页脚可从重叠匹配中剔除，并在最终结果中只保留一份。
 * @returns 无返回值。
 * @author zhenghq
 */
test('长截图应识别并去除固定页眉页脚', () => {
  const header = [250, 250, 250, 250]
  const footer = [249, 249, 249, 249]
  const first = createFrame([...header, ...Array.from({ length: 20 }, (_, i) => i + 20), ...footer])
  const second = createFrame([...header, ...Array.from({ length: 20 }, (_, i) => i + 24), ...footer])
  const fixed = detectFixedRegions(first, second, 4, 28, { minFixedRows: 4 })
  assert.equal(fixed.top, 4)
  assert.equal(fixed.bottom, 4)

  const stitcher = new LongCaptureStitcher(4, 28, { minFixedRows: 4 })
  stitcher.appendFrame(first, 28)
  stitcher.appendFrame(second, 28)
  const result = stitcher.result()
  assert.equal(result.fixedTop, 4)
  assert.equal(result.fixedBottom, 4)
  assert.equal(result.height, 32)
  assert.deepEqual([...result.data.slice(0, 4 * 4 * 4)], [...createFrame(header)])
  assert.deepEqual([...result.data.slice(-4 * 4 * 4)], [...createFrame(footer)])
})

/**
 * 校验向上滚动时能向画布头部插入新内容。
 * @returns 无返回值。
 * @author zhenghq
 */
test('长截图应支持向上滚动补充内容', () => {
  const stitcher = new LongCaptureStitcher(4, 20)
  stitcher.appendFrame(createScrollFrame(20, 20), 20)
  assert.equal(stitcher.appendFrame(createScrollFrame(16, 20), 20), true)
  assert.equal(stitcher.height, 24)
  assert.equal(stitcher.offset, -4)
})

/**
 * 校验无法可靠匹配的新帧不会污染拼接结果。
 * @returns 无返回值。
 * @author zhenghq
 */
test('长截图应拒绝无法可靠匹配的帧', () => {
  const previous = createScrollFrame(1, 20)
  const unrelated = createFrame(Array.from({ length: 20 }, (_, index) => (index * 37 + 13) % 251))
  const match = locateScrollOffset(previous, unrelated, 4, 20)
  assert.equal(match.confident, false)
  const stitcher = new LongCaptureStitcher(4, 20)
  stitcher.appendFrame(previous, 20)
  assert.equal(stitcher.appendFrame(unrelated, 20), false)
  assert.equal(stitcher.height, 20)
})

/**
 * 校验快速滚动只剩四行重叠时仍能可靠续接。
 * @returns 无返回值。
 * @author zhenghq
 */
test('长截图应接受仅四行重叠的快速滚动帧', () => {
  const stitcher = new LongCaptureStitcher(4, 20)
  assert.equal(stitcher.appendFrame(createScrollFrame(10, 20), 20), true)
  assert.equal(stitcher.appendFrame(createScrollFrame(26, 20), 20), true)
  assert.equal(stitcher.height, 36)
  assert.equal(stitcher.offset, 16)
})

/**
 * 校验拼接结果受最大高度保护，避免超长页面无限占用内存。
 * @returns 无返回值。
 * @author zhenghq
 */
test('长截图应限制最大输出高度', () => {
  const stitcher = new LongCaptureStitcher(4, 20, { maxHeight: 24 })
  stitcher.appendFrame(createScrollFrame(1, 20), 20)
  stitcher.appendFrame(createScrollFrame(5, 20), 20)
  assert.equal(stitcher.height, 24)
  assert.equal(stitcher.truncated, true)
})

/**
 * 校验追加新内容后可以撤销回上一帧，并恢复滚动偏移。
 * @returns 无返回值。
 * @author zhenghq
 */
test('长截图应支持撤销到上一帧', () => {
  const stitcher = new LongCaptureStitcher(4, 20)
  assert.equal(stitcher.canUndo, false)
  assert.equal(stitcher.undo(), false)

  stitcher.appendFrame(createScrollFrame(10, 20), 20)
  stitcher.appendFrame(createScrollFrame(14, 20), 20)
  assert.equal(stitcher.height, 24)
  assert.equal(stitcher.offset, 4)
  assert.equal(stitcher.canUndo, true)

  assert.equal(stitcher.undo(), true)
  assert.equal(stitcher.height, 20)
  assert.equal(stitcher.offset, 0)
  assert.equal(stitcher.canUndo, true)
  assert.deepEqual([...stitcher.snapshot()], [...createScrollFrame(10, 20)])
})

/**
 * 校验未滚动的重复帧不会污染撤销历史。
 * @returns 无返回值。
 * @author zhenghq
 */
test('长截图重复帧不应产生撤销记录', () => {
  const frame = createScrollFrame(30, 18)
  const stitcher = new LongCaptureStitcher(4, 18)
  stitcher.appendFrame(frame, 18)
  stitcher.appendFrame(frame, 18)
  assert.equal(stitcher.undo(), true)
  assert.equal(stitcher.height, 0)
  assert.equal(stitcher.canUndo, false)
})

/**
 * 校验撤销会恢复固定区域、截断状态、最后一帧与滚动偏移。
 * @returns 无返回值。
 * @author zhenghq
 */
test('长截图撤销应恢复完整拼接状态', () => {
  const header = [250, 250, 250, 250]
  const footer = [249, 249, 249, 249]
  const first = createFrame([
    ...header,
    ...Array.from({ length: 20 }, (_, index) => index + 20),
    ...footer
  ])
  const second = createFrame([
    ...header,
    ...Array.from({ length: 20 }, (_, index) => index + 24),
    ...footer
  ])
  const stitcher = new LongCaptureStitcher(4, 28, { minFixedRows: 4, maxHeight: 32 })

  stitcher.appendFrame(first, 28)
  stitcher.appendFrame(second, 28)
  assert.equal(stitcher.result().fixedTop, 4)
  assert.equal(stitcher.result().fixedBottom, 4)
  assert.equal(stitcher.offset, 4)
  assert.equal(stitcher.truncated, true)

  assert.equal(stitcher.undo(), true)
  const restored = stitcher.result()
  assert.equal(restored.height, 28)
  assert.equal(restored.fixedTop, 0)
  assert.equal(restored.fixedBottom, 0)
  assert.equal(stitcher.offset, 0)
  assert.equal(stitcher.truncated, false)
  assert.deepEqual([...restored.data], [...first])
})

/**
 * 校验第三帧及后续帧仍持续去除固定页眉页脚。
 * @returns 无返回值。
 * @author zhenghq
 */
test('长截图连续滚动时应持续去除固定页眉页脚', () => {
  const header = [250, 250, 250, 250]
  const footer = [249, 249, 249, 249]
  const makeFrame = (start: number): Uint8ClampedArray => createFrame([
    ...header,
    ...Array.from({ length: 20 }, (_, index) => start + index),
    ...footer
  ])
  const stitcher = new LongCaptureStitcher(4, 28, { minFixedRows: 4 })

  stitcher.appendFrame(makeFrame(20), 28)
  stitcher.appendFrame(makeFrame(24), 28)
  stitcher.appendFrame(makeFrame(28), 28)
  stitcher.appendFrame(makeFrame(32), 28)

  const result = stitcher.result()
  assert.equal(result.fixedTop, 4)
  assert.equal(result.fixedBottom, 4)
  assert.equal(result.height, 40)
  assert.deepEqual([...result.data.slice(0, 4 * 4 * 4)], [...createFrame(header)])
  assert.deepEqual([...result.data.slice(-4 * 4 * 4)], [...createFrame(footer)])
})

/**
 * 校验达到最大高度后继续追加仍受上限保护。
 * @returns 无返回值。
 * @author zhenghq
 */
test('长截图触顶后继续追加不应突破最大高度', () => {
  const stitcher = new LongCaptureStitcher(4, 20, { maxHeight: 24 })
  for (const start of [1, 5, 9, 13, 17]) {
    assert.equal(stitcher.appendFrame(createScrollFrame(start, 20), 20), true)
    assert.ok(stitcher.height <= 24)
  }
  assert.equal(stitcher.height, 24)
  assert.equal(stitcher.truncated, true)
})

/**
 * 校验长截图控制条优先放在选区下方，且永远不覆盖采集区域。
 * @returns 无返回值。
 * @author zhenghq
 */
test('长截图状态条不得覆盖采集选区', () => {
  const selection = { x: 31, y: 494, width: 1573, height: 428 }
  const workArea = { x: 0, y: 0, width: 1728, height: 1117 }
  const bar = placeLongCaptureStatusBar(selection, workArea)

  assert.equal(rectanglesOverlap(bar, selection), false)
  assert.ok(bar.y >= selection.y + selection.height)
  assert.ok(bar.y + bar.height <= workArea.y + workArea.height)
  assert.ok(bar.height <= 56)
})

/**
 * 校验选区占满上下空间时控制条仍留在屏幕内且不压住选区。
 * @returns 无返回值。
 * @author zhenghq
 */
test('长截图状态条在上下空间不足时也不得覆盖选区', () => {
  const selection = { x: 20, y: 40, width: 1760, height: 1000 }
  const workArea = { x: 0, y: 0, width: 1800, height: 1080 }
  const bar = placeLongCaptureStatusBar(selection, workArea)

  assert.equal(rectanglesOverlap(bar, selection), false)
  assert.ok(bar.x >= workArea.x)
  assert.ok(bar.x + bar.width <= workArea.x + workArea.width)
})

/**
 * 校验侧边预览只在剩余空间足够时显示，并避开采集选区。
 * @returns 无返回值。
 * @author zhenghq
 */
test('长截图侧边预览应避开采集选区并在空间不足时隐藏', () => {
  const selection = { x: 300, y: 100, width: 900, height: 700 }
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 }
  const preview = placeLongCapturePreview(selection, workArea)
  assert.ok(preview)
  assert.equal(rectanglesOverlap(preview, selection), false)

  const fullWidth = { x: 10, y: 10, width: 1900, height: 900 }
  assert.equal(placeLongCapturePreview(fullWidth, workArea), null)
})
