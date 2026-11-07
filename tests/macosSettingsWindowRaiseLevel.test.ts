import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * 截取源码中指定函数的完整片段。
 * @param source 待检索源码。
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
 * 去掉源码注释，避免注释中的历史名称干扰断言。
 * @param source 源码。
 * @returns 移除注释后的源码。
 * @author zhenghq
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

const mainSource = readFileSync('src/main/index.ts', 'utf8')

test('设置页临时提升层级后必须有界回收，不能只依赖 blur 事件', () => {
  const helperSource = stripComments(
    extractFunction(mainSource, 'function showOwnWindowForInteraction(')
  )

  // nonactivating panel 的 blur 事件在 macOS 上不保证派发；若只依赖 blur 降级，
  // 设置页会长期保持 screen-saver 层级，划词时便会概率性浮到最前。
  assert.match(
    helperSource,
    /setAlwaysOnTop\(true,\s*'screen-saver'\)/u,
    '显式置前仍应临时提升层级'
  )
  assert.match(
    helperSource,
    /scheduleSettingsPanelRaiseLevelReset\(\)/u,
    '显式置前必须安排有界回收'
  )
  const resetSource = stripComments(
    extractFunction(mainSource, 'function scheduleSettingsPanelRaiseLevelReset(')
  )
  assert.match(resetSource, /setTimeout\(/u, '层级回收必须使用有界定时器')
  assert.match(
    resetSource,
    /lowerSettingsPanelRaiseLevel\(\)/u,
    '定时器到期必须复用带后台保护判断的统一回收器归还普通层级'
  )
})

test('网页阅读器临时提升层级后必须复用同一回收器', () => {
  const helperSource = stripComments(
    extractFunction(mainSource, 'function showOwnWindowForInteraction(')
  )
  const lowerSource = stripComments(
    extractFunction(mainSource, 'function lowerSettingsPanelRaiseLevel(')
  )
  const resetSource = stripComments(
    extractFunction(mainSource, 'function scheduleSettingsPanelRaiseLevelReset(')
  )

  // 设置页与网页阅读器共用 showOwnWindowForInteraction()，因此阅读器也会被
  // 临时提升到 screen-saver。回收器若只处理 settingsWin，阅读器会永久置顶；
  // 必须记录本次提升过的窗口，并在定时器、失焦和划词入口统一降级。
  assert.match(
    helperSource,
    /raisedInteractionWindows\.add\(win\)/u,
    '统一置前入口必须登记被提升层级的窗口'
  )
  assert.match(
    lowerSource,
    /raisedInteractionWindows/u,
    '立即回收必须遍历所有被提升层级的自有窗口'
  )
  assert.match(
    resetSource,
    /lowerSettingsPanelRaiseLevel\(\)/u,
    '定时回收必须复用会遍历所有被提升窗口的统一回收器'
  )
})

test('划词手势开始时必须主动把设置页降回普通层级', () => {
  const scheduleSource = stripComments(
    extractFunction(mainSource, 'function scheduleSelectionAction(')
  )
  const gestureSource = stripComments(
    extractFunction(mainSource, 'function handleSelectionGesture(')
  )

  // 划词是纯内部交互，不能受设置页残留的最高层级影响；手势一开始就必须降级，
  // 而不是等按钮/弹窗状态或 blur 事件到达。
  assert.match(
    `${scheduleSource}\n${gestureSource}`,
    /lowerSettingsPanelRaiseLevel\(\)/u,
    '划词开始路径必须主动回收设置页的临时置顶层级'
  )
})

test('划词开始回收层级后必须留下可核验的普通层级状态', () => {
  const scheduleSource = stripComments(
    extractFunction(mainSource, 'function scheduleSelectionAction(')
  )

  // 真机日志只记录 initial-launch-final 时的 isAlwaysOnTop=true，后续划词入口
  // 即使执行了回收也没有证据。必须在划词入口同步降级后记录窗口层级与焦点状态，
  // 便于确认设置页确实已退出 screen-saver，而不是仅清空了内部登记集合。
  assert.match(
    scheduleSource,
    /lowerSettingsPanelRaiseLevel\(\)[\s\S]*?logSettingsPanelBringToFront\([^)]*selection/u,
    '划词入口必须在层级回收后记录设置页状态'
  )
})

test('划词开始必须先回收设置页层级再续期保护期', () => {
  const scheduleSource = stripComments(
    extractFunction(mainSource, 'function scheduleSelectionAction(')
  )

  // lowerSettingsPanelRaiseLevel() 在保护期内只能清空内部登记，不会实际写窗口层级。
  // 若先续期保护期再调用回收，真正的 setAlwaysOnTop(false) 永远不会发生；必须
  // 先在旧的保护状态内完成实际回收，再续期本次划词的 activate 抑制。
  const lowerIndex = scheduleSource.indexOf('lowerSettingsPanelRaiseLevel()')
  const suppressIndex = scheduleSource.indexOf('suppressSelectionActivationWindowGap()')
  assert.ok(lowerIndex >= 0, '划词开始必须回收设置页临时层级')
  assert.ok(suppressIndex >= 0, '划词开始必须续期 activate 抑制')
  assert.ok(
    lowerIndex < suppressIndex,
    '必须先在旧保护状态内实际回收层级，再续期本次划词保护期'
  )
})

test('应用失活或处于划词保护期时不得对后台设置页调用 setAlwaysOnTop', () => {
  const lowerSource = stripComments(
    extractFunction(mainSource, 'function lowerSettingsPanelRaiseLevel(')
  )
  const resetSource = stripComments(
    extractFunction(mainSource, 'function scheduleSettingsPanelRaiseLevelReset(')
  )

  // 最新真机日志里设置页已经可见且 appActive=false，划词入口仍对后台窗口执行
  // setAlwaysOnTop(false)。macOS 会因此重新计算窗口层级并可能把设置页选成 key
  // window，表现为首次划词时设置页闪到最前。保护期内只能清理内部登记，不能
  // 对后台窗口做任何层级写操作；定时回收也必须复用同一保护判断。
  assert.match(
    lowerSource,
    /isMacAppActiveByEvents\(\)[\s\S]*?isSelectionWindowRaiseGuardActive\(\)/u,
    '立即回收必须先判断应用激活状态与划词保护期'
  )
  assert.match(
    lowerSource,
    /isSelectionWindowRaiseGuardActive\(\)[\s\S]*?raisedInteractionWindows\.clear\(\)/u,
    '保护期内必须只清理登记而不修改窗口层级'
  )
  assert.match(
    resetSource,
    /lowerSettingsPanelRaiseLevel\(\)/u,
    '定时回收必须复用带后台保护判断的统一回收入口'
  )
})

test('应用失活时必须强制撤销临时最高层级，避免设置页永久悬浮', () => {
  const forceLowerSource = stripComments(
    extractFunction(mainSource, 'function forceLowerRaisedInteractionWindows(')
  )
  const resignHandlerSource = mainSource.slice(
    mainSource.indexOf("app.on('did-resign-active'"),
    mainSource.indexOf("app.on('activate'", mainSource.indexOf("app.on('did-resign-active'"))
  )

  // 应用失活后就进入新的前后台语义：普通回收器为避免重排可能跳过窗口层级
  // 写入，但此时若不强制撤销 screen-saver 层级，设置页会一直盖在其它应用上。
  // 必须由 did-resign-active 做一次无焦点、仅降级的强制回收，并让所有在途
  // Dock 置前请求失效，用户再次激活后也只能由最新显式入口重新置前。
  assert.match(forceLowerSource, /setAlwaysOnTop\(false\)/u,
    '应用失活专用回收器必须真正把窗口降回普通层级')
  assert.ok(resignHandlerSource.length > 0, '必须监听 macOS 应用失活事件')
  assert.match(resignHandlerSource, /settingsDockActivationEpoch\s*\+=\s*1/u,
    '应用失活必须使所有旧 Dock 置前请求失效')
  assert.match(resignHandlerSource, /settingsBringToFrontEpoch\s*\+=\s*1/u,
    '应用失活必须使所有旧设置页置前意图失效')
  assert.match(resignHandlerSource, /forceLowerRaisedInteractionWindows\(\)/u,
    '应用失活必须强制撤销临时最高层级')
})

test('提升登记被失焦清理后，应用失活仍须覆盖设置页与阅读器本身', () => {
  const forceLowerSource = stripComments(
    extractFunction(mainSource, 'function forceLowerRaisedInteractionWindows(')
  )

  // 设置页 blur 可能早于 did-resign-active；普通回收器此时会因为应用已失活
  // 只清理登记，不再写窗口层级。强制回收器不能只遍历登记集合，否则随后执行
  // 时集合已空，设置页仍永久停留在 screen-saver 层级。必须同时把已知的
  // 设置页和网页阅读器窗口纳入兜底候选。
  assert.match(
    forceLowerSource,
    /settingsWin/u,
    '强制回收必须兜底覆盖设置页实例'
  )
  assert.match(
    forceLowerSource,
    /webReader\?\.getWindow\(\)/u,
    '强制回收必须兜底覆盖网页阅读器实例'
  )
})

test('已可见的后台设置页不得被静默显示重复顶到前台', () => {
  const helperSource = stripComments(
    extractFunction(mainSource, 'function showOwnWindowForInteraction(')
  )
  const createStart = mainSource.indexOf('async function createSettingsWindow(')
  const createEnd = mainSource.indexOf('/**\n * 打开设置窗口。', createStart)
  const createSource = stripComments(mainSource.slice(createStart, createEnd))
  const existingBranch = createSource.slice(
    createSource.indexOf('if (settingsWin && !settingsWin.isDestroyed())'),
    createSource.indexOf('const createdWindow = new BrowserWindow')
  )

  // 真机日志中设置页 isVisible=true、appActive=false，但弹窗关闭和 Dock 刷新
  // 仍反复走 show()。macOS 的 BrowserWindow.show() 会参与 key window 与 z-order
  // 重排，即使紧接着不 focus()/moveTop() 也可能让后台设置页闪现。统一入口必须
  // 对已可见窗口保持静默；真正显式置前仍由后续 moveTop()/focus() 完成。
  assert.match(
    helperSource,
    /if \(!win\.isVisible\(\)\) win\.show\(\)/u,
    '统一入口只能在窗口不可见时调用 show()'
  )
  assert.doesNotMatch(
    existingBranch,
    /showOwnWindowForInteraction\(settingsWin,\s*\{\s*focus:\s*false,\s*moveTop:\s*false,\s*raiseLevel:\s*false\s*\}\)/u,
    '复用已可见窗口的后台刷新分支不得再调用静默显示入口'
  )
})

test('设置页建窗在刷新 Dock 前后都必须复核划词保护状态', () => {
  const createStart = mainSource.indexOf('async function createSettingsWindow(')
  const createEnd = mainSource.indexOf('/**\n * 打开设置窗口。', createStart)
  const createSource = stripComments(mainSource.slice(createStart, createEnd))
  const existingIndex = createSource.indexOf('if (settingsWin && !settingsWin.isDestroyed())')
  const firstAwaitIndex = createSource.indexOf('await refreshMacOSDockVisibility()', existingIndex)
  const secondAwaitIndex = createSource.indexOf('await refreshMacOSDockVisibility()', firstAwaitIndex + 1)
  const afterFirstAwait = createSource.slice(firstAwaitIndex, secondAwaitIndex)

  assert.ok(existingIndex >= 0 && firstAwaitIndex > existingIndex)
  assert.match(
    createSource.slice(existingIndex, firstAwaitIndex),
    /canCompleteSettingsBringToFront|isSelectionWindowRaiseGuardActive/u,
    '复用窗口进入异步 Dock 刷新前必须先校验置前意图'
  )
  assert.match(
    afterFirstAwait,
    /bringToFrontEpochAtStart\s*!==\s*settingsBringToFrontEpoch[\s\S]*?isSelectionWindowRaiseGuardActive\(\)/u,
    'Dock 刷新返回后必须再次校验代际与划词保护期'
  )
})

test('弹窗关闭开始与真实隐藏后都必须回收设置页临时层级', () => {
  const closeStartSource = stripComments(
    extractFunction(mainSource, 'function handlePopupCloseStart(')
  )
  const closeEndSource = stripComments(
    extractFunction(mainSource, 'function handlePopupCloseEnd(')
  )
  const transitionSource = stripComments(
    extractFunction(mainSource, 'function handlePopupInternalWindowTransition(')
  )

  // 外部点击关闭弹窗后，前台交还和真实 hide 都是异步的；设置页若仍保留
  // screen-saver 层级，系统会在隐藏 panel 时把它重新选为 key window。关闭开始
  // 必须立即降级，真实隐藏完成后还要再降一次，覆盖交还期间重新提升的竞态。
  assert.match(
    closeStartSource,
    /handlePopupInternalWindowTransition\(\)/u,
    '弹窗关闭开始必须进入统一的内部窗口收尾流程'
  )
  assert.match(
    closeEndSource,
    /handlePopupInternalWindowTransition\(\)/u,
    '弹窗真实隐藏后必须再次进入统一的内部窗口收尾流程'
  )
  assert.match(
    transitionSource,
    /lowerSettingsPanelRaiseLevel\(\)/u,
    '统一收尾流程必须实际回收设置页临时层级'
  )
})

test('划词流程收尾与结果弹窗显示时必须续期 activate 抑制，覆盖翻译耗时', () => {
  const releaseSource = stripComments(
    extractFunction(mainSource, 'function releaseSelectionInteraction(')
  )

  // 翻译结果弹窗通常在划词手势 1~3 秒后才 show()，初始的短抑制窗口早已过期。
  // 若不在释放交互 token 时续期，结果弹窗触发的 activate 会被误判为 Dock 点击，
  // 从而把已打开的设置页重新拉到最前。
  assert.match(
    releaseSource,
    /suppressSelectionActivationWindowGap\(\)/u,
    '释放划词交互后必须续期抑制，覆盖收尾阶段的迟到 activate'
  )
  assert.match(
    mainSource,
    /createPopup\(\s*\{[\s\S]*?onWindowShown:\s*suppressSelectionActivationWindowGap,[\s\S]*?onPopupHidden:\s*\(\)\s*=>\s*pronunciationRequests\.cancelAll\(\),[\s\S]*?onPopupCloseStart:\s*handlePopupCloseStart,[\s\S]*?onPopupCloseEndBeforeHideRestore:\s*finishPopupInternalWindowTransitionBeforeFocusRestore,[\s\S]*?onFrontRecheckComplete:\s*releaseSettingsWindowFocusLeaseAfterFrontRecheck,[\s\S]*?onPopupCloseEnd:\s*handlePopupCloseEnd,[\s\S]*?onPopupCloseCancelled:\s*handlePopupCloseCancelled\s*\}\s*\)/u,
    '翻译弹窗显示时必须回调续期抑制，隐藏时必须清理音标请求'
  )
})

test('翻译弹窗在显示或聚焦自身时通知调用方，不激活应用其它窗口', () => {
  const popupSource = stripComments(
    readFileSync('src/main/popup.ts', 'utf8')
  )

  assert.match(
    popupSource,
    /export function createPopup\(\s*options:\s*CreatePopupOptions\s*\): BrowserWindow/u,
    '翻译弹窗创建入口必须接收显示通知与隐藏清理回调'
  )
  assert.match(
    popupSource,
    /function notifyInternalWindowShown\(/u,
    '翻译弹窗必须提供内部显示通知函数'
  )
  assert.match(
    popupSource,
    /notifyInternalWindowShown\(\)/u,
    '翻译弹窗每次自身显示时都必须通知调用方续期 activate 抑制'
  )
})

test('结果弹窗显示与关闭都必须续期抑制，防止下一轮划词前误拉设置页', () => {
  const popupSource = stripComments(
    readFileSync('src/main/popup.ts', 'utf8')
  )
  const showSource = extractFunction(popupSource, 'export function showPopup(')
  const hideSource = extractFunction(
    popupSource, 'export function hidePopup('
  )

  // 用户现象：翻译结果上屏后点击空白页，下一轮划词就会把设置页拉到最前。
  // 结果弹窗的 show()/hide() 都会让 macOS 派发内部 activate，两处都必须续期。
  assert.match(showSource, /notifyInternalWindowShown\(\)/u,
    '结果弹窗显示后必须续期 activate 抑制')
  assert.match(hideSource, /notifyInternalWindowShown\(\)/u,
    '结果弹窗隐藏后必须续期 activate 抑制')
})

test('划词开始必须使启动首开的延迟置前失效', () => {
  const suppressSource = stripComments(
    extractFunction(mainSource, 'function suppressSelectionActivationWindowGap(')
  )

  // 启动首开设置页的最终置前在多个 await 之后才执行；若用户在这段窗口期内
  // 已经开始划词，延迟到达的 moveTop()/focus() 会把设置页顶到划词应用之上。
  // 因此每次划词内部动作开始时都必须递增代际，使尚未收尾的置前动作失效。
  assert.match(mainSource, /let settingsBringToFrontEpoch = 0/u,
    '必须维护设置页置前代际')
  assert.match(suppressSource, /settingsBringToFrontEpoch\s*\+=\s*1/u,
    '划词内部动作开始必须递增置前代际')
})

test('启动首开的延迟置前必须校验划词代际与保护期', () => {
  const createStart = mainSource.indexOf('async function createSettingsWindow(')
  const createEnd = mainSource.indexOf('/**\n * 打开设置窗口。', createStart)
  assert.ok(createStart >= 0 && createEnd > createStart)
  const createSource = stripComments(mainSource.slice(createStart, createEnd))

  assert.match(createSource, /const bringToFrontEpochAtStart = settingsBringToFrontEpoch/u,
    '创建设置窗口时必须记录本次置前代际')
  assert.match(createSource, /bringToFrontEpochAtStart !== settingsBringToFrontEpoch/u,
    '延迟置前前必须校验代际未被划词失效')
  assert.match(createSource, /isSelectionWindowRaiseGuardActive\(\)/u,
    '延迟置前前必须校验当前不处于划词置前保护期')
})

test('划词置前保护期内 activate 自动路径不得置前阅读器或设置页', () => {
  const activateSource = stripComments(
    extractFunction(mainSource, 'function activateExistingPageOrOpenSettings(): void {')
  )

  // activate 判定存在短暂状态空档：全空闲检查可能漏过内部激活。只要仍处于
  // 划词置前保护期，自动路径就必须直接返回，绝不能 focusOrOpenExistingWindow()
  // 或 openSettings({ bringToFront: true }) 把窗口顶到最前。
  assert.match(activateSource, /isSelectionWindowRaiseGuardActive\(\)/u,
    'activate 自动路径必须叠加划词置前保护期判断')
})

test('划词置前保护期内刷新 Dock 不得激活应用置前窗口', () => {
  const applySource = stripComments(
    extractFunction(mainSource, 'async function applyMacOSDockVisibility(')
  )

  // app.dock.show() 会把整个应用激活到最前，连带把阅读器与设置页顶到其它应用之上。
  // 划词期间刷新 Dock 呈现时必须延后这次激活，等保护期结束再补执行。
  assert.match(applySource, /isSelectionWindowRaiseGuardActive\(\)/u,
    'Dock 刷新必须判断划词置前保护期')
  assert.match(applySource, /scheduleMacOSDockShowAfterSelectionGuard\(\)/u,
    '保护期内必须延后 app.dock.show()')
  assert.match(mainSource, /function scheduleMacOSDockShowAfterSelectionGuard\(/u,
    '必须提供保护期结束后补执行 app.dock.show() 的入口')
})

test('划词置前保护期内不得通过 showInactive 把设置页顶到前台应用之上', () => {
  const applySource = stripComments(
    extractFunction(mainSource, 'async function applyMacOSDockVisibility(')
  )

  // macOS panel 的 showInactive() 走 orderFrontRegardless，会把设置页顶到
  // 前台应用之上。保护期内必须整体推迟 Dock 呈现重放，而不是切换策略后
  // 再用 showInactive() 恢复设置页可见性。
  const guardIndex = applySource.indexOf('isSelectionWindowRaiseGuardActive()')
  const resolveIndex = applySource.indexOf('resolveMacOSDockPresentation(')
  assert.ok(guardIndex >= 0, 'Dock 刷新入口必须判断划词保护期')
  assert.ok(resolveIndex > guardIndex, '保护期判断必须在解析/切换 Dock 呈现之前短路')
  assert.match(applySource, /scheduleMacOSDockVisibilityAfterSelectionGuard\(\)/u,
    '保护期内必须推迟整个 Dock 呈现重放')
})

test('设置页所有显式置前出口都必须受划词代际与保护期约束', () => {
  const createStart = mainSource.indexOf('async function createSettingsWindow(')
  const createEnd = mainSource.indexOf('/**\n * 打开设置窗口。', createStart)
  assert.ok(createStart >= 0 && createEnd > createStart)
  const createSource = stripComments(mainSource.slice(createStart, createEnd))

  // 复用分支的三个出口（最小化恢复、已可见置前、隐藏后重开）、新建分支
  // readyToShow 之后的首次显示、以及 Dock 刷新后的最终置前，都必须能识别
  // 划词已开始；否则用户在这些 await 窗口期划词时，设置页仍会被延迟置前，
  // 进而把整个应用带到最前。共 5 处显式置前出口。
  const guardedEpochCount =
    (createSource.match(/bringToFrontEpochAtStart\s*!==\s*settingsBringToFrontEpoch/gu) ?? []).length
  assert.ok(
    guardedEpochCount >= 5,
    `设置页每个显式置前出口都必须先校验代际，当前仅 ${guardedEpochCount} 处`
  )

  // 首次显示位于 readyToShow 之后；此时若已进入划词，不得 focus()/moveTop()。
  const readyIndex = createSource.indexOf('await readyToShow')
  const firstShowIndex = createSource.indexOf('showOwnWindowForInteraction(settingsWin,', readyIndex)
  assert.ok(readyIndex >= 0 && firstShowIndex > readyIndex, '新建分支首次显示必须在 readyToShow 之后')
  const firstShowSource = createSource.slice(readyIndex, firstShowIndex)
  assert.match(
    firstShowSource,
    /bringToFrontEpochAtStart\s*!==\s*settingsBringToFrontEpoch/u,
    '首次显示前必须校验划词代际，避免划词期间仍 focus 设置页'
  )
  assert.match(
    firstShowSource,
    /isSelectionWindowRaiseGuardActive\(\)/u,
    '首次显示前必须校验划词保护期'
  )
})

test('被延后的 Dock 呈现重放必须等划词保护期与交互都结束', () => {
  const showSchedule = stripComments(
    extractFunction(mainSource, 'function scheduleMacOSDockShowAfterSelectionGuard(')
  )
  const visibilitySchedule = stripComments(
    extractFunction(mainSource, 'function scheduleMacOSDockVisibilityAfterSelectionGuard(')
  )

  // 仅按 selectionActivationSuppressUntil 计时会在用户持续划词时过早重放：
  // 每次新划词都会续期，若重放只判断单次保护期，可能在两次划词之间激活应用。
  // 必须同时确认当前没有进行中的划词交互。
  for (const [name, scheduleSource] of [
    ['scheduleMacOSDockShowAfterSelectionGuard', showSchedule],
    ['scheduleMacOSDockVisibilityAfterSelectionGuard', visibilitySchedule]
  ] as const) {
    assert.match(
      scheduleSource,
      /selectionInteraction\.snapshot\(\)\.state\s*!==\s*'idle'/u,
      `${name} 必须把进行中的划词交互视为继续等待的信号`
    )
  }
})

test('首帧就绪时若已进入划词，不得显示或聚焦设置页', () => {
  const createStart = mainSource.indexOf('async function createSettingsWindow(')
  const createEnd = mainSource.indexOf('/**\n * 打开设置窗口。', createStart)
  const createSource = stripComments(mainSource.slice(createStart, createEnd))

  // 设置页是普通 BrowserWindow，show() 也可能激活整个应用并把后台窗口带上屏；
  // 首帧就绪时若用户已开始划词，必须完全延迟显示，等托盘、菜单、Dock 或设置页内
  // 点击等显式入口再展示，不能以“不聚焦、不提升层级”为由继续 show()。
  const readyIndex = createSource.indexOf('await readyToShow')
  const guardIndex = createSource.indexOf('isSelectionWindowRaiseGuardActive()', readyIndex)
  const guardEndIndex = createSource.indexOf('\n  }', guardIndex)
  assert.ok(readyIndex >= 0 && guardIndex > readyIndex && guardEndIndex > guardIndex,
    '首帧就绪后必须先用划词保护期短路，再执行任何首开显示')
  const guardedShowSource = createSource.slice(guardIndex, guardEndIndex + 4)
  assert.match(guardedShowSource, /selectionInteraction\.snapshot\(\)\.state\s*!==\s*'idle'/u,
    '首开显示短路必须同时判断划词交互仍在进行')
  assert.match(guardedShowSource, /settings-reveal-deferred/u,
    '划词期间必须记录设置页显示被延迟')
  assert.doesNotMatch(guardedShowSource, /showOwnWindowForInteraction\(|\.show\(\)|showInactive\(\)|\.focus\(\)|\.moveTop\(\)/u,
    '划词期间不得显示、聚焦或移动设置页')
})

test('外部划词开始时必须暂时隐藏后台设置页，移除系统重选 key window 的竞态源', () => {
  const scheduleSource = stripComments(
    extractFunction(mainSource, 'function scheduleSelectionAction(')
  )
  const gestureSource = stripComments(
    extractFunction(mainSource, 'function handleSelectionGesture(')
  )
  const hideSource = stripComments(
    extractFunction(mainSource, 'function suspendSettingsWindowForExternalSelection(')
  )
  const hotkeySource = stripComments(
    extractFunction(mainSource, 'function onHotkey(): void {')
  )

  // 设置页是普通 BrowserWindow。macOS 在弹窗显隐、复制前交还前台或迟到的
  // activate 中，可能从同一应用重新选择仍可见的后台设置页作为 key window。
  // 仅在失焦后设置 focusable=false 仍存在事件时序窗口，因此外部划词入口必须在
  // 同步阶段把设置页真正隐藏，直到用户通过显式入口再次打开它。
  assert.match(
    `${scheduleSource}\n${gestureSource}`,
    /suspendSettingsWindowForExternalSelection\(\)/u,
    '外部划词入口必须暂时隐藏后台设置页'
  )
  assert.match(hideSource, /settingsWin\.hide\(\)/u,
    '设置页暂停入口必须实际隐藏窗口，而不只是修改焦点或层级')
  assert.match(hideSource, /settingsWindowHiddenForSelection\s*=\s*true/u,
    '隐藏设置页后必须记录待显式恢复状态')
  assert.match(
    mainSource,
    /function resumeSettingsWindowAfterExternalSelection\(\): void \{[\s\S]*?settingsWindowHiddenForSelection\s*=\s*false/u,
    '显式入口必须提供解除暂停状态的恢复函数'
  )
  assert.match(hotkeySource, /suspendSettingsWindowForExternalSelection\(\)/u,
    '全局快捷键取词同样必须在复制与弹窗显隐前隐藏后台设置页')
})

test('划词隐藏后任何迟到的窗口显示都必须被立即撤销，直到显式入口恢复', () => {
  const hideSource = stripComments(
    extractFunction(mainSource, 'function suspendSettingsWindowForExternalSelection(')
  )
  const resumeSource = stripComments(
    extractFunction(mainSource, 'function resumeSettingsWindowAfterExternalSelection(')
  )
  const showListenerStart = mainSource.indexOf("settingsWin.on('show'")
  const showListenerEnd = mainSource.indexOf("settingsWin.on('hide'", showListenerStart)

  // 外部划词可能触发 app.hide() → app.show()，后者会整体恢复应用内原本可见的
  // 窗口；迟到的 Dock/activate 也可能再次调用 show()。只在划词入口 hide() 一次
  // 无法覆盖这些后续路径，必须让 show 生命周期在暂停期间立即撤销显示。
  assert.ok(showListenerStart >= 0 && showListenerEnd > showListenerStart,
    '设置窗口必须注册独立的 show 生命周期兜底')
  const showListener = stripComments(mainSource.slice(showListenerStart, showListenerEnd))
  assert.match(showListener, /settingsWindowHiddenForSelection/u,
    'show 生命周期必须判断当前是否处于划词隐藏期')
  assert.match(showListener, /(?:settingsWin|createdWindow)\.hide\(\)/u,
    '划词隐藏期内任何 show 都必须立即重新隐藏设置页')
  assert.match(showListener, /settings-show-suppressed-for-selection/u,
    '迟到 show 被撤销时必须留下诊断打点')
  assert.match(resumeSource, /settingsWindowHiddenForSelection\s*=\s*false/u,
    '只有显式入口可以解除 show 生命周期抑制')
  assert.match(resumeSource, /settingsBringToFrontEpoch\s*\+=\s*1/u,
    '显式恢复必须更新置前代际，使划词前旧异步动作失效')
  assert.match(hideSource, /settingsWin\.hide\(\)/u,
    '首次划词仍必须主动隐藏设置页')
})

test('划词隐藏设置页时必须立即失效旧置前意图并阻止统一入口继续显示', () => {
  const hideSource = stripComments(
    extractFunction(mainSource, 'function suspendSettingsWindowForExternalSelection(')
  )
  const completeSource = stripComments(
    extractFunction(mainSource, 'function canCompleteSettingsBringToFront(')
  )

  // hide() 与后续 suppressSelectionActivationWindowGap() 之间仍有同步调用边界。
  // 启动首开可能恰好停在 await 之后，若隐藏动作不立即递增代际，旧置前仍会执行。
  assert.match(
    hideSource,
    /settingsWindowHiddenForSelection\s*=\s*true[\s\S]*?settingsBringToFrontEpoch\s*\+=\s*1/u,
    '隐藏设置页时必须同步递增置前代际'
  )
  // 即使有其它调用方只隐藏窗口而没有续期保护期，统一置前入口也必须以隐藏态
  // 作为最终门禁，避免 moveTop()/focus() 把刚隐藏的设置页重新带回前台。
  assert.match(
    completeSource,
    /settingsWindowHiddenForSelection/u,
    '统一置前入口必须拒绝仍处于划词隐藏状态的设置页'
  )
})

test('设置窗口销毁时必须复位划词隐藏标记，避免新窗口被旧状态误隐藏', () => {
  const closedStart = mainSource.indexOf("settingsWin.on('closed'")
  const closedEnd = mainSource.indexOf('/**', closedStart)
  assert.ok(closedStart >= 0 && closedEnd > closedStart, '必须存在设置窗口 closed 生命周期')
  const closedListener = stripComments(mainSource.slice(closedStart, closedEnd))

  // 标记是窗口实例级状态。用户关闭设置页后若仍保留 true，下一次显式打开新建
  // 窗口会立刻被 show 生命周期再次隐藏，表现为托盘/Dock 点击完全无效。
  assert.match(
    closedListener,
    /settingsWin === createdWindow[\s\S]*?settingsWindowHiddenForSelection\s*=\s*false/u,
    '关闭当前设置窗口时必须复位划词隐藏标记'
  )
})

test('所有设置页显式打开入口必须先恢复被划词隐藏的设置页', () => {
  const openSource = stripComments(extractFunction(mainSource, 'async function openSettings('))
  const activateSource = stripComments(
    extractFunction(mainSource, 'function activateExistingPageOrOpenSettings(): void {')
  )
  const traySource = stripComments(extractFunction(mainSource, 'function createTray(): void {'))

  assert.match(openSource, /resumeSettingsWindowAfterExternalSelection\(\)/u,
    '托盘、菜单、Dock、弹窗设置入口都必须先解除划词隐藏状态')
  assert.match(openSource, /explicitEntry\?:\s*boolean/u,
    'openSettings 必须显式区分用户入口与自动 activate 路径')
  assert.match(openSource, /if\s*\(options\.explicitEntry\)\s*resumeSettingsWindowAfterExternalSelection\(\)/u,
    '只有显式入口才能解除划词隐藏，自动 activate 不得恢复后台设置页')
  assert.match(
    activateSource,
    /openSettings\(\{[\s\S]*?bringToFront:\s*true[\s\S]*?explicitEntry:\s*true[\s\S]*?source:\s*'dock'[\s\S]*?dockActivationEpoch[\s\S]*?\}\)/u,
    '真实 Dock 激活属于显式入口，必须显式传参并携带激活代际')
  assert.match(traySource, /openSettings\(\{ explicitEntry: true \}\)/u,
    '托盘点击属于显式入口，必须显式传参')
})
