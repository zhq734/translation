import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyStaticTranslations,
  startLocaleRuntime,
  type LocaleRuntime
} from '../src/renderer/src/locale.ts'
import type { Api, Settings } from '../src/shared/types.ts'
import { DEFAULT_SETTINGS } from '../src/shared/settingsDefaults.ts'

type SettingsListener = (settings: Settings) => void

/**
 * 创建可手动触发设置广播的 Renderer 本地化测试环境。
 * @returns 运行时、语言变化记录和广播辅助函数。
 * @author zhenghq
 */
function createHarness(): {
  runtime: LocaleRuntime
  changes: string[]
  emitSettings(settings: Pick<Settings, 'uiLocale'>): void
} {
  const listeners = new Set<SettingsListener>()
  let settings: Settings = { ...DEFAULT_SETTINGS, uiLocale: 'en-US' }
  const api = {
    getSettings: async () => settings,
    onSettingsChanged: (listener: SettingsListener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  } as unknown as Pick<Api, 'getSettings' | 'onSettingsChanged'>
  const changes: string[] = []
  const runtime = startLocaleRuntime(api)
  runtime.onLocaleChanged((locale) => changes.push(locale))
  return {
    runtime,
    changes,
    emitSettings(nextSettings) {
      settings = { ...settings, ...nextSettings }
      for (const listener of listeners) listener(settings)
    }
  }
}

test('Renderer locale runtime 应读取缓存并在主进程设置到达后校正语言', async () => {
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
  const dispatched: string[] = []
  const document = {
    documentElement,
    querySelectorAll: () => [],
    dispatchEvent: (event: Event) => {
      dispatched.push((event as CustomEvent<string>).detail)
      return true
    }
  }
  const storage = new Map<string, string>([['selection-translator.locale', 'zh-CN']])
  const window = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value)
    },
    navigator: { language: 'zh-CN', languages: ['zh-CN'] }
  }
  Object.assign(globalThis, { window, document })

  try {
    const { runtime, changes, emitSettings } = createHarness()
    assert.equal(runtime.locale, 'zh-CN')
    assert.equal(documentElement.lang, 'zh-CN')
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(runtime.locale, 'en-US')
    assert.equal(documentElement.lang, 'en-US')
    assert.deepEqual(changes, ['en-US'])
    assert.deepEqual(dispatched, ['en-US'])

    emitSettings({ uiLocale: 'zh-CN' })
    assert.equal(runtime.locale, 'zh-CN')
    assert.equal(documentElement.lang, 'zh-CN')
    assert.deepEqual(changes, ['en-US', 'zh-CN'])
  } finally {
    Object.assign(globalThis, { window: previousWindow, document: previousDocument })
  }
})

test('applyStaticTranslations 应翻译文本和声明的关键属性', () => {
  const textElement = { dataset: { i18n: 'menu.settings' }, textContent: '' }
  const attributeElement = {
    dataset: { i18nAttr: 'title:menu.settings;aria-label:menu.settings' },
    setAttribute(name: string, value: string) {
      attributes[name] = value
    }
  }
  const attributes: Record<string, string> = {}
  const root = {
    querySelectorAll(selector: string) {
      return selector === '[data-i18n]' ? [textElement] : [attributeElement]
    }
  }
  applyStaticTranslations(root as unknown as ParentNode, {
    locale: 'en-US',
    t: (key: string) => key,
    plural: (key: string) => key,
    has: () => true
  })
  assert.equal(textElement.textContent, 'menu.settings')
  assert.deepEqual(attributes, {
    title: 'menu.settings',
    'aria-label': 'menu.settings'
  })
})
