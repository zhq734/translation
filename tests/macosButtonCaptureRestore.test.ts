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
test('macOS 按钮取词不得再走应用级前台交还', () => {
  const src = stripComments(extractFunction(
    indexSource,
    'async function translateSelectionButton(): Promise<void> {'
  ))

  // 翻译弹窗与设置窗口在 macOS 上都是 nonactivating panel：显示/聚焦只影响
  // 目标窗口自身，不激活应用，因此不存在「复制键打在弹窗上」的应用级前台占用，
  // 按钮取词无需再精确交还前台或等待前台切换。
  assert.doesNotMatch(src, /restoreFrontmostAppForCapture/u)
  assert.doesNotMatch(src, /waitForFrontmostAppReturn/u)
  assert.doesNotMatch(src, /isMacAppActiveByEvents/u)
  assert.doesNotMatch(src, /wasFrontmostAppSelf/u)
  // 直接进入消费预取与复制取词即可。
  assert.match(src, /consumePreparedBounded\(\)/u, '按钮取词必须直接消费预取')
})

/**
 * 校验划词阶段就记录源应用，避免用户点击“译”按钮后本应用已成最前应用，
 * 此时再读取快照只会读到自身，导致没有可交还目标、复制取词超时。
 * @returns 无返回值。
 * @author zhenghq
 */
test('划词显示按钮不再需要记录源应用交还目标', () => {
  const src = stripComments(extractFunction(indexSource, 'function scheduleSelectionAction('))

  // panel 不占用应用级前台，划词与取词收尾都不再需要 `open -b` 交还目标，
  // 记录源应用只会留下无消费方的补偿状态。
  assert.doesNotMatch(src, /rememberFrontmostAppIfInactive/u)
  assert.match(src, /showSelectionButton\(/u, '划词仍需显示“译”按钮')
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
 * 校验翻译弹窗路径不得再依赖安全让出入口，仅 OCR / 原生对话框保留内部退化链路。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 前台交还模块不得再导出安全让出入口', () => {
  // panel 落地后翻译弹窗直接 win.hide()，不再需要 app.hide()→app.show() 的
  // 整应用让出；但 OCR 覆盖层与原生修复对话框仍保留内部 handBack 退化链路，
  // 因此只要求不再导出 yieldFrontmostAppThen，且弹窗路径不得引用它。
  assert.doesNotMatch(macForegroundSource, /export function yieldFrontmostAppThen\(/u)
  assert.doesNotMatch(popupSource, /yieldFrontmostAppThen/u)
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
test('按钮取词的失焦抑制补偿状态必须整体删除', () => {
  // panel 不激活应用后，显示读取弹窗不会再收到「前台交还」引发的迟到失焦，
  // 对应的失焦抑制开关失去存在前提。
  assert.doesNotMatch(popupSource, /beginPopupForegroundRestoreForCapture/u)
  assert.doesNotMatch(popupSource, /endPopupForegroundRestoreForCapture/u)
  assert.doesNotMatch(popupSource, /captureForegroundRestoreActive/u)
  assert.doesNotMatch(popupSource, /function isRestoringForeground\(/u)

  const src = stripComments(extractFunction(
    indexSource,
    'async function translateSelectionButton(): Promise<void> {'
  ))
  assert.doesNotMatch(src, /beginPopupForegroundRestoreForCapture/u)
  assert.doesNotMatch(src, /endPopupForegroundRestoreForCapture/u)
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
 * 校验 macOS 按钮取词不再做取词前的应用级失活处理。
 *
 * 旧实现会在点击“译”后把本应用前台交还给源应用再注入复制键；panel 落地后
 * 弹窗显示不会激活应用，复制键天然落在源应用上，该补偿路径必须整体删除。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 按钮取词不得再做取词前应用级失活', () => {
  const src = stripComments(
    extractFunction(
      indexSource,
      'async function translateSelectionButton(): Promise<void> {'
    )
  )

  assert.doesNotMatch(src, /deactivatePopupForCapture/u, 'macOS 按钮取词不得再主动失活弹窗')
  assert.doesNotMatch(src, /isMacAppActiveByEvents/u, 'macOS 不得再依据应用激活事件交还前台')
  assert.doesNotMatch(src, /waitForFrontmostAppReturn/u, 'macOS 不得再等待应用级前台交还')
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
 * 校验取词专用系统快照与自身抢占识别补偿状态必须整体删除。
 *
 * 旧实现为消除「点击“译”后应用激活事件迟到」的竞态，引入了同步读取系统最前
 * 应用的 `refreshFrontmostAppForSelection()` 与 `wasFrontmostAppSelf()` 判定。
 * panel 不激活应用后该竞态不存在，这些补偿 API 必须删除，避免残留死代码
 * 让后续维护者误以为仍需要应用级前台交还。
 * @returns 无返回值。
 * @author zhenghq
 */
test('取词专用系统快照补偿状态必须整体删除', () => {
  const code = stripComments(macForegroundSource)

  assert.doesNotMatch(code, /wasFrontmostAppSelf/u, '不得再保留自身抢占前台快照判定')
  assert.doesNotMatch(code, /refreshFrontmostAppForSelection/u, '不得再保留取词专用同步刷新入口')
  assert.doesNotMatch(code, /restoreFrontmostAppForCapture/u, '不得再保留取词前精确交还入口')
  assert.doesNotMatch(code, /waitForFrontmostAppReturn/u, '不得再保留前台交还等待入口')
  assert.doesNotMatch(code, /rememberFrontmostAppIfInactive\b/u, '不得再保留按激活状态记录源应用入口')
})

/**
 * 校验翻译弹窗路径不得再引用取词专用系统快照补偿 API。
 * @returns 无返回值。
 * @author zhenghq
 */
test('按钮取词不得再依赖取词专用系统快照补偿 API', () => {
  const src = stripComments(
    extractFunction(
      indexSource,
      'async function translateSelectionButton(): Promise<void> {'
    )
  )

  assert.doesNotMatch(src, /refreshFrontmostAppForSelection/u)
  assert.doesNotMatch(src, /wasFrontmostAppSelf/u)
  assert.doesNotMatch(src, /restoreFrontmostAppForCapture/u)
  assert.match(src, /consumePreparedBounded\(\)/u, '按钮取词必须直接消费预取结果')
})
