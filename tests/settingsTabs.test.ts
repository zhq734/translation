import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const TAB_IDS = ['general', 'dingtalk', 'microsoft', 'deeplx', 'advanced', 'about'] as const

/**
 * 获取指定元素的开始标签，便于校验无框架设置页的可访问性属性。
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

test('设置页应按六个配置类别展示可访问的 Tab 与对应面板', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  assert.match(html, /role="tablist"[^>]+aria-label="设置分类"/u)

  for (const [index, tabId] of TAB_IDS.entries()) {
    const tab = getOpeningTag(html, `settings-tab-${tabId}`)
    const panel = getOpeningTag(html, `settings-panel-${tabId}`)
    assert.match(tab, /role="tab"/u)
    assert.match(tab, new RegExp(`aria-controls="settings-panel-${tabId}"`, 'u'))
    assert.match(panel, /role="tabpanel"/u)
    assert.match(panel, new RegExp(`aria-labelledby="settings-tab-${tabId}"`, 'u'))

    if (index === 0) {
      assert.match(tab, /aria-selected="true"/u)
      assert.doesNotMatch(panel, /\shidden(?:\s|>)/u)
    } else {
      assert.match(tab, /aria-selected="false"/u)
      assert.match(panel, /\shidden(?:\s|>)/u)
    }
  }
})

test('设置项应分配到常规、翻译服务、DeepLX 和高级配置面板', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const generalIndex = html.indexOf('id="settings-panel-general"')
  const dingTalkIndex = html.indexOf('id="settings-panel-dingtalk"')
  const microsoftIndex = html.indexOf('id="settings-panel-microsoft"')
  const deepLxIndex = html.indexOf('id="settings-panel-deeplx"')
  const advancedIndex = html.indexOf('id="settings-panel-advanced"')
  const aboutIndex = html.indexOf('id="settings-panel-about"')

  assert.ok(generalIndex >= 0)
  assert.ok(dingTalkIndex > generalIndex)
  assert.ok(microsoftIndex > dingTalkIndex)
  assert.ok(deepLxIndex > microsoftIndex)
  assert.ok(advancedIndex > deepLxIndex)
  assert.ok(aboutIndex > advancedIndex)

  assert.ok(html.indexOf('<h2>翻译语言</h2>') > generalIndex)
  assert.ok(html.indexOf('<h2>触发与弹窗</h2>') > generalIndex)
  assert.ok(html.indexOf('<h2>钉钉翻译</h2>') > dingTalkIndex)
  assert.ok(html.indexOf('<h2>微软翻译</h2>') > microsoftIndex)
  assert.ok(html.indexOf('<h2>翻译通道</h2>') > deepLxIndex)
  assert.ok(html.indexOf('<h2>自建 DeepLX</h2>') > deepLxIndex)
  assert.ok(html.indexOf('<h2>网络代理</h2>') > advancedIndex)
  assert.ok(html.indexOf('<h2>服务控制</h2>') > advancedIndex)
  assert.ok(html.indexOf('<h2>版本与更新</h2>') > aboutIndex)
})

test('Tab 交互应支持点击、键盘导航、URL 查询参数和本地缓存恢复', () => {
  const source = readFileSync('src/renderer/src/settings.ts', 'utf8')
  assert.match(source, /querySelectorAll<HTMLButtonElement>\('\[role="tab"\]'\)/u)
  assert.match(source, /ariaSelected/u)
  assert.match(source, /panel\.hidden/u)
  assert.match(source, /ArrowLeft/u)
  assert.match(source, /ArrowRight/u)
  assert.match(source, /Home/u)
  assert.match(source, /End/u)
  assert.match(source, /new URLSearchParams\(window\.location\.search\)/u)
  assert.match(source, /window\.localStorage\.getItem/u)
  assert.match(source, /window\.localStorage\.setItem/u)
  assert.match(source, /window\.history\.pushState/u)
  assert.match(source, /popstate/u)
})

test('Tab 布局应自适应宽度，并让当前面板独立滚动且兼容主题变量', () => {
  const css = readFileSync('src/renderer/src/settings.css', 'utf8')
  assert.match(css, /\.settings-tabs\s*\{[\s\S]*overflow-x:\s*auto/u)
  assert.match(css, /\.tab-panel\s*\{[\s\S]*overflow-y:\s*auto/u)
  assert.match(css, /\.tab-panel\[hidden\]\s*\{[\s\S]*display:\s*none/u)
  assert.match(css, /\.settings-tab\[aria-selected='true'\][\s\S]*var\(--button-bg\)/u)
  assert.match(css, /@media\s*\(max-width:\s*480px\)/u)
})
