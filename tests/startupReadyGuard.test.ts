import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { extractIpcRegistration, readMainSource } from './helpers/mainSource.ts'
import {
  createDeferredServicesGate,
  markDeferredServicesReady
} from '../src/main/deferredServicesGate.ts'

const mainSource = readMainSource()

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

/**
 * 截取单个 IPC 注册片段，直到回调结束边界。
 * @param channel IPC 通道名。
 * @param method IPC 注册方法名。
 * @returns 单个处理器源码片段。
 * @author zhenghq
 */
function extractIpcHandler(channel: string, method: 'handle' | 'on' = 'handle'): string {
  return extractIpcRegistration(mainSource, channel, method)
}

/**
 * 截取网页阅读器控制类 ipcMain.on 注册片段，直到通道注册结束边界。
 * @param channel IPC 通道名。
 * @returns 单个处理器源码片段。
 * @author zhenghq
 */
function extractIpcListener(channel: string): string {
  return extractIpcRegistration(mainSource, channel, 'on')
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

  const settingsStatusSource = extractIpcHandler('subtitle:get-status')
  assert.match(
    settingsStatusSource,
    /dependencies\.getUnsupportedRealtimeSubtitleSnapshot\(\)/u,
    '设置页首屏状态查询必须拥有不依赖重服务的轻量快照'
  )
  assert.doesNotMatch(
    settingsStatusSource,
    /getReadyRealtimeSubtitleController\(|ensureDeferredStartupServicesInitialized\(|dependencies\.ensureReady\(/u,
    '设置页首屏状态查询不得等待尚未启动的重服务'
  )
  assert.match(
    settingsStatusSource,
    /dependencies\.createIdleRealtimeSubtitleSnapshot\(\)/u,
    '普通平台控制器尚未初始化时应返回中性空闲快照'
  )
  assert.match(
    mainSource,
    /function createIdleRealtimeSubtitleSnapshot\(\): RealtimeSubtitleSnapshot/u,
    '应提供不带平台错误的中性空闲快照'
  )
  const idleSnapshotSource = extractFunction(
    'function createIdleRealtimeSubtitleSnapshot(): RealtimeSubtitleSnapshot'
  )
  assert.doesNotMatch(idleSnapshotSource, /error|errorCode/u, '中性空闲快照不得误报平台不支持')
  assert.match(
    settingsStatusSource,
    /dependencies\.getRealtimeSubtitleCapability\(\)/u,
    '首屏状态查询应同步区分平台能力，避免不支持平台先显示空闲再跳变'
  )
  assert.match(
    settingsStatusSource,
    /capability\.supported\s*\?\s*dependencies\.createIdleRealtimeSubtitleSnapshot\(\)/u,
    '仅支持平台在控制器未初始化时返回中性空闲快照'
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
    'function toggleRealtimeSubtitleFromShortcut(): void'
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

  const traySource = extractFunction('function buildTrayMenu(): Menu')
  assert.match(
    traySource,
    /applicationServicesGate\.isReady\(\)/u,
    '托盘菜单必须识别服务就绪窗口期'
  )
  assert.match(
    traySource,
    /runWhenDeferredServicesReady\(refreshTrayMenu\)/u,
    '托盘菜单应在重后台服务就绪后刷新，而不是登记空动作'
  )
  assert.doesNotMatch(
    traySource,
    /void whenApplicationServicesReady\(\(\) => undefined\)/u,
    '不得留下可能拒绝的空等待动作'
  )
})

test('网页阅读器控制 IPC 在后台服务启动失败时不得留下未处理 Promise 异常', () => {
  const ipcBody = extractFunction('function registerIpc(): void')
  assert.match(ipcBody, /registerWebReaderIpc\(\{/u, '主进程必须注册网页阅读器 IPC 模块')
  assert.match(ipcBody, /runWhenReady: runWhenDeferredServicesReady/u, '阅读器动作必须接入统一就绪门控')
  for (const channel of [
    'webview:close',
    'webview:back',
    'webview:forward',
    'webview:reload',
    'webview:set-bounds',
    'web-translate:cancel'
  ]) {
    const source = extractIpcListener(channel)
    assert.match(
      source,
      /dependencies\.runWhenReady\(/u,
      `${channel} 应在服务就绪后执行且统一处理启动失败`
    )
    assert.doesNotMatch(
      source,
      /void getReadyWebReader\(\)/u,
      `${channel} 不得留下未处理的后台服务启动异常`
    )
  }
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
