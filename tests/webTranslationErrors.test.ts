import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isDisposedWebFrameError,
  normalizeWebTranslationError
} from '../src/shared/webTranslationErrors'

test('网页翻译错误应移除 Electron invoke 前缀并保留中文提示', () => {
  const error = new Error(
    "Error invoking remote method 'web-translate:extract': Error: 请先打开一个 HTTP 或 HTTPS 网页"
  )

  assert.equal(normalizeWebTranslationError(error, '网页翻译失败'), '请先打开一个 HTTP 或 HTTPS 网页')
})

test('网页翻译错误归一化应支持普通错误和兜底提示', () => {
  assert.equal(normalizeWebTranslationError(new Error('页面内容已更新'), '网页翻译失败'), '页面内容已更新')
  assert.equal(normalizeWebTranslationError(null, '网页翻译失败'), '网页翻译失败')
})

test('应识别远程主 frame 已销毁的瞬态 Electron 错误', () => {
  assert.equal(
    isDisposedWebFrameError(new Error('Render frame was disposed before WebFrameMain could be accessed')),
    true
  )
  assert.equal(isDisposedWebFrameError(new Error('普通翻译失败')), false)
})
