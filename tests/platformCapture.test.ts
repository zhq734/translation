import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  getSelectionCapturePlan,
  parseMacosAxReaderWindowDiagnostic,
  resolveSelectionCaptureStrategy,
  shouldPrefetchSelectionForButton
} from '../src/shared/platformCapture.ts'

test('不同桌面平台应选择可用的系统级取词策略', () => {
  assert.equal(resolveSelectionCaptureStrategy('darwin'), 'macos-command-copy')
  assert.equal(resolveSelectionCaptureStrategy('win32'), 'windows-control-copy')
  assert.equal(resolveSelectionCaptureStrategy('linux'), 'linux-primary-selection')
  assert.equal(resolveSelectionCaptureStrategy('freebsd'), 'unsupported')
})

test('不同桌面平台应具备原生直读优先与复制兜底能力', () => {
  const darwinPlan = getSelectionCapturePlan('darwin')
  assert.equal(darwinPlan.nativeRead, 'macos-accessibility')
  assert.equal(darwinPlan.supportsNativeRead, true)
  assert.equal(darwinPlan.copyFallback, true)

  const win32Plan = getSelectionCapturePlan('win32')
  assert.equal(win32Plan.nativeRead, 'windows-uia')
  assert.equal(win32Plan.supportsNativeRead, true)
  assert.equal(win32Plan.copyFallback, true)

  const linuxPlan = getSelectionCapturePlan('linux')
  assert.equal(linuxPlan.nativeRead, 'linux-primary-selection')
  assert.equal(linuxPlan.supportsNativeRead, true)
  assert.equal(linuxPlan.copyFallback, false)

  const unsupportedPlan = getSelectionCapturePlan('freebsd')
  assert.equal(unsupportedPlan.nativeRead, 'unsupported')
  assert.equal(unsupportedPlan.supportsNativeRead, false)
  assert.equal(unsupportedPlan.copyFallback, false)
})

/**
 * 校验窗口诊断解析只暴露白名单字段，忽略自由文本与非法计数。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口诊断解析应只返回脱敏白名单字段', () => {
  assert.deepEqual(parseMacosAxReaderWindowDiagnostic(Buffer.from('WINDOW exact count=3')), {
    windowLocate: 'exact',
    windowCount: 3,
    windowMatched: true
  })
  assert.deepEqual(
    parseMacosAxReaderWindowDiagnostic('WINDOW fallback count=2\n聊天窗口：张三\n选区：敏感文本'),
    { windowLocate: 'app-fallback', windowCount: 2, windowMatched: false }
  )
  assert.deepEqual(parseMacosAxReaderWindowDiagnostic('WINDOW exact count=999999999999999999999'), {})
})

/**
 * 校验原生直读与通用取词入口都消费 helper 返回的窗口字段，
 * 不再根据是否传入窗口编号推断定位结果。
 * @returns 无返回值。
 * @author zhenghq
 */
test('原生取词结果应透传 helper 窗口诊断字段', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const prefetchStart = source.indexOf('export async function captureSelectionByNativeOnly')
  const prefetchEnd = source.indexOf('export async function captureSelectionAfterButtonClick', prefetchStart)
  const pipelineStart = source.indexOf('export async function captureSelection(')
  const prefetchSource = source.slice(prefetchStart, prefetchEnd)
  const pipelineSource = source.slice(pipelineStart)

  assert.ok(prefetchStart >= 0 && prefetchEnd > prefetchStart, '应能定位只读预取函数')
  assert.ok(pipelineStart >= 0, '应能定位通用取词函数')
  assert.match(prefetchSource, /windowLocate:\s*native\.windowLocate/u, '预取应透传 windowLocate')
  assert.match(prefetchSource, /windowCount:\s*native\.windowCount/u, '预取应透传 windowCount')
  assert.match(prefetchSource, /windowMatched:\s*native\.windowMatched/u, '预取应透传 windowMatched')
  assert.match(pipelineSource, /windowLocate:\s*native\.windowLocate/u, '通用取词应透传 windowLocate')
  assert.match(pipelineSource, /windowCount:\s*native\.windowCount/u, '通用取词应透传 windowCount')
  assert.match(pipelineSource, /windowMatched:\s*native\.windowMatched/u, '通用取词应透传 windowMatched')
  assert.doesNotMatch(
    pipelineSource,
    /context\?\.windowNumber\s*===\s*undefined\s*\?\s*'app-fallback'\s*:\s*'exact'/u,
    '不得仅凭窗口编号存在就推断 exact'
  )
})

test('主进程取词实现应包含 Windows Ctrl+C、Linux primary selection 与直读优先编排', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')

  assert.match(source, /powershell\.exe/u)
  assert.match(source, /uIOhook\.keyTap/u)
  assert.match(source, /clipboard\.readText\('selection'\)/u)
  assert.match(source, /readSelectionByNative/u)
})

/**
 * 校验 Windows 注入 Ctrl+C 前等待用户松开原快捷键修饰键，避免生成 Ctrl+Alt+C 等错误组合。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 复制取词应使用已加载的原生模块直接发送 Ctrl+C', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const copyStart = source.indexOf('export async function simulateCopy')
  const copyEnd = source.indexOf('/**\n * 通过模拟复制快捷键', copyStart)
  const copySource = source.slice(copyStart, copyEnd)

  assert.ok(copyStart >= 0)
  assert.ok(copyEnd > copyStart)
  assert.match(source, /import \{ uIOhook, UiohookKey \} from '\.\/uiohookRuntime'/u)
  assert.match(copySource, /uIOhook\.keyTap\(UiohookKey\.C,\s*\[UiohookKey\.Ctrl\]\)/u)
  assert.doesNotMatch(copySource, /powershell\.exe|Add-Type|keybd_event/u)
})

/**
 * 校验 Windows 按钮模式跳过耗时的 UI Automation 后台预取，点击后直接走快速复制取词。
 * @returns 无返回值。
 * @author zhenghq
 */
test('各平台均允许按钮预取，helper 不可用时由管线跳过', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const scheduleStart = source.indexOf('function scheduleSelectionAction')
  const scheduleEnd = source.indexOf('/**\n * 响应一次全局划词动作', scheduleStart)
  const scheduleSource = source.slice(scheduleStart, scheduleEnd)

  assert.equal(shouldPrefetchSelectionForButton('win32'), true)
  assert.equal(shouldPrefetchSelectionForButton('darwin'), true)
  assert.equal(shouldPrefetchSelectionForButton('linux'), true)
  assert.ok(scheduleStart >= 0)
  assert.ok(scheduleEnd > scheduleStart)
  assert.match(
    scheduleSource,
    /shouldPrefetchSelectionForButton\(process\.platform\)[\s\S]*?selectionCapture\.prepare\(anchor\)/u
  )
})

test('macOS 模拟复制必须显式按下和释放 Command，避免把 C 当作普通字符输入', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const commandDown = source.indexOf('CGEventCreateKeyboardEvent(s,55,true)')
  const copyDown = source.indexOf('CGEventCreateKeyboardEvent(s,8,true)')
  const copyUp = source.indexOf('CGEventCreateKeyboardEvent(s,8,false)')
  const commandUp = source.indexOf('CGEventCreateKeyboardEvent(s,55,false)')

  assert.ok(commandDown >= 0, '应显式发送 Command 按下事件')
  assert.ok(copyDown > commandDown, '应先按下 Command 再按下 C')
  assert.ok(copyUp > copyDown, '应在 C 按下后释放 C')
  assert.ok(commandUp > copyUp, '应在释放 C 后释放 Command')
})

test('macOS 模拟复制不得释放用户正在按住的 Command 键', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')

  // 按键状态由全局快捷键入口短时传递，避免脚本查询 hiservices 或调用不存在的 uiohook API。
  assert.match(source, /pendingMacOSCommandWasDownUntil/u)
  assert.match(source, /Date\.now\(\) <= pendingMacOSCommandWasDownUntil/u)
  assert.match(source, /if\(!commandWasDown\)\{[\s\S]*?commandDown/u)
  assert.match(source, /if\(!commandWasDown\)\{[\s\S]*?commandUp/u)
})

test('原生直读脚本应输出带文本的规范化结果，供取词管线解析', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')

  assert.match(source, /AXSelectedText/u)
  assert.match(source, /TextPattern/u)
})

/**
 * 校验取词管线先执行原生直读，直读未取到文本时才回退到复制兜底。
 * @returns 无返回值。
 * @author zhenghq
 */
test('取词管线应原生直读优先并在失败时回退复制兜底', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const pipelineStart = source.indexOf('export async function captureSelection(')
  const pipelineSource = source.slice(pipelineStart)
  const nativeReadCall = pipelineSource.search(/readSelectionByNative\(signal(?:,\s*resolvedContext)?\)/u)
  const copyFallbackCall = pipelineSource.indexOf('captureByCopy(signal')

  assert.ok(nativeReadCall >= 0, 'captureSelection 应先调用原生直读')
  assert.ok(
    copyFallbackCall > nativeReadCall,
    '直读未取到文本时才应回退到复制兜底'
  )
})

/**
 * 校验 macOS 直读脚本在 PRESENT 时输出选中文本，供直读解析消费且不触碰剪贴板。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS 直读脚本应在 PRESENT 时同时输出选中文本', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')

  assert.match(source, /PRESENT\\n" & \(selectedText as text\)/u)
})

/**
 * 校验 Windows 直读脚本用 TextPattern 输出 PRESENT 状态与选中文本，换行符分隔供解析。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Windows 直读脚本应输出 PRESENT 状态与选中文本', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')

  assert.match(source, /TextPattern\]\$pattern\)\.GetSelection\(\)/u)
  assert.match(source, /GetText\(-1\)/u)
  assert.match(source, /PRESENT' \+ \[char\]10 \+ \$text/u)
})

/**
 * 校验 Linux 直读包装主选区并纳入统一管线，空时按分类返回原因且不注入复制键。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Linux 取词应纳入主选区直读并保留分类结果', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')

  assert.match(source, /clipboard\.readText\('selection'\)/u)
  assert.match(source, /status === 'empty' \? 'empty' : 'unsupported'/u)
  assert.match(source, /parseNativeSelectionReadOutput/u)
})

/**
 * 校验按钮显示期间使用的只读直读预取：只调原生直读、不注入复制键、不写剪贴板。
 * @returns 无返回值。
 * @author zhenghq
 */
test('只读预取应仅使用原生直读且不注入复制键或写剪贴板', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const prefetchStart = source.indexOf('export async function captureSelectionByNativeOnly')
  // 结束标记指向按钮专用取词函数，避免把按钮点击逻辑误算为只读预取实现。
  const prefetchEnd = source.indexOf('export async function captureSelectionAfterButtonClick', prefetchStart)
  const prefetchSource = source.slice(prefetchStart, prefetchEnd)

  assert.ok(prefetchStart >= 0, '应导出 captureSelectionByNativeOnly 只读预取函数')
  assert.match(prefetchSource, /readSelectionByNativeWithRetry\(signal(?:,\s*context)?\)/u)
  assert.match(prefetchSource, /native\.status === 'present'/u)
  assert.doesNotMatch(prefetchSource, /captureByCopy|simulateCopy|keybd_event|CGEvent/u)
  assert.doesNotMatch(prefetchSource, /clipboard\.write/u)
  assert.match(prefetchSource, /native\.status === 'empty' \? 'empty' : 'unsupported'/u)
})

/**
 * 校验双击后的原生选区读取允许短暂重试，但始终只读原生选区，不进入复制兜底。
 * @returns 无返回值。
 * @author zhenghq
 */
test('双击只读预取应在选区稳定期间短暂重试原生读取', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const prefetchStart = source.indexOf('export async function captureSelectionByNativeOnly')
  const prefetchEnd = source.indexOf('export async function captureSelectionAfterButtonClick', prefetchStart)
  const prefetchSource = source.slice(prefetchStart, prefetchEnd)

  assert.match(source, /NATIVE_SELECTION_RETRY_COUNT/u)
  assert.match(source, /NATIVE_SELECTION_RETRY_DELAY_MS/u)
  assert.match(prefetchSource, /readSelectionByNativeWithRetry/u)
  assert.doesNotMatch(prefetchSource, /captureByCopy|simulateCopy|keybd_event|CGEvent/u)
})

/**
 * 校验“译”按钮点击后的兜底取词应直接发送复制快捷键，不能再次被缓慢的原生直读阻塞。
 * @returns 无返回值。
 * @author zhenghq
 */
test('按钮点击兜底取词应复制优先且不再次等待原生直读', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const start = source.indexOf('export async function captureSelectionAfterButtonClick')
  const end = source.indexOf('export async function captureSelection(', start)
  const buttonCaptureSource = source.slice(start, end)

  assert.ok(start >= 0, '应导出按钮点击专用取词函数')
  assert.ok(end > start, '按钮取词函数应位于通用取词函数之前')
  assert.match(buttonCaptureSource, /plan\.copyFallback/u)
  assert.match(buttonCaptureSource, /captureByCopy\(signal, resolvedTimeoutMs(?:,\s*resolvedContext)?\)/u)
  assert.doesNotMatch(buttonCaptureSource, /readSelectionByNative\(/u)
})

/**
 * 校验复制链路能识别入口层已完成的窗口激活，避免同一轮取词重复切换微信窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('复制链路应复用入口层窗口激活结果', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const start = source.indexOf('async function activateWindowBeforeCopy(')
  const end = source.indexOf('\n}\n', start)
  assert.ok(start >= 0 && end > start, '应存在 activateWindowBeforeCopy 实现')
  const activationSource = source.slice(start, end)
  assert.match(activationSource, /windowActivationSettled/u,
    '入口层已完成激活时，复制链路不得再次调用窗口激活')
})

/**
 * 校验窗口激活异常必须返回固定 failed，而不是让复制链路把异常当成无需确认。
 * @returns 无返回值。
 * @author zhenghq
 */
test('复制前窗口激活异常必须返回 failed 结果', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const start = source.indexOf('async function activateWindowBeforeCopy(')
  const end = source.indexOf('\n}\n', start)
  assert.ok(start >= 0 && end > start, '应存在 activateWindowBeforeCopy 实现')
  const activationSource = source.slice(start, end)
  assert.match(activationSource, /catch\s*\{[\s\S]*?outcome:\s*'failed'/u,
    '激活异常必须返回固定 failed 结果')
  assert.doesNotMatch(activationSource, /catch\s*\{[\s\S]*?return null/u,
    '激活异常不得返回 null 绕过复制前的安全失败')
})

/**
 * 校验窗口激活失败时不得写剪贴板哨兵或注入 Cmd+C。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口激活失败时复制链路必须在注入前早退', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const start = source.indexOf('async function captureByCopy')
  const end = source.indexOf('/**\n * 捕获当前选中文字', start)
  assert.ok(start >= 0 && end > start, '应存在 captureByCopy 实现')
  const copySource = source.slice(start, end)
  const activationIndex = copySource.indexOf('const windowActivation = await activateWindowBeforeCopy(context)')
  const earlyReturnIndex = copySource.indexOf('isFailedWindowActivation(windowActivation)', activationIndex)
  const sentinelIndex = copySource.indexOf('clipboard.writeText(sentinel)', activationIndex)
  const injectIndex = copySource.indexOf('await injectCopyShortcut()', activationIndex)
  assert.ok(earlyReturnIndex > activationIndex, '复制链路必须在激活后检查 failed 结果')
  assert.ok(sentinelIndex > earlyReturnIndex, '激活失败时必须在写哨兵前早退')
  assert.ok(injectIndex > earlyReturnIndex, '激活失败时必须在注入复制键前早退')
  assert.match(copySource, /status=window-activation-failed/u,
    '早退日志必须给出明确的 window-activation-failed 状态')
  assert.match(copySource, /reason:\s*'unknown'/u,
    '窗口激活失败应复用既有 unknown 失败原因')
})

/**
 * 校验失效的旧预取可以中止原生命令，避免阻塞后续双击读取。
 * @returns 无返回值。
 * @author zhenghq
 */
test('原生直读应接收取消信号以避免旧预取阻塞新请求', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')

  assert.match(source, /readSelectionByNative\(signal(?:,\s*context)?\)/u)
  assert.match(source, /timeout: SELECTION_INSPECTION_TIMEOUT_MS,\s*signal/u)
  assert.match(source, /readSelectionByNativeWithRetry\(signal(?:,\s*context)?\)/u)
})
