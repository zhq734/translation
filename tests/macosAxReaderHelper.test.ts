import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { resolveMacosAxReaderPath } from '../src/main/nativeReaderHost.ts'
import { parseNativeSelectionReadOutput } from '../src/shared/selectionBehavior.ts'
import { parseMacosAxReaderWindowDiagnostic } from '../src/shared/platformCapture.ts'

const HELPER_PATH = 'helpers/macos-ax-reader/main.m'

/**
 * 读取 macOS AX helper 源码，文件不存在时返回空串以便断言给出明确失败信息。
 * @returns helper 源码文本。
 * @author zhenghq
 */
function readHelperSource(): string {
  return existsSync(HELPER_PATH) ? readFileSync(HELPER_PATH, 'utf8') : ''
}

/**
 * 校验 helper 输出协议与现有 parseNativeSelectionReadOutput 完全兼容：
 * 首行状态标记，其余行作为选中文本。
 * @returns 无返回值。
 * @author zhenghq
 */
test('helper 输出协议应兼容现有 parseNativeSelectionReadOutput', () => {
  assert.deepEqual(parseNativeSelectionReadOutput('PRESENT\nhello world'), {
    status: 'present',
    text: 'hello world'
  })
  assert.deepEqual(parseNativeSelectionReadOutput('PRESENT\nline1\nline2'), {
    status: 'present',
    text: 'line1\nline2'
  })
  assert.deepEqual(parseNativeSelectionReadOutput('EMPTY'), { status: 'empty', text: '' })
  assert.deepEqual(parseNativeSelectionReadOutput('UNKNOWN'), { status: 'unknown', text: '' })
})

/**
 * 校验 helper 源码包含全部状态标记，包括权限失败标记，且以“状态 + 换行 + 文本”分隔。
 * @returns 无返回值。
 * @author zhenghq
 */
test('helper 源码应输出 PRESENT/EMPTY/UNKNOWN/权限失败标记与文本分隔格式', () => {
  const source = readHelperSource()
  assert.ok(source.length > 0, `缺少 macOS AX helper 源码: ${HELPER_PATH}`)
  assert.match(source, /PRESENT/u)
  assert.match(source, /EMPTY/u)
  assert.match(source, /UNKNOWN/u)
  // 权限失败必须有明确标记，供上层沿用授权引导。
  assert.match(source, /PERMISSION/u)
})

/**
 * 校验 helper 按序执行三级读取：AXSelectedText → AXSelectedTextMarkerRange → 鼠标位置元素，
 * 鼠标位置兜底最多沿 AXParent 上溯 4 层，且完全不引用 System Events。
 * @returns 无返回值。
 * @author zhenghq
 */
test('helper 应按序执行三级读取且不引用 System Events', () => {
  const source = readHelperSource()
  assert.ok(source.length > 0, `缺少 macOS AX helper 源码: ${HELPER_PATH}`)

  assert.match(source, /AXIsProcessTrusted/u)
  assert.match(source, /kAXSelectedTextAttribute/u)
  assert.match(source, /kAXSelectedTextMarkerRangeAttribute/u)
  assert.match(source, /AXUIElementCopyElementAtPosition/u)

  // 校验 main 中三级读取的调用顺序（函数定义顺序与注释提及不参与判定）。
  const mainBody = source.slice(source.indexOf('int main'))
  const selectedTextAt = mainBody.indexOf('CopyStringAttribute(focusedElement, kAXSelectedTextAttribute)')
  const markerRangeAt = mainBody.indexOf('CopySelectedTextViaMarkerRange(focusedElement)')
  const positionAt = source.indexOf('AXUIElementCopyElementAtPosition')
  assert.ok(selectedTextAt >= 0 && markerRangeAt > selectedTextAt,
    'AXSelectedTextMarkerRange 读取应位于 AXSelectedText 之后')
  assert.ok(positionAt > markerRangeAt,
    '鼠标位置元素兜底应位于 marker range 之后')

  // 鼠标位置兜底最多上溯 4 层祖先。
  assert.match(source, /4/u)

  // 直读只依赖 Accessibility，代码中不得出现 System Events 引用（注释中的说明除外）。
  const codeOnly = source.split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*')).join('\n')
  assert.ok(!/System Events/u.test(codeOnly), 'helper 代码不得引用 System Events')

/**
 * 校验 CopySelectedTextFromAncestry 在祖先链每一层都保留 marker range 回退，
 * 覆盖 VS Code 注释、网页正文等不暴露 AXSelectedText 的自绘控件。
 * @returns 无返回值。
 * @author zhenghq
 */
test('祖先链读取的每一层都应保留 AXSelectedTextMarkerRange 回退', () => {
  const source = readHelperSource()
  assert.ok(source.length > 0, `缺少 macOS AX helper 源码: ${HELPER_PATH}`)

  const startAt = source.indexOf('static NSString *CopySelectedTextFromAncestry')
  const endAt = source.indexOf('static AXUIElementRef CopyElementAtMousePosition')
  assert.ok(startAt >= 0, '缺少 CopySelectedTextFromAncestry 定义')
  assert.ok(endAt > startAt, 'CopySelectedTextFromAncestry 定义顺序异常')
  const ancestryBody = source.slice(startAt, endAt)

  // 循环体内必须"先 AXSelectedText 后 marker range"，缺一即退化回只读 AXSelectedText。
  const selectedTextAt = ancestryBody.indexOf('CopyStringAttribute(current, kAXSelectedTextAttribute)')
  const markerRangeAt = ancestryBody.indexOf('CopySelectedTextViaMarkerRange(current)')
  assert.ok(selectedTextAt >= 0, '祖先链每层应先读 AXSelectedText')
  assert.ok(markerRangeAt > selectedTextAt, '祖先链每层的 AXSelectedText 失败后应回退 marker range')

  // 回退必须真的挂在"当前层读取失败"分支上，而不是无条件覆盖。
  assert.match(ancestryBody, /if \(!text\) \{\s*\n\s*text = CopySelectedTextViaMarkerRange\(current\);/u)

  // 命中即返回首个非空选区，并沿 AXParent 上溯。
  assert.match(ancestryBody, /kAXParentAttribute/u)
  assert.match(ancestryBody, /break;/u)
})
})

/**
 * 校验构建脚本存在且 package.json 已接入 dev/build 脚本链与 mac extraResources。
 * @returns 无返回值。
 * @author zhenghq
 */
test('构建脚本与打包配置应接入 macOS AX helper', () => {
  const buildScriptPath = 'scripts/build-macos-ax-reader.mjs'
  assert.ok(existsSync(buildScriptPath), `缺少构建脚本: ${buildScriptPath}`)

  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.match(packageJson.scripts.dev, /build-macos-ax-reader/u)
  assert.match(packageJson.scripts.build, /build-macos-ax-reader/u)

  const macResources = packageJson.build.mac.extraResources as Array<{ from: string }>
  assert.ok(
    macResources.some((entry) => entry.from.includes('macos-ax-reader')),
    'mac extraResources 应包含 macos-ax-reader'
  )
})

/**
 * 校验打包环境下 AX helper 路径优先解析到 Electron resourcesPath，
 * 避免打包产物中因相对路径失效而降级到 System Events（触发 Automation 弹窗）。
 * @returns 无返回值。
 * @author zhenghq
 */
test('AX helper 路径应优先解析打包后的 resourcesPath', () => {
  const packagedPath = resolveMacosAxReaderPath({
    resourcesPath: '/Applications/App.app/Contents/Resources',
    cwd: '/repo',
    fileExists: (candidate: string) =>
      candidate === '/Applications/App.app/Contents/Resources/macos-ax-reader'
  })
  assert.equal(packagedPath, '/Applications/App.app/Contents/Resources/macos-ax-reader')
})

/**
 * 校验开发环境下 AX helper 路径回退到仓库 build 目录，且返回绝对路径。
 * @returns 无返回值。
 * @author zhenghq
 */
test('AX helper 路径在开发环境应回退 build 目录绝对路径', () => {
  const devPath = resolveMacosAxReaderPath({
    resourcesPath: undefined,
    cwd: '/repo',
    fileExists: (candidate: string) => candidate === '/repo/build/macos-ax-reader'
  })
  assert.equal(devPath, '/repo/build/macos-ax-reader')
})

/**
 * 校验 helper 均不存在时返回 null，让取词管线明确降级而不是执行不存在的路径。
 * @returns 无返回值。
 * @author zhenghq
 */
test('AX helper 不存在时应返回 null 以触发降级', () => {
  assert.equal(
    resolveMacosAxReaderPath({ resourcesPath: '/res', cwd: '/repo', fileExists: () => false }),
    null
  )
})

/**
 * 校验 capture.ts 的 macOS 直读使用解析后的 helper 绝对路径，而非硬编码相对路径。
 * @returns 无返回值。
 * @author zhenghq
 */
test('capture.ts macOS 直读应使用解析后的 helper 路径', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  assert.match(source, /resolveMacosAxReaderPath/u)
  assert.ok(
    !/execFileP\(\s*'build\/macos-ax-reader'/u.test(source),
    'macOS 直读不得硬编码 build/macos-ax-reader 相对路径'
  )
})

/**
 * 校验 helper 支持可选窗口编号参数，同时无参数调用仍保持原有读取路径。
 * @returns 无返回值。
 * @author zhenghq
 */
test('AX helper 应支持可选窗口编号且无参数时保持旧协议', () => {
  const source = readHelperSource()
  assert.match(source, /argc\s*>\s*1/u, 'helper 必须检查可选窗口参数')
  assert.match(source, /argv\[1\]/u, 'helper 必须从 argv[1] 读取窗口编号')
  assert.match(source, /AXWindowNumber/u, 'helper 必须按 AX 窗口编号定位目标窗口')
  assert.match(source, /kAXFocusedWindowAttribute/u, 'helper 应读取目标窗口的 focused window')
  assert.match(source, /kAXRaiseAction/u, 'helper 应能提升目标窗口后读取')
  assert.match(source, /PRESENT/u, '窗口读取路径仍必须输出 PRESENT 状态')
  assert.match(source, /UNKNOWN/u, '无效窗口必须回退并输出 UNKNOWN')
})

/**
 * 校验 Node 侧把窗口编号作为可选参数传入，同时保留无参数调用。
 * @returns 无返回值。
 * @author zhenghq
 */
test('capture.ts macOS helper 调用应可选传入窗口编号', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const start = source.indexOf('async function readSelectionViaMacosHelper')
  const end = source.indexOf('async function readSelectionViaWindowsHelper', start)
  const fnSource = source.slice(start, end)
  assert.match(fnSource, /windowNumber/u, 'helper 调用必须接收可选窗口编号')
  assert.match(fnSource, /String\(windowNumber\)|\[\s*windowNumber/u, '窗口编号必须作为 argv 参数传入')
  assert.match(fnSource, /\[\]/u, '无窗口上下文时必须保留空参数调用')
})

/**
 * 校验 helper 在 stderr 输出固定窗口诊断，且诊断不包含标题或选区文本。
 * @returns 无返回值。
 * @author zhenghq
 */
test('AX helper 应输出固定窗口诊断且不泄露标题与选区文本', () => {
  const source = readHelperSource()
  const diagnosticStart = source.indexOf('WriteWindowDiagnostic')
  const diagnosticEnd = source.indexOf('\n}', diagnosticStart)
  assert.ok(diagnosticStart >= 0, 'helper 应定义窗口诊断输出函数')
  assert.ok(diagnosticEnd > diagnosticStart, '窗口诊断输出函数应有明确边界')
  const diagnosticSource = source.slice(diagnosticStart, diagnosticEnd)

  assert.match(diagnosticSource, /StandardError/u, '窗口诊断必须写入 stderr，避免污染 stdout 文本协议')
  assert.match(source, /WINDOW %@ count=/u, '诊断格式必须由固定模板生成')
  assert.match(source, /WriteWindowDiagnostic\(@"exact"/u, '精确命中必须写入 exact 诊断')
  assert.match(source, /WriteWindowDiagnostic\(@"fallback"/u, '应用级退化必须写入 fallback 诊断')
  assert.match(source, /WriteWindowDiagnostic\(@"failed"/u, '定位失败必须写入 failed 诊断')
  assert.doesNotMatch(diagnosticSource, /title|标题/iu, '诊断不得输出窗口标题')
  assert.doesNotMatch(diagnosticSource, /selectedText|选区文本/iu, '诊断不得输出选区文本')
})

/**
 * 校验 helper 可选接收 pid，并通过 AXUIElementCreateApplication(pid) 定向定位应用。
 * @returns 无返回值。
 * @author zhenghq
 */
test('AX helper 应支持可选 pid 并定向读取目标应用窗口', () => {
  const source = readHelperSource()
  assert.match(source, /argc\s*>\s*2/u, 'helper 应检查可选 pid 参数')
  assert.match(source, /argv\[2\]/u, 'helper 应从 argv[2] 读取 pid')
  assert.match(source, /AXUIElementCreateApplication\(/u, '传入 pid 时应直接创建目标应用 AX 元素')
  assert.match(source, /CopyWindowCount\(/u, 'helper 应统计目标应用窗口数量')
  assert.match(source, /WriteWindowDiagnostic\(@"exact"/u, '精确命中时应写入 exact 诊断')
  assert.match(source, /WriteWindowDiagnostic\(@"fallback"/u, '旧路径命中时应写入 fallback 诊断')
  assert.match(source, /WriteWindowDiagnostic\(@"failed"/u, '定位失败时应写入 failed 诊断')
})

/**
 * 校验 Node 侧同时读取 helper stderr，并按固定诊断行解析窗口定位结果。
 * @returns 无返回值。
 * @author zhenghq
 */
test('capture.ts macOS helper 调用应解析 stderr 窗口诊断', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const start = source.indexOf('async function readSelectionViaMacosHelper')
  const end = source.indexOf('async function readSelectionViaWindowsHelper', start)
  const fnSource = source.slice(start, end)

  assert.match(fnSource, /stderr/u, '必须读取 helper stderr')
  assert.match(fnSource, /parseMacosAxReaderWindowDiagnostic/u, '必须按固定诊断行解析窗口定位结果')
  assert.match(fnSource, /windowLocate/u, '解析结果必须透传到 NativeSelectionReadResult')
  assert.match(fnSource, /windowCount/u, '解析结果必须透传窗口数量')
  assert.match(fnSource, /windowMatched/u, '解析结果必须透传窗口命中状态')
})

/**
 * 校验窗口诊断解析器区分精确命中、应用级退化与定位失败。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口诊断解析器应区分 exact、fallback 与 failed', () => {
  assert.deepEqual(parseMacosAxReaderWindowDiagnostic('WINDOW exact count=2'), {
    windowLocate: 'exact',
    windowCount: 2,
    windowMatched: true
  })
  assert.deepEqual(parseMacosAxReaderWindowDiagnostic('WINDOW fallback count=2'), {
    windowLocate: 'app-fallback',
    windowCount: 2,
    windowMatched: false
  })
  assert.deepEqual(parseMacosAxReaderWindowDiagnostic('WINDOW failed count=0'), {
    windowLocate: 'failed',
    windowCount: 0,
    windowMatched: false
  })
})

/**
 * 校验窗口诊断解析器忽略未知行、非法计数与敏感内容。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口诊断解析器应忽略未知或非法行', () => {
  assert.deepEqual(parseMacosAxReaderWindowDiagnostic(''), {})
  assert.deepEqual(parseMacosAxReaderWindowDiagnostic('hello\nWINDOW unknown count=2'), {})
  assert.deepEqual(parseMacosAxReaderWindowDiagnostic('WINDOW exact count=-1'), {})
  assert.deepEqual(parseMacosAxReaderWindowDiagnostic('WINDOW exact count=abc'), {})
  assert.deepEqual(parseMacosAxReaderWindowDiagnostic('WINDOW exact count=2\n张三 - 微信'), {
    windowLocate: 'exact',
    windowCount: 2,
    windowMatched: true
  })
})
