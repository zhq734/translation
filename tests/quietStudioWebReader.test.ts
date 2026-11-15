import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { readAttributeI18nKey, readTextI18nKey, tForTest } from './helpers/i18n.ts'

const html = readFileSync('src/renderer/web-reader.html', 'utf8')
const css = readFileSync('src/renderer/src/webReader.css', 'utf8')
const renderer = readFileSync('src/renderer/src/webReader.ts', 'utf8')

/**
 * 查找稳定 ID 的唯一开始标签，防止外壳重排破坏事件绑定。
 * @param id 控制器依赖的元素 ID。
 * @returns 对应的开始标签。
 * @author zhenghq
 */
function tag(id: string): string {
  const matches = [...html.matchAll(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`, 'gu'))]
  assert.equal(matches.length, 1, `${id} 必须存在且唯一`)
  return matches[0][0]
}

/**
 * 读取指定独立选择器的基础声明，跳过共享选择器组，检查布局与主题合同。
 * @param selector CSS 选择器。
 * @returns 首个规则的声明体。
 * @author zhenghq
 */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const source = css.replace(/\/\*[\s\S]*?\*\//gu, '')
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]+)\\}`, 'u').exec(source)
  assert.ok(match, `缺少布局规则：${selector}`)
  return match[1]
}

test('静阅网页阅读器将地址导航和翻译工具分为两个命名区域', () => {
  const navigation = /<header\b[^>]*class="[^"]*\bweb-navigation-toolbar\b[^"]*"[^>]*>[\s\S]*?<\/header>/u.exec(html)?.[0] ?? ''
  const translation = /<section\b[^>]*class="[^"]*\bweb-translation-toolbar\b[^"]*"[^>]*>[\s\S]*?<\/section>/u.exec(html)?.[0] ?? ''
  assert.match(navigation, /data-i18n-attr="aria-label:webReader.navigationToolbar"/u)
  for (const id of ['web-back', 'web-forward', 'web-reload', 'web-address-form', 'web-address']) {
    assert.ok(navigation.includes(`id="${id}"`), `导航层缺少 ${id}`)
    assert.ok(!translation.includes(`id="${id}"`))
  }
  assert.match(translation, /data-i18n-attr="aria-label:webReader.translatePage"/u)
  for (const id of ['web-source-lang', 'web-target-lang', 'web-mode', 'web-translate', 'web-cancel', 'web-export-pdf']) {
    assert.ok(translation.includes(`id="${id}"`), `翻译层缺少 ${id}`)
    assert.ok(!navigation.includes(`id="${id}"`))
  }
  assert.ok(html.indexOf(navigation) < html.indexOf(translation))
  assert.ok(html.indexOf(translation) < html.indexOf('id="web-view-slot"'))
  assert.match(translation, /class="web-language-pair"/u)
  assert.match(translation, /class="web-translation-actions"/u)
})

test('静阅网页阅读器保留全部控制器 ID、翻译键、默认禁用与原生显示模式', () => {
  for (const match of renderer.matchAll(/getElementById\('([^']+)'\)/gu)) tag(match[1])
  for (const id of ['web-back', 'web-forward', 'web-cancel', 'web-export-pdf']) assert.match(tag(id), /\bdisabled\b/u)
  for (const [id, key] of Object.entries({
    'web-translate': 'webReader.translatePage',
    'web-cancel': 'common.cancel',
    'web-export-pdf': 'webReader.exportPdf'
  })) assert.equal(readTextI18nKey(tag(id)), key)
  for (const [id, key] of Object.entries({
    'web-address': 'webReader.address', 'web-source-lang': 'menu.sourceLanguage',
    'web-target-lang': 'menu.targetLanguage', 'web-mode': 'webReader.displayMode',
    'window-minimize': 'common.minimize', 'window-maximize': 'common.maximize',
    'window-close': 'common.close', 'web-back': 'webReader.back',
    'web-forward': 'webReader.forward', 'web-reload': 'webReader.reload'
  })) assert.equal(readAttributeI18nKey(tag(id), 'aria-label'), key)
  const modes = /<select id="web-mode"[^>]*>([\s\S]*?)<\/select>/u.exec(html)?.[1] ?? ''
  assert.deepEqual([...modes.matchAll(/value="([^"]+)"/gu)].map((match) => match[1]), ['target', 'source', 'bilingual'])
  for (const mode of ['target', 'source', 'bilingual']) assert.ok(modes.includes(`data-i18n="webReader.mode.${mode}"`))
  for (const declaration of html.matchAll(/data-i18n(?:-attr)?="([^"]+)"/gu)) {
    for (const entry of declaration[1].split(';')) {
      const key = entry.includes(':') ? entry.split(':')[1] : entry
      for (const locale of ['zh-CN', 'en-US'] as const) assert.notEqual(tForTest(locale, key), key)
    }
  }
})

test('静阅网页工具区以中性分组和明确显示标签替代渐变大工具栏', () => {
  assert.match(rule('.web-navigation-toolbar'), /background:\s*var\(--panel-bg\)/u)
  assert.match(rule('.web-translation-toolbar'), /background:\s*var\(--surface-subtle\)/u)
  assert.match(rule('.web-translation-toolbar'), /border-bottom:\s*1px solid var\(--border-subtle\)/u)
  assert.match(rule('.web-mode-control'), /border-left:\s*1px solid var\(--border-subtle\)/u)
  assert.match(html, /class="web-mode-control"><span data-i18n="webReader.display"/u)
  assert.match(rule('.primary-button'), /background:\s*var\(--button-bg\)/u)
  assert.match(rule('.primary-button'), /color:\s*var\(--text-on-accent\)/u)
  assert.doesNotMatch(css, /var\(--accent-gradient\)|#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\(/iu)
})

test('静阅网页工具区窄屏分行、低窗口局部滚动并始终为远程内容留空间', () => {
  assert.match(rule('.web-reader-shell'), /height:\s*100%/u)
  assert.match(rule('.web-navigation-toolbar'), /flex-wrap:\s*nowrap/u)
  assert.match(rule('.web-address-form'), /min-width:\s*0/u)
  assert.match(rule('.web-translation-toolbar'), /display:\s*flex/u)
  assert.match(rule('.web-translation-toolbar'), /flex-wrap:\s*wrap/u)
  assert.match(rule('.web-translation-toolbar'), /max-height:\s*32vh/u)
  assert.match(rule('.web-translation-toolbar'), /overflow-y:\s*auto/u)
  assert.match(rule('.web-translation-actions'), /flex-wrap:\s*wrap/u)
  assert.match(rule('.web-view-slot'), /flex:\s*1/u)
  assert.match(rule('.web-view-slot'), /min-height:\s*0/u)
  assert.match(rule('.web-view-slot'), /min-width:\s*0/u)
  assert.match(rule('.web-translation-settings'), /flex-wrap:\s*wrap/u)
  assert.match(rule('.web-translation-actions'), /margin-left:\s*auto/u)
  assert.match(css, /@media\s*\(max-width:\s*480px\)/u)
  assert.doesNotMatch(css, /order:\s*2/u)
})

test('静阅网页状态安静、进度隐藏有效且键盘及无动态偏好有回退', () => {
  assert.match(tag('web-status'), /role="status".*aria-live="polite"/u)
  assert.match(tag('web-loading-progress'), /role="progressbar".*aria-valuemin="0".*aria-valuemax="100".*hidden/u)
  assert.match(rule('.web-status'), /text-overflow:\s*ellipsis/u)
  assert.match(rule('.web-status'), /background:\s*var\(--panel-bg\)/u)
  assert.match(rule('.web-loading-progress'), /height:\s*2px/u)
  assert.match(rule('.web-reader-shell [hidden]'), /display:\s*none\s*!important/u)
  assert.match(css, /button:focus[\s\S]*select:focus\s*\{[^}]*outline:\s*2px solid var\(--focus-outline\)/u)
  assert.match(css, /:focus-visible/u)
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*animation:\s*none/u)
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*transition:\s*none/u)
})

test('静阅网页占位仍为空，布局变化通过原有 ResizeObserver 同步原生视图', () => {
  assert.match(html, /<section id="web-view-slot"[^>]*><\/section>/u)
  assert.doesNotMatch(html, /<(?:iframe|webview)\b/u)
  assert.doesNotMatch(renderer, /insertCSS|executeJavaScript|viewSlot\.(?:innerHTML|appendChild|replaceChildren)/u)
  const sync = /function syncViewBounds\(\): void \{([\s\S]*?)\n\}/u.exec(renderer)?.[1]
  const observe = /const resizeObserver = new ResizeObserver\(syncViewBounds\)[\s\S]*?window.addEventListener\('beforeunload', [^\n]+/u.exec(renderer)?.[0]
  assert.ok(sync)
  assert.ok(observe)
  const calls: unknown[] = []
  const listeners: Record<string, () => void> = {}
  let resize: () => void = () => undefined
  let disconnected = false
  let rect = { x: 0, y: 160, width: 1080, height: 640 }
  const slot = { getBoundingClientRect: () => rect }
  runInNewContext(`function syncViewBounds() {${sync}}\n${observe}\nsyncViewBounds()`, {
    viewSlot: slot,
    window: {
      api: { webViewSetBounds: (bounds: unknown) => calls.push(JSON.parse(JSON.stringify(bounds))) },
      addEventListener: (event: string, callback: () => void) => { listeners[event] = callback }
    },
    ResizeObserver: class {
      /** 保存待测边界回调；参数为观测回调，返回观测器实例。@author zhenghq */
      constructor(callback: () => void) { resize = callback }
      /** 核验观测目标；参数为占位对象，无返回值。@author zhenghq */
      observe(target: unknown): void { assert.equal(target, slot) }
      /** 模拟关闭窗口取消观测；无参数，无返回值。@author zhenghq */
      disconnect(): void { disconnected = true }
    }
  })
  assert.deepEqual(calls[0], rect)
  rect = { x: 0, y: 208, width: 360, height: 332 }
  resize()
  assert.deepEqual(calls[1], rect, '工具栏换行必须读取新占位边界而非固定偏移')
  listeners.resize()
  assert.deepEqual(calls[2], rect)
  listeners.beforeunload()
  assert.equal(disconnected, true)
  assert.match(renderer, /requestAnimationFrame\(syncViewBounds\)/u)
})
