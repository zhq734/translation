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
