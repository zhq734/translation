import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveMacOSDockPresentation } from '../src/main/dockVisibility.ts'

const windowStates = [
  { settingsOpen: false, webReaderOpen: false },
  { settingsOpen: true, webReaderOpen: false },
  { settingsOpen: false, webReaderOpen: true },
  { settingsOpen: true, webReaderOpen: true }
]

test('开启 Dock 图标后仅设置窗口存在时使用 regular 策略并显示图标', () => {
  assert.deepEqual(
    resolveMacOSDockPresentation({
      showDockIcon: true,
      settingsOpen: true,
      webReaderOpen: false
    }),
    { policy: 'regular', dockVisible: true }
  )
  assert.deepEqual(
    resolveMacOSDockPresentation({
      showDockIcon: true,
      settingsOpen: true,
      webReaderOpen: true
    }),
    { policy: 'regular', dockVisible: true }
  )
})

test('开启 Dock 图标但设置窗口不存在时必须隐藏图标', () => {
  assert.deepEqual(
    resolveMacOSDockPresentation({
      showDockIcon: true,
      settingsOpen: false,
      webReaderOpen: false
    }),
    { policy: 'accessory', dockVisible: false }
  )
  assert.deepEqual(
    resolveMacOSDockPresentation({
      showDockIcon: true,
      settingsOpen: false,
      webReaderOpen: true
    }),
    { policy: 'accessory', dockVisible: false }
  )
})

test('关闭 Dock 图标后所有窗口组合都必须保持 accessory 策略并隐藏图标', () => {
  for (const windowState of windowStates) {
    assert.deepEqual(
      resolveMacOSDockPresentation({ showDockIcon: false, ...windowState }),
      { policy: 'accessory', dockVisible: false }
    )
  }
})
