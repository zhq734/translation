import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, normalizeSettings } from '../src/shared/settingsDefaults.ts'
import { tForTest } from './helpers/i18n.ts'

const settingsHtml = readFileSync('src/renderer/settings.html', 'utf8')
const settingsSource = readFileSync('src/renderer/src/settings.ts', 'utf8')
const settingsCss = readFileSync('src/renderer/src/settings.css', 'utf8')
const main = readFileSync('src/main/index.ts', 'utf8')
const types = readFileSync('src/shared/types.ts', 'utf8')

test('设置 schema 应升级到 23 并补齐快捷动作引导状态', () => {
  assert.equal(SETTINGS_SCHEMA_VERSION, 23)
  assert.equal(DEFAULT_SETTINGS.shortcutGuideSeen, false)
  assert.equal(normalizeSettings({ schemaVersion: 22 } as never).shortcutGuideSeen, false)
  assert.equal(normalizeSettings({ schemaVersion: 23, shortcutGuideSeen: true }).shortcutGuideSeen, true)
  assert.equal(normalizeSettings({ schemaVersion: 23, shortcutGuideSeen: 'yes' } as never).shortcutGuideSeen, false)
  assert.match(types, /shortcutGuideSeen: boolean/u)
})

test('首次启动应自动展示快捷动作引导且可关闭后不再自动出现', () => {
  assert.match(settingsHtml, /id="shortcut-guide"/u)
  assert.match(settingsHtml, /id="shortcut-guide-close"/u)
  assert.match(settingsHtml, /id="shortcut-guide-confirm"/u)
  assert.match(settingsHtml, /data-i18n="settings\.shortcutGuide\.selection"/u)
  assert.match(settingsSource, /shortcutGuideSeen/u)
  assert.match(settingsSource, /showShortcutGuide/u)
  assert.match(main, /shortcutGuideSeen:\s*true/u)
})

test('设置页和托盘都必须提供重新查看快捷动作引导的入口', () => {
  assert.match(settingsHtml, /id="reopen-shortcut-guide"/u)
  assert.match(main, /menu\.shortcutGuide/u)
  assert.match(main, /openSettings\(\{ bringToFront: true, explicitEntry: true \}\)/u)
  assert.match(main, /shortcut-guide:open/u)
  assert.match(
    main,
    /openSettings\(\{ bringToFront: true, explicitEntry: true \}\)\s*\.then\(\(\)\s*=>\s*\{[\s\S]*?settingsWin\.webContents\.send\('shortcut-guide:open'\)/u,
    '托盘首次打开设置页时必须等待窗口就绪后再发送引导事件'
  )
})

test('快捷动作引导必须清楚区分划词、快捷 OCR 与截图编辑', () => {
  const selection = tForTest('zh-CN', 'settings.shortcutGuide.selection', {
    hotkey: 'Control+Alt+T'
  })
  const quickOcr = tForTest('zh-CN', 'settings.shortcutGuide.quickOcr', {
    hotkey: 'Control+Alt+S'
  })
  const ocrEditor = tForTest('zh-CN', 'settings.shortcutGuide.ocrEditor', {
    hotkey: 'Control+Alt+O'
  })

  assert.match(selection, /Control\+Alt\+T/u)
  assert.match(quickOcr, /Control\+Alt\+S/u)
  assert.match(ocrEditor, /Control\+Alt\+O/u)
  assert.match(
    tForTest('en-US', 'settings.shortcutGuide.quickOcr', { hotkey: 'Control+Alt+S' }),
    /Control\+Alt\+S/u
  )
  assert.doesNotMatch(tForTest('zh-CN', 'settings.shortcutGuide.selection'), /Alt\+T/u)
  assert.notEqual(
    tForTest('zh-CN', 'settings.shortcutGuide.quickOcr', { hotkey: 'Alt+S' }),
    tForTest('zh-CN', 'settings.shortcutGuide.ocrEditor', { hotkey: 'Alt+O' })
  )
})

test('快捷动作指南必须按用户配置动态渲染三个入口的快捷键', () => {
  for (const id of [
    'shortcut-guide-selection-key',
    'shortcut-guide-quick-ocr-key',
    'shortcut-guide-ocr-editor-key'
  ]) {
    assert.match(settingsHtml, new RegExp(`id="${id}"`, 'u'))
  }

  assert.match(settingsSource, /function renderShortcutGuideHotkeys\(settings: Settings\): void/u)
  assert.match(
    settingsSource,
    /shortcutGuideSelectionKey\.textContent\s*=\s*selectionHotkey/u
  )
  assert.match(
    settingsSource,
    /shortcutGuideQuickOcrKey\.textContent\s*=\s*quickOcrHotkey/u
  )
  assert.match(
    settingsSource,
    /shortcutGuideOcrEditorKey\.textContent\s*=\s*ocrEditorHotkey/u
  )
  assert.match(settingsSource, /formatShortcutGuideHotkey\(settings\.hotkey\)/u)
  assert.match(settingsSource, /formatShortcutGuideHotkey\(settings\.ocrQuickHotkey\)/u)
  assert.match(settingsSource, /formatShortcutGuideHotkey\(settings\.ocrHotkey\)/u)
  assert.match(settingsSource, /renderShortcutGuideHotkeys\(settings\)/u)
  assert.match(settingsSource, /accelerator\.trim\(\)\s*\|\|\s*t\('settings\.shortcutGuide\.notSet'\)/u)
  assert.equal(tForTest('zh-CN', 'settings.shortcutGuide.notSet'), '未设置')
  assert.equal(tForTest('en-US', 'settings.shortcutGuide.notSet'), 'Not set')
})

test('快捷动作指南与下方触发方式必须保留清晰间距', () => {
  const guideEntryCss =
    settingsCss.match(/\.shortcut-guide-entry\s*\{([\s\S]*?)\}/u)?.[1] ?? ''

  assert.match(guideEntryCss, /(?:^|\n)\s*margin-bottom:\s*var\(--space-4\);/u)
})
