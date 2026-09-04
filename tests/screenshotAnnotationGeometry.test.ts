import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SCREENSHOT_ANNOTATION_LIMITS,
  clampPointToSelection,
  computeArrowHeadPoints,
  computeExportScale,
  isPointInsideSelection,
  normalizeAnnotationStyle,
  normalizeRectFromPoints,
  simplifyBrushPoints,
  toSelectionRelativePoint
} from '../src/renderer/src/screenshotAnnotation.ts'

/**
 * 校验任意拖拽方向都能得到左上角原点与正宽高的规范化矩形。
 * @returns 无返回值。
 * @author zhenghq
 */
test('矩形规范化应处理四个拖拽方向', () => {
  assert.deepEqual(normalizeRectFromPoints({ x: 10, y: 20 }, { x: 50, y: 70 }), {
    x: 10,
    y: 20,
    width: 40,
    height: 50
  })
  assert.deepEqual(normalizeRectFromPoints({ x: 50, y: 70 }, { x: 10, y: 20 }), {
    x: 10,
    y: 20,
    width: 40,
    height: 50
  })
  assert.deepEqual(normalizeRectFromPoints({ x: 50, y: 20 }, { x: 10, y: 70 }), {
    x: 10,
    y: 20,
    width: 40,
    height: 50
  })
  assert.deepEqual(normalizeRectFromPoints({ x: 10, y: 70 }, { x: 50, y: 20 }), {
    x: 10,
    y: 20,
    width: 40,
    height: 50
  })
})

/**
 * 校验箭头头部两个端点位于终点附近且相对线段方向对称。
 * @returns 无返回值。
 * @author zhenghq
 */
test('箭头头部应指向终点并随方向旋转', () => {
  const right = computeArrowHeadPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 4)
  assert.equal(right.length, 2)
  for (const point of right) {
    // 头部端点位于终点左侧（朝向起点方向）且上下对称
    assert.ok(point.x < 100)
    assert.ok(point.x > 0)
  }
  assert.ok(Math.abs(right[0]!.y + right[1]!.y) < 1e-6)

  const down = computeArrowHeadPoints({ x: 0, y: 0 }, { x: 0, y: 100 }, 4)
  for (const point of down) {
    assert.ok(point.y < 100)
    assert.ok(point.y > 0)
  }
  assert.ok(Math.abs(down[0]!.x + down[1]!.x) < 1e-6)

  // 零长度线段不产生 NaN
  const zero = computeArrowHeadPoints({ x: 20, y: 20 }, { x: 20, y: 20 }, 4)
  for (const point of zero) {
    assert.ok(Number.isFinite(point.x))
    assert.ok(Number.isFinite(point.y))
  }
})

/**
 * 校验画笔点集合抽稀会丢弃过近的点、保留首尾并限制总点数。
 * @returns 无返回值。
 * @author zhenghq
 */
test('画笔点集合应抽稀并保留首尾点', () => {
  const dense = [
    { x: 0, y: 0 },
    { x: 0.2, y: 0.1 },
    { x: 0.4, y: 0.2 },
    { x: 12, y: 8 },
    { x: 30, y: 20 }
  ]
  const simplified = simplifyBrushPoints(dense)
  assert.ok(simplified.length < dense.length)
  assert.deepEqual(simplified[0], { x: 0, y: 0 })
  assert.deepEqual(simplified[simplified.length - 1], { x: 30, y: 20 })

  // 单点笔迹保留自身，便于绘制圆点
  assert.deepEqual(simplifyBrushPoints([{ x: 3, y: 4 }]), [{ x: 3, y: 4 }])
  assert.deepEqual(simplifyBrushPoints([]), [])

  const huge = Array.from({ length: SCREENSHOT_ANNOTATION_LIMITS.maxBrushPoints * 3 }, (_, i) => ({
    x: i * 5,
    y: i * 5
  }))
  assert.ok(simplifyBrushPoints(huge).length <= SCREENSHOT_ANNOTATION_LIMITS.maxBrushPoints)
})

/**
 * 校验选区相对坐标换算、边界裁剪与选区内外判定。
 * @returns 无返回值。
 * @author zhenghq
 */
test('选区相对坐标应以选区左上角为原点并裁剪到边界', () => {
  const selection = { x: 100, y: 50, width: 200, height: 120 }
  assert.deepEqual(toSelectionRelativePoint({ x: 150, y: 80 }, selection), { x: 50, y: 30 })
  // 超出选区的点被裁剪到选区边界内
  assert.deepEqual(clampPointToSelection({ x: -40, y: 999 }, selection), { x: 0, y: 120 })
  assert.deepEqual(clampPointToSelection({ x: 1000, y: -1 }, selection), { x: 200, y: 0 })

  assert.equal(isPointInsideSelection({ x: 101, y: 51 }, selection), true)
  assert.equal(isPointInsideSelection({ x: 99, y: 51 }, selection), false)
  assert.equal(isPointInsideSelection({ x: 101, y: 200 }, selection), false)
  assert.equal(isPointInsideSelection({ x: 300, y: 170 }, selection), true)
})

/**
 * 校验高 DPI 下导出比例按原始图片像素与覆盖层逻辑尺寸计算。
 * @returns 无返回值。
 * @author zhenghq
 */
test('导出比例应按原图像素与覆盖层逻辑尺寸换算', () => {
  // 2x 高 DPI 屏：图片自然尺寸是覆盖层逻辑尺寸的两倍
  const scale2x = computeExportScale(
    { width: 1440, height: 900 },
    { width: 2880, height: 1800 }
  )
  assert.deepEqual(scale2x, { scaleX: 2, scaleY: 2 })

  const scale1x = computeExportScale({ width: 1280, height: 800 }, { width: 1280, height: 800 })
  assert.deepEqual(scale1x, { scaleX: 1, scaleY: 1 })

  // 非法尺寸回退为 1，避免出现 0 或无限大的导出画布
  assert.deepEqual(computeExportScale({ width: 0, height: 0 }, { width: 100, height: 100 }), {
    scaleX: 1,
    scaleY: 1
  })
  assert.deepEqual(computeExportScale({ width: 100, height: 100 }, { width: 0, height: 0 }), {
    scaleX: 1,
    scaleY: 1
  })
})

/**
 * 校验导出画布尺寸受最大像素限制约束。
 * @returns 无返回值。
 * @author zhenghq
 */
test('样式默认值应在允许范围内', () => {
  const style = normalizeAnnotationStyle(null)
  assert.ok(style.strokeWidth >= SCREENSHOT_ANNOTATION_LIMITS.strokeWidth.min)
  assert.ok(style.strokeWidth <= SCREENSHOT_ANNOTATION_LIMITS.strokeWidth.max)
  assert.ok(style.fontSize >= SCREENSHOT_ANNOTATION_LIMITS.fontSize.min)
  assert.ok(style.mosaicBlockSize >= SCREENSHOT_ANNOTATION_LIMITS.mosaicBlockSize.min)
  assert.ok(SCREENSHOT_ANNOTATION_LIMITS.maxExportPixels > 0)
  assert.ok(SCREENSHOT_ANNOTATION_LIMITS.maxExportBytes > 0)
})
