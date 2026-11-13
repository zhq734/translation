import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { readMainSource } from './helpers/mainSource.ts'

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
  // 顶格闭合花括号才能代表函数结束，避免嵌套块被误判为结束边界。
  const end = source.indexOf('\n}\n', start)
  assert.ok(end > start, `函数 ${signature} 应有结束边界`)
  return source.slice(start, end)
}

/**
 * 去掉源码中的块注释与行注释，避免注释里的历史函数名干扰断言。
 * @param source 源码。
 * @returns 移除注释后的源码。
 * @author zhenghq
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

const mainSource = readMainSource()
const popupSource = readFileSync('src/main/popup.ts', 'utf8')
const macSource = readFileSync('src/main/macForeground.ts', 'utf8')

test('设置窗口保持普通窗口，翻译弹窗保留 nonactivating panel', () => {
  const createSource = extractFunction(mainSource, 'async function createSettingsWindow(')
  const popupCreateSource = extractFunction(popupSource, 'export function createPopup(')

  // 设置窗口曾尝试用 panel 避免激活整个应用，但 Electron 33 的 ElectronNSPanel
  // 强制 CanJoinAllSpaces，导致设置页跑到所有桌面。设置窗口必须改回普通窗口；
  // 翻译弹窗仍需要跨桌面的浮层语义，因此保留 panel。
  assert.doesNotMatch(createSource, /type:\s*'panel'/u)
  assert.match(popupCreateSource, /process\.platform\s*===\s*'darwin'\s*\?\s*\{\s*type:\s*'panel'\s*\}/u)
})

test('划词焦点挂起与恢复机制必须整体移除', () => {
  const code = stripComments(mainSource)

  // setFocusable(false) 会让 macOS 的 BrowserWindow.getFocusedWindow() 返回 null，
  // 弹窗隐藏时会把场景误判为需要整应用让出并触发 app.hide()，用户表现为从 Dock
  // 打开设置页后窗口闪一下消失。该机制已被真机证明无效且有害，必须彻底删除。
  for (const removed of [
    'settingsWindowFocusSuspendedForSelection',
    'settingsWindowFocusResumePending',
    'settingsWindowFocusResumePendingOwnerToken',
    'settingsWindowFocusSuspensionOwnerToken',
    'webReaderFocusResumePending',
    'webReaderFocusResumePendingOwnerToken',
    'webReaderFocusSuspensionOwnerToken',
    'suspendSettingsWindowFocusForSelection',
    'resumeSettingsWindowFocusAfterSelection'
  ]) {
    assert.ok(!code.includes(removed), `index.ts 不应再包含 ${removed}`)
  }
  assert.doesNotMatch(code, /\.setFocusable\(/u, 'index.ts 不得再通过 setFocusable 挂起自有窗口')
})

test('内部激活租约与延迟释放补偿必须整体删除', () => {
  const code = stripComments(mainSource)

  for (const removed of [
    'internalActivationLeaseUntil',
    'renewInternalActivationLease',
    'releaseSelectionInteractionAfterPopupHidden',
    'pendingPopupReleaseToken',
    'INTERNAL_ACTIVATION_LEASE_MS',
    'POPUP_RELEASE_FALLBACK_MS'
  ]) {
    assert.ok(!code.includes(removed), `index.ts 不应再包含 ${removed}`)
  }
})

test('取词流程必须通过统一租约保护设置窗口，且不得直接切换可聚焦性', () => {
  const translateSource = stripComments(
    extractFunction(mainSource, 'async function translateSelectionButton(')
  )
  const scheduleSource = stripComments(
    extractFunction(mainSource, 'function scheduleSelectionAction(')
  )

  assert.match(scheduleSource, /beginSelectionFocusLease\(\)/u,
    '划词开始时必须取得设置页生命周期焦点租约')
  assert.match(translateSource, /beginSelectionFocusLease\(\)/u,
    '按钮取词入口必须持有同一设置页焦点租约')
  assert.doesNotMatch(`${scheduleSource}\n${translateSource}`, /\.setFocusable\(/u,
    '业务入口不得直接切换设置页可聚焦性')
  assert.doesNotMatch(translateSource, /renewInternalActivationLease/u)
  assert.doesNotMatch(translateSource, /waitForFrontmostAppReturn/u)
  assert.doesNotMatch(translateSource, /restoreFrontmostAppForCapture/u)
  assert.doesNotMatch(translateSource, /pendingPopupReleaseToken/u)
})

test('快捷键自动取词与自动模式划词必须取得设置页生命周期焦点租约', () => {
  const hotkeySource = stripComments(
    extractFunction(mainSource, 'function onHotkey(): void {')
  )
  const scheduleSource = stripComments(
    extractFunction(mainSource, 'function scheduleSelectionAction(')
  )

  // 设置页仍是普通 BrowserWindow，弹窗隐藏/重新选 key window 时系统会把它
  // 提升到前台；快捷键与自动模式都必须覆盖完整划词生命周期。
  assert.match(hotkeySource, /beginSelectionFocusLease\(\)/u,
    '快捷键取词必须取得设置页生命周期焦点租约')
  assert.match(scheduleSource, /beginSelectionFocusLease\(\)/u,
    '自动模式划词必须取得设置页生命周期焦点租约')
  assert.doesNotMatch(`${hotkeySource}\n${scheduleSource}`, /\.setFocusable\(/u,
    '取词入口不得直接切换设置页可聚焦性')
})

test('首次划词必须为从未失焦的后台设置页补做焦点保护', () => {
  const beginSource = stripComments(
    extractFunction(mainSource, 'function beginSelectionFocusLease(): void {')
  )

  assert.match(
    beginSource,
    /suspendSettingsWindowFocusForPopupHide\([\s\S]*?process\.platform,[\s\S]*?settingsWin,[\s\S]*?appActive:\s*isMacAppActiveByEvents\(\)[\s\S]*?source:\s*'selection'/u,
    '首次划词必须使用 selection 来源，为可见但从未失焦的后台设置页补做保护'
  )
  assert.match(
    beginSource,
    /const lease = suspendSettingsWindowFocusForPopupHide\([\s\S]*?if \(!lease\.acquired\) return[\s\S]*?restoreSelectionFocusLease = lease/u,
    '只有真正取得保护时才能缓存租约；跳过后的空操作必须在后续划词时重试'
  )
})

test('划词租约必须覆盖两次划词之间，且弹窗可见时不得提前恢复', () => {
  const scheduleSource = stripComments(
    extractFunction(mainSource, 'function scheduleSelectionAction(')
  )
  const releaseSource = stripComments(
    extractFunction(mainSource, 'function releaseSelectionInteraction(')
  )

  const leaseIndex = scheduleSource.indexOf('beginSelectionFocusLease()')
  const invalidateIndex = scheduleSource.indexOf('invalidateSelectionFlowWithFocusCleanup()')
  const showButtonIndex = scheduleSource.indexOf('showSelectionButton(anchor)')
  const autoIndex = scheduleSource.indexOf('selectionInteraction.beginTranslation()')
  assert.ok(leaseIndex >= 0, '划词开始必须取得焦点租约')
  assert.ok(leaseIndex < invalidateIndex, '焦点保护必须先于旧流程失效和窗口动作')
  assert.ok(leaseIndex < showButtonIndex, '按钮显示前必须已取得焦点保护')
  assert.ok(leaseIndex < autoIndex, '自动取词开始前必须已取得焦点保护')

  assert.match(releaseSource, /isPopupVisible\(\)/u,
    '交互 token 释放时必须检查弹窗是否仍可见')
  assert.match(releaseSource, /releaseSelectionFocusLease\(\)/u,
    '弹窗不可见且没有新交互时必须释放划词租约')
  const popupGuardIndex = releaseSource.indexOf('isPopupVisible()')
  const leaseReleaseIndex = releaseSource.indexOf('releaseSelectionFocusLease()')
  assert.ok(popupGuardIndex >= 0 && leaseReleaseIndex > popupGuardIndex,
    '弹窗仍可见时不得提前释放划词焦点租约')
})

test('显式打开设置页不得在异步建窗前提前恢复焦点租约', () => {
  const openSource = stripComments(
    extractFunction(mainSource, 'async function openSettings(')
  )
  const restoreIndex = openSource.indexOf('forceRestoreSettingsWindowFocus(')
  const createIndex = openSource.indexOf('createSettingsWindow(')

  // 真机日志显示启动首开会在 createSettingsWindow() 的 ready-to-show、Dock 刷新与
  // 事件循环让出期间继续等待。若在 await 之前恢复可聚焦性，用户此时切换应用并
  // 划词，macOS 会把后台设置页重新选为 key window，表现为首次划词设置页闪现。
  assert.ok(createIndex >= 0, 'openSettings() 必须继续创建或复用设置窗口')
  assert.ok(
    restoreIndex < 0 || restoreIndex > createIndex,
    '恢复可聚焦性必须下沉到窗口确实准备置前的分支，不得在建窗前执行'
  )
  assert.match(
    openSource,
    /createSettingsWindow\(\s*options\.bringToFront \?\? true,\s*options\.source,\s*options\.dockActivationEpoch\s*\)/u,
    'openSettings() 必须把显式置前意图、来源与 Dock 代际透传给窗口创建入口'
  )
})

test('快捷键延迟取词必须在启动旧流程前校验交互 token', () => {
  const hotkeySource = stripComments(
    extractFunction(mainSource, 'function onHotkey(): void {')
  )
  const timeoutStart = hotkeySource.indexOf('setTimeout(')
  const timeoutEnd = hotkeySource.indexOf('captureDelay', timeoutStart)

  // Windows 快捷键取词会先等待 300ms 释放修饰键。等待期间用户可能复制/粘贴、
  // 切换触发模式或开始新一轮划词，旧定时器若仍进入 queueSelectionTranslation()，
  // 会在 token 校验前启动一次取词并干扰新流程。回调必须先确认本次 token 仍是
  // 当前交互，再启动取词。
  assert.ok(timeoutStart >= 0, '快捷键应保留延迟取词定时器')
  assert.ok(timeoutEnd > timeoutStart, '延迟取词定时器应使用 captureDelay')
  const delayedCaptureSource = hotkeySource.slice(timeoutStart, timeoutEnd)
  const currentCheckIndex = delayedCaptureSource.indexOf(
    'selectionInteraction.isCurrent(interactionToken)'
  )
  const queueIndex = delayedCaptureSource.indexOf(
    'queueSelectionTranslation(undefined, interactionToken, true, popupCloseVersion)'
  )
  assert.ok(currentCheckIndex >= 0, '延迟回调必须校验本次交互 token 是否仍有效')
  assert.ok(queueIndex > currentCheckIndex, 'token 校验必须位于延迟取词启动之前')
})

test('macOS 前台交还模块不得再导出补偿性 API', () => {
  const code = stripComments(macSource)

  for (const removed of [
    'isMacAppActive(',
    'isFrontmostAppSelf(',
    'wasFrontmostAppSelf(',
    'isFrontmostHandBackInFlight(',
    'whenFrontmostHandBackSettled(',
    'beginInternalWindowTeardown(',
    'endInternalWindowTeardown(',
    'isInternalWindowTeardownActive(',
    'rememberFrontmostAppBeforeActivation(',
    'refreshFrontmostAppForSelection(',
    'rememberFrontmostAppIfInactive(',
    'restoreFrontmostAppForCapture(',
    'waitForFrontmostAppReturn('
  ]) {
    assert.ok(!code.includes(removed), `macForeground.ts 不应再包含 ${removed}`)
  }
})

test('翻译弹窗隐藏必须交还前台后再隐藏，且不得隐藏整个应用', () => {
  const hideSource = stripComments(
    extractFunction(popupSource, 'export function hidePopup(')
  )

  assert.match(hideSource, /win\?\.hide\(\)/u, '隐藏弹窗必须最终调用 win.hide()')
  assert.match(hideSource, /handBackFrontmostThen\(/u,
    '结果弹窗隐藏前必须复用共享前台交还链路')
  assert.doesNotMatch(hideSource, /yieldFrontmostAppThen|app\.hide\(\)/u,
    '隐藏弹窗不得直接隐藏整个应用')
  assert.doesNotMatch(hideSource, /hidingAfterFrontReturn|beginInternalWindowTeardown/u,
    '隐藏弹窗不得再维护前台交还收尾状态')
})

test('安全让出前台恢复应用后必须保持原本隐藏窗口的隐藏状态', () => {
  const yieldSource = stripComments(
    extractFunction(macSource, 'function yieldFrontmostApp(')
  )

  // app.hide() 会隐藏整个应用，app.show() 又会恢复应用内窗口。若不在隐藏前记录
  // 每个窗口的可见性，原本关闭的弹窗或后台窗口会被重新显示；设置页也可能因此
  // 重新出现在用户当前应用之上。恢复后必须只保留隐藏前已经可见的窗口。
  const snapshotIndex = yieldSource.indexOf('BrowserWindow.getAllWindows()')
  // 注释里也会出现 app.hide()/app.show() 文本，必须从实际调用点开始定位。
  const hideIndex = yieldSource.indexOf('\n    app.hide()', snapshotIndex)
  const showIndex = yieldSource.indexOf('\n      app.show()', snapshotIndex)
  const restoreIndex = yieldSource.indexOf('!snapshot.wasVisible', showIndex)

  assert.ok(snapshotIndex >= 0, '安全让出前必须采集自有窗口可见性快照')
  assert.ok(hideIndex > snapshotIndex, '必须先采集可见性再隐藏应用')
  assert.ok(showIndex > snapshotIndex, '等待失活后仍需恢复应用可见性')
  assert.ok(restoreIndex > showIndex, 'app.show() 后必须恢复隐藏窗口的原状态')
  assert.match(
    yieldSource,
    /if \(!snapshot\.wasVisible[\s\S]*?snapshot\.window\.hide\(\)/u,
    '原本隐藏的窗口不得因 app.show() 被重新显示'
  )
  assert.doesNotMatch(
    yieldSource,
    /\.showInactive\(\)|\.focus\(\)|\.moveTop\(\)/u,
    '安全让出必须依赖 app.show() 整体恢复，不得逐窗口置前'
  )
})

test('共享前台策略只保留 Windows 语义', () => {
  const code = stripComments(readFileSync('src/shared/popupForeground.ts', 'utf8'))

  assert.doesNotMatch(code, /POPUP_RESULT_ACTIVATION_SETTLE_MS/u)
  assert.doesNotMatch(code, /POPUP_RESULT_ACTIVATION_REFOCUS_DELAY_MS/u)
  assert.doesNotMatch(code, /shouldDeactivatePopupBeforeMacCapture/u)
  assert.match(code, /shouldRestoreForegroundBeforeCapture/u)
})

test('Dock 呈现切换等内部刷新不得恢复、置前或聚焦设置窗口', () => {
  const applySource = extractFunction(mainSource, 'async function applyMacOSDockVisibility(')
  const executableSource = stripComments(applySource)

  // 切换激活策略会重排窗口层级。内部刷新可能在交互状态短暂回到 idle 时触发，
  // 且 macOS 的 showInactive() 仍会 orderFrontRegardless，因此不得尝试恢复设置页，
  // 更不得通过 show()/focus()/moveTop() 把设置页越过用户当前应用拉到最前。
  assert.doesNotMatch(
    executableSource,
    /settingsWindowToPreserve/u,
    '内部刷新不得保留或恢复设置窗口'
  )
  assert.doesNotMatch(
    executableSource,
    /\.showInactive\(\)|settingsWin\.show\(\)|settingsWin\.focus\(\)|settingsWin\.moveTop\(\)|showOwnWindowForInteraction\(/u,
    '内部刷新不得恢复、置前或聚焦设置窗口'
  )
})

test('窗口级置前入口不得激活整个应用', () => {
  const helperSource = stripComments(
    extractFunction(mainSource, 'function showOwnWindowForInteraction(')
  )

  // macOS 上窗口层级单位是应用：app.focus() 会把同应用所有可见窗口一起提到最前。
  // 设置窗口改为 nonactivating panel 后，只允许提升目标窗口自身。
  assert.doesNotMatch(helperSource, /app\.focus\(/u, '统一置前入口不得调用 app.focus')
  assert.match(helperSource, /win\.show\(\)/u, '统一置前入口必须显示目标窗口自身')
  assert.match(helperSource, /win\.focus\(\)/u, '统一置前入口必须让目标窗口取得键盘焦点')
})

test('设置窗口创建与复用路径不得激活整个应用或恢复焦点挂起', () => {
  const createSource = stripComments(
    extractFunction(mainSource, 'async function createSettingsWindow(')
  )

  assert.doesNotMatch(createSource, /app\.focus\(/u, '创建/复用设置窗口不得激活整个应用')
  assert.doesNotMatch(createSource, /resumeSettingsWindowFocusAfterSelection|setFocusable\(/u,
    '创建/复用设置窗口不得依赖已删除的焦点恢复机制')
  assert.match(createSource, /showOwnWindowForInteraction\(/u, '设置窗口必须走统一窗口级置前入口')
})

test('Dock 激活路径不得为迟到 activate 恢复后台设置页可聚焦性', () => {
  const activateSource = stripComments(
    extractFunction(mainSource, 'function activateExistingPageOrOpenSettings(): void {')
  )

  // macOS 会在切换应用、划词按钮和弹窗收尾时派发迟到 activate，无法仅凭
  // activate 可靠区分真实 Dock 点击。后台已可见设置页收到这种事件时只能结束
  // 焦点租约引用，不得 setFocusable(true)，否则系统会立即把设置页提到最前。
  assert.doesNotMatch(activateSource, /forceRestoreSettingsWindowFocus\(process\.platform,\s*settingsWin\)/u,
    '迟到 activate 不得恢复后台设置页可聚焦性')
  assert.doesNotMatch(activateSource, /resumeSettingsWindowFocusAfterSelection|\.setFocusable\(/u,
    'Dock 激活路径不得残留旧焦点恢复机制或直接切换窗口能力')
  // Dock 激活先恢复全部窗口，再通过最近焦点记录选择唯一目标；不能固定优先
  // 某个工作区，否则文件翻译或设置页会被错误聚焦。
  assert.match(activateSource, /ownedWindowFocusRecency\.resolveMostRecent\(/u,
    'Dock 激活必须按最近使用顺序选择窗口')
  assert.match(
    activateSource,
    /openSettings\(\{[\s\S]*?bringToFront:\s*true[\s\S]*?explicitEntry:\s*true[\s\S]*?source:\s*'dock'[\s\S]*?dockActivationEpoch[\s\S]*?\}\)/u,
    '没有阅读器时 Dock 激活必须携带独立来源与激活代际置前设置页'
  )
})

test('activate 复用已可见且未最小化的设置页时仍须安全置前', () => {
  const activateSource = stripComments(
    extractFunction(mainSource, 'function activateExistingPageOrOpenSettings(): void {')
  )

  // 设置页已可见但被其它应用遮挡时，真实 Dock 点击仍必须复用并安全置前。
  // 不能因为 isVisible() 为 true 就提前返回，否则用户会感觉 Dock 图标完全无响应。
  assert.doesNotMatch(
    activateSource,
    /settingsWin\.isVisible\(\)\s*&&\s*!settingsWin\.isMinimized\(\)[\s\S]*?releaseSelectionFocusLease\(\)[\s\S]*?return/u,
    '已可见设置页不得在 Dock 激活路径中提前返回'
  )
  assert.match(
    activateSource,
    /openSettings\(\{[\s\S]*?bringToFront:\s*true[\s\S]*?explicitEntry:\s*true[\s\S]*?source:\s*'dock'[\s\S]*?dockActivationEpoch[\s\S]*?\}\)[\s\S]*?yieldToEventLoop\(\)[\s\S]*?bringSettingsWindowToFrontSafely\(target,\s*\{[\s\S]*?raiseLevel:\s*false/u,
    '已可见设置页收到有效 Dock 激活后必须复用窗口并再次安全置前'
  )
  assert.doesNotMatch(
    activateSource,
    /settingsWin\.(?:focus|moveTop|show)\(/u,
    'Dock 激活路径不得绕过统一安全置前入口直接操作窗口'
  )
})

test('应用失活后迟到的 Dock 补置前必须失效', () => {
  const completeSource = stripComments(
    extractFunction(mainSource, 'function canCompleteSettingsBringToFront(')
  )
  const activateSource = stripComments(
    extractFunction(mainSource, 'function activateExistingPageOrOpenSettings(): void {')
  )

  // Dock activate 与最终补置前之间存在多个异步边界。用户切到其它应用后，
  // 旧任务若继续 moveTop()/focus() 会把设置页重新拉到最前，表现为设置页
  // “永远盖在其它应用上面”。统一入口必须把应用激活事件作为最终门禁。
  assert.match(
    completeSource,
    /isMacAppActiveByEvents\(\)/u,
    '统一置前入口必须拒绝应用失活后的迟到置前'
  )
  // 连续 Dock activate 可能各自排队；只保留最新一次请求，避免旧请求在用户
  // 重新激活应用后突然执行，与最新一次请求竞争并重复拉起设置页。
  assert.match(
    activateSource,
    /const dockActivationEpoch\s*=\s*\+\+settingsDockActivationEpoch/u,
    '每次 Dock activate 必须登记独立请求代际'
  )
  assert.match(
    activateSource,
    /dockActivationEpoch\s*!==\s*settingsDockActivationEpoch/u,
    'Dock 补置前必须丢弃已被更新请求取代的旧任务'
  )
})

test('Dock 首次激活不得因 did-become-active 尚未落定而静默丢弃置前请求', () => {
  const activateSource = stripComments(
    extractFunction(mainSource, 'function activateExistingPageOrOpenSettings(): void {')
  )
  const openSource = stripComments(extractFunction(mainSource, 'async function openSettings('))
  const createSource = stripComments(
    extractFunction(mainSource, 'async function createSettingsWindow(')
  )
  const completeSource = stripComments(
    extractFunction(mainSource, 'function canCompleteSettingsBringToFront(')
  )

  // macOS 可能先派发 activate，再派发 did-become-active。此时仅凭
  // isMacAppActiveByEvents() 会误判为失活并吞掉第一次 Dock 点击。activate
  // 判定放行后必须把当前 Dock 请求代际传到统一置前门禁，由门禁在“激活事件
  // 短暂延迟”与“用户真的切走”之间做区分。
  assert.match(
    activateSource,
    /openSettings\(\{[\s\S]*?source:\s*'dock'[\s\S]*?dockActivationEpoch[\s\S]*?\}\)/u,
    'Dock 激活必须把请求来源与代际传给 openSettings'
  )
  assert.match(
    openSource,
    /source\?:\s*'popup'\s*\|\s*'initial-launch'\s*\|\s*'dock'/u,
    'openSettings 必须显式支持 Dock 来源'
  )
  assert.match(openSource, /dockActivationEpoch\?:\s*number/u,
    'openSettings 必须接收本次 Dock 激活代际')
  assert.match(
    openSource,
    /createSettingsWindow\([\s\S]*?options\.source[\s\S]*?options\.dockActivationEpoch/u,
    'openSettings 必须把 Dock 来源与代际传给窗口创建路径'
  )
  assert.match(createSource, /source\?:\s*'popup'\s*\|\s*'initial-launch'\s*\|\s*'dock'/u,
    'createSettingsWindow 必须显式支持 Dock 来源')
  assert.match(createSource, /dockActivationEpoch\?:\s*number/u,
    'createSettingsWindow 必须接收本次 Dock 激活代际')
  assert.match(createSource, /const dockActivationEpochAtStart\s*=\s*source\s*===\s*'dock'/u,
    '只有 Dock 来源可以携带激活代际进入置前门禁')
  assert.match(completeSource, /shouldCompleteSettingsBringToFront\(/u,
    '统一置前门禁必须使用可单测的 Dock 激活判定')
  assert.match(completeSource, /dockActivationEpoch,/u,
    '统一置前门禁必须把 Dock 激活代际交给判定函数')
  assert.match(completeSource, /currentDockActivationEpoch:\s*settingsDockActivationEpoch/u,
    '统一置前门禁必须用最新 Dock 代际识别真正失活')
})

test('启动首开必须使用独立来源，不能因启动期失活事件被永久吞掉', () => {
  const openSource = stripComments(extractFunction(mainSource, 'async function openSettings('))
  const createSource = stripComments(
    extractFunction(mainSource, 'async function createSettingsWindow(')
  )
  const completeSource = stripComments(
    extractFunction(mainSource, 'function canCompleteSettingsBringToFront(')
  )

  // macOS 在应用启动期间可能先派发 did-resign-active，新提交又会让该事件递增
  // 设置页置前代际。启动首开若仍走普通 Dock/activate 来源，就会在 ready-to-show
  // 时被判定过期，窗口只创建不显示。启动首开必须携带独立来源，并只在没有真实
  // 划词风险时豁免启动期噪声。
  assert.match(
    mainSource,
    /if \(openSettingsOnInitialLaunch\) await openSettings\(\{\s*bringToFront:\s*true,\s*source:\s*'initial-launch'\s*\}\)/u,
    '启动首开必须向统一打开入口传递 initial-launch 来源'
  )
  assert.match(
    createSource,
    /source\?:\s*'popup'\s*\|\s*'initial-launch'/u,
    '设置窗口打开来源必须同时区分弹窗入口与启动首开'
  )
  assert.match(
    createSource,
    /const initialLaunchSource = source === 'initial-launch'/u,
    '设置窗口创建路径必须显式识别启动首开来源'
  )
  assert.match(
    completeSource,
    /initialLaunchSource,[\s\S]*?selectionGuardActive:\s*isSelectionWindowRaiseGuardActive\(\)[\s\S]*?selectionInteractionIdle:\s*selectionInteraction\.snapshot\(\)\.state === 'idle'[\s\S]*?appActive:\s*isMac\s*\?\s*isMacAppActiveByEvents\(\)\s*:\s*true/u,
    '启动首开只能豁免应用失活门禁，仍必须阻止划词保护期或进行中交互抢前台；非 macOS 不得误判失活'
  )

  const initialLaunchEpochBypassCount =
    (createSource.match(
      /bringToFrontEpochAtStart\s*!==\s*settingsBringToFrontEpoch\s*&&\s*!initialLaunchSource/gu
    ) ?? []).length
  assert.ok(
    initialLaunchEpochBypassCount >= 5,
    `启动首开的所有显式置前出口都必须忽略启动期代际噪声，当前仅 ${initialLaunchEpochBypassCount} 处`
  )
})

test('弹窗真实隐藏前后必须短暂撤销设置页的 key window 候选资格', () => {
  const createSource = stripComments(
    extractFunction(popupSource, 'export function createPopup(')
  )
  const hideSource = stripComments(
    extractFunction(popupSource, 'export function hidePopup(')
  )
  const hideIndex = hideSource.indexOf('win?.hide()')
  const closeStartIndex = hideSource.indexOf('onPopupCloseStartCallback?.(closeToken)')
  const closeEndIndex = hideSource.indexOf('onPopupCloseEndCallback?.(closeToken)', hideIndex)

  assert.match(popupSource, /onPopupCloseStart\?:\s*\(token:\s*number\)\s*=>\s*void/u,
    '弹窗创建入口必须接收关闭开始回调')
  assert.match(popupSource, /onPopupCloseEnd\?:\s*\(token:\s*number\)\s*=>\s*void/u,
    '弹窗创建入口必须接收关闭结束回调')
  assert.match(createSource, /onPopupCloseStartCallback = options\.onPopupCloseStart \?\? null/u,
    '关闭开始回调必须保存到模块状态')
  assert.match(createSource, /onPopupCloseEndCallback = options\.onPopupCloseEnd \?\? null/u,
    '关闭结束回调必须保存到模块状态')
  assert.ok(closeStartIndex >= 0, '关闭入口必须同步撤销设置页焦点候选资格')
  assert.ok(closeStartIndex < hideIndex, '焦点保护必须早于 win.hide()')
  assert.ok(closeEndIndex > hideIndex, '焦点恢复必须晚于 win.hide()')
  assert.match(
    mainSource,
    /createPopup\(\s*\{[\s\S]*?onPopupCloseStart:\s*handlePopupCloseStart,[\s\S]*?onPopupCloseEndBeforeHideRestore:\s*finishPopupInternalWindowTransitionBeforeFocusRestore,[\s\S]*?onFrontRecheckComplete:\s*releaseSettingsWindowFocusLeaseAfterFrontRecheck,[\s\S]*?onPopupCloseEnd:\s*handlePopupCloseEnd,[\s\S]*?onPopupCloseCancelled:\s*handlePopupCloseCancelled\s*\}\s*\)/u,
    '主进程必须把弹窗隐藏前后焦点保护注入翻译弹窗'
  )
  assert.match(
    mainSource,
    /suspendSettingsWindowFocusForPopupHide\(\s*process\.platform,\s*settingsWin,\s*\{\s*appActive:\s*isMacAppActiveByEvents\(\)\s*\}\s*\)/u,
    '主进程必须仅在 macOS 可见设置页上启用焦点保护'
  )
})

/**
 * 校验设置页可聚焦性必须等到弹窗隐藏后的前台复核收尾才恢复。
 *
 * 真机日志显示源应用已恢复后，`popup-hide` 前仍可能短暂出现设置页；
 * 若在 `win.hide()` 后立即恢复其 key window 候选资格，本应用再次置前时
 * 会把设置页重新提升到翻译界面之前。
 * @returns 无返回值。
 * @author zhenghq
 */
test('弹窗隐藏后的设置页可聚焦性必须延迟到前台复核收尾恢复', () => {
  const popupCreateSource = stripComments(
    extractFunction(popupSource, 'export function createPopup(')
  )
  const hideSource = stripComments(
    extractFunction(popupSource, 'export function hidePopup(')
  )
  const mainSourceStripped = stripComments(mainSource)
  const beforeHideRestoreIndex = hideSource.indexOf(
    'onPopupCloseEndBeforeHideRestoreCallback?.(closeToken)',
    hideSource.indexOf('win?.hide()')
  )
  const fullEndRestoreIndex = hideSource.indexOf(
    'onPopupCloseEndCallback?.(closeToken)',
    beforeHideRestoreIndex
  )

  assert.match(popupSource, /onPopupCloseEndBeforeHideRestore\?:\s*\(token:\s*number\)\s*=>\s*void/u)
  assert.match(popupSource, /onFrontRecheckComplete\?:\s*\(token:\s*number,\s*restored:\s*boolean\)\s*=>\s*void/u)
  assert.match(popupCreateSource, /onPopupCloseEndBeforeHideRestoreCallback = options/u)
  assert.match(popupCreateSource, /onFrontRecheckCompleteCallback = options/u)
  assert.ok(beforeHideRestoreIndex > hideSource.indexOf('win?.hide()'))
  assert.ok(fullEndRestoreIndex > beforeHideRestoreIndex)
  assert.match(mainSourceStripped, /onPopupCloseEndBeforeHideRestore:/u)
  assert.match(mainSourceStripped, /onFrontRecheckComplete:/u)
  assert.match(
    mainSourceStripped,
    /function releaseSettingsWindowFocusLeaseAfterFrontRecheck[\s\S]*?const slot = restoreSettingsWindowFocusAfterPopupFrontRecheck[\s\S]*?if \(!slot \|\| slot\.token !== token\) return[\s\S]*?slot\.restore\(\)/u
  )

  // 回归：onPopupCloseEnd 此前仍会同步恢复 focusable，绕过复核延迟保护；
  // 真实隐藏后的通用收尾不得执行 handlePopupCloseEnd。
  assert.ok(
    fullEndRestoreIndex > beforeHideRestoreIndex,
    'win.hide() 后的通用收尾回调必须先于前台复核回调'
  )
  // 只允许带“非延迟交还路径”守卫的同步恢复调用；裸调用会绕过复核保护。
  // 复核完成后的兜底回调不属于同步隐藏收尾，因此断言只检查到异步交还分支前。
  const syncHideCleanupSource = hideSource.slice(
    beforeHideRestoreIndex,
    hideSource.indexOf('if (process.platform === \'darwin\' && handBackFrontmost)')
  )
  for (const match of syncHideCleanupSource.matchAll(
    /onPopupCloseEndCallback\?\.\(closeToken\)/gu
  )) {
    const guard = syncHideCleanupSource.slice(
      Math.max(0, match.index - 120),
      match.index
    )
    assert.match(
      guard,
      /if \(!restoreFocusAfterFrontRecheck\)/u,
      'macOS 延迟交还路径不得在隐藏后同步恢复设置页可聚焦性'
    )
  }
})
