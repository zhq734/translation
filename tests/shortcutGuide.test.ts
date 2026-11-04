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

test('设置 schema 升级后应补齐快捷动作引导状态', () => {
  assert.equal(SETTINGS_SCHEMA_VERSION, 27)
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

test('快捷动作指南必须提供直达对应快捷键设置的入口', () => {
  const expectedTargets = [
    ['shortcut-guide-selection-settings', 'general', 'hotkey'],
    ['shortcut-guide-quick-ocr-settings', 'ocr', 'ocr-quick-hotkey'],
    ['shortcut-guide-ocr-editor-settings', 'ocr', 'ocr-hotkey']
  ] as const

  for (const [buttonId, tabId, inputId] of expectedTargets) {
    const tag = settingsHtml.match(new RegExp(`<button[^>]*id="${buttonId}"[^>]*>`, 'u'))?.[0] ?? ''
    assert.match(tag, /class="btn"/u)
    assert.match(tag, new RegExp(`data-settings-tab="${tabId}"`, 'u'))
    assert.match(tag, new RegExp(`data-settings-focus="${inputId}"`, 'u'))
    assert.match(tag, /data-i18n="settings\.shortcutGuide\.configure"/u)
  }

  assert.match(settingsSource, /function openShortcutGuideTarget\(button: HTMLButtonElement\): void/u)
  assert.match(settingsSource, /activateSettingsTab\(tabId, false, 'push'\)/u)
  assert.match(settingsSource, /shortcutGuideEl\.hidden = true/u)
  assert.match(settingsSource, /requestAnimationFrame\(\(\) => \{[\s\S]*?focus\(\)[\s\S]*?scrollIntoView/u)
  assert.match(settingsSource, /querySelectorAll<HTMLButtonElement>\('\[data-settings-tab\]\[data-settings-focus\]'\)/u)
  assert.match(settingsSource, /openShortcutGuideTarget\(button\)/u)
  assert.equal(tForTest('zh-CN', 'settings.shortcutGuide.configure'), '设置快捷键')
  assert.equal(tForTest('en-US', 'settings.shortcutGuide.configure'), 'Set shortcut')
})

test('OCR 页的快捷键配置必须在独立小节中清晰展示', () => {
  const panelStart = settingsHtml.indexOf('id="settings-panel-ocr"')
  const panelEnd = settingsHtml.indexOf('id="settings-panel-translation-services"', panelStart)
  const panel = settingsHtml.slice(panelStart, panelEnd)

  assert.match(
    panel,
    /<h3[^>]*data-i18n="settings\.ocr.hotkeysTitle"[^>]*>[\s\S]*?<div class="row">[\s\S]*?id="ocr-hotkey"/u
  )
  assert.match(
    panel,
    /id="ocr-hotkey"[\s\S]*?id="ocr-quick-hotkey"[\s\S]*?id="ocr-quick-hotkey-clear"/u
  )
  assert.equal(tForTest('zh-CN', 'settings.ocr.hotkeysTitle'), '快捷键')
  assert.equal(tForTest('en-US', 'settings.ocr.hotkeysTitle'), 'Shortcuts')
})
