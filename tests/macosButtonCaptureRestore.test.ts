import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const indexSource = readFileSync('src/main/index.ts', 'utf8')
const popupSource = readFileSync('src/main/popup.ts', 'utf8')
const selectionButtonSource = readFileSync('src/main/selectionButton.ts', 'utf8')
const macForegroundSource = readFileSync('src/main/macForeground.ts', 'utf8')

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

/**
 * 去掉源码中的块注释与行注释，避免注释文本干扰行为断言。
 * @param source 源码。
 * @returns 移除注释后的源码。
 * @author zhenghq
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

/**
 * 校验 macOS 点击“译”按钮后必须先交还前台再注入复制键。
 * 点击按钮会让本应用成为最前应用，若不交还，注入的 Command+C 会打在
 * 翻译弹窗上而不是 Chrome，剪贴板哨兵不变，最终报取词超时。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 按钮取词必须先交还前台再取词', () => {
  const src = extractFunction(
    indexSource,
    'async function translateSelectionButton(): Promise<void> {'
  )

  assert.match(src, /restoreFrontmostAppForCapture\(\)/u, '按钮取词必须尝试精确交还前台')
  assert.match(src, /waitForFrontmostAppReturn\(\)/u, '交还后必须等待前台真正切换完成')
  assert.ok(
    src.indexOf('restoreFrontmostAppForCapture()') < src.indexOf('consumePreparedBounded()'),
    '交还必须发生在消费预取与复制取词之前'
  )
  assert.ok(
    src.indexOf('waitForFrontmostAppReturn()') < src.indexOf('consumePreparedBounded()'),
    '等待前台交还必须发生在消费预取与复制取词之前'
  )
})

/**
 * 校验划词阶段就记录源应用，避免用户点击“译”按钮后本应用已成最前应用，
 * 此时再读取快照只会读到自身，导致没有可交还目标、复制取词超时。
 * @returns 无返回值。
 * @author zhenghq
 */
test('划词显示按钮前必须记录源应用', () => {
  const src = extractFunction(indexSource, 'function scheduleSelectionAction(')

  assert.match(src, /rememberFrontmostAppIfInactive\(\)/u, '划词阶段必须记录源应用')
  assert.ok(
    src.indexOf('rememberFrontmostAppIfInactive()') < src.indexOf('showSelectionButton('),
    '记录源应用必须发生在显示“译”按钮之前'
  )
})

/**
 * 校验“译”按钮窗口支持在整应用隐藏后按待处理锚点恢复显示。
 * app.hide() 会连同按钮窗口一起隐藏，若此时 showInactive 被吞掉且清空
 * pendingAnchor，按钮将永远不再出现，用户表现为划词后“译”按钮消失。
 * @returns 无返回值。
 * @author zhenghq
 */
test('“译”按钮必须支持按待处理锚点恢复显示', () => {
  assert.match(
    selectionButtonSource,
    /export function restoreSelectionButtonIfPending\(/u,
    '必须导出按钮恢复入口供整应用隐藏后调用'
  )

  const showReady = stripComments(
    extractFunction(selectionButtonSource, 'function showReadySelectionButton(')
  )
  assert.doesNotMatch(
    showReady,
    /pendingAnchor = null/u,
    '显示按钮时不得直接清空待处理锚点，否则 app.hide 期间会被永久丢失'
  )
})

/**
 * 校验安全让出前台后必须恢复被 app.hide() 隐藏的“译”按钮。
 * @returns 无返回值。
 * @author zhenghq
 */
test('安全让出前台恢复应用后必须重放待显示的“译”按钮', () => {
  const src = extractFunction(
    macForegroundSource,
    'export function yieldFrontmostAppThen('
  )

  assert.match(src, /restoreSelectionButtonIfPending\(\)/u, 'app.show() 后必须恢复待显示的按钮')
  assert.ok(
    src.indexOf('app.show()') < src.indexOf('restoreSelectionButtonIfPending()'),
    '恢复按钮必须发生在 app.show() 之后'
  )
})

/**
 * 校验点击弹窗外部时必须主动关闭可见弹窗，触发前台归还。
 *
 * 用户反馈：划词后偶发不出现“译”按钮，点一下翻译弹窗的关闭按钮又能自动恢复。
 * 根因是读取状态弹窗以 showInactive 显示，`shownInactive` 期间 blur 被短路，
 * 用户点击空白处不会关闭弹窗，也就不会交还前台；弹窗长期留在屏上后，
 * 后续划词手势一旦落在弹窗矩形内就被静默吞掉，表现为“译”按钮不出现。
 * 只依赖窗口 blur 在读取状态会漏触发，必须在全局鼠标按下时对弹窗与“译”按钮
 * 之外的点击主动收尾，保证归还流程一定执行；固定弹窗与弹窗内部点击不受影响。
 * @returns 无返回值。
 * @author zhenghq
 */
test('点击弹窗外部必须主动关闭可见弹窗并触发前台归还', () => {
  const src = stripComments(
    extractFunction(indexSource, 'function handleSelectionPointerDown(')
  )

  assert.match(
    src,
    /dismissPopupOnExternalPointerDown\(point\)/u,
    '外部点击必须主动关闭弹窗，不能只依赖 blur'
  )
  assert.ok(
    src.indexOf('dismissPopupOnExternalPointerDown(point)') > src.indexOf("result === 'track'"),
    '外部点击关闭必须发生在按 track 继续跟踪的分支内，弹窗内部点击不触发'
  )

  const dismissSource = stripComments(
    extractFunction(popupSource, 'export function dismissPopupOnExternalPointerDown(')
  )
  assert.match(
    dismissSource,
    /isPopupVisible\(\)/u,
    '读取状态弹窗同样可见，必须按可见性判断而不能只看是否持有前台'
  )
  assert.match(dismissSource, /pinned/u, '固定弹窗不得被外部点击关闭')
  assert.match(dismissSource, /hidePopup\(\)/u, '外部点击必须触发弹窗关闭以归还前台')
})

/**
 * 校验正在交还前台的弹窗不得再被当成划词起点命中。
 *
 * 外部点击会同步进入「先交还前台、再隐藏」的收尾流程，此时窗口仍然可见。
 * 若命中判定只看 isVisible()，紧接着的划词手势会被判定为落在弹窗内而被吞掉，
 * 用户仍然看不到“译”按钮。
 * @returns 无返回值。
 * @author zhenghq
 */
test('正在交还前台的弹窗不得再吞掉新的划词手势', () => {
  const src = stripComments(
    extractFunction(popupSource, 'export function isPointInsidePopup(')
  )

  assert.match(
    src,
    /isPopupVisible\(\)/u,
    '命中判定必须复用逻辑可见性，排除正在交还前台的弹窗'
  )
})

/**
 * 校验取词结果为 null（被取消或新请求覆盖）时必须关闭读取状态弹窗。
 *
 * 读取状态弹窗以 showInactive 显示且不设自动隐藏；只有拿到结果才会被
 * handleSelectionCaptureResult 收尾。若结果被取消直接 return，弹窗会永久
 * 留在屏上、前台不归还，后续划词命中弹窗矩形就被静默吞掉。
 * @returns 无返回值。
 * @author zhenghq
 */
test('取词结果被取消时必须关闭读取状态弹窗', () => {
  const src = stripComments(
    extractFunction(indexSource, 'function queueSelectionTranslation(')
  )

  const nullBranchStart = src.indexOf('if (result) {')
  assert.ok(nullBranchStart >= 0, '必须显式区分取词成功与取词失败')
  const nullBranch = src.slice(nullBranchStart)
  assert.match(
    nullBranch,
    /hidePopup\(\)/u,
    '取词结果为空时必须关闭读取状态弹窗，避免残留后吞掉后续划词'
  )
})

/**
 * 校验 macOS 按钮取词主动交还前台期间必须抑制弹窗失焦自动关闭。
 * 点击“译”按钮会让本应用成为最前应用，随后 open -b 源应用会让刚显示的
 * 读取弹窗收到 blur；若不标记为内部动作，handlePopupBlur 会误判为用户
 * 点击外部并调用 hidePopup，表现为弹窗一闪即关。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 按钮取词交还前台期间必须抑制弹窗失焦关闭', () => {
  assert.match(
    popupSource,
    /export function beginPopupForegroundRestoreForCapture\(/u,
    '必须提供进入交还失焦抑制的入口'
  )
  assert.match(
    popupSource,
    /export function endPopupForegroundRestoreForCapture\(/u,
    '必须提供解除交还失焦抑制的入口'
  )

  const src = extractFunction(
    indexSource,
    'async function translateSelectionButton(): Promise<void> {'
  )
  const beginIndex = src.indexOf('beginPopupForegroundRestoreForCapture()')
  const popupIndex = src.indexOf('showSelectionReadingPopup(anchor)')
  const restoreIndex = src.indexOf('restoreFrontmostAppForCapture()')
  const endIndex = src.indexOf('endPopupForegroundRestoreForCapture()')
  assert.ok(beginIndex >= 0 && beginIndex < popupIndex,
    '必须在显示读取弹窗前进入失焦抑制，避免显示瞬间的 blur 漏抑制')
  assert.ok(popupIndex < restoreIndex,
    '必须先显示读取弹窗再交还前台')
  assert.ok(endIndex > restoreIndex,
    '取词流程结束后必须解除失焦抑制，避免后续点击外部无法关闭弹窗')

  const guardSource = extractFunction(
    popupSource,
    'function isRestoringForeground(): boolean {'
  )
  assert.match(
    guardSource,
    /captureForegroundRestoreActive/u,
    '失焦抑制判定必须覆盖按钮取词的整个交还窗口'
  )
})

/**
 * 校验选区取词进入翻译阶段时加载弹窗仍保持非激活。
 * 取词成功后 translateText 若立刻调用 win.show()，会与尚未完成的 open -b 交还前台
 * 竞争：随后到达的 blur 在取词抑制解除后触发，弹窗会被误判为点击外部而关闭。
 * 加载态保持非激活，等最终翻译结果到达后再激活即可避开这段竞态。
 * @returns 无返回值。
 * @author zhenghq
 */
test('选区取词加载弹窗不得在交还前台完成前重新激活', () => {
  const src = extractFunction(indexSource, 'async function translateText(')
  const loadingCallIndex = src.indexOf('showPopup(')
  const loadingCallEnd = src.indexOf('try {', loadingCallIndex)
  assert.ok(loadingCallIndex >= 0 && loadingCallEnd > loadingCallIndex,
    'translateText 应包含首次加载态 showPopup 调用')

  const loadingCall = src.slice(loadingCallIndex, loadingCallEnd)
  assert.match(
    loadingCall,
    /origin !== 'selection'/u,
    '选区取词的加载态必须以非激活方式显示，避免与前台交还竞争'
  )
})

/**
 * 校验点击“译”按钮后的迟到全局按下不得关闭刚显示的读取弹窗。
 *
 * macOS 全局鼠标钩子可能把按钮点击的按下事件重放或延迟派发：主进程处理第一次
 * 按下后会立即隐藏按钮并显示读取弹窗，迟到事件再分类时按钮已不可见，于是被当作
 * 弹窗外部点击，触发 `[popup] 外部点击主动关闭弹窗并归还前台`，用户看到“译”
 * 按钮没有出来或翻译弹窗瞬间消失。点击“译”开始取词后必须有一个很短的迟到事件
 * 抑制窗口，只吞掉同一次点击产生的按下，窗口过期后真实外部点击仍可关闭弹窗。
 * @returns 无返回值。
 * @author zhenghq
 */
test('点击“译”后的迟到全局按下不得关闭读取弹窗', () => {
  assert.match(
    popupSource,
    /suppressExternalPointerDismissForButtonClick/u,
    'popup 模块必须提供按钮点击后的外部按下抑制入口'
  )
  assert.match(
    popupSource,
    /suppressExternalPointerDismissUntil/u,
    '必须记录外部按下抑制截止时间'
  )

  const translateSource = stripComments(
    extractFunction(
      indexSource,
      'async function translateSelectionButton(): Promise<void> {'
    )
  )
  assert.match(
    translateSource,
    /suppressExternalPointerDismissForButtonClick\(/u,
    '按钮点击入口必须先开启迟到按下抑制，再隐藏按钮/显示弹窗'
  )
  const suppressIndex = translateSource.indexOf('suppressExternalPointerDismissForButtonClick(')
  const showIndex = translateSource.indexOf('showSelectionReadingPopup(anchor)')
  assert.ok(
    suppressIndex >= 0 && showIndex > suppressIndex,
    '抑制必须早于读取弹窗显示，否则迟到按下仍会命中关闭兜底'
  )

  const dismissSource = stripComments(
    extractFunction(popupSource, 'export function dismissPopupOnExternalPointerDown(')
  )
  assert.match(
    dismissSource,
    /isSuppressedExternalPointerDismiss\(point\)/u,
    '抑制判定必须结合本次按下的坐标，避免吞掉其它位置的真实点击'
  )
  assert.ok(
    dismissSource.indexOf('isSuppressedExternalPointerDismiss(point)') <
      dismissSource.indexOf('hidePopup()'),
    '抑制判断必须早于真正关闭弹窗'
  )

  const hideSource = stripComments(extractFunction(popupSource, 'export function hidePopup(): void {'))
  assert.match(
    hideSource,
    /suppressExternalPointerDismissUntil = 0/u,
    '关闭弹窗时必须复位抑制状态，避免影响下一轮交互'
  )
})

/**
 * 校验 macOS 按钮取词仅在点击“译”确实抢占了前台时才交还源应用。
 *
 * 用户反馈点击“译”后浏览器会切到另一个窗口/页面再取词。根因是本应用以
 * accessory 方式显示按钮时通常并未抢占 macOS 前台，但按钮取词路径仍无条件
 * 执行 `open -b Chrome`；Chrome 多窗口时会按自己的最近活跃窗口重新置顶，
 * 于是取词落在错误窗口，用户看到“切到其他页面”。只有本应用确实成为最前应用
 * 时才需要交还，否则源应用焦点本就还在，重复 open -b 反而会切错窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 按钮取词只在应用确实抢占前台时交还源应用', () => {
  const src = stripComments(
    extractFunction(
      indexSource,
      'async function translateSelectionButton(): Promise<void> {'
    )
  )
  assert.match(
    src,
    /isMacAppActiveByEvents\(\)/u,
    '必须依据应用激活事件判断本应用是否确实抢占了前台'
  )
  const restoreIndex = src.indexOf('restoreFrontmostAppForCapture()')
  const guardIndex = src.indexOf('isMacAppActiveByEvents()')
  assert.ok(
    guardIndex >= 0 && restoreIndex > guardIndex,
    '交还前台必须受「本应用确实在前台」条件保护，不能无条件 open -b'
  )
})

/**
 * 校验选区加载态不得让全局外部点击无法关闭弹窗。
 *
 * 加载态只应用于吸收迟到的 blur；若 `dismissPopupOnExternalPointerDown()` 也
 * 在加载期间短路，用户真实点击弹窗外部时弹窗不会关闭、前台也不会归还，
 * 残留弹窗会吞掉后续划词，表现为“译”按钮偶发不出现。真实全局按下必须始终
 * 保持关闭能力，仅同一次按钮点击的迟到按下由短抑制窗口吸收。
 * @returns 无返回值。
 * @author zhenghq
 */
test('选区加载态不得吞掉真实外部点击关闭', () => {
  const dismissSource = stripComments(
    extractFunction(popupSource, 'export function dismissPopupOnExternalPointerDown(')
  )
  assert.doesNotMatch(
    dismissSource,
    /selectionCaptureLoading/u,
    '加载态不能成为全局外部点击的短路条件，否则真实点击无法关闭弹窗'
  )
})

/**
 * 校验按钮点击的迟到按下抑制窗口必须覆盖复制兜底的最长耗时。
 *
 * 真机日志显示点击“译”后约 970ms 仍会到达一次全局按下，恰好落在
 * `copy-finish`（约 300ms）与翻译结果返回之间。若抑制窗口只有 300ms，
 * 这次尾随按下会被当成外部点击关闭弹窗，用户表现为“译”按钮刚出现就消失。
 * 复制兜底超时为 800ms，抑制窗口必须不小于该值并留出余量。
 * @returns 无返回值。
 * @author zhenghq
 */
test('按钮点击迟到按下抑制窗口必须覆盖复制兜底超时', () => {
  const match = /EXTERNAL_POINTER_DISMISS_SUPPRESS_MS\s*=\s*(\d+)/u.exec(popupSource)
  assert.ok(match, '必须定义迟到按下抑制窗口常量')
  const suppressMs = Number(match[1])
  assert.ok(
    suppressMs >= 900,
    `抑制窗口必须覆盖 800ms 复制兜底并留余量，当前为 ${suppressMs}ms`
  )
})

/**
 * 校验迟到按下抑制必须按按钮原位置做坐标匹配。
 *
 * 把抑制窗口拉长到覆盖复制兜底后，若仍只按时间短路，用户在这段时间内点击
 * 弹窗之外的任意位置都会被吞掉，重新出现「点空白一次不消失」。因此抑制判定
 * 必须同时校验本次按下是否落在按钮原位置附近，其它位置的真实点击立即关闭。
 * @returns 无返回值。
 * @author zhenghq
 */
test('迟到按下抑制必须按按钮原位置做坐标匹配', () => {
  assert.match(
    popupSource,
    /suppressExternalPointerDismissOrigin/u,
    '必须记录触发抑制的按钮中心坐标'
  )
  const helperSource = stripComments(
    extractFunction(popupSource, 'function isSuppressedExternalPointerDismiss(')
  )
  assert.match(
    helperSource,
    /Math\.abs\(point\.x - origin\.x\)/u,
    '必须按横坐标比对按钮原位置'
  )
  assert.match(
    helperSource,
    /Math\.abs\(point\.y - origin\.y\)/u,
    '必须按纵坐标比对按钮原位置'
  )
  assert.match(
    helperSource,
    /Date\.now\(\) > suppressExternalPointerDismissUntil/u,
    '超出抑制窗口后必须立即恢复正常关闭语义'
  )
})

/**
 * 校验 macOS 按钮取词必须覆盖「本应用失活但仍持有残留 key window」的场景。
 *
 * 真机日志中点击“译”取词超时时，既没有「取词前精确交还前台」也没有
 * 「开始精确交还」，说明交还守卫 `isMacAppActiveByEvents()` 返回了 false。
 * 但 macOS 在应用失活后仍可能让设置页等自有窗口保持 key window，注入的
 * Command+C 会打在该窗口上而不是 Chrome，剪贴板哨兵不变并最终报取词超时。
 * 因此交还守卫必须同时覆盖「本应用仍持有焦点窗口」这一残留状态。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 按钮取词必须覆盖残留焦点窗口的交还场景', () => {
  const src = stripComments(
    extractFunction(
      indexSource,
      'async function translateSelectionButton(): Promise<void> {'
    )
  )

  assert.match(
    src,
    /isMacAppActiveByEvents\(\)\s*\|\|\s*wasFrontmostAppSelf\(\)/u,
    '必须结合应用激活事件与系统自身快照判定是否占用前台'
  )
  const guardIndex = src.indexOf('wasFrontmostAppSelf()')
  const restoreIndex = src.indexOf('restoreFrontmostAppForCapture()')
  assert.ok(
    guardIndex >= 0 && restoreIndex > guardIndex,
    '系统快照表明本应用在最前时也必须先交还源应用'
  )
})

/**
 * 校验同步刷新识别出「最前应用是本应用」时必须留下诊断日志。
 *
 * 真机取词超时的日志里既没有「刷新源应用」也没有「取词前精确交还前台」，
 * 无法判断到底是快照解析失败、还是快照显示本应用抢占前台后走了静默分支。
 * 该分支必须打印一条可区分来源的日志，避免下次排查继续只能靠推断。
 * @returns 无返回值。
 * @author zhenghq
 */
test('同步刷新识别自身抢占前台时必须记录诊断日志', () => {
  const refreshSrc = stripComments(
    extractFunction(macForegroundSource, 'export function refreshFrontmostAppForSelection(')
  )

  assert.match(
    refreshSrc,
    /frontmostAppWasSelf\s*=\s*frontPid\s*===\s*process\.pid/u,
    '必须记录最前应用是否为本应用'
  )
  assert.match(
    refreshSrc,
    /if \(frontmostAppWasSelf\)[\s\S]*?logFrontDiagnostic\(/u,
    '识别出本应用抢占前台后必须打印诊断日志'
  )
})

/**
 * 校验点击“译”引发本应用抢占前台时，必须依据系统快照而不是事件标记交还。
 *
 * 用户点击“译”按钮会让 macOS 开始激活本应用，但 did-become-active 事件可能
 * 晚于按钮回调到达：此刻 `isMacAppActiveByEvents()` 仍为 false，交还被跳过，
 * 随后注入的 Command+C 落回本应用，剪贴板哨兵不变并报取词超时。真机日志中
 * 表现为点击后没有任何「取词前精确交还前台」记录。同步读取系统最前应用得到的
 * 「最前应用是自己」信号必须参与交还判定，消除这一竞态。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 按钮取词必须依据系统快照识别自身抢占前台', () => {
  assert.match(
    macForegroundSource,
    /export function wasFrontmostAppSelf\(\)/u,
    '必须暴露最近一次系统快照是否显示最前应用为本应用'
  )
  const refreshSrc = stripComments(
    extractFunction(macForegroundSource, 'export function refreshFrontmostAppForSelection(')
  )
  assert.match(
    refreshSrc,
    /frontmostAppWasSelf\s*=\s*frontPid\s*===\s*process\.pid/u,
    '同步刷新检测到最前应用为本应用时必须记录该状态'
  )

  const translateSrc = stripComments(
    extractFunction(
      indexSource,
      'async function translateSelectionButton(): Promise<void> {'
    )
  )
  const guardIndex = translateSrc.indexOf('wasFrontmostAppSelf()')
  const restoreIndex = translateSrc.indexOf('restoreFrontmostAppForCapture()')
  assert.ok(
    guardIndex >= 0 && restoreIndex > guardIndex,
    '系统快照表明本应用在最前时也必须先交还源应用'
  )
})
