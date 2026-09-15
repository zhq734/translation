import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { shouldActivatePopupForCaptureFailure } from '../src/shared/popupForeground.ts'

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

const popupSource = readFileSync('src/main/popup.ts', 'utf8')
const mainSource = readFileSync('src/main/index.ts', 'utf8')
const macForegroundSource = readFileSync('src/main/macForeground.ts', 'utf8')

test('弹窗隐藏前先把 macOS 前台交还出去', () => {
  const hideSource = extractFunction(popupSource, 'export function hidePopup(): void {')

  // 弹窗通常是应用内最后一个 key window：直接隐藏会让系统把设置页提升为 key window 并顶到最前。
  assert.match(hideSource, /handBackFrontmostThen\(win, \(\) => \{/u, '必须复用共享交还逻辑')
  assert.match(hideSource, /hidingAfterFrontReturn = true/u, '交还期间必须标记为逻辑关闭')
  assert.match(hideSource, /win\?\.hide\(\)/u, '交还完成后才隐藏窗口')
  // 激活源应用会让弹窗失焦，不能被 handlePopupBlur 当成用户点击外部而重复关闭。
  assert.ok(
    hideSource.indexOf('restoringForegroundUntil = Date.now()') <
      hideSource.indexOf('handBackFrontmostThen(win'),
    '必须在交还前台之前标记这段失焦为内部动作'
  )
  // 交还期间再次调用不能重复发起交还，否则会把用户当前在用的应用换掉。
  assert.match(hideSource, /hidingAfterFrontReturn\) return/u, '交还进行中必须短路重复隐藏')
})

test('交还期间的弹窗按已关闭对待，避免复用即将隐藏的窗口', () => {
  const visibleSource = extractFunction(popupSource, 'export function isPopupVisible(): boolean {')
  const activatedSource = extractFunction(popupSource, 'export function isPopupActivated(): boolean {')
  const showSource = extractFunction(popupSource, 'export function showPopup(')
  const createSource = extractFunction(popupSource, 'export function createPopup(preloadPath: string): BrowserWindow {')

  assert.match(visibleSource, /!hidingAfterFrontReturn/u, '可见状态必须排除交还期间')
  assert.match(activatedSource, /!hidingAfterFrontReturn/u, '激活状态必须排除交还期间')
  // 弹窗仍可见但正在交还时，新请求必须按「未显示」处理，否则会复用即将隐藏的窗口。
  assert.match(
    showSource,
    /const alreadyVisible = win\.isVisible\(\) && !hidingAfterFrontReturn/u,
    '显示判定必须排除交还期间'
  )
  // 重建窗口时必须复位，否则新窗口会一直被认为正在交还。
  assert.match(createSource, /hidingAfterFrontReturn = false/u, '创建窗口时必须复位交还标记')
})

test('划词弹窗显示前记录源应用，供最终隐藏时交还', () => {
  const readingSource = extractFunction(mainSource, 'function showSelectionReadingPopup(')

  // 此刻本应用还不是前台应用，读到的就是用户原本在用的应用。
  assert.match(readingSource, /rememberFrontmostAppIfInactive\(\)/u, '必须记录源应用')
  assert.ok(
    readingSource.indexOf('rememberFrontmostAppIfInactive()') <
      readingSource.indexOf('showPopup('),
    '必须在显示弹窗之前记录源应用'
  )
})

/**
 * 截取 handleSelectionCaptureResult 中「未取到文字」提示分支的源码。
 * @returns 从失败分支开始到提示弹窗调用结束的源码片段。
 * @author zhenghq
 */
function selectionCaptureFailureSource(): string {
  const start = mainSource.indexOf('if (!result.text) {')
  const end = mainSource.indexOf('if (shouldPromptHiServicesRepair)', start)
  assert.ok(start >= 0, 'handleSelectionCaptureResult 应有取词失败分支')
  assert.ok(end > start, '取词失败分支应有结束边界')
  return mainSource.slice(start, end)
}

test('macOS 上取词失败提示必须以非激活方式显示，避免设置页被顶到最前', () => {
  // macOS：失败提示若激活本应用，提示自动隐藏时系统会把设置页提升为 key window 顶到最前。
  assert.equal(shouldActivatePopupForCaptureFailure('darwin'), false)
  // Windows / Linux 保持原有激活行为，避免影响取词焦点时序。
  assert.equal(shouldActivatePopupForCaptureFailure('win32'), true)
  assert.equal(shouldActivatePopupForCaptureFailure('linux'), true)

  const failureSource = selectionCaptureFailureSource()
  assert.match(
    failureSource,
    /result\.anchor,\s*shouldActivatePopupForCaptureFailure\(process\.platform\)/u,
    '取词失败提示的激活方式必须由平台策略决定，不能沿用默认激活'
  )
})

test('macOS 连续取词超时提示必须交还前台且结果提示不得重新激活应用', () => {
  const promptSource = extractFunction(mainSource, 'function promptHiServicesRepair(')

  // 原生消息框会激活本应用；阅读器作为应用内下一个 key window 会被系统顶到最前。
  assert.match(
    promptSource,
    /await rememberFrontmostAppIfInactiveAsync\(\)[\s\S]*?dialog\.showMessageBox\(/u,
    '显示原生修复提示前必须记录源应用并等待快照完成'
  )
  assert.match(
    promptSource,
    /showPopup\([\s\S]*?shouldActivatePopupForCaptureFailure\(process\.platform\)/u,
    '修复结果提示必须复用 macOS 非激活显示策略'
  )
})

test('原生修复对话框关闭后必须依据应用激活状态交还前台', () => {
  const handBackAppSource = extractFunction(
    macForegroundSource,
    'export function handBackFrontmostApp(): Promise<boolean> {'
  )
  // dialog.showMessageBox 是原生对话框而不是 BrowserWindow：对话框存在时
  // BrowserWindow.getFocusedWindow() 返回 null，但本应用仍然处于最前。
  // 若据此判断「无需交还」，对话框关闭后系统会把网页翻译窗口提升到最前。
  assert.match(handBackAppSource, /!isMacAppActive\(\)/u, '必须依据应用激活状态判断是否仍需交还前台')
  assert.match(
    handBackAppSource,
    /if \(!isMacAppActive\(\)\) \{\s*\n\s*forgetFrontmostApp\(\)/u,
    '本应用确实不在最前时才能放弃交还'
  )
  // 交还过程中同样必须等待应用失活，不能只看 BrowserWindow 焦点。
  assert.match(
    handBackAppSource,
    /if \(!isMacAppActive\(\)\) \{\s*\n\s*finish\(true\)/u,
    '必须轮询应用失活后才算交还完成'
  )
  // Electron 33 不提供 app.isActive()，必须通过获得/失去激活事件自行跟踪应用状态。
  assert.match(macForegroundSource, /app\.on\('did-become-active'/u, '必须跟踪应用获得激活')
  assert.match(macForegroundSource, /app\.on\('did-resign-active'/u, '必须跟踪应用失去激活')
  assert.doesNotMatch(handBackAppSource, /app\.isActive\(\)/u, 'Electron 33 不提供 app.isActive()')
})

test('原生修复对话框显示期间隐藏失败提示不得丢弃待交还记录', () => {
  const handBackThenSource = extractFunction(
    macForegroundSource,
    'export function handBackFrontmostThen('
  )

  // 修复对话框持有 key window 时 BrowserWindow.getFocusedWindow() 返回 null，
  // 但本应用仍处于最前。失败提示在这期间自动隐藏，若此时丢弃待交还记录，
  // 对话框关闭后就没有目标可以交还，网页翻译窗口会被系统顶到最前。
  assert.match(
    handBackThenSource,
    /if \(focused === null\) \{[\s\S]*?if \(isMacAppActive\(\)\) \{\s*\n\s*run\(\)\s*\n\s*return\s*\n\s*\}/u,
    '应用仍在前台（对话框持有 key window）时必须保留待交还记录'
  )
  assert.match(
    handBackThenSource,
    /if \(isMacAppActive\(\)\) \{[\s\S]*?forgetFrontmostApp\(\)/u,
    '只有应用确实失活时才能丢弃待交还记录'
  )
})

test('macOS 交还失败时弹窗必须走安全退化路径，不能直接隐藏应用内 key window', () => {
  const hideSource = extractFunction(popupSource, 'export function hidePopup(): void {')

  // 本应用仍是最前时直接隐藏应用内 key window，系统会把应用内下一个窗口
  // （正在后台打开的网页阅读器）提升为 key window 并顶到用户应用之上。
  // 拿不到源应用或激活无效时必须走独立退化回调，不能直接执行隐藏。
  assert.match(
    hideSource,
    /handBackFrontmostThen\(\s*win,\s*\(\) => \{[\s\S]*?\n  \}, \(\) => \{/u,
    '必须为交还失败注册独立退化回调'
  )
  assert.match(hideSource, /yieldFrontmostAppThen\(/u, '退化回调必须复用安全让出前台逻辑')
})

test('安全让出前台必须先确认应用失活再收尾，最后非激活恢复窗口', () => {
  const source = extractFunction(
    macForegroundSource,
    'export function yieldFrontmostAppThen('
  )

  assert.match(source, /app\.hide\(\)/u, '必须用 app.hide() 让系统把前台还给用户原本在用的应用')
  assert.match(
    source,
    /if \(!isMacAppActive\(\)\) \{\s*\n\s*finish\(\)/u,
    '必须轮询确认本应用真正失活后才执行收尾'
  )
  // 未等待失活就收尾仍会把阅读器顶到最前（真机 CGWindowList 采样验证过）。
  assert.match(source, /setTimeout\(poll, FRONT_RETURN_POLL_INTERVAL_MS\)/u, '必须有失活轮询')
  // app.hide() 隐藏整个应用期间，弹窗的 isVisible() 也返回 false，收尾函数会
  // 命中可见性短路分支而跳过真正的 win.hide()；随后的 app.show() 再把弹窗恢复
  // 可见，用户表现为「点关闭后弹窗关不掉」。因此必须先非激活恢复应用内窗口，
  // 让收尾动作在弹窗可见状态下真正执行隐藏。
  const finishStart = source.indexOf('const finish = ')
  // 用带缩进的调用语句定位截止点，避免注释中出现的同名文本干扰切片。
  const finishEnd = source.indexOf('\n    app.hide()', finishStart)
  assert.ok(finishStart >= 0 && finishEnd > finishStart, '应存在收尾函数与 app.hide() 调用')
  const finishSource = source.slice(finishStart, finishEnd)
  // 注释中同样会出现 app.show() 字样，必须按真实调用语句校验先后顺序。
  assert.match(
    finishSource,
    /app\.show\(\)\n(?:\s*\/\/[^\n]*\n)*\s*run\(\)/u,
    '必须先非激活恢复应用内窗口，再执行收尾动作'
  )
  assert.match(
    source,
    /if \(process\.platform !== 'darwin'[\s\S]*?\n/u,
    '非 macOS 平台不存在窗口提升问题，必须直接收尾'
  )
})

test('原生对话框交还失败时同样必须先安全让出前台', () => {
  const source = extractFunction(
    macForegroundSource,
    'export function handBackFrontmostApp(): Promise<boolean> {'
  )

  // 对话框关闭后若没有可交还的源应用，直接继续会让系统把网页阅读器提升到最前。
  assert.match(source, /yieldFrontmostAppThen\(/u, '没有可交还目标时必须安全让出前台')
  assert.match(
    source,
    /!target \|\| !isProcessAlive\(target\.pid\)[\s\S]*?yieldFrontmostAppThen\(/u,
    '目标缺失或已退出时必须走安全退化路径'
  )
})

test('弹窗以激活方式显示前必须记录源应用，避免收尾时无目标可交还', () => {
  const showSource = extractFunction(popupSource, 'export function showPopup(')

  // 上一轮翻译结果弹窗用 win.show() 激活本应用后，本轮取词时 rememberFrontmostAppIfInactive()
  // 会因为应用内已有焦点窗口而跳过记录，收尾只能落到实测不稳定的 app.hide()→app.show() 兜底。
  // 因此激活显示之前必须记录源应用，让可靠的 open -b 交还路径真正执行。
  assert.match(
    showSource,
    /if \(activate\) rememberFrontmostAppBeforeActivation\(\)/u,
    '激活显示前必须记录源应用'
  )
  assert.ok(
    showSource.indexOf('rememberFrontmostAppBeforeActivation()') < showSource.indexOf('win.show()'),
    '记录源应用必须早于 win.show()'
  )
})

test('收尾抑制期必须在隐藏真正生效之后才结束', () => {
  const hideSource = extractFunction(popupSource, 'export function hidePopup(): void {')

  // win.hide() 异步生效：若在调用 hide 之前就清除标记，收尾期到达的内部事件会看到标记已失效。
  assert.ok(
    hideSource.indexOf('hidingAfterFrontReturn = false') > hideSource.indexOf('win?.hide()'),
    'hidingAfterFrontReturn 必须在 win.hide() 之后才清除'
  )
  assert.match(hideSource, /beginInternalWindowTeardown\(\)/u, '收尾开始必须进入抑制期')
  assert.match(hideSource, /endInternalWindowTeardown\(\)/u, '收尾结束必须退出抑制期')
})

test('弹窗收尾失败时不得直接隐藏应用内 key window', () => {
  const hideSource = extractFunction(popupSource, 'export function hidePopup(): void {')

  assert.match(hideSource, /yieldFrontmostAppThen\(/u, '退化回调必须复用安全让出前台逻辑')
  // 退化分支同样受抑制期保护，且必须在收尾完成后才释放。
  const fallbackStart = hideSource.indexOf('yieldFrontmostAppThen(')
  assert.ok(fallbackStart > 0, '必须存在退化分支')
  assert.ok(
    hideSource.indexOf('endInternalWindowTeardown()', fallbackStart) > fallbackStart,
    '退化分支完成后必须释放抑制期'
  )
})

test('应用内已有焦点窗口时仍必须记录源应用', () => {
  const syncSource = extractFunction(
    macForegroundSource,
    'export function rememberFrontmostAppIfInactive(): void {'
  )
  const asyncSource = extractFunction(
    macForegroundSource,
    'export async function rememberFrontmostAppIfInactiveAsync(): Promise<void> {'
  )

  // 应用内存在焦点窗口（例如上一轮结果弹窗）不代表本应用占用 macOS 前台；
  // 旧实现据此直接 return，导致源应用记录被跳过。
  assert.doesNotMatch(syncSource, /BrowserWindow\.getFocusedWindow\(\)\s*!==\s*null\)\s*return/u, '不得因应用内焦点窗口跳过记录')
  assert.doesNotMatch(asyncSource, /BrowserWindow\.getFocusedWindow\(\)\s*!==\s*null\)\s*return/u, '不得因应用内焦点窗口跳过记录')
  assert.match(syncSource, /isMacAppActive\(\)/u, '必须按应用级激活状态判断')
  assert.match(asyncSource, /isMacAppActive\(\)/u, '必须按应用级激活状态判断')
})
