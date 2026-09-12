import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveMacOSDockPresentation } from '../src/main/dockVisibility.ts'

const windowStates = [
  { settingsOpen: false, webReaderOpen: false },
  { settingsOpen: true, webReaderOpen: false },
  { settingsOpen: false, webReaderOpen: true },
  { settingsOpen: true, webReaderOpen: true }
]

test('开启 Dock 图标后所有窗口组合都必须保持 regular 策略并显示图标', () => {
  for (const windowState of windowStates) {
    assert.deepEqual(
      resolveMacOSDockPresentation({ showDockIcon: true, ...windowState }),
      { policy: 'regular', dockVisible: true }
    )
  }
})

test('关闭 Dock 图标后所有窗口组合都必须保持 accessory 策略并隐藏图标', () => {
  for (const windowState of windowStates) {
    assert.deepEqual(
      resolveMacOSDockPresentation({ showDockIcon: false, ...windowState }),
      { policy: 'accessory', dockVisible: false }
    )
  }
})
