import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')

/**
 * 提取指定名称函数的源码，供回归测试检查生命周期调用。
 * @param name 函数名称。
 * @returns 从函数声明开始到首个顶层结束花括号的源码。
 * @author zhenghq
 */
function extractFunction(name: string): string {
  const start = renderer.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `未找到函数 ${name}`)
  const end = renderer.indexOf('\n}', start)
  assert.ok(end >= 0, `未找到函数 ${name} 的结束位置`)
  return renderer.slice(start, end + 2)
}

test('朗读按钮在译文暂时失效但仍在播放时应保持可停止', () => {
  const syncSpeechButton = extractFunction('syncSpeechButton')

  assert.match(syncSpeechButton, /const disabled\s*=\s*!translation\s*&&\s*!speaking/u)
})

test('翻译状态渲染不得停止正在播放的朗读', () => {
  assert.doesNotMatch(extractFunction('renderManualState'), /stopSpeech\(\)/u)
  assert.doesNotMatch(extractFunction('submitManualTranslation'), /stopSpeech\(\)/u)

  const renderSelection = extractFunction('renderSelection')
  const loadingStart = renderSelection.indexOf('if (payload.loading) {')
  const failureStart = renderSelection.indexOf('if (!payload.ok) {')
  const successStart = renderSelection.indexOf('const sourceName = payload.detectedLang')
  assert.ok(loadingStart >= 0 && failureStart > loadingStart && successStart > failureStart)
  const translationLifecycle = [
    renderSelection.slice(loadingStart, failureStart),
    renderSelection.slice(failureStart, successStart),
    renderSelection.slice(successStart)
  ].join('\n')
  assert.doesNotMatch(translationLifecycle, /stopPronunciationPlayback\(\)/u)
})

test('手动翻译结果回调不得因加载、失败或成功停止正在播放的朗读', () => {
  const callbackStart = renderer.indexOf('window.api.onResult((payload) => {')
  assert.ok(callbackStart >= 0)
  const callbackEnd = renderer.indexOf('\n})', callbackStart)
  assert.ok(callbackEnd > callbackStart)
  const callback = renderer.slice(callbackStart, callbackEnd)

  assert.doesNotMatch(callback, /stopSpeech\(\)/u)
})
