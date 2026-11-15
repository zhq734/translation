import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { applyTheme, resolveThemeMode } from '../src/renderer/src/theme.ts'

const require = createRequire(`${process.cwd()}/package.json`)
const { parse } = require('postcss') as typeof import('postcss')
const themeCss = readFileSync('src/renderer/src/theme.css', 'utf8')
const baseCss = readFileSync('src/renderer/src/base.css', 'utf8')
const theme = parse(themeCss)
const presets = ['sakura', 'emerald', 'sky', 'navy', 'platinum-black'] as const
const modes = ['light', 'dark'] as const
type PaletteState = { preset?: string; mode?: string; systemDark: boolean; colorMix?: boolean }
type Tokens = Record<string, string>
const legacyTokens = `font-family-sans font-size-caption font-size-body font-size-label font-size-title
space-1 space-2 space-3 space-4 space-6 control-height-compact control-height control-height-primary
titlebar-height icon-size-sm icon-size-md icon-size-lg radius-control radius-panel radius-overlay radius-pill
border-width shadow-overlay z-titlebar z-overlay duration-fast duration-normal ease-standard page-bg panel-bg
panel-shadow document-paper-bg document-paper-text document-watermark-ink document-watermark-ink-strong
bg-secondary control-bg control-disabled-bg border-default border-control document-table-boundary focus-ring
document-manual-edit-hover-bg document-manual-edit-active-bg search-match-bg search-current-bg
button-secondary-bg button-secondary-hover popup-bg popup-border text-primary text-secondary text-muted divider
button-bg button-bg-hover button-text selection-button-bg selection-button-border selection-button-shadow
ocr-overlay-bg ocr-selection-bg ocr-selection-mask overlay-backdrop popup-shadow toast-bg toast-text toast-border
hint-pill-bg hint-pill-text hint-pill-icon-success hint-pill-icon-warning hint-pill-icon-error
status-success status-error status-warning bg-primary bg-elevated text-danger overlay-bg capture-accent
focus-outline accent-start accent-end accent-gradient theme-sakura-gradient theme-emerald-gradient
theme-sky-gradient theme-navy-gradient theme-platinum-black-gradient`.split(/\s+/u)
const newTokens = `text-reading reading-line-height surface-subtle surface-hover accent-soft text-on-accent
border-subtle shadow-panel radius-window content-max-width subtitle-surface subtitle-primary
subtitle-secondary subtitle-outline`.split(/\s+/u)

/**
 * 按根选择器优先级与媒体条件计算真实样式表的 Token 层叠，不假定源码块的排列顺序。
 * @param state 根节点主题、系统明暗与浏览器混色能力。
 * @returns 层叠后的未展开变量映射。
 * @author zhenghq
 */
function palette(state: PaletteState): Tokens {
  const values: Tokens = {}
  const weights: Record<string, number> = {}
  theme.walkRules((rule) => {
    for (let parent: typeof rule.parent | import('postcss').Document = rule.parent; parent; parent = parent.parent) {
      if (parent.type !== 'atrule') continue
      if (parent.name === 'media' && parent.params.includes('prefers-color-scheme: dark') && !state.systemDark) return
      if (parent.name === 'supports' && !state.colorMix) return
    }
    for (const selector of rule.selectors) {
      if (!/^:root(?:\[data-theme(?:-mode)?='[^']+'\])*$/u.test(selector)) continue
      const attributes = [...selector.matchAll(/\[(data-theme(?:-mode)?)='([^']+)'\]/gu)]
      if (attributes.some(([, name, value]) => (name === 'data-theme' ? state.preset : state.mode) !== value)) continue
      const weight = attributes.length + 1
      rule.walkDecls(/^--/u, (declaration) => {
        if (weight < (weights[declaration.prop] ?? 0)) return
        weights[declaration.prop] = weight
        values[declaration.prop] = declaration.value
      })
    }
  })
  return values
}

/**
 * 递归展开语义别名，同时拒绝缺失变量或循环依赖。
 * @param tokens 当前调色板。
 * @param name 待读取的变量名。
 * @param chain 当前展开链。
 * @returns 不含 var() 的 CSS 值。
 * @author zhenghq
 */
function token(tokens: Tokens, name: string, chain: string[] = []): string {
  assert.ok(tokens[name], `缺少 ${name}`)
  assert.ok(!chain.includes(name), `变量循环：${[...chain, name].join(' → ')}`)
  return tokens[name].replace(/var\((--[\w-]+)\)/gu, (_, reference: string) => token(tokens, reference, [...chain, name]))
}

/**
 * 将全局 HEX/RGB/RGBA 色值与不透明底色合成，供实际对比度计算使用。
 * @param color 前景色。
 * @param underlay 透明色下面的 RGB 背景，默认白色。
 * @returns 合成后的 RGB 通道。
 * @author zhenghq
 */
function rgb(color: string, underlay = [255, 255, 255]): number[] {
  if (/^#[\da-f]{6}$/iu.test(color)) return [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16))
  const match = /^rgba?\(([^)]+)\)$/u.exec(color)
  assert.ok(match, `不支持的色值 ${color}`)
  const [red, green, blue, alpha = 1] = match[1].split(',').map(Number)
  return [red, green, blue].map((channel, index) => channel * alpha + underlay[index] * (1 - alpha))
}

/**
 * 按 WCAG sRGB 线性化公式计算相对亮度。
 * @param channels RGB 通道。
 * @returns 0 至 1 的相对亮度。
 * @author zhenghq
 */
function luminance(channels: number[]): number {
  const linear = channels.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

/**
 * 计算支持透明表面的前景/背景对比度。
 * @param foreground 前景 CSS 色值。
 * @param background 背景 CSS 色值。
 * @param underlay 背景下面的不透明色值。
 * @returns WCAG 对比度比值。
 * @author zhenghq
 */
function contrast(foreground: string, background: string, underlay = '#ffffff'): number {
  const back = rgb(background, rgb(underlay))
  const front = rgb(foreground, back)
  const [low, high] = [luminance(front), luminance(back)].sort((first, second) => first - second)
  return (high + 0.05) / (low + 0.05)
}

test('Quiet Studio 保留全部旧 Token 并提供共享契约，别名在全部主题中可解析', () => {
  for (const preset of presets) for (const mode of modes) for (const systemDark of [false, true]) {
    const values = palette({ preset, mode, systemDark })
    for (const name of [...legacyTokens, ...newTokens]) assert.ok(token(values, `--${name}`), `${preset}/${mode}/${name}`)
    for (const name of Object.keys(values)) assert.doesNotMatch(token(values, name), /var\(/u)
    for (const [name, expected] of Object.entries({
      'font-size-body': '14px', 'font-size-title': '22px', 'reading-line-height': '1.75',
      'radius-panel': '12px', 'radius-window': '14px', 'radius-overlay': '14px',
      'control-height': '32px', 'control-height-primary': '36px', 'titlebar-height': '40px',
      'content-max-width': '1120px'
    })) assert.equal(token(values, `--${name}`), expected)
    assert.equal(token(values, '--text-on-accent'), token(values, '--button-text'))
    assert.equal(token(values, '--text-reading'), token(values, '--text-primary'))
    assert.equal(token(values, '--surface-subtle'), token(values, '--bg-secondary'))
  }
})

test('Quiet Studio 十套调色板只改变强调色，不给正文、普通表面与边界染色', () => {
  const neutralNames = `page-bg panel-bg bg-secondary control-bg control-disabled-bg text-primary text-secondary
    text-muted text-reading border-default border-control border-subtle divider popup-bg popup-border
    surface-subtle surface-hover button-secondary-bg button-secondary-hover`.split(/\s+/u)
  for (const mode of modes) {
    const reference = palette({ preset: 'sky', mode, systemDark: false })
    const accents = new Set<string>()
    for (const preset of presets) {
      const values = palette({ preset, mode, systemDark: false })
      for (const name of neutralNames) {
        const color = token(values, `--${name}`)
        assert.equal(color, token(reference, `--${name}`), `${preset}/${mode}/${name} 被主题染色`)
        const channels = rgb(color)
        assert.ok(Math.max(...channels) - Math.min(...channels) <= 18, `${name} 不是中性色`)
      }
      accents.add(token(values, '--button-bg'))
      assert.notEqual(token(values, '--button-bg'), token(values, '--button-bg-hover'))
      assert.notEqual(token(values, '--accent-soft'), token(values, '--surface-subtle'))
    }
    assert.equal(accents.size, 5, `${mode} 下应保留五个可辨识强调色`)
  }
})

test('显式模式不受系统外观污染，未 bootstrap 的根节点仍随系统提供完整中性调色板', () => {
  for (const preset of presets) for (const mode of modes) {
    assert.deepEqual(palette({ preset, mode, systemDark: true }), palette({ preset, mode, systemDark: false }))
  }
  for (const systemDark of [false, true]) {
    const fallback = palette({ systemDark })
    const explicit = palette({ preset: 'sky', mode: systemDark ? 'dark' : 'light', systemDark })
    for (const name of [...legacyTokens, ...newTokens]) assert.equal(token(fallback, `--${name}`), token(explicit, `--${name}`), name)
  }
})

test('主题规则没有重复声明或冲突控件覆盖，强调色接口保持兼容的同色渐变', () => {
  theme.walkRules((rule) => {
    const declarations = new Set<string>()
    rule.walkDecls((declaration) => {
      assert.ok(!declarations.has(declaration.prop), `${rule.selector} 重复定义 ${declaration.prop}`)
      declarations.add(declaration.prop)
    })
    assert.ok(rule.selectors.every((selector) => selector.startsWith(':root')), 'theme.css 不应承担组件状态样式')
  })
  for (const preset of presets) for (const mode of modes) {
    const values = palette({ preset, mode, systemDark: false })
    assert.equal(token(values, '--accent-start'), token(values, '--button-bg'))
    assert.equal(token(values, '--accent-end'), token(values, '--button-bg'))
  }
})

test('正文与默认/悬停/选中按钮满足 4.5:1，焦点与面板满足 3:1', (context) => {
  let minimumText = Infinity
  let minimumButton = Infinity
  for (const preset of presets) for (const mode of modes) {
    const values = palette({ preset, mode, systemDark: mode === 'dark' })
    /** 读取当前调色板颜色；参数为不带前缀的名称，返回展开色值。@author zhenghq */
    const color = (name: string): string => token(values, `--${name}`)
    for (const foreground of ['text-primary', 'text-secondary', 'text-reading', 'text-muted']) {
      for (const background of ['page-bg', 'panel-bg', 'control-bg', 'surface-subtle', 'surface-hover', 'popup-bg']) {
        const ratio = contrast(color(foreground), color(background), color('page-bg'))
        minimumText = Math.min(minimumText, ratio)
        assert.ok(ratio >= 4.5, `${preset}/${mode}/${foreground}/${background} = ${ratio.toFixed(2)}`)
      }
    }
    for (const background of ['button-bg', 'button-bg-hover', 'accent-start', 'accent-end']) {
      const ratio = contrast(color('text-on-accent'), color(background))
      minimumButton = Math.min(minimumButton, ratio)
      assert.ok(ratio >= 4.5, `${preset}/${mode}/按钮/${background} = ${ratio.toFixed(2)}`)
    }
    assert.ok(contrast(color('text-primary'), color('accent-soft')) >= 4.5)
    assert.ok(contrast(color('text-secondary'), color('accent-soft')) >= 4.5)
    for (const background of ['button-secondary-bg', 'button-secondary-hover']) {
      assert.ok(contrast(color('text-primary'), color(background)) >= 4.5)
    }
    assert.ok(contrast(color('button-bg'), color('accent-soft')) >= 4.5)
    assert.ok(contrast(color('button-text'), color('status-error')) >= 4.5, `${preset}/${mode}/关闭按钮`)
    assert.ok(contrast(color('focus-outline'), color('panel-bg')) >= 3)
  }
  context.diagnostic(`十套调色板最低正文对比度 ${minimumText.toFixed(2)}:1，最低主按钮对比度 ${minimumButton.toFixed(2)}:1`)
})

test('纸张、水印、检索和截图提示保持独立语义，旧浏览器手改底色有不透明回退', () => {
  for (const preset of presets) for (const mode of modes) {
    const values = palette({ preset, mode, systemDark: true })
    assert.equal(token(values, '--document-paper-bg'), '#ffffff')
    assert.equal(token(values, '--document-paper-text'), '#111827')
    assert.equal(token(values, '--document-watermark-ink'), 'rgba(17, 24, 39, 0.11)')
    assert.equal(token(values, '--document-watermark-ink-strong'), 'rgba(17, 24, 39, 0.17)')
    assert.ok(contrast(token(values, '--document-table-boundary'), '#ffffff') >= 4.5)
    assert.equal(token(values, '--document-manual-edit-hover-bg'), '#ffffff')
    assert.equal(token(values, '--document-manual-edit-active-bg'), '#ffffff')
    const modern = palette({ preset, mode, systemDark: true, colorMix: true })
    assert.match(token(modern, '--document-manual-edit-hover-bg'), /^color-mix\(/u)
    assert.match(token(modern, '--document-manual-edit-active-bg'), /^color-mix\(/u)
    for (const desktop of ['#ffffff', '#000000']) {
      assert.ok(contrast(token(values, '--hint-pill-text'), token(values, '--hint-pill-bg'), desktop) >= 4.5)
    }
    for (const name of ['ocr-overlay-bg', 'ocr-selection-bg', 'ocr-selection-mask', 'search-match-bg', 'search-current-bg']) {
      assert.match(token(values, `--${name}`), /^rgba\(/u)
    }
  }
})

/** 校验所有主题下字幕暗底、描边与文字对比度；无参数、无返回值。@author zhenghq */
test('字幕专用表面在全部主题中保持暗底、可读文字与深色描边', () => {
  for (const preset of presets) for (const mode of modes) {
    const values = palette({ preset, mode, systemDark: mode === 'dark' })
    const surface = token(values, '--subtitle-surface')
    assert.ok(luminance(rgb(surface)) < 0.05, `${preset}/${mode}/字幕暗底`)
    assert.ok(luminance(rgb(token(values, '--subtitle-outline'))) < luminance(rgb(surface)))
    for (const foreground of ['--subtitle-primary', '--subtitle-secondary']) {
      assert.ok(contrast(token(values, foreground), surface) >= 4.5, `${preset}/${mode}/${foreground}`)
    }
    assert.ok(contrast('#ffffff', surface) >= 4.5, `${preset}/${mode}/默认白色字幕`)
  }
})

test('基础控件具有中性 hover、主操作、禁用、链接焦点、旧浏览器焦点回退和 reduced-motion', () => {
  assert.match(baseCss, /background:\s*var\(--control-bg\)/u)
  assert.match(baseCss, /:hover[^}]*background:\s*var\(--surface-hover\)/u)
  assert.match(baseCss, /\.primary-button[^}]*background:\s*var\(--button-bg\)/u)
  assert.match(baseCss, /color:\s*var\(--text-on-accent\)/u)
  assert.match(baseCss, /:disabled/u)
  assert.match(baseCss, /aria-disabled=['"]true/u)
  assert.match(baseCss, /cursor:\s*not-allowed/u)
  assert.match(baseCss, /background:\s*var\(--control-disabled-bg\)/u)
  assert.match(baseCss, /a\[href\][^}]*:focus-visible[^}]*outline:\s*2px solid var\(--focus-outline\)/u)
  assert.match(baseCss, /:where\(button, input, select, textarea, a\[href\], \[tabindex\]\):focus-visible\s*\{[^}]*outline:[^;]*!important/u)
  assert.match(baseCss, /@supports not selector\(:focus-visible\)/u)
  assert.match(baseCss, /@media \(prefers-reduced-motion: reduce\)/u)
  for (const property of ['animation-delay', 'transition-delay']) assert.match(baseCss, new RegExp(`${property}:\\s*0s`, 'u'))
  assert.match(baseCss, /\[hidden\]\s*\{\s*display:\s*none\s*!important/u)
  assert.doesNotMatch(themeCss, /:root\[data-theme\]\s+\.(?:primary-button|btn|settings-tab)/u)
  assert.doesNotMatch(baseCss, /(?:#[\da-f]{3,8}\b|rgba?\(|hsla?\()/iu)
  const base = parse(baseCss)
  base.walkRules((rule) => {
    if (rule.selector.includes(':hover')) {
      if (rule.selector.includes('button') || rule.selector.includes('.primary')) {
        assert.ok(rule.selector.includes(':not(:disabled)'), '按钮 hover 不应应用于禁用控件')
        assert.ok(rule.selector.includes(":not([aria-disabled='true'])"), '按钮 hover 不应应用于 ARIA 禁用控件')
      }
    }
    if (rule.selectors.includes('button:disabled')) {
      const properties: Tokens = {}
      rule.walkDecls((declaration) => {
        properties[declaration.prop] = declaration.value
        if (['background', 'color', 'border-color'].includes(declaration.prop)) assert.ok(declaration.important)
      })
      assert.equal(properties.background, 'var(--control-disabled-bg)')
      assert.equal(properties.color, 'var(--text-muted)')
      assert.equal(properties.cursor, 'not-allowed')
    }
  })
})

test('现有运行时仍把五主题与 system 模式解析为明确根属性并保留缓存', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let systemDark = false
  const attributes = new Map<string, string>()
  const cache = new Map<string, string>()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    matchMedia: () => ({ matches: systemDark }),
    localStorage: { setItem: (name: string, value: string) => cache.set(name, value) }
  } })
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) }
  } })
  try {
    for (const dark of [false, true]) {
      systemDark = dark
      for (const preset of presets) for (const mode of ['system', ...modes] as const) {
        applyTheme({ themePreset: preset, themeMode: mode })
        assert.equal(attributes.get('data-theme'), preset)
        assert.equal(attributes.get('data-theme-mode'), mode === 'system' ? (dark ? 'dark' : 'light') : mode)
        assert.deepEqual(JSON.parse(cache.get('selection-translator.theme')!), { themePreset: preset, themeMode: mode })
      }
      assert.equal(resolveThemeMode('system'), dark ? 'dark' : 'light')
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})
