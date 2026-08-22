import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanOcrText } from '../src/shared/ocrText.ts'

/**
 * 校验空值与纯空白输入返回空字符串。
 * @returns 无返回值。
 * @author zhenghq
 */
test('空输入应返回空字符串', () => {
  assert.equal(cleanOcrText(''), '')
  assert.equal(cleanOcrText('   \n\t  '), '')
})

/**
 * 校验零宽字符（BOM、双向控制符等）被移除。
 * @returns 无返回值。
 * @author zhenghq
 */
test('应移除零宽字符与 BOM', () => {
  assert.equal(cleanOcrText('a\u200bb'), 'ab')
  assert.equal(cleanOcrText('\ufeffhello'), 'hello')
  assert.equal(cleanOcrText('a\u200e\u200fb'), 'ab')
})

/**
 * 校验连续竖线（含全角）被收敛为单个。
 * @returns 无返回值。
 * @author zhenghq
 */
test('连续竖线应收敛为单个', () => {
  assert.equal(cleanOcrText('a|||b'), 'a|b')
  assert.equal(cleanOcrText('a｜｜｜b'), 'a|b')
  assert.equal(cleanOcrText('single|pipe'), 'single|pipe')
})

/**
 * 校验连续空格与制表符收敛为单个空格。
 * @returns 无返回值。
 * @author zhenghq
 */
test('连续空白应收敛为单个空格', () => {
  assert.equal(cleanOcrText('a   b\t\tc'), 'a b c')
})

/**
 * 校验行尾标点前的多余空格被移除。
 * @returns 无返回值。
 * @author zhenghq
 */
test('标点前的空格应被移除', () => {
  assert.equal(cleanOcrText('end .'), 'end.')
  assert.equal(cleanOcrText('end  .  '), 'end.')
  assert.equal(cleanOcrText('word , next'), 'word, next')
  assert.equal(cleanOcrText('hello ，world'), 'hello，world')
})

/**
 * 校验空行被过滤且首尾被去除。
 * @returns 无返回值。
 * @author zhenghq
 */
test('空行应被过滤且结果去除首尾空白', () => {
  assert.equal(cleanOcrText('  \n\nline one\n\n\nline two\n  '), 'line one\nline two')
})

/**
 * 校验回车符被移除。
 * @returns 无返回值。
 * @author zhenghq
 */
test('回车符应被移除', () => {
  assert.equal(cleanOcrText('a\rb\nc'), 'ab\nc')
})
