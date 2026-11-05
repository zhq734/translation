import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, normalizeSettings } from '../src/shared/settingsDefaults.ts'
import { collectShortcutRegistrationStates } from '../src/main/globalShortcutRegistry.ts'

const main = readFileSync('src/main/index.ts', 'utf8')
const selection = readFileSync('src/renderer/src/selection.ts', 'utf8')
const selectionCss = readFileSync('src/renderer/src/selection.css', 'utf8')
const settingsHtml = readFileSync('src/renderer/settings.html', 'utf8')
const settingsSource = readFileSync('src/renderer/src/settings.ts', 'utf8')
const types = readFileSync('src/shared/types.ts', 'utf8')
const zhCatalog = readFileSync('src/shared/i18n/catalog.zh-CN.base.ts', 'utf8')
const enCatalog = readFileSync('src/shared/i18n/catalog.en-US.base.ts', 'utf8')

/**
 * 截取源码中指定函数的函数体文本。
 * @param source 源码文本。
 * @param signature 函数签名前缀。
 * @returns 函数体文本。
 * @author zhenghq
 */
function sliceFunction(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.notStrictEqual(start, -1, `未找到函数 ${signature}`)
  const end = source.indexOf('\n}\n', start)
  assert.notStrictEqual(end, -1, `未找到函数 ${signature} 的结尾`)
  return source.slice(start, end)
}

test('快捷 OCR 翻译应使用默认 Alt+S 并升级设置版本', () => {
  assert.equal(SETTINGS_SCHEMA_VERSION, 28)
  assert.equal(DEFAULT_SETTINGS.ocrQuickHotkey, 'Alt+S')
  assert.equal(DEFAULT_SETTINGS.ocrHotkey, 'Alt+O')
})

test('旧设置应补齐快捷 OCR 快捷键且显式清空应保留', () => {
  const legacy = normalizeSettings({ schemaVersion: 21 } as never)
  const cleared = normalizeSettings({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    ocrQuickHotkey: ''
  })
  const invalid = normalizeSettings({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    ocrQuickHotkey: 42 as never
  })

  assert.equal(legacy.ocrQuickHotkey, 'Alt+S')
  assert.equal(cleared.ocrQuickHotkey, '')
  assert.equal(invalid.ocrQuickHotkey, 'Alt+S')
})

test('快捷 OCR 快捷键应纳入全局注册与重复冲突检测', () => {
  const registered: string[] = []
  const states = collectShortcutRegistrationStates({
    hotkey: 'Alt+T',
    ocrHotkey: 'Alt+O',
    ocrQuickHotkey: 'Alt+S',
    manualTranslationHotkey: 'Alt+M',
    webReaderHotkey: 'Alt+P',
    documentTranslationHotkey: 'Alt+D'
  }, {
    unregisterAll: () => undefined,
    register: (accelerator) => {
      registered.push(accelerator)
      return true
    }
  })

  assert.ok(states.some((state) => state.id === 'ocrQuickHotkey' && state.status === 'registered'))
  assert.ok(registered.includes('Alt+S'))
})

test('快捷 OCR 入口应携带自动翻译标记且高级截图入口保持手动提交', () => {
  assert.match(types, /interface OcrSelectionBeginPayload[\s\S]*?autoTranslate:\s*boolean/u)
  assert.match(main, /function onOcrQuickHotkey\(\): void[\s\S]*?requestOcrSelection\(true\)/u)
  assert.match(main, /function onOcrHotkey\(\): void[\s\S]*?requestOcrSelection\(false\)/u)
  assert.match(main, /'ocr-selection:open'[\s\S]{0,120}?requestOcrSelection\(false\)/u)
  assert.match(main, /menu\.quickScreenshotOcr[\s\S]{0,120}?requestOcrSelection\(true\)/u)
  assert.match(main, /sendToOcrSelectionWindow\(win, 'ocr-selection:begin', \{[\s\S]*?autoTranslate/u)
})

test('快捷 OCR 应仅在一次有效的新框选松开后自动提交', () => {
  const mouseUpSource = sliceFunction(selection, 'function handleOcrMouseUp(')
  const flushSource = sliceFunction(selection, 'function flushPendingQuickOcrSelection(')
  const enterSource = sliceFunction(selection, 'function enterOcrSelectionMode(')
  const loadSource = sliceFunction(selection, 'function handleOcrSnapshotLoad(')
  const applySource = sliceFunction(selection, 'function applyOcrSnapshot(')

  assert.match(enterSource, /quickOcrAutoTranslate\s*=\s*payload\.autoTranslate\s*===\s*true/u)
  assert.match(mouseUpSource, /dragState\.type === 'draw'/u)
  assert.match(mouseUpSource, /dragState\.activated === true/u)
  assert.match(mouseUpSource, /pendingQuickOcrSubmit\s*=\s*true/u)
  assert.match(mouseUpSource, /flushPendingQuickOcrSelection\(\)/u)
  assert.match(flushSource, /quickOcrAutoTranslate/u)
  assert.match(flushSource, /pendingQuickOcrSubmit/u)
  assert.match(flushSource, /ocrSnapshotAvailable/u)
  assert.match(flushSource, /MIN_SELECTION_SIZE/u)
  assert.match(flushSource, /translateCurrentOcrSelection\(\)/u)
  assert.match(loadSource, /flushPendingQuickOcrSelection\(\)/u)
  assert.match(applySource, /ocrSnapshotAvailable = true/u)
  assert.match(applySource, /flushPendingQuickOcrSelection\(\)/u)
  assert.match(
    applySource,
    /flushPendingQuickOcrSelection\(\)[\s\S]*?if \(quickOcrAutoTranslate\) return/u,
    '快捷模式提交后应立即返回，不能继续解码即将被清空的整屏预览'
  )
})

test('快捷 OCR 模式应只保留选框并隐藏截图工作台辅助界面', () => {
  const enterSource = sliceFunction(selection, 'function enterOcrSelectionMode(')
  const leaveSource = sliceFunction(selection, 'function leaveOcrSelectionMode(')
  const resetSource = sliceFunction(selection, 'function resetOcrSessionUi(')

  assert.match(enterSource, /document\.documentElement\.setAttribute\('data-ocr-quick-mode', String\(quickOcrAutoTranslate\)\)/u)
  assert.match(leaveSource, /document\.documentElement\.removeAttribute\('data-ocr-quick-mode'\)/u)
  assert.match(resetSource, /document\.documentElement\.removeAttribute\('data-ocr-quick-mode'\)/u)
  assert.match(
    selectionCss,
    /:root\[data-ocr-quick-mode='true'\]\s+#ocr-tip,[\s\S]*?#ocr-tooltip\s*\{[\s\S]*?display:\s*none/u
  )
})

test('快捷 OCR 模式应禁用选区移动缩放和标注交互', () => {
  const mouseDownSource = sliceFunction(selection, 'function handleOcrMouseDown(')
  const annotationDownSource = sliceFunction(selection, 'function handleAnnotationPointerDown(')
  const toolbarSource = sliceFunction(selection, 'function renderOcrToolbar(')
  const selectionRectSource = sliceFunction(selection, 'function renderSelectionRect(')

  assert.match(
    mouseDownSource,
    /if \(quickOcrAutoTranslate\) \{[\s\S]*?type: 'draw'[\s\S]*?event\.preventDefault\(\)[\s\S]*?return/u
  )
  assert.match(annotationDownSource, /if \(quickOcrAutoTranslate \|\| !ocrMode[\s\S]*?return/u)
  assert.match(toolbarSource, /if \(quickOcrAutoTranslate\)[\s\S]*?ocrToolbar\.hidden = true[\s\S]*?return/u)
  assert.match(selectionRectSource, /ocrSelectionBox\.style\.pointerEvents = quickOcrAutoTranslate \? 'none' : 'auto'/u)
  assert.match(selectionRectSource, /if \(quickOcrAutoTranslate\) return/u)
})

test('快捷 OCR 设置页应提供快捷键录入、清除与注册失败标签', () => {
  assert.match(settingsHtml, /id="ocr-quick-hotkey"[^>]*readonly[^>]*data-hotkey-recorder/u)
  assert.match(settingsHtml, /id="ocr-quick-hotkey-clear"/u)
  assert.match(settingsSource, /ocrQuickHotkey\.addEventListener\('keydown'/u)
  assert.match(settingsSource, /ocr-quick-hotkey-clear/u)
  assert.match(settingsSource, /ocrQuickHotkey:\s*t\('settings\.ocr\.quickHotkey'\)/u)
  assert.match(settingsSource, /ocrQuickHotkey:\s*quickAccelerator/u)
})

test('快捷 OCR 文案应提供中英文词条', () => {
  assert.match(zhCatalog, /'menu\.quickScreenshotOcr':/u)
  assert.match(zhCatalog, /'settings\.ocr\.quickHotkey':/u)
  assert.match(zhCatalog, /'settings\.ocr\.quickHotkeyHint':/u)
  assert.match(enCatalog, /'menu\.quickScreenshotOcr':/u)
  assert.match(enCatalog, /'settings\.ocr\.quickHotkey':/u)
  assert.match(enCatalog, /'settings\.ocr\.quickHotkeyHint':/u)
})
