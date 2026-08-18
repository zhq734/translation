import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  createObservedPointerSample,
  decideSelectionAction,
  getSelectionGesture,
  resolveLanguagePair,
  resolveWindowsPointerPoint,
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
  shouldRestoreClipboardAfterAbort,
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

/**
 * 校验 Windows 高 DPI 与多显示器场景能识别原生坐标是否已经是 DIP，并在坐标异常时回退到当前光标。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 划词坐标应转换为 Electron 使用的 DIP 坐标并容忍原生坐标异常', () => {
  assert.deepEqual(
    resolveWindowsPointerPoint(
      { x: 1800, y: 900 },
      { x: 1200, y: 600 },
      { x: 1201, y: 600 }
    ),
    { x: 1200, y: 600 }
  )
  assert.deepEqual(
    resolveWindowsPointerPoint(
      { x: 100, y: 100 },
      { x: 80, y: 80 },
      { x: 100, y: 100 }
    ),
    { x: 100, y: 100 }
  )
  assert.deepEqual(
    resolveWindowsPointerPoint(
      { x: -21000, y: 480 },
      { x: -16800, y: 384 },
      { x: 980, y: 480 }
    ),
    { x: 980, y: 480 }
  )
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

  assert.equal(guard.observeCopyShortcut(), false)
  await expectation.finish()
  assert.equal(guard.hasExternalCopySince(version), false)

  assert.equal(guard.observeCopyShortcut(), true)
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

test('用户复制导致内部取词中止时不得把旧剪贴板写回', () => {
  assert.equal(shouldRestoreClipboardAfterAbort(true), false)
  assert.equal(shouldRestoreClipboardAfterAbort(false), true)

  const source = readFileSync('src/main/capture.ts', 'utf8')
  assert.match(
    source,
    /const handleAbort = \(\): void => \{\s*if \(shouldRestoreClipboardAfterAbort\(\s*copyShortcutGuard\.hasExternalCopySince\(externalCopyVersion\)\s*\)\) \{\s*restoreOriginalClipboard\(\)/u
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

/**
 * 校验 Windows 用户快速点击按钮时会等待尚未完成的预取，而不是中止后重新从已失效的选区取词。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('点击“译”按钮时应等待正在进行的选区预取并且只消费一次', async () => {
  let captureCount = 0
  let notifyStarted: (() => void) | undefined
  let finishCapture: ((text: string) => void) | undefined
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve
  })
  const coordinator = new SelectionCaptureCoordinator(async () => {
    captureCount += 1
    notifyStarted?.()
    return await new Promise<string>((resolve) => {
      finishCapture = resolve
    })
  })
  const anchor = { x: 420, y: 260 }

  const preparing = coordinator.prepare(anchor)
  await started
  const clicked = coordinator.consumePreparedOrWait()
  const duplicateClick = coordinator.consumePreparedOrWait()
  finishCapture?.('Windows cached selection')

  assert.deepEqual(await preparing, { text: 'Windows cached selection', anchor })
  assert.deepEqual(await clicked, { text: 'Windows cached selection', anchor })
  assert.equal(await duplicateClick, null)
  assert.equal(captureCount, 1)
})

/**
 * 校验图标可以先展示，而后台取词仍等待前台应用完成选区更新。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('选区按钮预取应支持延迟执行且快速点击仍可等待结果', async () => {
  let captureCount = 0
  const coordinator = new SelectionCaptureCoordinator(async () => {
    captureCount += 1
    return 'delayed Windows selection'
  })
  const anchor = { x: 520, y: 320 }

  const preparing = coordinator.prepare(anchor, 30)
  const clicked = coordinator.consumePreparedOrWait()

  assert.equal(captureCount, 0)
  assert.deepEqual(await preparing, { text: 'delayed Windows selection', anchor })
  assert.deepEqual(await clicked, { text: 'delayed Windows selection', anchor })
  assert.equal(captureCount, 1)
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

test('预取结果为空时点击“译”按钮仍应消费结果以展示明确提示', async () => {
  const coordinator = new SelectionCaptureCoordinator(async () => '   ')
  const anchor = { x: 100, y: 100 }

  const prepared = await coordinator.prepare(anchor)

  assert.deepEqual(prepared, { text: '', anchor })
  assert.deepEqual(await coordinator.consumePreparedOrWait(), { text: '', anchor })
  assert.equal(await coordinator.consumePreparedOrWait(), null)
})

test('主进程应先显示按钮并在点击时等待预取结果', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')

  assert.match(
    source,
    /showSelectionButton\(anchor\)[\s\S]*?void prepareSelectionButton\(anchor, gestureId\)/u
  )
  assert.match(
    source,
    /await selectionCapture\.prepare\(anchor,\s*SELECTION_SETTLE_DELAY_MS\)/u
  )
  assert.match(
    source,
    /await selectionCapture\.consumePreparedOrWait\(\)[\s\S]*?selectionCapture\.invalidate\(\)/u
  )
  assert.match(
    source,
    /startAutoTrigger\(\s*handleSelectionGesture,\s*handleSelectionPointerDown,\s*handleCopyShortcut,\s*handlePasteShortcut\s*\)/u
  )
})

/**
 * 校验选区稳定等待只作用于后台取词，不再阻塞 Windows “译”图标展示。
 * @returns 无返回值。
 * @author zhenghq
 */
test('按钮模式应立即显示“译”图标并仅延迟后台预取', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const scheduleStart = source.indexOf('function scheduleSelectionAction')
  const scheduleEnd = source.indexOf('/**\n * 响应一次全局划词动作', scheduleStart)
  const scheduleSource = source.slice(scheduleStart, scheduleEnd)

  assert.ok(scheduleStart >= 0)
  assert.ok(scheduleEnd > scheduleStart)
  assert.match(
    scheduleSource,
    /if\s*\(action === 'show-button'\)\s*\{[\s\S]*?showSelectionButton\(anchor\)[\s\S]*?prepareSelectionButton\(anchor, gestureId\)[\s\S]*?return/u
  )
  assert.match(
    source,
    /selectionCapture\.prepare\(anchor,\s*SELECTION_SETTLE_DELAY_MS\)/u
  )
})

/**
 * 校验 Windows 不依赖非激活悬浮窗口的 DOM click，能够从全局鼠标按下事件直接触发翻译。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 点击“译”按钮应由主进程直接激活并阻止鼠标事件继续进入划词判定', () => {
  const mainSource = readFileSync('src/main/index.ts', 'utf8')
  const autoTriggerSource = readFileSync('src/main/autoTrigger.ts', 'utf8')

  assert.match(
    mainSource,
    /if\s*\(isPointInsideSelectionButton\(point\)\)\s*\{[\s\S]*?process\.platform\s*===\s*'win32'[\s\S]*?translatePreparedSelection\(\)[\s\S]*?return true/u
  )
  assert.match(
    autoTriggerSource,
    /const pointerHandled = pointerDownCallback\?\.\(point\)\s*\?\?\s*false[\s\S]*?if\s*\(pointerHandled\)\s*\{[\s\S]*?downAt\s*=\s*null[\s\S]*?return/u
  )
})

test('全局监听应传递双击次数，并监听用户复制和粘贴快捷键', () => {
  const source = readFileSync('src/main/autoTrigger.ts', 'utf8')

  assert.match(source, /shouldTriggerSelectionGesture\(gesture,\s*e\.clicks/u)
  assert.match(source, /screen\.screenToDipPoint\(/u)
  assert.match(source, /screen\.getCursorScreenPoint\(\)/u)
  assert.match(source, /uIOhook\.on\('keydown',\s*onKeyDown\)/u)
  assert.match(
    source,
    /if\s*\(copyShortcutGuard\.observeCopyShortcut\(\)\)\s*copyShortcutCallback\?\.\(\)/u
  )
  assert.match(source, /e\.keycode\s*===\s*UiohookKey\.V/u)
  assert.match(source, /pasteShortcutCallback\?\.\(\)/u)
})

test('全局监听不应监听 Ctrl+A 或 Command+A 全选快捷键', () => {
  const autoTriggerSource = readFileSync('src/main/autoTrigger.ts', 'utf8')
  const mainSource = readFileSync('src/main/index.ts', 'utf8')

  assert.doesNotMatch(
    autoTriggerSource,
    /isSelectAllShortcut|UiohookKey\.A|SelectAllShortcut|selectAllShortcut|uIOhook\.on\('keyup'/u
  )
  assert.doesNotMatch(mainSource, /handleSelectAllShortcut|Ctrl\+A|Command\+A/u)
})

test('主进程不得注册系统复制快捷键，选区按钮也不得抢占输入焦点', () => {
  const mainSource = readFileSync('src/main/index.ts', 'utf8')
  const buttonSource = readFileSync('src/main/selectionButton.ts', 'utf8')

  assert.match(mainSource, /if\s*\(isCopyShortcut\(accelerator\)\)\s*\{/u)
  assert.match(buttonSource, /focusable:\s*false/u)
  assert.match(buttonSource, /webContents\.once\('did-finish-load'/u)
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
  assert.match(
    source,
    /if\s*\(signal\?\.aborted\)\s*\{\s*if\s*\(shouldRestoreClipboardAfterAbort\(\s*copyShortcutGuard\.hasExternalCopySince\(externalCopyVersion\)\s*\)\)\s*\{\s*restoreOriginalClipboard\(\)/u
  )
})

test('用户复制或粘贴时主进程应立即取消待处理或正在进行的选区捕获', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')

  assert.match(
    source,
    /startAutoTrigger\(\s*handleSelectionGesture,\s*handleSelectionPointerDown,\s*handleCopyShortcut,\s*handlePasteShortcut\s*\)/u
  )
  assert.match(
    source,
    /function handleCopyShortcut\(\): void \{[\s\S]*?selectionCapture\.invalidate\(\)/u
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

/**
 * 校验图钉与设置操作使用相同尺寸、相同线条风格的 SVG 图标和按钮外观。
 * @returns 无返回值。
 * @author zhenghq
 */
test('翻译弹窗的图钉和设置操作应使用统一尺寸的线性 SVG 图标', () => {
  const popupHtml = readFileSync('src/renderer/index.html', 'utf8')
  const popupStyles = readFileSync('src/renderer/src/style.css', 'utf8')

  assert.match(
    popupHtml,
    /<button[^>]+id="pin"[^>]+class="header-action-button"[^>]*>[\s\S]*?<svg[^>]+class="header-action-icon pin-icon"/u
  )
  assert.match(
    popupHtml,
    /<button[^>]+id="open-settings"[^>]+class="header-action-button"[^>]*>[\s\S]*?<svg[^>]+class="header-action-icon settings-icon"/u
  )
  assert.doesNotMatch(popupHtml, />\s*⚙\s*<\/button>/u)
  assert.match(
    popupStyles,
    /\.header-action-button\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;[^}]*border-radius:\s*9px;[^}]*transition:/su
  )
  assert.match(
    popupStyles,
    /\.header-action-icon\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px;[^}]*fill:\s*none;[^}]*stroke:\s*currentColor;[^}]*stroke-width:\s*1\.8;/su
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

  assert.equal(settings.schemaVersion, 8)
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

  assert.equal(settings.schemaVersion, 8)
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
