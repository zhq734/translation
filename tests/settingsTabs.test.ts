import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const GROUP_IDS = ['general', 'ai', 'ocr', 'translation-services', 'advanced', 'logs', 'about'] as const

/**
 * 获取指定元素的开始标签，便于校验设置页可访问性属性。
 * @param html 设置页 HTML 内容。
 * @param id 元素 ID。
 * @returns 指定元素的开始标签。
 * @author zhenghq
 */
function getOpeningTag(html: string, id: string): string {
  const match = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`, 'u'))
  assert.ok(match, `缺少元素 #${id}`)
  return match[0]
}

test('设置页应展示七个可访问的左侧一级分组与稳定内容面板', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  assert.match(html, /class="settings-sidebar"/u)
  assert.match(html, /role="tablist"[^>]+aria-label="设置分类"[^>]+aria-orientation="vertical"/u)

  for (const [index, groupId] of GROUP_IDS.entries()) {
    const tab = getOpeningTag(html, `settings-tab-${groupId}`)
    const panel = getOpeningTag(html, `settings-panel-${groupId}`)
    assert.match(tab, /role="tab"/u)
    assert.match(tab, new RegExp(`aria-controls="settings-panel-${groupId}"`, 'u'))
    assert.match(panel, /role="tabpanel"/u)
    assert.match(panel, new RegExp(`aria-labelledby="settings-tab-${groupId}"`, 'u'))
    assert.match(tab, new RegExp(`aria-selected="${index === 0 ? 'true' : 'false'}"`, 'u'))
    index === 0
      ? assert.doesNotMatch(panel, /\shidden(?:\s|>)/u)
      : assert.match(panel, /\shidden(?:\s|>)/u)
  }

  assert.equal((html.match(/role="tab"/gu) ?? []).length, GROUP_IDS.length)
})

test('翻译服务应合并钉钉、微软和 DeepLX 并提供二级入口', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const start = html.indexOf('id="settings-panel-translation-services"')
  const end = html.indexOf('id="settings-panel-advanced"', start)
  const panel = html.slice(start, end)

  assert.ok(start >= 0 && end > start)
  assert.match(panel, /id="translation-service-dingtalk"/u)
  assert.match(panel, /id="translation-service-microsoft"/u)
  assert.match(panel, /id="translation-service-deeplx"/u)
  assert.match(panel, /data-service-anchor="dingtalk"/u)
  assert.match(panel, /data-service-anchor="microsoft"/u)
  assert.match(panel, /data-service-anchor="deeplx"/u)
  assert.match(panel, /<h2>钉钉翻译<\/h2>/u)
  assert.match(panel, /<h2>微软翻译<\/h2>/u)
  assert.match(panel, /<h2>自建 DeepLX<\/h2>/u)
})

test('分组导航应支持旧标识映射、hash 回退和纵向键盘导航', () => {
  const source = readFileSync('src/renderer/src/settings.ts', 'utf8')
  assert.match(source, /dingtalk:\s*'translation-services'/u)
  assert.match(source, /microsoft:\s*'translation-services'/u)
  assert.match(source, /deeplx:\s*'translation-services'/u)
  assert.match(source, /window\.location\.hash/u)
  assert.match(source, /window\.addEventListener\('hashchange'/u)
  assert.match(source, /'general'/u)
  assert.match(source, /ArrowUp/u)
  assert.match(source, /ArrowDown/u)
  assert.match(source, /Home/u)
  assert.match(source, /End/u)
})

test('切换分组应保留 DOM、表单值、加载数据和每组滚动位置', () => {
  const source = readFileSync('src/renderer/src/settings.ts', 'utf8')
  assert.match(source, /panel\.hidden/u)
  assert.doesNotMatch(source, /replaceChildren\([^)]*settingsTab/u)
  assert.match(source, /settingsGroupScrollPositions/u)
  assert.match(source, /activePanel\.scrollTop/u)
  assert.match(source, /requestAnimationFrame/u)
  assert.match(source, /initializeLogsPanel/u)
  assert.match(source, /initializeDiagnosticsPanel/u)
})

test('设置页应使用左侧导航、独立滚动内容和窄宽自适应布局', () => {
  const css = readFileSync('src/renderer/src/settings.css', 'utf8')
  assert.match(css, /\.settings-layout\s*\{[\s\S]*display:\s*flex/u)
  assert.match(css, /\.settings-sidebar\s*\{[\s\S]*width:\s*184px/u)
  assert.match(css, /\.settings-content\s*\{[\s\S]*flex:\s*1/u)
  assert.match(css, /\.settings-content\s*\{[\s\S]*min-width:\s*0/u)
  assert.match(css, /\.settings-content\s*\{[\s\S]*min-height:\s*0/u)
  assert.match(css, /\.tab-panel\s*\{[\s\S]*overflow-y:\s*auto/u)
  assert.match(css, /@media\s*\(max-width:\s*720px\)/u)
  assert.match(css, /\.row\s*\{[\s\S]*grid-template-columns/u)
})

test('设置页菜单文字应使用主题语义色并保证选中项对比度', () => {
  const css = readFileSync('src/renderer/src/settings.css', 'utf8')
  assert.match(css, /\.settings-tab\s*\{[^}]*color:\s*var\(--text-secondary\)/u)
  assert.match(
    css,
    /\.settings-tab\[aria-selected='true'\]\s*\{[^}]*color:\s*var\(--button-text\)/u
  )
})

test('设置页一级菜单应靠左对齐并在文字前展示对应图标', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const css = readFileSync('src/renderer/src/settings.css', 'utf8')
  const labels = ['常规', 'AI 翻译', 'OCR', '翻译服务', '高级', '日志', '关于']

  for (const [index, groupId] of GROUP_IDS.entries()) {
    const tabStart = html.indexOf(`id="settings-tab-${groupId}"`)
    const tabEnd = html.indexOf('</button>', tabStart)
    const tab = html.slice(tabStart, tabEnd)
    assert.match(tab, /<svg class="settings-tab-icon"[^>]+aria-hidden="true"[^>]+focusable="false"/u)
    assert.match(tab, new RegExp(`<span class="settings-tab-label">${labels[index]}</span>`, 'u'))
    assert.ok(tab.indexOf('settings-tab-icon') < tab.indexOf('settings-tab-label'))
  }

  assert.match(css, /\.settings-tab\s*\{[^}]*display:\s*flex/u)
  assert.match(css, /\.settings-tab\s*\{[^}]*justify-content:\s*flex-start/u)
  assert.match(css, /\.settings-tab\s*\{[^}]*text-align:\s*left/u)
  assert.match(css, /\.settings-tab-icon\s*\{[^}]*stroke:\s*currentColor/u)
})

test('设置页数字输入框应与下拉框使用统一控件高度和主题样式', () => {
  const css = readFileSync('src/renderer/src/settings.css', 'utf8')
  assert.match(css, /select,[\s\S]*input\[type=['"]number['"]\]/u)
  assert.match(css, /select,[\s\S]*input\[type=['"]number['"]\][\s\S]*min-height:\s*36px/u)
  assert.match(css, /select,[\s\S]*input\[type=['"]number['"]\][\s\S]*padding:\s*7px\s+10px/u)
})

test('关于页项目卡片应在右下角对齐展示作者与邮箱', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const aboutIndex = html.indexOf('id="settings-panel-about"')
  const projectIndex = html.indexOf('<h2>项目</h2>', aboutIndex)
  const projectSection = html.slice(projectIndex)
  assert.match(projectSection, /class="project-meta"/u)
  assert.match(projectSection, /<dt>作者<\/dt>\s*<dd>zhenghq<\/dd>/u)
  assert.match(projectSection, /<dt>邮箱<\/dt>\s*<dd>734652567@qq\.com<\/dd>/u)
})

test('设置操作反馈应使用脱离内容布局的主题气泡提示', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const source = readFileSync('src/renderer/src/settings.ts', 'utf8')
  const css = readFileSync('src/renderer/src/settings.css', 'utf8')
  const mainEnd = html.indexOf('</main>')
  const toastIndex = html.indexOf('id="saved"')
  const toast = getOpeningTag(html, 'saved')

  assert.ok(mainEnd >= 0 && toastIndex > mainEnd, '气泡提示应位于主内容区域之外')
  assert.match(toast, /class="settings-toast"/u)
  assert.match(toast, /role="status"/u)
  assert.match(toast, /aria-live="polite"/u)
  assert.match(toast, /aria-atomic="true"/u)
  assert.match(html, /id="saved-icon" class="settings-toast-icon"[^>]+aria-hidden="true"/u)
  assert.match(html, /id="saved-message"/u)

  assert.match(source, /savedEl\.dataset\.state/u)
  assert.match(source, /savedMessageEl\.textContent\s*=\s*message/u)
  assert.match(source, /savedIconEl\.textContent/u)
  assert.match(source, /savedEl\.classList\.add\('visible'\)/u)
  assert.match(source, /savedEl\.classList\.remove\('visible'\)/u)

  assert.match(css, /\.settings-toast\s*\{[^}]*position:\s*fixed/u)
  assert.match(css, /\.settings-toast\s*\{[^}]*background:\s*var\(--toast-bg\)/u)
  assert.match(css, /\.settings-toast\s*\{[^}]*border:\s*var\(--border-width\)\s+solid\s+var\(--toast-border\)/u)
  assert.match(css, /\.settings-toast\s*\{[^}]*color:\s*var\(--toast-text\)/u)
  assert.match(css, /\.settings-toast\.visible/u)
  assert.match(css, /\.settings-toast\[data-state='error'\][^{]*\{[^}]*var\(--status-error\)/u)
  assert.match(css, /\.settings-toast\[data-state='warning'\][^{]*\{[^}]*var\(--status-warning\)/u)
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/u)
  assert.doesNotMatch(css, /\.saved\s*\{/u)
})
