import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { tForTest } from './helpers/i18n.ts'

const html = readFileSync('src/renderer/settings.html', 'utf8')
const css = readFileSync('src/renderer/src/settings.css', 'utf8')
const source = readFileSync('src/renderer/src/settings.ts', 'utf8')
const groups = ['general', 'ai', 'ocr', 'translation-services', 'subtitle', 'advanced', 'logs', 'about']
const themes = ['sakura', 'emerald', 'sky', 'navy', 'platinum-black']

/**
 * 提取指定选择器的首个 CSS 规则，避免跨规则匹配导致布局断言误通过。
 * @param selector 需要检查的完整选择器。
 * @returns 选择器对应的声明块。
 * @author zhenghq
 */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`, 'u'))
  assert.ok(match, `缺少 CSS 规则 ${selector}`)
  return match[1]
}

/**
 * 获取分类面板的静态内容，以校验各分类均使用统一标题与分组结构。
 * @param group 分类标识。
 * @returns 当前分类的 HTML 片段。
 * @author zhenghq
 */
function panel(group: string): string {
  const start = html.indexOf(`id="settings-panel-${group}"`)
  assert.ok(start >= 0, `缺少分类 ${group}`)
  const next = html.indexOf('id="settings-panel-', start + 1)
  return html.slice(start, next < 0 ? html.indexOf('</main>', start) : next)
}

/**
 * 对稳定接口清单生成指纹，锁定改版前全部 ID 与本地化绑定而非仅校验数量。
 * @param values 需要保持兼容的接口标识。
 * @returns 排序去重后的 SHA-256 指纹。
 * @author zhenghq
 */
function contractFingerprint(values: string[]): string {
  return createHash('sha256').update([...new Set(values)].sort().join('\n')).digest('hex')
}

test('Quiet Studio 八分类均有本地化面板标题与扁平分组，不删除已有控件入口', () => {
  for (const group of groups) {
    const content = panel(group)
    assert.match(content, /<header class="settings-panel-heading">\s*<h2 data-i18n="settings\.tab\.[^"]+">/u)
    assert.match(content, /<section\b/u)
    assert.match(content, /role="tabpanel"/u)
  }
  const ids = [...html.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1])
  assert.equal(new Set(ids).size, ids.length, '设置 ID 不可重复')
  const portableIds = ['portable-notice', 'portable-data-directory']
  for (const id of portableIds) assert.ok(ids.includes(id), `便携新增 ID 必须存在：${id}`)
  assert.equal(contractFingerprint(ids.filter((id) => !portableIds.includes(id))), '3ff478fb64150873538ef35a2d9dd90770ff17a97a89002b414ad8a78690d419', '保留改版前 225 个配置、状态和操作 ID')
  const bindings = [...html.matchAll(/data-i18n(?:-attr)?="([^"]+)"/gu)].map((match) => match[1])
  const portableBindings = ['settings.portable.title', 'settings.portable.restrictions', 'settings.portable.dataDirectory']
  for (const key of portableBindings) assert.ok(bindings.includes(key), `便携新增本地化绑定必须存在：${key}`)
  assert.equal(contractFingerprint(bindings.filter((key) => !portableBindings.includes(key))), '140d9ac75dbcc6c9e5ccbb79e3ec96ae1b732c080576bd209ef947916b4dfef5', '保留改版前 385 个本地化绑定，不引入未翻译文案')
  for (const match of source.matchAll(/getElementById\(['"]([^'"]+)['"]\)/gu)) {
    assert.ok(ids.includes(match[1]), `控制器引用的 #${match[1]} 必须保留`)
  }
  for (const match of html.matchAll(/data-i18n="([^"]+)"/gu)) {
    assert.notEqual(tForTest('en-US', match[1]), match[1], `本地化键必须存在：${match[1]}`)
  }
  assert.match(rule('.tab-panel > section'), /border:\s*0/u)
  assert.match(rule('.tab-panel > section + section'), /border-top:\s*1px solid var\(--border-subtle\)/u)
})

/**
 * 校验侧栏保留中性表面、明显的主题选中态与窄屏分类名称。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Quiet Studio 侧栏使用中性表面与高对比选中态，窄屏不隐藏分类名称', () => {
  assert.match(rule('.settings-sidebar'), /background:\s*var\(--surface-subtle\)/u)
  assert.match(rule('.settings-sidebar'), /overflow-y:\s*auto/u)
  assert.match(rule(".settings-tab[aria-selected='true']"), /background:\s*var\(--button-bg\)/u)
  assert.match(rule(".settings-tab[aria-selected='true']"), /border-color:\s*var\(--button-bg\)/u)
  assert.match(rule('.settings-tab-label'), /white-space:\s*normal/u)
  assert.match(rule('.settings-tab-label'), /overflow-wrap:\s*anywhere/u)
  assert.doesNotMatch(css, /\.settings-tab-label\s*\{[^}]*display:\s*none/u)
  assert.match(css, /@media\s*\(max-width:\s*540px\)/u)
  assert.match(css, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/u)
})

test('Quiet Studio 五种主题均显示界面结构缩略图，而不是单纯渐变色条', () => {
  for (const theme of themes) {
    const start = html.indexOf(`data-theme-preset="${theme}"`)
    const card = html.slice(start, html.indexOf('</button>', start))
    assert.match(card, /class="theme-preset-preview" aria-hidden="true"/u)
    assert.match(card, /class="theme-preview-sidebar"/u)
    assert.match(card, /class="theme-preview-content"/u)
    assert.match(card, /class="theme-preview-line"/u)
    assert.match(card, /class="theme-preview-action"/u)
    assert.match(rule(`[data-theme-preset='${theme}']`), new RegExp(`var\\(--theme-${theme}-gradient\\)`, 'u'))
  }
  assert.match(rule('.theme-preset-preview'), /background:\s*var\(--page-bg\)/u)
  assert.match(rule('.theme-preview-content'), /background:\s*var\(--panel-bg\)/u)
  assert.match(rule('.theme-preview-action'), /background:\s*var\(--preview-accent\)/u)
  assert.match(css, /\.theme-preset-card\[aria-pressed='true'\]/u)
})

test('Quiet Studio 服务分组、等宽日志与简洁更新区保留状态和操作', () => {
  assert.match(panel('ai'), /class="settings-form-group"/u)
  for (const service of ['bili-index', 'dingtalk', 'microsoft', 'deeplx']) {
    assert.match(html, new RegExp(`<section id="translation-service-${service}" class="service-section" data-service-anchor="${service}"`, 'u'))
  }
  assert.match(rule('.logs-list'), /font-family:[^;]*monospace/u)
  assert.match(rule('.logs-section'), /min-height:\s*240px/u)
  assert.match(rule('.logs-filters'), /flex-wrap:\s*wrap/u)
  assert.match(rule('.update-summary > div'), /border:\s*0/u)
  for (const id of ['logs-list', 'logs-status', 'diagnostics-body', 'update-action', 'update-cancel', 'saved']) {
    assert.ok(html.includes(`id="${id}"`))
  }
  assert.match(source, /savedMessageEl\.textContent\s*=\s*message/u)
  assert.match(source, /settingsGroupScrollPositions/u)
  assert.match(source, /nextPanel\.scrollTop\s*=/u)
  assert.match(source, /window\.localStorage\.setItem\(SETTINGS_TAB_STORAGE_KEY/u)
})

test('Quiet Studio 填满窗口、独立滚动、键盘焦点与全部 hidden 状态兼容', () => {
  assert.match(rule('body'), /display:\s*flex/u)
  assert.match(rule('.container'), /flex:\s*1/u)
  for (const selector of ['.container', '.settings-layout', '.settings-content', '.tab-panel']) {
    assert.match(rule(selector), /min-height:\s*0/u)
    assert.match(rule(selector), /min-width:\s*0/u)
  }
  assert.match(rule('.tab-panel'), /overflow-y:\s*auto/u)
  assert.match(rule('[hidden]'), /display:\s*none\s*!important/u)
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-outline\)/u)
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/u)
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\(/iu, '组件颜色必须使用主题 token')
})
