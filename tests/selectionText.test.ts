import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSelectedText } from '../src/shared/selectionText.ts'
import { SelectionCaptureCoordinator } from '../src/shared/selectionCaptureCoordinator.ts'

/**
 * 校验英文句子中的浏览器硬换行会在翻译前合并为空格。
 * @returns 无返回值。
 * @author zhenghq
 */
test('英文整句中的单个硬换行应合并为空格', () => {
  assert.equal(
    normalizeSelectedText('This is a complete\nEnglish sentence selected from a browser.'),
    'This is a complete English sentence selected from a browser.'
  )
})

/**
 * 校验连续硬换行、Windows 换行和行首尾空格都能稳定规范化。
 * @returns 无返回值。
 * @author zhenghq
 */
test('连续软换行和 Windows 换行应合并且不产生重复空格', () => {
  assert.equal(
    normalizeSelectedText('  A sentence can be\r\n  wrapped across\r\nseveral visual lines.  '),
    'A sentence can be wrapped across several visual lines.'
  )
})

/**
 * 校验中文视觉换行合并时不会在汉字之间引入多余空格。
 * @returns 无返回值。
 * @author zhenghq
 */
test('中文整句中的单个硬换行应直接连接', () => {
  assert.equal(normalizeSelectedText('这是一个完整的\n中文句子。'), '这是一个完整的中文句子。')
})

/**
 * 校验段落和列表等语义换行不会被错误压平成一行。
 * @returns 无返回值。
 * @author zhenghq
 */
test('空行分隔的段落和列表项换行应保留', () => {
  assert.equal(
    normalizeSelectedText('First paragraph.\n\nSecond paragraph.'),
    'First paragraph.\n\nSecond paragraph.'
  )
  assert.equal(
    normalizeSelectedText('- First item\n- Second item'),
    '- First item\n- Second item'
  )
})

/**
 * 校验选区协调器会在缓存和翻译前统一规范化捕获文本。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('选区捕获结果应在进入按钮缓存和翻译流程前合并软换行', async () => {
  const coordinator = new SelectionCaptureCoordinator(async () => (
    'This sentence is\nwrapped by the source document.'
  ))

  const result = await coordinator.prepare({ x: 100, y: 100 })

  assert.deepEqual(result, {
    text: 'This sentence is wrapped by the source document.',
    anchor: { x: 100, y: 100 }
  })
  assert.deepEqual(coordinator.consumePrepared(), result)
})
