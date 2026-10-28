import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, normalizeSettings } from '../src/shared/settingsDefaults.ts'
import {
  collectShortcutRegistrationStates,
  findShortcutConflict
} from '../src/main/globalShortcutRegistry.ts'

test('设置默认值应包含手动翻译、网页阅读器与文档翻译快捷键', () => {
  assert.equal(SETTINGS_SCHEMA_VERSION, 20)
  assert.equal(DEFAULT_SETTINGS.manualTranslationHotkey, 'Alt+M')
  assert.equal(DEFAULT_SETTINGS.webReaderHotkey, 'Alt+P')
  assert.equal(DEFAULT_SETTINGS.documentTranslationHotkey, 'Alt+D')
})

test('旧配置升级应补齐新快捷键并保留已有快捷键', () => {
  const migrated = normalizeSettings({
    schemaVersion: 20,
    hotkey: 'Alt+Q',
    ocrHotkey: 'Alt+W'
  })

  assert.equal(migrated.manualTranslationHotkey, 'Alt+M')
  assert.equal(migrated.webReaderHotkey, 'Alt+P')
  assert.equal(migrated.documentTranslationHotkey, 'Alt+D')
  assert.equal(migrated.hotkey, 'Alt+Q')
  assert.equal(migrated.ocrHotkey, 'Alt+W')
})

test('用户清空的新快捷键必须保留为空而不是回填默认值', () => {
  const normalized = normalizeSettings({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    manualTranslationHotkey: '',
    webReaderHotkey: '',
    documentTranslationHotkey: ''
  })

  assert.equal(normalized.manualTranslationHotkey, '')
  assert.equal(normalized.webReaderHotkey, '')
  assert.equal(normalized.documentTranslationHotkey, '')
})

test('非法的新快捷键值应回退到默认值', () => {
  const normalized = normalizeSettings({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    manualTranslationHotkey: 42 as unknown as string,
    webReaderHotkey: null as unknown as string,
    documentTranslationHotkey: {} as unknown as string
  })

  assert.equal(normalized.manualTranslationHotkey, 'Alt+M')
  assert.equal(normalized.webReaderHotkey, 'Alt+P')
  assert.equal(normalized.documentTranslationHotkey, 'Alt+D')
})

test('快捷键冲突校验应拒绝系统复制、重复绑定，并忽略空值', () => {
  const base = {
    hotkey: 'Alt+T',
    ocrHotkey: 'Alt+O',
    manualTranslationHotkey: 'Alt+M',
    webReaderHotkey: 'Alt+P',
    documentTranslationHotkey: 'Alt+D'
  }

  assert.deepEqual(findShortcutConflict('manualTranslationHotkey', 'Ctrl+C', base), {
    kind: 'copy'
  })
  assert.deepEqual(findShortcutConflict('webReaderHotkey', 'Alt+T', base), {
    kind: 'duplicate',
    owner: 'hotkey'
  })
  assert.deepEqual(findShortcutConflict('manualTranslationHotkey', 'Alt+P', base), {
    kind: 'duplicate',
    owner: 'webReaderHotkey'
  })
  assert.deepEqual(findShortcutConflict('documentTranslationHotkey', 'Ctrl+C', base), {
    kind: 'copy'
  })
  assert.deepEqual(findShortcutConflict('documentTranslationHotkey', 'Alt+M', base), {
    kind: 'duplicate',
    owner: 'manualTranslationHotkey'
  })
  assert.equal(findShortcutConflict('webReaderHotkey', '', base), null)
  assert.equal(findShortcutConflict('manualTranslationHotkey', 'Alt+M', {
    ...base,
    manualTranslationHotkey: ''
  }), null)
})

test('快捷键注册应汇总成功、占用、非法、空值和部分失败状态', () => {
  const registered: string[] = []
  const states = collectShortcutRegistrationStates({
    hotkey: 'Alt+T',
    ocrHotkey: 'Alt+O',
    manualTranslationHotkey: 'Alt+M',
    webReaderHotkey: '',
    documentTranslationHotkey: 'Alt+D',
    // 非法组合用于验证结构化的 invalid 状态，而不是抛出异常。
    preferredTranslationProvider: 'auto'
  } as never, {
    register: (accelerator) => {
      if (accelerator === 'Alt+M') return false
      registered.push(accelerator)
      return true
    },
    unregisterAll: () => undefined
  })

  assert.deepEqual(states.map((state) => [state.id, state.status]), [
    ['hotkey', 'registered'],
    ['ocrHotkey', 'registered'],
    ['manualTranslationHotkey', 'occupied'],
    ['webReaderHotkey', 'skipped'],
    ['documentTranslationHotkey', 'registered']
  ])
  assert.deepEqual(registered, ['Alt+T', 'Alt+O', 'Alt+D'])
})

test('快捷键修改时应先注销旧注册再注册全部非空快捷键', () => {
  const calls: string[] = []
  collectShortcutRegistrationStates({
    hotkey: 'Alt+T',
    ocrHotkey: '',
    manualTranslationHotkey: 'Alt+M',
    webReaderHotkey: 'Alt+P',
    documentTranslationHotkey: 'Alt+D'
  } as never, {
    unregisterAll: () => calls.push('unregisterAll'),
    register: (accelerator) => {
      calls.push(`register:${accelerator}`)
      return true
    }
  })

  assert.deepEqual(calls, [
    'unregisterAll',
    'register:Alt+T',
    'register:Alt+M',
    'register:Alt+P',
    'register:Alt+D'
  ])
})

test('设置页应提供手动翻译、网页阅读器与文档翻译快捷键录入和清除入口', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const source = readFileSync('src/renderer/src/settings.ts', 'utf8')

  assert.match(html, /id="manual-translation-hotkey"[^>]*readonly[^>]*data-hotkey-recorder/u)
  assert.match(html, /id="web-reader-hotkey"[^>]*readonly[^>]*data-hotkey-recorder/u)
  assert.match(html, /id="manual-translation-hotkey-clear"/u)
  assert.match(html, /id="web-reader-hotkey-clear"/u)
  assert.match(html, /id="document-translation-hotkey"[^>]*readonly[^>]*data-hotkey-recorder/u)
  assert.match(html, /id="document-translation-hotkey-clear"/u)
  assert.match(source, /manualTranslationHotkey\.addEventListener\('keydown'/u)
  assert.match(source, /webReaderHotkey\.addEventListener\('keydown'/u)
  assert.match(source, /documentTranslationHotkey\.addEventListener\('keydown'/u)
  assert.match(source, /manual-translation-hotkey-clear/u)
  assert.match(source, /web-reader-hotkey-clear/u)
  assert.match(source, /document-translation-hotkey-clear/u)
})
