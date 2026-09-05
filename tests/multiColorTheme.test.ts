import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('主题运行时应支持五套主题、三种模式和本地缓存', () => {
  const source = readFileSync('src/renderer/src/theme.ts', 'utf8')
  assert.match(source, /sakura/u)
  assert.match(source, /emerald/u)
  assert.match(source, /sky/u)
  assert.match(source, /navy/u)
  assert.match(source, /platinum-black/u)
  assert.match(source, /system/u)
  assert.match(source, /matchMedia/u)
  assert.match(source, /localStorage/u)
  assert.match(source, /data-theme/u)
  assert.match(source, /data-theme-mode/u)
})

test('所有 Renderer 入口都应初始化并监听主题设置', () => {
  for (const file of ['popup.ts', 'settings.ts', 'selection.ts', 'toast.ts', 'webReader.ts']) {
    const source = readFileSync(`src/renderer/src/${file}`, 'utf8')
    assert.match(source, /startThemeRuntime\(window\.api\)/u, `${file} 未初始化主题运行时`)
  }
})

test('主题样式应提供五套主题的浅深模式和强调渐变', () => {
  const css = readFileSync('src/renderer/src/theme.css', 'utf8')
  for (const theme of ['sakura', 'emerald', 'sky', 'navy', 'platinum-black']) {
    assert.match(css, new RegExp(`data-theme=['"]${theme}['"]`, 'u'))
  }
  assert.match(css, /data-theme-mode=['"]light['"]/u)
  assert.match(css, /data-theme-mode=['"]dark['"]/u)
  assert.match(css, /--accent-gradient:\s*linear-gradient/u)
})

test('设置页应提供主题模式和五个可访问主题卡片', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  for (const [id, label] of [
    ['sakura', '樱花粉'],
    ['emerald', '祖母绿'],
    ['sky', '天空蓝'],
    ['navy', '藏青色'],
    ['platinum-black', '铂金黑']
  ]) {
    assert.match(html, new RegExp(`data-theme-preset=["']${id}["']`, 'u'))
    assert.match(html, new RegExp(label, 'u'))
  }
  assert.match(html, /id="theme-mode"/u)
  assert.match(html, /aria-pressed="false"/u)
  const css = readFileSync('src/renderer/src/settings.css', 'utf8')
  assert.match(css, /\.theme-preset-grid\s*\{[\s\S]*display:\s*grid/u)
  assert.match(css, /repeat\(auto-fit/u)
})
