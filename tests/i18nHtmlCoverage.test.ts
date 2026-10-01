import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const ENTRY_FILES = ['index.html', 'selection.html', 'settings.html', 'toast.html', 'web-reader.html']

test('五个 Renderer 入口应具备英文兜底语言属性和同步 locale bootstrap', () => {
  for (const file of ENTRY_FILES) {
    const html = readFileSync(`src/renderer/${file}`, 'utf8')
    assert.match(html, /<html lang="en">/u, `${file} 应使用英文兜底 lang`)
    assert.match(html, /<script src="\.\/localeBootstrap\.js"><\/script>/u, `${file} 缺少 locale bootstrap`)
  }
})

test('locale bootstrap 必须在样式表前同步执行，并读取合法缓存', () => {
  const bootstrap = readFileSync('src/renderer/public/localeBootstrap.js', 'utf8')
  assert.doesNotMatch(bootstrap, /\bimport\b|\bexport\b/u)
  assert.match(bootstrap, /selection-translator\.locale/u)
  assert.match(bootstrap, /getSelectionTranslatorLocale/u, '首屏应优先读取 preload 同步注入语言')
  assert.match(bootstrap, /data-i18n-pending/u, '首屏应隐藏英文兜底，避免语言闪烁')
  assert.match(bootstrap, /documentElement\.lang/u)
  assert.match(bootstrap, /data-locale/u)
  for (const file of ENTRY_FILES) {
    const html = readFileSync(`src/renderer/${file}`, 'utf8')
    const bootstrapIndex = html.indexOf('localeBootstrap.js')
    const styleIndex = html.indexOf('theme.css')
    assert.ok(bootstrapIndex > 0, `${file} 缺少 locale bootstrap`)
    assert.ok(bootstrapIndex < styleIndex, `${file} 的 locale bootstrap 必须早于样式表`)
  }
})

test('静态文案和关键属性应使用 data-i18n 标记约定', () => {
  const settings = readFileSync('src/renderer/settings.html', 'utf8')
  assert.match(settings, /data-i18n="[^"]+"/u)
  assert.match(settings, /data-i18n-attr="[^"]+"/u)
  assert.match(settings, /id="ui-locale"/u)
  assert.match(settings, /value="auto"/u)
  assert.match(settings, /value="zh-CN"/u)
  assert.match(settings, /value="en-US"/u)
})

test('五个 Renderer 入口不得残留未标记的用户可见中文', () => {
  for (const file of ENTRY_FILES) {
    const html = readFileSync(`src/renderer/${file}`, 'utf8')
    const body = html.slice(html.indexOf('<body'), html.indexOf('</body>'))
    const visible = body
      .replace(/<script[\s\S]*?<\/script>/gu, '')
      .replace(/<style[\s\S]*?<\/style>/gu, '')
      .replace(/<!--[\s\S]*?-->/gu, '')
      // 品牌标记「译」是应用图标语义，保持语言无关；装饰性标记已用 aria-hidden 移除，
      // 选区翻译按钮则通过 aria-label 提供可访问名称。
      .replace(/<[^>]*aria-hidden="true"[^>]*>译<\/[^>]+>/gu, '')
      .replace(/<button\b[^>]*>译<\/button>/gu, '')
    const chinese = [...visible.matchAll(/[\u3400-\u9fff]+/gu)].map((match) => match[0])
    assert.deepEqual(chinese, [], `${file} 仍有未标记中文：${chinese.join('、')}`)
  }
})
