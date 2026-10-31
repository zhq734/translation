import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  DOCUMENT_PDF_MAX_RENDER_PIXELS,
  createDocumentPdfRasterizer,
  createDocumentPdfRasterizerBundle,
  type PdfRasterPage
} from '../src/main/documentPdfRasterizer.ts'
import { createPdfEmbeddedImageExporter } from '../src/main/documentPdfRuntime.ts'

/**
 * 读取项目内源码文件，用于验证运行时桥接契约。
 * @param path 相对项目根目录的文件路径。
 * @returns 文件文本内容。
 * @author zhenghq
 */
function read(path: string): string {
  return readFileSync(path, 'utf8')
}

/** 测试画布接口，避免单元测试依赖原生 canvas。 */
interface TestCanvas {
  /** 画布宽度。 */
  width: number
  /** 画布高度。 */
  height: number
  /** 取得二维上下文。 */
  getContext(type: '2d'): unknown
  /** 编码为 PNG。 */
  toBuffer(type: 'image/png'): Uint8Array
}

/**
 * 创建测试画布工厂。
 * @param events 记录画布创建与渲染事件。
 * @param size 页面渲染像素尺寸。
 * @returns 测试画布工厂。
 * @author zhenghq
 */
function canvasFactory(events: string[], size = { width: 100, height: 200 }) {
  const contexts: Array<{ canvas: TestCanvas }> = []
  return {
    contexts,
    createCanvas(width: number, height: number): TestCanvas {
      events.push(`create:${width}x${height}`)
      const context = {
        canvas: { width, height } as TestCanvas,
        fillStyle: '',
        fillRect: () => undefined,
        drawImage: (image: unknown, ...args: number[]) => {
          events.push(`drawImage:${width}x${height}:${args.join(',')}`)
        }
      }
      const canvas: TestCanvas = {
        width,
        height,
        getContext: () => context,
        toBuffer: () => new Uint8Array([137, 80, 78, 71, size.width, size.height])
      }
      context.canvas = canvas
      contexts.push(context as unknown as { canvas: TestCanvas })
      return canvas
    }
  }
}

/**
 * 创建测试 PDF 页面。
 * @param events 记录渲染事件。
 * @param size 页面视口尺寸。
 * @returns 测试页面。
 * @author zhenghq
 */
function page(events: string[], size = { width: 200, height: 300 }): PdfRasterPage {
  return {
    getViewport: ({ scale }) => ({
      width: size.width * scale,
      height: size.height * scale
    }),
    render: () => ({
      promise: Promise.resolve().then(() => {
        events.push('render')
      }),
      cancel: () => events.push('cancel')
    })
  }
}

test('PDF 栅格化器必须按限制尺寸渲染并输出 PNG', async () => {
  const events: string[] = []
  const factory = canvasFactory(events)
  const rasterize = createDocumentPdfRasterizer({
    createCanvas: factory.createCanvas,
    scale: 1,
    maxPixels: 100_000
  })

  const bytes = await rasterize(page(events), 0)

  assert.deepEqual(bytes, new Uint8Array([137, 80, 78, 71, 100, 200]))
  assert.deepEqual(events, ['create:200x300', 'render'])
})

test('PDF 栅格化器必须限制超大页面的像素总量', async () => {
  const events: string[] = []
  const factory = canvasFactory(events)
  const rasterize = createDocumentPdfRasterizer({
    createCanvas: factory.createCanvas,
    maxPixels: 100
  })

  const bytes = await rasterize(page(events, { width: 200, height: 300 }), 0)

  assert.equal(bytes, null)
  assert.deepEqual(events, [])
})

test('PDF 栅格化器必须在取消后终止渲染并释放画布', async () => {
  const events: string[] = []
  const factory = canvasFactory(events)
  const controller = new AbortController()
  const rasterize = createDocumentPdfRasterizer({
    createCanvas: factory.createCanvas,
    signal: controller.signal
  })

  const pending = rasterize(page(events), 0)
  controller.abort()

  await assert.rejects(pending, /aborted|AbortError/iu)
  assert.equal(events.includes('cancel'), true)
})

test('PDF 栅格化器默认像素上限应足够覆盖 A4 300 DPI 页面', () => {
  const a4At300Dpi = Math.ceil(8.27 * 300) * Math.ceil(11.69 * 300)
  assert.equal(DOCUMENT_PDF_MAX_RENDER_PIXELS >= a4At300Dpi, true)
})

test('PDF 区域裁切器必须复用整页渲染并按缩放比例裁切', async () => {
  const events: string[] = []
  const factory = canvasFactory(events)
  const rasterizer = createDocumentPdfRasterizerBundle({
    createCanvas: factory.createCanvas,
    scale: 2,
    maxPixels: 1_000_000
  })
  const pdfPage = page(events, { width: 200, height: 300 })

  await rasterizer.renderRegion(pdfPage, 0, { x: 10, y: 20, width: 30, height: 40 })
  await rasterizer.renderRegion(pdfPage, 0, { x: 40, y: 60, width: 20, height: 10 })

  assert.deepEqual(events, [
    'create:400x600',
    'render',
    'create:60x80',
    'drawImage:60x80:20,40,60,80,0,0,60,80',
    'create:40x20',
    'drawImage:40x20:80,120,40,20,0,0,40,20'
  ])
})

test('PDF 区域裁切器必须在取消后停止创建画布', async () => {
  const events: string[] = []
  const factory = canvasFactory(events)
  const controller = new AbortController()
  const rasterizer = createDocumentPdfRasterizerBundle({
    createCanvas: factory.createCanvas,
    scale: 1,
    signal: controller.signal
  })
  controller.abort()

  await assert.rejects(
    rasterizer.renderRegion(page(events), 0, { x: 10, y: 10, width: 20, height: 20 }),
    /aborted|AbortError/iu
  )
  assert.deepEqual(events, [])
})

test('PDF 区域裁切器必须拒绝无效或超出页面范围的区域', async () => {
  const events: string[] = []
  const factory = canvasFactory(events)
  const rasterizer = createDocumentPdfRasterizerBundle({
    createCanvas: factory.createCanvas,
    scale: 1
  })
  const pdfPage = page(events, { width: 200, height: 300 })

  assert.equal(await rasterizer.renderRegion(pdfPage, 0, { x: 0, y: 0, width: 0, height: 20 }), null)
  assert.equal(await rasterizer.renderRegion(pdfPage, 0, { x: 300, y: 400, width: 20, height: 20 }), null)
  assert.deepEqual(events, [])
})

test('PDF 内嵌 RGB 图片必须直接导出为完整 PNG，不能依赖整页渲染', async () => {
  const events: string[] = []
  const imageData = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray(8)
  }
  const createCanvas = (width: number, height: number) => {
    events.push(`create:${width}x${height}`)
    const context = {
      createImageData: (imageWidth: number, imageHeight: number) => {
        assert.equal(imageWidth, width)
        assert.equal(imageHeight, height)
        return imageData
      },
      putImageData: (data: typeof imageData, x: number, y: number) => {
        assert.equal(data, imageData)
        events.push(`putImageData:${x}:${y}`)
      },
      drawImage: () => events.push('drawImage')
    }
    return {
      width,
      height,
      getContext: () => context,
      toBuffer: () => new Uint8Array([137, 80, 78, 71, width, height])
    }
  }
  const exporter = createPdfEmbeddedImageExporter(createCanvas)
  const pdfPage = {
    getViewport: () => ({ width: 200, height: 300 }),
    render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
    objs: {
      has: (objectId: string) => objectId === 'img_rgb',
      get: () => ({
        width: 2,
        height: 1,
        kind: 2,
        data: new Uint8ClampedArray([255, 0, 0, 0, 255, 0])
      })
    }
  }

  const bytes = await exporter(pdfPage, 0, 'img_rgb')

  assert.deepEqual(bytes, new Uint8Array([137, 80, 78, 71, 2, 1]))
  assert.deepEqual([...imageData.data], [255, 0, 0, 255, 0, 255, 0, 255])
  assert.deepEqual(events, ['create:2x1', 'putImageData:0:0'])
})

test('PDF 内嵌图片对象尚未解码时必须等待 PDF.js 回调完成', async () => {
  let callback: ((value: unknown) => void) | null = null
  const createCanvas = () => ({
    width: 1,
    height: 1,
    getContext: () => ({
      createImageData: () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) }),
      putImageData: () => undefined,
      drawImage: () => undefined
    }),
    toBuffer: () => new Uint8Array([1])
  })
  const exporter = createPdfEmbeddedImageExporter(createCanvas)
  const pdfPage = {
    getViewport: () => ({ width: 200, height: 300 }),
    render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
    objs: {
      has: () => false,
      get: (_objectId: string, onReady: (value: unknown) => void) => {
        callback = onReady
        return null
      }
    }
  }

  const pending = exporter(pdfPage, 0, 'img_pending')
  assert.equal(callback !== null, true)
  callback!({ width: 1, height: 1, kind: 3, data: new Uint8ClampedArray([1, 2, 3, 4]) })

  assert.deepEqual(await pending, new Uint8Array([1]))
})

test('PDF 内嵌 RGBA 图片必须保留透明通道，单色位图必须回退到整页裁切', async () => {
  const outputs: number[][] = []
  let createdCanvases = 0
  const createCanvas = (width: number, height: number) => ({
    width,
    height,
    getContext: () => ({
      createImageData: () => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: (data: { data: Uint8ClampedArray }) => outputs.push([...data.data]),
      drawImage: () => undefined
    }),
    toBuffer: () => {
      createdCanvases += 1
      return new Uint8Array([1])
    }
  })
  const exporter = createPdfEmbeddedImageExporter(createCanvas)
  const images = new Map<string, unknown>([
    ['rgba', { width: 1, height: 1, kind: 3, data: new Uint8ClampedArray([10, 20, 30, 40]) }],
    ['bitmap', { width: 9, height: 1, kind: 1, data: new Uint8ClampedArray([0b10100000, 0b10000000]) }]
  ])
  const pdfPage = {
    getViewport: () => ({ width: 200, height: 300 }),
    render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
    objs: {
      has: (objectId: string) => images.has(objectId),
      get: (objectId: string) => images.get(objectId)
    }
  }

  await exporter(pdfPage, 0, 'rgba')
  const bitmap = await exporter(pdfPage, 0, 'bitmap')

  assert.deepEqual(outputs[0], [10, 20, 30, 40])
  assert.equal(bitmap, null)
  assert.equal(outputs.length, 1)
  assert.equal(createdCanvases, 1)
})

test('PDF 解析必须向 PDF.js 注入兼容 Canvas 3 的画布工厂', () => {
  const source = read('src/main/documentPdfParser.ts')

  assert.match(source, /function createPdfCanvasFactory\(/u)
  assert.match(source, /canvasFactory:\s*createPdfCanvasFactory\(\)/u)
  assert.match(source, /reset\(entry: PdfCanvasEntry, width: number, height: number\)/u)
  assert.match(source, /destroy\(entry: PdfCanvasEntry\)/u)
})

test('PDF 内嵌图片导出必须在取消后终止等待', async () => {
  const controller = new AbortController()
  const exporter = createPdfEmbeddedImageExporter(() => {
    throw new Error('canvas must not be created after cancellation')
  }, controller.signal)
  const pdfPage = {
    getViewport: () => ({ width: 200, height: 300 }),
    render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
    objs: {
      has: () => false,
      get: () => null
    }
  }

  const pending = exporter(pdfPage, 0, 'img_pending')
  controller.abort()

  await assert.rejects(pending, /aborted|AbortError/iu)
})
