import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeChineseScript } from '../src/main/chineseScript.ts'

/**
 * 校验简体中文识别结果会把繁体字形规范为简体。
 * @returns 无返回值。
 * @author zhenghq
 */
test('简体中文应将繁体识别文本规范为简体', () => {
  assert.equal(
    normalizeChineseScript('國會參眾兩院均控制超過半數席位', 'zh-CN'),
    '国会参众两院均控制超过半数席位'
  )
})

/**
 * 校验繁体中文识别结果会把简体字形规范为繁体。
 * @returns 无返回值。
 * @author zhenghq
 */
test('繁体中文应将简体识别文本规范为繁体', () => {
  assert.equal(
    normalizeChineseScript('国会参众两院均控制超过半数席位', 'zh-TW'),
    '國會參眾兩院均控制超過半數席位'
  )
})

/**
 * 校验自动识别及其他语言不会误改原文。
 * @returns 无返回值。
 * @author zhenghq
 */
test('自动识别和其他语言应保留原文', () => {
  assert.equal(normalizeChineseScript('國會參眾兩院', 'auto'), '國會參眾兩院')
  assert.equal(normalizeChineseScript('國會參眾兩院', 'ja-JP'), '國會參眾兩院')
})
