import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  createDeferredServicesGate,
  markDeferredServicesReady
} from '../src/main/deferredServicesGate.ts'

const mainSource = readFileSync('src/main/index.ts', 'utf8')

/**
 * 截取顶层函数的完整源码片段，直到顶格右花括号为止。
 * @param signature 函数签名起始片段。
 * @returns 函数源码片段。
 * @author zhenghq
 */
function extractFunction(signature: string): string {
  const start = mainSource.indexOf(signature)
  assert.ok(start >= 0, `应存在函数 ${signature}`)
  const end = mainSource.indexOf('\n}', start)
  assert.ok(end > start, `函数 ${signature} 应有结束边界`)
  return mainSource.slice(start, end + 2)
}

test('启动期 IPC 等待后台服务时不得反向触发重初始化', () => {
  assert.match(mainSource, /function waitForDeferredStartupServices\(\): Promise<void>/u)
  assert.match(mainSource, /function runWhenDeferredServicesReady\(action: \(\) => void\): void/u)
  assert.match(mainSource, /function queueDeferredServiceWaiter\(/u)
  assert.match(mainSource, /waitForDeferredStartupServices\(\)\.then\(action\)\.catch/u)
  assert.doesNotMatch(
    extractFunction('function waitForDeferredStartupServices(): Promise<void>'),
    /startDeferredStartupServices\(|initializeDeferredStartupServices\(/u,
    '等待门控不得在设置页首屏拉起重服务'
  )

  const onReadySource = extractFunction('async function onReady(): Promise<boolean>')
  const settingsOpenIndex = onReadySource.indexOf(
    "if (openSettingsOnInitialLaunch) await openSettings({ bringToFront: true, source: 'initial-launch' })"
  )
  const deferredStartIndex = onReadySource.indexOf('startDeferredStartupServices()')
  assert.ok(settingsOpenIndex >= 0 && deferredStartIndex > settingsOpenIndex,
    '重后台服务仍必须在设置页首开之后启动')
  assert.match(onReadySource, /startDeferredStartupServices\(\)\n  return true/u)

  const settingsStatusSource = extractFunction("ipcMain.handle('subtitle:get-status'")
  assert.match(
    settingsStatusSource,
    /unsupportedRealtimeSubtitleSnapshot/u,
    '设置页首屏状态查询必须拥有不依赖重服务的轻量快照'
  )
  assert.doesNotMatch(
    settingsStatusSource,
    /getReadyRealtimeSubtitleController\(|ensureDeferredStartupServicesInitialized\(/u,
    '设置页首屏状态查询不得等待尚未启动的重服务'
  )
})

test('显式业务入口在后台服务未就绪时登记等待，就绪后立即重放', () => {
  for (const signature of [
    'function onGlobalShortcut(accelerator: string): void',
    'function handleSelectionGesture(gesture: SelectionGesture): void',
    'function openWebReaderFromShortcut(): void',
    'function openDocumentWorkspaceFromShortcut(): void',
    'function openWebReaderFromPopup(url?: string): void',
    'function openDocumentWorkspaceFromPopup(): void',
    'async function openManualTranslation(): Promise<void>',
    'async function translateClipboardImage(): Promise<void>',
    'async function translateText(',
    'async function translateRecognizedOcrResult(',
    'async function requestManualTranslation(',
    'function toggleRealtimeSubtitleFromShortcut(): void',
    'function buildTrayMenu(): Menu'
  ]) {
    const source = extractFunction(signature)
    assert.match(source, /whenApplicationServicesReady/u, `${signature} 必须识别服务就绪窗口期`)
  }

  for (const action of [
    'openManualTranslation()',
    'translateClipboardImage()',
    'openWebReaderFromPopup(url)',
    'openDocumentWorkspaceFromPopup()',
    'requestManualTranslation(text',
    'toggleRealtimeSubtitleFromShortcut()'
  ]) {
    assert.ok(mainSource.includes(action), `应保留显式动作 ${action}`)
  }
  assert.match(mainSource, /function toggleRealtimeSubtitleFromShortcut\(\): void/u)
  assert.match(mainSource, /async function requestManualTranslation\(/u)
})

test('就绪门控只在服务启动完成后重放等待的用户动作，失败时放弃且不留未处理异常', async () => {
  const gate = createDeferredServicesGate()
  const actions: string[] = []
  let rejected = false
  gate.whenReady(() => actions.push('first'))
  gate.whenReady(() => actions.push('second'))
  assert.deepEqual(actions, [], '未就绪时不得执行用户动作')
  assert.equal(gate.isReady(), false)

  void gate.getInitializationPromise().catch(() => {
    rejected = true
  })
  markDeferredServicesReady(gate)
  await gate.getInitializationPromise()
  assert.deepEqual(actions, ['first', 'second'])
  assert.equal(gate.isReady(), true)
  assert.equal(rejected, false)

  gate.whenReady(() => actions.push('third'))
  assert.deepEqual(actions, ['first', 'second', 'third'], '就绪后的动作应立即执行')

  const failedGate = createDeferredServicesGate()
  const failedActions: string[] = []
  failedGate.whenReady(() => failedActions.push('never'))
  failedGate.fail(new Error('startup failed'))
  await assert.rejects(failedGate.getInitializationPromise(), /startup failed/u)
  assert.deepEqual(failedActions, [], '初始化失败时不得重放依赖服务的动作')
  failedGate.whenReady(() => failedActions.push('still-never'))
  assert.deepEqual(failedActions, [], '失败状态不得再次放行依赖服务的动作')
})
