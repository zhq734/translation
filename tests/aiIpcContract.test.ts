import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('主进程应注册 ai:configure、ai:clear-key、ai:list-models 和 ai:check IPC', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  assert.match(source, /ipcMain\.handle\('ai:configure'/u)
  assert.match(source, /ipcMain\.handle\('ai:clear-key'/u)
  assert.match(source, /ipcMain\.handle\('ai:list-models'/u)
  assert.match(source, /ipcMain\.handle\('ai:check'/u)
})

test('普通 settings:set 应删除 aiApiKey 和 aiApiKeyConfigured 敏感字段', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  assert.match(source, /delete \(safePatch as Record<string, unknown>\)\.aiApiKey/u)
  assert.match(source, /delete \(safePatch as Record<string, unknown>\)\.aiApiKeyConfigured/u)
})

test('AI 配置保存成功后应通过专用服务广播脱敏 Settings', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  assert.match(source, /onSettingsChanged: \(settings\) => \{[\s\S]*broadcast\('settings:changed', settings\)/u)
  assert.match(source, /resetTranslationRuntime: resetAiTranslationRuntime/u)
})

test('翻译请求应从主进程安全存储读取 AI API Key 并传入运行时', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  assert.match(source, /const aiApiKey = settings\.aiEnabled \? getAiConfiguration\(\)\.getApiKey\(\) : null/u)
  assert.match(source, /await translate\(text, requestSettings, dingTalkCredentials, aiApiKey\)/u)
})

test('AI 配置变化应清理模型缓存和 AI 运行时', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  assert.match(source, /if \(aiFieldChanged\) \{[\s\S]*resetAiTranslationRuntime\(\)[\s\S]*aiModelDiscovery\?\.clearCache\(\)/u)
})

test('preload 应暴露 setAiConfig、clearAiApiKey、listAiModels 和 checkAi 方法', () => {
  const source = readFileSync('src/preload/index.ts', 'utf8')
  assert.match(source, /setAiConfig: \(patch: AiConfigPatch\): Promise<Settings> => ipcRenderer\.invoke\('ai:configure', patch\)/u)
  assert.match(source, /clearAiApiKey: \(\): Promise<Settings> => ipcRenderer\.invoke\('ai:clear-key'\)/u)
  assert.match(source, /listAiModels: \(\): Promise<AiModelListResult> => ipcRenderer\.invoke\('ai:list-models'\)/u)
  assert.match(source, /checkAi: \(\): Promise<AiCheckStatus> => ipcRenderer\.invoke\('ai:check'\)/u)
})

test('主进程与 preload 应暴露受限 Edge 语音合成 IPC', () => {
  const main = readFileSync('src/main/index.ts', 'utf8')
  const preload = readFileSync('src/preload/index.ts', 'utf8')
  assert.match(main, /ipcMain\.handle\('speech:edge-synthesize'/u)
  assert.match(preload, /synthesizeEdgeSpeech:[\s\S]*?\.invoke\(\s*'speech:edge-synthesize'/u)
  assert.match(preload, /synthesizeEdgeSpeech: \(text: string, language: string, requestId\?: string\)/u)
  assert.match(preload, /cancelEdgeSpeech: \(requestId: string\): void => ipcRenderer\.send\('speech:edge-cancel'/u)
  assert.doesNotMatch(preload, /signal\?\.addEventListener/u)
})

test('配置保存成功后广播的设置不应包含 API Key 明文', async () => {
  const { AiConfigurationService } = await import('../src/main/aiConfig.ts')
  const { normalizeSettings } = await import('../src/shared/settingsDefaults.ts')
  let settings = normalizeSettings({ schemaVersion: 9 } as never)
  let apiKey: string | null = null
  const broadcasts: unknown[] = []
  const service = new AiConfigurationService({
    getSettings: () => settings,
    saveSettings: (patch) => { settings = normalizeSettings({ ...settings, ...patch } as never); return settings },
    credentialStore: {
      readApiKey: () => ({ configured: apiKey != null, apiKey }),
      saveApiKey: (v: string): void => { apiKey = v },
      clearApiKey: (): void => { apiKey = null }
    },
    onSettingsChanged: (next) => broadcasts.push(next),
    resetTranslationRuntime: (): void => {}
  })
  service.initialize()
  service.applyPatch({ enabled: true, apiKey: 'sk-broadcast-secret' })
  for (const b of broadcasts) {
    assert.equal(JSON.stringify(b).includes('sk-broadcast-secret'), false)
  }
})
