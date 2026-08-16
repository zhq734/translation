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
