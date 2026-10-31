import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DocumentImageSecurityError,
  parseImageDocument
} from '../src/main/documentImageParser.ts'
import { detectDocumentFormat, getDocumentCapabilities } from '../src/shared/documentFormat.ts'

/**
 * 构造最小 PNG 文件头，供格式探测与解析测试复用。
 * @param width 图片像素宽度。
 * @param height 图片像素高度。
 * @returns 含签名与 IHDR 尺寸的 PNG 字节。
 * @author zhenghq
 */
function pngBytes(width = 320, height = 200): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width, false)
  view.setUint32(20, height, false)
  return bytes
}

test('图片扩展名与文件头探测统一返回 image 格式', () => {
  const cases: Array<[string, Uint8Array]> = [
    ['scan.png', pngBytes()],
    ['photo.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])],
    ['photo.jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 0])],
    ['anim.gif', new TextEncoder().encode('GIF89a')],
    ['legacy.gif', new TextEncoder().encode('GIF87a')],
    ['bitmap.bmp', new Uint8Array([0x42, 0x4d, 0, 0, 0, 0])],
    ['photo.webp', new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])]
  ]
  for (const [fileName, head] of cases) {
    const detected = detectDocumentFormat(fileName, head)
    assert.equal(detected.ok, true, fileName)
    assert.equal(detected.ok ? detected.format : null, 'image', fileName)
  }
  assert.equal(getDocumentCapabilities('image').ocrEmbeddedImages, true)
  assert.equal(getDocumentCapabilities('image').nativeLayout, false)
  assert.equal(getDocumentCapabilities('image').exportPdf, true)
})

test('图片文件头不匹配扩展名时拒绝为无效文件头', () => {
  const result = detectDocumentFormat('fake.png', new TextEncoder().encode('not an image'))
  assert.deepEqual(result, { ok: false, code: 'invalid-header', format: 'image' })
})

test('无扩展名图片按文件头嗅探为 image', () => {
  const result = detectDocumentFormat('unknown', pngBytes())
  assert.equal(result.ok, true)
  assert.equal(result.ok ? result.format : null, 'image')
})

test('解析 PNG 生成单页图片区块并登记资源字节', async () => {
  const bytes = pngBytes(640, 480)
  const registered = new Map<string, Uint8Array>()
  const model = await parseImageDocument({
    path: '/tmp/scan.png',
    fileName: 'scan.png',
    format: 'image',
    sha256: 'fixture-sha256',
    bytes
  }, (assetId, content) => {
    registered.set(assetId, content)
  })

  assert.equal(model.source.format, 'image')
  assert.equal(model.pages.length, 1)
  const page = model.pages[0]!
  assert.equal(page.width, 640)
  assert.equal(page.height, 480)
  assert.equal(page.blocks.length, 1)
  const block = page.blocks[0]!
  assert.equal(block.kind, 'image')
  assert.equal(block.kind === 'image' ? block.assetId : '', model.assets[0]!.assetId)
  assert.equal(model.assets.length, 1)
  assert.equal(model.assets[0]!.mimeType, 'image/png')
  assert.equal(registered.get(model.assets[0]!.assetId), bytes)
})

test('独立图片像素超过上限时必须拒绝解析且不得登记资源', async () => {
  const bytes = pngBytes(5_000, 5_000)
  let registerCalls = 0
  await assert.rejects(
    parseImageDocument({
      path: '/tmp/huge.png',
      fileName: 'huge.png',
      format: 'image',
      sha256: 'fixture-sha256',
      bytes
    }, () => {
      registerCalls += 1
    }),
    (error: unknown) => {
      assert.equal(error instanceof DocumentImageSecurityError, true)
      assert.equal((error as DocumentImageSecurityError).code, 'image-pixel-limit-reached')
      return true
    }
  )
  assert.equal(registerCalls, 0)
})
