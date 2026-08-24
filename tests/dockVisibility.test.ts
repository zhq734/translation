import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldShowMacOSDockIcon } from '../src/main/dockVisibility.ts'

test('Dock 图标仅在设置页或网页翻译页打开时显示', () => {
  assert.equal(
    shouldShowMacOSDockIcon({ showDockIcon: true, settingsOpen: false, webReaderOpen: false }),
    false
  )
  assert.equal(
    shouldShowMacOSDockIcon({ showDockIcon: true, settingsOpen: true, webReaderOpen: false }),
    true
  )
  assert.equal(
    shouldShowMacOSDockIcon({ showDockIcon: true, settingsOpen: false, webReaderOpen: true }),
    true
  )
})

test('关闭所有受支持的窗口后应隐藏 Dock 图标', () => {
  assert.equal(
    shouldShowMacOSDockIcon({ showDockIcon: true, settingsOpen: false, webReaderOpen: false }),
    false
  )
})

test('未开启 Dock 图标设置时即使窗口打开也不显示', () => {
  assert.equal(
    shouldShowMacOSDockIcon({ showDockIcon: false, settingsOpen: true, webReaderOpen: true }),
    false
  )
})
