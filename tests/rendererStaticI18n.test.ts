import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  findOpeningTagById,
  readAttributeI18nKey,
  readTextI18nKey,
  translatorForTest
} from './helpers/i18n.ts'

/** 需要检查静态本地化标记的 Renderer 入口。 */
const ENTRY_FILES = ['index.html', 'selection.html', 'settings.html', 'toast.html', 'web-reader.html'] as const

/** 必须由 data-i18n-attr 或显式白名单覆盖的静态属性。 */
const TRANSLATABLE_ATTRIBUTES = ['title', 'aria-label', 'placeholder', 'alt'] as const

/**
 * 允许保留字面量、不参与本地化的静态属性白名单。
 * key 为 `文件:属性`，value 为该属性值允许出现的字面量集合。
 * @author zhenghq
 */
const STATIC_ATTRIBUTE_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {}

/**
 * 从 HTML 中提取指定属性值的字面量。
 * @param tag HTML 开始标签。
 * @param attribute 属性名。
 * @returns 属性值；不存在时返回 null。
 * @author zhenghq
 */
function readAttributeValue(tag: string, attribute: string): string | null {
  const pattern = new RegExp(`\\b${attribute}\\s*=\\s*"([^"]*)"`, 'u')
  return tag.match(pattern)?.[1] ?? null
}

/**
 * 从 HTML 中提取元素 id。
 * @param tag HTML 开始标签。
 * @returns 元素 id；不存在时返回 null。
 * @author zhenghq
 */
function readElementId(tag: string): string | null {
  return tag.match(/\bid="([^"]*)"/u)?.[1] ?? null
}

/**
 * 枚举 HTML 中所有开始标签。
 * @param html HTML 文本。
 * @returns 开始标签字符串列表。
 * @author zhenghq
 */
function collectOpeningTags(html: string): string[] {
  return [...html.matchAll(/<[a-zA-Z][\w-]*(?:"[^"]*"|'[^']*'|[^'">])*>/gu)].map((match) => match[0])
}

test('所有静态可翻译属性必须由 data-i18n-attr 映射或显式白名单覆盖', () => {
  for (const file of ENTRY_FILES) {
    const html = readFileSync(`src/renderer/${file}`, 'utf8')
    for (const tag of collectOpeningTags(html)) {
      for (const attribute of TRANSLATABLE_ATTRIBUTES) {
        const value = readAttributeValue(tag, attribute)
        if (value === null) continue
        const allowKey = `${file}:${attribute}`
        const allowedValues = STATIC_ATTRIBUTE_ALLOWLIST[allowKey]
        if (allowedValues?.includes(value)) continue
        const key = readAttributeI18nKey(tag, attribute)
        assert.ok(
          key,
          `${file} 的 ${attribute} 属性缺少 data-i18n-attr 映射（元素 id：${readElementId(tag) ?? '无'}，值：${value}）`
        )
      }
    }
  }
})

test('静态属性映射的词条 key 必须在两种语言下都存在且非空', () => {
  for (const file of ENTRY_FILES) {
    const html = readFileSync(`src/renderer/${file}`, 'utf8')
    for (const tag of collectOpeningTags(html)) {
      for (const attribute of TRANSLATABLE_ATTRIBUTES) {
        if (readAttributeValue(tag, attribute) === null) continue
        const key = readAttributeI18nKey(tag, attribute)
        if (!key) continue
        for (const locale of ['zh-CN', 'en-US'] as const) {
          const translated = translatorForTest(locale).t(key)
          assert.ok(translated.trim().length > 0, `${file} 的 ${attribute} 词条 ${key} 在 ${locale} 下为空`)
          assert.notEqual(translated, key, `${file} 的 ${attribute} 词条 ${key} 在 ${locale} 下未定义`)
        }
      }
    }
  }
})

test('静态文本映射的词条 key 必须在两种语言下都存在且非空', () => {
  for (const file of ENTRY_FILES) {
    const html = readFileSync(`src/renderer/${file}`, 'utf8')
    for (const tag of collectOpeningTags(html)) {
      const key = readTextI18nKey(tag)
      if (!key) continue
      for (const locale of ['zh-CN', 'en-US'] as const) {
        const translated = translatorForTest(locale).t(key)
        assert.ok(translated.trim().length > 0, `${file} 的文本词条 ${key} 在 ${locale} 下为空`)
        assert.notEqual(translated, key, `${file} 的文本词条 ${key} 在 ${locale} 下未定义`)
      }
    }
  }
})

test('设置页关键字段标签已本地化', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const expectations: ReadonlyArray<readonly [string, string]> = [
    ['ai-base-url', 'settings.ai.baseUrl'],
    ['ai-api-key', 'settings.ai.apiKey'],
    ['ocr-tesseract-enabled', 'settings.ocr.tesseract'],
    ['dingtalk-corp-id', 'settings.dingTalk.corpId'],
    ['dingtalk-client-id', 'settings.dingTalk.clientId'],
    ['dingtalk-client-secret', 'settings.dingTalk.clientSecret']
  ]
  for (const [id, key] of expectations) {
    const tag = findOpeningTagById(html, id)
    assert.ok(tag, `settings.html 缺少 #${id}`)
    const labelPattern = new RegExp(`<label\\b[^>]*\\bfor="${id}"[^>]*>`, 'u')
    const label = html.match(labelPattern)?.[0] ?? null
    assert.ok(label, `settings.html 缺少 #${id} 的 label`)
    assert.equal(readTextI18nKey(label), key, `settings.html #${id} 的 label 未使用 ${key}`)
  }
})
