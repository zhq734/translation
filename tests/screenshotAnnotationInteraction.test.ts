import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  ScreenshotAnnotationController,
  SCREENSHOT_ANNOTATION_LIMITS
} from '../src/renderer/src/screenshotAnnotation.ts'
import type { ScreenshotTextAnnotation } from '../src/shared/types.ts'

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
  assert.match(selectionRenderer, /ocrSnapshot\.addEventListener\('load', handleOcrSnapshotLoad\)/u)
  assert.match(selectionRenderer, /ocrSnapshot\.addEventListener\('error', handleOcrSnapshotError\)/u)
  assert.match(selectionRenderer, /ocrSnapshotState !== 'ready'/u)
  const copyStart = selectionRenderer.indexOf('function copyCurrentOcrSelectionImage')
  const copyEnd = selectionRenderer.indexOf('\n}', copyStart)
  const copySource = selectionRenderer.slice(copyStart, copyEnd)
  assert.match(copySource, /try/u)
  assert.match(copySource, /showScreenshotToast/u)
  const enterStart = selectionRenderer.indexOf('function enterOcrSelectionMode')
  const enterEnd = selectionRenderer.indexOf('/**', enterStart + 1)
  const enterSource = selectionRenderer.slice(enterStart, enterEnd)
  assert.match(enterSource, /ocrCopyImageButton\.disabled = ocrSnapshotState !== 'ready'/u)
  assert.match(enterSource, /ocrSaveImageButton\.disabled = ocrSnapshotState !== 'ready'/u)
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
