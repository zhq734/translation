import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { resolveSelectionCaptureStrategy } from '../src/shared/platformCapture.ts'

test('不同桌面平台应选择可用的系统级取词策略', () => {
  assert.equal(resolveSelectionCaptureStrategy('darwin'), 'macos-command-copy')
  assert.equal(resolveSelectionCaptureStrategy('win32'), 'windows-control-copy')
  assert.equal(resolveSelectionCaptureStrategy('linux'), 'linux-primary-selection')
  assert.equal(resolveSelectionCaptureStrategy('freebsd'), 'unsupported')
})

test('主进程取词实现应包含 Windows Ctrl+C 与 Linux primary selection', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')

  assert.match(source, /powershell\.exe/u)
  assert.match(source, /keybd_event/u)
  assert.match(source, /clipboard\.readText\('selection'\)/u)
})

test('macOS 模拟复制必须显式按下和释放 Command，避免把 C 当作普通字符输入', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const commandDown = source.indexOf('CGEventCreateKeyboardEvent(s,55,true)')
  const copyDown = source.indexOf('CGEventCreateKeyboardEvent(s,8,true)')
  const copyUp = source.indexOf('CGEventCreateKeyboardEvent(s,8,false)')
  const commandUp = source.indexOf('CGEventCreateKeyboardEvent(s,55,false)')

  assert.ok(commandDown >= 0, '应显式发送 Command 按下事件')
  assert.ok(copyDown > commandDown, '应先按下 Command 再按下 C')
  assert.ok(copyUp > copyDown, '应在 C 按下后释放 C')
  assert.ok(commandUp > copyUp, '应在释放 C 后释放 Command')
})

test('macOS 模拟复制不得释放用户正在按住的 Command 键', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')

  assert.match(source, /CGEventSourceKeyState\(\$\.kCGEventSourceStateHIDSystemState,55\)/u)
  assert.match(source, /CGEventSourceKeyState\(\$\.kCGEventSourceStateHIDSystemState,54\)/u)
  assert.match(source, /if\(!commandWasDown\)\{[\s\S]*?commandDown/u)
  assert.match(source, /if\(!commandWasDown\)\{[\s\S]*?commandUp/u)
})
