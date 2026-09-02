import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { formatKeyboardAccelerator } from '../src/shared/keyboardAccelerator'
import { resolveHotkeyCaptureDelay } from '../src/shared/hotkeyCaptureTiming'

test('快捷键录入应把键盘组合转换为 Electron Accelerator', () => {
  assert.equal(
    formatKeyboardAccelerator({
      key: 't',
      code: 'KeyT',
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
      metaKey: false,
      repeat: false
    }, 'Linux'),
    'Control+Alt+T'
  )
  assert.equal(
    formatKeyboardAccelerator({
      key: 'ArrowUp',
      code: 'ArrowUp',
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      metaKey: true,
      repeat: false
    }, 'MacIntel'),
    'Shift+Command+Up'
  )
})

test('快捷键录入应忽略仅修饰键、重复按键和不支持的按键', () => {
  const base = {
    code: 'ControlLeft',
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    repeat: false
  }

  assert.equal(formatKeyboardAccelerator({ ...base, key: 'Control' }, 'Linux'), null)
  assert.equal(formatKeyboardAccelerator({ ...base, key: 'Process' }, 'Linux'), null)
  assert.equal(formatKeyboardAccelerator({ ...base, key: 't', repeat: true }, 'Linux'), null)
})

test('设置页应通过按键直接录入翻译与 OCR 快捷键', () => {
  const html = readFileSync('src/renderer/settings.html', 'utf8')
  const source = readFileSync('src/renderer/src/settings.ts', 'utf8')

  assert.match(html, /id="hotkey"[^>]*readonly[^>]*data-hotkey-recorder/u)
  assert.match(html, /id="ocr-hotkey"[^>]*readonly[^>]*data-hotkey-recorder/u)
  assert.match(source, /hotkey\.addEventListener\('keydown',\s*handleTranslationHotkeyKeydown\)/u)
  assert.match(source, /ocrHotkey\.addEventListener\('keydown',\s*handleOcrHotkeyKeydown\)/u)
  assert.match(source, /formatKeyboardAccelerator/u)
})

test('Windows 快捷键触发后应等待修饰键释放再取词，快捷键变更应整体重绑', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')

  assert.equal(resolveHotkeyCaptureDelay('win32'), 300)
  assert.equal(resolveHotkeyCaptureDelay('darwin'), 0)
  assert.equal(resolveHotkeyCaptureDelay('linux'), 0)
  assert.match(source, /resolveHotkeyCaptureDelay\(process\.platform\)/u)
  assert.match(
    source,
    /setTimeout\([\s\S]*?queueSelectionTranslation\([^)]*true[^)]*\),\s*captureDelay/u
  )
  assert.match(
    source,
    /patch\.hotkey\s*!==\s*undefined[\s\S]*?\|\|[\s\S]*?patch\.ocrHotkey\s*!==\s*undefined/u
  )
  assert.match(source, /registerGlobalShortcuts\(settings\)/u)
})

/**
 * 校验 Windows 翻译快捷键直接走复制取词，避免 UI Automation 直读阻塞或让选区失效。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 翻译快捷键应使用直接复制取词而不是原生直读优先取词', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const hotkeyStart = source.indexOf('function onHotkey')
  const hotkeyEnd = source.indexOf('/**\n * 响应全局 OCR 快捷键', hotkeyStart)
  const hotkeySource = source.slice(hotkeyStart, hotkeyEnd)
  const queueStart = source.indexOf('function queueSelectionTranslation')
  const queueEnd = source.indexOf('/**\n * 响应“译”按钮点击', queueStart)
  const queueSource = source.slice(queueStart, queueEnd)

  assert.ok(hotkeyStart >= 0)
  assert.ok(hotkeyEnd > hotkeyStart)
  assert.ok(queueStart >= 0)
  assert.ok(queueEnd > queueStart)
  assert.match(hotkeySource, /queueSelectionTranslation\([^)]*true[^)]*\)/u)
  assert.match(queueSource, /directCapture[\s\S]*?selectionCapture\.captureDirect\(anchor\)/u)
  assert.match(queueSource, /selectionCapture\.capture\(anchor\)/u)
})

/**
 * 校验翻译快捷键会先非激活显示读取状态，再等待修饰键释放并开始系统取词。
 * @returns 无返回值。
 * @author zhenghq
 */
test('翻译快捷键应先显示读取中的弹窗再异步取词', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const hotkeyStart = source.indexOf('function onHotkey')
  const hotkeyEnd = source.indexOf('/**\n * 响应全局 OCR 快捷键', hotkeyStart)
  const hotkeySource = source.slice(hotkeyStart, hotkeyEnd)
  const popupStart = source.indexOf('function showSelectionReadingPopup')
  const popupEnd = source.indexOf('/**\n * 捕获当前选中文字', popupStart)
  const popupSource = source.slice(popupStart, popupEnd)

  assert.ok(hotkeyStart >= 0)
  assert.ok(hotkeyEnd > hotkeyStart)
  assert.ok(popupStart >= 0)
  assert.ok(popupEnd > popupStart)
  const showReadingIndex = hotkeySource.indexOf('showSelectionReadingPopup(')
  const delayedCaptureIndex = hotkeySource.indexOf('setTimeout(')
  assert.ok(showReadingIndex >= 0, '快捷键触发后应立即显示读取状态')
  assert.ok(delayedCaptureIndex > showReadingIndex, '读取弹窗必须先于延迟取词显示')
  assert.match(popupSource, /loading:\s*true/u)
  assert.match(popupSource, /loadingMessage:\s*'正在读取选中文字…'/u)
  assert.match(popupSource, /showPopup\([\s\S]*?anchor,\s*false\s*\)/u)
  assert.match(hotkeySource, /queueSelectionTranslation\([^)]*popupCloseVersion/u)
})
