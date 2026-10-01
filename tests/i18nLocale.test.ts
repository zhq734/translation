import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  normalizeLocaleTag,
  normalizeUiLocale,
  resolveLocale
} from '../src/shared/i18n/locale.ts'

test('支持语言集合和默认语言固定为中文与英文，并最终回退英文', () => {
  assert.deepEqual(SUPPORTED_LOCALES, ['zh-CN', 'en-US'])
  assert.equal(DEFAULT_LOCALE, 'en-US')
})

test('语言标签规范化支持下划线、编码后缀和中文地区变体', () => {
  assert.equal(normalizeLocaleTag('zh_CN.UTF-8'), 'zh-CN')
  assert.equal(normalizeLocaleTag('zh-TW'), 'zh-CN')
  assert.equal(normalizeLocaleTag('zh-Hant@modifier'), 'zh-CN')
  assert.equal(normalizeLocaleTag('en_US'), 'en-US')
  assert.equal(normalizeLocaleTag('en_GB.UTF-8'), 'en-US')
  assert.equal(normalizeLocaleTag('en'), 'en-US')
})

test('C、POSIX、空值和非法语言标签应被忽略', () => {
  for (const value of ['C', 'POSIX', '', '   ', 'not_a_locale', null, undefined, 42]) {
    assert.equal(normalizeLocaleTag(value), null, `${String(value)} 应被忽略`)
  }
})

test('不支持的语言应回退英文而不是中文', () => {
  assert.equal(resolveLocale('auto', ['fr-FR', 'de-DE']), 'en-US')
  assert.equal(resolveLocale('auto', ['C', 'POSIX']), 'en-US')
  assert.equal(resolveLocale('auto', []), 'en-US')
})

test('auto 模式按候选顺序选择第一个受支持语言', () => {
  assert.equal(resolveLocale('auto', ['fr-FR', 'zh-CN', 'en-US']), 'zh-CN')
  assert.equal(resolveLocale('auto', ['C', 'en-GB', 'zh-CN']), 'en-US')
  assert.equal(resolveLocale('auto', [null, 'zh-TW']), 'zh-CN')
})

test('显式 uiLocale 覆盖系统候选且非法值按 auto 处理', () => {
  assert.equal(resolveLocale('zh-CN', ['en-US']), 'zh-CN')
  assert.equal(resolveLocale('en-US', ['zh-CN']), 'en-US')
  assert.equal(resolveLocale('invalid' as never, ['zh-CN']), 'zh-CN')
  assert.equal(normalizeUiLocale('invalid'), 'auto')
  assert.equal(normalizeUiLocale('zh_CN'), 'auto')
})
