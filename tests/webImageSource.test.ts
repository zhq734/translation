import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createWebImageSource,
  type WebImageSourceDeps
} from '../src/main/webImageSource.ts'
import type { WebImageCandidate } from '../src/shared/webPageTranslation.ts'

/**
 * 创建图片候选。
 * @param patch 需要覆盖的字段。
 * @returns 图片候选。
 * @author zhenghq
 */
function candidate(patch: Partial<WebImageCandidate> = {}): WebImageCandidate {
  return {
    imageId: 'image-1',
    kind: 'img',
    selector: 'body > img:nth-child(1)',
    rect: { x: 0, y: 0, width: 200, height: 100 },
    naturalWidth: 400,
    naturalHeight: 200,
    src: 'https://example.com/a.png',
    ...patch
  }
}

/**
 * 创建可注入依赖，默认成功返回 1x1 PNG。
 * @param patch 覆盖依赖。
 * @returns 依赖对象与调用记录。
 * @author zhenghq
 */
function deps(patch: Partial<WebImageSourceDeps> = {}): {
  deps: WebImageSourceDeps
  calls: { requested: string[]; captured: number }
} {
  const calls = { requested: [] as string[], captured: 0 }
  const value: WebImageSourceDeps = {
    requestImage: async (url) => {
      calls.requested.push(url)
      return { bytes: Buffer.from([1, 2, 3, 4]), contentType: 'image/png', width: 400, height: 200 }
    },
    captureRegion: async () => {
      calls.captured += 1
      return Buffer.from([5, 6, 7, 8])
    },
    maxBytes: 8 * 1024 * 1024,
    maxPixels: 4_000_000,
    ...patch
  }
  return { deps: value, calls }
}

test('可请求的图片优先走会话请求', async () => {
  const { deps: injected, calls } = deps()
  const source = createWebImageSource(injected)
  const result = await source.fetch(candidate())
  assert.equal(result.ok, true)
  assert.equal(result.strategy, 'session')
  assert.deepEqual(calls.requested, ['https://example.com/a.png'])
  assert.equal(calls.captured, 0)
})

test('Canvas 与内联图片回退区域截图', async () => {
  const { deps: injected, calls } = deps()
  const source = createWebImageSource(injected)
  const canvas = await source.fetch(candidate({ kind: 'canvas', src: undefined }))
  const inline = await source.fetch(candidate({ inline: true, src: 'data:image/png;base64,AAAA' }))
  assert.equal(canvas.strategy, 'capture')
  assert.equal(inline.strategy, 'capture')
  assert.equal(calls.captured, 2)
})

test('会话请求失败时回退区域截图', async () => {
  const { deps: injected, calls } = deps({
    requestImage: async () => {
      throw new Error('network-error')
    }
  })
  const source = createWebImageSource(injected)
  const result = await source.fetch(candidate())
  assert.equal(result.ok, true)
  assert.equal(result.strategy, 'capture')
  assert.equal(calls.captured, 1)
})

test('非图片响应或空字节回退区域截图', async () => {
  const { deps: injected } = deps({
    requestImage: async () => ({ bytes: Buffer.alloc(0), contentType: 'text/html', width: 0, height: 0 })
  })
  const source = createWebImageSource(injected)
  const result = await source.fetch(candidate())
  assert.equal(result.strategy, 'capture')
})

test('超出字节或像素上限的请求结果回退区域截图', async () => {
  const { deps: injected } = deps({
    requestImage: async () => ({ bytes: Buffer.alloc(64), contentType: 'image/png', width: 9000, height: 9000 })
  })
  const source = createWebImageSource(injected)
  const oversizedPixels = await source.fetch(candidate())
  assert.equal(oversizedPixels.strategy, 'capture')

  const { deps: smallLimit } = deps({
    maxBytes: 8,
    requestImage: async () => ({ bytes: Buffer.alloc(64), contentType: 'image/png', width: 400, height: 200 })
  })
  const limited = createWebImageSource(smallLimit)
  const oversizedBytes = await limited.fetch(candidate())
  assert.equal(oversizedBytes.strategy, 'capture')
})

test('截图也失败时返回跳过结果而不是抛错', async () => {
  const { deps: injected } = deps({
    requestImage: async () => {
      throw new Error('blocked')
    },
    captureRegion: async () => {
      throw new Error('capture-failed')
    }
  })
  const source = createWebImageSource(injected)
  const result = await source.fetch(candidate())
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'capture-failed')
})

test('取消信号应阻止取图', async () => {
  const controller = new AbortController()
  controller.abort()
  const { deps: injected, calls } = deps({ signal: controller.signal })
  const source = createWebImageSource(injected)
  const result = await source.fetch(candidate())
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'cancelled')
  assert.equal(calls.requested.length, 0)
  assert.equal(calls.captured, 0)
})

test('截图矩形使用 DIP 坐标，不做设备像素比放大', async () => {
  const captured: unknown[] = []
  const { deps: injected } = deps({
    devicePixelRatio: 2,
    captureRegion: async (rect) => {
      captured.push(rect)
      return Buffer.from([1])
    }
  })
  const source = createWebImageSource(injected)
  await source.fetch(candidate({ kind: 'canvas', src: undefined, rect: { x: 10, y: 20, width: 100, height: 50 } }))
  assert.deepEqual(captured[0], { x: 10, y: 20, width: 100, height: 50 })
})

test('截图前应把文档坐标换算为视口坐标', async () => {
  const captured: unknown[] = []
  const { deps: injected } = deps({
    devicePixelRatio: 1,
    resolveViewport: async () => ({ scrollX: 0, scrollY: 500, width: 1000, height: 800 }),
    captureRegion: async (rect) => {
      captured.push(rect)
      return Buffer.from([1])
    }
  })
  const source = createWebImageSource(injected)
  const visible = await source.fetch(candidate({
    kind: 'canvas',
    src: undefined,
    rect: { x: 10, y: 600, width: 100, height: 50 }
  }))
  assert.equal(visible.ok, true)
  assert.deepEqual(captured[0], { x: 10, y: 100, width: 100, height: 50 })
})

test('视口外候选应滚动取图并恢复原滚动位置', async () => {
  const captured: unknown[] = []
  const scrolls: Array<[number, number]> = []
  let scrollY = 0
  const { deps: injected } = deps({
    devicePixelRatio: 1,
    resolveViewport: async () => ({ scrollX: 0, scrollY, width: 1000, height: 800 }),
    scrollIntoView: async (rect) => {
      scrollY = Math.max(0, rect.y - 100)
      return true
    },
    restoreScroll: async (x, y) => {
      scrolls.push([x, y])
      scrollY = y
    },
    captureRegion: async (rect) => {
      captured.push(rect)
      return Buffer.from([1])
    }
  })
  const source = createWebImageSource(injected)
  const result = await source.fetch(candidate({
    kind: 'canvas',
    src: undefined,
    rect: { x: 10, y: 2000, width: 100, height: 50 }
  }))
  assert.equal(result.ok, true)
  assert.deepEqual(captured[0], { x: 10, y: 100, width: 100, height: 50 })
  assert.deepEqual(scrolls, [[0, 0]])
})

test('视口外候选无法滚动时返回截图失败', async () => {
  const { deps: injected } = deps({
    resolveViewport: async () => ({ scrollX: 0, scrollY: 0, width: 1000, height: 800 })
  })
  const source = createWebImageSource(injected)
  const result = await source.fetch(candidate({
    kind: 'canvas',
    src: undefined,
    rect: { x: 10, y: 2000, width: 100, height: 50 }
  }))
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'capture-failed')
})

test('会话返回 SVG 等位图外格式时应回退区域截图', async () => {
  const { deps: injected, calls } = deps({
    requestImage: async () => ({
      bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      contentType: 'image/svg+xml'
    })
  })
  const source = createWebImageSource(injected)
  const result = await source.fetch(candidate())

  assert.equal(result.ok, true)
  assert.equal(result.strategy, 'capture')
  assert.equal(calls.captured, 1)
})

test('会话返回未知或非图片内容类型时应回退区域截图', async () => {
  const { deps: injected, calls } = deps({
    requestImage: async () => ({ bytes: Buffer.from('<html></html>'), contentType: 'text/html' })
  })
  const source = createWebImageSource(injected)
  const result = await source.fetch(candidate())

  assert.equal(result.ok, true)
  assert.equal(result.strategy, 'capture')
  assert.equal(calls.captured, 1)
})

test('会话返回的位图内容类型仍应优先直接使用', async () => {
  const { deps: injected, calls } = deps({
    requestImage: async () => ({ bytes: Buffer.from([1, 2, 3]), contentType: 'image/webp', width: 400, height: 200 })
  })
  const source = createWebImageSource(injected)
  const result = await source.fetch(candidate())

  assert.equal(result.ok, true)
  assert.equal(result.strategy, 'session')
  assert.equal(calls.captured, 0)
})
