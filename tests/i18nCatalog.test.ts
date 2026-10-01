import assert from 'node:assert/strict'
import test from 'node:test'
import { enUSCatalog } from '../src/shared/i18n/catalog.en-US.ts'
import { zhCNCatalog } from '../src/shared/i18n/catalog.zh-CN.ts'
import { collectTranslationKeys, collectPlaceholders } from '../src/shared/i18n/catalog.ts'

test('中英文目录 key 集合完全一致且叶子值非空', () => {
  const englishKeys = collectTranslationKeys(enUSCatalog)
  const chineseKeys = collectTranslationKeys(zhCNCatalog)
  assert.deepEqual(chineseKeys, englishKeys)
  assert.ok(englishKeys.length > 0)

  for (const key of englishKeys) {
    const english = enUSCatalog[key as keyof typeof enUSCatalog]
    const chinese = zhCNCatalog[key as keyof typeof zhCNCatalog]
    if (typeof english === 'string') {
      assert.ok(english.trim().length > 0, `${key} 英文词条不能为空`)
      assert.equal(typeof chinese, 'string', `${key} 中文词条类型应与英文一致`)
      assert.ok(chinese.trim().length > 0, `${key} 中文词条不能为空`)
    } else {
      assert.equal(typeof english, 'object', `${key} 应为字符串或复数对象`)
      assert.equal(typeof chinese, 'object', `${key} 中文复数类型应与英文一致`)
      assert.equal(typeof english.other, 'string', `${key} 复数词条必须包含 other 分支`)
      assert.equal(typeof chinese.other, 'string', `${key} 中文复数词条必须包含 other 分支`)
    }
  }
})

test('同一 key 在中英文中的插值占位符集合一致', () => {
  const keys = collectTranslationKeys(enUSCatalog)
  for (const key of keys) {
    const english = enUSCatalog[key as keyof typeof enUSCatalog]
    const chinese = zhCNCatalog[key as keyof typeof zhCNCatalog]
    assert.deepEqual(
      collectPlaceholders(chinese),
      collectPlaceholders(english),
      `${key} 的插值参数不一致`
    )
  }
})

test('英文复数词条至少包含 one 与 other，zero 可选', () => {
  for (const [key, value] of Object.entries(enUSCatalog)) {
    if (typeof value === 'string') continue
    assert.equal(typeof value.one, 'string', `${key} 缺少 one 分支`)
    assert.equal(typeof value.other, 'string', `${key} 缺少 other 分支`)
  }
})
