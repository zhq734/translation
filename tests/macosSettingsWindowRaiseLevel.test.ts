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
  assert.match(resetSource, /setAlwaysOnTop\(false\)/u, '定时器到期必须归还普通层级')
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
    /raisedInteractionWindows/u,
    '定时回收必须遍历所有被提升层级的自有窗口'
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
    /createPopup\(PRELOAD_PATH,\s*suppressSelectionActivationWindowGap,\s*\(\)\s*=>\s*pronunciationRequests\.cancelAll\(\)\s*\)/u,
    '翻译弹窗显示时必须回调续期抑制，隐藏时必须清理音标请求'
  )
})

test('翻译弹窗在显示或聚焦自身时通知调用方，不激活应用其它窗口', () => {
  const popupSource = stripComments(
    readFileSync('src/main/popup.ts', 'utf8')
  )

  assert.match(
    popupSource,
    /createPopup\(\s*preloadPath:\s*string,\s*onWindowShown\?:\s*\(\)\s*=>\s*void,\s*onPopupHidden\?:\s*\(\)\s*=>\s*void\s*\)/u,
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

test('首帧就绪时若已进入划词，不得聚焦或提升设置页层级', () => {
  const createStart = mainSource.indexOf('async function createSettingsWindow(')
  const createEnd = mainSource.indexOf('/**\n * 打开设置窗口。', createStart)
  const createSource = stripComments(mainSource.slice(createStart, createEnd))

  // macOS panel 的 showInactive() 走 orderFrontRegardless，moveTop()/focus()
  // 也会把窗口排到前台应用之上。首帧就绪时若用户已开始划词，只能以不聚焦、
  // 不提升层级的方式让窗口安静上屏，绝不能走显式置前路径。
  const readyIndex = createSource.indexOf('await readyToShow')
  const guardIndex = createSource.indexOf('isSelectionWindowRaiseGuardActive()', readyIndex)
  const firstShowIndex = createSource.indexOf('showOwnWindowForInteraction(settingsWin,', readyIndex)
  assert.ok(readyIndex >= 0 && guardIndex > readyIndex && firstShowIndex > guardIndex,
    '首帧就绪后必须先用划词保护期短路，再执行任何首开显示')
  const guardSource = createSource.slice(readyIndex, guardIndex)
  const guardedShowSource = createSource.slice(guardIndex, firstShowIndex + 160)
  assert.match(guardedShowSource, /selectionInteraction\.snapshot\(\)\.state\s*!==\s*'idle'/u,
    '首开显示短路必须同时判断划词交互仍在进行')
  assert.match(guardedShowSource, /focus:\s*false/u,
    '划词期间首开显示不得聚焦设置页')
  assert.match(guardedShowSource, /moveTop:\s*false/u,
    '划词期间首开显示不得把设置页提到前台应用之上')
  assert.match(guardedShowSource, /raiseLevel:\s*false/u,
    '划词期间首开显示不得提升设置页层级')
  assert.doesNotMatch(guardedShowSource, /showInactive\(\)/u,
    '划词期间首开显示不得使用 orderFrontRegardless 语义的 showInactive()')
})
