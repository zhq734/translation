import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  collectLocaleCandidates,
  createMainI18nRuntime,
  detectMainLocale
} from '../src/main/i18n.ts'

test('主进程应按显式设置或系统候选解析界面语言', () => {
  assert.equal(
    createMainI18nRuntime({
      getUiLocale: () => 'zh-CN',
      localeSources: { env: { LANG: 'C' } }
    }).locale,
    'zh-CN'
  )
  assert.equal(
    createMainI18nRuntime({
      getUiLocale: () => 'en-US',
      localeSources: { preferredSystemLanguages: ['zh-CN'] }
    }).locale,
    'en-US'
  )
  assert.equal(
    createMainI18nRuntime({
      getUiLocale: () => 'auto',
      localeSources: { env: { LANG: 'zh_CN.UTF-8' } }
    }).locale,
    'zh-CN'
  )
})

test('主进程系统语言候选应按 Electron、环境变量顺序汇总', () => {
  assert.deepEqual(
    collectLocaleCandidates({
      preferredSystemLanguages: ['zh-CN', 'en-US'],
      systemLocale: 'en-GB',
      appLocale: 'zh-TW',
      env: { LANG: 'C', LC_ALL: 'en_US.UTF-8', LC_MESSAGES: 'fr-FR' }
    }),
    ['zh-CN', 'en-US', 'en-GB', 'zh-TW', 'C', 'en_US.UTF-8', 'fr-FR']
  )
  assert.equal(
    detectMainLocale({ preferredSystemLanguages: ['C', 'POSIX', 'fr-FR'] }),
    'en-US'
  )
})

test('主进程运行时刷新设置后应切换翻译器并只通知一次', () => {
  let uiLocale: 'auto' | 'zh-CN' | 'en-US' = 'zh-CN'
  const changed: string[] = []
  const runtime = createMainI18nRuntime({
    getUiLocale: () => uiLocale,
    localeSources: { env: { LANG: 'C' } },
    onLocaleChanged: (locale) => changed.push(`callback:${locale}`)
  })
  const observed: string[] = []
  runtime.onChange((locale) => observed.push(`listener:${locale}`))

  assert.equal(runtime.translator.t('menu.settings'), '设置')
  assert.equal(runtime.refresh(), 'zh-CN')
  assert.deepEqual(changed, [])
  assert.deepEqual(observed, [])

  uiLocale = 'en-US'
  assert.equal(runtime.refresh(), 'en-US')
  assert.equal(runtime.locale, 'en-US')
  assert.equal(runtime.translator.t('menu.settings'), 'Settings')
  assert.deepEqual(changed, ['callback:en-US'])
  assert.deepEqual(observed, ['listener:en-US'])
})

test('主进程设置变化时应通过统一回调刷新菜单和窗口标题', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  assert.match(source, /createMainI18nRuntime/u)
  assert.match(source, /mainI18n\?\.refresh\(\)/u)
  assert.match(source, /refreshLocalizedApplicationChrome/u)
})
