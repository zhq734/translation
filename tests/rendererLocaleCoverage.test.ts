import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { translatorForTest } from './helpers/i18n.ts'

/** 需要验证动态本地化文案的五个 Renderer 入口源码。 */
const RENDERER_MODULES = [
  'src/renderer/src/popup.ts',
  'src/renderer/src/settings.ts',
  'src/renderer/src/selection.ts',
  'src/renderer/src/toast.ts',
  'src/renderer/src/webReader.ts'
] as const

/**
 * 读取指定 Renderer 模块源码，供契约断言复用。
 * @param file 相对仓库根目录的源码路径。
 * @returns 模块源码文本。
 * @author zhenghq
 */
function readRenderer(file: string): string {
  return readFileSync(file, 'utf8')
}

test('五个 Renderer 的动态用户文案应通过当前语言翻译器生成', () => {
  for (const file of RENDERER_MODULES) {
    const source = readRenderer(file)
    assert.match(source, /startLocaleRuntime\(window\.api\)/u, `${file} 未接入 locale runtime`)
    // 每个入口都至少有一处运行时 t() 调用或主进程已本地化消息的接收链路。
    const hasLocalizedMessage = /\bt\(['"][^'"]+['"]/u.test(source)
      || /onShowScreenshotToast\(/u.test(source)
    assert.ok(hasLocalizedMessage, `${file} 未使用当前语言生成动态文案`)
  }
})

test('代表性动态文案在中英文下均非空且语言不同', () => {
  const keys = [
    'popup.translationFailed',
    'settings.uiLocale.label',
    'selection.recognizing',
    'toast.copiedToClipboard',
    'webReader.loadingPage'
  ] as const
  for (const key of keys) {
    const zh = translatorForTest('zh-CN').t(key)
    const en = translatorForTest('en-US').t(key)
    assert.ok(zh.trim().length > 0, `${key} 缺少中文文案`)
    assert.ok(en.trim().length > 0, `${key} 缺少英文文案`)
    assert.notEqual(zh, en, `${key} 的中英文文案不应完全相同`)
  }
})

test('语言切换处理器应保留各入口的用户状态', () => {
  const settings = readRenderer('src/renderer/src/settings.ts')
  // 设置页：重渲染后恢复表单值与每组滚动位置，且不重建 DOM。
  assert.match(settings, /settingsGroupScrollPositions/u)
  assert.match(settings, /latestSettings/u)
  assert.match(settings, /function handleLocaleChanged\(/u)
  assert.match(settings, /renderSettings\(latestSettings\)/u)

  const popup = readRenderer('src/renderer/src/popup.ts')
  // 翻译弹窗：切换语言时保留译文、草稿与选择状态。
  assert.match(popup, /function handleLocaleChanged\(/u)
  assert.match(popup, /manualState/u)
  assert.match(popup, /lastTranslation/u)
  assert.match(popup, /sourceValue/u)
  assert.match(popup, /targetValue/u)

  const selection = readRenderer('src/renderer/src/selection.ts')
  // 截图选区：切换语言时保留标注与 OCR 面板内容。
  assert.match(selection, /localeRuntime\.onLocaleChanged/u)
  assert.match(selection, /updateAnnotationUi\(\)/u)
  assert.match(selection, /ocrPanelText\.value/u)

  const toast = readRenderer('src/renderer/src/toast.ts')
  // Toast：切换语言时保留当前提示文本。
  assert.match(toast, /localeRuntime\.onLocaleChanged/u)
  assert.match(toast, /toastMessage\.textContent/u)

  const webReader = readRenderer('src/renderer/src/webReader.ts')
  // 网页阅读器：切换语言时恢复源语言/目标语言选择。
  assert.match(webReader, /localeRuntime\.onLocaleChanged/u)
  assert.match(webReader, /sourceValue/u)
  assert.match(webReader, /targetValue/u)
  assert.match(webReader, /populateLanguages\(currentSettings\)/u)
})
