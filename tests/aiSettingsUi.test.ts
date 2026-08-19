import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const html = readFileSync('src/renderer/settings.html', 'utf8')
const ts = readFileSync('src/renderer/src/settings.ts', 'utf8')

/**
 * 获取指定元素的开始标签。
 * @param content HTML 或源码内容。
 * @param id 元素 ID。
 * @returns 匹配到的开始标签字符串。
 * @author zhenghq
 */
function getOpeningTag(content: string, id: string): string {
  const match = content.match(new RegExp(`<[^>]+id="${id}"[^>]*>`, 'u'))
  assert.ok(match, `缺少元素 #${id}`)
  return match[0]
}

test('AI Tab 应包含协议选择、Base URL、API Key、模型输入与操作按钮控件', () => {
  // Tab 按钮存在
  const tab = getOpeningTag(html, 'settings-tab-ai')
  assert.match(tab, /role="tab"/u)
  assert.match(tab, /aria-controls="settings-panel-ai"/u)

  // 面板存在
  const panel = getOpeningTag(html, 'settings-panel-ai')
  assert.match(panel, /role="tabpanel"/u)

  // 协议选择
  const protocol = getOpeningTag(html, 'ai-protocol')
  assert.match(protocol, /<select/u)
  assert.match(html, /<option value="ollama">/u)
  assert.match(html, /<option value="openai">/u)
  assert.match(html, /<option value="claude-code">/u)

  // Base URL 输入
  assert.ok(html.includes('id="ai-base-url"'))

  // API Key 输入（password 类型，不回显）
  const apiKeyInput = getOpeningTag(html, 'ai-api-key')
  assert.match(apiKeyInput, /type="password"/u)

  // 模型输入配合 datalist
  const modelInput = getOpeningTag(html, 'ai-model')
  assert.match(modelInput, /list="ai-model-list"/u)
  assert.ok(html.includes('<datalist id="ai-model-list">'))

  // 操作按钮
  assert.ok(html.includes('id="ai-save"'))
  assert.ok(html.includes('id="ai-refresh-models"'))
  assert.ok(html.includes('id="ai-check"'))
  assert.ok(html.includes('id="ai-clear-key"'))

  // 状态展示区域
  assert.ok(html.includes('id="ai-status"'))
  assert.ok(html.includes('id="ai-model-status"'))
  assert.ok(html.includes('id="ai-api-key-status"'))
})

test('设置页 Renderer 逻辑应包含 AI Tab 类型与事件绑定', () => {
  // SettingsTabId 包含 'ai'
  assert.match(ts, /type SettingsTabId/u)
  assert.match(ts, /'ai'/u)

  // SETTINGS_TAB_IDS 包含 'ai'
  assert.match(ts, /SETTINGS_TAB_IDS/u)

  // renderSettings 中处理 AI 字段
  assert.match(ts, /aiEnabled/u)
  assert.match(ts, /aiProtocol/u)
  assert.match(ts, /aiBaseUrl/u)
  assert.match(ts, /aiModel/u)
  assert.match(ts, /aiApiKeyConfigured/u)

  // 保存、清除、模型列表、检测函数
  assert.match(ts, /saveAiConfig/u)
  assert.match(ts, /clearAiApiKey/u)
  assert.match(ts, /listAiModels/u)
  assert.match(ts, /checkAi/u)

  // 调用 preload API
  assert.match(ts, /window\.api\.setAiConfig/u)
  assert.match(ts, /window\.api\.clearAiApiKey/u)
  assert.match(ts, /window\.api\.listAiModels/u)
  assert.match(ts, /window\.api\.checkAi/u)

  // 事件监听器注册
  assert.match(ts, /aiSave\.addEventListener/u)
  assert.match(ts, /aiRefreshModels\.addEventListener/u)
  assert.match(ts, /aiCheck\.addEventListener/u)
  assert.match(ts, /aiClearKey\.addEventListener/u)
})

test('AI 配置保存后应自动加载模型列表', () => {
  assert.match(ts, /saveAiConfig[\s\S]*listAiModels/u)
})

test('AI 配置保存应使用独立 IPC 且 API Key 留空保留原值', () => {
  assert.match(ts, /window\.api\.setAiConfig\(\{/u)
  assert.match(ts, /apiKey:\s*aiApiKey\.value/u)
  assert.match(ts, /aiApiKey\.value\s*=\s*''/u)
  assert.match(ts, /window\.api\.clearAiApiKey/u)
})

test('模型列表加载失败后应保留用户手动输入的模型名称', () => {
  // listAiModels 中不应覆盖用户手动输入的值
  assert.match(ts, /listAiModels[\s\S]*aiModel\.value/u)
  // saveAiConfig 中保存后调用 listAiModels
  assert.match(ts, /saveAiConfig[\s\S]*await listAiModels/u)
})

test('AI 设置样式应使用 CSS 变量并支持自适应', () => {
  const css = readFileSync('src/renderer/src/settings.css', 'utf8')
  assert.match(css, /\.ai-actions/u)
  assert.match(css, /var\(--status-success\)/u)
  assert.match(css, /var\(--status-error\)/u)
  assert.match(css, /var\(--text-muted\)/u)
  assert.match(css, /\.ai-api-key-status\.configured/u)
  assert.match(css, /@media\s*\(max-width:\s*480px\)/u)
})

test('preload 应暴露 AI 配置保存、清除密钥、模型列表和检测接口', () => {
  const preload = readFileSync('src/preload/index.ts', 'utf8')
  assert.match(preload, /setAiConfig[\s\S]*ai:configure/u)
  assert.match(preload, /clearAiApiKey[\s\S]*ai:clear-key/u)
  assert.match(preload, /listAiModels[\s\S]*ai:list-models/u)
  assert.match(preload, /checkAi[\s\S]*ai:check/u)
})

test('刷新模型列表应先保存当前配置再加载，确保使用页面最新值', () => {
  assert.match(ts, /refreshAiModels[\s\S]*saveAiConfig/u)
})

test('检测配置应先保存当前配置再检测，确保使用页面最新值', () => {
  assert.match(ts, /checkAi[\s\S]*window\.api\.setAiConfig/u)
})
