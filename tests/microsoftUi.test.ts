import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('preload 应暴露微软配置保存、显式清除和配置检测接口', () => {
  const preload = readFileSync('src/preload/index.ts', 'utf8')
  assert.match(preload, /setMicrosoftConfig[\s\S]*microsoft:configure/u)
  assert.match(preload, /clearMicrosoftSubscriptionKey[\s\S]*microsoft:clear-key/u)
  assert.match(preload, /checkMicrosoft[\s\S]*microsoft:check/u)
})

test('普通设置 IPC 不得绕过微软专用配置接口修改受保护字段', () => {
  const main = readFileSync('src/main/index.ts', 'utf8')
  assert.match(main, /delete safePatch\.microsoftEnabled/u)
  assert.match(main, /delete safePatch\.microsoftRegion/u)
  assert.match(main, /delete safePatch\.microsoftSubscriptionKeyConfigured/u)
})

test('设置页应包含微软翻译配置区域和密码类型订阅密钥输入框', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  assert.match(html, /<h2>微软翻译<\/h2>/u)
  assert.match(html, /id="microsoft-enabled"/u)
  assert.match(html, /id="microsoft-region"/u)
  assert.match(html, /id="microsoft-subscription-key"[^>]+type="password"/u)
  assert.match(html, /id="microsoft-key-status"/u)
  assert.match(html, /id="microsoft-save"/u)
  assert.match(html, /id="microsoft-clear-key"/u)
  assert.match(html, /id="microsoft-check"/u)
  assert.match(html, /id="microsoft-status"/u)
})

test('微软设置交互应留空保留密钥并通过独立 IPC 显式清除', () => {
  const source = readFileSync('src/renderer/src/settings.ts', 'utf8')
  assert.match(source, /window\.api\.setMicrosoftConfig/u)
  assert.match(source, /subscriptionKey:\s*microsoftSubscriptionKey\.value/u)
  assert.match(source, /microsoftSubscriptionKey\.value\s*=\s*''/u)
  assert.match(source, /window\.api\.clearMicrosoftSubscriptionKey/u)
  assert.match(source, /window\.api\.checkMicrosoft/u)
})

test('微软翻译应出现在钉钉之后、自建 DeepLX 之前的通道优先级说明中', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const dingTalkIndex = html.indexOf('<li><b>钉钉翻译</b>')
  const microsoftIndex = html.indexOf('<li><b>微软翻译</b>')
  const deepLxIndex = html.indexOf('<li><b>自建 DeepLX</b>')

  assert.ok(dingTalkIndex >= 0)
  assert.ok(microsoftIndex > dingTalkIndex)
  assert.ok(deepLxIndex > microsoftIndex)
})
