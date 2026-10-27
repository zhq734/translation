import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * 校验 macOS 模拟复制脚本不再调用 CGEventSourceKeyState。
 * 该 API 在部分 macOS 环境会无限阻塞等待 hiservices XPC 回复，
 * 导致复制快捷键迟迟发不出去，划词取词最终以超时失败。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 模拟复制脚本不应调用可能无限阻塞的 CGEventSourceKeyState', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  assert.equal(source.includes('CGEventSourceKeyState'), false)
})

/**
 * 校验 macOS 模拟复制为脚本执行设置了超时，并由快捷键入口短时传递 Command 状态。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 模拟复制应带脚本超时并从快捷键入口接收 Command 键状态', () => {
  const captureSource = readFileSync('src/main/capture.ts', 'utf8')
  const mainSource = readFileSync('src/main/index.ts', 'utf8')

  assert.equal(captureSource.includes('MACOS_COPY_SCRIPT_TIMEOUT_MS'), true)
  assert.equal(captureSource.includes('getKeyState'), false)
  assert.match(captureSource, /export function setPendingMacOSCommandWasDown/u)
  assert.match(captureSource, /pendingMacOSCommandWasDownUntil/u)
  assert.match(mainSource, /setPendingMacOSCommandWasDown\(hotkeyModifiers\.includes\('meta'\)\)/u)
  assert.match(mainSource, /translateSelectionButton\([\s\S]*?setPendingMacOSCommandWasDown\(false\)/u)
})

/**
 * 校验 macOS 模拟复制会在组合键的各个事件之间留出短暂间隔。
 * 部分 Electron 自绘编辑器会丢弃同一 tick 内连续到达的瞬时 Cmd+C 事件，
 * 间隔发送可让目标应用稳定收到完整的按下/释放序列。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 模拟复制应在按键事件之间留出短间隔', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const start = source.indexOf('const JXA_COPY =')
  const end = source.indexOf('\n\n/**', start)
  const jxaSource = source.slice(start, end)

  assert.match(jxaSource, /NSThread\.sleepForTimeInterval/u)
  assert.ok(
    (jxaSource.match(/sleepForTimeInterval/gu) ?? []).length >= 3,
    'Command、C 按下和 C 释放之间都应留出间隔'
  )
})

/**
 * 校验 macOS 重试可以定向投递到源进程，同时保留首轮全局事件注入。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 模拟复制重试应支持按源进程定向注入', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const copyStart = source.indexOf('export async function simulateCopy')
  const copyEnd = source.indexOf('/**\n * 通过模拟复制快捷键', copyStart)
  const copySource = source.slice(copyStart, copyEnd)

  assert.match(copySource, /simulateCopy\(targetPid\?: number\)/u)
  assert.match(source, /CGEventPostToPid/u)
  assert.match(source, /targetPid/u)
  assert.match(source, /CGEventPost\(\$\.kCGHIDEventTap/u)
  assert.match(
    source,
    /copy-retry[\s\S]*?injectCopyShortcut\(context\?\.pid\)/u,
    '轮询重试应使用源进程 PID 定向注入'
  )
  assert.match(
    source,
    /copy-fallback-retry[\s\S]*?injectCopyShortcut\(context\?\.pid\)/u,
    '独立 fallback 重试应使用源进程 PID 定向注入'
  )
})

/**
 * 校验未启用复制事件观测时不会伪造 `copyObserved=false`。
 * @returns 无返回值。
 * @author zhenghq
 */
test('未启用复制事件观测时不得输出未观测诊断', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const captureStart = source.indexOf('async function captureByCopy(')
  const captureEnd = source.indexOf('/**\n * 捕获当前选中文字', captureStart)
  const captureSource = source.slice(captureStart, captureEnd)

  assert.match(captureSource, /let syntheticCopyObserved: boolean \| undefined/u,
    '复制观测状态必须区分未观测与明确未观测到事件')
  assert.match(
    captureSource,
    /if \(!shouldObserveSyntheticCopy\) \{[\s\S]*?sendCopyShortcut\(false\)[\s\S]*?return/u,
    '未启用观测时只能注入快捷键，不得登记观测结果'
  )
  assert.match(
    captureSource,
    /syntheticCopyObserved = false[\s\S]*?const expectation = copyShortcutGuard\.expectSyntheticCopyShortcut\(\)/u,
    '启用观测时必须先显式标记为尚未观测到事件'
  )
  assert.match(
    captureSource,
    /\.\.\.\(syntheticCopyObserved === undefined \? \{\} : \{ copyObserved: syntheticCopyObserved \}\)/u,
    '超时诊断只能在观测状态已知时携带 copyObserved'
  )
  assert.ok(
    captureSource.includes(
      "syntheticCopyObserved === undefined ? '' : `copyObserved=${syntheticCopyObserved} `"
    ),
    '超时日志不得把未知状态打印为 false'
  )
})

/**
 * 校验 macOS 首次 Cmd+C 无剪贴板结果时，先尝试目标应用菜单栏的 AX 复制动作。
 * ynote 等应用可能观测到注入事件却不消费快捷键，AXPress 可直接触发其原生复制命令。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 首次复制超时后应优先尝试 AX 菜单复制兜底', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const captureStart = source.indexOf('async function captureByCopy(')
  const captureEnd = source.indexOf('/**\n * 捕获当前选中文字', captureStart)
  const captureSource = source.slice(captureStart, captureEnd)

  assert.match(source, /async function performMacosAxCopy\(pid: number, signal\?: AbortSignal\)/u,
    '应提供独立的 macOS AX 菜单复制函数')
  assert.match(source, /\["--copy", String\(pid\)\]/u, 'AX 复制必须把源进程号传给 helper')
  assert.match(source, /parseMacosAxCopyOutput/u, 'AX 复制结果必须通过固定状态协议解析')
  assert.match(source, /ax-copy-menu status=/u, 'AX 复制结果应输出脱敏诊断日志')
  assert.match(
    captureSource,
    /await injectCopyShortcut\(\)\s*await pollForCapture\(timeoutMs\)[\s\S]*?axCopyPerformed[\s\S]*?copy-fallback-retry/u,
    'AX 菜单复制兜底应位于首次快捷键轮询之后、盲重试之前'
  )
  assert.match(
    captureSource,
    /if \(!axCopyPerformed\)[\s\S]*?injectCopyShortcut\(context\?\.pid\)/u,
    'AX 菜单复制已执行时不得再次盲发定向 Cmd+C'
  )
})

/**
 * 校验 AX 菜单复制只对 macOS 且具备有效源进程号的场景启用，且遵守中止信号。
 * @returns 无返回值。
 * @author zhenghq
 */
test('AX 菜单复制兜底应受平台、进程号与中止信号约束', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const copyStart = source.indexOf('async function performMacosAxCopy(')
  const copyEnd = source.indexOf('/**\n * 通过模拟复制快捷键', copyStart)
  const copySource = source.slice(copyStart, copyEnd)

  assert.match(copySource, /process\.platform !== 'darwin'/u)
  assert.match(copySource, /!Number\.isInteger\(pid\) \|\| pid <= 0/u)
  assert.match(copySource, /signal\?\.aborted/u)
  assert.match(copySource, /resolveMacosAxReaderPath/u)
  assert.match(copySource, /SELECTION_INSPECTION_TIMEOUT_MS/u)
})
