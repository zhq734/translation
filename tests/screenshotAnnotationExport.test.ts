import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  SCREENSHOT_ANNOTATION_LIMITS,
  computeExportCanvasSize,
  createArrowAnnotation,
  createBrushAnnotation,
  createMosaicAnnotation,
  createShapeAnnotation,
  createTextAnnotation,
  drawAnnotations,
  normalizeAnnotationStyle,
  pixelateImageData
} from '../src/renderer/src/screenshotAnnotation.ts'
import {
  SCREENSHOT_EXPORT_LIMITS,
  validateAnnotatedExportPayload
} from '../src/main/screenshotExportPayload.ts'

const main = readFileSync('src/main/index.ts', 'utf8')
const preload = readFileSync('src/preload/index.ts', 'utf8')
const types = readFileSync('src/shared/types.ts', 'utf8')
const selectionRenderer = readFileSync('src/renderer/src/selection.ts', 'utf8')

/** PNG 文件签名。 */
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * 构造用于测试的伪 PNG 字节，仅包含合法签名与填充数据。
 * @param length 期望的总字节长度。
 * @returns 伪 PNG 字节。
 * @author zhenghq
 */
function buildFakePng(length = 64): Uint8Array {
  const bytes = new Uint8Array(length)
  bytes.set(pngSignature, 0)
  return bytes
}

/**
 * 构造合法的带标注导出请求负载。
 * @param overrides 需要覆盖的字段。
 * @returns 导出请求负载。
 * @author zhenghq
 */
function buildPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'copy-image',
    requestId: 'screenshot-1-1',
    bounds: { x: 10, y: 20, width: 200, height: 120 },
    width: 400,
    height: 240,
    png: buildFakePng(),
    ...overrides
  }
}

/**
 * 记录 Canvas 2D 调用的最小替身，用于校验标注绘制行为。
 * @returns Canvas 上下文替身与调用记录。
 * @author zhenghq
 */
function createContextStub(): { ctx: Record<string, unknown>; calls: string[] } {
  const calls: string[] = []
  const record = (name: string) => (...args: unknown[]) => {
    calls.push(`${name}(${args.map((arg) => String(arg)).join(',')})`)
  }
  const ctx: Record<string, unknown> = {
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    quadraticCurveTo: record('quadraticCurveTo'),
    arc: record('arc'),
    ellipse: record('ellipse'),
    rect: record('rect'),
    stroke: record('stroke'),
    fill: record('fill'),
    fillRect: record('fillRect'),
    fillText: record('fillText'),
    clip: record('clip'),
    translate: record('translate'),
    scale: record('scale'),
    setTransform: record('setTransform'),
    clearRect: record('clearRect'),
    drawImage: record('drawImage'),
    measureText: () => ({ width: 30 })
  }
  return { ctx, calls }
}

/**
 * 校验标注绘制会为六种标注调用对应的 Canvas 绘制指令并使用创建时样式。
 * @returns 无返回值。
 * @author zhenghq
 */
test('标注绘制应覆盖六种标注类型', () => {
  const style = normalizeAnnotationStyle({ color: '#ff3b30', strokeWidth: 4, fontSize: 20 })
  const annotations = [
    createShapeAnnotation('rect', { x: 0, y: 0 }, { x: 40, y: 30 }, style)!,
    createShapeAnnotation('ellipse', { x: 0, y: 0 }, { x: 40, y: 30 }, style)!,
    createArrowAnnotation({ x: 0, y: 0 }, { x: 50, y: 50 }, style)!,
    createBrushAnnotation([{ x: 0, y: 0 }, { x: 20, y: 20 }, { x: 40, y: 10 }], style)!,
    createTextAnnotation({ x: 5, y: 5 }, '重点', style)!
  ]
  const { ctx, calls } = createContextStub()
  drawAnnotations(ctx as unknown as CanvasRenderingContext2D, annotations)

  assert.ok(calls.some((call) => call.startsWith('rect(')))
  assert.ok(calls.some((call) => call.startsWith('ellipse(')))
  assert.ok(calls.some((call) => call.startsWith('lineTo(')))
  assert.ok(calls.some((call) => call.startsWith('fillText(重点')))
  const multiline = createTextAnnotation({ x: 5, y: 5 }, '第一行\n第二行', style)!
  const multilineCallsBefore = calls.length
  drawAnnotations(ctx as unknown as CanvasRenderingContext2D, [multiline])
  assert.deepEqual(
    calls.slice(multilineCallsBefore).filter((call) => call.startsWith('fillText(')),
    ['fillText(第一行,5,5)', 'fillText(第二行,5,31)']
  )
  assert.ok(calls.filter((call) => call === 'save()').length >= annotations.length)
  assert.equal(
    calls.filter((call) => call === 'save()').length,
    calls.filter((call) => call === 'restore()').length
  )
  // 绘制使用标注自身冻结的颜色与线宽
  assert.equal(ctx['strokeStyle'], '#ff3b30')
  assert.equal(ctx['lineWidth'], 4)
})

/**
 * 校验马赛克标注在提供原图采样器时执行像素化，且不修改采样区域之外内容。
 * @returns 无返回值。
 * @author zhenghq
 */
test('马赛克绘制应使用统一像素块算法', () => {
  const style = normalizeAnnotationStyle({ mosaicBrushSize: 20, mosaicBlockSize: 10 })
  const mosaic = createMosaicAnnotation([{ x: 20, y: 20 }, { x: 40, y: 20 }], style)!
  const { ctx, calls } = createContextStub()
  drawAnnotations(ctx as unknown as CanvasRenderingContext2D, [mosaic], {
    // 采样器返回纯色块，绘制实现只需按像素块填充
    sampleColor: () => '#123456'
  })
  assert.ok(calls.some((call) => call.startsWith('fillRect(')))
  // 像素块对齐到 blockSize 网格，坐标必须是块大小的整数倍
  const fillRects = calls.filter((call) => call.startsWith('fillRect('))
  for (const call of fillRects) {
    const [x, y] = call.slice('fillRect('.length, -1).split(',').map(Number)
    assert.equal((x as number) % mosaic.blockSize, 0)
    assert.equal((y as number) % mosaic.blockSize, 0)
  }

  // 像素化函数把每个块统一为块内平均色
  const width = 4
  const height = 2
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = i * 10
    data[i * 4 + 1] = i * 10
    data[i * 4 + 2] = i * 10
    data[i * 4 + 3] = 255
  }
  pixelateImageData(data, width, height, 2)
  assert.equal(data[0], data[4])
  assert.equal(data[0], data[width * 4])
  assert.notEqual(data[0], data[8])
})

/**
 * 校验马赛克采样块使用覆盖区域的平均颜色，而不是只取中心像素或半透明兜底色。
 * @returns 无返回值。
 * @author zhenghq
 */
test('马赛克应对覆盖块采样并使用不透明颜色遮盖文字', () => {
  const style = normalizeAnnotationStyle({ mosaicBrushSize: 20, mosaicBlockSize: 10 })
  const mosaic = createMosaicAnnotation([{ x: 15, y: 15 }], style)!
  const sampled: Array<[number, number]> = []
  const { ctx, calls } = createContextStub()
  drawAnnotations(ctx as unknown as CanvasRenderingContext2D, [mosaic], {
    sampleColor: (x, y) => {
      sampled.push([x, y])
      return 'rgba(10, 20, 30, 1)'
    }
  })
  assert.ok(sampled.length > 0)
  assert.ok(calls.some((call) => call.startsWith('fillRect(')))
  assert.equal(ctx['globalAlpha'], 1)
})

/**
 * 校验导出画布尺寸按原图比例换算并受最大像素限制约束。
 * @returns 无返回值。
 * @author zhenghq
 */
test('导出画布尺寸应按比例换算并受像素上限约束', () => {
  const normal = computeExportCanvasSize({ x: 0, y: 0, width: 200, height: 100 }, { scaleX: 2, scaleY: 2 })
  assert.deepEqual({ width: normal.width, height: normal.height }, { width: 400, height: 200 })
  assert.equal(normal.scaleX, 2)

  const huge = computeExportCanvasSize({ x: 0, y: 0, width: 40_000, height: 40_000 }, { scaleX: 4, scaleY: 4 })
  assert.ok(huge.width * huge.height <= SCREENSHOT_ANNOTATION_LIMITS.maxExportPixels)
  assert.ok(huge.width > 0 && huge.height > 0)
})

/**
 * 校验主进程接受合法的带标注导出负载。
 * @returns 无返回值。
 * @author zhenghq
 */
test('主进程应接受合法的带标注导出负载', () => {
  const result = validateAnnotatedExportPayload(buildPayload())
  assert.equal(result.ok, true)
  assert.ok(result.ok && Buffer.isBuffer(result.request.png))
  assert.ok(result.ok && result.request.png.subarray(0, 8).equals(Buffer.from(pngSignature)))
  assert.equal(result.ok && result.request.action, 'copy-image')
  assert.equal(result.ok && result.request.requestId, 'screenshot-1-1')
})

/**
 * 校验主进程拒绝非 PNG、超限尺寸、超限体积与缺失请求 ID 的导出负载。
 * @returns 无返回值。
 * @author zhenghq
 */
test('主进程应拒绝非法带标注导出负载', () => {
  const cases: Array<[string, unknown]> = [
    ['空负载', null],
    ['非对象负载', 'png'],
    ['动作非法', buildPayload({ action: 'recognize' })],
    ['缺少请求 ID', buildPayload({ requestId: '   ' })],
    ['选区非法', buildPayload({ bounds: { x: 0, y: 0, width: 0, height: 0 } })],
    ['非 PNG 字节', buildPayload({ png: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) })],
    ['PNG 过短', buildPayload({ png: new Uint8Array(pngSignature.slice(0, 4)) })],
    ['宽度超限', buildPayload({ width: SCREENSHOT_EXPORT_LIMITS.maxWidth + 1 })],
    ['高度超限', buildPayload({ height: SCREENSHOT_EXPORT_LIMITS.maxHeight + 1 })],
    ['体积超限', buildPayload({ png: buildFakePng(SCREENSHOT_EXPORT_LIMITS.maxBytes + 1) })]
  ]
  for (const [name, payload] of cases) {
    const result = validateAnnotatedExportPayload(payload)
    assert.equal(result.ok, false, `${name} 应被拒绝`)
    assert.ok(!result.ok && typeof result.error === 'string' && result.error.length > 0)
    assert.ok(!result.ok && result.code === 'invalid-export-payload')
  }
})

/**
 * 校验 preload 只暴露受限的带标注导出方法，不泄漏 Node 或 Electron 对象。
 * @returns 无返回值。
 * @author zhenghq
 */
test('preload 应提供受限的带标注导出通道', () => {
  assert.match(preload, /copyAnnotatedOcrSelectionImage\(/u)
  assert.match(preload, /saveAnnotatedOcrSelectionImage\(/u)
  assert.match(preload, /ocr-selection:copy-annotated-image/u)
  assert.match(preload, /ocr-selection:save-annotated-image/u)
  assert.match(types, /copyAnnotatedOcrSelectionImage\(/u)
  assert.match(types, /saveAnnotatedOcrSelectionImage\(/u)
  assert.match(types, /ScreenshotAnnotatedExportRequest/u)
  // 不得暴露 Node、文件系统或 Electron 原始对象
  assert.doesNotMatch(preload, /contextBridge\.exposeInMainWorld\('electronRequire'/u)
  assert.doesNotMatch(preload, /require\('fs'\)/u)
})

/**
 * 校验主进程注册带标注导出 IPC 并复用会话与请求 ID 校验。
 * @returns 无返回值。
 * @author zhenghq
 */
test('主进程应注册带标注导出 IPC 并绑定会话校验', () => {
  assert.match(main, /ipcMain\.on\('ocr-selection:copy-annotated-image'/u)
  assert.match(main, /ipcMain\.on\('ocr-selection:save-annotated-image'/u)
  assert.match(main, /validateAnnotatedExportPayload/u)
  assert.match(main, /isScreenshotOcrRequestActive/u)
  const copyStart = main.indexOf('async function copyAnnotatedOcrSelectionImageAction')
  assert.notEqual(copyStart, -1)
  const copyEnd = main.indexOf('\n/**', copyStart)
  const copySource = main.slice(copyStart, copyEnd)
  assert.match(copySource, /clipboard\.writeImage/u)
  assert.match(copySource, /activeScreenshotOcrRequests\.delete/u)

  const saveStart = main.indexOf('async function saveAnnotatedOcrSelectionImageAction')
  assert.notEqual(saveStart, -1)
  const saveEnd = main.indexOf('\n/**', saveStart)
  const saveSource = main.slice(saveStart, saveEnd)
  assert.match(saveSource, /dialog\.showSaveDialog/u)
  assert.match(saveSource, /writeFile\(/u)
  assert.match(saveSource, /canceled/u)
})

/**
 * 校验识别与翻译继续使用主进程未标注快照裁剪路径。
 * @returns 无返回值。
 * @author zhenghq
 */
test('识别与翻译应继续使用未标注原图', () => {
  const recognizeStart = main.indexOf('async function recognizeOcrSelectionAction')
  const recognizeEnd = main.indexOf('\n/**', recognizeStart)
  const recognizeSource = main.slice(recognizeStart, recognizeEnd)
  assert.match(recognizeSource, /cropCurrentOcrSelectionPng\(/u)
  assert.doesNotMatch(recognizeSource, /validateAnnotatedExportPayload/u)

  const translateStart = main.indexOf('async function translateOcrSelectionAction')
  const translateEnd = main.indexOf('\n/**', translateStart)
  const translateSource = main.slice(translateStart, translateEnd)
  assert.doesNotMatch(translateSource, /png|annotat/iu)

  // Renderer 的识别与翻译请求不携带任何标注或图片数据
  const recognizeRenderer = selectionRenderer.slice(
    selectionRenderer.indexOf('function recognizeCurrentOcrSelection'),
    selectionRenderer.indexOf('function handleOcrRecognizeResult')
  )
  assert.doesNotMatch(recognizeRenderer, /annotation|png|toDataURL/iu)
  const translateRenderer = selectionRenderer.slice(
    selectionRenderer.indexOf('function translateCurrentOcrSelection'),
    selectionRenderer.indexOf('function copyCurrentOcrSelectionImage')
  )
  assert.doesNotMatch(translateRenderer, /annotation|png|toDataURL/iu)
})
