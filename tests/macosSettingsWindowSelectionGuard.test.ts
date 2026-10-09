import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * 从源码中截取指定函数的函数体。
 * @param source 源码。
 * @param signature 函数签名起始片段。
 * @returns 从签名到函数结束的源码片段。
 * @author zhenghq
 */
function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `应存在函数 ${signature}`)
  const end = source.indexOf('\n}', start)
  assert.ok(end > start, `函数 ${signature} 应有结束边界`)
  return source.slice(start, end)
}

const mainSource = readFileSync('src/main/index.ts', 'utf8')

test('设置窗口可见时点击“译”必须临时暂停其可聚焦性', () => {
  const translateSource = extractFunction(mainSource, 'async function translateSelectionButton(')

  // 设置窗口可见时点击“译”，本应用可能因点击短暂成为最前应用，
  // macOS 会把应用内可聚焦的可见设置窗口提升为 key window 并带到最前。
  // 取词前必须临时关闭设置窗口的可聚焦性，取词结束后再恢复。
  assert.match(
    translateSource,
    /suspendSettingsWindowFocusForSelection\(interactionToken\)/u,
    '取词流程必须暂停可见设置窗口的可聚焦性'
  )
  const releaseSource = extractFunction(mainSource, 'function releaseSelectionInteraction(')
  assert.match(
    releaseSource,
    /finishSettingsWindowFocusSuspension\(token\)/u,
    '选区交互释放时必须进入设置窗口焦点保护收尾'
  )

  const suspendSource = extractFunction(mainSource, 'function suspendSettingsWindowFocusForSelection(')
  const resumeSource = extractFunction(mainSource, 'function resumeSettingsWindowFocusAfterSelection(')
  assert.match(suspendSource, /setFocusable\(false\)/u, '暂停必须关闭设置窗口可聚焦性')
  // Electron 文档明确：macOS 上 setFocusable(false) 不会移除窗口已有焦点。
  // 若设置窗口已被系统提升为 key window，必须显式 blur 才能真正撤回。
  assert.match(
    suspendSource,
    /getFocusedWindow\(\)\s*===\s*target[\s\S]*?target\.blur\(\)/u,
    '设置窗口已持有焦点时必须显式 blur'
  )
  assert.match(resumeSource, /setFocusable\(true\)/u, '恢复必须重新打开设置窗口可聚焦性')
})

test('Dock 呈现切换在划词交互期间不得聚焦设置窗口', () => {
  const applySource = extractFunction(mainSource, 'async function applyMacOSDockVisibility(')

  // 切换激活策略会重排窗口层级；若此时再 focus() 可见设置页，就会把设置页
  // 带到最前。交互期间只恢复可见性，不恢复焦点。
  assert.match(
    applySource,
    /selectionInteractionActive/u,
    'Dock 呈现切换必须依据划词交互状态决定是否恢复设置窗口焦点'
  )
  assert.match(
    mainSource,
    /else \{[\s\S]*?settingsWindowToPreserve\.show\(\)[\s\S]*?settingsWindowToPreserve\.focus\(\)/u,
    '只有非划词交互时才允许聚焦被保留的设置窗口'
  )
  // show() 在 macOS 上同样会聚焦窗口，交互期间必须改用 showInactive()
  // 只恢复可见性，避免恢复 Dock 图标时把设置页重新置顶。
  assert.match(
    mainSource,
    /if \(selectionInteractionActive\)[\s\S]*?settingsWindowToPreserve\.showInactive\(\)/u,
    '交互期间必须用非激活方式恢复设置窗口可见性'
  )
})

test('设置窗口焦点保护必须覆盖整个划词翻译生命周期', () => {
  const translateSource = extractFunction(mainSource, 'async function translateSelectionButton(')
  // 取词按钮流程只覆盖到同步取词结束；若在这一步的 finally 里就恢复设置窗口
  // 可聚焦性，异步翻译结果弹窗随后 win.show() 激活本应用时，可见且可聚焦的
  // 设置页会被 macOS 提升为 key window 带到最前。恢复必须绑定到选区交互释放，
  // 即取词与翻译结果都已展示之后。
  assert.doesNotMatch(
    translateSource,
    /resumeSettingsWindowFocusAfterSelection\(\)/u,
    '取词按钮流程不得在翻译结果返回前恢复设置窗口可聚焦性'
  )
  const releaseSource = extractFunction(mainSource, 'function releaseSelectionInteraction(')
  assert.match(
    releaseSource,
    /finishSettingsWindowFocusSuspension\(token\)/u,
    '选区交互释放时才允许进入设置窗口焦点保护收尾'
  )
})

test('设置窗口焦点挂起必须记录所有者 token，避免旧流程提前恢复', () => {
  const suspendSource = extractFunction(mainSource, 'function suspendSettingsWindowFocusForSelection(')
  const resumeSource = extractFunction(mainSource, 'function resumeSettingsWindowFocusAfterSelection(')
  const releaseSource = extractFunction(mainSource, 'function releaseSelectionInteraction(')

  // 用户可能在上一轮翻译尚未结束时再次划词并点击“译”。新一轮会复用同一个
  // 挂起的设置窗口，若旧流程释放时无条件恢复，新流程的焦点保护会被提前撤销，
  // 设置页又会被结果弹窗激活动作提升到最前。挂起必须记住最新所有者 token，
  // 只有所有者释放时才恢复。
  assert.match(
    suspendSource,
    /settingsWindowFocusSuspensionOwnerToken\s*=\s*token/u,
    '挂起必须记录所有者 token'
  )
  assert.match(
    resumeSource,
    /ownerToken\s*!==\s*undefined\s*&&\s*settingsWindowFocusSuspensionOwnerToken\s*!==\s*ownerToken/u,
    '恢复必须校验所有者 token'
  )
  assert.match(
    releaseSource,
    /finishSettingsWindowFocusSuspension\(token\)/u,
    '释放交互时必须把 token 传给焦点保护收尾函数'
  )
})

test('结果弹窗仍可见时不得立即恢复设置窗口可聚焦性', () => {
  const finishSource = extractFunction(mainSource, 'function finishSettingsWindowFocusSuspension(')
  // 翻译结果弹窗 show() 激活本应用后仍可能被迟到的全局 mousedown 关闭；
  // 若交互释放时立即恢复设置窗口可聚焦性，弹窗收尾的窗口层级变化会把设置页
  // 提升为 key window 带到最前。弹窗仍可见时必须延迟恢复。
  assert.match(finishSource, /isPopupVisible\(\)/u, '必须按弹窗可见性决定是否延迟恢复')
  assert.match(finishSource, /scheduleSettingsWindowFocusResume\(ownerToken\)/u, '弹窗可见时必须延迟恢复')
  assert.match(
    finishSource,
    /resumeSettingsWindowFocusAfterSelection\(ownerToken\)/u,
    '弹窗已隐藏时才允许立即恢复'
  )

  const scheduleSource = extractFunction(mainSource, 'function scheduleSettingsWindowFocusResume(')
  assert.match(scheduleSource, /whenPopupHidden\(/u, '弹窗隐藏后必须恢复设置窗口可聚焦性')
  assert.match(scheduleSource, /setTimeout\(/u, '必须保留兜底定时器，但弹窗可见时不得触发恢复')
})

test('新一轮挂起必须取消上一轮待恢复定时器', () => {
  const suspendSource = extractFunction(mainSource, 'function suspendSettingsWindowFocusForSelection(')
  // 上一轮交互释放后可能已经排好延迟恢复；新一轮划词点击“译”接管保护时，
  // 必须取消该定时器，否则旧定时器会在新流程中途恢复可聚焦性。
  assert.match(
    suspendSource,
    /clearSettingsWindowFocusResume\(\)/u,
    '新一轮挂起必须先取消上一轮待恢复定时器'
  )
})

test('弹窗正在交还前台时不得并发恢复设置窗口可聚焦性', () => {
  const finishSource = extractFunction(mainSource, 'function finishSettingsWindowFocusSuspension(')

  // hidePopup() 一开始就会把弹窗标记为「逻辑关闭」，此时 isPopupVisible() 为 false，
  // 但 handBackFrontmostThen() 的精确交还仍在进行。若这里立即恢复设置窗口可聚焦性，
  // resumeSettingsWindowFocusAfterSelection() 会看到应用仍激活并再次启动安全让出，
  // 与弹窗收尾的 open -b 并发执行；app.show() 可能把设置页重新带到最前。
  // 必须把「正在交还前台」视为弹窗尚未完成收尾，等 hide 事件后再恢复。
  assert.match(
    finishSource,
    /!isPopupVisible\(\)\s*&&\s*!isPopupHandingBackFront\(\)/u,
    '弹窗逻辑关闭但仍在交还前台时必须等待收尾完成'
  )
  assert.match(
    finishSource,
    /scheduleSettingsWindowFocusResume\(ownerToken\)/u,
    '等待弹窗隐藏后必须通过延迟恢复路径继续'
  )
})

test('设置窗口恢复必须等待弹窗前台交还收尾完成', () => {
  const popupSource = readFileSync('src/main/popup.ts', 'utf8')
  const whenHiddenSource = extractFunction(popupSource, 'export function whenPopupHidden(')
  const hideSource = extractFunction(popupSource, 'export function hidePopup(): void {')

  // whenPopupHidden 只监听 hide 事件，而安全让出分支中 hide 事件可能早于
  // 应用真正失活到达。若恢复逻辑只看 hide，设置页仍会在本应用最前时恢复
  // 可聚焦性并被系统提升。必须让回调等到前台交还收尾真正结束。
  assert.match(
    whenHiddenSource,
    /!hidingAfterFrontReturn/u,
    '弹窗隐藏回调必须排除仍在交还前台的收尾期'
  )
  assert.match(
    hideSource,
    /notifyPopupHiddenWaiters|finishPopupTeardown\(\)[\s\S]*?whenPopupHidden/u,
    '交还收尾完成时必须通知等待弹窗隐藏的调用方'
  )
})

test('交还收尾期间的重复隐藏不得提前唤醒等待者', () => {
  const popupSource = readFileSync('src/main/popup.ts', 'utf8')
  const hideSource = extractFunction(popupSource, 'export function hidePopup(): void {')
  const repeatGuardIndex = hideSource.indexOf('if (hidingAfterFrontReturn) return')

  // 第一次 hidePopup() 已进入交还流程时，弹窗失焦可能再次触发 hidePopup()。
  // 重复隐藏必须立即短路，但不能在精确交还（open -b）完成前唤醒设置页恢复逻辑：
  // 提前恢复可聚焦性会让设置页与交还流程并发执行 app.hide()/app.show()，
  // 最终把设置页重新顶到最前。等待者统一由 finishPopupTeardown() 收尾后通知。
  assert.ok(repeatGuardIndex >= 0, '必须保留交还期间的重复隐藏短路')
  const repeatGuardLineEnd = hideSource.indexOf('\n', repeatGuardIndex)
  const repeatGuardLine = hideSource.slice(repeatGuardIndex, repeatGuardLineEnd)
  assert.match(
    repeatGuardLine,
    /if \(hidingAfterFrontReturn\) return/u,
    '交还期间必须立即短路重复隐藏'
  )
  assert.doesNotMatch(
    repeatGuardLine,
    /notifyPopupHiddenWaiters\(\)/u,
    '交还期间不得提前唤醒等待者'
  )

  // 窗口确实已销毁时不存在后续收尾事件，仍必须主动唤醒等待者。
  assert.match(
    hideSource,
    /if \(!win \|\| win\.isDestroyed\(\)\) \{[\s\S]*?notifyPopupHiddenWaiters\(\)/u,
    '窗口销毁时必须立即唤醒等待者'
  )
})

test('取词早期必须续期内部激活租约，避免 activate 漏放行打开设置页', () => {
  const translateSource = extractFunction(mainSource, 'async function translateSelectionButton(')

  // 点击“译”会先隐藏按钮再显示读取弹窗；这段窗口期 selectionInteraction 虽已
  // 进入 capturing，但 activate 事件可能在状态切换前到达，必须尽早续租拦截。
  const beginIndex = translateSource.indexOf('selectionInteraction.beginButtonCapture()')
  const renewIndex = translateSource.indexOf('renewInternalActivationLease()', beginIndex)
  const hideIndex = translateSource.indexOf('hideSelectionButton()', beginIndex)
  assert.ok(beginIndex >= 0, '取词流程必须取得交互 token')
  assert.ok(renewIndex > beginIndex, '取词流程必须续期内部激活租约')
  assert.ok(hideIndex > renewIndex, '续租必须早于隐藏“译”按钮')
})

test('取词失败弹窗隐藏时必须真正交还前台，不能因本应用仍激活而跳过', () => {
  const handBackThenSource = extractFunction(
    readFileSync('src/main/macForeground.ts', 'utf8'),
    'export function handBackFrontmostThen('
  )

  // 设置页在划词期间被设为不可聚焦、失败提示以 showInactive 显示，
  // 此时 BrowserWindow.getFocusedWindow() 返回 null，但点击“译”已让本应用
  // 成为最前应用（isMacAppActive() 为 true）。旧逻辑会把这个组合误判为
  // 「原生对话框持有 key window」而直接 run()，既不交还前台也不丢弃记录，
  // 失败提示自动隐藏后应用仍是前台，恢复设置页可聚焦性时它会被系统提升到最前。
  // 必须增加显式参数区分「弹窗即将隐藏」这一真实场景，使其走交还/安全让出。
  assert.match(
    handBackThenSource,
    /keyWindowIsPopup|popupClosing|closingPopup/iu,
    '必须提供参数区分弹窗隐藏与原生对话框持有 key window'
  )
  assert.match(
    handBackThenSource,
    /if \(isMacAppActive\(\)\) \{[\s\S]*?keyWindowIsPopup|keyWindowIsPopup[\s\S]*?if \(isMacAppActive\(\)\)/u,
    '弹窗隐藏场景不得再走原生对话框的跳过交还分支'
  )
})

test('弹窗隐藏时必须把弹窗场景标记传给前台交还逻辑', () => {
  const popupSource = readFileSync('src/main/popup.ts', 'utf8')
  const hideSource = extractFunction(popupSource, 'export function hidePopup(): void {')
  assert.match(
    hideSource,
    /handBackFrontmostThen\([\s\S]*?true\s*\)/u,
    'hidePopup 必须把弹窗场景标记传给 handBackFrontmostThen'
  )
})

test('设置窗口恢复可聚焦性前必须确认本应用已不再是最前', () => {
  const resumeSource = extractFunction(mainSource, 'function resumeSettingsWindowFocusAfterSelection(')

  // 应用仍是前台时直接 setFocusable(true)，系统会立刻把可见的设置页提升为
  // key window 并顶到最前。必须先把前台交还/安全让出，确认失活后再恢复。
  assert.match(
    resumeSource,
    /isMacAppActiveByEvents\(\)|isMacAppActive\(\)/u,
    '恢复前必须检查本应用是否仍处于最前'
  )
  assert.match(
    resumeSource,
    /yieldFrontmostAppThen|handBackFrontmostApp|restoreFrontmostAppForCapture/u,
    '应用仍在前台时必须先交还前台再恢复可聚焦性'
  )
})

test('用户显式打开设置页时不得触发安全让出前台', () => {
  const resumeSource = extractFunction(mainSource, 'function resumeSettingsWindowFocusAfterSelection(')

  // 显式打开设置页（菜单栏图标 / 托盘 / 第二实例）会省略 ownerToken 调用本函数，
  // 语义是用户本就要把设置页带到最前。若此时也走安全让出，会把刚打开的设置页
  // 让到后台，表现为「打开设置页又立刻被压下去」。
  assert.match(
    resumeSource,
    /ownerToken\s*!==\s*undefined\s*&&\s*isMacAppActiveByEvents\(\)/u,
    '只有划词流程自动收尾才允许安全让出，显式打开必须直接恢复'
  )
})

test('安全让出期间弹窗重新打开时不得恢复设置页可聚焦性', () => {
  const resumeSource = extractFunction(mainSource, 'function resumeSettingsWindowFocusAfterSelection(')

  // 安全让出是异步的：期间新一轮划词可能重新打开弹窗并再次挂起设置窗口焦点保护。
  // 旧让出回调若仍执行 setFocusable(true)，弹窗收尾会立刻把设置页顶到最前。
  // 恢复前必须同时校验代际号与弹窗可见性。
  const yieldIndex = resumeSource.indexOf('yieldFrontmostAppThen(')
  assert.ok(yieldIndex >= 0, '恢复函数必须调用安全让出')
  const callbackSource = resumeSource.slice(yieldIndex)
  assert.match(
    callbackSource,
    /resumeGeneration\s*!==\s*settingsWindowFocusResumeGeneration/u,
    '旧让出回调必须按代际号失效'
  )
  assert.match(
    callbackSource,
    /if \(isPopupVisible\(\)\) return/u,
    '弹窗重新打开时不得恢复设置页可聚焦性'
  )
})

test('原生对话框交还在途时不得并发启动安全让出前台', () => {
  const macSource = readFileSync('src/main/macForeground.ts', 'utf8')
  const resumeSource = extractFunction(mainSource, 'function resumeSettingsWindowFocusAfterSelection(')

  // 连续取词超时会弹出原生修复对话框；对话框关闭后 promptHiServicesRepair 会
  // await handBackFrontmostApp() 执行 open -b 精确交还。与此同时选区交互释放会
  // 触发设置页焦点恢复，若该路径再启动 yieldFrontmostAppThen() 的 app.hide()/app.show()，
  // 两路前台操作并发，app.show() 会把设置页重新顶到最前（日志中表现为
  // 「原生对话框收尾开始精确交还」之后紧跟「应用仍最前，恢复设置页可聚焦性前先安全让出前台」）。
  // 必须让恢复路径感知在途交还并等待其收尾，而不是并发安全让出。
  assert.match(
    macSource,
    /export function isFrontmostHandBackInFlight\(/u,
    '前台交还模块必须暴露「原生对话框交还在途」状态'
  )
  assert.match(
    macSource,
    /export function whenFrontmostHandBackSettled\(/u,
    '前台交还模块必须提供等待在途交还收尾的入口'
  )
  assert.match(
    resumeSource,
    /isFrontmostHandBackInFlight\(\)/u,
    '恢复设置页可聚焦性前必须检查原生对话框交还是否在途'
  )
  assert.match(
    resumeSource,
    /whenFrontmostHandBackSettled\(\)/u,
    '在途交还结束前必须等待而不是并发安全让出'
  )
  const inFlightIndex = resumeSource.indexOf('isFrontmostHandBackInFlight()')
  const firstYieldIndex = resumeSource.indexOf('yieldFrontmostAppThen(', inFlightIndex)
  assert.ok(
    inFlightIndex >= 0 && firstYieldIndex >= 0 && inFlightIndex < firstYieldIndex,
    '在途交还检查必须早于安全让出调用'
  )
})

test('前台交还在途状态必须在精确交还成功后及时清除', () => {
  const macSource = readFileSync('src/main/macForeground.ts', 'utf8')
  const handBackSource = extractFunction(macSource, 'export function handBackFrontmostApp(): Promise<boolean> {')

  // 在途计数只增不减会让设置页恢复永久阻塞；精确交还分支必须在 Promise
  // settle 后统一调用 endFrontmostHandBack()，无论成功、超时还是异常。
  assert.match(
    handBackSource,
    /beginFrontmostHandBack\(\)/u,
    '进入交还流程前必须标记在途'
  )
  assert.match(
    handBackSource,
    /\.finally\(\(\) => endFrontmostHandBack\(\)\)/u,
    '交还 Promise settle 后必须清除在途状态'
  )
  assert.match(
    handBackSource,
    /catch \(error\) \{[\s\S]*?endFrontmostHandBack\(\)/u,
    '同步异常路径也必须清除在途状态'
  )
})

test('弹窗关闭且本应用仍最前时不得因 key window 不匹配跳过交还', () => {
  const handBackThenSource = extractFunction(
    readFileSync('src/main/macForeground.ts', 'utf8'),
    'export function handBackFrontmostThen('
  )

  // 点击“译”后设置页被临时设为不可聚焦并 blur，但 macOS 仍可能把焦点残留在
  // 其它自有窗口上：此时 BrowserWindow.getFocusedWindow() 非 null，且不是即将
  // 隐藏的弹窗。旧逻辑会命中「即将隐藏的窗口不是当前 key window」直接 run()，
  // 既不交还前台也不消费记录；随后设置页恢复可聚焦性时应用仍最前，只能走
  // app.hide()→app.show() 兜底，app.show() 会把设置页重新顶到最前（用户反馈
  // 「取词超时后设置页弹到最前」）。弹窗场景只要本应用仍最前，就必须继续交还，
  // 不能被 key window 不匹配短路。
  assert.match(
    handBackThenSource,
    /const focusedIsResidualUnfocusableWindow = focused !== null[\s\S]*?!focused\.isFocusable\(\)/u,
    '必须识别不可聚焦的残留焦点窗口'
  )
  assert.match(
    handBackThenSource,
    /const popupClosingWithoutKeyWindow = keyWindowIsPopup &&[\s\S]*?focusedIsResidualUnfocusableWindow/u,
    '弹窗场景下残留不可聚焦焦点必须绕过 key window 不匹配的跳过分支'
  )
  // 但用户主动点击了其它可聚焦自有窗口（结果弹窗可见时点设置页）时，该窗口
  // 就是用户的目标焦点，不能因为弹窗场景就把它抢走，必须保留跳过分支。
  assert.match(
    handBackThenSource,
    /isFocusable\(\)/u,
    '必须用可聚焦性区分用户目标窗口与不可聚焦的残留焦点'
  )
  // 反向回归：可聚焦的其它自有窗口（手动翻译弹窗打开时用户主动点设置页）
  // 必须继续命中跳过分支，只隐藏弹窗、保留用户刚点中的窗口焦点。
  assert.match(
    handBackThenSource,
    /!focused\.isFocusable\(\)\s*\n\s*const popupClosingWithoutKeyWindow/u,
    '可聚焦窗口必须留在跳过分支，不能被弹窗场景无条件抢走焦点'
  )
})

test('弹窗仍可见时兜底恢复不得把设置页安全让出到最前', () => {
  const scheduleSource = extractFunction(mainSource, 'function scheduleSettingsWindowFocusResume(')
  const finishSource = extractFunction(mainSource, 'function finishSettingsWindowFocusSuspension(')

  // 翻译结果弹窗展示后，交互释放会走 scheduleSettingsWindowFocusResume()：
  // 一边等待弹窗真正隐藏，一边挂 5 秒兜底定时器。旧兜底到期后直接调用
  // resumeSettingsWindowFocusAfterSelection()，此时弹窗仍可见且本应用仍是
  // 最前应用，恢复函数会走 yieldFrontmostAppThen() 的 app.hide()→app.show()，
  // 把一直开着的设置页重新顶到用户当前应用之上，表现为「划词弹出翻译窗口后
  // 隔 5~6 秒设置界面突然弹出」。兜底到期时必须先确认弹窗确实已经隐藏；
  // 弹窗仍可见只能保持设置页不可聚焦，把恢复交给真正的弹窗隐藏回调。
  assert.match(
    scheduleSource,
    /fallbackTimer = setTimeout\(\(\) => \{[\s\S]*?isPopupVisible\(\)/u,
    '兜底定时器到期时必须先判断翻译弹窗是否仍然可见'
  )
  assert.match(
    scheduleSource,
    /isPopupVisible\(\)[\s\S]*?return/u,
    '弹窗仍可见时兜底恢复必须直接返回，不得恢复设置页可聚焦性'
  )
  // 弹窗隐藏回调仍然必须负责正常恢复，否则设置页会永久不可聚焦。
  assert.match(
    scheduleSource,
    /whenPopupHidden\(finish\)/u,
    '弹窗隐藏后仍必须通过正常回调恢复设置页可聚焦性'
  )
  // 兜底与正常回调共用 finish()，弹窗可见性判断必须早于 finish() 调用。
  const fallbackIndex = scheduleSource.indexOf('fallbackTimer = setTimeout(')
  const finishCallIndex = scheduleSource.indexOf('\n    finish()', fallbackIndex)
  const visibilityIndex = scheduleSource.indexOf('isPopupVisible()', fallbackIndex)
  assert.ok(
    visibilityIndex >= 0 && finishCallIndex >= 0 && visibilityIndex < finishCallIndex,
    '弹窗可见性检查必须早于兜底 finish() 调用'
  )
  assert.match(
    finishSource,
    /scheduleSettingsWindowFocusResume\(ownerToken\)/u,
    '弹窗仍可见时必须保留延迟恢复路径'
  )
})
