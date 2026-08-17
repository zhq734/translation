import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  createObservedPointerSample,
  decideSelectionAction,
  getSelectionGesture,
  isSelectAllShortcut,
  resolveLanguagePair,
  shouldTriggerSelectionGesture
} from '../src/shared/selectionBehavior.ts'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'
import { buildProxyConfig } from '../src/shared/proxySettings.ts'
import { SelectionCaptureCoordinator } from '../src/shared/selectionCaptureCoordinator.ts'
import { shouldDismissPopupOnBlur } from '../src/shared/popupBehavior.ts'
import {
  CopyShortcutGuard,
  hasClipboardCaptureCompleted,
  isCopyShortcut,
  shouldRestoreClipboard
} from '../src/shared/copyShortcutBehavior.ts'

test('全局鼠标事件应使用本机观测时间，避免 macOS 原生时间单位导致划词被过滤', () => {
  assert.deepEqual(
    createObservedPointerSample({ x: 120, y: 260, time: 300_000_000 }, 1000),
    { x: 120, y: 260, time: 1000 }
  )
})

test('划词结束后应使用拖拽区域右上角作为“译”按钮锚点', () => {
  const gesture = getSelectionGesture(
    { x: 120, y: 260, time: 1000 },
    { x: 360, y: 220, time: 1300 }
  )

  assert.deepEqual(gesture.anchor, { x: 360, y: 220 })
  assert.equal(Math.round(gesture.distance), 243)
  assert.equal(gesture.durationMs, 300)
})

test('双击选中文字时即使鼠标没有明显移动也应触发选区处理', () => {
  const gesture = getSelectionGesture(
    { x: 180, y: 220, time: 1000 },
    { x: 181, y: 220, time: 1010 }
  )

  assert.equal(shouldTriggerSelectionGesture(gesture, 2, {
    minDragDistance: 4,
    minHoldMs: 20,
    maxHoldMs: 10000
  }), true)
})

test('普通单击不应触发选区处理，常规划词拖拽仍应触发', () => {
  const click = getSelectionGesture(
    { x: 180, y: 220, time: 1000 },
    { x: 181, y: 220, time: 1010 }
  )
  const drag = getSelectionGesture(
    { x: 180, y: 220, time: 1000 },
    { x: 260, y: 220, time: 1100 }
  )
  const options = { minDragDistance: 4, minHoldMs: 20, maxHoldMs: 10000 }

  assert.equal(shouldTriggerSelectionGesture(click, 1, options), false)
  assert.equal(shouldTriggerSelectionGesture(drag, 1, options), true)
})


/**
 * 校验 Windows/Linux 的 Ctrl+A 与 macOS 的 Command+A 都会被识别为全选快捷键。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Ctrl+A 和 Command+A 应被识别为全选翻译触发', () => {
  const selectAllKeycode = 30
  const baseEvent = {
    keycode: selectAllKeycode,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false
  }

  assert.equal(isSelectAllShortcut({ ...baseEvent, ctrlKey: true }, selectAllKeycode), true)
  assert.equal(isSelectAllShortcut({ ...baseEvent, metaKey: true }, selectAllKeycode), true)
})

/**
 * 校验带其他修饰键、无主修饰键或按下其他按键时不会误触发全选翻译。
 * @returns 无返回值。
 * @author zhenghq
 */
test('非标准全选组合不应触发翻译', () => {
  const selectAllKeycode = 30
  const baseEvent = {
    keycode: selectAllKeycode,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false
  }

  assert.equal(isSelectAllShortcut({ ...baseEvent, altKey: true }, selectAllKeycode), false)
  assert.equal(isSelectAllShortcut({ ...baseEvent, shiftKey: true }, selectAllKeycode), false)
  assert.equal(isSelectAllShortcut({ ...baseEvent, ctrlKey: false }, selectAllKeycode), false)
  assert.equal(isSelectAllShortcut({ ...baseEvent, keycode: 31 }, selectAllKeycode), false)
})

test('系统复制组合不能被识别为翻译快捷键', () => {
  for (const shortcut of [
    'Ctrl+C',
    'Control+C',
    'Cmd+C',
    'Command+C',
    'CommandOrControl+C',
    'CmdOrCtrl+C'
  ]) {
    assert.equal(isCopyShortcut(shortcut), true, shortcut)
  }
  assert.equal(isCopyShortcut('Ctrl+Shift+C'), false)
  assert.equal(isCopyShortcut('Alt+C'), false)
  assert.equal(isCopyShortcut('Alt+T'), false)
})

test('内部模拟复制事件不应误判为用户复制，用户复制应阻止覆盖新剪贴板', async () => {
  const guard = new CopyShortcutGuard()
  const version = guard.getExternalCopyVersion()
  const expectation = guard.expectSyntheticCopyShortcut()

  guard.observeCopyShortcut()
  await expectation.finish()
  assert.equal(guard.hasExternalCopySince(version), false)

  guard.observeCopyShortcut()
  assert.equal(guard.hasExternalCopySince(version), true)
  assert.equal(shouldRestoreClipboard(true, '用户刚复制的文字', '__sentinel__'), false)
  assert.equal(shouldRestoreClipboard(true, '__sentinel__', '__sentinel__'), true)
  assert.equal(shouldRestoreClipboard(false, '内部取词结果', '__sentinel__'), true)
})

test('内部模拟复制事件延迟到达时结束观测应等待该事件', async () => {
  const guard = new CopyShortcutGuard()
  const version = guard.getExternalCopyVersion()
  const expectation = guard.expectSyntheticCopyShortcut()

  const finishing = expectation.finish()
  setTimeout(() => guard.observeCopyShortcut(), 10)
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  await finishing

  assert.equal(guard.hasExternalCopySince(version), false)
})

test('内部模拟复制之后紧邻的第二次复制必须识别为用户复制', async () => {
  const guard = new CopyShortcutGuard()
  const version = guard.getExternalCopyVersion()
  const expectation = guard.expectSyntheticCopyShortcut()

  const finishing = expectation.finish()
  setTimeout(() => {
    guard.observeCopyShortcut()
    guard.observeCopyShortcut()
  }, 10)
  await finishing

  assert.equal(guard.getExternalCopyVersion(), version + 1)
})

test('剪贴板已变为非内部捕获文本时不得恢复旧内容', () => {
  const sentinel = '__sentinel__'

  assert.equal(
    shouldRestoreClipboard(false, '用户刚复制的新内容', sentinel, false, '内部捕获文本'),
    false
  )
  assert.equal(
    shouldRestoreClipboard(false, '内部捕获文本', sentinel, false, '内部捕获文本'),
    true
  )
})

test('图片写入剪贴板后应视为复制完成且不得恢复上一张图片', () => {
  const sentinel = '__sentinel__'

  assert.equal(hasClipboardCaptureCompleted(sentinel, false, sentinel), false)
  assert.equal(hasClipboardCaptureCompleted('', true, sentinel), true)
  assert.equal(hasClipboardCaptureCompleted(sentinel, true, sentinel), true)
  assert.equal(shouldRestoreClipboard(true, sentinel, sentinel, true), false)
  assert.equal(shouldRestoreClipboard(true, '', sentinel, false), true)
})

test('按钮模式下弹窗未打开时划词应显示“译”按钮', () => {
  assert.equal(decideSelectionAction(false, 'button'), 'show-button')
})

test('按钮模式下即使弹窗保持打开，再次划词也必须显示“译”按钮', () => {
  assert.equal(decideSelectionAction(true, 'button'), 'show-button')
})

test('自动模式下即使弹窗关闭也应直接翻译', () => {
  assert.equal(decideSelectionAction(false, 'auto'), 'translate')
})

test('快捷键模式下划词不应自动打开弹窗或显示“译”按钮', () => {
  assert.equal(decideSelectionAction(false, 'hotkey'), 'ignore')
  assert.equal(decideSelectionAction(true, 'hotkey'), 'ignore')
})

test('选区按钮应在划词阶段预取文字，并在点击时直接消费缓存', async () => {
  let captureCount = 0
  const coordinator = new SelectionCaptureCoordinator(async () => {
    captureCount += 1
    return '  cached selection  '
  })
  const anchor = { x: 320, y: 180 }

  const prepared = await coordinator.prepare(anchor)
  const clicked = coordinator.consumePrepared()

  assert.deepEqual(prepared, { text: 'cached selection', anchor })
  assert.deepEqual(clicked, { text: 'cached selection', anchor })
  assert.equal(captureCount, 1)
  assert.equal(coordinator.consumePrepared(), null)
})

test('新的划词准备开始后应使旧的选中文字缓存失效', async () => {
  const coordinator = new SelectionCaptureCoordinator(async () => 'first selection')

  await coordinator.prepare({ x: 100, y: 100 })
  coordinator.invalidate()

  assert.equal(coordinator.consumePrepared(), null)
})

test('粘贴或外部点击使选区失效时应中止正在进行的剪贴板取词', async () => {
  let activeSignal: AbortSignal | undefined
  let notifyStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve
  })
  const coordinator = new SelectionCaptureCoordinator(async (signal) => {
    activeSignal = signal
    notifyStarted?.()
    await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), {
      once: true
    }))
    return '已经失效的选区'
  })

  const pending = coordinator.prepare({ x: 100, y: 100 })
  await started
  coordinator.invalidate()

  assert.equal(activeSignal?.aborted, true)
  assert.equal(await pending, null)
  assert.equal(coordinator.consumePrepared(), null)
})

test('预取结果为空时不应保留可供“译”按钮消费的选区', async () => {
  const coordinator = new SelectionCaptureCoordinator(async () => '   ')

  const prepared = await coordinator.prepare({ x: 100, y: 100 })

  assert.deepEqual(prepared, { text: '', anchor: { x: 100, y: 100 } })
  assert.equal(coordinator.consumePrepared(), null)
})

test('主进程应只为有效文字显示按钮，并在外部按下鼠标时隐藏旧按钮', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')

  assert.match(source, /if\s*\(!result\.text\s*\|\|\s*result\.error\)\s*\{[\s\S]*?hideSelectionButton\(\)/u)
  assert.match(
    source,
    /startAutoTrigger\(\s*handleSelectionGesture,\s*handleSelectionPointerDown,\s*handlePasteShortcut,\s*handleSelectAllShortcut\s*\)/u
  )
})

test('全局监听应传递双击次数，并监听用户复制和粘贴快捷键', () => {
  const source = readFileSync('src/main/autoTrigger.ts', 'utf8')

  assert.match(source, /shouldTriggerSelectionGesture\(gesture,\s*e\.clicks/u)
  assert.match(source, /uIOhook\.on\('keydown',\s*onKeyDown\)/u)
  assert.match(source, /copyShortcutGuard\.observeCopyShortcut\(\)/u)
  assert.match(source, /e\.keycode\s*===\s*UiohookKey\.V/u)
  assert.match(source, /pasteShortcutCallback\?\.\(\)/u)
  assert.match(source, /isSelectAllShortcut\(e,\s*UiohookKey\.A\)/u)
  assert.match(source, /selectAllShortcutCallback\?\.\(\)/u)
})

test('主进程不得注册系统复制快捷键，选区按钮也不得抢占输入焦点', () => {
  const mainSource = readFileSync('src/main/index.ts', 'utf8')
  const buttonSource = readFileSync('src/main/selectionButton.ts', 'utf8')

  assert.match(mainSource, /if\s*\(isCopyShortcut\(accelerator\)\)\s*\{/u)
  assert.match(buttonSource, /focusable:\s*false/u)
  assert.match(buttonSource, /win\.showInactive\(\)/u)
})

test('内部取词应同时等待文字或图片写入，并避免恢复旧图片', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')

  assert.match(source, /copyShortcutGuard\.hasExternalCopySince/u)
  assert.match(source, /hasClipboardCaptureCompleted/u)
  assert.match(source, /clipboard\.readImage\(\)/u)
  assert.match(source, /await expectation\.finish\(\)/u)
  assert.match(source, /await sleep\(CLIPBOARD_STABILITY_DELAY_MS\)/u)
  assert.match(source, /shouldRestoreClipboard\([^)]*currentHasImage,\s*text/su)
  assert.match(source, /signal\?\.addEventListener\('abort'/u)
  assert.match(source, /if\s*\(signal\?\.aborted\)/u)
})

test('用户粘贴时主进程应立即取消待处理或正在进行的选区捕获', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')

  assert.match(
    source,
    /startAutoTrigger\(\s*handleSelectionGesture,\s*handleSelectionPointerDown,\s*handlePasteShortcut,\s*handleSelectAllShortcut\s*\)/u
  )
  assert.match(
    source,
    /function handlePasteShortcut\(\): void \{[\s\S]*?selectionCapture\.invalidate\(\)/u
  )
})

test('未钉住时点击弹窗外部应关闭，钉住后不应关闭', () => {
  assert.equal(shouldDismissPopupOnBlur(false), true)
  assert.equal(shouldDismissPopupOnBlur(true), false)
})

test('翻译弹窗应包含可见的图钉按钮图标', () => {
  const popupHtml = readFileSync('src/renderer/index.html', 'utf8')
  assert.match(
    popupHtml,
    /<button[^>]+id="pin"[^>]*>[\s\S]*<svg[^>]+class="pin-icon"/u
  )
})

test('自动中英适配应把中文翻译为英文', () => {
  assert.deepEqual(resolveLanguagePair('这是一段中文内容', 'auto', 'auto'), {
    sourceLang: 'auto',
    targetLang: 'EN'
  })
})

test('自动中英适配应把英文翻译为中文', () => {
  assert.deepEqual(resolveLanguagePair('This is an English sentence.', 'auto', 'auto'), {
    sourceLang: 'auto',
    targetLang: 'ZH'
  })
})

test('手动语言设置应优先于自动中英适配', () => {
  assert.deepEqual(resolveLanguagePair('Bonjour le monde', 'FR', 'DE'), {
    sourceLang: 'FR',
    targetLang: 'DE'
  })
})

test('目标语言自动时应根据手动源语言选择中英文目标', () => {
  assert.deepEqual(resolveLanguagePair('任意内容', 'ZH', 'auto'), {
    sourceLang: 'ZH',
    targetLang: 'EN'
  })
  assert.deepEqual(resolveLanguagePair('任意内容', 'EN', 'auto'), {
    sourceLang: 'EN',
    targetLang: 'ZH'
  })
})

test('旧版设置升级后应默认启用选词按钮、自动中英互译、系统代理和常驻弹窗', () => {
  const settings = normalizeSettings({
    targetLang: 'ZH',
    sourceLang: 'auto',
    hotkey: 'Alt+T',
    autoHideMs: 8000,
    deepLxUrl: '',
    autoTrigger: true
  })

  assert.equal(settings.schemaVersion, 6)
  assert.equal(settings.targetLang, 'auto')
  assert.equal(settings.autoHideMs, 0)
  assert.equal(settings.triggerMode, 'button')
  assert.equal(settings.proxyMode, 'system')
})

test('第二版触发设置升级后应统一回到按钮模式', () => {
  const automatic = normalizeSettings({
    schemaVersion: 2,
    targetLang: 'DE',
    sourceLang: 'FR',
    hotkey: 'Alt+Y',
    autoHideMs: 5000,
    deepLxUrl: 'http://127.0.0.1:1189/translate',
    autoTrigger: true
  })
  const button = normalizeSettings({
    schemaVersion: 2,
    autoTrigger: false
  })

  assert.equal(automatic.triggerMode, 'button')
  assert.equal(button.triggerMode, 'button')
  assert.equal(automatic.targetLang, 'DE')
  assert.equal(automatic.autoHideMs, 5000)
})

test('第三版自动模式配置升级后应回到按钮模式', () => {
  const settings = normalizeSettings({
    schemaVersion: 3,
    triggerMode: 'auto'
  })

  assert.equal(settings.schemaVersion, 6)
  assert.equal(settings.triggerMode, 'button')
})

test('第四版设置中的语言、触发方式、自动隐藏和代理偏好应被保留', () => {
  const settings = normalizeSettings({
    schemaVersion: 4,
    targetLang: 'DE',
    sourceLang: 'FR',
    hotkey: 'Alt+Y',
    autoHideMs: 5000,
    deepLxUrl: 'http://127.0.0.1:1189/translate',
    triggerMode: 'hotkey',
    proxyMode: 'custom',
    proxyRules: 'http://127.0.0.1:7890',
    proxyBypassRules: '<local>;localhost'
  })

  assert.equal(settings.targetLang, 'DE')
  assert.equal(settings.sourceLang, 'FR')
  assert.equal(settings.autoHideMs, 5000)
  assert.equal(settings.triggerMode, 'hotkey')
  assert.equal(settings.proxyMode, 'custom')
  assert.equal(settings.proxyRules, 'http://127.0.0.1:7890')
  assert.equal(settings.proxyBypassRules, '<local>;localhost')
})

test('自定义代理应转换为 Electron 固定代理配置并清理空白', () => {
  assert.deepEqual(buildProxyConfig({
    proxyMode: 'custom',
    proxyRules: '  socks5://127.0.0.1:7890  ',
    proxyBypassRules: '  <local>;localhost  '
  }), {
    mode: 'fixed_servers',
    proxyRules: 'socks5://127.0.0.1:7890',
    proxyBypassRules: '<local>;localhost'
  })
})

test('系统代理和直连模式不应携带自定义代理规则', () => {
  assert.deepEqual(buildProxyConfig({
    proxyMode: 'system',
    proxyRules: 'http://127.0.0.1:7890',
    proxyBypassRules: '<local>'
  }), { mode: 'system' })
  assert.deepEqual(buildProxyConfig({
    proxyMode: 'direct',
    proxyRules: 'http://127.0.0.1:7890',
    proxyBypassRules: '<local>'
  }), { mode: 'direct' })
})
