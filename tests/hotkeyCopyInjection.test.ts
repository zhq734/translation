import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  COPY_FALLBACK_MAX_RETRIES,
  COPY_FALLBACK_RETRY_TIMEOUT_MS,
  COPY_INJECTION_RETRY_DELAY_MS,
  resolveCopyRetryPlan,
  resolveHotkeyModifiers,
  shouldReleaseHotkeyModifiersBeforeCopy,
  shouldRetryCopyInjection
} from '../src/shared/hotkeyCaptureTiming.ts'

/**
 * 校验从 Electron Accelerator 解析出触发快捷键实际按住的修饰键，
 * 供注入 Ctrl+C 前强制释放，避免被前台应用识别成 Ctrl+Alt+C 等错误组合。
 * @returns 无返回值。
 * @author zhenghq
 */
test('翻译快捷键应解析出需要在复制前释放的修饰键', () => {
  assert.deepEqual(resolveHotkeyModifiers('Alt+T', 'win32'), ['alt'])
  assert.deepEqual(resolveHotkeyModifiers('Control+Shift+Y', 'win32'), ['control', 'shift'])
  assert.deepEqual(resolveHotkeyModifiers('CommandOrControl+D', 'win32'), ['control'])
  assert.deepEqual(resolveHotkeyModifiers('CmdOrCtrl+D', 'darwin'), ['meta'])
  assert.deepEqual(resolveHotkeyModifiers('Super+X', 'win32'), ['meta'])
  assert.deepEqual(resolveHotkeyModifiers('Alt+Shift+Alt+T', 'win32'), ['alt', 'shift'])
  assert.deepEqual(resolveHotkeyModifiers('', 'win32'), [])
  assert.deepEqual(resolveHotkeyModifiers('F9', 'win32'), [])
})

/**
 * 校验仅 Windows 需要在注入复制快捷键前强制释放修饰键。
 * macOS 的 CGEvent 注入自带修饰键标志，Linux 走主选区读取，均无需释放。
 * @returns 无返回值。
 * @author zhenghq
 */
test('只有 Windows 需要在注入复制快捷键前释放修饰键', () => {
  assert.equal(shouldReleaseHotkeyModifiersBeforeCopy('win32'), true)
  assert.equal(shouldReleaseHotkeyModifiersBeforeCopy('darwin'), false)
  assert.equal(shouldReleaseHotkeyModifiersBeforeCopy('linux'), false)
})

/**
 * 校验复制兜底在首次注入无响应时限次重投复制快捷键，且不会无限重投。
 * @returns 无返回值。
 * @author zhenghq
 */
test('复制取词应在首次注入无响应时限次重投复制快捷键', () => {
  assert.equal(COPY_INJECTION_RETRY_DELAY_MS > 0, true)
  assert.equal(shouldRetryCopyInjection(COPY_INJECTION_RETRY_DELAY_MS - 1, 1), false)
  assert.equal(shouldRetryCopyInjection(COPY_INJECTION_RETRY_DELAY_MS, 1), true)
  assert.equal(shouldRetryCopyInjection(COPY_INJECTION_RETRY_DELAY_MS * 3, 2), false)
  assert.equal(shouldRetryCopyInjection(COPY_INJECTION_RETRY_DELAY_MS * 3, 1, 0), false)
  assert.equal(shouldRetryCopyInjection(0, 0), false)
})

/**
 * 校验主进程在快捷键取词前登记待释放修饰键，并在 Windows 模拟复制时释放左右两侧修饰键。
 * @returns 无返回值。
 * @author zhenghq
 */
test('快捷键取词前应登记修饰键释放并在模拟复制时释放左右修饰键', () => {
  const mainSource = readFileSync('src/main/index.ts', 'utf8')
  const captureSource = readFileSync('src/main/capture.ts', 'utf8')
  const hotkeyStart = mainSource.indexOf('function onHotkey')
  const hotkeyEnd = mainSource.indexOf('/**\n * 响应全局 OCR 快捷键', hotkeyStart)
  const hotkeySource = mainSource.slice(hotkeyStart, hotkeyEnd)

  assert.ok(hotkeyStart >= 0)
  assert.ok(hotkeyEnd > hotkeyStart)
  assert.match(hotkeySource, /shouldReleaseHotkeyModifiersBeforeCopy\(process\.platform\)/u)
  assert.match(hotkeySource, /const hotkeyModifiers = resolveHotkeyModifiers\(/u)
  assert.match(hotkeySource, /setPendingCopyModifierRelease\(hotkeyModifiers\)/u)
  assert.match(captureSource, /export function setPendingCopyModifierRelease/u)
  assert.match(captureSource, /UiohookKey\.CtrlRight/u)
  assert.match(captureSource, /UiohookKey\.AltRight/u)
  assert.match(captureSource, /UiohookKey\.ShiftRight/u)
  assert.match(captureSource, /UiohookKey\.MetaRight/u)
  assert.match(captureSource, /keyToggle\([^,]+,\s*'up'\)/u)
})

/**
 * 校验复制兜底在轮询期间可以重投一次复制快捷键，避免修饰键释放时序导致的取词超时。
 * @returns 无返回值。
 * @author zhenghq
 */
test('复制兜底轮询期间应可重投复制快捷键', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const start = source.indexOf('async function captureByCopy')
  const end = source.indexOf('export async function captureSelectionByNativeOnly', start)
  const copySource = source.slice(start, end)

  assert.ok(start >= 0)
  assert.ok(end > start)
  assert.match(copySource, /shouldRetryCopyInjection\(/u)
  assert.match(copySource, /copy-retry/u)
})

/**
 * 校验全局钩子未运行时跳过内部模拟复制的观测等待。
 * 纯快捷键触发模式不会启动 uiohook，观测窗口内不可能收到复制事件，
 * 每次注入都白等观测超时会让取词额外变慢。
 * @returns 无返回值。
 * @author zhenghq
 */
test('全局钩子未运行时不应等待内部模拟复制的观测窗口', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const start = source.indexOf('async function captureByCopy')
  const end = source.indexOf('export async function captureSelectionByNativeOnly', start)
  const copySource = source.slice(start, end)

  assert.ok(start >= 0)
  assert.ok(end > start)
  assert.match(source, /import \{ isAutoTriggerRunning \} from '\.\/autoTrigger'/u)
  assert.match(copySource, /isAutoTriggerRunning\(\)/u)
  assert.match(
    copySource,
    /if\s*\(!\s*shouldObserveSyntheticCopy\)\s*\{\s*await sendCopyShortcut\(false\)/u
  )
  assert.match(copySource, /expectSyntheticCopyShortcut\(\)[\s\S]*?sendCopyShortcut\(true\)/u)
})

/**
 * 校验复制兜底在首次轮询超时后只允许一次独立、有界的重试，
 * 且重试计划必须尊重中止信号与用户主动复制状态。
 * @returns 无返回值。
 * @author zhenghq
 */
test('复制兜底超时后应允许一次独立有界重试', () => {
  assert.equal(typeof resolveCopyRetryPlan, 'function')
  const plan = resolveCopyRetryPlan({
    attempts: 1,
    retries: 0,
    elapsedMs: 800,
    timeoutMs: 800,
    aborted: false,
    externalCopyObserved: false
  })
  assert.equal(plan.retry, true)
  assert.ok(plan.retryTimeoutMs > 0, '重试必须带独立超时')
  assert.ok(plan.retryTimeoutMs <= 600, '重试超时必须不超过硬上限')

  // 一次复制键都没注入成功时无可重试内容，不得进入重试。
  assert.equal(resolveCopyRetryPlan({
    attempts: 0,
    retries: 0,
    elapsedMs: 800,
    timeoutMs: 800,
    aborted: false,
    externalCopyObserved: false
  }).retry, false)

  // 重试次数耗尽后不得再重试。
  assert.equal(resolveCopyRetryPlan({
    attempts: 1,
    retries: 1,
    elapsedMs: 1600,
    timeoutMs: 800,
    aborted: false,
    externalCopyObserved: false
  }).retry, false)

  // 取词被中止时不得重试。
  assert.equal(resolveCopyRetryPlan({
    attempts: 1,
    retries: 0,
    elapsedMs: 800,
    timeoutMs: 800,
    aborted: true,
    externalCopyObserved: false
  }).retry, false)

  // 用户主动复制时不得重试，避免覆盖用户剪贴板。
  assert.equal(resolveCopyRetryPlan({
    attempts: 1,
    retries: 0,
    elapsedMs: 800,
    timeoutMs: 800,
    aborted: false,
    externalCopyObserved: true
  }).retry, false)

  // 首次轮询尚未超时时不得提前进入独立重试轮次。
  assert.equal(resolveCopyRetryPlan({
    attempts: 1,
    retries: 0,
    elapsedMs: 200,
    timeoutMs: 800,
    aborted: false,
    externalCopyObserved: false
  }).retry, false)
})

/**
 * 校验复制兜底重试常量语义：最多一次、超时有硬上限。
 * @returns 无返回值。
 * @author zhenghq
 */
test('复制兜底重试次数与超时必须受硬上限约束', () => {
  assert.equal(COPY_FALLBACK_MAX_RETRIES, 1)
  assert.ok(COPY_FALLBACK_RETRY_TIMEOUT_MS > 0)
  assert.ok(COPY_FALLBACK_RETRY_TIMEOUT_MS <= 600)
})
