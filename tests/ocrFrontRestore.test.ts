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
const macForegroundSource = readFileSync('src/main/macForeground.ts', 'utf8')

test('截图前必须记录应用是否已在前台，供收尾决定是否归还', () => {
  const openSource = extractFunction(mainSource, 'async function openOcrSelection(): Promise<void> {')

  // 覆盖窗口显示时会把应用激活到最前，只有先记录截图前的状态，收尾才知道要不要交还前台。
  assert.match(openSource, /ocrSessionAppWasFrontmost\s*=\s*BrowserWindow\.getFocusedWindow\(\)\s*!==\s*null/u)
})

test('取消截图时只有应用原本不在前台才交还前台，并先交还再收起覆盖窗口', () => {
  const cancelSource = extractFunction(mainSource, 'function cancelOcrSelection(): void {')

  // 覆盖窗口隐藏后系统会把设置页提升为 key window，只有应用原本不在前台时才需要交还前台。
  assert.match(
    cancelSource,
    /const wasVisible = isOcrSelectionVisible\(\)/u,
    '必须保留覆盖窗口隐藏前的可见状态'
  )
  assert.match(
    cancelSource,
    /if \(wasVisible && !ocrSessionAppWasFrontmost\) \{/u,
    '只在覆盖窗口曾可见且应用原本不在前台时才交还前台'
  )
  assert.match(cancelSource, /returnFrontmostThenHideOcrSelection\(\)/u, '交还前台路径必须先交还再收起窗口')
  // 交还前台的路径不能顺手先隐藏窗口，否则设置页会在交还生效前被顶到最前。
  assert.ok(
    cancelSource.indexOf('returnFrontmostThenHideOcrSelection()') < cancelSource.indexOf('\n  hideOcrSelectionWindow()'),
    '交还前台分支必须排在直接隐藏窗口之前'
  )
  assert.match(cancelSource, /hideOcrSelectionWindow\(\)/u, '其余路径仍需直接收起覆盖窗口')
  assert.match(cancelSource, /ocrSessionAppWasFrontmost = true/u, '收尾后必须复位记录')
})

test('截图前最前应用必须在覆盖窗口显示之前采集', () => {
  const openSource = extractFunction(mainSource, 'async function openOcrSelection(): Promise<void> {')

  // 覆盖窗口一显示本应用就成为最前，晚一步就会读到本应用自己，交还前台会变成把设置页顶到最前。
  assert.match(
    openSource,
    /const previousAppPromise = isMac && !ocrSessionAppWasFrontmost \? readFrontmostAppSnapshot\(\) : null/u,
    '只在 macOS 且截图前应用不在最前时才采集前台应用'
  )
  assert.match(
    openSource,
    /if \(previousAppPromise\) rememberFrontmostApp\(await previousAppPromise\)\s*\n\s*win\.show\(\)/u,
    '必须在 win.show() 之前收齐前台应用快照并写入共享记录'
  )
  // 截图前本应用已是最前时没有可交还的目标，同时清掉上一轮残留，避免换掉用户当前在用的应用。
  assert.match(openSource, /forgetFrontmostApp\(\)/u, '每次会话开始都要清掉上一轮的交还记录')
})

test('前台应用快照走 lsappinfo 读取，并排除本应用自己', () => {
  const readSource = extractFunction(
    macForegroundSource,
    'export async function readFrontmostAppSnapshot(): Promise<FrontmostAppSnapshot | null> {'
  )
  const parseSource = extractFunction(
    macForegroundSource,
    'export function parseFrontmostAppSnapshot(output: string, selfPid: number): FrontmostAppSnapshot | null {'
  )

  assert.match(readSource, /execFileP\('lsappinfo', \['front'\]/u, '必须先取最前应用 ASN')
  assert.match(readSource, /execFileP\('lsappinfo', \['info', asn\]/u, '再取该应用的详情')
  assert.match(readSource, /parseFrontmostAppSnapshot\(infoStdout, process\.pid\)/u, '必须排除本应用自己')
  assert.match(parseSource, /bundleID="\(\[\^"\]\+\)"/u, '必须解析 bundle id')
  assert.match(parseSource, /pid = \(\\d\+\)/u, '必须解析进程号')
  // 最前应用就是本应用时没有可交还的目标，强行激活自己反而会把设置页顶到最前。
  assert.match(parseSource, /if \(pid === selfPid\) return null/u, '最前应用是本应用时必须放弃采集')
})

test('交还前台优先激活截图前的应用，确认失活后才收起覆盖窗口', () => {
  const handBackSource = extractFunction(
    macForegroundSource,
    'export function handBackFrontmostThen('
  )
  const activateSource = extractFunction(
    macForegroundSource,
    'export function activateFrontmostApp(snapshot: FrontmostAppSnapshot | null): boolean {'
  )

  // 非 macOS 平台不存在「应用内窗口被提升」的问题，直接执行收尾动作即可。
  assert.match(handBackSource, /if \(process\.platform !== 'darwin'\) \{/u, '非 macOS 平台必须走直接收尾分支')
  // 首选路径：激活源应用，本应用所有窗口留在屏上，正在展示的提示窗口不会闪一下。
  assert.match(activateSource, /execFile\('open', \['-b', snapshot\.bundleId\]/u, '必须用 open -b 交还前台')
  // 目标应用若已退出，open -b 会把它重新启动，用户会看到已关闭的应用被拉起。
  assert.match(activateSource, /isProcessAlive\(snapshot\.pid\)/u, '必须先确认目标应用仍在运行')
  // 本应用已不在最前时隐藏窗口不会提升其它窗口，交还反而会抢走用户正在使用的窗口。
  assert.match(handBackSource, /if \(focused === null\) \{/u, '应用不在最前时必须直接收尾')
  assert.match(handBackSource, /forgetFrontmostApp\(\)/u, '应用不在最前时记录已失效，必须丢弃')
  assert.match(handBackSource, /focused !== keyWindow/u, '只有隐藏 key window 才需要交还前台')
  assert.match(handBackSource, /activateFrontmostApp\(target\)/u, '必须激活待交还的应用')
  // 激活是异步生效的：必须先确认本应用失去最前状态再隐藏窗口，否则设置页会闪一下。
  assert.match(
    handBackSource,
    /if \(BrowserWindow\.getFocusedWindow\(\) === null\) \{\s*\n\s*finish\(true\)/u,
    '必须轮询确认本应用已失活后才执行收尾动作'
  )
  // 激活未生效时必须仍然收尾，不能把窗口一直留在屏上。
  assert.match(handBackSource, /setTimeout\(\(\) => finish\(false\), FRONT_RETURN_TIMEOUT_MS\)/u, '必须有兜底收尾')
  // orderFront 会把窗口顶到前台应用之上，用户仍会看到设置页盖住自己的应用，因此禁止 showInactive。
  assert.doesNotMatch(handBackSource, /showInactive/u, '不得用 showInactive 恢复窗口')
  assert.doesNotMatch(activateSource, /showInactive/u, '不得用 showInactive 交还前台')
})

test('覆盖窗口收起复用共享交还逻辑，并在拿不到源应用时退化', () => {
  const returnSource = extractFunction(mainSource, 'function returnFrontmostThenHideOcrSelection(): void {')

  assert.match(returnSource, /handBackFrontmostThen\(ocrSelectionWin, hideOverlay,/u, '必须复用共享交还逻辑')
  // 拿不到目标应用或激活失败时退化为隐藏应用再恢复：窗口会短暂消失，但设置页不会留在最前。
  assert.match(returnSource, /restoreAppWindowsByHidingApp\(\)/u, '交还失败时必须退化')
  // 退化路径若先隐藏应用，app.show() 会把刚收起的覆盖窗口一并恢复，必须保证顺序。
  assert.match(
    returnSource,
    /hideOverlay\(\)\s*\n\s*restoreAppWindowsByHidingApp\(\)/u,
    '退化路径必须先收起覆盖窗口再隐藏应用'
  )
  // 新截图会话开始后必须放弃收尾，避免把新会话的覆盖窗口隐藏掉。
  assert.match(returnSource, /ocrSelectionSessionSeq !== sessionSeqAtReturn/u)
})

test('退化方案用 app.hide 与 app.show 恢复窗口层级', () => {
  const fallbackSource = extractFunction(mainSource, 'function restoreAppWindowsByHidingApp(): void {')

  assert.match(fallbackSource, /app\.hide\(\)/u, '必须用 app.hide() 让系统重新激活截图前的应用')
  assert.match(fallbackSource, /app\.show\(\)/u, '必须用 app.show() 恢复应用内窗口')
  // orderFront 会把窗口顶到前台应用之上，且逐个操作窗口无法恢复应用整体层级。
  assert.doesNotMatch(fallbackSource, /showInactive/u, '不得用 showInactive 恢复窗口')
  assert.doesNotMatch(fallbackSource, /BrowserWindow\./u, '不得逐个操作窗口，必须用 app.show() 整体恢复')
  // 新截图会话开始后必须放弃恢复，避免把窗口可见性改回上一次会话的状态。
  assert.match(fallbackSource, /ocrSelectionSessionSeq !== sessionSeqAtHide/u)
})

test('采集失败时 macOS 先显示错误弹窗再收起覆盖窗口', () => {
  const failSource = extractFunction(mainSource, 'function failOcrSelectionCapture(')

  // 覆盖窗口是应用内最后一个 key window：先显示弹窗接管 key window，再收起覆盖窗口，
  // 系统就不会把设置页提升为 key window 顶到其它应用之上。
  assert.match(
    failSource,
    /if \(isMac\) \{\s*\n\s*showErrorPopup\(\)\s*\n\s*hideOverlay\(\)\s*\n\s*\}/u,
    'macOS 必须先显示弹窗再收起覆盖窗口'
  )
  // Windows 的弹窗显示时机依赖覆盖窗口隐藏后的前台状态，必须保持原顺序。
  assert.match(
    failSource,
    /\} else \{\s*\n\s*hideOverlay\(\)\s*\n\s*showErrorPopup\(\)\s*\n\s*\}/u,
    'Windows 必须保持先收起覆盖窗口再显示弹窗'
  )
  assert.match(failSource, /restoreSelectionListenerAfterOcr\(interactionToken\)/u, '收尾仍需恢复划词监听')
})

test('框选提交时 macOS 先显示识别弹窗再收起覆盖窗口', () => {
  const submitSource = extractFunction(mainSource, 'async function submitOcrSelection(value: unknown): Promise<void> {')

  assert.match(
    submitSource,
    /if \(isMac\) showLoadingPopup\(\)\s*\n\s*hideOcrSelectionWindow\(\)/u,
    'macOS 必须先显示识别弹窗接管 key window，再收起覆盖窗口'
  )
  // Windows 先收起覆盖窗口能立即给出反馈，采集完成后再显示弹窗，必须保持原顺序。
  assert.match(
    submitSource,
    /if \(!isMac\) showLoadingPopup\(\)/u,
    'Windows 必须保持采集完成后再显示弹窗'
  )
  // 选区无效时既没有弹窗也不需要交还，但覆盖窗口仍必须收起。
  assert.match(
    submitSource,
    /if \(!bounds\) \{[\s\S]*?hideOcrSelectionWindow\(\)[\s\S]*?return\s*\n\s*\}/u,
    '选区无效的早退路径也必须收起覆盖窗口'
  )
})
