import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/** 读取主进程取词源码，用于源码契约验证。 @author zhenghq */
function readCaptureSource(): string {
  return readFileSync('src/main/capture.ts', 'utf8')
}

/**
 * 提取指定函数源码，便于对局部行为做边界校验。
 * @param source 完整源码。
 * @param marker 函数起始标记。
 * @param nextMarker 下一函数起始标记。
 * @returns 指定函数的源码片段。
 * @author zhenghq
 */
function sliceFunction(source: string, marker: string, nextMarker: string): string {
  const start = source.indexOf(marker)
  const end = source.indexOf(nextMarker, start)
  assert.ok(start >= 0, `应存在 ${marker}`)
  assert.ok(end > start, '函数边界必须有效')
  return source.slice(start, end)
}

test('复制注入不得把登记观测窗口误报为事件已观测', () => {
  const source = readCaptureSource()
  const copyStart = source.indexOf('async function captureByCopy(')
  const copyEnd = source.indexOf('/**\n * 捕获当前选中文字', copyStart)
  const copySource = source.slice(copyStart, copyEnd)

  assert.match(
    copySource,
    /\[capture\] copy-shortcut-sent attempt=\$\{copyAttempts\} expectationRegistered=\$\{observed\}/u,
    '发送日志必须使用 expectationRegistered 表示仅登记观测'
  )
  assert.match(
    copySource,
    /\[capture\] copy-event eventObserved=/u,
    '观测结果必须通过 copy-event 单独记录'
  )
})

test('Chrome AX 和菜单不可用时应停止快捷键盲发', () => {
  const source = readCaptureSource()
  const copyStart = source.indexOf('async function captureByCopy(')
  const copyEnd = source.indexOf('/**\n * 捕获当前选中文字', copyStart)
  const copySource = source.slice(copyStart, copyEnd)

  assert.match(
    copySource,
    /shouldBlockChromiumShortcut[\s\S]*?phase=ax-read|menu-copy/u,
    '必须定义 Chrome 快捷键安全门禁'
  )
  assert.match(
    copySource,
    /copy-finish status=chromium-ax-unavailable/u,
    '门禁命中时必须返回可诊断失败'
  )
})

test('Safari 不得命中 Chromium 专用门禁', () => {
  const source = readCaptureSource()
  const copyStart = source.indexOf('async function captureByCopy(')
  const copyEnd = source.indexOf('/**\n * 捕获当前选中文字', copyStart)
  const copySource = source.slice(copyStart, copyEnd)

  const gateStart = copySource.indexOf('const shouldBlockChromiumShortcut')
  const gateEnd = copySource.indexOf('if (shouldBlockChromiumShortcut)', gateStart)
  const gateSource = copySource.slice(gateStart, gateEnd)

  assert.ok(gateStart >= 0 && gateEnd > gateStart, '应存在 Chromium 专用门禁')
  assert.match(gateSource, /isChromiumBundleId\(context\?\.bundleId\)/u,
    'Chromium 门禁必须限定应用白名单')
  assert.doesNotMatch(gateSource, /chromiumProcessDetector|isChromiumLikeProcess/u,
    '通用 Chromium/Electron 检测不得扩大 Cmd+C 安全门禁')
})

test('Chromium/Electron AX 增强应使用通用进程检测', () => {
  const source = readCaptureSource()
  const copyStart = source.indexOf('async function captureByCopy(')
  const copyEnd = source.indexOf('/**\n * 捕获当前选中文字', copyStart)
  const copySource = source.slice(copyStart, copyEnd)

  assert.match(
    copySource,
    /chromiumProcessDetector\.isChromiumLikeProcess\([\s\S]*?context\.bundleId,[\s\S]*?context\.pid[\s\S]*?\)/u,
    'AX 失败后必须使用通用检测覆盖 Chromium 与 Electron'
  )
})

test('AX helper 必须区分焦点就绪和焦点失配', () => {
  const helper = readFileSync('helpers/macos-ax-reader/main.m', 'utf8')
  const windowRead = helper.slice(
    helper.indexOf('static NSString *CopySelectedTextFromWindow'),
    helper.indexOf('int main(')
  )

  assert.match(windowRead, /if \(focusStatus\) \*focusStatus = @"ready"/u, '焦点窗口匹配时应输出 ready')
  assert.match(windowRead, /if \(focusStatus\) \*focusStatus = @"target-mismatch"/u, '焦点窗口失配时应输出 target-mismatch')
})

test('AX helper 必须输出脱敏焦点阶段诊断', () => {
  const source = readFileSync('helpers/macos-ax-reader/main.m', 'utf8')
  assert.match(source, /FOCUS\s+unknown\|ready\|target-mismatch/u, '协议注释必须声明 FOCUS 枚举')
  assert.match(source, /static void WriteFocusDiagnostic/u, '必须提供焦点诊断输出函数')
  assert.match(source, /result\.focusStatus = @"unknown"/u, '窗口级读取失败必须输出 unknown')
})

test('Chromium AX UNKNOWN 后必须尝试增强 AX 并记录结果', () => {
  const source = readCaptureSource()
  const copyStart = source.indexOf('async function captureByCopy(')
  const copyEnd = source.indexOf('/**\n * 捕获当前选中文字', copyStart)
  const copySource = source.slice(copyStart, copyEnd)

  assert.match(copySource, /enhancedAx=/u, '必须记录增强 AX 结果')
  assert.match(copySource, /enhancedAx: 'none' \| 'enhanced-ui' \| 'rejected'/u, '必须使用白名单枚举')
  assert.doesNotMatch(copySource, /waitForChromiumEnhancedAx/u, '不得在同一轮无界等待增强生效')
})

test('Chromium 增强 AX 必须通过 helper 真实设置应用属性', () => {
  const helper = readFileSync('helpers/macos-ax-reader/main.m', 'utf8')
  const source = readCaptureSource()

  assert.match(helper, /static AXEnhancementResult EnableEnhancedUserInterface/u, 'helper 必须实现增强 AX 设置')
  assert.match(helper, /AXEnhancedUserInterface/u, 'helper 必须设置增强 AX 属性')
  assert.match(helper, /"--enhance"/u, 'helper 必须提供 enhance 子命令')
  assert.match(source, /performChromiumEnhancedAx/u, '主进程必须调用 helper 设置增强 AX')
  assert.match(source, /'--enhance', String\(pid\)/u, '必须把目标进程号传给 helper')
})

test('Chromium 增强拒绝必须记录固定 reason 且不得泄露文本', () => {
  const source = readCaptureSource()
  const enhanceStart = source.indexOf('async function requestChromiumEnhancedAx(')
  const enhanceEnd = source.indexOf('/**\n * 为已记录为源窗口', enhanceStart)
  const enhanceSource = source.slice(enhanceStart, enhanceEnd)

  assert.ok(enhanceStart >= 0 && enhanceEnd > enhanceStart, '应存在增强 helper 调用实现')
  assert.match(enhanceSource, /parseMacosAxEnhancementOutput/u, '必须解析结构化增强结果')
  assert.match(enhanceSource, /reason=\$\{/u, '拒绝日志必须输出固定 reason')
  assert.doesNotMatch(enhanceSource, /stdout\?\.length|textLength|selectedText/u,
    '增强诊断不得记录任何选区文本或长度')
})

test('Chromium 增强 AX 后必须在同一轮有界重读', () => {
  const source = readCaptureSource()
  const copyStart = source.indexOf('async function captureByCopy(')
  const copyEnd = source.indexOf('/**\n * 捕获当前选中文字', copyStart)
  const copySource = source.slice(copyStart, copyEnd)
  const enhanceAt = copySource.indexOf('performChromiumEnhancedAx(context.pid, signal)')
  const retryAt = copySource.indexOf('readSelectionViaMacosHelper(', enhanceAt)

  assert.ok(enhanceAt >= 0, 'Chromium 失败后必须调用增强 helper')
  assert.ok(retryAt > enhanceAt, '增强后必须在同一轮重新读取 AX')
  assert.match(copySource, /CHROMIUM_AX_ENHANCE_RETRY_COUNT/u, '重读次数必须使用固定上限')
  assert.match(copySource, /CHROMIUM_AX_ENHANCE_RETRY_DELAY_MS/u, '重读间隔必须使用固定上限')
  assert.match(copySource, /post-enhance-native-read status=/u, '增强后重读应输出脱敏诊断日志')
})

test('Chromium 增强必须按 PID 单飞且成功后不重复请求', () => {
  const source = readCaptureSource()
  const enhanceStart = source.indexOf('async function performChromiumEnhancedAx(')
  const enhanceEnd = source.indexOf('/**\n * Windows 常驻 UIA helper 宿主单例', enhanceStart)
  const enhanceSource = source.slice(enhanceStart, enhanceEnd)

  assert.ok(enhanceStart >= 0 && enhanceEnd > enhanceStart, '应存在 Chromium 增强实现')
  assert.match(source, /chromiumAxEnhancementRequests/u, '必须维护按 PID 的增强请求缓存')
  assert.match(source, /chromiumAxEnhancementsAccepted/u, '必须记录已成功增强的 PID')
  assert.match(enhanceSource, /chromiumAxEnhancementRequests\.get\(pid\)/u, '并发调用必须复用同一请求')
  assert.match(enhanceSource, /chromiumAxEnhancementsAccepted\.has\(pid\)/u, '已成功增强的 PID 不得再次设置属性')
  assert.match(enhanceSource, /finally\s*\{[\s\S]*chromiumAxEnhancementRequests\.delete\(pid\)/u,
    '请求完成后必须清理 in-flight 记录')
})

test('Chromium 增强应在记录源窗口后后台预热且不阻塞入口', () => {
  const source = readCaptureSource()
  const foreground = readFileSync('src/main/macForeground.ts', 'utf8')
  assert.match(source, /export function warmChromiumAccessibility/u, 'capture 必须导出可复用的预热入口')
  const warmStart = source.indexOf('export function warmChromiumAccessibility(')
  const warmEnd = source.indexOf('\n}\n', warmStart)
  const warmSource = source.slice(warmStart, warmEnd)
  assert.match(warmSource, /void performChromiumEnhancedAx/u, '预热必须以非阻塞方式调用增强')
  assert.match(warmSource, /chromiumProcessDetector/u, '预热必须复用 Chromium/Electron 进程检测器')
  assert.match(warmSource, /isChromiumLikeProcess/u, '预热必须覆盖 Chromium 与 Electron')
  assert.doesNotMatch(warmSource, /isChromiumBundleId/u, '预热不得只依赖 Chrome 专用 bundle id 白名单')

  assert.match(foreground, /warmChromiumAccessibility/u, '记录 Chromium 源窗口时必须触发预热')
  const rememberStart = foreground.indexOf('export async function rememberFrontmostWindowAtPoint(')
  const rememberEnd = foreground.indexOf('\n}\n', rememberStart)
  const rememberSource = foreground.slice(rememberStart, rememberEnd)
  assert.match(rememberSource, /warmChromiumAccessibility\(/u,
    '记录源窗口是天然的一次性预热时机')
  assert.match(rememberSource, /void warmChromiumAccessibility/u, '预热不得阻塞窗口快照返回')
})

test('增强后的同轮重读必须短路且等待可取消', () => {
  const source = readCaptureSource()
  const copyStart = source.indexOf('async function captureByCopy(')
  const copyEnd = source.indexOf('/**\n * 捕获当前选中文字', copyStart)
  const copySource = source.slice(copyStart, copyEnd)

  assert.match(copySource, /await waitForAbortableDelay\(/u, '重读间隔必须使用可取消等待')
  assert.match(copySource, /if \(isTrustedNativeSelection\(retried, context\)\)[\s\S]*?break/u,
    '首次重读命中后必须立即停止后续重读')
})
