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
  // V1.2.1 的行为是打开设置页后翻译弹窗自动关闭，不会留下一个仍可见的
  // 弹窗等待用户点击设置页。当前版本为了让弹窗保持打开引入了设置窗口保护，
  // 但点击设置页时全局按下仍可能落入弹窗关闭路径，而 hidePopup() 会先交还
  // 前台，拿不到源应用记录时退化为 app.hide()→app.show()，把设置页一起隐藏。
  // 因此打开设置页必须走“只隐藏弹窗自身”的入口，禁止复用会隐藏整个应用的
  // hidePopup()。
  assert.match(
    popupSource,
    /export function hidePopupForInternalWindowSwitch\(/u,
    'popup 模块必须提供只隐藏弹窗自身、不交还前台的入口'
  )

  const hideOnlySource = extractFunction(
    popupSource,
    'export function hidePopupForInternalWindowSwitch('
  )
  assert.match(hideOnlySource, /win\?\.hide\(\)|win\.hide\(\)/u, '只隐藏弹窗自身时仍必须真正隐藏窗口')
  assert.doesNotMatch(
    hideOnlySource,
    /handBackFrontmostThen\(/u,
    '只隐藏弹窗自身时不得走前台交还，否则会抢走设置页焦点'
  )
  assert.doesNotMatch(
    hideOnlySource,
    /yieldFrontmostAppThen\(/u,
    '只隐藏弹窗自身时不得走 app.hide()/app.show() 整应用让出'
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
  assert.doesNotMatch(
    openSettingsSource,
    /hidePopup\(\)/u,
    '打开设置页时不得调用会交还前台并可能隐藏整个应用的 hidePopup()'
  )
})

test('保护状态失效后点击可见设置页也不得走整应用关闭路径', () => {
  const pointerSource = extractFunction(indexSource, 'function handleSelectionPointerDown(')

  // 设置窗口 focus/blur 事件顺序并不稳定：guard 可能在全局按下之前被 blur 解除，
  // 此时点击设置页会被分类为 track。若直接调用 dismissPopupOnExternalPointerDown()，
  // 弹窗仍持有 key window 时会走前台交还，最终 app.hide()/app.show() 会把设置页
  // 一起隐藏。命中可见设置窗口时必须改用只隐藏弹窗自身的入口。
  const visibleHitIndex = pointerSource.indexOf('isPointInsideVisibleSettingsWindow(point)')
  const dismissIndex = pointerSource.indexOf('dismissPopupOnExternalPointerDown(point)')
  assert.ok(visibleHitIndex >= 0, '全局按下必须按可见设置窗口矩形识别设置页点击')
  assert.ok(dismissIndex > visibleHitIndex, '设置页命中判断必须早于外部点击关闭兜底')
  assert.match(
    pointerSource,
    /isPointInsideVisibleSettingsWindow\(point\)[\s\S]*?hidePopupForInternalWindowSwitch\(\)/u,
    '点击可见设置窗口时必须只隐藏弹窗自身'
  )
  assert.match(
    pointerSource,
    /if \(result === 'track'\) \{[\s\S]*?isPointInsideVisibleSettingsWindow\(point\)[\s\S]*?return 'ignore'/u,
    '即使保护状态已失效，点击可见设置窗口也不得继续按外部点击处理'
  )
})

test('设置窗口可见时恢复焦点不得走整应用隐藏', () => {
  const resumeSource = extractFunction(
    indexSource,
    'function resumeSettingsWindowFocusAfterSelection('
  )

  // app.hide() 会连用户此前打开、此刻仍在屏上的设置页一起隐藏，app.show() 再把它
  // 显示回来，用户表现为「打开设置页后划词点击“译”，设置页闪一下然后消失」。
  // 设置窗口可见时必须提前返回：仍最前且持有源应用记录时只做 open -b 精确交还，
  // 否则直接恢复可聚焦性；无论如何都不能落到下方会隐藏整个应用的兜底分支。
  const visibleIndex = resumeSource.indexOf('target.isVisible()')
  assert.ok(visibleIndex >= 0, '恢复函数必须先判断设置窗口是否仍然可见')
  const visibleBlockEnd = resumeSource.indexOf('// 省略 ownerToken', visibleIndex)
  assert.ok(visibleBlockEnd > visibleIndex, '可见设置窗口分支必须位于显式打开语义之前')
  const visibleBlock = resumeSource.slice(visibleIndex, visibleBlockEnd)
  assert.match(
    visibleBlock,
    /restoreFrontmostAppForCapture\(\)/u,
    '设置窗口可见且本应用仍最前时只允许精确交还源应用'
  )
  assert.match(
    visibleBlock,
    /return/u,
    '可见设置窗口分支必须提前返回，避免落入整应用安全让出'
  )
  assert.doesNotMatch(
    visibleBlock,
    /yieldFrontmostAppThen\(/u,
    '可见设置窗口分支不得调用 app.hide()/app.show() 整应用让出'
  )
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
  // 此时点击阅读器不能被当作外部点击并调用 dismissPopupOnExternalPointerDown()，
  // 否则 hidePopup() 的前台交还退化路径仍可能隐藏整个应用，让阅读器闪一下。
  const webReaderHitIndex = pointerSource.indexOf('isPointInsideVisibleWebReaderWindow(point)')
  const dismissIndex = pointerSource.indexOf('dismissPopupOnExternalPointerDown(point)')
  assert.ok(webReaderHitIndex >= 0, '全局按下必须识别可见网页阅读器矩形')
  assert.ok(dismissIndex > webReaderHitIndex, '阅读器命中判断必须早于外部点击关闭兜底')
  assert.match(
    pointerSource,
    /isPointInsideVisibleWebReaderWindow\(point\)[\s\S]*?hidePopupForInternalWindowSwitch\(\)/u,
    '点击可见网页阅读器时必须只隐藏弹窗自身'
  )
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
  // 隐式外部点击兜底：若不判断 pinned 就调用 hidePopupForInternalWindowSwitch，
  // 该入口会清掉 pinned 并隐藏弹窗，表现为“固定了窗口，点空白还是会自动关闭”。
  // 注意：从弹窗内显式打开设置/阅读器仍应隐藏弹窗，因此固定判断只能加在
  // 全局按下兜底分支，不能整体加进 hidePopupForInternalWindowSwitch。
  assert.match(indexSource, /isPopupPinned/u, '主进程必须能查询翻译弹窗的固定状态')

  const settingsBranchStart = pointerSource.indexOf(
    'if (isPopupVisible() && isPointInsideVisibleSettingsWindow(point))'
  )
  const settingsHideIndex = pointerSource.indexOf(
    'hidePopupForInternalWindowSwitch()',
    settingsBranchStart
  )
  const webReaderBranchStart = pointerSource.indexOf(
    'if (isPopupVisible() && isPointInsideVisibleWebReaderWindow(point))'
  )
  const webReaderHideIndex = pointerSource.indexOf(
    'hidePopupForInternalWindowSwitch()',
    webReaderBranchStart
  )
  assert.ok(settingsBranchStart >= 0 && settingsHideIndex > settingsBranchStart, '必须识别点击可见设置页')
  assert.ok(webReaderBranchStart >= 0 && webReaderHideIndex > webReaderBranchStart, '必须识别点击可见阅读器')

  const settingsBranch = pointerSource.slice(settingsBranchStart, settingsHideIndex)
  const webReaderBranch = pointerSource.slice(webReaderBranchStart, webReaderHideIndex)
  assert.match(
    settingsBranch,
    /!isPopupPinned\(\)/u,
    '点击可见设置页时必须在固定状态下跳过隐式关闭'
  )
  assert.match(
    webReaderBranch,
    /!isPopupPinned\(\)/u,
    '点击可见阅读器时必须在固定状态下跳过隐式关闭'
  )
})

test('显式打开的设置窗口在划词收尾时不得抢回源应用前台', () => {
  const resumeSource = extractFunction(
    indexSource,
    'function resumeSettingsWindowFocusAfterSelection('
  )

  // 启动时自动打开的设置页只是后台驻留窗口，划词收尾时交还源应用前台可以
  // 避免它突然顶到最前；但用户显式打开的设置页必须保留在当前前台，否则
  // 精确交还 `open -b` 会把源应用拉到最前，用户表现为设置页被一起关掉。
  const explicitIndex = resumeSource.indexOf('settingsWindowExplicitlyOpened')
  const restoreIndex = resumeSource.indexOf('restoreFrontmostAppForCapture()')
  assert.ok(explicitIndex >= 0, '恢复设置页焦点时必须读取设置窗口的显式打开标记')
  assert.ok(restoreIndex > explicitIndex, '显式打开判断必须早于源应用前台交还')
  const explicitBranch = resumeSource.slice(explicitIndex, restoreIndex)
  assert.match(
    explicitBranch,
    /setFocusable\(true\)/u,
    '显式打开的设置窗口只恢复可聚焦性，不得抢回源应用前台'
  )
})

test('启动自动打开必须保留后台设置页语义，内部 activate 不得改变显式标记', () => {
  const readySource = extractFunction(indexSource, 'async function onReady(): Promise<boolean>')
  assert.match(
    readySource,
    /openSettingsOnInitialLaunch[\s\S]*?openSettings\(\{[\s\S]*?explicit:\s*false/u,
    '启动自动打开设置页不得标记为用户显式打开'
  )

  const activateSource = extractFunction(
    indexSource,
    'function activateExistingPageOrOpenSettings()'
  )
  assert.match(
    activateSource,
    /openSettings\(\{ bringToFront: false \}\)/u,
    '内部 activate 不得传入 explicit，避免把用户显式打开的标记降级'
  )
  assert.doesNotMatch(
    activateSource,
    /explicit/u,
    '内部 activate 只负责复用设置页，不应改写用户显式打开语义'
  )
})

test('openSettings 必须按来源维护显式打开标记并在关闭时重置', () => {
  const openSource = extractFunction(indexSource, 'async function openSettings(')
  assert.match(
    openSource,
    /if \(options\.explicit === false\)[\s\S]*?settingsWindowExplicitlyOpened\s*=\s*false/u,
    '只有启动自动打开显式传入 false 时才能降级为后台设置页语义'
  )
  assert.match(
    openSource,
    /else if \(options\.bringToFront !== false\)[\s\S]*?settingsWindowExplicitlyOpened\s*=\s*true/u,
    '用户显式打开入口必须标记为显式打开'
  )

  const createSource = extractFunction(indexSource, 'async function createSettingsWindow(')
  assert.match(
    createSource,
    /if \(settingsWin === createdWindow\)[\s\S]*?settingsWindowExplicitlyOpened\s*=\s*false/u,
    '设置窗口销毁后必须重置显式打开标记，避免下一个窗口继承错误语义'
  )
})
