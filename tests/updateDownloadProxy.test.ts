import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { applyProxyToSessions, type ProxyCapableSession } from '../src/main/proxySessionApply.ts'

/**
 * 创建记录代理调用顺序的假网络会话。
 * @param name 会话名称，便于断言调用归属。
 * @param calls 共享调用记录。
 * @returns 可传入代理应用函数的假会话。
 * @author zhenghq
 */
function createFakeSession(name: string, calls: string[]): ProxyCapableSession {
  return {
    setProxy: async (config) => {
      calls.push(`${name}:setProxy:${JSON.stringify(config)}`)
    },
    closeAllConnections: async () => {
      calls.push(`${name}:closeAllConnections`)
    }
  }
}

test('代理应用应对翻译会话与更新下载会话同时设置代理并释放旧连接', async () => {
  const calls: string[] = []
  const translation = createFakeSession('translation', calls)
  const updateDownload = createFakeSession('updateDownload', calls)

  await applyProxyToSessions([translation, updateDownload], { mode: 'direct' })

  assert.deepEqual(calls, [
    'translation:setProxy:{"mode":"direct"}',
    'translation:closeAllConnections',
    'updateDownload:setProxy:{"mode":"direct"}',
    'updateDownload:closeAllConnections'
  ])
})

test('代理应用应把同一份代理配置传给每个会话', async () => {
  const calls: string[] = []
  const proxyConfig = {
    proxyRules: 'http://127.0.0.1:7890',
    proxyBypassRules: '<local>'
  }

  await applyProxyToSessions(
    [createFakeSession('translation', calls), createFakeSession('updateDownload', calls)],
    proxyConfig
  )

  const setProxyCalls = calls.filter((call) => call.includes(':setProxy:'))
  assert.equal(setProxyCalls.length, 2)
  assert.equal(
    setProxyCalls[0].replace('translation', ''),
    setProxyCalls[1].replace('updateDownload', '')
  )
})

test('某个会话应用代理失败时不应阻止其余会话完成配置', async () => {
  const calls: string[] = []
  const failing: ProxyCapableSession = {
    setProxy: async () => {
      throw new Error('会话已销毁')
    },
    closeAllConnections: async () => {
      calls.push('failing:closeAllConnections')
    }
  }

  await applyProxyToSessions([failing, createFakeSession('updateDownload', calls)], { mode: 'system' })

  assert.deepEqual(calls, [
    'updateDownload:setProxy:{"mode":"system"}',
    'updateDownload:closeAllConnections'
  ])
})

test('网络模块应把翻译会话与 electron-updater 会话一起交给代理应用逻辑', () => {
  const source = readFileSync('src/main/network.ts', 'utf8')

  assert.match(source, /session\.fromPartition\('translation-network'\)/u)
  assert.match(source, /session\.fromPartition\('electron-updater'\)/u)
  assert.match(
    source,
    /applyProxyToSessions\(\s*\[getTranslationSession\(\), getUpdateDownloadSession\(\)\],\s*buildProxyConfig\(settings\)\s*\)/u,
    'applyTranslationProxy 必须同时覆盖翻译会话与更新下载会话'
  )
})

test('手动 macOS 更新服务应注入统一代理会话的 fetch', () => {
  const source = readFileSync('src/main/updater.ts', 'utf8')

  assert.match(source, /import \{ translationFetch \} from '\.\/network'/u)
  assert.match(
    source,
    /createManualMacUpdateService\(\{[\s\S]*?fetch:\s*translationFetch/u,
    '手动 DMG 下载必须使用应用代理会话，而不是 Node 全局 fetch'
  )
})

test('手动 macOS 更新服务必须显式注入 fetch 依赖，不再隐式回退全局 fetch', () => {
  const source = readFileSync('src/main/manualMacUpdate.ts', 'utf8')

  assert.doesNotMatch(
    source,
    /options\.fetch \?\? globalThis\.fetch/u,
    '不应保留绕过代理的全局 fetch 回退'
  )
  assert.match(
    source,
    /fetch:\s*UpdateDownloadFetch/u,
    'fetch 依赖必须是必填项，由调用方注入代理会话实现'
  )
})
