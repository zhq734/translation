import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  ScreenshotAnnotationController,
  normalizeMosaicBlockSize,
  normalizeMosaicIntensity,
  computeMosaicBlocks
} from '../src/renderer/src/screenshotAnnotation.ts'

const selectionHtml = readFileSync('src/renderer/selection.html', 'utf8')
const selectionRenderer = readFileSync('src/renderer/src/selection.ts', 'utf8')
const selectionCss = readFileSync('src/renderer/src/selection.css', 'utf8')

/** 测试用选区。 */
const selection = { x: 100, y: 100, width: 240, height: 160 }

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
 * 校验截图工具栏为微信风格三段结构，图标按钮为 36px 且支持窄屏换行。
 * @returns 无返回值。
 * @author zhenghq
 */
test('微信风格工具栏应采用三段结构与 36px 图标按钮', () => {
  const groups = [
    'annotation-tools',
    'annotation-style',
    'screenshot-actions'
  ]
  for (const group of groups) {
    assert.match(
      selectionHtml,
      new RegExp(`data-group="${group}"`, 'u'),
      `缺少工具栏分组 ${group}`
    )
  }

  assert.match(selectionCss, /\.ocr-toolbar\s*\{[^}]*gap:\s*8px/su)
  assert.match(selectionCss, /\.ocr-toolbar-group\s*\{[^}]*gap:\s*6px/su)
  assert.match(
    selectionCss,
    /\.ocr-toolbar button\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px/su,
    '工具栏按钮应为 36px'
  )
  assert.match(selectionCss, /\.ocr-toolbar\s*\{[^}]*flex-wrap:\s*wrap/su)
  assert.match(
    selectionCss,
    /\.ocr-toolbar-group\s*\+\s*\.ocr-toolbar-group\s*\{[^}]*border-left/su
  )
  // 标注层必须位于选区框之上，避免矩形/椭圆/箭头被选区框遮挡
  assert.match(
    selectionCss,
    /\.ocr-annotation-canvas,\s*\.ocr-annotation-preview\s*\{[^}]*z-index:\s*[45]/su
  )
  assert.match(selectionCss, /\.ocr-annotation-preview\s*\{[^}]*z-index:\s*5/su)
})

/**
 * 校验标注工具支持“进行中输入 → 工具 → 截图窗口”的 Esc 分层退出。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Esc 应先取消输入再退出工具最后退出截图', () => {
  const controller = createController()
  controller.setTool('rect')
  assert.equal(controller.tool, 'rect')

  // 第一层：取消进行中的绘制，但保留工具
  controller.beginStroke({ x: 120, y: 120 })
  controller.updateStroke({ x: 220, y: 190 })
  assert.equal(controller.cancelAnnotationInput(), true)
  assert.equal(controller.tool, 'rect')

  // 第二层：没有进行中输入时退出工具
  assert.equal(controller.deactivateTool(), true)
  assert.equal(controller.tool, null)

  // 第三层由 Renderer 继续处理并退出截图窗口
  const keyStart = selectionRenderer.indexOf('function handleKeyDown')
  const keyEnd = selectionRenderer.indexOf('\n/**', keyStart)
  const keySource = selectionRenderer.slice(keyStart, keyEnd)
  assert.match(keySource, /cancelAnnotationInput\(\)/u)
  assert.match(keySource, /deactivateTool\(\)/u)
  assert.match(keySource, /cancelOcrSelection\(\)/u)
})

/**
 * 校验标注工具激活时选区边缘仍优先响应缩放，选区内部才用于绘制。
 * @returns 无返回值。
 * @author zhenghq
 */
test('标注工具激活时选区边缘应优先响应缩放', () => {
  const downStart = selectionRenderer.indexOf('function handleOcrMouseDown')
  const downEnd = selectionRenderer.indexOf('\n/**', downStart)
  const downSource = selectionRenderer.slice(downStart, downEnd)

  assert.match(downSource, /isNearSelectionEdge\(/u)
  const edgeStart = selectionRenderer.indexOf('function isNearSelectionEdge')
  const edgeEnd = selectionRenderer.indexOf('\n/**', edgeStart)
  const edgeSource = selectionRenderer.slice(edgeStart, edgeEnd)
  assert.match(edgeSource, /ANNOTATION_SELECTION_EDGE_SIZE/u)
  assert.doesNotMatch(
    downSource,
    /if \(annotationController\.isAnnotating\(\)\) return/u,
    '工具激活时不得直接放弃边缘缩放'
  )
})

/**
 * 校验上下文样式矩阵：马赛克不显示颜色，文字显示字号与加粗。
 * @returns 无返回值。
 * @author zhenghq
 */
test('上下文样式矩阵应隐藏马赛克颜色控件', () => {
  const uiStart = selectionRenderer.indexOf('function updateAnnotationUi')
  const uiEnd = selectionRenderer.indexOf('\n/**', uiStart)
  const uiSource = selectionRenderer.slice(uiStart, uiEnd)

  assert.match(uiSource, /ocrColorToggle\.hidden = tool === 'mosaic'/u)
  assert.match(uiSource, /ocrStrokeWidth\.hidden = tool === 'text' \|\| tool === 'mosaic'/u)
  assert.match(uiSource, /ocrFontSize\.hidden = tool !== 'text'/u)
  assert.match(uiSource, /ocrMosaicBrush\.hidden = tool !== 'mosaic'/u)
  assert.match(uiSource, /ocrMosaicIntensity\.hidden = tool !== 'mosaic'/u)
  assert.match(selectionHtml, /aria-label="马赛克强度"/u)
})

/**
 * 校验文字输入支持 blur 提交非空文本并保留连续输入能力。
 * @returns 无返回值。
 * @author zhenghq
 */
test('文字输入应在 blur 时提交非空文本', () => {
  const controller = createController()
  controller.setTool('text')
  assert.equal(controller.beginText({ x: 120, y: 120 }), true)

  assert.equal(controller.commitText('  '), false)
  assert.equal(controller.textEditorPoint, null)

  controller.beginText({ x: 120, y: 120 })
  assert.equal(controller.commitText(' 重点 '), true)
  assert.equal(controller.textEditorPoint, null)
  assert.equal(controller.tool, 'text', '提交文字后应保持文字工具')

  assert.match(selectionRenderer, /addEventListener\('blur', handleTextInputBlur\)/u)
  const blurStart = selectionRenderer.indexOf('function handleTextInputBlur')
  const blurEnd = selectionRenderer.indexOf('\n/**', blurStart)
  const blurSource = selectionRenderer.slice(blurStart, blurEnd)
  assert.match(blurSource, /commitText\(ocrTextInput\.value\)/u)
})

/**
 * 校验马赛克强度映射为有限像素块大小，并冻结到标注数据。
 * @returns 无返回值。
 * @author zhenghq
 */
test('马赛克强度应映射为有限像素块大小', () => {
  assert.equal(normalizeMosaicBlockSize('weak'), 6)
  assert.equal(normalizeMosaicBlockSize('medium'), 10)
  assert.equal(normalizeMosaicBlockSize('strong'), 16)
  assert.equal(normalizeMosaicBlockSize('unknown'), 10)
  // HTML range 传递的是数字字符串，必须映射到弱/中/强档位
  assert.equal(normalizeMosaicIntensity('1'), 6)
  assert.equal(normalizeMosaicIntensity('2'), 10)
  assert.equal(normalizeMosaicIntensity('3'), 16)

  const controller = createController()
  controller.setTool('mosaic')
  controller.setMosaicIntensity('strong')
  assert.equal(controller.style.mosaicBlockSize, 16)

  controller.beginStroke({ x: 130, y: 130 })
  controller.updateStroke({ x: 220, y: 180 })
  controller.endStroke()
  assert.equal(controller.annotations[0]!.blockSize, 16)
})

/**
 * 校验马赛克块计算可基于原图采样颜色并覆盖笔刷轨迹。
 * @returns 无返回值。
 * @author zhenghq
 */
test('马赛克块应覆盖笔刷轨迹并可采样原图颜色', () => {
  const blocks = computeMosaicBlocks(
    [
      { x: 20, y: 20 },
      { x: 80, y: 60 }
    ],
    28,
    10
  )
  assert.ok(blocks.length > 0)
  assert.deepEqual(blocks[0], { x: 10, y: 10 })
  assert.ok(blocks.some((block) => block.x >= 70 && block.y >= 50))

  // 原图采样器必须由预览和导出共同使用，不再返回固定灰色。
  assert.match(selectionRenderer, /createSnapshotSampler\(/u)
  assert.match(selectionRenderer, /sampleColor: sampleSnapshotColor/u)
  assert.doesNotMatch(selectionRenderer, /rgba\(128,128,128,0\.9\)/u)
})

/**
 * 校验标注模式会关闭选区框自身指针事件，避免选区框拦截绘制输入。
 * @returns 无返回值。
 * @author zhenghq
 */
test('标注模式应避免选区框拦截绘制输入', () => {
  const uiStart = selectionRenderer.indexOf('function updateAnnotationUi')
  const uiEnd = selectionRenderer.indexOf('\n/**', uiStart)
  const uiSource = selectionRenderer.slice(uiStart, uiEnd)
  assert.match(
    uiSource,
    /ocrSelectionBox\.style\.pointerEvents = tool \? 'none' : 'auto'/u
  )
})
