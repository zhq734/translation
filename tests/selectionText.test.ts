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
 * 校验连续软换行和行首尾空格都能稳定规范化。
 * @returns 无返回值。
 * @author zhenghq
 */
test('连续软换行应合并且不产生重复空格', () => {
  assert.equal(
    normalizeSelectedText('  A sentence can be\n  wrapped across\nseveral visual lines.  '),
    'A sentence can be wrapped across several visual lines.'
  )
})

/**
 * 校验 Windows 划词复制产生的 CRLF 会保留为逻辑换行，避免多行原文被压成一行。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 多行选区的 CRLF 换行应保留', () => {
  assert.equal(
    normalizeSelectedText('第一行内容\r\n第二行内容\r\nThird line'),
    '第一行内容\n第二行内容\nThird line'
  )
})

/**
 * 校验 Windows 剪贴板只用单个 CRLF 分隔完整段落时不会被误判为视觉软换行。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 单个换行分隔的完整段落应保留段落边界', () => {
  assert.equal(
    normalizeSelectedText('First paragraph ends here.\r\nSecond paragraph starts here.'),
    'First paragraph ends here.\nSecond paragraph starts here.'
  )
})

/**
 * 校验 Windows 选区末尾的 CRLF 不会把内部换行标记泄漏到最终文本。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 选区末尾带空格或连续 CRLF 时不应出现私有区字符', () => {
  assert.equal(normalizeSelectedText('hello  \r\n'), 'hello')
  assert.equal(normalizeSelectedText('hello \r\n\r\n'), 'hello')
})

/**
 * 校验 Windows 多行选区在去除行尾空格后仍保留逻辑换行。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 多行选区的行尾空格不应污染下一行', () => {
  assert.equal(normalizeSelectedText('hello \r\nworld  '), 'hello\nworld')
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
 * 校验 IDEA 等编辑器选中的无缩进代码不会被当成浏览器视觉软换行合并。
 * @returns 无返回值。
 * @author zhenghq
 */
test('无缩进代码选区的换行应完整保留', () => {
  assert.equal(
    normalizeSelectedText('function foo() {\nconst a = 1\nconst b = 2\nreturn a + b\n}'),
    'function foo() {\nconst a = 1\nconst b = 2\nreturn a + b\n}'
  )
})

/**
 * 校验两空格缩进的 JSON / 脚本代码换行与缩进都应保留。
 * @returns 无返回值。
 * @author zhenghq
 */
test('两空格缩进代码选区的换行与缩进应完整保留', () => {
  assert.equal(
    normalizeSelectedText('if (ready) {\n  start()\n} else {\n  stop()\n}'),
    'if (ready) {\n  start()\n} else {\n  stop()\n}'
  )
  assert.equal(
    normalizeSelectedText('{\n  "name": "demo",\n  "version": 1\n}'),
    '{\n  "name": "demo",\n  "version": 1\n}'
  )
})

/**
 * 校验多行 SQL 选区的换行应完整保留。
 * @returns 无返回值。
 * @author zhenghq
 */
test('SQL 多行选区的换行应完整保留', () => {
  assert.equal(
    normalizeSelectedText('SELECT id, name\nFROM users\nWHERE id = 1'),
    'SELECT id, name\nFROM users\nWHERE id = 1'
  )
})

/**
 * 校验带类型声明的代码行（如 Java / C# 局部变量）也会被识别为代码选区。
 * @returns 无返回值。
 * @author zhenghq
 */
test('带类型声明的两行代码选区换行应完整保留', () => {
  assert.equal(
    normalizeSelectedText('String name = "demo"\nint count = 1'),
    'String name = "demo"\nint count = 1'
  )
})

/**
 * 校验 Windows CRLF 代码选区不会因换行标记而漏判，且结果使用 LF 换行。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows CRLF 代码选区的换行应完整保留', () => {
  assert.equal(
    normalizeSelectedText('public class Foo {\r\n    private int a;\r\n    private int b;\r\n}'),
    'public class Foo {\n    private int a;\n    private int b;\n}'
  )
})

/**
 * 校验带缩进的普通文本仍会按浏览器视觉软换行合并，避免代码识别误伤散文。
 * @returns 无返回值。
 * @author zhenghq
 */
test('带缩进的普通文本仍应合并软换行', () => {
  assert.equal(
    normalizeSelectedText('  A sentence can be\n  wrapped across\nseveral visual lines.  '),
    'A sentence can be wrapped across several visual lines.'
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
