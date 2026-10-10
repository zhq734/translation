import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const popupSource = readFileSync('src/main/popup.ts', 'utf8')
const indexSource = readFileSync('src/main/index.ts', 'utf8')

/**
 * 截取源码中指定函数的完整片段。
 *
 * 约定目标函数为顶层声明，函数结束的 `}` 顶格出现，便于稳定定位边界。
 * @param source 待检索的源码。
 * @param signature 函数签名起始片段。
 * @returns 从签名到函数结束的源码。
 * @author zhenghq
 */
function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `应存在函数 ${signature}`)
  const end = source.indexOf('\n}', start)
  assert.ok(end > start, `函数 ${signature} 应有结束边界`)
  return source.slice(start, end + 2)
}

/**
 * 去掉源码中的块注释与行注释，避免注释里出现的函数名干扰“不得调用”断言。
 * @param source 源码。
 * @returns 移除注释后的源码。
 * @author zhenghq
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

test('从翻译弹窗打开设置时，弹窗失焦不得自动关闭', () => {
  assert.match(
    popupSource,
    /export function beginPopupSettingsOpenGuard\(/u,
    '必须提供设置打开期间的弹窗失焦保护入口'
  )
  assert.match(
    popupSource,
    /export function endPopupSettingsOpenGuard\(/u,
    '必须提供设置打开期间的弹窗失焦保护解除入口'
  )
  assert.match(
    popupSource,
    /export function isPopupSettingsOpenGuardActive\(/u,
    '必须提供保护状态查询入口，供全局按下判定复用'
  )

  const blurSource = extractFunction(popupSource, 'function handlePopupBlur()')
  const guardIndex = blurSource.indexOf('settingsOpenGuardActive')
  const hideIndex = blurSource.indexOf('hidePopup()')
  assert.ok(guardIndex >= 0, '失焦处理必须识别设置打开保护状态')
  assert.ok(guardIndex < hideIndex, '设置打开保护必须发生在自动关闭判断之前')
})

test('打开设置请求必须先开启失焦保护，失败时立即解除', () => {
  const openSettingsIndex = indexSource.indexOf("ipcMain.on('settings:open'")
  assert.ok(openSettingsIndex >= 0, '必须注册 settings:open IPC')

  const handlerSource = extractFunction(indexSource, 'function openSettingsFromPopup()')
  assert.match(
    handlerSource,
    /beginPopupSettingsOpenGuard\(\)/u,
    '处理打开设置请求时必须先进入弹窗失焦保护'
  )
  assert.match(handlerSource, /openSettings\(\)/u, '打开设置请求必须调用 openSettings')
  assert.ok(
    handlerSource.indexOf('beginPopupSettingsOpenGuard()') <
      handlerSource.indexOf('openSettings()'),
    '必须先开启保护再打开设置窗口'
  )
  // 打开失败时设置窗口不会产生 focus/blur 生命周期事件，保护必须自行解除，
  // 否则弹窗会永久忽略失焦，退回「点外部不消失」。
  assert.match(
    handlerSource,
    /catch[\s\S]*?endPopupSettingsOpenGuard\(\)/u,
    '打开设置失败时必须解除弹窗失焦保护'
  )
})

test('设置窗口生命周期必须正确开关弹窗失焦保护', () => {
  const createSource = extractFunction(indexSource, 'async function createSettingsWindow(')

  const focusIndex = createSource.indexOf("settingsWin.on('focus'")
  const blurIndex = createSource.indexOf("settingsWin.on('blur'")
  const hideIndex = createSource.indexOf("settingsWin.on('hide'")
  const closedIndex = createSource.indexOf("settingsWin.on('closed'")
  assert.ok(focusIndex >= 0 && blurIndex > focusIndex, '必须监听设置窗口 focus 与 blur')
  assert.ok(hideIndex > blurIndex, '必须监听设置窗口 hide')
  assert.ok(closedIndex > hideIndex, '必须监听设置窗口 closed')

  const focusBlock = createSource.slice(focusIndex, blurIndex)
  const blurBlock = createSource.slice(blurIndex, hideIndex)
  const hideBlock = createSource.slice(hideIndex, closedIndex)
  const closedBlock = createSource.slice(closedIndex)

  // 复用已可见窗口时 focus 事件可能不再派发，因此 IPC 入口已提前开启保护；
  // focus 时再次开启用于重置保护，确保随后到来的失焦一定被吸收。
  assert.match(focusBlock, /beginPopupSettingsOpenGuard\(\)/u, '设置窗口获得焦点时必须进入保护')
  assert.match(blurBlock, /endPopupSettingsOpenGuard\(\)/u, '设置窗口失焦时必须解除保护')
  assert.match(hideBlock, /endPopupSettingsOpenGuard\(\)/u, '设置窗口隐藏时必须解除保护')
  assert.match(closedBlock, /endPopupSettingsOpenGuard\(\)/u, '设置窗口销毁时必须解除保护')
})

test('保护期内点击设置窗口不得被判定为弹窗外部点击', () => {
  const pointerSource = extractFunction(indexSource, 'function handleSelectionPointerDown(')

  // 设置窗口 focus 事件可能晚于全局 mousedown 到达，此时 isFocused() 仍为 false，
  // 仅依赖焦点判定会把点击设置页误判为外部点击并关闭翻译弹窗。
  assert.match(
    pointerSource,
    /isPopupSettingsOpenGuardActive\(\)/u,
    '全局按下判定必须识别设置打开保护状态'
  )
  assert.match(
    pointerSource,
    /isPointInsideVisibleSettingsWindow\(/u,
    '保护期内必须按设置窗口可见矩形识别应用内点击'
  )
  assert.match(
    pointerSource,
    /const settingsWindowHit = isPopupSettingsOpenGuardActive\(\)\s*&&\s*isPointInsideVisibleSettingsWindow\(point\)/u,
    '设置窗口命中只能由保护状态与可见矩形决定，不能依赖迟到的应用激活事件'
  )
  // 设置窗口已经获得焦点后，macOS 的 did-become-active 仍可能晚于全局 mousedown；
  // 若在命中判定中叠加应用激活事件门禁，本次点击会被误分类为 track，随后
  // dismissPopupOnExternalPointerDown → hidePopup 会把前台交还给源应用并关掉设置页。
  assert.doesNotMatch(
    pointerSource,
    /resolveAppFrontmostForExclusion\(/u,
    '设置窗口内部按下不得受应用激活事件门禁影响'
  )

  const guardIndex = pointerSource.indexOf('isPopupSettingsOpenGuardActive()')
  const classifyIndex = pointerSource.indexOf('classifySelectionPointerDown(')
  assert.ok(guardIndex >= 0 && classifyIndex > guardIndex, '保护判定必须早于按下分类')
})

test('设置窗口失焦后再次获得焦点必须重新进入保护期', () => {
  const createSource = extractFunction(indexSource, 'async function createSettingsWindow(')
  const focusIndex = createSource.indexOf("settingsWin.on('focus'")
  const blurIndex = createSource.indexOf("settingsWin.on('blur'")
  assert.ok(focusIndex >= 0 && blurIndex > focusIndex, '必须监听设置窗口 focus 与 blur')

  // 用户先点击其它应用让设置窗口失焦（保护解除），随后再次点击仍打开的设置页时，
  // 只会派发 focus 而不会再走 IPC 入口；若不在此重新开启保护，第二次点击设置页
  // 又会被全局按下误判为弹窗外部点击，弹窗被一起关闭，问题复发。
  const focusBlock = createSource.slice(focusIndex, blurIndex)
  assert.match(
    focusBlock,
    /beginPopupSettingsOpenGuard\(\)/u,
    '设置窗口每次获得焦点都必须重新进入保护期'
  )
})

test('从翻译弹窗打开设置时必须只隐藏弹窗自身', () => {
  // panel 落地后 hidePopup() 本身已只隐藏窗口自身，但仍保留显式语义入口，
  // 避免后续维护者把内部窗口切换误接到别的收尾路径。
  assert.match(
    popupSource,
    /export function hidePopupForInternalWindowSwitch\(/u,
    'popup 模块必须提供只隐藏弹窗自身、不交还前台的入口'
  )

  const hideOnlySource = extractFunction(
    popupSource,
    'export function hidePopupForInternalWindowSwitch('
  )
  // hidePopup() 在 panel 语义下已只隐藏窗口自身，委托入口不得再引入任何
  // 应用级收尾；断言委托关系与 hidePopup 的直接隐藏实现。
  assert.match(hideOnlySource, /hidePopup\(\)/u, '只隐藏弹窗自身时必须委托 hidePopup')
  assert.match(
    stripComments(extractFunction(popupSource, 'export function hidePopup(): void {')),
    /win\.hide\(\)/u,
    'hidePopup 必须真正隐藏窗口'
  )
  assert.doesNotMatch(
    hideOnlySource,
    /handBackFrontmostThen|yieldFrontmostAppThen|app\.hide\(\)/u,
    '只隐藏弹窗自身时不得走应用级前台交还或整应用让出'
  )

  const openSettingsSource = stripComments(
    extractFunction(indexSource, 'function openSettingsFromPopup()')
  )
  assert.match(
    openSettingsSource,
    /hidePopupForInternalWindowSwitch\(\)/u,
    '打开设置页前必须先只隐藏翻译弹窗自身'
  )
  assert.ok(
    openSettingsSource.indexOf('hidePopupForInternalWindowSwitch()') <
      openSettingsSource.indexOf('openSettings()'),
    '必须先关闭翻译弹窗，再打开设置页，避免弹窗关闭路径影响设置页'
  )
  assert.doesNotMatch(openSettingsSource, /handBackFrontmostThen|yieldFrontmostAppThen/u,
    '打开设置页时不得走应用级前台交还')
})

test('固定弹窗时从弹窗内打开设置页或阅读器不得关闭弹窗', () => {
  const openSettingsSource = stripComments(
    extractFunction(indexSource, 'function openSettingsFromPopup()')
  )
  const openWebReaderSource = stripComments(
    extractFunction(indexSource, 'function openWebReaderFromPopup(')
  )

  // 固定（图钉）是用户显式表达的“保持可见”意图。此后从弹窗内打开设置页或
  // 网页阅读器属于应用内部窗口切换，只能让目标窗口置前，不得清掉 pinned 并
  // 隐藏翻译弹窗；否则用户会看到固定窗口在内部跳转时被自动关闭。
  for (const [name, source] of [
    ['设置页', openSettingsSource],
    ['网页阅读器', openWebReaderSource]
  ] as const) {
    const pinnedIndex = source.indexOf('isPopupPinned()')
    const hideIndex = source.indexOf('hidePopupForInternalWindowSwitch()')
    assert.ok(pinnedIndex >= 0, `打开${name}前必须判断弹窗是否已固定`)
    assert.ok(hideIndex > pinnedIndex, `打开${name}时固定判断必须早于隐藏动作`)
    assert.match(
      source,
      /if\s*\(!isPopupPinned\(\)\)[\s\S]*?hidePopupForInternalWindowSwitch\(\)/u,
      `打开${name}时只能在弹窗未固定时隐藏弹窗自身`
    )
  }
})

test('保护状态失效后点击可见设置页也不得走整应用关闭路径', () => {
  const pointerSource = extractFunction(indexSource, 'function handleSelectionPointerDown(')

  // 设置窗口 focus/blur 事件顺序并不稳定：guard 可能在全局按下之前被 blur 解除。
  // 点击可见设置页仍属于应用内交互，不得落入外部点击关闭兜底。
  const visibleHitIndex = pointerSource.indexOf('isPointInsideVisibleSettingsWindow(point)')
  const dismissIndex = pointerSource.indexOf('dismissPopupOnExternalPointerDown(point)')
  assert.ok(visibleHitIndex >= 0, '全局按下必须按可见设置窗口矩形识别设置页点击')
  assert.ok(dismissIndex > visibleHitIndex, '设置页命中判断必须早于外部点击关闭兜底')
  assert.match(
    pointerSource,
    /if \(result === 'track'\) \{[\s\S]*?isPointInsideVisibleSettingsWindow\(point\)[\s\S]*?return 'ignore'/u,
    '即使保护状态已失效，点击可见设置窗口也不得继续按外部点击处理'
  )
})

test('设置窗口只保留最小焦点挂起机制，复杂补偿链必须删除', () => {
  const code = stripComments(indexSource)

  // panel 只阻止激活整个应用，无法阻止系统在应用内部把设置页选为 key window。
  // 因此最小焦点挂起机制必须保留；上一版补偿实现遗留的代际号与定时器仍须删除。
  for (const removed of [
    'settingsWindowFocusResumeTimer',
    'clearSettingsWindowFocusResume',
    'finishSettingsWindowFocusSuspension',
    'scheduleSettingsWindowFocusResume'
  ]) {
    assert.ok(!code.includes(removed), `index.ts 不应再包含 ${removed}`)
  }
})

test('从翻译弹窗打开网页阅读器时必须只隐藏弹窗自身', () => {
  // 网页阅读器与设置页同属应用内部窗口切换：打开阅读器时阅读器会 show()/focus()
  // 抢走翻译弹窗焦点，若弹窗保持可见，后续点击阅读器会落入全局按下关闭兜底，
  // 而 hidePopup() 的前台交还退化路径可能把阅读器一起隐藏。因此必须复用
  // “只隐藏弹窗自身”的入口，禁止调用会隐藏整个应用的 hidePopup()。
  const openWebReaderSource = stripComments(
    extractFunction(indexSource, 'function openWebReaderFromPopup(')
  )
  assert.match(
    openWebReaderSource,
    /hidePopupForInternalWindowSwitch\(\)/u,
    '打开网页阅读器前必须先只隐藏翻译弹窗自身'
  )
  assert.ok(
    openWebReaderSource.indexOf('hidePopupForInternalWindowSwitch()') <
      openWebReaderSource.indexOf('getWebReader()'),
    '必须先隐藏翻译弹窗，再打开网页阅读器，避免弹窗关闭路径影响阅读器'
  )
  assert.doesNotMatch(
    openWebReaderSource,
    /hidePopup\(\)/u,
    '打开网页阅读器时不得调用会交还前台并可能隐藏整个应用的 hidePopup()'
  )
})

test('webview:open IPC 必须复用只隐藏弹窗自身的入口', () => {
  const start = indexSource.indexOf("ipcMain.on('webview:open'")
  assert.ok(start >= 0, '必须注册 webview:open IPC')
  const end = indexSource.indexOf("ipcMain.on('webview:close'", start)
  assert.ok(end > start, 'webview:open 处理器必须位于 webview:close 之前')
  const handlerSource = indexSource.slice(start, end)
  assert.match(
    handlerSource,
    /openWebReaderFromPopup\(/u,
    'webview:open 必须通过只隐藏弹窗自身的入口打开阅读器'
  )
  assert.doesNotMatch(
    stripComments(handlerSource),
    /hidePopup\(\)/u,
    'webview:open 不得调用会隐藏整个应用的 hidePopup()'
  )
})

test('点击可见网页阅读器不得走整应用关闭路径', () => {
  const pointerSource = extractFunction(indexSource, 'function handleSelectionPointerDown(')

  // 打开阅读器后翻译弹窗已隐藏，但阅读器仍可能先派发全局 mousedown 再更新焦点。
  // 此时点击阅读器不能被当作外部点击并调用 dismissPopupOnExternalPointerDown()。
  const webReaderHitIndex = pointerSource.indexOf('isPointInsideVisibleWebReaderWindow(point)')
  const dismissIndex = pointerSource.indexOf('dismissPopupOnExternalPointerDown(point)')
  assert.ok(webReaderHitIndex >= 0, '全局按下必须识别可见网页阅读器矩形')
  assert.ok(dismissIndex > webReaderHitIndex, '阅读器命中判断必须早于外部点击关闭兜底')
  assert.match(
    pointerSource,
    /if \(result === 'track'\) \{[\s\S]*?isPointInsideVisibleWebReaderWindow\(point\)[\s\S]*?return 'ignore'/u,
    '点击可见网页阅读器时不得继续按外部点击处理'
  )
})

test('弹窗自身命中必须优先于已打开设置页或阅读器的内部窗口兜底', () => {
  const pointerSource = extractFunction(indexSource, 'function handleSelectionPointerDown(')

  // 第二次从翻译弹窗点击“设置/翻译页面”时，设置页或阅读器窗口可能已经可见，
  // 且与弹窗坐标区域重叠。全局 mousedown 会先于 IPC 到达，如果先判断可见设置页/
  // 阅读器矩形并调用 hidePopupForInternalWindowSwitch()，弹窗会被提前隐藏，
  // 表现为第二次点击直接关闭、窗口打不开。必须保证点击弹窗自身时先 return，
  // 让按钮 IPC 正常发出。
  const popupHitIndex = pointerSource.indexOf('const popupHit = isPointInsidePopup(point)')
  const popupReturnIndex = pointerSource.indexOf("if (popupHit && primaryButton) return 'ignore'", popupHitIndex)
  const classifyIndex = pointerSource.indexOf('classifySelectionPointerDown(')
  const settingsHitIndex = pointerSource.indexOf('isPointInsideVisibleSettingsWindow(point)', popupReturnIndex)
  const webReaderHitIndex = pointerSource.indexOf('isPointInsideVisibleWebReaderWindow(point)', popupReturnIndex)
  assert.ok(popupHitIndex >= 0, '必须计算弹窗命中状态')
  assert.ok(popupReturnIndex > popupHitIndex, '弹窗命中后必须立即短路')
  assert.ok(classifyIndex > popupReturnIndex, '弹窗自身短路必须早于按下分类')
  assert.ok(settingsHitIndex > popupReturnIndex, '弹窗自身命中必须早于设置页内部窗口兜底')
  assert.ok(webReaderHitIndex > popupReturnIndex, '弹窗自身命中必须早于阅读器内部窗口兜底')
})

test('连续第二次打开设置页或阅读器时，打开动作完成后仍必须维持内部窗口保护', () => {
  const openSettingsSource = stripComments(
    extractFunction(indexSource, 'function openSettingsFromPopup()')
  )
  const openWebReaderSource = stripComments(
    extractFunction(indexSource, 'function openWebReaderFromPopup(')
  )

  // 第二次打开时设置页/阅读器已经可见，复用窗口的 show()/focus() 不保证再次派发
  // focus 事件；同时弹窗隐藏引发的 blur 可能把 guard 清掉，随后全局按下会把
  // 刚打开的窗口再次当成外部点击关闭。两个入口都必须在隐藏弹窗后重新开启保护，
  // 且保护开启必须早于异步打开动作。
  assert.ok(
    openSettingsSource.indexOf('beginPopupSettingsOpenGuard()') > openSettingsSource.indexOf('hidePopupForInternalWindowSwitch()'),
    '打开设置页后必须重新开启内部窗口保护'
  )
  assert.ok(
    openSettingsSource.indexOf('beginPopupSettingsOpenGuard()') < openSettingsSource.indexOf('openSettings()'),
    '设置页保护必须早于异步打开动作'
  )
  assert.ok(
    openWebReaderSource.indexOf('beginPopupSettingsOpenGuard()') > openWebReaderSource.indexOf('hidePopupForInternalWindowSwitch()'),
    '打开阅读器后必须重新开启内部窗口保护'
  )
  assert.ok(
    openWebReaderSource.indexOf('beginPopupSettingsOpenGuard()') < openWebReaderSource.indexOf('getWebReader()'),
    '阅读器保护必须早于异步打开动作'
  )
})

test('网页阅读器关闭时必须解除弹窗保护', () => {
  const webReaderSource = readFileSync('src/main/webReaderWindow.ts', 'utf8')
  const ensureSource = extractFunction(webReaderSource, 'private async ensureWindow()')

  assert.match(
    webReaderSource,
    /onInternalWindowFocusLost\?:/u,
    '阅读器管理器必须提供内部窗口失焦生命周期回调'
  )
  assert.match(
    ensureSource,
    /on\('closed'[\s\S]*?onInternalWindowFocusLost/u,
    '阅读器窗口关闭时必须通知主进程解除弹窗保护'
  )
  assert.match(
    indexSource,
    /onInternalWindowFocusLost:\s*\(\)\s*=>\s*\{[\s\S]*?BrowserWindow\.getFocusedWindow\(\)[\s\S]*?endPopupSettingsOpenGuard\(\)/u,
    '主进程必须把阅读器生命周期回调接到弹窗保护解除入口'
  )
})

test('网页阅读器失焦只有在焦点离开所有自有窗口时才解除弹窗保护', () => {
  const webReaderSource = readFileSync('src/main/webReaderWindow.ts', 'utf8')
  const ensureSource = extractFunction(webReaderSource, 'private async ensureWindow()')

  assert.match(
    ensureSource,
    /on\('blur'[\s\S]*?onInternalWindowFocusLost/u,
    '阅读器失焦时必须通知主进程判断是否解除弹窗保护'
  )
  assert.match(
    indexSource,
    /onInternalWindowFocusLost:\s*\(\)\s*=>\s*\{[\s\S]*?BrowserWindow\.getFocusedWindow\(\)[\s\S]*?endPopupSettingsOpenGuard\(\)/u,
    '主进程必须在焦点确实离开所有自有窗口后才解除弹窗保护'
  )
})

test('固定弹窗时点击可见设置页或阅读器区域不得自动关闭弹窗', () => {
  const pointerSource = extractFunction(indexSource, 'function handleSelectionPointerDown(')

  // 固定弹窗的语义是隐式路径不再自动关闭。点击可见设置页/阅读器矩形属于
  // 应用内交互，必须直接忽略本次按下，固定弹窗更不能被隐藏。
  assert.match(indexSource, /isPopupPinned/u, '主进程必须能查询翻译弹窗的固定状态')

  const settingsIgnoreIndex = pointerSource.indexOf(
    "if (isPopupVisible() && isPointInsideVisibleSettingsWindow(point))"
  )
  const webReaderIgnoreIndex = pointerSource.indexOf(
    "if (isPopupVisible() && isPointInsideVisibleWebReaderWindow(point))"
  )
  assert.ok(settingsIgnoreIndex >= 0, '必须识别点击可见设置页')
  assert.ok(webReaderIgnoreIndex >= 0, '必须识别点击可见阅读器')
  const settingsBlock = pointerSource.slice(settingsIgnoreIndex, settingsIgnoreIndex + 160)
  const webReaderBlock = pointerSource.slice(webReaderIgnoreIndex, webReaderIgnoreIndex + 160)
  assert.match(settingsBlock, /return 'ignore'/u, '点击可见设置页必须直接忽略')
  assert.match(webReaderBlock, /return 'ignore'/u, '点击可见阅读器必须直接忽略')
})

test('启动自动打开与 Dock activate 都必须把设置页置前', () => {
  const readySource = extractFunction(indexSource, 'async function onReady(): Promise<boolean>')
  // 应用启动是明确的用户入口：设置页必须主动放到最前，否则会被其它应用遮挡，
  // 用户会误以为设置页没有打开。该语义只属于启动首开，不能扩散到内部 activate。
  assert.match(
    readySource,
    /openSettingsOnInitialLaunch[\s\S]*?openSettings\(\{[\s\S]*?bringToFront:\s*true/u,
    '启动自动打开设置页必须把窗口置顶'
  )

  const activateSource = extractFunction(
    indexSource,
    'function activateExistingPageOrOpenSettings()'
  )
  assert.match(
    activateSource,
    /openSettings\(\{ bringToFront: true \}\)/u,
    'Dock activate 是显式入口，必须把已可见设置页置前'
  )
  assert.doesNotMatch(
    activateSource,
    /explicit/u,
    '内部 activate 不应再依赖已删除的显式打开标记'
  )
})

test('openSettings 必须按来源决定是否置顶且不得再维护显式打开标记', () => {
  const openSource = extractFunction(indexSource, 'async function openSettings(')

  assert.match(
    openSource,
    /createSettingsWindow\(options\.bringToFront \?\? true\)/u,
    'openSettings 必须把是否置顶透传给 createSettingsWindow'
  )
  assert.doesNotMatch(openSource, /settingsWindowExplicitlyOpened/u,
    'panel 落地后不得再维护显式打开补偿标记')
  assert.doesNotMatch(stripComments(indexSource), /settingsWindowExplicitlyOpened/u,
    '整个主进程不得再引用显式打开补偿标记')
})
