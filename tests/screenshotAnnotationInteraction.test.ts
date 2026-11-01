import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  ScreenshotAnnotationController,
  SCREENSHOT_ANNOTATION_LIMITS
} from '../src/renderer/src/screenshotAnnotation.ts'
import type {
  ScreenshotAnnotationRect,
  ScreenshotShapeAnnotation,
  ScreenshotTextAnnotation
} from '../src/shared/types.ts'

const selectionRenderer = readFileSync('src/renderer/src/selection.ts', 'utf8')

/** 测试用选区（截图窗口内逻辑坐标）。 */
const selection = { x: 100, y: 100, width: 200, height: 150 }

/**
 * 创建绑定测试选区的标注控制器。
 * @returns 标注控制器实例。
 * @author zhenghq
 */
function createController(): ScreenshotAnnotationController {
  const controller = new ScreenshotAnnotationController()
  controller.setSelection(selection)
  return controller
}

/**
 * 校验默认没有激活标注工具，选择工具后进入标注模式。
 * @returns 无返回值。
 * @author zhenghq
 */
test('默认不激活标注工具，选择工具后接管指针事件', () => {
  const controller = createController()
  assert.equal(controller.tool, null)
  assert.equal(controller.isAnnotating(), false)

  controller.setTool('rect')
  assert.equal(controller.tool, 'rect')
  assert.equal(controller.isAnnotating(), true)

  // 再次点击同一工具取消选择，回到选区移动/缩放模式
  controller.setTool('rect')
  assert.equal(controller.tool, null)
  assert.equal(controller.isAnnotating(), false)
})

/**
 * 校验选区外按下不创建标注，选区内拖拽产生实时预览并提交标注。
 * @returns 无返回值。
 * @author zhenghq
 */
test('标注只在选区内创建并提供实时预览', () => {
  const controller = createController()
  controller.setTool('rect')

  // 选区外按下被拒绝
  assert.equal(controller.beginStroke({ x: 20, y: 20 }), false)
  assert.equal(controller.preview, null)
  assert.equal(controller.annotations.length, 0)

  // 选区内按下并拖拽产生预览
  assert.equal(controller.beginStroke({ x: 120, y: 120 }), true)
  controller.updateStroke({ x: 200, y: 200 })
  assert.ok(controller.preview)
  assert.equal(controller.preview!.type, 'rect')
  // 预览坐标以选区左上角为原点
  assert.deepEqual(controller.preview!.bounds, { x: 20, y: 20, width: 80, height: 80 })
  assert.equal(controller.annotations.length, 0)

  // 抬起后提交为正式标注并清空预览
  assert.equal(controller.endStroke(), true)
  assert.equal(controller.preview, null)
  assert.equal(controller.annotations.length, 1)
  assert.deepEqual(controller.annotations[0]!.bounds, { x: 20, y: 20, width: 80, height: 80 })
})

/**
 * 校验高亮、模糊与聚光灯共用区域拖拽交互，并能提交对应标注。
 * @returns 无返回值。
 * @author zhenghq
 */
test('区域工具应支持拖拽预览并提交高亮、模糊与聚光标注', () => {
  const controller = createController()
  for (const tool of ['highlight', 'blur', 'spotlight'] as const) {
    controller.setTool(tool)
    assert.equal(controller.beginStroke({ x: 120, y: 120 }), true)
    controller.updateStroke({ x: 220, y: 200 })
    assert.equal(controller.preview?.type, tool)
    assert.equal(controller.endStroke(), true)
    assert.equal(controller.annotations.at(-1)?.type, tool)
  }
  assert.equal(controller.annotations.length, 3)
})

/**
 * 校验拖拽超出选区时坐标被裁剪到选区边界内。
 * @returns 无返回值。
 * @author zhenghq
 */
test('拖拽超出选区时标注被裁剪到选区边界', () => {
  const controller = createController()
  controller.setTool('rect')
  controller.beginStroke({ x: 120, y: 120 })
  controller.updateStroke({ x: 10_000, y: 10_000 })
  controller.endStroke()
  const bounds = controller.annotations[0]!.bounds!
  assert.equal(bounds.x + bounds.width, selection.width)
  assert.equal(bounds.y + bounds.height, selection.height)
})

/**
 * 校验 Esc 取消当前未完成绘制而保留已确认标注。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Esc 应取消当前绘制并保留已确认标注', () => {
  const controller = createController()
  controller.setTool('arrow')
  controller.beginStroke({ x: 110, y: 110 })
  controller.updateStroke({ x: 260, y: 200 })
  controller.endStroke()
  assert.equal(controller.annotations.length, 1)

  controller.beginStroke({ x: 120, y: 120 })
  controller.updateStroke({ x: 240, y: 240 })
  assert.ok(controller.preview)
  assert.equal(controller.cancelStroke(), true)
  assert.equal(controller.preview, null)
  assert.equal(controller.annotations.length, 1)
  // 没有进行中的绘制时取消返回 false，交由外层继续处理 Esc（退出截图）
  assert.equal(controller.cancelStroke(), false)
})

/**
 * 校验空操作（点击未拖动）不会产生标注。
 * @returns 无返回值。
 * @author zhenghq
 */
test('未产生位移的绘制不应生成标注', () => {
  const controller = createController()
  controller.setTool('ellipse')
  controller.beginStroke({ x: 150, y: 150 })
  controller.updateStroke({ x: 151, y: 151 })
  assert.equal(controller.endStroke(), false)
  assert.equal(controller.annotations.length, 0)
})

/**
 * 校验形状从零尺寸起笔后仍被识别为进行中的绘制，避免首个 pointermove 被提前丢弃。
 * @returns 无返回值。
 * @author zhenghq
 */
test('形状零尺寸起笔时应保留绘制草稿状态', () => {
  const controller = createController()
  controller.setTool('rect')
  assert.equal(controller.beginStroke({ x: 120, y: 120 }), true)
  assert.equal(controller.isDrawing(), true)
  assert.equal(controller.preview, null)

  controller.updateStroke({ x: 180, y: 160 })
  assert.ok(controller.preview)
  assert.equal(controller.endStroke(), true)
  assert.equal(controller.isDrawing(), false)
  assert.equal(controller.annotations.length, 1)
})

/**
 * 校验文字工具内联编辑：Enter 提交非空文本、Esc 取消、空文本不提交。
 * @returns 无返回值。
 * @author zhenghq
 */
test('文字工具应支持内联编辑提交与取消', () => {
  const controller = createController()
  controller.setTool('text')
  assert.equal(controller.beginText({ x: 30, y: 30 }), false, '选区外不得开始文字编辑')
  assert.equal(controller.beginText({ x: 140, y: 140 }), true)
  assert.deepEqual(controller.textEditorPoint, { x: 40, y: 40 })

  assert.equal(controller.commitText('   '), false)
  assert.equal(controller.annotations.length, 0)

  controller.beginText({ x: 140, y: 140 })
  assert.equal(controller.commitText(' 重点提示 '), true)
  assert.equal(controller.annotations.length, 1)
  assert.equal(controller.annotations[0]!.type, 'text')
  assert.equal(controller.annotations[0]!.text, ' 重点提示 ')
  assert.equal(controller.textEditorPoint, null)

  controller.beginText({ x: 150, y: 150 })
  assert.equal(controller.cancelText(), true)
  assert.equal(controller.textEditorPoint, null)
  assert.equal(controller.annotations.length, 1)

  // 超长文本被限制在最大长度内
  controller.beginText({ x: 150, y: 150 })
  controller.commitText('文'.repeat(SCREENSHOT_ANNOTATION_LIMITS.maxTextLength + 20))
  assert.equal(
    controller.annotations[1]!.text!.length,
    SCREENSHOT_ANNOTATION_LIMITS.maxTextLength
  )
})

/**
 * 校验已有文字可重新编辑并拖动到新的选区内位置，且拖动可被撤销。
 * @returns 无返回值。
 * @author zhenghq
 */
test('已有文字应支持编辑和拖动位置', () => {
  const controller = createController()
  controller.setTool('text')
  controller.beginText({ x: 140, y: 140 })
  assert.equal(controller.commitText('原始文字'), true)
  const annotation = controller.annotations[0] as ScreenshotTextAnnotation

  assert.equal(controller.beginTextEdit(annotation), true)
  assert.equal(controller.textEditorValue, '原始文字')
  assert.equal(controller.commitText('修改后\n第二行'), true)
  assert.equal((controller.annotations[0] as ScreenshotTextAnnotation).text, '修改后\n第二行')

  assert.equal(controller.beginTextMove(controller.annotations[0] as ScreenshotTextAnnotation), true)
  controller.updateTextPosition({ x: 180, y: 190 })
  assert.equal(controller.endTextMove(), true)
  assert.deepEqual((controller.annotations[0] as ScreenshotTextAnnotation).position, { x: 80, y: 90 })
  assert.equal(controller.undo(), true)
  assert.deepEqual((controller.annotations[0] as ScreenshotTextAnnotation).position, { x: 40, y: 40 })
})

/**
 * 校验复制后重新进入截图时不会继承上一次激活的绘制工具。
 * @returns 无返回值。
 * @author zhenghq
 */
test('新截图会话应重置激活的绘制工具', () => {
  const controller = createController()
  controller.setTool('brush')
  assert.equal(controller.tool, 'brush')
  controller.resetForNewSession()
  assert.equal(controller.tool, null)
  assert.equal(controller.annotations.length, 0)
})

/**
 * 校验样式修改只影响后续标注，已有标注保持创建时样式。
 * @returns 无返回值。
 * @author zhenghq
 */
test('样式修改不应影响已有标注', () => {
  const controller = createController()
  controller.setTool('rect')
  controller.setColor('#34c759')
  controller.setStrokeWidth(2)
  controller.beginStroke({ x: 110, y: 110 })
  controller.updateStroke({ x: 180, y: 180 })
  controller.endStroke()

  controller.setColor('#ff3b30')
  controller.setStrokeWidth(8)
  controller.beginStroke({ x: 200, y: 200 })
  controller.updateStroke({ x: 250, y: 240 })
  controller.endStroke()

  assert.equal(controller.annotations[0]!.color, '#34c759')
  assert.equal(controller.annotations[0]!.strokeWidth, 2)
  assert.equal(controller.annotations[1]!.color, '#ff3b30')
  assert.equal(controller.annotations[1]!.strokeWidth, 8)
  // 非法样式值被归一化，不进入标注数据
  controller.setColor('javascript:alert(1)')
  assert.match(controller.style.color, /^#[0-9a-f]{6}$/u)
  controller.setStrokeWidth(Number.NaN)
  assert.ok(Number.isFinite(controller.style.strokeWidth))
})

/**
 * 校验对象命中按从上层向下层顺序返回，并可选中、取消选中与删除。
 * @returns 无返回值。
 * @author zhenghq
 */
test('标注对象应支持命中选择与删除', () => {
  const controller = createController()
  controller.setTool('rect')
  controller.beginStroke({ x: 120, y: 120 })
  controller.updateStroke({ x: 220, y: 220 })
  controller.endStroke()
  controller.setColor('#34c759')
  controller.beginStroke({ x: 140, y: 140 })
  controller.updateStroke({ x: 200, y: 200 })
  controller.endStroke()

  const hit = controller.findAnnotationAt({ x: 60, y: 60 })
  assert.equal(hit, controller.annotations[1])
  assert.equal(controller.selectAnnotation(hit!), true)
  assert.equal(controller.selectedAnnotation, hit)
  assert.deepEqual(controller.selectedAnnotationBounds, {
    x: 40,
    y: 40,
    width: 60,
    height: 60
  })

  assert.equal(controller.deleteSelectedAnnotation(), true)
  assert.equal(controller.annotations.length, 1)
  assert.equal(controller.selectedAnnotation, null)
  assert.equal(controller.undo(), true)
  assert.equal(controller.annotations.length, 2)
  controller.clearSelection()
  assert.equal(controller.selectedAnnotation, null)
})

/**
 * 校验对象拖动、八向缩放、Shift 等比缩放与一次撤销记录。
 * @returns 无返回值。
 * @author zhenghq
 */
test('标注对象应支持拖动、缩放与单次撤销', () => {
  const controller = createController()
  controller.setTool('rect')
  controller.beginStroke({ x: 120, y: 120 })
  controller.updateStroke({ x: 220, y: 200 })
  controller.endStroke()
  const rect = controller.annotations[0] as ScreenshotShapeAnnotation

  assert.equal(controller.selectAnnotation(rect), true)
  assert.equal(controller.beginAnnotationTransform('move'), true)
  controller.updateAnnotationTransform({ x: 150, y: 150 })
  controller.updateAnnotationTransform({ x: 170, y: 160 })
  assert.equal(controller.endAnnotationTransform(), true)
  // 变换坐标以选区左上角为原点：指针从 (50,50) 移到 (70,60)，因此右移 20、下移 10。
  assert.deepEqual(rect.bounds, { x: 40, y: 30, width: 100, height: 80 })
  assert.equal(controller.undo(), true)
  assert.deepEqual((controller.annotations[0] as ScreenshotShapeAnnotation).bounds, {
    x: 20,
    y: 20,
    width: 100,
    height: 80
  })

  assert.equal(controller.selectAnnotation(controller.annotations[0]!), true)
  assert.equal(controller.beginAnnotationTransform('se'), true)
  controller.updateAnnotationTransform({ x: 160, y: 140 })
  assert.equal(controller.endAnnotationTransform(), true)
  assert.deepEqual((controller.annotations[0] as ScreenshotShapeAnnotation).bounds, {
    x: 20,
    y: 20,
    width: 140,
    height: 120
  })

  controller.undo()
  assert.equal(controller.selectAnnotation(controller.annotations[0]!), true)
  assert.equal(controller.beginAnnotationTransform('se'), true)
  controller.updateAnnotationTransform({ x: 160, y: 140 }, true)
  assert.equal(controller.endAnnotationTransform(), true)
  const proportional = (controller.annotations[0] as ScreenshotShapeAnnotation).bounds
  assert.ok(Math.abs(proportional.width / proportional.height - 100 / 80) < 1e-6)
})

/**
 * 校验仅点击选中对象而没有实际位移时，不应写入空撤销记录。
 * @returns 无返回值。
 * @author zhenghq
 */
test('未产生位移的对象变换不应写入撤销历史', () => {
  const controller = createController()
  controller.setTool('rect')
  controller.beginStroke({ x: 120, y: 120 })
  controller.updateStroke({ x: 220, y: 200 })
  controller.endStroke()
  const rect = controller.annotations[0] as ScreenshotShapeAnnotation

  controller.selectAnnotation(rect)
  assert.equal(controller.beginAnnotationTransform('move'), true)
  controller.updateAnnotationTransform({ x: 50, y: 50 })
  assert.equal(controller.endAnnotationTransform(), false)

  // 若空变换被写入历史，这里只会弹出相同快照，标注仍会保留。
  assert.equal(controller.undo(), true)
  assert.equal(controller.annotations.length, 0)
})

/**
 * 校验方向键微调 1 像素、Shift 加速 5 像素，并合并为一次撤销记录。
 * @returns 无返回值。
 * @author zhenghq
 */
test('选中标注应支持方向键微调', () => {
  const controller = createController()
  controller.setTool('rect')
  controller.beginStroke({ x: 120, y: 120 })
  controller.updateStroke({ x: 220, y: 200 })
  controller.endStroke()
  const rect = controller.annotations[0] as ScreenshotShapeAnnotation
  controller.selectAnnotation(rect)

  assert.equal(controller.nudgeSelectedAnnotation(1, 0), true)
  assert.equal(controller.nudgeSelectedAnnotation(0, 1), true)
  assert.equal(controller.nudgeSelectedAnnotation(-1, 0, true), true)
  assert.deepEqual(rect.bounds, { x: 16, y: 21, width: 100, height: 80 })
  assert.equal(controller.undo(), true)
  assert.deepEqual((controller.annotations[0] as ScreenshotShapeAnnotation).bounds, {
    x: 20,
    y: 20,
    width: 100,
    height: 80
  })
})

/**
 * 校验选中对象后修改样式会实时应用，且连续样式修改合并为一次撤销。
 * @returns 无返回值。
 * @author zhenghq
 */
test('选中对象的样式修改应实时应用并合并历史', () => {
  const controller = createController()
  controller.setTool('rect')
  controller.beginStroke({ x: 120, y: 120 })
  controller.updateStroke({ x: 220, y: 200 })
  controller.endStroke()
  const rect = controller.annotations[0] as ScreenshotShapeAnnotation
  controller.selectAnnotation(rect)

  controller.setColor('#34c759')
  controller.setStrokeWidth(7)
  controller.setFilled(true)
  controller.setFillOpacity(0.4)
  controller.setCornerRadius(12)
  assert.equal(rect.color, '#34c759')
  assert.equal(rect.strokeWidth, 7)
  assert.equal(rect.filled, true)
  assert.equal(rect.fillOpacity, 0.4)
  assert.equal(rect.cornerRadius, 12)

  assert.equal(controller.undo(), true)
  const restored = controller.annotations[0] as ScreenshotShapeAnnotation
  assert.equal(restored.color, '#ff3b30')
  assert.equal(restored.strokeWidth, 3)
  assert.equal(restored.filled, false)
  assert.equal(restored.cornerRadius, 0)
})

/**
 * 校验切换选中对象时会先提交上一对象的样式修改，避免两次样式操作合并。
 * @returns 无返回值。
 * @author zhenghq
 */
test('切换选中对象时样式历史应按对象拆分', () => {
  const controller = createController()
  controller.setTool('rect')
  controller.beginStroke({ x: 120, y: 120 })
  controller.updateStroke({ x: 200, y: 180 })
  controller.endStroke()
  controller.setColor('#34c759')
  controller.beginStroke({ x: 220, y: 200 })
  controller.updateStroke({ x: 280, y: 250 })
  controller.endStroke()

  controller.selectAnnotation(controller.annotations[0]!)
  controller.setColor('#0a84ff')
  controller.selectAnnotation(controller.annotations[1]!)
  controller.setColor('#ff9500')

  assert.equal(controller.undo(), true)
  assert.equal(controller.annotations[0]!.color, '#0a84ff')
  assert.equal(controller.annotations[1]!.color, '#34c759')
  assert.equal(controller.undo(), true)
  assert.equal(controller.annotations[0]!.color, '#ff3b30')
  assert.equal(controller.annotations[1]!.color, '#34c759')
})

/**
 * 校验撤销移除当前选中对象后会清理选择状态，重做时也不会悬空选中新对象。
 * @returns 无返回值。
 * @author zhenghq
 */
test('撤销移除选中对象后应清理选择状态', () => {
  const controller = createController()
  controller.setTool('rect')
  controller.beginStroke({ x: 120, y: 120 })
  controller.updateStroke({ x: 180, y: 180 })
  controller.endStroke()
  controller.beginStroke({ x: 220, y: 200 })
  controller.updateStroke({ x: 280, y: 250 })
  controller.endStroke()
  controller.selectAnnotation(controller.annotations[1]!)

  assert.equal(controller.undo(), true)
  assert.equal(controller.selectedAnnotation, null)
  assert.equal(controller.redo(), true)
  assert.equal(controller.selectedAnnotation, null)
})

/**
 * 校验缩放后矩形圆角不会超过短边一半，并且对象不会越出选区。
 * @returns 无返回值。
 * @author zhenghq
 */
test('标注对象变换应保持边界与圆角合法', () => {
  const controller = createController()
  controller.setTool('rect')
  controller.setCornerRadius(40)
  controller.beginStroke({ x: 120, y: 120 })
  controller.updateStroke({ x: 220, y: 200 })
  controller.endStroke()
  const rect = controller.annotations[0] as ScreenshotShapeAnnotation
  controller.selectAnnotation(rect)
  controller.beginAnnotationTransform('se')
  controller.updateAnnotationTransform({ x: 120, y: 120 })
  controller.endAnnotationTransform()
  const bounds = (controller.annotations[0] as ScreenshotShapeAnnotation).bounds
  assert.ok(bounds.x >= 0 && bounds.y >= 0)
  assert.ok(bounds.x + bounds.width <= selection.width)
  assert.ok(bounds.y + bounds.height <= selection.height)
  assert.ok(bounds.width >= 8 && bounds.height >= 8)
})

/**
 * 校验撤销、重做与清空标注在控制器层可用，并同步历史可用状态。
 * @returns 无返回值。
 * @author zhenghq
 */
test('控制器应暴露撤销、重做与清空能力', () => {
  const controller = createController()
  controller.setTool('brush')
  controller.beginStroke({ x: 110, y: 110 })
  controller.updateStroke({ x: 160, y: 150 })
  controller.updateStroke({ x: 200, y: 180 })
  controller.endStroke()
  assert.equal(controller.annotations.length, 1)
  assert.equal(controller.canUndo, true)
  assert.equal(controller.canRedo, false)

  assert.equal(controller.undo(), true)
  assert.equal(controller.annotations.length, 0)
  assert.equal(controller.canRedo, true)
  assert.equal(controller.redo(), true)
  assert.equal(controller.annotations.length, 1)
  assert.equal(controller.clearAnnotations(), true)
  assert.equal(controller.annotations.length, 0)
})

/**
 * 校验重新框选会清空标注、历史与进行中的编辑；选区移动后标注保持相对位置。
 * @returns 无返回值。
 * @author zhenghq
 */
test('新选区应清空标注，选区移动后标注跟随', () => {
  const controller = createController()
  controller.setTool('rect')
  controller.beginStroke({ x: 120, y: 120 })
  controller.updateStroke({ x: 200, y: 200 })
  controller.endStroke()
  const bounds = { ...controller.annotations[0]!.bounds! }

  // 选区移动：相对坐标不变
  controller.setSelection({ x: 400, y: 300, width: selection.width, height: selection.height })
  assert.deepEqual(controller.annotations[0]!.bounds, bounds)
  assert.equal(controller.annotations.length, 1)

  // 重新框选：标注、历史与进行中的文字编辑全部清空
  controller.setTool('text')
  controller.beginText({ x: 420, y: 320 })
  controller.resetForNewSelection({ x: 0, y: 0, width: 120, height: 90 })
  assert.equal(controller.annotations.length, 0)
  assert.equal(controller.canUndo, false)
  assert.equal(controller.canRedo, false)
  assert.equal(controller.preview, null)
  assert.equal(controller.textEditorPoint, null)
})

/**
 * 校验 Renderer 使用 Pointer Events 与指针捕获接入标注交互，并把选区变化同步给标注层。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Renderer 应通过 Pointer Events 接入标注交互', () => {
  assert.match(selectionRenderer, /screenshotAnnotation/u)
  assert.match(selectionRenderer, /addEventListener\('pointerdown', handleAnnotationPointerDown\)/u)
  assert.match(selectionRenderer, /addEventListener\('pointermove', handleAnnotationPointerMove\)/u)
  assert.match(selectionRenderer, /addEventListener\('pointerup', handleAnnotationPointerUp\)/u)
  assert.match(selectionRenderer, /setPointerCapture\(/u)
  // 选区渲染与窗口 resize 都会同步标注画布
  const renderStart = selectionRenderer.indexOf('function renderSelectionRect(')
  const renderEnd = selectionRenderer.indexOf('/**', renderStart + 1)
  const renderSource = selectionRenderer.slice(renderStart, renderEnd)
  assert.match(renderSource, /syncAnnotationCanvas\(\)/u)
  assert.match(selectionRenderer, /function syncAnnotationCanvas\(/u)
  assert.match(selectionRenderer, /devicePixelRatio/u)
  // 标注工具激活时选区内按下不再触发移动或重新框选
  const downStart = selectionRenderer.indexOf('function handleOcrMouseDown')
  const downEnd = selectionRenderer.indexOf('/**', downStart + 1)
  const downSource = selectionRenderer.slice(downStart, downEnd)
  assert.match(downSource, /annotationController\.isAnnotating\(\)/u)
  // Esc 优先取消当前绘制，其次取消截图
  const keyStart = selectionRenderer.indexOf('function handleKeyDown')
  const keyEnd = selectionRenderer.indexOf('\ntranslateButton', keyStart)
  const keySource = selectionRenderer.slice(keyStart, keyEnd)
  assert.match(keySource, /cancelStroke\(\)|cancelAnnotationInput\(\)/u)
})

/**
 * 校验 Renderer 接入高亮、模糊与聚光灯，并为模糊和聚光灯提供底图与视口参数。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Renderer 应接入高亮、模糊和聚光灯的底图合成', () => {
  assert.match(selectionRenderer, /isScreenshotAnnotationTool/u)
  assert.match(selectionRenderer, /getElementById\('ocr-blur-radius'\)/u)
  assert.match(selectionRenderer, /ocrBlurRadius\.addEventListener\('input'/u)
  assert.match(selectionRenderer, /setBlurRadius\(ocrBlurRadius\.value\)/u)
  assert.match(selectionRenderer, /drawSourceRegion:/u)
  assert.match(selectionRenderer, /viewport: \{ width: currentRect\.width, height: currentRect\.height \}/u)
  assert.match(selectionRenderer, /\.filter = `blur\(/u)
})

/**
 * 校验标注绘制移动依据草稿而非有效预览，避免零尺寸起笔时首个移动事件被忽略。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Renderer 标注移动应检查绘制草稿状态', () => {
  const moveStart = selectionRenderer.indexOf('function handleAnnotationPointerMove')
  const moveEnd = selectionRenderer.indexOf('\n}', moveStart)
  const moveSource = selectionRenderer.slice(moveStart, moveEnd)
  assert.doesNotMatch(moveSource, /if \(!annotationController\.preview\) return/u)
  assert.match(moveSource, /isDrawing\(\)/u)
})

/**
 * 校验截图资源加载完成和失败均有明确处理，且导出异常不会静默吞掉。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Renderer 应处理截图加载状态与导出异常', () => {
  // 快照画布不触发 load/error，解码事件由临时 Image 承载。
  assert.match(selectionRenderer, /ocrSnapshotSource\.addEventListener\('load', handleOcrSnapshotLoad\)/u)
  assert.match(selectionRenderer, /ocrSnapshotSource\.addEventListener\('error', handleOcrSnapshotError\)/u)
  assert.match(selectionRenderer, /ocrSnapshotState !== 'ready'/u)
  const copyStart = selectionRenderer.indexOf('function copyCurrentOcrSelectionImage')
  const copyEnd = selectionRenderer.indexOf('\n}', copyStart)
  const copySource = selectionRenderer.slice(copyStart, copyEnd)
  assert.match(copySource, /try/u)
  assert.match(copySource, /showScreenshotToast/u)
  const enterStart = selectionRenderer.indexOf('function enterOcrSelectionMode')
  const enterEnd = selectionRenderer.indexOf('/**', enterStart + 1)
  const enterSource = selectionRenderer.slice(enterStart, enterEnd)
  // 采集中态统一由 updateOcrImageActionAvailability 按快照状态禁用图像动作
  assert.match(enterSource, /updateOcrImageActionAvailability\(\)/u)
  const availabilityStart = selectionRenderer.indexOf('function updateOcrImageActionAvailability')
  const availabilityEnd = selectionRenderer.indexOf('\n}', availabilityStart)
  const availabilitySource = selectionRenderer.slice(availabilityStart, availabilityEnd)
  assert.match(availabilitySource, /ocrCopyImageButton\.disabled = blocked/u)
  assert.match(availabilitySource, /ocrSaveImageButton\.disabled = blocked/u)
})

/**
 * 校验文字工具开始输入时阻止兼容鼠标事件，避免 input 刚聚焦就被覆盖层默认行为抢走焦点。
 * @returns 无返回值。
 * @author zhenghq
 */
test('文字工具开始输入时应阻止覆盖层抢占输入焦点', () => {
  const downStart = selectionRenderer.indexOf('function handleAnnotationPointerDown')
  const downEnd = selectionRenderer.indexOf('\n}', downStart)
  const downSource = selectionRenderer.slice(downStart, downEnd)
  const textStart = downSource.indexOf("annotationController.tool === 'text'")
  assert.ok(textStart >= 0)
  const textSource = downSource.slice(textStart)
  assert.match(textSource, /event\.preventDefault\(\)/u)
  assert.match(textSource, /event\.stopPropagation\(\)/u)
})

/**
 * 校验文字编辑框自身的指针事件不会再次触发覆盖层创建文字或清空已输入内容。
 * @returns 无返回值。
 * @author zhenghq
 */
test('文字编辑框应隔离覆盖层指针事件', () => {
  const pointerStart = selectionRenderer.indexOf('function handleAnnotationPointerDown')
  const pointerEnd = selectionRenderer.indexOf('\n}', pointerStart)
  const pointerSource = selectionRenderer.slice(pointerStart, pointerEnd)
  assert.match(pointerSource, /ocr-text-input/u)

  const mouseStart = selectionRenderer.indexOf('function handleOcrMouseDown')
  const mouseEnd = selectionRenderer.indexOf('/**', mouseStart + 1)
  const mouseSource = selectionRenderer.slice(mouseStart, mouseEnd)
  assert.match(mouseSource, /ocr-text-input/u)
  assert.match(selectionRenderer, /ocrTextInput\.addEventListener\('pointerdown'/u)
  assert.match(selectionRenderer, /ocrTextInput\.addEventListener\('mousedown'/u)
})

/**
 * 校验文字编辑键盘事件不会把空格或回车冒泡为结束截图快捷键。
 * @returns 无返回值。
 * @author zhenghq
 */
test('文字编辑时空格和回车应原样输入而不是提交截图', () => {
  const keyStart = selectionRenderer.indexOf('function handleTextInputKeyDown')
  const keyEnd = selectionRenderer.indexOf('\n}', keyStart)
  const keySource = selectionRenderer.slice(keyStart, keyEnd)
  assert.doesNotMatch(keySource, /event\.key === 'Enter'[\s\S]*?event\.preventDefault\(\)/u)

  const globalStart = selectionRenderer.indexOf('function handleKeyDown')
  const globalEnd = selectionRenderer.indexOf('\n}', globalStart)
  const globalSource = selectionRenderer.slice(globalStart, globalEnd)
  assert.match(globalSource, /event\.target === ocrTextInput/u)
  assert.match(globalSource, /if \(event\.target === ocrTextInput\) return/u)
})

/**
 * 校验文字标注支持双击重新编辑、点击其它位置确认以及拖动位置。
 * @returns 无返回值。
 * @author zhenghq
 */
test('文字标注应支持双击编辑、点击确认和拖动', () => {
  assert.match(selectionRenderer, /event\.detail >= 2/u)
  assert.match(selectionRenderer, /handleAnnotationDoubleClick/u)
  assert.match(selectionRenderer, /beginTextAnnotation/u)
  assert.match(selectionRenderer, /commitTextInput/u)
  assert.match(selectionRenderer, /textMoveState/u)
  assert.match(selectionRenderer, /updateTextPosition/u)
})

/**
 * 校验 Renderer 将指针事件接入对象命中、拖动与八向缩放，并支持方向键微调。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Renderer 应接入对象选择、变换与键盘微调', () => {
  assert.match(selectionRenderer, /ocrAnnotationSelection/u)
  assert.match(selectionRenderer, /data-annotation-handle/u)
  assert.match(selectionRenderer, /findAnnotationAt/u)
  assert.match(selectionRenderer, /beginAnnotationTransform/u)
  assert.match(selectionRenderer, /updateAnnotationTransform/u)
  assert.match(selectionRenderer, /endAnnotationTransform/u)
  assert.match(selectionRenderer, /nudgeSelectedAnnotation/u)
  assert.match(selectionRenderer, /event\.shiftKey/u)
  const keyStart = selectionRenderer.indexOf('function handleKeyDown')
  const keyEnd = selectionRenderer.indexOf('\n}', keyStart)
  const keySource = selectionRenderer.slice(keyStart, keyEnd)
  assert.match(keySource, /ArrowLeft/u)
  assert.match(keySource, /ArrowRight/u)
  assert.match(keySource, /ArrowUp/u)
  assert.match(keySource, /ArrowDown/u)
})

/**
 * 校验选中对象后颜色、线宽、填充与圆角控件会立即同步到标注。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Renderer 样式控件应实时更新选中对象', () => {
  assert.match(selectionRenderer, /setFilled/u)
  assert.match(selectionRenderer, /setFillOpacity/u)
  assert.match(selectionRenderer, /setCornerRadius/u)
  assert.match(selectionRenderer, /ocrFillToggle\.addEventListener/u)
  assert.match(selectionRenderer, /ocrFillOpacity\.addEventListener/u)
  assert.match(selectionRenderer, /ocrCornerRadius\.addEventListener/u)
  assert.match(selectionRenderer, /redrawAnnotations\(\)/u)
})

/**
 * 校验立即型样式控件在修改后提交历史，滑杆在 change 时提交，避免跨对象合并。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Renderer 样式控件应在操作结束时提交历史', () => {
  const colorHandlerStart = selectionRenderer.indexOf('function handleAnnotationColorSelect(')
  const colorHandlerEnd = selectionRenderer.indexOf('\n}', colorHandlerStart) + 2
  assert.ok(colorHandlerStart > -1 && colorHandlerEnd > 1, '缺少颜色选择处理函数')
  assert.match(selectionRenderer.slice(colorHandlerStart, colorHandlerEnd), /commitStyleChange\(\)/u)

  for (const control of [
    'ocrColorCustom',
    'ocrStrokeWidth',
    'ocrFontSize',
    'ocrMosaicBrush',
    'ocrMosaicIntensity',
    'ocrBlurRadius',
    'ocrFillOpacity',
    'ocrCornerRadius'
  ]) {
    assert.match(
      selectionRenderer,
      new RegExp(`${control}\\.addEventListener\\('change',[^\\n]*commitStyleChange\\(\\)`, 'u'),
      `${control} 应在 change 时提交样式历史`
    )
  }
  for (const control of ['ocrFillToggle', 'ocrTextBold']) {
    assert.match(
      selectionRenderer,
      new RegExp(`${control}\\.addEventListener\\('click',[\\s\\S]*?commitStyleChange\\(\\)`, 'u'),
      `${control} 应在点击后提交样式历史`
    )
  }
})

/**
 * 校验选区被清空时会同步隐藏对象选择框，避免残留旧控制柄。
 * @returns 无返回值。
 * @author zhenghq
 */
test('清空选区时应同步隐藏对象选择框', () => {
  const renderStart = selectionRenderer.indexOf('function renderSelectionRect(')
  const renderEnd = selectionRenderer.indexOf('/**', renderStart + 1)
  const renderSource = selectionRenderer.slice(renderStart, renderEnd)
  assert.match(renderSource, /updateAnnotationSelectionBox\(\)/u)
})
