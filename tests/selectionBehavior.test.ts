import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  createObservedPointerSample,
  decideSelectionAction,
  getSelectionGesture,
  hasConfirmedSelectionText,
  parseNativeSelectionReadOutput,
  parseSelectionPresenceOutput,
  resolveSelectionCaptureFailureMessage,
  resolveLanguagePair,
  resolveWindowsPointerPoint,
  shouldShowSelectionButtonAfterInspection,
  shouldTriggerSelectionGesture,
  isPointInsideBounds,
  isSelectionGestureInsideOwnWindows
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
    { x: 181, y: 220, time: 1010 },
    2
  )

  assert.equal(gesture.clicks, 2)
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
 * 校验选区状态解析辅助函数仍能识别空选区，但按钮显示不依赖该异步检查结果。
 * @returns 无返回值。
 * @author zhenghq
 */
test('双击选区状态辅助解析应区分空选区与已选文字', () => {
  assert.equal(parseSelectionPresenceOutput('PRESENT\n'), 'present')
  assert.equal(parseSelectionPresenceOutput('EMPTY\r\n'), 'empty')
  assert.equal(parseSelectionPresenceOutput('无法读取'), 'unknown')
  assert.equal(shouldShowSelectionButtonAfterInspection(2, 'empty'), false)
  assert.equal(shouldShowSelectionButtonAfterInspection(2, 'present'), true)
  assert.equal(shouldShowSelectionButtonAfterInspection(2, 'unknown'), false)
  assert.equal(shouldShowSelectionButtonAfterInspection(1, 'empty'), true)
})

/**
 * 校验预取结果判断辅助函数仍能区分可缓存文字与无效结果。
 * 双击按钮本身会立即显示，预取结果只用于后续点击时消费。
 * @returns 无返回值。
 * @author zhenghq
 */
test('双击预取结果判断应区分可缓存文字与无效结果', () => {
  assert.equal(hasConfirmedSelectionText(null), false)
  assert.equal(hasConfirmedSelectionText({ text: '' }), false)
  assert.equal(hasConfirmedSelectionText({ text: '   \n  ' }), false)
  assert.equal(hasConfirmedSelectionText({ text: '', reason: 'empty' }), false)
  assert.equal(hasConfirmedSelectionText({ text: '', reason: 'unsupported' }), false)
  assert.equal(hasConfirmedSelectionText({ text: '', reason: 'unknown' }), false)
  assert.equal(hasConfirmedSelectionText({ text: '已选文字', error: new Error('读取失败') }), false)
  assert.equal(hasConfirmedSelectionText({ text: '  已选文字  ' }), true)
})

/**
 * 校验状态检查只读取首行状态标记，多行选中文本中即使出现 EMPTY/UNKNOWN 字样也不会误判为空选区。
 * @returns 无返回值。
 * @author zhenghq
 */
test('多行选中文本不应把正文中的 EMPTY 字样误判为空选区', () => {
  assert.equal(parseSelectionPresenceOutput('PRESENT\n第一行\nEMPTY'), 'present')
  assert.equal(parseSelectionPresenceOutput('PRESENT\nUNKNOWN 文字'), 'present')
  assert.equal(parseSelectionPresenceOutput('EMPTY\n附带说明'), 'empty')
  assert.equal(parseSelectionPresenceOutput('UNKNOWN\n附带说明'), 'unknown')
})

/**
 * 校验原生直读解析只取首行状态标记，其余行视为多行选中文本，避免把正文误判为状态。
 * @returns 无返回值。
 * @author zhenghq
 */
test('原生直读应解析首行状态并把其余行作为选中文本', () => {
  assert.deepEqual(
    parseNativeSelectionReadOutput('PRESENT\n选中文字'),
    { status: 'present', text: '选中文字' }
  )
  assert.deepEqual(
    parseNativeSelectionReadOutput('PRESENT\n第一行\n第二行'),
    { status: 'present', text: '第一行\n第二行' }
  )
  assert.deepEqual(
    parseNativeSelectionReadOutput('EMPTY\n'),
    { status: 'empty', text: '' }
  )
  assert.deepEqual(
    parseNativeSelectionReadOutput('UNKNOWN'),
    { status: 'unknown', text: '' }
  )
  assert.deepEqual(
    parseNativeSelectionReadOutput('无法识别'),
    { status: 'unknown', text: '' }
  )
})

/**
 * 校验 Windows PowerShell 输出的 CRLF 换行能被规范化，多行文本不会丢内容。
 * @returns 无返回值。
 * @author zhenghq
 */
test('原生直读应兼容 Windows CRLF 输出与仅空白的 PRESENT', () => {
  assert.deepEqual(
    parseNativeSelectionReadOutput('PRESENT\r\nWindows 文本'),
    { status: 'present', text: 'Windows 文本' }
  )
  assert.deepEqual(
    parseNativeSelectionReadOutput('PRESENT\r\n第一行\r\n第二行'),
    { status: 'present', text: '第一行\n第二行' }
  )
  assert.deepEqual(
    parseNativeSelectionReadOutput('PRESENT\n   '),
    { status: 'empty', text: '' }
  )
  assert.deepEqual(
    parseNativeSelectionReadOutput(''),
    { status: 'unknown', text: '' }
  )
})

/**
 * 校验取词失败提示按原因细分：空选区沿用既有文案，超时与不支持分别给出新文案。
 * @returns 无返回值。
 * @author zhenghq
 */
test('取词失败提示应按原因细分：空选区、超时与应用不支持', () => {
  assert.equal(
    resolveSelectionCaptureFailureMessage('empty'),
    '未检测到选中文字，请重新划词后点击“译”按钮'
  )
  assert.equal(
    resolveSelectionCaptureFailureMessage(undefined),
    '未检测到选中文字，请重新划词后点击“译”按钮'
  )
  assert.equal(
    resolveSelectionCaptureFailureMessage('timeout'),
    '取词超时，请重试或确认所选内容可复制'
  )
  assert.equal(
    resolveSelectionCaptureFailureMessage('unsupported'),
    '当前应用不支持划词取词，请确认所选内容可复制'
  )
  assert.equal(
    resolveSelectionCaptureFailureMessage('permission'),
    '需要「辅助功能」权限才能读取选中文字，请授权后重试'
  )
})

/**
 * 校验只选中图片时不把图片选区误报为“未检测到选中文字”。
 * @returns 无返回值。
 * @author zhenghq
 */
test('图片选区失败提示应优先于空选区文案', () => {
  assert.equal(
    resolveSelectionCaptureFailureMessage('empty', true),
    '已识别到图片选区，暂不支持图片翻译'
  )
  assert.equal(
    resolveSelectionCaptureFailureMessage('timeout', true),
    '已识别到图片选区，暂不支持图片翻译'
  )
  assert.equal(
    resolveSelectionCaptureFailureMessage(undefined, true),
    '已识别到图片选区，暂不支持图片翻译'
  )
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
 * 校验点击“译”按钮时不会等待卡住的只读预取，而是立即取消预取并开始按钮专用取词。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('点击“译”按钮应取消未完成预取并立即开始按钮专用取词', async () => {
  let prefetchAbortObserved = false
  let buttonCaptureCount = 0
  let notifyPrefetchStarted: (() => void) | undefined
  const prefetchStarted = new Promise<void>((resolve) => {
    notifyPrefetchStarted = resolve
  })
  const coordinator = new SelectionCaptureCoordinator(
    async () => '普通完整取词',
    async (signal) => await new Promise((resolve) => {
      notifyPrefetchStarted?.()
      signal.addEventListener('abort', () => {
        prefetchAbortObserved = true
        resolve({ text: '', reason: 'unknown' })
      }, { once: true })
    }),
    async () => {
      buttonCaptureCount += 1
      return '按钮立即复制到的文字'
    }
  )
  const anchor = { x: 460, y: 280 }

  void coordinator.prepare(anchor)
  await prefetchStarted
  const prepared = coordinator.consumePrepared()
  const captured = await coordinator.captureFromButton(anchor)

  assert.equal(prepared, null)
  assert.equal(prefetchAbortObserved, true)
  assert.deepEqual(captured, { text: '按钮立即复制到的文字', anchor })
  assert.equal(buttonCaptureCount, 1)
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

/**
 * 校验协调器结果携带底层取词返回的失败原因与图片标志，供上层细分提示文案。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('取词结果应携带失败原因与图片标志', async () => {
  const coordinator = new SelectionCaptureCoordinator(async () => ({
    text: '',
    reason: 'timeout'
  }))
  const anchor = { x: 100, y: 100 }

  assert.deepEqual(await coordinator.capture(anchor), {
    text: '',
    reason: 'timeout',
    anchor
  })

  const imageCoordinator = new SelectionCaptureCoordinator(async () => ({
    text: '',
    hasImage: true
  }))
  assert.deepEqual(await imageCoordinator.capture(anchor), {
    text: '',
    hasImage: true,
    anchor
  })
})

/**
 * 校验预取使用传入的只读取词函数，而 capture 使用完整取词管线，二者互不混用。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('预取应使用只读函数，点击消费后 capture 才使用完整取词管线', async () => {
  let prefetchCount = 0
  let captureCount = 0
  const coordinator = new SelectionCaptureCoordinator(
    async () => {
      captureCount += 1
      return '完整管线取到的文字'
    },
    async () => {
      prefetchCount += 1
      return '只读预取到的文字'
    }
  )
  const anchor = { x: 640, y: 420 }

  const prepared = await coordinator.prepare(anchor)
  assert.deepEqual(prepared, { text: '只读预取到的文字', anchor })
  assert.equal(prefetchCount, 1)
  assert.equal(captureCount, 0)

  const clicked = await coordinator.consumePreparedOrWait()
  assert.deepEqual(clicked, { text: '只读预取到的文字', anchor })
  assert.equal(captureCount, 0)

  const full = await coordinator.capture(anchor)
  assert.deepEqual(full, { text: '完整管线取到的文字', anchor })
  assert.equal(captureCount, 1)
})

/**
 * 校验只读预取未取到文本时，点击仍可回退到完整取词管线拿到文字。
 * @returns 测试完成后的 Promise。
 * @author zhenghq
 */
test('只读预取为空时点击“译”按钮应回退到完整取词管线', async () => {
  let captureCount = 0
  const coordinator = new SelectionCaptureCoordinator(
    async () => {
      captureCount += 1
      return '复制兜底拿到的文字'
    },
    async () => ({ text: '', reason: 'empty' })
  )
  const anchor = { x: 80, y: 80 }

  const prepared = await coordinator.prepare(anchor)
  assert.deepEqual(prepared, { text: '', reason: 'empty', anchor })

  // 预取为空时 consumed 结果不含文本，主进程据此回退到 capture 完整管线。
  const consumed = await coordinator.consumePreparedOrWait()
  assert.equal(consumed?.text, '')
  assert.equal(captureCount, 0)

  const full = await coordinator.capture(anchor)
  assert.deepEqual(full, { text: '复制兜底拿到的文字', anchor })
  assert.equal(captureCount, 1)
})

/**
 * 校验按钮模式在划词阶段只做只读直读预取，完整取词（复制兜底）必须等用户点击“译”按钮。
 * @returns 无返回值。
 * @author zhenghq
 */
test('按钮模式应在划词阶段只读预取文字，点击“译”按钮后优先消费缓存再兜底完整取词', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const scheduleStart = source.indexOf('function scheduleSelectionAction')
  const scheduleEnd = source.indexOf('/**\n * 响应一次全局划词动作', scheduleStart)
  const scheduleSource = source.slice(scheduleStart, scheduleEnd)
  const translateStart = source.indexOf('async function translateSelectionButton')
  const translateEnd = source.indexOf('/**\n * 处理取词结果', translateStart)
  const translateSource = source.slice(translateStart, translateEnd)

  assert.match(
    scheduleSource,
    /if\s*\(action === 'show-button'\)\s*\{[\s\S]*?showSelectionButton\(anchor\)[\s\S]*?selectionCapture\.prepare\(anchor\)[\s\S]*?return/u
  )
  // 按钮显示期间不得启动完整取词管线（直读 + 复制兜底），只允许只读预取。
  assert.doesNotMatch(scheduleSource, /selectionCapture\.capture/u)
  assert.match(translateSource, /selectionCapture\.consumePreparedBounded\(\)/u)
  assert.doesNotMatch(translateSource, /consumePreparedOrWait/u)
  assert.match(translateSource, /const anchor = lastSelectionAnchor/u)
  assert.match(translateSource, /selectionInteraction\.beginButtonCapture\(\)/u)
  assert.match(
    translateSource,
    /consumption\.result\s*\?\?\s*await selectionCapture\.captureFromButton\(anchor\)[\s\S]*?selectionCapture\.invalidate\(\)/u
  )
  assert.match(translateSource, /selectionInteraction\.isCurrent\(interactionToken\)/u)
  assert.match(
    source,
    /startAutoTrigger\(\s*handleSelectionGesture,\s*handleSelectionPointerDown,\s*handleCopyShortcut,\s*handlePasteShortcut\s*\)/u
  )
})

/**
 * 校验按钮显示期间只做只读直读预取，不得启动完整取词（复制兜底），避免无选区时持续发送 Ctrl+C。
 * @returns 无返回值。
 * @author zhenghq
 */
test('显示“译”按钮期间只允许只读预取，不得启动完整选区捕获', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const scheduleStart = source.indexOf('function scheduleSelectionAction')
  const scheduleEnd = source.indexOf('/**\n * 响应一次全局划词动作', scheduleStart)
  const scheduleSource = source.slice(scheduleStart, scheduleEnd)

  assert.ok(scheduleStart >= 0)
  assert.ok(scheduleEnd > scheduleStart)
  assert.match(scheduleSource, /selectionCapture\.prepare\(anchor\)/u)
  assert.doesNotMatch(scheduleSource, /selectionCapture\.capture/u)
  assert.doesNotMatch(source, /function prepareSelectionButton/u)
})

/**
 * 校验按钮模式双击应先显示“译”按钮，再用只读直读后台预取选中文字，不发送复制快捷键。
 * @returns 无返回值。
 * @author zhenghq
 */
test('按钮模式双击应立即显示按钮并后台预取选区文字', () => {
  const mainSource = readFileSync('src/main/index.ts', 'utf8')
  const captureSource = readFileSync('src/main/capture.ts', 'utf8')
  const doubleClickStart = mainSource.indexOf('function scheduleDoubleClickSelectionButton')
  const doubleClickEnd = mainSource.indexOf('/**', doubleClickStart)
  const doubleClickSource = mainSource.slice(doubleClickStart, doubleClickEnd)

  assert.ok(doubleClickStart >= 0)
  assert.ok(doubleClickEnd > doubleClickStart)
  // 预取结果只用于缓存，不能阻塞按钮显示，否则系统直读失败时用户永远看不到按钮。
  assert.doesNotMatch(doubleClickSource, /hasConfirmedSelectionText\(prepared\)/u)
  assert.match(
    doubleClickSource,
    /lastSelectionAnchor\s*=\s*gesture\.anchor[\s\S]*?showSelectionButton\(gesture\.anchor\)[\s\S]*?await selectionCapture\.prepare/u
  )
  assert.doesNotMatch(doubleClickSource, /selectionCapture\.capture|simulateCopy/u)
  assert.match(doubleClickSource, /selectionCapture\.prepare\(gesture\.anchor,\s*SELECTION_SETTLE_DELAY_MS\)/u)
  assert.match(doubleClickSource, /gestureId !== latestSelectionGesture/u)
  assert.match(doubleClickSource, /getSettings\(\)\.triggerMode !== 'button'/u)
  assert.match(captureSource, /clipboard\.readText\('selection'\)/u)
  assert.match(captureSource, /AXSelectedText/u)
  assert.match(captureSource, /System\.Windows\.Automation\.TextPattern/u)
})

/**
 * 校验所有桌面平台都在悬浮按钮的全局鼠标按下阶段直接触发翻译，避免源应用先清除选区。
 * @returns 无返回值。
 * @author zhenghq
 */
test('点击“译”按钮应在全局鼠标按下阶段直接激活并阻止鼠标事件继续进入划词判定', () => {
  const mainSource = readFileSync('src/main/index.ts', 'utf8')
  const autoTriggerSource = readFileSync('src/main/autoTrigger.ts', 'utf8')
  const pointerDownStart = mainSource.indexOf('function handleSelectionPointerDown')
  const pointerDownEnd = mainSource.indexOf('/**', pointerDownStart)
  const pointerDownSource = mainSource.slice(pointerDownStart, pointerDownEnd)

  assert.match(
    pointerDownSource,
    /ocrActive:[\s\S]*?selectionButtonHit:\s*isPointInsideSelectionButton\(point\)[\s\S]*?if\s*\(result === 'consume' && isPointInsideSelectionButton\(point\)\)\s*\{[\s\S]*?void translateSelectionButton\(\)[\s\S]*?if\s*\(result === 'consume'\)\s*return result/u
  )
  assert.doesNotMatch(pointerDownSource, /process\.platform\s*===\s*'win32'/u)
  assert.match(
    autoTriggerSource,
    /let result:\s*PointerDownResult\s*=\s*'track'[\s\S]*?result\s*=\s*pointerDownCallback\?\.\(point\)\s*\?\?\s*'track'[\s\S]*?resolvePointerDownTracking\(/u
  )
})

test('全局监听应传递双击次数，并监听用户复制和粘贴快捷键', () => {
  const source = readFileSync('src/main/autoTrigger.ts', 'utf8')

  assert.match(source, /shouldTriggerSelectionGesture\(gesture,\s*e\.clicks/u)
  assert.match(source, /screen\.screenToDipPoint\(/u)
  assert.match(source, /screen\.getCursorScreenPoint\(\)/u)
  assert.match(source, /keydown:\s*onKeyDown as AutoTriggerHookListeners\['keydown'\]/u)
  assert.match(source, /startAutoTriggerLifecycle\(\{/u)
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

  assert.equal(settings.schemaVersion, 16)
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

  assert.equal(settings.schemaVersion, 16)
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

test('落在应用自有窗口内的鼠标动作不应被当成划词手势', () => {
  const settingsBounds = { x: 100, y: 100, width: 640, height: 820 }

  assert.equal(isPointInsideBounds({ x: 300, y: 400 }, settingsBounds), true)
  assert.equal(isPointInsideBounds({ x: 90, y: 400 }, settingsBounds), false)
  assert.equal(isPointInsideBounds({ x: 300, y: 400 }, null), false)

  // 设置窗口内的点击与拖动：起点或终点任意一端落在窗口内都应忽略
  const insideGesture = getSelectionGesture(
    { x: 200, y: 300, time: 1000 },
    { x: 420, y: 300, time: 1400 }
  )
  const leavingGesture = getSelectionGesture(
    { x: 200, y: 300, time: 1000 },
    { x: 2000, y: 300, time: 1400 }
  )
  const outsideGesture = getSelectionGesture(
    { x: 900, y: 300, time: 1000 },
    { x: 1100, y: 300, time: 1400 }
  )

  assert.equal(isSelectionGestureInsideOwnWindows(insideGesture, [settingsBounds]), true)
  assert.equal(isSelectionGestureInsideOwnWindows(leavingGesture, [settingsBounds]), true)
  assert.equal(isSelectionGestureInsideOwnWindows(outsideGesture, [settingsBounds]), false)
  assert.equal(isSelectionGestureInsideOwnWindows(insideGesture, []), false)
  assert.equal(isSelectionGestureInsideOwnWindows(insideGesture, [null]), false)
})

test('划词手势处理只应排除持有焦点的应用自有窗口，后台设置窗口不得屏蔽其他应用划词', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')

  // 只有当前持有焦点的自有窗口参与排除；仅按矩形位置判断会让后台设置窗口挡住其他应用的划词
  assert.match(source, /function getFocusedOwnWindowBounds/u)
  const boundsStart = source.indexOf('function getFocusedOwnWindowBounds')
  const boundsEnd = source.indexOf('\n}', boundsStart)
  const boundsSource = source.slice(boundsStart, boundsEnd)
  assert.match(boundsSource, /settingsWin/u)
  assert.match(boundsSource, /isFocused\(\)/u)
  assert.match(boundsSource, /webReader\?\.isWindowFocused\(\)/u)

  const handlerStart = source.indexOf('function handleSelectionGesture')
  const handlerEnd = source.indexOf('/**', handlerStart + 1)
  const handlerSource = source.slice(handlerStart, handlerEnd)
  assert.match(
    handlerSource,
    /isSelectionGestureInsideOwnWindows\(gesture,\s*getFocusedOwnWindowBounds\(\)\)/u
  )

  const pointerStart = source.indexOf('function handleSelectionPointerDown')
  const pointerEnd = source.indexOf('/**', pointerStart + 1)
  const pointerSource = source.slice(pointerStart, pointerEnd)
  // 焦点在设置窗口内按下不得清空已有选区缓存，也不得被按钮流程消费
  assert.match(pointerSource, /isPointInsideFocusedOwnWindow\(point\)/u)
})

test('网页阅读器窗口应暴露焦点状态，供划词监听区分前台与后台窗口', () => {
  const source = readFileSync('src/main/webReaderWindow.ts', 'utf8')
  assert.match(source, /isWindowFocused\(\):\s*boolean/u)
  assert.match(source, /getVisibleBounds\(\):\s*Rectangle \| null/u)
})

test('设置窗口焦点切换应清理窗口内遗留状态但保留先到达的外部鼠标按下', () => {
  const autoTriggerSource = readFileSync('src/main/autoTrigger.ts', 'utf8')
  const mainSource = readFileSync('src/main/index.ts', 'utf8')

  // macOS 可能先派发外部 mousedown，再派发设置窗口 blur；失焦清理必须限定窗口边界，
  // 否则会把用户切出设置页后的第一次正常划词起点一起清除。
  assert.match(autoTriggerSource, /export function resetAutoTriggerPointerState\(blurredWindowBounds\?: ScreenBounds\): void/u)
  assert.match(autoTriggerSource, /resetPointerTrackingForWindowBlur/u)
  assert.match(
    mainSource,
    /settingsWin\.on\('focus',[\s\S]*?settingsWin\.getBounds\(\)[\s\S]*?resetAutoTriggerPointerState\(settingsBounds\)[\s\S]*?settingsWin\.on\('blur',[\s\S]*?settingsWin\.getBounds\(\)[\s\S]*?resetAutoTriggerPointerState\(settingsBounds\)/u
  )
})

test('OCR 框选收尾必须无条件恢复划词监听，避免全局钩子被永久停用', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')

  // OCR 暂停与恢复统一交给监听控制器记账，移除分散布尔状态。
  assert.match(source, /new SelectionListenerController/u)
  assert.doesNotMatch(source, /selectionListenerSuspendedForOcr/u)
  assert.match(source, /function suspendSelectionListenerForOcr/u)

  const suspendStart = source.indexOf('function suspendSelectionListenerForOcr')
  const suspendSource = source.slice(suspendStart, source.indexOf('\n}', suspendStart))
  assert.match(suspendSource, /selectionListenerController\.pause\('ocr'\)/u)
  assert.doesNotMatch(suspendSource, /stopAutoTrigger\(\)/u)

  const restoreStart = source.indexOf('function restoreSelectionListenerAfterOcr')
  const restoreSource = source.slice(restoreStart, source.indexOf('\n}', restoreStart))
  assert.match(restoreSource, /selectionListenerController\.resume\('ocr'\)/u)
  assert.match(restoreSource, /ocrInteractionToken = null/u)
  assert.doesNotMatch(restoreSource, /applySelectionListener\(\)/u)

  // openOcrSelection 必须通过记账函数停用，不能直接 stopAutoTrigger
  const openStart = source.indexOf('async function openOcrSelection')
  const openSource = source.slice(openStart, source.indexOf('\n}\n', openStart))
  assert.match(openSource, /suspendSelectionListenerForOcr\(\)/u)
  assert.match(
    openSource,
    /if\s*\(!selectionInteraction\.isCurrent\(interactionToken\)\)\s*\{[\s\S]*?restoreSelectionListenerAfterOcr\(interactionToken\)[\s\S]*?return/u
  )
  assert.doesNotMatch(openSource, /\bstopAutoTrigger\(\)/u)

  const hotkeyStart = source.indexOf('function onOcrHotkey')
  const hotkeySource = source.slice(hotkeyStart, source.indexOf('\n}', hotkeyStart))
  assert.doesNotMatch(hotkeySource, /selectionInteraction\.invalidate\(\)/u)

  const translationQueueStart = source.indexOf('function queueSelectionTranslation')
  const translationQueueSource = source.slice(
    translationQueueStart,
    source.indexOf('/**\n * 响应“译”按钮点击', translationQueueStart)
  )
  assert.match(translationQueueSource, /snapshot\(\)\.state === 'ocr-selecting'\) return/u)

  // 取消与提交都不得再用“窗口曾可见”作为恢复前提
  const cancelStart = source.indexOf('function cancelOcrSelection')
  const cancelSource = source.slice(cancelStart, source.indexOf('\n}', cancelStart))
  assert.match(cancelSource, /restoreSelectionListenerAfterOcr\(\)/u)
  assert.doesNotMatch(cancelSource, /if\s*\(wasVisible\)/u)

  const submitStart = source.indexOf('async function submitOcrSelection')
  const submitSource = source.slice(submitStart, source.indexOf('\n}\n', submitStart))
  assert.doesNotMatch(submitSource, /if\s*\(!ocrSelectionWasVisible\s*\|\|/u)
})

test('OCR 取消应始终通知主进程，即使 Renderer 已退出框选模式', () => {
  const source = readFileSync('src/renderer/src/selection.ts', 'utf8')
  const cancelStart = source.indexOf('function cancelOcrSelection')
  const cancelSource = source.slice(cancelStart, source.indexOf('\n}', cancelStart))

  // 提前返回会让主进程收不到取消通知，全局钩子将无法恢复
  assert.doesNotMatch(cancelSource, /if\s*\(!ocrMode\)\s*return/u)
  assert.match(cancelSource, /window\.api\.cancelOcrSelection\(\)/u)
})

/**
 * 校验“译”浮动图标不使用原生或 CSS 半透明阴影，避免 Windows 透明窗口底部出现阴影残留。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows “译”浮动图标应去除底部半透明阴影', () => {
  const buttonSource = readFileSync('src/main/selectionButton.ts', 'utf8')
  const styles = readFileSync('src/renderer/src/selection.css', 'utf8')
  const buttonRule = styles.match(/#translate\s*\{([^}]*)\}/u)?.[1] ?? ''
  const hoverRule = styles.match(/#translate:hover\s*\{([^}]*)\}/u)?.[1] ?? ''

  assert.match(buttonSource, /hasShadow:\s*false/u)
  assert.doesNotMatch(buttonRule, /box-shadow/u)
  assert.doesNotMatch(hoverRule, /box-shadow/u)
})

test('全局钩子启动失败时应清理监听器状态并允许后续重试', () => {
  const source = readFileSync('src/main/autoTrigger.ts', 'utf8')
  const lifecycleSource = readFileSync('src/main/autoTriggerLifecycle.ts', 'utf8')
  const startStart = source.indexOf('export function startAutoTrigger')
  const startSource = source.slice(startStart, source.indexOf('\n}', startStart))

  // 行为测试覆盖真实清理结果；此处仅保留接线断言，避免主入口绕过生命周期辅助函数。
  assert.match(startSource, /startAutoTriggerLifecycle\(\{[\s\S]*?clearCallbackState:\s*clearAutoTriggerCallbacks/u)
  assert.match(source, /function detachHookListeners/u)
  assert.match(lifecycleSource, /catch[\s\S]*?detachAutoTriggerHookListeners\(hook, listeners\)[\s\S]*?options\.clearCallbackState\(\)/u)

  // 需要暴露启动结果，便于上层判断钩子是否真的在工作
  assert.match(source, /export function startAutoTrigger\([\s\S]*?\):\s*boolean/u)
  assert.match(startSource, /return true/u)
  assert.match(startSource, /return false/u)
})

test('划词监听启动失败应记录可诊断日志，避免手势失效时无迹可查', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const controllerSource = readFileSync('src/main/selectionListenerController.ts', 'utf8')
  const applyStart = source.indexOf('function applySelectionListener')
  const applySource = source.slice(applyStart, source.indexOf('\n}', applyStart))

  assert.match(applySource, /selectionListenerController\.setMode\(getSettings\(\)\.triggerMode\)/u)
  assert.match(applySource, /!selectionListenerController\.isRunning\(\)/u)
  assert.match(applySource, /console\.warn/u)
  assert.match(controllerSource, /const started = this\.options\.start\(\)/u)
  assert.match(controllerSource, /this\.running = started/u)
  assert.match(controllerSource, /后续 refresh 可重试/u)
})
