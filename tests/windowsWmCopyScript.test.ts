import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/** 读取主进程取词源码，用于约束 Windows WM_COPY 脚本结构。 @author zhenghq */
function readCaptureSource(): string {
  return readFileSync('src/main/capture.ts', 'utf8')
}

/**
 * 提取 tryWmCopyPoll 函数源码。
 * @returns 函数源码片段。
 * @author zhenghq
 */
function sliceWmCopyFunction(): string {
  const source = readCaptureSource()
  const start = source.indexOf('async function tryWmCopyPoll(')
  assert.ok(start >= 0, '应存在 tryWmCopyPoll')
  const next = source.indexOf('/**', start + 10)
  const end = source.indexOf('async function simulateCopy(', start)
  return source.slice(start, end > start ? end : next)
}

test('WM_COPY 脚本必须先定义 User32 类型再调用 SendMessageTimeout', () => {
  const fnSource = sliceWmCopyFunction()
  const addTypeIndex = fnSource.indexOf('Add-Type -Namespace User32')
  const callIndex = fnSource.indexOf('[User32]::SendMessageTimeout')
  assert.ok(addTypeIndex >= 0, '应存在 User32 类型定义')
  assert.ok(callIndex >= 0, '应存在 SendMessageTimeout 调用')
  assert.ok(
    addTypeIndex < callIndex,
    'PowerShell 顺序执行：Add-Type 必须位于首次使用 [User32] 之前，否则脚本必然报找不到类型'
  )
})

test('WM_COPY 消息发送必须使用 SMTO_ABORTIFHUNG 防止挂起窗口阻塞取词', () => {
  const fnSource = sliceWmCopyFunction()
  assert.match(
    fnSource,
    /0x0002/u,
    'SendMessageTimeout 应使用 SMTO_ABORTIFHUNG(0x0002)，SMTO_BLOCK(0x0001) 会被挂起窗口阻塞'
  )
  assert.equal(
    fnSource.includes('0x0001'),
    false,
    '不得继续使用 SMTO_BLOCK(0x0001)'
  )
})

test('WM_COPY 的 PowerShell 进程超时必须独立于消息超时并留足冷启动余量', () => {
  const source = readCaptureSource()
  assert.match(
    source,
    /WM_COPY_SCRIPT_TIMEOUT_MS/u,
    '应存在独立的 WM_COPY 脚本进程超时常量'
  )
  const fnSource = sliceWmCopyFunction()
  const execCall = fnSource.indexOf("execFileP('powershell.exe'")
  assert.ok(execCall >= 0, '应存在 PowerShell 进程调用')
  const execContext = fnSource.slice(execCall, execCall + 500)
  assert.match(
    execContext,
    /timeout:\s*WM_COPY_SCRIPT_TIMEOUT_MS/u,
    '进程超时不得复用 WM_COPY_TIMEOUT_MS（500ms 连 PowerShell 冷启动都不够）'
  )
})
