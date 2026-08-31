import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeAiTranslation } from '../src/shared/aiTranslationSanitize.ts'
import { parseAiTranslationResponse } from '../src/main/aiProtocol.ts'

test('应移除工具调用与其后的调度指令片段，只保留译文', () => {
  const raw = 'search("Auto-reviewer approved codex to run")fast|translate phrase 你好，世界'
  assert.equal(sanitizeAiTranslation(raw), '你好，世界')
})

test('应移除独占一行的工具调用噪声行', () => {
  const raw = 'search("Auto-reviewer approved codex to run")fast|translate phrase\n你好，世界'
  assert.equal(sanitizeAiTranslation(raw), '你好，世界')
})

test('应移除译文之后追加的工具调用噪声', () => {
  const raw = '你好，世界\nsearch("Auto-reviewer approved codex to run")fast|translate sentence'
  assert.equal(sanitizeAiTranslation(raw), '你好，世界')
})

test('应移除 think 等推理块', () => {
  const raw = '<think>先分析句子结构</think>\n你好，世界'
  assert.equal(sanitizeAiTranslation(raw), '你好，世界')
  assert.equal(sanitizeAiTranslation('<thinking>reasoning</thinking>你好'), '你好')
})

test('应去掉包裹译文的 Markdown 代码块与译文标签', () => {
  assert.equal(sanitizeAiTranslation('```\n你好，世界\n```'), '你好，世界')
  assert.equal(sanitizeAiTranslation('```text\n你好，世界\n```'), '你好，世界')
  assert.equal(sanitizeAiTranslation('译文：你好，世界'), '你好，世界')
  assert.equal(sanitizeAiTranslation('Translation: hello world'), 'hello world')
})

test('不应破坏正常译文中的括号、竖线和普通英文单词', () => {
  assert.equal(sanitizeAiTranslation('快速排序（quick sort）是一种排序算法'), '快速排序（quick sort）是一种排序算法')
  assert.equal(sanitizeAiTranslation('A | B | C'), 'A | B | C')
  assert.equal(sanitizeAiTranslation('fast food is not healthy'), 'fast food is not healthy')
  assert.equal(sanitizeAiTranslation('调用 myFunction(1, 2) 即可'), '调用 myFunction(1, 2) 即可')
})

test('应保留多行译文并去除首尾空白与空行', () => {
  assert.equal(sanitizeAiTranslation('\n\n第一行\n\n第二行\n\n'), '第一行\n\n第二行')
})

test('全部内容均为噪声时应返回空字符串', () => {
  assert.equal(sanitizeAiTranslation('search("Auto-reviewer approved codex to run")fast|translate phrase'), '')
})

test('空输入应安全返回空字符串', () => {
  assert.equal(sanitizeAiTranslation(''), '')
  assert.equal(sanitizeAiTranslation(null as unknown as string), '')
})

test('协议响应解析应输出已清洗的译文', () => {
  const noisy = 'search("Auto-reviewer approved codex to run")fast|translate phrase 你好'
  assert.equal(parseAiTranslationResponse('ollama', { message: { content: noisy } }), '你好')
  assert.equal(parseAiTranslationResponse('openai', { choices: [{ message: { content: noisy } }] }), '你好')
  assert.equal(
    parseAiTranslationResponse('claude-code', { content: [{ type: 'text', text: '<think>x</think>你' }, { type: 'text', text: '好' }] }),
    '你好'
  )
})
