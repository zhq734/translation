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

test('气泡提示应跟随浅深与多彩主题使用语义颜色', () => {
  const css = readFileSync('src/renderer/src/theme.css', 'utf8')
  assert.match(css, /--toast-bg:\s*var\(--popup-bg\)/u)
  assert.match(css, /--toast-text:\s*var\(--text-primary\)/u)
  assert.match(css, /--toast-border:\s*var\(--popup-border\)/u)
})

test('覆盖层提示胶囊应为反色胶囊并在五套主题与浅深模式下都有定义', () => {
  const css = readFileSync('src/renderer/src/theme.css', 'utf8')
  const toastCss = readFileSync('src/renderer/src/toast.css', 'utf8')
  const selectionCss = readFileSync('src/renderer/src/selection.css', 'utf8')
  // 未应用主题属性前也要有兜底配色，否则提示会渲染成透明
  assert.match(css, /--hint-pill-bg:\s*rgba\(/u)
  assert.match(css, /--hint-pill-text:\s*#/u)
  // 显式明暗模式必须压过系统外观：浅色主题深底白字，深色主题浅底深字
  assert.match(css, /:root\[data-theme-mode='light'\]\s*\{[^}]*--hint-pill-text:\s*#ffffff/u)
  assert.match(css, /:root\[data-theme-mode='dark'\]\s*\{[^}]*--hint-pill-text:\s*#17171a/u)
  // 五套主题各自微调胶囊底色，保证多主题下都不是同一种黑
  for (const theme of ['sakura', 'emerald', 'sky', 'navy', 'platinum-black']) {
    assert.match(css, new RegExp(`data-theme=['"]${theme}['"][^}]*--hint-pill-bg:`, 'u'), `${theme} 缺少提示胶囊底色`)
  }
  // 状态图标必须走各自的 Token，不得退回共享状态色
  assert.match(toastCss, /\[data-state='warning'\][^}]*--hint-pill-icon-warning/u)
  assert.match(toastCss, /\[data-state='error'\][^}]*--hint-pill-icon-error/u)
  // 截图动作提示与 OCR 框选提示必须共用同一组 Token，不能各留一套配色
  assert.match(toastCss, /background:\s*var\(--hint-pill-bg\)/u)
  assert.match(selectionCss, /\.ocr-tip\s*\{[^}]*background:\s*var\(--hint-pill-bg\)/su)
  assert.match(selectionCss, /\.ocr-tip\s*\{[^}]*color:\s*var\(--hint-pill-text\)/su)
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
