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

/**
 * 校验 URL/JDBC 连接串中的全角点号、冒号与多余空格被恢复为半角符号。
 * @returns 无返回值。
 * @author zhenghq
 */
test('URL 与 JDBC 连接串中的全角标点应恢复为半角', () => {
  const raw = 'jdbc:kingbase8://17 ． 1 ． 87 ． 69： 54321 /admin-'
  assert.equal(
    cleanOcrText(raw),
    'jdbc:kingbase8://17.1.87.69:54321/admin-'
  )
})

/**
 * 校验 URL 归一化不会误改普通中文句子中的全角标点。
 * @returns 无返回值。
 * @author zhenghq
 */
test('普通中文文本中的全角标点应保持不变', () => {
  assert.equal(cleanOcrText('你好，世界。'), '你好，世界。')
  assert.equal(cleanOcrText('参数：值'), '参数：值')
})

/**
 * 校验 URL 归一化不会删除 URL 后中文说明中的词间空格。
 * @returns 无返回值。
 * @author zhenghq
 */
test('URL 后的中文说明应保留正常空格', () => {
  assert.equal(
    cleanOcrText('访问 https://example ． com 查看 文档'),
    '访问 https://example.com 查看 文档'
  )
})

/**
 * 校验不含 URL 的英文句子不会被删除空格或转换全角标点。
 * @returns 无返回值。
 * @author zhenghq
 */
test('不含 URL 的英文句子应保持原有空格与标点', () => {
  assert.equal(cleanOcrText('Note： hello world'), 'Note： hello world')
})

/**
 * 校验中文说明中的全角冒号不会被 URL 规则改写。
 * @returns 无返回值。
 * @author zhenghq
 */
test('中文说明中的全角冒号和句号应保持不变', () => {
  assert.equal(
    cleanOcrText('地址：https://example ． com。请访问'),
    '地址：https://example.com。请访问'
  )
})

/**
 * 校验协议分隔符 `://` 被整体识别成全角 `：／／` 时仍能恢复标准 URL 形式。
 * @returns 无返回值。
 * @author zhenghq
 */
test('全角协议分隔符应恢复为半角 URL', () => {
  assert.equal(
    cleanOcrText('jdbc：kingbase8：／／17 ． 1 ． 87 ． 69： 54321 ／admin-'),
    'jdbc:kingbase8://17.1.87.69:54321/admin-'
  )
})
