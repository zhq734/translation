import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('preload 应暴露钉钉配置保存、显式清除和配置检测接口', () => {
  const preload = readFileSync('src/preload/index.ts', 'utf8')
  assert.match(preload, /setDingTalkConfig[\s\S]*dingtalk:configure/u)
  assert.match(preload, /clearDingTalkSecret[\s\S]*dingtalk:clear-secret/u)
  assert.match(preload, /checkDingTalk[\s\S]*dingtalk:check/u)
})

test('设置页应包含完整的钉钉配置区域和密码类型 Secret 输入框', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  assert.match(html, /id="dingtalk-enabled"/u)
  assert.match(html, /id="dingtalk-corp-id"/u)
  assert.match(html, /id="dingtalk-client-id"/u)
  assert.match(html, /id="dingtalk-client-secret"[^>]+type="password"/u)
  assert.match(html, /id="dingtalk-secret-status"/u)
  assert.match(html, /id="dingtalk-save"/u)
  assert.match(html, /id="dingtalk-clear-secret"/u)
  assert.match(html, /id="dingtalk-check"/u)
  assert.match(html, /id="dingtalk-status"/u)
})

test('钉钉配置区域应位于翻译语言之后且在触发设置之前，确保打开页面即可发现', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const languageIndex = html.indexOf('<h2>翻译语言</h2>')
  const dingTalkIndex = html.indexOf('<h2>钉钉翻译</h2>')
  const triggerIndex = html.indexOf('<h2>触发与弹窗</h2>')

  assert.ok(languageIndex >= 0)
  assert.ok(dingTalkIndex > languageIndex)
  assert.ok(triggerIndex > dingTalkIndex)
})

test('设置页交互应使用独立接口、留空保留 Secret 并显式清除', () => {
  const source = readFileSync('src/renderer/src/settings.ts', 'utf8')
  assert.match(source, /window\.api\.setDingTalkConfig/u)
  assert.match(source, /clientSecret:\s*dingTalkClientSecret\.value/u)
  assert.match(source, /dingTalkClientSecret\.value\s*=\s*''/u)
  assert.match(source, /window\.api\.clearDingTalkSecret/u)
  assert.match(source, /window\.api\.checkDingTalk/u)
})

test('钉钉设置样式应覆盖密码框、自适应按钮和主题变量', () => {
  const css = readFileSync('src/renderer/src/settings.css', 'utf8')
  assert.match(css, /input\[type='password'\]/u)
  assert.match(css, /\.dingtalk-actions/u)
  assert.match(css, /var\(--status-success\)/u)
  assert.match(css, /@media\s*\(max-width:\s*480px\)/u)
})
