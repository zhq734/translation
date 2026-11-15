import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const home = readFileSync('site/index.html', 'utf8')
const docs = readFileSync('site/docs/index.html', 'utf8')
const missing = readFileSync('site/404.html', 'utf8')
const css = readFileSync('site/styles.css', 'utf8')
const docsCss = readFileSync('site/docs/docs.css', 'utf8')
const unix = 'curl -fsSL https://raw.githubusercontent.com/zhq734/translation/master/scripts/install.sh | sh'
const windows = 'irm https://raw.githubusercontent.com/zhq734/translation/master/scripts/install.ps1 | iex'

/** 提取并排序属性契约；参数为源码与正则，返回包含重复项的摘要。@author zhenghq */
function digest(source: string, pattern: RegExp): string {
  return createHash('sha256').update([...source.matchAll(pattern)].map(match => match[1]).sort().join('\n')).digest('hex')
}

/** 查找指定 CSS 规则；参数为样式与选择器，返回声明文本。@author zhenghq */
function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`, 'u'))
  assert.ok(match, `缺少规则：${selector}`)
  return match[1]
}

test('三页保留全部既有导航、下载链接、DOM ID 与媒体资源', () => {
  const contracts = [
    [home, '22940fb92bced90e9483d055ccd99e1c3ab8b59e6d3449ef179eab84aff74c82', 'dfc4c5591ee046c41d0380fcf3cbd1ec30262a7cddd0e9f0e4e01d5aff357729', '3c1c73db5fe417279a3caf8c01972dde5b3d67c4d9a2c09edbbc67d5b55a7ed9'],
    [docs, '325da797671f94c33923fc9a31eb4d2067cfc6115015c852f19ba783c425ec01', '46a3952f6d5e927853c8d6660e12c5125b726d83916b3ad6ce08112d9b312abe', '56d7ccbffe4790bb3b3518ef2d8925e1be645c69dfacfe2fece1714b2754e477'],
    [missing, '7d9d1ea32499a58af3055ff0732c2c68626fc5dc853f70b1195dd1de55b7021f', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855']
  ]
  for (const [source, links, ids, media] of contracts) {
    assert.equal(digest(source, /<a\b[^>]*\bhref="([^"]+)"/gu), links)
    assert.equal(digest(source, /\bid="([^"]+)"/gu), ids)
    assert.equal(digest(source, /\b(?:src|poster)="([^"]+)"/gu), media)
    assert.match(source, /<html lang="zh-CN">/u)
    assert.match(source, /name="viewport" content="width=device-width, initial-scale=1"/u)
  }
})

test('站内锚点和资源可解析，搜索用的文档全文仍在 DOM 内', () => {
  for (const [path, source] of [['', home], ['docs/', docs], ['404.html', missing]]) {
    for (const match of source.matchAll(/\b(?:href|src|poster)="([^"]+)"/gu)) {
      const target = new URL(match[1], `https://local.test/translation/${path}`)
      if (target.origin !== 'https://local.test') continue
      let file = target.pathname.replace(/^\/translation\//u, 'site/')
      if (file.endsWith('/')) file += 'index.html'
      assert.ok(existsSync(file), `${path} 的目标不存在：${match[1]}`)
      if (target.hash) assert.ok(readFileSync(file, 'utf8').includes(`id="${target.hash.slice(1)}"`), match[1])
    }
  }
  for (const id of ['install', 'permissions', 'quick-start', 'selection', 'ocr', 'web', 'document', 'subtitle', 'channels', 'settings', 'privacy', 'faq', 'limitations']) {
    assert.match(docs, new RegExp(`<section[^>]*id="${id}"[^>]*>`))
  }
  assert.doesNotMatch(docs, /<section[^>]*(?:hidden|aria-hidden="true")/u)
  assert.match(docs, /<nav class="toc" aria-label="文档章节">/u)
  assert.match(docs, /简体中文/u)
  assert.match(docs, /English/u)
})

test('全局明暗 token 驱动三页组件，无渐变、在线字体或硬编码组件颜色', () => {
  const components = css.replace(/:root\s*\{[^}]*\}/gu, '')
  assert.doesNotMatch(components + docsCss, /#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\(/iu)
  assert.doesNotMatch(css + docsCss, /gradient\(|@import|https?:\/\/|data:image/iu)
  for (const token of ['--bg', '--bg-elev', '--ink', '--muted', '--line', '--focus', '--text-reading', '--surface-subtle', '--surface-hover']) {
    assert.equal([...css.matchAll(new RegExp(`${token}:`, 'gu'))].length, 2, `${token} 需要明暗两套定义`)
  }
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/u)
  assert.match(css, /--shadow-panel:\s*none/u)
  assert.match(missing, /<link rel="stylesheet" href="\/translation\/styles.css">/u)
  assert.doesNotMatch(missing, /<style>/u)
})

/** 将十六进制颜色换算为相对亮度；参数为颜色值，返回 WCAG 相对亮度。@author zhenghq */
function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../gu)!.map(value => {
    const channel = Number.parseInt(value, 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

test('明暗正文、辅助文字、命令和动作文字对比度均不低于 4.5:1', () => {
  const themes = [...css.matchAll(/:root\s*\{([^}]+)\}/gu)]
  assert.equal(themes.length, 2)
  for (const [, block] of themes) {
    const tokens = Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[\da-f]{6})/gu)].map(match => [match[1], match[2]]))
    const pairs = ['--ink', '--ink-soft', '--text-reading', '--muted', '--faint'].flatMap(text => ['--bg', '--bg-elev', '--surface-subtle'].map(surface => [text, surface]))
    pairs.push(['--accent', '--accent-soft'], ['--code-ink', '--code-bg'], ['--bg-elev', '--ink'], ['--bg-elev', '--ink-soft'])
    for (const [text, surface] of pairs) {
      const values = [luminance(tokens[text]), luminance(tokens[surface])].sort((first, second) => second - first)
      assert.ok((values[0] + 0.05) / (values[1] + 0.05) >= 4.5, `${text}/${surface} 对比度不足`)
    }
  }
})

test('首页静态示意不遮挡正文，下载和导航在窄屏可换行且保留可访问名称', () => {
  assert.match(rule(css, '.hero-stage'), /background:\s*var\(--surface-subtle\)/u)
  assert.doesNotMatch(rule(css, '.floating-card'), /position:\s*absolute|animation:/u)
  assert.match(rule(css, '.product-mark'), /clamp\(36px,\s*4\.5vw,\s*56px\)/u)
  assert.match(rule(css, '.site-nav'), /flex-wrap:\s*wrap/u)
  assert.match(css, /@media\s*\(max-width:\s*760px\)[\s\S]*grid-template-columns:\s*1fr/u)
  assert.match(css, /\.hero-copy, \.hero-stage[^{]*\{[^}]*min-width:\s*0/u)
  for (const source of [home, docs]) assert.match(source, /<a[^>]*header-download[^>]*aria-label="下载桌面版"/u)
})

test('文档侧栏可独立滚动，正文保持阅读字号，表格键盘可滚动且窄屏不撑宽', () => {
  assert.match(rule(docsCss, '.docs-sidebar'), /max-height:\s*calc\(100vh - var\(--header-offset\)\)/u)
  assert.match(rule(docsCss, '.docs-sidebar'), /overflow-y:\s*auto/u)
  assert.match(rule(docsCss, '.doc-section p, .doc-section li'), /font-size:\s*16px/u)
  assert.match(rule(docsCss, '.doc-section p, .doc-section li'), /color:\s*var\(--text-reading\)/u)
  assert.match(rule(docsCss, '.table-wrap'), /max-width:\s*100%/u)
  assert.match(rule(docsCss, '.table-wrap'), /overflow-x:\s*auto/u)
  const tables = [...docs.matchAll(/<div class="table-wrap"([^>]*)>/gu)]
  assert.ok(tables.length > 0)
  for (const [, attributes] of tables) {
    assert.match(attributes, /tabindex="0"/u)
    assert.match(attributes, /role="region"/u)
    assert.match(attributes, /aria-label="[^"]+"/u)
  }
  assert.match(docsCss, /@media\s*\(max-width:\s*1000px\)[\s\S]*max-height:\s*none/u)
  assert.doesNotMatch(docsCss, /\.docs-sidebar-cta\s*\{\s*display:\s*none/u)
})

test('404 使用相同阅读布局和焦点，三页具有 hidden 与减少动态保护', () => {
  assert.match(missing, /<body class="not-found-page">/u)
  assert.match(missing, /<main class="not-found-card"/u)
  assert.match(rule(css, '.not-found-page'), /min-height:\s*100vh/u)
  assert.match(rule(css, '.not-found-card'), /width:\s*100%/u)
  assert.match(rule(css, '.not-found-card'), /max-width:\s*36rem/u)
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/u)
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/u)
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/u)
})

type Callback = () => unknown

class ElementStub {
  textContent = ''
  dataset: Record<string, string> = {}
  attributes: Record<string, string> = {}
  listeners: Record<string, Callback> = {}
  children: ElementStub[] = []
  classes = new Set<string>()
  classList = {
    /** 添加模拟类名；参数为类名，无返回值。@author zhenghq */
    add: (name: string): void => { this.classes.add(name) },
    /** 切换模拟类名；参数为类名与状态，无返回值。@author zhenghq */
    toggle: (name: string, enabled: boolean): void => { enabled ? this.classes.add(name) : this.classes.delete(name) }
  }
  /** 保存模拟事件；参数为事件名与回调，无返回值。@author zhenghq */
  addEventListener(name: string, callback: Callback): void { this.listeners[name] = callback }
  /** 保存模拟属性；参数为属性名和值，无返回值。@author zhenghq */
  setAttribute(name: string, value: string): void { this.attributes[name] = value }
  /** 获取模拟属性；参数为属性名，返回属性值。@author zhenghq */
  getAttribute(name: string): string { return this.attributes[name] }
  /** 切换布尔属性；参数为属性名与状态，无返回值。@author zhenghq */
  toggleAttribute(name: string, enabled: boolean): void { enabled ? this.setAttribute(name, '') : delete this.attributes[name] }
  /** 查询模拟子项；参数为选择器，返回标签子项。@author zhenghq */
  querySelector(_selector: string): ElementStub { return this.children[0] }
  /** 替换模拟子项；参数为节点列表，无返回值。@author zhenghq */
  replaceChildren(...children: ElementStub[]): void { this.children = children }
}

/** 根据真实 HTML 建立最小 DOM 并执行原始脚本；参数为页面、平台与剪贴板状态，返回可操作夹具。@author zhenghq */
function boot(page: 'home' | 'docs', platform = 'MacIntel', clipboardWorks = true) {
  const source = page === 'home' ? home : docs
  const nodes = new Map<string, ElementStub>()
  const commands: ElementStub[] = []
  const services: ElementStub[] = []
  const links: ElementStub[] = []
  for (const match of source.matchAll(/<(?:[a-z][\w-]*)\b([^>]*)>/gu)) {
    const node = new ElementStub()
    for (const attribute of match[1].matchAll(/([\w-]+)="([^"]*)"/gu)) node.attributes[attribute[1]] = attribute[2]
    if (node.attributes.id) nodes.set(`#${node.attributes.id}`, node)
    for (const key of ['command', 'service', 'platform']) if (node.attributes[`data-${key}`]) node.dataset[key] = node.attributes[`data-${key}`]
    if (node.dataset.command) commands.push(node)
    if (node.dataset.service) services.push(node)
    if (node.dataset.platform) { node.children = [new ElementStub()]; nodes.set(`[data-platform="${node.dataset.platform}"]`, node) }
    if (node.attributes.href?.startsWith('#') && !node.attributes.href.startsWith('#i-')) links.push(node)
  }
  nodes.get('#install-command')!.textContent = unix
  nodes.get('#copy-command')!.children = [new ElementStub()]
  const writes: string[] = []
  const timers: Callback[] = []
  const observed: ElementStub[] = []
  let observer: (entries: unknown[]) => void = () => undefined
  let selected: ElementStub | undefined
  runInNewContext(readFileSync(page === 'home' ? 'site/app.js' : 'site/docs/app.js', 'utf8'), {
    document: {
      querySelector: (selector: string) => nodes.get(selector) ?? null,
      querySelectorAll: (selector: string) => selector === '[data-command]' ? commands : selector === '[data-service]' ? services : links,
      createElement: () => new ElementStub(),
      createRange: () => ({ selectNodeContents: (node: ElementStub) => { selected = node } })
    },
    navigator: { platform, clipboard: { writeText: async (text: string) => { if (!clipboardWorks) throw new Error('权限拒绝'); writes.push(text) } } },
    window: { IntersectionObserver: true, setTimeout: (callback: Callback) => timers.push(callback), getSelection: () => ({ removeAllRanges: () => undefined, addRange: () => undefined }) },
    IntersectionObserver: class {
      /** 记录观测回调；参数为交叉观测回调，返回实例。@author zhenghq */
      constructor(callback: typeof observer) { observer = callback }
      /** 记录被观测节点；参数为节点，无返回值。@author zhenghq */
      observe(node: ElementStub): void { observed.push(node) }
    }
  })
  return { nodes, commands, services, links, writes, timers, observed, intersect: (id: string) => observer([{ isIntersecting: true, intersectionRatio: 1, target: { id } }]), selection: () => selected }
}

for (const page of ['home', 'docs'] as const) {
  test(`${page} 的命令切换、复制成功及权限拒绝回退保持`, async () => {
    for (const clipboardWorks of [true, false]) {
      const app = boot(page, 'MacIntel', clipboardWorks)
      await app.commands[1].listeners.click()
      assert.equal(app.nodes.get('#install-command')!.textContent, windows)
      assert.equal(app.commands[1].attributes['aria-pressed'], 'true')
      assert.equal(app.commands[0].attributes['aria-pressed'], 'false')
      await app.nodes.get('#copy-command')!.listeners.click()
      if (clipboardWorks) assert.deepEqual(app.writes, [windows])
      else assert.equal(app.selection(), app.nodes.get('#install-command'))
      assert.equal(app.nodes.get('#copy-command')!.children[0].textContent, clipboardWorks ? '已复制' : '请复制')
      app.timers[0]()
      assert.equal(app.nodes.get('#copy-command')!.children[0].textContent, '复制')
      app.commands[0].listeners.click()
      assert.equal(app.nodes.get('#install-command')!.textContent, unix)
    }
  })
}

test('首页四个真实翻译服务与三个系统下载提示仍可切换', () => {
  const app = boot('home')
  assert.equal(app.services.length, 4)
  for (const button of app.services) {
    button.listeners.click()
    assert.equal(button.attributes['aria-pressed'], 'true')
    assert.ok(app.nodes.get('#service-title')!.textContent)
    assert.ok(app.nodes.get('#service-description')!.textContent)
    assert.ok(app.nodes.get('#service-footnote')!.textContent)
    assert.ok(app.nodes.get('#service-tags')!.children.length)
  }
  for (const [platform, key] of [['MacIntel', 'mac'], ['Win32', 'win'], ['Linux x86_64', 'linux']]) {
    const card = boot('home', platform).nodes.get(`[data-platform="${key}"]`)!
    assert.ok(card.classes.has('is-detected'))
    assert.equal(card.children[0].textContent, '当前系统')
  }
})

test('首页导航与文档目录继续响应章节观测', () => {
  for (const page of ['home', 'docs'] as const) {
    const app = boot(page)
    const id = page === 'home' ? 'features' : 'document'
    assert.ok(app.observed.length)
    app.intersect(id)
    const link = app.links.find(node => node.attributes.href === `#${id}`)!
    assert.ok(page === 'home' ? 'aria-current' in link.attributes : link.classes.has('is-active'))
  }
})
