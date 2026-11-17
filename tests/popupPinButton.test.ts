import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { enUSBase } from '../src/shared/i18n/catalog.en-US.base'
import { zhCNBase } from '../src/shared/i18n/catalog.zh-CN.base'

const html = readFileSync('src/renderer/index.html', 'utf8')
const styles = readFileSync('src/renderer/src/style.css', 'utf8')
const renderer = readFileSync('src/renderer/src/popup.ts', 'utf8')
const ts = createRequire(`${process.cwd()}/package.json`)('typescript')

/** 校验图钉作为左上角独立角标，不占用标题队列或底栏；无参数、无返回值。@author zhenghq */
test('钉住按钮应是窗口左上角唯一的纯图标角标', () => {
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'))
  const footer = html.slice(html.indexOf('class="footer popup-status-actions"'))
  const button = html.match(/<button id="pin"[\s\S]*?<\/button>/u)?.[0]

  assert.ok(button, '左上角必须提供钉住角标')
  assert.match(html, /id="popup">\s*<button id="pin"/u)
  assert.doesNotMatch(header, /id="pin"/u)
  assert.match(button, /class="header-action-button"/u)
  assert.match(button, /type="button"[^>]*aria-label=[^>]*aria-pressed="false"/u)
  assert.match(button, /<svg class="header-action-icon pin-icon"/u)
  assert.doesNotMatch(button, /<span/u)
  assert.doesNotMatch(footer, /id="pin"/u)
  assert.equal(Array.from(html.matchAll(/id="pin"/gu)).length, 1)
  assert.doesNotMatch(renderer, /pinLabelEl|pin-label/u)
})

/** 校验图钉角标独立定位、不继承底栏收缩，且保留主题及键盘样式；无参数、无返回值。@author zhenghq */
test('左上角图钉应独立定位并保持非拖动区域', () => {
  assert.match(styles, /#pin\s*\{[^}]*position:\s*absolute;[^}]*top:\s*2px;[^}]*left:\s*4px;[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*min-height:\s*24px;[^}]*z-index:\s*4;/su)
  assert.doesNotMatch(styles, /#speak,\s*#pin/u)
  assert.match(styles, /\.header-actions,[^}]*#pin,[^}]*-webkit-app-region:\s*no-drag;/su)
  assert.match(styles, /#pin\[aria-pressed='true'\]\s*\{[^}]*background:\s*var\(--bg-secondary\);[^}]*color:\s*var\(--button-bg\);/su)
  assert.match(styles, /\.header-action-button:focus-visible,[^}]*outline:\s*2px solid var\(--focus-outline\);/su)
  assert.match(styles, /#pin:focus-visible\s*\{[^}]*outline-offset:\s*-2px;/su)
  assert.match(styles, /#popup\.compact-height \.header-top\s*\{[^}]*padding-inline-start:\s*20px;/su)
})

/** 执行真实状态函数，校验图钉双向切换及主进程状态同步；无参数、无返回值。@author zhenghq */
test('纯图标图钉应支持钉住、取消及中英文状态提示同步', () => {
  const source = ts.createSourceFile('popup.ts', renderer, ts.ScriptTarget.Latest, true)
  const functions = source.statements
    .filter((node: { name?: { text?: string } }) => ['renderPinnedState', 'togglePinned'].includes(node.name?.text ?? ''))
    .map((node: { getText(source: unknown): string }) => node.getText(source))
    .join('\n')
  assert.match(renderer, /pinBtn\.addEventListener\('click', togglePinned\)/u)
  assert.match(renderer, /window\.api\.onPinnedChanged\(renderPinnedState\)/u)

  for (const catalog of [zhCNBase, enUSBase]) {
    const attributes = new Map<string, string>()
    const calls: boolean[] = []
    const pinBtn = {
      title: '',
      /** 记录按钮属性；参数为属性名和属性值，无返回值。@author zhenghq */
      setAttribute(name: string, value: string): void { attributes.set(name, value) }
    }
    const context = {
      pinned: false,
      pinBtn,
      /** 获取语言目录中的提示；参数为翻译键，返回提示。@author zhenghq */
      t(key: keyof typeof catalog): string { return catalog[key] },
      window: { api: {
        /** 记录传给主进程的固定状态；参数为是否固定，无返回值。@author zhenghq */
        setPinned(value: boolean): void { calls.push(value) }
      } }
    }
    const code = ts.transpile(functions, { target: ts.ScriptTarget.ES2022 })
    runInNewContext(`${code}\nrenderPinnedState(false)`, context)
    assert.equal(pinBtn.title, catalog['popup.pin'])
    assert.equal(attributes.get('aria-pressed'), 'false')

    runInNewContext(`${code}\ntogglePinned()`, context)
    assert.equal(context.pinned, true)
    assert.equal(attributes.get('aria-pressed'), 'true')
    assert.equal(pinBtn.title, catalog['popup.unpinWindow'])
    assert.equal(attributes.get('aria-label'), pinBtn.title)

    runInNewContext(`${code}\ntogglePinned()`, context)
    assert.equal(context.pinned, false)
    assert.equal(attributes.get('aria-pressed'), 'false')
    assert.equal(pinBtn.title, catalog['popup.pin'])
    assert.equal(attributes.get('aria-label'), pinBtn.title)
    assert.deepEqual(calls, [true, false])

    runInNewContext(`${code}\nrenderPinnedState(true)`, context)
    assert.equal(context.pinned, true)
    assert.equal(attributes.get('aria-pressed'), 'true')
    assert.equal(pinBtn.title, catalog['popup.unpinWindow'])
    assert.deepEqual(calls, [true, false], '同步主进程状态不得重复发送固定请求')
  }
})
