import assert from 'node:assert/strict'
import test from 'node:test'
import { readClipboardImage, type ClipboardLike } from '../src/main/clipboardImage.ts'

/**
 * 构造测试用剪贴板。
 * @param hasImage 是否包含图片。
 * @param text 剪贴板文本。
 * @returns 剪贴板对象。
 * @author zhenghq
 */
function makeClipboard(hasImage: boolean, text = ''): ClipboardLike {
  return {
    readImage: () => ({
      isEmpty: () => !hasImage,
      toPNG: () => Buffer.from([1, 2, 3])
    }),
    readText: () => text
  }
}

/**
 * 校验剪贴板含图片时返回 PNG 字节。
 * @returns 无返回值。
 * @author zhenghq
 */
test('剪贴板含图片应返回 image 与 PNG 字节', () => {
  const result = readClipboardImage(makeClipboard(true, 'some text'))
  assert.equal(result.kind, 'image')
  assert.deepEqual(result.png, Buffer.from([1, 2, 3]))
})

/**
 * 校验剪贴板仅含文本时返回 text 且不进入 OCR。
 * @returns 无返回值。
 * @author zhenghq
 */
test('剪贴板仅含文本应返回 text', () => {
  const result = readClipboardImage(makeClipboard(false, 'hello'))
  assert.equal(result.kind, 'text')
  assert.equal(result.png, undefined)
})

/**
 * 校验剪贴板为空时返回 empty。
 * @returns 无返回值。
 * @author zhenghq
 */
test('剪贴板为空应返回 empty', () => {
  const result = readClipboardImage(makeClipboard(false, '   '))
  assert.equal(result.kind, 'empty')
})
