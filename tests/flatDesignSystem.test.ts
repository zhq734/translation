import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const RENDERER_ENTRIES = [
  'src/renderer/index.html',
  'src/renderer/settings.html',
  'src/renderer/selection.html',
  'src/renderer/web-reader.html',
  'src/renderer/toast.html'
] as const

const COMPONENT_STYLES = [
  'src/renderer/src/style.css',
  'src/renderer/src/settings.css',
  'src/renderer/src/selection.css',
  'src/renderer/src/webReader.css',
  'src/renderer/src/toast.css'
] as const

test('共享主题应提供完整的扁平化设计 Token', () => {
  const css = readFileSync('src/renderer/src/theme.css', 'utf8')
  for (const token of [
    '--font-family-sans',
    '--font-size-caption',
    '--font-size-body',
    '--font-size-label',
    '--font-size-title',
    '--space-1',
    '--space-2',
    '--space-3',
    '--space-4',
    '--space-6',
    '--control-height-compact',
    '--control-height',
    '--control-height-primary',
    '--titlebar-height',
    '--icon-size-sm',
    '--icon-size-md',
    '--icon-size-lg',
    '--radius-control',
    '--radius-panel',
    '--radius-overlay',
    '--radius-pill',
    '--border-width',
    '--shadow-overlay',
    '--z-titlebar',
    '--z-overlay',
    '--duration-fast',
    '--duration-normal',
    '--ease-standard',
    '--bg-primary',
    '--bg-elevated',
    '--text-danger',
    '--status-warning',
    '--overlay-bg',
    '--capture-accent'
  ]) {
    assert.match(css, new RegExp(`${token}:`, 'u'), `缺少设计 Token ${token}`)
  }
  assert.match(css, /--titlebar-height:\s*40px/u)
  assert.match(css, /--control-height:\s*32px/u)
})

test('共享基础样式应提供扁平控件、可见焦点与降低动态效果支持', () => {
  const css = readFileSync('src/renderer/src/base.css', 'utf8')
  assert.match(css, /box-sizing:\s*border-box/u)
  assert.match(css, /min-height:\s*var\(--control-height\)/u)
  assert.match(css, /:focus-visible/u)
  assert.match(css, /outline:\s*2px\s+solid\s+var\(--focus-outline\)/u)
  assert.match(css, /\.icon-button[\s\S]*inline-size:\s*var\(--control-height\)/u)
  assert.match(css, /\.flat-overlay[\s\S]*box-shadow:\s*var\(--shadow-overlay\)/u)
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/u)
})

test('五类 Renderer 应在主题之后、组件样式之前引用共享基础样式', () => {
  for (const file of RENDERER_ENTRIES) {
    const html = readFileSync(file, 'utf8')
    const themeIndex = html.indexOf('./src/theme.css')
    const baseIndex = html.indexOf('./src/base.css')
    const componentIndex = html.search(/\.\/src\/(?:style|settings|selection|webReader|toast)\.css/u)
    assert.ok(themeIndex >= 0, `${file} 缺少 theme.css`)
    assert.ok(baseIndex > themeIndex, `${file} 未在主题后引用 base.css`)
    assert.ok(componentIndex > baseIndex, `${file} 未在基础样式后引用组件样式`)
  }
})

test('组件样式不得硬编码主题颜色', () => {
  const colorLiteral = /(?:#[\da-f]{3,8}\b|rgba?\(|hsla?\()/iu
  for (const file of COMPONENT_STYLES) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), colorLiteral, `${file} 存在硬编码主题颜色`)
  }
})

test('sky 应作为默认现代蓝色基线', () => {
  const themeSource = readFileSync('src/renderer/src/theme.ts', 'utf8')
  const css = readFileSync('src/renderer/src/theme.css', 'utf8')
  assert.match(themeSource, /DEFAULT_THEME(?:\s*:\s*ThemePreset)?\s*=\s*['"]sky['"]/u)
  assert.match(css, /:root\s*\{[\s\S]*--button-bg:\s*#3b82f6/u)
  assert.match(css, /--accent-gradient:\s*linear-gradient\(135deg,\s*var\(--accent-start\),\s*var\(--accent-end\)\)/u)
})
