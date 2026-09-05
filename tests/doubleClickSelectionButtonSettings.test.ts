import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  normalizeSettings
} from '../src/shared/settingsDefaults.ts'

test('双击选词“译”按钮设置应默认开启并支持持久化关闭', () => {
  assert.equal(SETTINGS_SCHEMA_VERSION, 17)
  assert.equal(DEFAULT_SETTINGS.doubleClickSelectionButtonEnabled, true)
  assert.equal(
    normalizeSettings({ schemaVersion: 15 }).doubleClickSelectionButtonEnabled,
    true
  )
  assert.equal(
    normalizeSettings({
      schemaVersion: 17,
      doubleClickSelectionButtonEnabled: false
    }).doubleClickSelectionButtonEnabled,
    false
  )
})

test('设置页应提供双击选词显示“译”按钮开关并自动保存', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const source = readFileSync('src/renderer/src/settings.ts', 'utf8')

  assert.match(html, /id="double-click-selection-button-enabled"[^>]+type="checkbox"/u)
  assert.match(html, /双击选词显示“译”按钮/u)
  assert.match(
    source,
    /doubleClickSelectionButtonEnabled\.checked\s*=\s*settings\.doubleClickSelectionButtonEnabled/u
  )
  assert.match(
    source,
    /function saveDoubleClickSelectionButtonEnabled\(\): void[\s\S]*?doubleClickSelectionButtonEnabled:\s*doubleClickSelectionButtonEnabled\.checked/u
  )
  assert.match(
    source,
    /doubleClickSelectionButtonEnabled\.addEventListener\('change',\s*saveDoubleClickSelectionButtonEnabled\)/u
  )
})

test('关闭双击选词开关后按钮模式应忽略双击手势', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const start = source.indexOf('function handleSelectionGesture')
  const end = source.indexOf('/**', start)
  const handlerSource = source.slice(start, end)

  assert.ok(start >= 0)
  assert.ok(end > start)
  assert.match(
    handlerSource,
    /gesture\.clicks >= 2[\s\S]*?triggerMode === 'button'[\s\S]*?if \(!settings\.doubleClickSelectionButtonEnabled\) return[\s\S]*?scheduleDoubleClickSelectionButton\(gesture\)/u
  )
})
