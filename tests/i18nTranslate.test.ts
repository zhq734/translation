import assert from 'node:assert/strict'
import test from 'node:test'
import { createTranslator } from '../src/shared/i18n/translate.ts'

test('t 支持命名参数插值', () => {
  const translator = createTranslator('en-US')
  assert.equal(
    translator.t('update.downloading', { percent: 42 }),
    'Downloading update… 42%'
  )
  assert.equal(translator.t('update.downloading', { percent: 42 }).includes('{{'), false)
})

test('plural 按英文 one、other 和可选 zero 选择分支', () => {
  const translator = createTranslator('en-US')
  assert.equal(translator.plural('update.items', 1), '1 item')
  assert.equal(translator.plural('update.items', 3), '3 items')
  assert.equal(translator.plural('update.items', 0), 'No items')
})

test('中文复数统一使用 other 分支', () => {
  const translator = createTranslator('zh-CN')
  assert.equal(translator.plural('update.items', 1), '1 项')
  assert.equal(translator.plural('update.items', 3), '3 项')
  assert.equal(translator.plural('update.items', 0), '0 项')
})

test('未知 key 和缺失语言回退到英文或安全文本', () => {
  const translator = createTranslator('zh-CN')
  assert.equal(translator.t('common.ok'), '确定')
  assert.equal(translator.t('unknown.key'), 'unknown.key')
  assert.equal(translator.has('common.ok'), true)
  assert.equal(translator.has('unknown.key'), false)
})
