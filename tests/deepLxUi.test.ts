import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const html = readFileSync('src/renderer/settings.html', 'utf8')
const renderer = readFileSync('src/renderer/src/settings.ts', 'utf8')
const preload = readFileSync('src/preload/index.ts', 'utf8')
const main = readFileSync('src/main/index.ts', 'utf8')

test('DeepLX 设置页应提供多地址说明和保存操作，不提供 Token 配置', () => {
  assert.match(html, /英文或中文逗号/u)
  assert.match(html, /id="deeplx-save"/u)
  assert.doesNotMatch(html, /id="deeplx-token"/u)
  assert.doesNotMatch(html, /id="deeplx-clear-token"/u)
})

test('DeepLX 配置应通过专用 IPC 保存，检测前先保存当前表单', () => {
  assert.match(preload, /setDeepLxConfig:[\s\S]*deeplx:configure/u)
  assert.match(preload, /checkDeepLx:[\s\S]*deeplx:check/u)
  assert.match(main, /ipcMain\.handle\('deeplx:configure'/u)
  assert.doesNotMatch(preload, /clearDeepLxToken|deeplx:clear-token/u)
  assert.doesNotMatch(main, /clearDeepLxToken|deeplx:clear-token/u)
  assert.match(renderer, /async function checkDeepLxStatus[\s\S]*saveDeepLxConfig\(false\)[\s\S]*checkDeepLx\(\)/u)
})

test('普通设置 IPC 应过滤 DeepLX 专用地址字段', () => {
  assert.match(main, /delete safePatch\.deepLxUrl/u)
  assert.doesNotMatch(main, /deepLxToken/u)
})
