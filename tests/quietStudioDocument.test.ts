import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const html = readFileSync('src/renderer/document.html', 'utf8')
const css = readFileSync('src/renderer/src/document.css', 'utf8')
const elements = readFileSync('src/renderer/src/documentElements.ts', 'utf8')

/**
 * 提取指定选择器的首个声明块，避免媒体查询中的覆盖掩盖默认布局缺陷。
 * @param selector 完整 CSS 选择器。
 * @returns 该选择器对应的声明文本。
 * @author zhenghq
 */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const body = new RegExp(`(?:^|[},]\\s*)${escaped}\\s*\\{([^}]*)\\}`, 'mu').exec(css)?.[1]
  assert.ok(body, `缺少样式规则：${selector}`)
  return body
}

/**
 * 读取带稳定 ID 的开始标签，验证控制器及无障碍绑定。
 * @param id 元素 ID。
 * @returns 原始 HTML 开始标签。
 * @author zhenghq
 */
function tag(id: string): string {
  const value = new RegExp(`<[^>]+\\bid="${id}"[^>]*>`, 'u').exec(html)?.[0]
  assert.ok(value, `缺少 DOM ID：${id}`)
  return value
}

test('静阅文档保留全部控制器绑定、隐藏态及无障碍名称', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1])
  assert.equal(new Set(ids).size, ids.length, 'ID 不得重复')
  for (const match of elements.matchAll(/getElementById\('([^']+)'\)/gu)) tag(match[1])
  for (const id of ['document-workbench', 'document-file-summary', 'document-source-ocr-mode',
    'document-history-popover', 'document-history-status', 'document-cancel-button',
    'document-partial-status', 'document-export-incomplete-notice', 'document-export-progress',
    'document-export-open-folder', 'document-toc-list']) assert.match(tag(id), /\bhidden\b/u)
  assert.match(tag('document-drop-zone'), /tabindex="0".*role="button"/u)
  assert.match(tag('document-drop-zone'), /aria-describedby="document-upload-formats document-upload-privacy"/u)
  assert.match(tag('document-file-tabs'), /role="tablist"/u)
  assert.match(tag('document-history-button'), /aria-haspopup="listbox".*aria-expanded="false".*aria-controls="document-history-popover"/u)
  assert.match(tag('document-sync-scroll'), /role="switch".*aria-checked="true"/u)
  assert.match(tag('document-progressbar'), /role="progressbar".*aria-valuemin="0".*aria-valuemax="100".*aria-valuenow="0"/u)
  assert.match(tag('document-source-content'), /tabindex="0"/u)
  assert.match(tag('document-translation-content'), /tabindex="0"/u)
})

test('静阅导入区聚焦拖放与选择，格式和隐私说明独立展示并复用翻译键', () => {
  const drop = /<div id="document-drop-zone"[\s\S]*?<\/div>/u.exec(html)?.[0] ?? ''
  assert.match(drop, /<svg[^>]*class="document-drop-zone-icon"[^>]*aria-hidden="true"/u)
  assert.match(drop, /data-i18n="document\.upload\.chooseFile"/u)
  assert.doesNotMatch(drop, /id="document-upload-(?:formats|privacy)"/u)
  assert.match(html, /class="document-upload-support"[\s\S]*id="document-upload-formats"[\s\S]*id="document-upload-privacy"/u)
  assert.match(tag('document-file-input'), /multiple.*accept="[^"]*\.pdf[^"]*\.vtt[^"]*\.bmp".*hidden/u)
  assert.match(rule('.document-upload-card'), /box-shadow:\s*var\(--shadow-panel\)/u)
  assert.match(rule('.document-drop-zone-action'), /background:\s*var\(--button-bg\)/u)
  assert.match(rule('.document-upload-heading h1'), /font-size:\s*var\(--font-size-title\)/u)
})

test('静阅将重译收纳到原有翻译菜单，保留顶部重试、历史与主导出动作', () => {
  const main = html.slice(html.indexOf('class="document-toolbar-main"'), html.indexOf('class="document-toolbar-meta"'))
  const translationMenu = /<details class="document-toolbar-menu"[^>]*>[\s\S]*?<\/details>/u.exec(html)?.[0] ?? ''
  assert.doesNotMatch(main, /id="document-rerun-button"/u)
  assert.match(main, /id="document-retry-button"/u)
  assert.match(main, /id="document-history-button"/u)
  assert.match(translationMenu, /data-i18n="document\.menu\.translation"[\s\S]*class="document-task-actions"[\s\S]*id="document-rerun-button"/u)
  assert.match(tag('document-export-button'), /class="document-primary-button"/u)
  assert.match(rule('.document-task-actions'), /flex-wrap:\s*wrap/u)
  assert.match(rule('.document-toolbar-menu-panel'), /overflow:\s*visible/u)
})

test('静阅标签与工作区使用中性层级而非整块强调渐变', () => {
  assert.match(rule(".document-file-tab[aria-selected='true']"), /background:\s*var\(--accent-soft\)/u)
  assert.match(rule(".document-file-tab[aria-selected='true']"), /color:\s*var\(--text-primary\)/u)
  assert.match(rule('.document-toolbar'), /background:\s*var\(--panel-bg\)/u)
  assert.match(rule('.document-column-header'), /background:\s*var\(--surface-subtle\)/u)
  assert.match(rule('.document-progress-panel'), /min-height:\s*0/u)
  assert.doesNotMatch(css, /var\(--accent-gradient\)|#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\(/iu)
})

test('静阅全部导出、部分导出、删除确认和历史弹层共享克制样式且可滚动', () => {
  for (const id of ['document-export-dialog', 'document-partial-export-dialog', 'document-history-confirm-dialog']) {
    assert.match(tag(id), /class="[^"]*\bdocument-dialog\b/u)
    assert.match(tag(id), /aria-labelledby="[^"]+".*aria-describedby="[^"]+"/u)
  }
  assert.match(tag('document-history-confirm-dialog'), /role="alertdialog".*aria-modal="true"/u)
  assert.match(rule('.document-dialog'), /border-radius:\s*var\(--radius-window\)/u)
  assert.match(rule('.document-dialog:not([open])'), /display:\s*none/u)
  assert.match(rule('.document-dialog-content'), /min-height:\s*0[\s\S]*overflow:\s*auto/u)
  assert.match(rule('.document-dialog-actions'), /flex-wrap:\s*wrap/u)
  assert.match(rule('.document-history-popover'), /border-radius:\s*var\(--radius-window\)/u)
  assert.match(rule('.document-history-footer'), /flex-wrap:\s*wrap/u)
  assert.match(rule('.document-history-danger-button'), /color:\s*var\(--status-error\)/u)
})

test('静阅窄屏不会把文件名的横向 flex 基准变成 260px 高度，工具换行仍保留阅读区', () => {
  const narrow = css.slice(css.indexOf('@media (max-width: 620px)'))
  assert.match(narrow, /\.document-file-identity\s*\{[^}]*flex:\s*0 1 auto/su)
  assert.match(narrow, /\.document-file-tabs-shell\s*\{[^}]*flex:\s*0 1 auto/su)
  assert.match(narrow, /\.document-workbench-actions\s*\{[^}]*flex-wrap:\s*wrap/su)
  assert.match(rule('.document-progress-copy'), /max-height:[^;]+;[\s\S]*overflow-y:\s*auto/u)
  for (const selector of ['.document-shell', '.document-workbench', '.document-columns', '.document-column', '.document-page-scroll']) {
    assert.match(rule(selector), /min-width:\s*0/u)
    assert.match(rule(selector), /min-height:\s*0/u)
  }
  assert.match(rule('.document-columns'), /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/u)
  assert.match(rule('.document-page-scroll'), /overflow:\s*auto/u)
})

test('静阅短窗口限制工具区占高，并排保留纸张而不裁切展开菜单', () => {
  const compact = css.slice(css.indexOf('@media (max-height: 600px)'))
  assert.match(compact, /\.document-toolbar\s*\{[^}]*max-height:\s*25vh;[^}]*overflow-y:\s*auto/su)
  assert.match(compact, /\.document-workbench-header\s*\{[^}]*max-height:\s*25vh;[^}]*overflow-y:\s*auto/su)
  assert.match(compact, /\.document-columns\[data-view-mode='spread'\]\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\);[^}]*grid-template-rows:\s*minmax\(0, 1fr\)/su)
  assert.match(compact, /\.document-toolbar-menu-panel,[\s\S]*?\.document-history-popover\s*\{[^}]*position:\s*fixed;[^}]*max-height:\s*70vh;[^}]*overflow-y:\s*auto/su)
  assert.match(compact, /\.document-toolbar-menu\[data-menu-align='end'\] \.document-toolbar-menu-panel\s*\{[^}]*left:\s*var\(--space-3\)/su)
  assert.match(rule('.document-workbench-actions > button'), /max-width:\s*100%/u)
})

test('静阅底部多行任务状态可通过键盘聚焦滚动，保留实时播报', () => {
  assert.match(html, /class="document-progress-copy"[^>]*tabindex="0"[^>]*data-i18n-attr="aria-label:document\.progress\.label"/u)
  assert.match(tag('document-progress-panel'), /aria-live="polite"/u)
})

test('静阅紧凑菜单不能以 transform 建立包含块裁切既有目录浮层', () => {
  for (const condition of ['@media (max-width: 620px)', '@media (max-height: 600px)']) {
    const compact = css.slice(css.indexOf(condition), css.indexOf('@media', css.indexOf(condition) + 1))
    assert.match(compact, /\.document-toolbar-menu-panel\s*\{[^}]*top:\s*calc\(var\(--titlebar-height\) \+ var\(--space-2\)\);[^}]*transform:\s*none/su)
  }
})

test('静阅隐藏属性优先于布局规则，焦点和减少动态效果覆盖菜单、弹层及滚动区', () => {
  assert.match(rule('[hidden]'), /display:\s*none\s*!important/u)
  assert.match(css, /\.document-shell :focus,[\s\S]*?\.document-dialog :focus\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/u)
  assert.match(css, /\.document-shell :focus-visible,[\s\S]*?\.document-dialog :focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/u)
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
  assert.match(reduced, /\.document-drop-zone,[\s\S]*?\.document-toolbar-menu-trigger::after[\s\S]*?transition:\s*none/u)
  assert.match(reduced, /\.document-page-scroll\s*\{[^}]*scroll-behavior:\s*auto/u)
})

test('静阅不侵入纸张计算，PDF/OCR/译文和目标级状态继续保留', () => {
  assert.match(css, /\.document-page\[data-layout='translation-flow'\]/u)
  assert.match(css, /\.document-page\[data-layout='absolute'\]/u)
  assert.match(css, /var\(--document-page-scale, 1\)/u)
  assert.match(css, /var\(--document-paper-bg\)/u)
  for (const name of ['document-preview-host', 'document-pdf-page', 'document-pdf-canvas',
    'document-image-block', 'document-markdown-preview', 'document-table-preview',
    'document-subtitle-preview', 'document-manual-edit-active', 'document-search-current',
    'document-translation-failed', 'document-translation-pending', 'document-block-action-menu',
    'document-partial-export-notice', 'document-warning-list']) assert.ok(css.includes(`.${name}`), name)
  assert.doesNotMatch(rule('.document-columns') + rule('.document-column'), /\b(?:transform|zoom|contain):/u)
  assert.match(rule(".document-columns[data-view-mode='source'] .document-column:last-child"), /display:\s*none/u)
  assert.match(rule(".document-columns[data-view-mode='translation'] .document-column:first-child"), /display:\s*none/u)
})
