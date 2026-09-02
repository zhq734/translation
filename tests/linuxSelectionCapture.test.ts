import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * 读取主进程取词实现源码，用于约束 Linux 取词结构。
 * @returns capture.ts 源码文本。
 * @author zhenghq
 */
function readCaptureSource(): string {
  return readFileSync('src/main/capture.ts', 'utf8')
}

test('Linux 取词应抽出统一读取函数供选区检查与原生直读共用', () => {
  const source = readCaptureSource()

  // 统一的 Linux 读取入口必须存在
  assert.match(source, /async function readLinuxSelectionByNative/u)

  // inspectSelectedTextPresence 的 Linux 分支必须使用统一入口，禁止直接调用 readText('selection')
  const inspectStart = source.indexOf('export async function inspectSelectedTextPresence')
  const inspectEnd = source.indexOf('export async function readSelectionByNative')
  const inspectSource = source.slice(inspectStart, inspectEnd)
  assert.match(inspectSource, /readLinuxSelectionByNative/u)
  assert.equal(inspectSource.includes("readText('selection')"), false)

  // readSelectionByNative 的 Linux 分支必须使用统一入口，禁止直接调用 readText('selection')
  const nativeStart = source.indexOf('export async function readSelectionByNative')
  const nativeEnd = source.indexOf('async function readSelectionByNativeWithRetry')
  const nativeSource = source.slice(nativeStart, nativeEnd)
  assert.match(nativeSource, /readLinuxSelectionByNative/u)
  assert.equal(nativeSource.includes("readText('selection')"), false)
})

test('Linux 统一读取应在 Wayland 会话优先调用 wl-paste 读取主选区', () => {
  const source = readCaptureSource()

  assert.match(source, /shouldUseWlPasteForLinux/u)
  assert.match(source, /wl-paste/u)
  assert.match(source, /--primary/u)
  assert.match(source, /--no-newline/u)
})

test('wl-paste 读取应受超时与取消信号约束', () => {
  const source = readCaptureSource()

  assert.match(source, /WL_PASTE_TIMEOUT_MS/u)
  const wlPasteCall = source.indexOf("'wl-paste'")
  assert.ok(wlPasteCall >= 0, '应存在 wl-paste 调用')
  const callContext = source.slice(wlPasteCall, wlPasteCall + 400)
  assert.match(callContext, /timeout/u)
  assert.match(callContext, /signal/u)
})

test('wl-paste 读取失败或为空时应回退 Electron selection 读取', () => {
  const source = readCaptureSource()

  assert.match(source, /resolveWlPasteReadOutcome/u)
  // 统一读取函数内部必须保留 readText('selection') 回退路径
  const fnStart = source.indexOf('async function readLinuxSelectionByNative')
  assert.ok(fnStart >= 0, '应存在 readLinuxSelectionByNative')
  const fnEnd = source.indexOf('export async function checkAccessibilityPermission')
  const fnSource = source.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined)
  assert.match(fnSource, /readText\('selection'\)/u)
})
