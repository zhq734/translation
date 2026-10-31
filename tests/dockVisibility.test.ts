import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveMacOSDockPresentation } from '../src/main/dockVisibility.ts'

const windowStates = [
  { settingsOpen: false, webReaderOpen: false, documentWorkspaceOpen: false },
  { settingsOpen: true, webReaderOpen: false, documentWorkspaceOpen: false },
  { settingsOpen: false, webReaderOpen: true, documentWorkspaceOpen: false },
  { settingsOpen: true, webReaderOpen: true, documentWorkspaceOpen: false },
  { settingsOpen: false, webReaderOpen: false, documentWorkspaceOpen: true },
  { settingsOpen: true, webReaderOpen: false, documentWorkspaceOpen: true },
  { settingsOpen: false, webReaderOpen: true, documentWorkspaceOpen: true },
  { settingsOpen: true, webReaderOpen: true, documentWorkspaceOpen: true }
]

test('开启 Dock 图标后任一常规窗口存在时都必须保持 regular 策略并显示图标', () => {
  assert.deepEqual(
    resolveMacOSDockPresentation({
      showDockIcon: true,
      settingsOpen: true,
      webReaderOpen: false,
      documentWorkspaceOpen: false
    }),
    { policy: 'regular', dockVisible: true }
  )
  assert.deepEqual(
    resolveMacOSDockPresentation({
      showDockIcon: true,
      settingsOpen: true,
      webReaderOpen: true,
      documentWorkspaceOpen: false
    }),
    { policy: 'regular', dockVisible: true }
  )
  // 关闭设置页时若网页翻译窗口仍在打开，不能把应用降为 accessory：
  // 激活策略切换会重新排列应用内窗口，把仍在最前的翻译页压到其它窗口之后。
  assert.deepEqual(
    resolveMacOSDockPresentation({
      showDockIcon: true,
      settingsOpen: false,
      webReaderOpen: true,
      documentWorkspaceOpen: false
    }),
    { policy: 'regular', dockVisible: true }
  )
  // 文档工作台是普通可交互窗口，单独打开或与其它内部窗口组合时也必须保持 Dock。
  assert.deepEqual(
    resolveMacOSDockPresentation({
      showDockIcon: true,
      settingsOpen: false,
      webReaderOpen: false,
      documentWorkspaceOpen: true
    }),
    { policy: 'regular', dockVisible: true }
  )
  assert.deepEqual(
    resolveMacOSDockPresentation({
      showDockIcon: true,
      settingsOpen: true,
      webReaderOpen: true,
      documentWorkspaceOpen: true
    }),
    { policy: 'regular', dockVisible: true }
  )
})

test('开启 Dock 图标但所有常规窗口都关闭时才隐藏图标', () => {
  assert.deepEqual(
    resolveMacOSDockPresentation({
      showDockIcon: true,
      settingsOpen: false,
      webReaderOpen: false,
      documentWorkspaceOpen: false
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
