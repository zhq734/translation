import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  resolvePronunciationInteractionTransition,
  shouldSchedulePopupHide
} from '../src/main/popupAutoHideState.ts'

test('音标交互期间应暂停自动隐藏且不改变固定语义', () => {
  assert.equal(shouldSchedulePopupHide({
    pinned: false,
    autoHideMs: 3000,
    pronunciationInteractionActive: true
  }), false)
  assert.equal(shouldSchedulePopupHide({
    pinned: false,
    autoHideMs: 3000,
    pronunciationInteractionActive: false
  }), true)
  assert.equal(shouldSchedulePopupHide({
    pinned: true,
    autoHideMs: 3000,
    pronunciationInteractionActive: false
  }), false)
  assert.equal(shouldSchedulePopupHide({
    pinned: false,
    autoHideMs: 0,
    pronunciationInteractionActive: false
  }), false)
})

test('主进程应提供独立发音交互状态并复用自动隐藏判定', () => {
  const popup = readFileSync('src/main/popup.ts', 'utf8')
  const main = readFileSync('src/main/index.ts', 'utf8')
  const preload = readFileSync('src/preload/index.ts', 'utf8')
  const types = readFileSync('src/shared/types.ts', 'utf8')

  assert.match(popup, /export function setPronunciationInteraction/u)
  assert.match(popup, /shouldSchedulePopupHide\(/u)
  assert.match(popup, /pronunciationInteractionActive/u)
  assert.match(main, /ipcMain\.on\(['"]pronunciation:interaction['"]/u)
  assert.match(preload, /setPronunciationInteraction\(active: boolean\)/u)
  assert.match(preload, /ipcRenderer\.send\(['"]pronunciation:interaction['"], active\)/u)
  assert.match(types, /setPronunciationInteraction\(active: boolean\): void/u)
})

test('重复上报相同音标交互状态不应重置自动隐藏计时', () => {
  assert.equal(resolvePronunciationInteractionTransition(false, false), 'unchanged')
  assert.equal(resolvePronunciationInteractionTransition(true, true), 'unchanged')
  assert.equal(resolvePronunciationInteractionTransition(false, true), 'resume')
  assert.equal(resolvePronunciationInteractionTransition(true, false), 'pause')
})

test('弹窗被外部关闭时应清理音标交互状态，避免下次显示跳过自动隐藏', () => {
  const popup = readFileSync('src/main/popup.ts', 'utf8')
  const hidePopup = popup.match(/export function hidePopup\([\s\S]*?\n\}/u)?.[0] ?? ''

  assert.match(hidePopup, /pronunciationInteractionActive\s*=\s*false/u)
})

test('弹窗被外部隐藏时应取消所有未完成的音标查询和音频下载', () => {
  const popup = readFileSync('src/main/popup.ts', 'utf8')
  const main = readFileSync('src/main/index.ts', 'utf8')
  const hidePopupBlock = popup.match(/export function hidePopup\([\s\S]*?\n\}/u)?.[0] ?? ''

  assert.match(
    popup,
    /export function createPopup\(\s*options:\s*CreatePopupOptions\s*\): BrowserWindow/u
  )
  assert.match(hidePopupBlock, /onPopupHiddenCallback\?\.\(\)/u)
  assert.match(
    main,
    /createPopup\(\s*\{[\s\S]*?onWindowShown:\s*suppressSelectionActivationWindowGap,[\s\S]*?onPopupHidden:\s*\(\)\s*=>\s*pronunciationRequests\.cancelAll\(\),[\s\S]*?onPopupCloseStart:\s*handlePopupCloseStart,[\s\S]*?onPopupCloseEnd:\s*handlePopupCloseEnd\s*\}\s*\)/u
  )
})
