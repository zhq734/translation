import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isWaylandSession,
  shouldUseWlPasteForLinux,
  resolveWlPasteReadOutcome,
  shouldFallbackAfterWlPaste,
  WL_PASTE_TIMEOUT_MS
} from '../src/shared/waylandSelection.ts'

test('XDG_SESSION_TYPE=wayland 时判定为 Wayland 会话', () => {
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: 'wayland' }), true)
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: 'Wayland' }), true)
})

test('仅存在 WAYLAND_DISPLAY 时也判定为 Wayland 会话', () => {
  assert.equal(isWaylandSession({ WAYLAND_DISPLAY: 'wayland-0' }), true)
  assert.equal(
    isWaylandSession({ XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-1' }),
    true
  )
})

test('X11 会话不判定为 Wayland', () => {
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: 'x11' }), false)
  assert.equal(isWaylandSession({}), false)
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: 'tty' }), false)
})

test('仅 Linux 且 Wayland 会话才使用 wl-paste 读取', () => {
  assert.equal(shouldUseWlPasteForLinux('linux', { XDG_SESSION_TYPE: 'wayland' }), true)
  assert.equal(shouldUseWlPasteForLinux('linux', { XDG_SESSION_TYPE: 'x11' }), false)
  assert.equal(shouldUseWlPasteForLinux('darwin', { XDG_SESSION_TYPE: 'wayland' }), false)
  assert.equal(shouldUseWlPasteForLinux('win32', { WAYLAND_DISPLAY: 'wayland-0' }), false)
})

test('wl-paste 成功读取非空文本时应直接使用该文本', () => {
  const outcome = resolveWlPasteReadOutcome({ ok: true, text: '你好，世界' })
  assert.deepEqual(outcome, { kind: 'text', text: '你好，世界' })
})

test('wl-paste 成功读取纯空白文本时应回退，不视为有效选区', () => {
  assert.deepEqual(resolveWlPasteReadOutcome({ ok: true, text: '   \n\t ' }), { kind: 'fallback' })
})

test('wl-paste 成功读取空文本时应回退', () => {
  assert.deepEqual(resolveWlPasteReadOutcome({ ok: true, text: '' }), { kind: 'fallback' })
})

test('wl-paste 执行失败（命令不存在/超时/非零退出）时应回退', () => {
  assert.deepEqual(resolveWlPasteReadOutcome({ ok: false, text: '' }), { kind: 'fallback' })
  assert.deepEqual(resolveWlPasteReadOutcome({ ok: false, text: 'No selection' }), { kind: 'fallback' })
})

test('回退判定：text 结果不回退，fallback 结果回退', () => {
  assert.equal(shouldFallbackAfterWlPaste({ kind: 'text', text: 'abc' }), false)
  assert.equal(shouldFallbackAfterWlPaste({ kind: 'fallback' }), true)
})

test('wl-paste 单次调用超时应小于取词检查超时上限', () => {
  assert.equal(typeof WL_PASTE_TIMEOUT_MS, 'number')
  assert.ok(WL_PASTE_TIMEOUT_MS > 0)
  assert.ok(WL_PASTE_TIMEOUT_MS <= 800)
})
