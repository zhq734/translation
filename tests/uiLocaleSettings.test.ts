import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('设置页应在通用区域提供三种界面语言选项', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  assert.match(html, /id="ui-locale"/u)
  assert.match(html, /value="auto"/u)
  assert.match(html, /value="zh-CN"/u)
  assert.match(html, /value="en-US"/u)
  assert.match(html, /data-i18n="settings\.uiLocale\.label"/u)
  assert.match(html, /id="ui-locale"[^>]*data-i18n-attr="title:settings\.uiLocale\.title"/u)
})

test('设置脚本应读取、保存并同步界面语言选择器', () => {
  const source = readFileSync('src/renderer/src/settings.ts', 'utf8')
  assert.match(source, /getElementById\('ui-locale'\)/u)
  assert.match(source, /uiLocale\.value = settings\.uiLocale/u)
  assert.match(source, /uiLocale\.addEventListener\('change'/u)
  assert.match(source, /save\(\{ uiLocale: uiLocale\.value as UiLocale \}\)/u)
  assert.match(source, /uiLocale\.value = previousLocale/u, '保存失败时应回滚选择器')
  assert.match(source, /onSettingsChanged/u, '应响应设置广播同步语言选择器')
})
