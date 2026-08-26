import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('设置页应提供划词后自动显示“译”按钮开关并与触发方式同步', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const source = readFileSync('src/renderer/src/settings.ts', 'utf8')

  assert.match(html, /id="auto-show-selection-button"[^>]+type="checkbox"/u)
  assert.match(html, /for="auto-show-selection-button"/u)
  assert.match(html, /划词后自动显示“译”按钮/u)
  assert.match(source, /getElementById\('auto-show-selection-button'\)/u)
  assert.match(
    source,
    /autoShowSelectionButton\.checked\s*=\s*settings\.triggerMode\s*===\s*'button'/u
  )
  assert.match(
    source,
    /autoShowSelectionButton\.addEventListener\('change',\s*saveAutoShowSelectionButton\)/u
  )
  assert.match(
    source,
    /function saveAutoShowSelectionButton\(\): void[\s\S]*?triggerMode:\s*autoShowSelectionButton\.checked\s*\?\s*'button'\s*:\s*'hotkey'/u
  )
  assert.match(
    source,
    /function saveTriggerMode\(\): void[\s\S]*?autoShowSelectionButton\.checked\s*=\s*value\s*===\s*'button'/u
  )
})

test('触发模式补丁应在异步设置操作前同步持久化并应用，快速切换无需额外保存队列', () => {
  const mainSource = readFileSync('src/main/index.ts', 'utf8')
  const applyStart = mainSource.indexOf('async function applySettingsPatch')
  const applyEnd = mainSource.indexOf('/**', applyStart + 1)
  const applySource = mainSource.slice(applyStart, applyEnd)
  const saveIndex = applySource.indexOf('const settings = saveSettings(safePatch)')
  const listenerIndex = applySource.indexOf('applySelectionListener()')
  const firstAwaitIndex = applySource.indexOf('await ')

  assert.ok(saveIndex >= 0)
  assert.ok(listenerIndex > saveIndex)
  assert.ok(firstAwaitIndex < 0 || listenerIndex < firstAwaitIndex)
})
