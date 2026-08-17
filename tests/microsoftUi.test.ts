import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('preload 应只暴露免配置微软可用性检测接口', () => {
  const preload = readFileSync('src/preload/index.ts', 'utf8')
  assert.doesNotMatch(preload, /setMicrosoftConfig|microsoft:configure/u)
  assert.doesNotMatch(preload, /clearMicrosoftSubscriptionKey|microsoft:clear-key/u)
  assert.match(preload, /checkMicrosoft[\s\S]*microsoft:check/u)
})

test('普通设置 IPC 应允许保存微软启用状态且不再处理 Azure 字段', () => {
  const main = readFileSync('src/main/index.ts', 'utf8')
  assert.doesNotMatch(main, /delete safePatch\.microsoftEnabled/u)
  assert.doesNotMatch(main, /microsoftRegion|microsoftSubscriptionKeyConfigured/u)
  assert.doesNotMatch(main, /microsoft:configure|microsoft:clear-key/u)
  assert.match(main, /resetMicrosoftTranslationRuntime/u)
})

test('设置页应包含免订阅微软翻译开关、检测按钮和稳定性提示', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  assert.match(html, /<h2>微软翻译<\/h2>/u)
  assert.match(html, /id="microsoft-enabled"/u)
  assert.match(html, /无需(?:配置|订阅密钥)|免订阅/u)
  assert.match(html, /Bing 在线翻译/u)
  assert.match(html, /接口[^<]*可能[^<]*失效|服务调整[^<]*不可用/u)
  assert.match(html, /id="microsoft-check"/u)
  assert.match(html, /id="microsoft-status"/u)
  assert.doesNotMatch(html, /id="microsoft-region"/u)
  assert.doesNotMatch(html, /id="microsoft-subscription-key"/u)
  assert.doesNotMatch(html, /id="microsoft-key-status"/u)
  assert.doesNotMatch(html, /id="microsoft-save"/u)
  assert.doesNotMatch(html, /id="microsoft-clear-key"/u)
})

test('微软设置交互应通过普通设置保存开关并保留独立可用性检测', () => {
  const source = readFileSync('src/renderer/src/settings.ts', 'utf8')
  assert.match(source, /microsoftEnabled[\s\S]*window\.api\.setSettings\(\{\s*microsoftEnabled:/u)
  assert.match(source, /window\.api\.checkMicrosoft/u)
  assert.doesNotMatch(source, /setMicrosoftConfig|clearMicrosoftSubscriptionKey/u)
  assert.doesNotMatch(source, /microsoftRegion|microsoftSubscriptionKey|microsoftKeyStatus/u)
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
