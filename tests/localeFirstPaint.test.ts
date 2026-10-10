import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { startLocaleRuntime, type LocaleRuntime } from '../src/renderer/src/locale.ts'
import type { Api, Settings } from '../src/shared/types.ts'
import { DEFAULT_SETTINGS } from '../src/shared/settingsDefaults.ts'

/** 首屏语言预应用脚本源码。 */
const BOOTSTRAP_SOURCE = readFileSync('src/renderer/public/localeBootstrap.js', 'utf8')

/**
 * 在隔离的 DOM 与 window 环境中执行首屏语言预应用脚本。
 * @param injectedLocale preload 暴露的同步界面语言。
 * @param cachedLocale localStorage 中缓存的界面语言。
 * @returns 脚本执行后写入根节点的语言属性。
 * @author zhenghq
 */
function runLocaleBootstrap(
  injectedLocale: unknown,
  cachedLocale: string | null
): { lang: string; dataLocale: string; pending: boolean } {
  const attributes = new Map<string, string>()
  const documentElement = {
    lang: '',
    setAttribute(name: string, value: string) {
      attributes.set(name, value)
    },
    removeAttribute(name: string) {
      attributes.delete(name)
    }
  }
  runInNewContext(BOOTSTRAP_SOURCE, {
    window: {
      getSelectionTranslatorLocale: () => injectedLocale,
      localStorage: {
        getItem: () => cachedLocale
      },
      setTimeout: () => 0
    },
    document: { documentElement }
  })
  return {
    lang: documentElement.lang,
    dataLocale: attributes.get('data-locale') ?? '',
    pending: attributes.has('data-i18n-pending')
  }
}

/**
 * 创建可手动触发设置广播的 Renderer 本地化测试环境。
 * @param injectedLocale preload 暴露的同步界面语言。
 * @param uiLocale 主进程权威设置中的界面语言。
 * @returns 运行时与语言变化记录。
 * @author zhenghq
 */
function createHarness(injectedLocale: unknown, uiLocale: Settings['uiLocale'] = 'en-US'): {
  runtime: LocaleRuntime
  changes: string[]
} {
  const listeners = new Set<(settings: Settings) => void>()
  const api = {
    getSettings: async () => ({ ...DEFAULT_SETTINGS, uiLocale }),
    onSettingsChanged: (listener: (settings: Settings) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  } as unknown as Pick<Api, 'getSettings' | 'onSettingsChanged'>
  const changes: string[] = []
  const runtime = startLocaleRuntime(api)
  runtime.onLocaleChanged((locale) => changes.push(locale))
  return { runtime, changes }
}

test('首屏 bootstrap 应优先使用 preload 同步注入的语言，避免首次启动先英文后中文', () => {
  const result = runLocaleBootstrap('zh-CN', 'en-US')
  assert.deepEqual(result, { lang: 'zh-CN', dataLocale: 'zh-CN', pending: true })
})

test('首屏 bootstrap 应在同步注入不可用时回退到缓存与英文兜底', () => {
  assert.deepEqual(runLocaleBootstrap(undefined, 'zh-CN'), {
    lang: 'zh-CN',
    dataLocale: 'zh-CN',
    pending: true
  })
  assert.deepEqual(runLocaleBootstrap('fr-FR', 'zh-CN'), {
    lang: 'zh-CN',
    dataLocale: 'zh-CN',
    pending: true
  })
  assert.deepEqual(runLocaleBootstrap('en-US', 'zh-CN'), {
    lang: 'en-US',
    dataLocale: 'en-US',
    pending: true
  })
})

test('首屏 bootstrap 在语言未确认前不得先放行英文兜底', () => {
  assert.deepEqual(runLocaleBootstrap(undefined, null), {
    lang: 'en-US',
    dataLocale: 'en-US',
    pending: true
  })
  const bootstrap = readFileSync('src/renderer/public/localeBootstrap.js', 'utf8')
  const fallbackMs = Number(bootstrap.match(/LOCALE_PENDING_FALLBACK_MS\s*=\s*(\d+)/u)?.[1])
  assert.ok(fallbackMs >= 3000, `兜底释放时间过短（${fallbackMs}ms），冷启动可能先显示英文`)
})

test('preload 应通过同步 IPC 暴露主进程已解析语言', () => {
  const preload = readFileSync('src/preload/index.ts', 'utf8')
  assert.match(preload, /ipcRenderer\.sendSync\('i18n:get-current-locale'\)/u)
  assert.match(preload, /exposeInMainWorld\('getSelectionTranslatorLocale'/u)
})

test('主进程应在创建任何窗口前注册同步语言 IPC，并在运行时未就绪时回退英文', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  assert.match(source, /ipcMain\.on\('i18n:get-current-locale'/u)
  assert.match(source, /event\.returnValue\s*=\s*mainI18n\?\.locale\s*\?\?\s*'en-US'/u)
  const runtimeIndex = source.indexOf('mainI18n = createMainI18nRuntime(')
  const ipcIndex = source.indexOf('\n  registerLocaleIpc()')
  const popupIndex = source.indexOf('createPopup(PRELOAD_PATH,')
  assert.ok(runtimeIndex >= 0 && ipcIndex > runtimeIndex && popupIndex > ipcIndex,
    '同步语言 IPC 必须在运行时创建后、窗口创建前注册')
})

test('Renderer locale runtime 应优先采用 preload 同步注入语言', async () => {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const documentElement = {
    lang: 'en',
    attributes: new Map<string, string>(),
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value)
    },
    removeAttribute(name: string) {
      this.attributes.delete(name)
    }
  }
  const window = {
    getSelectionTranslatorLocale: () => 'zh-CN',
    localStorage: {
      getItem: () => null,
      setItem: () => undefined
    },
    navigator: { language: 'en-US', languages: ['en-US'] }
  }
  const document = {
    documentElement,
    querySelectorAll: () => [],
    dispatchEvent: () => true
  }
  Object.assign(globalThis, { window, document })
  // 模拟首屏 bootstrap 已按缓存语言预应用并设置隐藏标记。
  documentElement.setAttribute('data-i18n-pending', 'true')

  try {
    const { runtime } = createHarness('zh-CN')
    assert.equal(runtime.locale, 'zh-CN')
    assert.equal(documentElement.lang, 'zh-CN')
    // 主进程设置确认前保留隐藏标记，避免先显示英文兜底。
    assert.equal(documentElement.attributes.has('data-i18n-pending'), true)
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(documentElement.attributes.has('data-i18n-pending'), false)
  } finally {
    Object.assign(globalThis, { window: previousWindow, document: previousDocument })
  }
})

test('同步注入仍是英文兜底时应等主进程权威设置确认后再显示中文首屏', async () => {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const documentElement = {
    lang: 'en',
    attributes: new Map<string, string>(),
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value)
    },
    removeAttribute(name: string) {
      this.attributes.delete(name)
    }
  }
  const window = {
    // 模拟主进程 i18n 运行时尚未就绪时同步 IPC 返回的英文兜底值。
    getSelectionTranslatorLocale: () => 'en-US',
    localStorage: {
      getItem: () => null,
      setItem: () => undefined
    },
    navigator: { language: 'en-US', languages: ['en-US'] }
  }
  const document = {
    documentElement,
    querySelectorAll: () => [],
    dispatchEvent: () => true
  }
  Object.assign(globalThis, { window, document })
  documentElement.setAttribute('data-i18n-pending', 'true')

  try {
    const { runtime } = createHarness('en-US', 'zh-CN')
    // 权威设置返回前必须保持隐藏，不能先把英文兜底显示出来。
    assert.equal(documentElement.attributes.has('data-i18n-pending'), true)
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(runtime.locale, 'zh-CN')
    assert.equal(documentElement.lang, 'zh-CN')
    assert.equal(documentElement.attributes.has('data-i18n-pending'), false)
  } finally {
    Object.assign(globalThis, { window: previousWindow, document: previousDocument })
  }
})
