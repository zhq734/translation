import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  getSelectionCapturePlan,
  resolveSelectionCaptureStrategy
} from '../src/shared/platformCapture.ts'

test('不同桌面平台应选择可用的系统级取词策略', () => {
  assert.equal(resolveSelectionCaptureStrategy('darwin'), 'macos-command-copy')
  assert.equal(resolveSelectionCaptureStrategy('win32'), 'windows-control-copy')
  assert.equal(resolveSelectionCaptureStrategy('linux'), 'linux-primary-selection')
  assert.equal(resolveSelectionCaptureStrategy('freebsd'), 'unsupported')
})

test('不同桌面平台应具备原生直读优先与复制兜底能力', () => {
  const darwinPlan = getSelectionCapturePlan('darwin')
  assert.equal(darwinPlan.nativeRead, 'macos-accessibility')
  assert.equal(darwinPlan.supportsNativeRead, true)
  assert.equal(darwinPlan.copyFallback, true)

  const win32Plan = getSelectionCapturePlan('win32')
  assert.equal(win32Plan.nativeRead, 'windows-uia')
  assert.equal(win32Plan.supportsNativeRead, true)
  assert.equal(win32Plan.copyFallback, true)

  const linuxPlan = getSelectionCapturePlan('linux')
  assert.equal(linuxPlan.nativeRead, 'linux-primary-selection')
  assert.equal(linuxPlan.supportsNativeRead, true)
  assert.equal(linuxPlan.copyFallback, false)

  const unsupportedPlan = getSelectionCapturePlan('freebsd')
  assert.equal(unsupportedPlan.nativeRead, 'unsupported')
  assert.equal(unsupportedPlan.supportsNativeRead, false)
  assert.equal(unsupportedPlan.copyFallback, false)
})

test('主进程取词实现应包含 Windows Ctrl+C、Linux primary selection 与直读优先编排', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')

  assert.match(source, /powershell\.exe/u)
  assert.match(source, /keybd_event/u)
  assert.match(source, /clipboard\.readText\('selection'\)/u)
  assert.match(source, /readSelectionByNative/u)
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

test('原生直读脚本应输出带文本的规范化结果，供取词管线解析', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')

  assert.match(source, /AXSelectedText/u)
  assert.match(source, /TextPattern/u)
})

/**
 * 校验取词管线先执行原生直读，直读未取到文本时才回退到复制兜底。
 * @returns 无返回值。
 * @author zhenghq
 */
test('取词管线应原生直读优先并在失败时回退复制兜底', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const pipelineStart = source.indexOf('export async function captureSelection')
  const pipelineSource = source.slice(pipelineStart)
  const nativeReadCall = pipelineSource.indexOf('readSelectionByNative()')
  const copyFallbackCall = pipelineSource.indexOf('captureByCopy(signal')

  assert.ok(nativeReadCall >= 0, 'captureSelection 应先调用原生直读')
  assert.ok(
    copyFallbackCall > nativeReadCall,
    '直读未取到文本时才应回退到复制兜底'
  )
})

/**
 * 校验 macOS 直读脚本在 PRESENT 时输出选中文本，供直读解析消费且不触碰剪贴板。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 直读脚本应在 PRESENT 时同时输出选中文本', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')

  assert.match(source, /PRESENT\\n" & \(selectedText as text\)/u)
})

/**
 * 校验 Windows 直读脚本用 TextPattern 输出 PRESENT 状态与选中文本，换行符分隔供解析。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 直读脚本应输出 PRESENT 状态与选中文本', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')

  assert.match(source, /TextPattern\]\$pattern\)\.GetSelection\(\)/u)
  assert.match(source, /GetText\(-1\)/u)
  assert.match(source, /PRESENT' \+ \[char\]10 \+ \$text/u)
})

/**
 * 校验 Linux 直读包装主选区并纳入统一管线，空时按分类返回原因且不注入复制键。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Linux 取词应纳入主选区直读并保留分类结果', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')

  assert.match(source, /clipboard\.readText\('selection'\)/u)
  assert.match(source, /status === 'empty' \? 'empty' : 'unsupported'/u)
  assert.match(source, /parseNativeSelectionReadOutput/u)
})

/**
 * 校验按钮显示期间使用的只读直读预取：只调原生直读、不注入复制键、不写剪贴板。
 * @returns 无返回值。
 * @author zhenghq
 */
test('只读预取应仅使用原生直读且不注入复制键或写剪贴板', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const prefetchStart = source.indexOf('export async function captureSelectionByNativeOnly')
  // 结束标记必须带左括号，避免把 captureSelectionByNativeOnly 自身当作 captureSelection 的起点。
  const prefetchEnd = source.indexOf('export async function captureSelection(', prefetchStart)
  const prefetchSource = source.slice(prefetchStart, prefetchEnd)

  assert.ok(prefetchStart >= 0, '应导出 captureSelectionByNativeOnly 只读预取函数')
  assert.match(prefetchSource, /readSelectionByNative\(\)/u)
  assert.match(prefetchSource, /native\.status === 'present'/u)
  assert.doesNotMatch(prefetchSource, /captureByCopy|simulateCopy|keybd_event|CGEvent/u)
  assert.doesNotMatch(prefetchSource, /clipboard\.write/u)
  assert.match(prefetchSource, /reason: native\.status === 'empty' \? 'empty' : 'unsupported'/u)
})
