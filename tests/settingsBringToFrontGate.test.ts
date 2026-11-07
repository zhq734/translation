import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldCompleteSettingsBringToFront } from '../src/main/settingsBringToFrontGate.ts'

/** 构造一个允许完成置前的空闲状态，供各用例只覆盖目标条件。 */
const idleState = {
  settingsWindowHiddenForSelection: false,
  explicitPopupSource: false,
  initialLaunchSource: false,
  selectionGuardActive: false,
  selectionInteractionIdle: true,
  appActive: true,
  bringToFrontEpoch: 3,
  currentBringToFrontEpoch: 3,
  dockActivationEpoch: undefined,
  currentDockActivationEpoch: 5
}

test('Dock activate 后激活事件短暂延迟时仍应允许当前请求置前', () => {
  assert.equal(
    shouldCompleteSettingsBringToFront({
      ...idleState,
      appActive: false,
      dockActivationEpoch: 5
    }),
    true
  )
})

test('应用真正失活后旧 Dock 请求必须失效', () => {
  assert.equal(
    shouldCompleteSettingsBringToFront({
      ...idleState,
      appActive: false,
      dockActivationEpoch: 5,
      currentDockActivationEpoch: 6
    }),
    false
  )
})

test('应用仍处于激活状态时，被新 Dock 请求取代的旧请求也必须失效', () => {
  assert.equal(
    shouldCompleteSettingsBringToFront({
      ...idleState,
      dockActivationEpoch: 5,
      currentDockActivationEpoch: 6
    }),
    false
  )
})

test('非 Dock 来源在应用激活事件为 false 时仍须拒绝置前', () => {
  assert.equal(
    shouldCompleteSettingsBringToFront({
      ...idleState,
      appActive: false
    }),
    false
  )
})

test('Dock 请求不得越过划词保护期或进行中的划词交互', () => {
  assert.equal(
    shouldCompleteSettingsBringToFront({
      ...idleState,
      appActive: false,
      dockActivationEpoch: 5,
      selectionGuardActive: true
    }),
    false
  )
  assert.equal(
    shouldCompleteSettingsBringToFront({
      ...idleState,
      appActive: false,
      dockActivationEpoch: 5,
      selectionInteractionIdle: false
    }),
    false
  )
})

test('Dock 请求仍须校验置前代际与外部划词隐藏状态', () => {
  assert.equal(
    shouldCompleteSettingsBringToFront({
      ...idleState,
      appActive: false,
      dockActivationEpoch: 5,
      bringToFrontEpoch: 2
    }),
    false
  )
  assert.equal(
    shouldCompleteSettingsBringToFront({
      ...idleState,
      appActive: false,
      dockActivationEpoch: 5,
      settingsWindowHiddenForSelection: true
    }),
    false
  )
})
