import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const mainSource = readFileSync('src/main/index.ts', 'utf8')
const settingsSource = readFileSync('src/renderer/src/settings.ts', 'utf8')

/**
 * 截取顶层函数的完整源码片段，直到顶格右花括号为止。
 * @param source 主进程或 Renderer 源码。
 * @param signature 函数签名起始片段。
 * @returns 函数源码片段。
 * @author zhenghq
 */
function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `应存在函数 ${signature}`)
  const end = source.indexOf('\n}', start)
  assert.ok(end > start, `函数 ${signature} 应有结束边界`)
  return source.slice(start, end + 2)
}

test('启动首开设置页前不得执行更新管理器、Toast 和预热等重初始化', () => {
  const onReadySource = extractFunction(mainSource, 'async function onReady(): Promise<boolean>')
  const deferredSource = extractFunction(mainSource, 'async function initializeDeferredStartupServices(): Promise<void>')
  const settingsOpen = "if (openSettingsOnInitialLaunch) await openSettings({ bringToFront: true, source: 'initial-launch' })"
  const deferredStart = 'startDeferredStartupServices()'
  const settingsOpenIndex = onReadySource.indexOf(settingsOpen)
  const deferredStartIndex = onReadySource.indexOf(deferredStart)
  const registerIpcIndex = onReadySource.indexOf('\n  registerIpc()\n')

  assert.ok(registerIpcIndex >= 0, '设置页首屏必须提前注册完整 IPC')
  assert.ok(settingsOpenIndex > registerIpcIndex, '设置页打开必须晚于 IPC 注册')
  assert.ok(deferredStartIndex > settingsOpenIndex, '重后台服务必须在设置页首开之后启动')
  assert.doesNotMatch(onReadySource, /await initializeDeferredStartupServices\(\)/u, '重后台服务不得阻塞启动初始化 Promise')
  assert.match(onReadySource, /startDeferredStartupServices\(\)\n  return true/u, '设置页首开后应立即触发后台服务并结束初始化')
  assert.match(onReadySource, /createSelectionButton\(PRELOAD_PATH/u, '选区按钮接线仍须保留在 onReady')
  for (const heavyCall of [
    'createApplicationUpdateManager(',
    'getScreenshotToastWindow()',
    'prewarmScreenshotRuntime()'
  ]) {
    assert.ok(!onReadySource.slice(0, settingsOpenIndex).includes(heavyCall), `${heavyCall} 不得阻塞设置页首开`)
    assert.ok(deferredSource.includes(heavyCall), `${heavyCall} 必须迁移到后台初始化`)
  }
  assert.match(deferredSource, /await applyTranslationProxy\(/u)
  assert.match(deferredSource, /initializeRealtimeSubtitle\(\)/u)
  assert.ok(
    mainSource.indexOf('createTray()') <
      mainSource.indexOf('await applyTranslationProxy(', mainSource.indexOf('async function initializeDeferredStartupServices')),
    '托盘与代理的全局源码顺序仍须兼容既有生命周期测试'
  )
  assert.ok(
    mainSource.indexOf('await confirmMacOSInstalledApplicationLaunch()') <
      mainSource.indexOf('\n  applySelectionListener()\n'),
    '磁盘镜像确认仍须早于划词监听启动'
  )
})

test('后台服务初始化完成前 IPC 必须等待，所有依赖后台服务的处理器保持可用', () => {
  assert.match(mainSource, /function ensureDeferredStartupServicesInitialized\(\): Promise<void>/u)
  assert.match(mainSource, /let deferredStartupServices: Promise<void> \| null = null/u)
  const ipcBody = extractFunction(mainSource, 'function registerIpc(): void')
  const serviceGetters = [
    'getDingTalkConfiguration()',
    'getAiConfiguration()',
    'getDeepgramConfiguration()',
    'getWhisperConfiguration()',
    'getDashScopeConfiguration()',
    'getOpenAIRealtimeConfiguration()',
    'getGeminiLiveConfiguration()',
    'getITranslateConfiguration()',
    'getDeepLxConfiguration()',
    'getWebReader()',
    'getDocumentWorkspace()',
    'getRealtimeSubtitleController()',
    'getScreenshotPinManager()'
  ]
  for (const getter of serviceGetters) {
    assert.ok(ipcBody.includes(`await ensureDeferredStartupServicesInitialized()\n    return ${getter}`), `${getter} 必须等待后台服务就绪`)
  }
  assert.match(ipcBody, /ipcMain\.handle\('settings:get', \(\) => getSettings\(\)\)/u)
  assert.match(mainSource, /deferredStartupServices = initializeDeferredStartupServices\(\)/u)
  assert.match(mainSource, /function startDeferredStartupServices\(\): Promise<void>/u)
})

test('更新管理器延后初始化时状态查询安全，全部更新操作等待管理器就绪后回填状态', () => {
  assert.match(mainSource, /let updateManagerInitialization: Promise<void> \| null = null/u)
  assert.match(mainSource, /function getUpdateStatusSnapshot\(\): UpdateStatus/u)
  assert.match(mainSource, /phase: updateManager \? updateManager\.getStatus\(\)\.phase : 'idle'/u)
  assert.match(mainSource, /ipcMain\.handle\('updater:get-status', \(\) => getUpdateStatusSnapshot\(\)\)/u)
  assert.doesNotMatch(mainSource, /ipcMain\.handle\('updater:get-status', \(\) => getUpdateManager\(\)\.getStatus\(\)\)/u)
  for (const operation of [
    'async function checkForApplicationUpdates(',
    'async function downloadApplicationUpdate(',
    'async function cancelApplicationUpdateDownload(',
    'async function openApplicationReleasePage('
  ]) {
    const body = extractFunction(mainSource, operation)
    assert.match(body, /await ensureUpdateManagerInitialized\(\)/u, `${operation} 必须等待更新管理器就绪`)
  }
  const installSource = extractFunction(mainSource, 'function installApplicationUpdate(): void')
  assert.match(installSource, /void ensureUpdateManagerInitialized\(\)[\s\S]*?getUpdateManager\(\)\.installUpdate\(\)/u)
  assert.match(mainSource, /broadcast\('updater:status', updateManager\.getStatus\(\)\)/u)
  assert.match(mainSource, /broadcast\('subtitle:update', snapshot\)/u)
  assert.match(mainSource, /broadcast\('settings:changed', getSettings\(\)\)/u)
  assert.match(mainSource, /setTimeout\(\(\) => void checkForApplicationUpdates\(\), UPDATE_CHECK_DELAY_MS\)/u)
})

test('设置页初始化应并行读取互不依赖的状态', () => {
  const initializeSource = extractFunction(settingsSource, 'async function initialize(): Promise<void>')
  assert.match(initializeSource, /const \[[\s\S]*?\] = await Promise\.all\(\[/u)
  for (const request of [
    'window.api.getSettings()',
    'window.api.getShortcutRegistrationStates()',
    'window.api.getOcrStatus()',
    'window.api.getDockerCommand(1189)',
    'window.api.getUpdateStatus()'
  ]) {
    assert.ok(initializeSource.includes(request), `初始化仍须读取 ${request}`)
  }
})
