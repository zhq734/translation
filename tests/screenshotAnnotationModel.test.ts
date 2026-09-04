import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_SCREENSHOT_ANNOTATION_STYLE,
  SCREENSHOT_ANNOTATION_LIMITS,
  SCREENSHOT_ANNOTATION_PRESET_COLORS,
  ScreenshotAnnotationStore,
  createArrowAnnotation,
  createBrushAnnotation,
  createMosaicAnnotation,
  createShapeAnnotation,
  createTextAnnotation,
  getTextAnnotationBounds,
  isScreenshotAnnotationTool,
  normalizeAnnotationColor,
  normalizeAnnotationStyle,
  normalizeAnnotationText,
  normalizeFontSize,
  normalizeMosaicBlockSize,
  normalizeMosaicBrushSize,
  normalizeStrokeWidth
} from '../src/renderer/src/screenshotAnnotation.ts'

/**
 * 校验六种标注工具标识可被识别，其它值一律拒绝。
 * @returns 无返回值。
 * @author zhenghq
 */
test('标注工具标识应只接受六种截图标注工具', () => {
  for (const tool of ['rect', 'ellipse', 'arrow', 'brush', 'text', 'mosaic']) {
    assert.equal(isScreenshotAnnotationTool(tool), true)
  }
  for (const invalid of ['select', '', 'RECT', null, undefined, 1, {}]) {
    assert.equal(isScreenshotAnnotationTool(invalid), false)
  }
})

/**
 * 校验颜色归一化只接受十六进制颜色，非法值回退到默认颜色。
 * @returns 无返回值。
 * @author zhenghq
 */
test('颜色归一化应只接受十六进制颜色并回退默认值', () => {
  assert.equal(normalizeAnnotationColor('#ff3b30'), '#ff3b30')
  assert.equal(normalizeAnnotationColor('#FFF'), '#ffffff')
  for (const invalid of [
    'red',
    'rgb(255,0,0)',
    'url(javascript:alert(1))',
    '#12',
    '#1234567',
    '',
    null,
    undefined,
    123,
    {}
  ]) {
    assert.equal(normalizeAnnotationColor(invalid), DEFAULT_SCREENSHOT_ANNOTATION_STYLE.color)
  }
  // 预置颜色必须全部是合法十六进制颜色且包含默认颜色
  assert.ok(SCREENSHOT_ANNOTATION_PRESET_COLORS.length >= 6)
  for (const color of SCREENSHOT_ANNOTATION_PRESET_COLORS) {
    assert.match(color, /^#[0-9a-f]{6}$/u)
  }
  assert.ok(SCREENSHOT_ANNOTATION_PRESET_COLORS.includes(DEFAULT_SCREENSHOT_ANNOTATION_STYLE.color))
})

/**
 * 校验线宽、字号、马赛克笔刷与像素块大小被限制在约定范围内。
 * @returns 无返回值。
 * @author zhenghq
 */
test('样式数值应被限制在约定范围内', () => {
  const cases = [
    [normalizeStrokeWidth, SCREENSHOT_ANNOTATION_LIMITS.strokeWidth],
    [normalizeFontSize, SCREENSHOT_ANNOTATION_LIMITS.fontSize],
    [normalizeMosaicBrushSize, SCREENSHOT_ANNOTATION_LIMITS.mosaicBrushSize],
    [normalizeMosaicBlockSize, SCREENSHOT_ANNOTATION_LIMITS.mosaicBlockSize]
  ] as const
  for (const [normalize, range] of cases) {
    assert.equal(normalize(range.min - 100), range.min)
    assert.equal(normalize(range.max + 10_000), range.max)
    assert.equal(normalize(range.min), range.min)
    assert.equal(normalize(range.max), range.max)
    assert.equal(normalize(Number.NaN), range.default)
    assert.equal(normalize(Number.POSITIVE_INFINITY), range.default)
    assert.equal(normalize(undefined), range.default)
    assert.equal(normalize('abc'), range.default)
    assert.ok(Number.isInteger(normalize(range.min + 0.7)))
  }
})

/**
 * 校验样式对象归一化会补齐缺省字段并拒绝非法值。
 * @returns 无返回值。
 * @author zhenghq
 */
test('样式对象归一化应补齐缺省字段', () => {
  assert.deepEqual(normalizeAnnotationStyle(null), DEFAULT_SCREENSHOT_ANNOTATION_STYLE)
  assert.deepEqual(normalizeAnnotationStyle({ color: 'nope', strokeWidth: 9999, bold: 'yes' }), {
    ...DEFAULT_SCREENSHOT_ANNOTATION_STYLE,
    strokeWidth: SCREENSHOT_ANNOTATION_LIMITS.strokeWidth.max,
    bold: true
  })
})

/**
 * 校验文字标注内容保留空格和换行，仅过滤纯空白输入并限制最大长度。
 * @returns 无返回值。
 * @author zhenghq
 */
test('文字标注内容应保留空白和换行并限制长度', () => {
  assert.equal(normalizeAnnotationText('  你好  '), '  你好  ')
  assert.equal(normalizeAnnotationText('第一行\n第二行'), '第一行\n第二行')
  assert.equal(normalizeAnnotationText('   '), '')
  assert.equal(normalizeAnnotationText(null), '')
  const long = 'a'.repeat(SCREENSHOT_ANNOTATION_LIMITS.maxTextLength + 50)
  assert.equal(normalizeAnnotationText(long).length, SCREENSHOT_ANNOTATION_LIMITS.maxTextLength)
})

/**
 * 校验多行文字边界能够覆盖最长行，供拖动命中和双击编辑使用。
 * @returns 无返回值。
 * @author zhenghq
 */
test('多行文字应计算完整命中区域', () => {
  const style = normalizeAnnotationStyle({ fontSize: 20 })
  const text = createTextAnnotation({ x: 12, y: 24 }, '短\n较长的一行', style)!
  const bounds = getTextAnnotationBounds(text, (line) => line.length * 10)
  assert.deepEqual(bounds, { x: 12, y: 24, width: 50, height: 52 })
})

/**
 * 校验矩形/椭圆标注按拖拽起止点规范化边界并冻结创建时样式。
 * @returns 无返回值。
 * @author zhenghq
 */
test('形状标注应规范化边界并冻结创建时样式', () => {
  const style = normalizeAnnotationStyle({ color: '#34c759', strokeWidth: 6 })
  const rect = createShapeAnnotation('rect', { x: 90, y: 70 }, { x: 30, y: 20 }, style)
  assert.ok(rect)
  assert.equal(rect.type, 'rect')
  assert.deepEqual(rect.bounds, { x: 30, y: 20, width: 60, height: 50 })
  assert.equal(rect.color, '#34c759')
  assert.equal(rect.strokeWidth, 6)

  // 创建后修改样式对象不得影响已有标注
  style.color = '#ff3b30'
  style.strokeWidth = 1
  assert.equal(rect.color, '#34c759')
  assert.equal(rect.strokeWidth, 6)

  const ellipse = createShapeAnnotation('ellipse', { x: 0, y: 0 }, { x: 40, y: 40 }, style)
  assert.ok(ellipse)
  assert.equal(ellipse.type, 'ellipse')
  // 空操作（宽高过小）不生成标注
  assert.equal(createShapeAnnotation('rect', { x: 5, y: 5 }, { x: 6, y: 6 }, style), null)
})

/**
 * 校验箭头、画笔、文字、马赛克标注的构造规则与空操作过滤。
 * @returns 无返回值。
 * @author zhenghq
 */
test('箭头、画笔、文字与马赛克标注应过滤空操作', () => {
  const style = normalizeAnnotationStyle({ color: '#0a84ff', strokeWidth: 3, fontSize: 22, bold: true })

  const arrow = createArrowAnnotation({ x: 10, y: 10 }, { x: 80, y: 40 }, style)
  assert.ok(arrow)
  assert.deepEqual(arrow.start, { x: 10, y: 10 })
  assert.deepEqual(arrow.end, { x: 80, y: 40 })
  assert.equal(createArrowAnnotation({ x: 10, y: 10 }, { x: 11, y: 11 }, style), null)

  const brush = createBrushAnnotation([{ x: 1, y: 1 }, { x: 20, y: 20 }, { x: 40, y: 30 }], style)
  assert.ok(brush)
  assert.equal(brush.type, 'brush')
  assert.ok(brush.points.length >= 2)
  assert.equal(createBrushAnnotation([], style), null)

  const text = createTextAnnotation({ x: 12, y: 24 }, '  重点  ', style)
  assert.ok(text)
  assert.equal(text.text, '  重点  ')
  assert.equal(text.fontSize, 22)
  assert.equal(text.bold, true)
  assert.equal(createTextAnnotation({ x: 12, y: 24 }, '   ', style), null)

  const mosaic = createMosaicAnnotation([{ x: 5, y: 5 }, { x: 30, y: 30 }], style)
  assert.ok(mosaic)
  assert.equal(mosaic.brushSize, style.mosaicBrushSize)
  assert.equal(mosaic.blockSize, style.mosaicBlockSize)
  assert.equal(createMosaicAnnotation([], style), null)
})

/**
 * 校验撤销、重做、清空历史行为与重做栈清空规则。
 * @returns 无返回值。
 * @author zhenghq
 */
test('标注历史应支持撤销、重做与清空', () => {
  const style = normalizeAnnotationStyle(null)
  const store = new ScreenshotAnnotationStore()
  assert.equal(store.canUndo, false)
  assert.equal(store.canRedo, false)
  assert.equal(store.isEmpty(), true)

  const first = createShapeAnnotation('rect', { x: 0, y: 0 }, { x: 30, y: 30 }, style)!
  const second = createArrowAnnotation({ x: 0, y: 0 }, { x: 50, y: 50 }, style)!
  store.add(first)
  store.add(second)
  assert.deepEqual(store.annotations.map((item) => item.type), ['rect', 'arrow'])

  assert.equal(store.undo(), true)
  assert.deepEqual(store.annotations.map((item) => item.type), ['rect'])
  assert.equal(store.canRedo, true)
  assert.equal(store.redo(), true)
  assert.deepEqual(store.annotations.map((item) => item.type), ['rect', 'arrow'])

  // 撤销后新增标注必须清空重做栈
  store.undo()
  const third = createTextAnnotation({ x: 4, y: 4 }, '提示', style)!
  store.add(third)
  assert.equal(store.canRedo, false)
  assert.equal(store.redo(), false)
  assert.deepEqual(store.annotations.map((item) => item.type), ['rect', 'text'])

  // 清空可被撤销恢复
  assert.equal(store.clear(), true)
  assert.equal(store.annotations.length, 0)
  assert.equal(store.clear(), false)
  assert.equal(store.undo(), true)
  assert.equal(store.annotations.length, 2)

  // 新选区重置后历史与重做栈均不可用
  store.reset()
  assert.equal(store.annotations.length, 0)
  assert.equal(store.canUndo, false)
  assert.equal(store.canRedo, false)
})

/**
 * 校验标注数量与画笔点数达到上限后不再无界增长。
 * @returns 无返回值。
 * @author zhenghq
 */
test('标注数量与画笔点数应受上限保护', () => {
  const style = normalizeAnnotationStyle(null)
  const store = new ScreenshotAnnotationStore()
  for (let index = 0; index < SCREENSHOT_ANNOTATION_LIMITS.maxAnnotations + 20; index += 1) {
    store.add(createShapeAnnotation('rect', { x: 0, y: 0 }, { x: 20, y: 20 }, style)!)
  }
  assert.equal(store.annotations.length, SCREENSHOT_ANNOTATION_LIMITS.maxAnnotations)

  const manyPoints = Array.from({ length: SCREENSHOT_ANNOTATION_LIMITS.maxBrushPoints + 500 }, (_, i) => ({
    x: i * 7,
    y: i * 11
  }))
  const brush = createBrushAnnotation(manyPoints, style)!
  assert.ok(brush.points.length <= SCREENSHOT_ANNOTATION_LIMITS.maxBrushPoints)
  const mosaic = createMosaicAnnotation(manyPoints, style)!
  assert.ok(mosaic.points.length <= SCREENSHOT_ANNOTATION_LIMITS.maxBrushPoints)
})
