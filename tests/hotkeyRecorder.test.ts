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

  assert.equal(resolveHotkeyCaptureDelay('win32'), 120)
  assert.equal(resolveHotkeyCaptureDelay('darwin'), 0)
  assert.equal(resolveHotkeyCaptureDelay('linux'), 0)
  assert.match(source, /resolveHotkeyCaptureDelay\(process\.platform\)/u)
  assert.match(source, /setTimeout\(queueSelectionTranslation,\s*captureDelay\)/u)
  assert.match(
    source,
    /patch\.hotkey\s*!==\s*undefined[\s\S]*?\|\|[\s\S]*?patch\.ocrHotkey\s*!==\s*undefined/u
  )
  assert.match(source, /registerGlobalShortcuts\(settings\)/u)
})
