import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { resolveMacosAxReaderPath } from '../src/main/nativeReaderHost.ts'
import { parseNativeSelectionReadOutput } from '../src/shared/selectionBehavior.ts'
import {
  parseMacosAxCopyOutput,
  parseMacosAxReaderWindowDiagnostic
} from '../src/shared/platformCapture.ts'

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
 * 从源码中截取指定函数定义，避免断言命中其它函数或注释。
 * @param source 待检索源码。
 * @param signature 函数签名起始片段。
 * @returns 从函数签名到函数结束的源码片段。
 * @author zhenghq
 */
function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `应存在函数 ${signature}`)
  const end = source.indexOf('\n}\n', start)
  assert.ok(end > start, `函数 ${signature} 应有结束边界`)
  return source.slice(start, end)
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
  assert.deepEqual(parseNativeSelectionReadOutput('UNKNOWN reason=api-disabled'), {
    status: 'unknown',
    text: '',
    reason: 'api-disabled'
  })
})

/**
 * 校验 helper 在 AX 返回 kAXErrorAPIDisabled 时输出固定原因，而不是折叠成普通 UNKNOWN。
 * @returns 无返回值。
 * @author zhenghq
 */
test('helper 必须把 AX APIDisabled 输出为 api-disabled', () => {
  const source = readHelperSource()
  const readBody = source.slice(
    source.indexOf('static MacosAxReadResult ReadMacosAxSelection'),
    source.indexOf('#ifndef MACOS_AX_READER_NO_MAIN')
  )

  assert.match(source, /kAXErrorAPIDisabled/u, '必须显式判断 -25211 对应的 APIDisabled 错误')
  assert.match(source, /UNKNOWN reason=api-disabled/u, '失败输出必须携带固定原因')
  assert.match(
    readBody,
    /CopySelectedTextFromWindow\([^;]*&apiDisabled/u,
    '窗口读取必须把 APIDisabled 状态透传给入口'
  )
  assert.match(
    readBody,
    /if \(apiDisabled\)[\s\S]*?result\.reason = @"api-disabled"/u,
    '窗口读取失败后必须优先输出 APIDisabled 原因，而不是继续折叠为 UNKNOWN'
  )
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

  // 校验共享读取函数中三级读取的调用顺序（函数定义顺序与注释提及不参与判定）。
  const readBody = source.slice(
    source.indexOf('static MacosAxReadResult ReadMacosAxSelection'),
    source.indexOf('#ifndef MACOS_AX_READER_NO_MAIN')
  )
  const focusedReadAt = readBody.indexOf('CopySelectedTextFromAncestry(focusedElement')
  const positionAt = source.indexOf('AXUIElementCopyElementAtPosition')
  assert.ok(focusedReadAt >= 0, '系统级焦点兜底应复用祖先链读取')
  assert.ok(positionAt > focusedReadAt,
    '鼠标位置元素兜底应位于系统级焦点读取之后')

  // 鼠标位置兜底最多上溯 4 层祖先。
  assert.match(source, /4/u)

  // 直读只依赖 Accessibility，代码中不得出现 System Events 引用（注释中的说明除外）。
  const codeOnly = source.split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*')).join('\n')
  assert.ok(!/System Events/u.test(codeOnly), 'helper 代码不得引用 System Events')
})

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

/**
 * 校验 WebKit 的 marker range 必须通过 AXStringForTextMarkerRange 读取，
 * 并保留 AXTextForRange 作为旧版应用兼容回退。
 * @returns 无返回值。
 * @author zhenghq
 */
test('WebKit marker range 应优先使用 AXStringForTextMarkerRange', () => {
  const source = readHelperSource()
  const markerBody = extractFunction(source, 'static NSString *CopySelectedTextViaMarkerRange')
  const correctAttributeAt = markerBody.indexOf('AXStringForTextMarkerRange')
  const legacyAttributeAt = markerBody.indexOf('AXTextForRange')

  assert.ok(correctAttributeAt >= 0,
    'WebKit marker range 必须使用 AXStringForTextMarkerRange 参数化属性')
  assert.ok(legacyAttributeAt > correctAttributeAt,
    'AXStringForTextMarkerRange 失败后应保留 AXTextForRange 兼容回退')
  assert.match(markerBody, /AXUIElementCopyParameterizedAttributeValue/u,
    '必须通过 AX 参数化属性读取 marker range 文本')
})

/**
 * 校验 Safari/WebKit 的选中文字位于 focused element 的祖先节点时，
 * 窗口级与系统级读取都必须沿完整祖先链查找，而不是只检查当前元素。
 * @returns 无返回值。
 * @author zhenghq
 */
test('焦点元素读取必须沿完整祖先链查找选区', () => {
  const source = readHelperSource()
  const windowBody = extractFunction(source, 'static NSString *CopySelectedTextFromWindow')
  const readBody = source.slice(
    source.indexOf('static MacosAxReadResult ReadMacosAxSelection'),
    source.indexOf('#ifndef MACOS_AX_READER_NO_MAIN')
  )

  assert.ok(
    (windowBody.match(/CopySelectedTextFromAncestry\(\(AXUIElementRef\)focusedValue, kMaxAncestorLevels\)/gu) ?? []).length >= 2,
    '窗口级 application/window focused element 都必须使用完整祖先链'
  )
  assert.match(
    readBody,
    /CopySelectedTextFromAncestry\(focusedElement, kMaxAncestorLevels\)/u,
    '系统级 focused element 兜底必须使用完整祖先链'
  )
  assert.doesNotMatch(windowBody, /CopySelectedTextFromAncestry\([^;]+, 1\)/u,
    '窗口级读取不得退化为仅检查当前元素')
})

/**
 * 校验只暴露 AXSelectedTextRange 的 Safari/WebKit 元素可通过
 * AXStringForRange 参数化属性读取选区，作为 marker range 之后的兼容回退。
 * @returns 无返回值。
 * @author zhenghq
 */
test('祖先链读取应支持 AXSelectedTextRange 与 AXStringForRange 回退', () => {
  const source = readHelperSource()
  const rangeBody = extractFunction(source, 'static NSString *CopySelectedTextViaSelectedRange')
  const ancestryBody = extractFunction(source, 'static NSString *CopySelectedTextFromAncestry')

  assert.match(rangeBody, /AXSelectedTextRange/u, '必须读取 AXSelectedTextRange')
  assert.match(rangeBody, /AXStringForRange/u, '必须通过 AXStringForRange 读取选区文字')
  assert.match(rangeBody, /kAXValueCFRangeType/u, '必须校验 AXValue 为 CFRange 类型')
  assert.match(rangeBody, /range\.length\s*<=\s*0/u, '空选区不得请求文本')
  assert.match(
    ancestryBody,
    /CopySelectedTextViaMarkerRange\(current\)[\s\S]*?CopySelectedTextViaSelectedRange\(current\)/u,
    'AXSelectedTextRange 回退必须位于 marker range 之后'
  )
})

/**
 * 校验 Chromium 增强优先请求 AXManualAccessibility，只有该属性被拒绝时
 * 才请求 AXEnhancedUserInterface。Electron 对两个属性都会进入同一套
 * 2 秒防抖计数，无条件同时设置会重复累积请求并反复重置定时器。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Chromium 增强应优先 manual 且仅在拒绝时回退 enhanced', () => {
  const source = readHelperSource()
  const enhanceBody = extractFunction(source, 'static AXEnhancementResult EnableEnhancedUserInterface')
  const touchBody = extractFunction(source, 'static void TouchDescendantElements')

  assert.match(enhanceBody, /AXManualAccessibility/u, '必须设置 AXManualAccessibility')
  assert.match(enhanceBody, /AXEnhancedUserInterface/u, '必须设置 AXEnhancedUserInterface')
  const manualAt = enhanceBody.indexOf('AXManualAccessibility')
  const manualFallbackAt = enhanceBody.indexOf('if (result.manualError', manualAt)
  const enhancedAt = enhanceBody.indexOf('AXEnhancedUserInterface', manualAt)
  assert.ok(manualFallbackAt > manualAt && enhancedAt > manualFallbackAt,
    'manual 成功时必须跳过 enhanced，只有拒绝时才进入回退分支')
  assert.match(enhanceBody, /TouchDescendantElements/u, '设置属性后必须触发目标窗口 AX 树构建')
  assert.match(touchBody, /kAXChildrenAttribute/u, 'touch 必须读取 AX children')
  assert.match(touchBody, /kMaxAxTouchDepth|maxDepth/u, 'touch 必须有深度上限')
  assert.match(touchBody, /kMaxAxTouchNodeCount|visitedCount/u, 'touch 必须有节点数量上限')
})

/**
 * 校验增强模式输出稳定的 mode/reason 原因码，避免把权限不足、目标不可访问
 * 与 Chromium 拒绝属性混为同一个 REJECTED。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Chromium 增强应输出固定 mode 与 reason 诊断', () => {
  const source = readHelperSource()
  const enhanceBody = extractFunction(source, 'static AXEnhancementResult EnableEnhancedUserInterface')
  const mainBody = source.slice(source.indexOf('int main'))

  assert.match(source, /AXEnhancementResult/u, '增强函数必须返回结构化结果')
  assert.match(enhanceBody, /AXIsProcessTrusted/u, '增强函数必须显式检查 Accessibility 权限')
  assert.match(enhanceBody, /applicationAvailable/u, '必须单独记录应用 AX 元素是否可用')
  assert.match(enhanceBody, /manualError|enhancedError/u, '必须保留两个属性的 AXError')
  assert.match(mainBody, /ACCEPTED mode=manual/u, 'manual 成功必须输出固定 mode')
  assert.match(mainBody, /ACCEPTED mode=enhanced/u, 'enhanced 成功必须输出固定 mode')
  assert.match(mainBody, /REJECTED reason=/u, '失败必须输出固定 reason')
  assert.match(mainBody, /REJECTED reason=permission/u, '权限失败必须使用固定 permission 原因码')
  assert.match(mainBody, /manualError/u, 'manual 拒绝必须保留数字错误码')
  assert.match(mainBody, /enhancedError/u, 'enhanced 拒绝必须保留数字错误码')
})

/**
 * 校验窗口定位在 AXWindows 为空或未命中时，会依次尝试 focused/main window，
 * 且回退窗口仍由编号、bounds 或标题指纹确认属于目标窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口定位应支持 AXWindows 为空时的 focused/main 受控回退', () => {
  const source = readHelperSource()
  const body = extractFunction(source, 'static AXUIElementRef CopyWindowByContext')

  assert.match(body, /kAXFocusedWindowAttribute/u, 'AXWindows 未命中时必须尝试 focused window')
  assert.match(body, /kAXMainWindowAttribute/u, 'focused window 未命中时必须尝试 main window')
  assert.match(source, /WindowMatchesContext/u, 'focused/main window 必须复用目标窗口校验')
  assert.match(body, /CopyAXWindowsAttribute|kAXWindowsAttribute/u, '仍必须优先读取 AXWindows')
  assert.match(source, /windowCount/u, '回退诊断必须保留窗口数量语义')
})

/**
 * 校验窗口级读取在获取焦点元素前会触发目标窗口的 AX 后代树构建，
 * 以覆盖 Chromium、Word、Excel 等按需生成辅助功能树的应用。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口级 AX 读取应先在目标窗口上触发后代树构建', () => {
  const source = readHelperSource()
  const windowBody = extractFunction(source, 'static NSString *CopySelectedTextFromWindow')

  assert.match(windowBody, /TouchDescendantElements\(window/u,
    '必须在读取 focused element 前 touch 目标窗口')
  const touchAt = windowBody.indexOf('TouchDescendantElements(window')
  const focusedReadAt = windowBody.indexOf('kAXFocusedUIElementAttribute')
  assert.ok(touchAt >= 0 && focusedReadAt > touchAt,
    'touch 必须发生在窗口级 focused element 读取之前')
})

/**
 * 校验窗口已精确命中但焦点元素没有选区时，仍保留真实窗口命中诊断，
 * 避免最终失败汇总把 exact/windowMatched=true 覆盖成 failed/false。
 * @returns 无返回值。
 * @author zhenghq
 */
test('目标窗口命中但无选区时应保留 windowMatched 诊断', () => {
  const source = readHelperSource()
  const windowBody = extractFunction(source, 'static NSString *CopySelectedTextFromWindow')
  const readBody = source.slice(
    source.indexOf('static MacosAxReadResult ReadMacosAxSelection'),
    source.indexOf('#ifndef MACOS_AX_READER_NO_MAIN')
  )

  assert.match(windowBody, /BOOL \*windowMatched/u,
    '窗口级读取必须通过输出参数返回是否命中目标窗口')
  assert.match(windowBody, /if \(windowMatched\) \*windowMatched = YES;/u,
    '窗口定位成功后必须立即记录命中状态')
  assert.match(readBody, /CopySelectedTextFromWindow\([^;]*&windowMatched/u,
    '共享读取入口必须接收窗口命中状态')
  assert.match(readBody, /result\.windowMatched = windowMatched;/u,
    '外层必须保存窗口命中状态，而不是只在取到文本时写 true')
  assert.match(readBody, /if \(windowMatched\)[\s\S]*?result\.windowLocate = @"exact"/u,
    '窗口命中时应写入 exact 诊断')
  assert.match(readBody, /if \(options\.hasWindowArgument && !result\.windowMatched\)[\s\S]*?result\.windowLocate = @"failed"/u,
    '只有未命中窗口时才允许在最终汇总写入 failed')
})

/**
 * 校验系统焦点或鼠标位置兜底成功时不会把非窗口级读取误报为 exact。
 * @returns 无返回值。
 * @author zhenghq
 */
test('非窗口级 AX 兜底成功应标记 app-fallback 且 windowMatched=false', () => {
  const source = readHelperSource()
  const readBody = source.slice(
    source.indexOf('static MacosAxReadResult ReadMacosAxSelection'),
    source.indexOf('#ifndef MACOS_AX_READER_NO_MAIN')
  )

  assert.match(
    readBody,
    /result\.windowLocate = @"fallback";[\s\S]{0,120}?result\.windowMatched = NO;/u,
    '系统焦点或鼠标位置兜底命中时必须同时清除窗口命中标记'
  )
})

/**
 * 校验目标窗口命中后会优先搜索 AXWebArea 后代，并设置深度与节点数硬上限。
 * @returns 无返回值。
 * @author zhenghq
 */
test('目标窗口应有界搜索 AXWebArea 后代选区', () => {
  const source = readHelperSource()
  const searchBody = extractFunction(source, 'static NSString *CopySelectedTextFromDescendants')
  const windowBody = extractFunction(source, 'static NSString *CopySelectedTextFromWindow')

  assert.match(searchBody, /AXWebArea/u, '必须优先识别 AXWebArea 节点')
  assert.match(searchBody, /kAXChildrenAttribute/u, '必须通过 AXChildren 遍历后代')
  assert.match(searchBody, /kMaxAxSelectionSearchDepth/u, '搜索必须有深度上限')
  assert.match(searchBody, /kMaxAxSelectionSearchNodeCount/u, '搜索必须有节点数量上限')
  assert.match(searchBody, /CopySelectedTextFromAncestry\(element, 1\)/u,
    '搜索树的每个节点都必须复用选中文本属性读取')
  assert.match(windowBody, /CopySelectedTextFromDescendants\(window/u,
    '窗口级 focused element 未命中后必须搜索目标窗口后代')
  const focusedAt = windowBody.indexOf('kAXFocusedUIElementAttribute')
  const descendantSearchAt = windowBody.indexOf('CopySelectedTextFromDescendants(window')
  assert.ok(focusedAt >= 0 && descendantSearchAt > focusedAt,
    '后代搜索必须位于 focused element 读取之后')
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
 * 校验 AXWindowNumber 缺失时仍能用窗口边界与标题指纹定位目标 AX 窗口。
 * Chrome 普通多窗口场景中窗口编号可能不暴露在 AX 窗口上，仅按编号会直接失败。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口级 AX 读取应按编号优先并用 bounds 与标题指纹二级定位', () => {
  const source = readHelperSource()
  const body = extractFunction(source, 'static AXUIElementRef CopyWindowByContext')
  const boundsReader = extractFunction(source, 'static BOOL CopyAXWindowBounds')

  assert.match(body, /CopyWindowNumber\(window\) == context\.windowNumber/u, '必须优先按 AXWindowNumber 精确匹配')
  assert.match(boundsReader, /kAXPositionAttribute/u, '编号未命中时必须读取 AXPosition 做二级匹配')
  assert.match(boundsReader, /kAXSizeAttribute/u, '编号未命中时必须读取 AXSize 做二级匹配')
  assert.match(body, /kAXTitleAttribute/u, '多个相同边界窗口必须用标题指纹消除歧义')
  assert.match(source, /CC_SHA256/u, '标题只能在 helper 内计算哈希，不得比较或输出标题明文')
  assert.match(source, /kWindowBoundsTolerance/u, 'bounds 比较必须允许系统坐标系取整误差')

  const numberMatchAt = body.indexOf('CopyWindowNumber(window) == context.windowNumber')
  const boundsMatchAt = body.indexOf('CopyAXWindowBounds')
  assert.ok(numberMatchAt >= 0 && boundsMatchAt > numberMatchAt,
    '窗口编号匹配必须排在 bounds 二级匹配之前')
})

/**
 * 校验无标题指纹时只有唯一 bounds 候选才可采用。
 * 同尺寸重叠窗口若直接取第一个，会把取词目标切到同进程的另一个窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('无标题指纹时 bounds 匹配必须要求唯一候选', () => {
  const source = readHelperSource()
  const body = extractFunction(source, 'static AXUIElementRef CopyWindowByContext')

  assert.match(body, /boundsCandidateCount/u, '必须统计 bounds 命中的候选数量')
  assert.match(body, /boundsCandidateCount\s*==\s*1/u, '只有唯一 bounds 候选时才允许返回窗口')
  assert.match(body, /boundsCandidateCount\s*==\s*1/u, '只有唯一 bounds 候选时才允许返回窗口')
  assert.match(body, /if \(boundsMatched\) CFRelease\(boundsMatched\);\s*boundsMatched = \(AXUIElementRef\)CFRetain\(window\);/u,
    '每个新的 bounds 候选都必须接管并释放上一个候选，避免长循环泄漏')
})

/**
 * 校验 helper 的标题指纹计算先 trim，与 Node 侧 createWindowTitleFingerprint 保持一致。
 * 否则带首尾空白的 AX 标题永远无法命中入口快照。
 * @returns 无返回值。
 * @author zhenghq
 */
test('helper 标题指纹必须与 Node 侧一样先 trim', () => {
  const source = readHelperSource()
  const body = extractFunction(source, 'static NSString *CopyTitleFingerprint')

  assert.match(body, /stringByTrimmingCharactersInSet/u, 'helper 必须先去除标题首尾空白')
  assert.match(body, /NSCharacterSet\.whitespaceAndNewlineCharacterSet/u,
    'helper 应去除空白与换行后再计算 SHA-256')
})

/**
 * 校验 bounds JSON 根节点非字典时先判断类型再取键，避免 Objective-C 异常退出。
 * @returns 无返回值。
 * @author zhenghq
 */
test('bounds JSON 解析必须先校验字典类型再读取字段', () => {
  const source = readHelperSource()
  const body = source.slice(source.indexOf('int main'))
  const typeCheckAt = body.indexOf('[parsedBounds isKindOfClass:[NSDictionary class]]')
  const firstFieldAt = body.indexOf('boundsObject[@"x"]')

  assert.ok(typeCheckAt >= 0, '必须校验 bounds JSON 根节点类型')
  assert.ok(firstFieldAt > typeCheckAt, '类型校验必须早于任何 bounds 字段读取')
})

/**
 * 校验 application focused UI element 只能在 focused window 已确认属于目标窗口后读取。
 * 否则同一进程的另一个 Chrome/微信窗口仍可能把错误选区返回给调用方。
 * @returns 无返回值。
 * @author zhenghq
 */
test('application 焦点元素读取前必须确认 focused window 属于目标窗口', () => {
  const source = readHelperSource()
  const body = extractFunction(source, 'static NSString *CopySelectedTextFromWindow')

  assert.match(source, /kAXFocusedWindowAttribute/u, '必须读取 application 的 focused window')
  assert.match(body, /FocusedWindowBelongsToTarget/u, '必须显式校验 focused window 是否属于目标窗口')
  assert.match(
    body,
    /if \([^\n]*applicationFocusMatchesTarget\)[\s\S]*?application,\s*kAXFocusedUIElementAttribute/u,
    '只有归属校验通过后才允许读取 application 焦点元素'
  )
  assert.match(body, /CopySelectedTextFromAncestry\(\(AXUIElementRef\)focusedValue/u,
    '窗口焦点元素也必须复用祖先链读取，保留 marker range 回退')
})

/**
 * 校验精确命中的目标窗口在 application AXFocusedWindow 不可读时，
 * 仍允许读取该窗口自己的 AXFocusedUIElement。
 *
 * Safari 后台窗口会出现 AXWindows 可精确匹配、application focused window
 * 读取失败，但 window focused element 可读的情况。此时目标窗口身份已经由
 * AXWindows 命中确认，不能再把窗口级焦点入口一并跳过。
 * @returns 无返回值。
 * @author zhenghq
 */
test('精确目标窗口的应用级焦点不可读时仍应读取窗口焦点元素', () => {
  const source = readHelperSource()
  const body = extractFunction(source, 'static NSString *CopySelectedTextFromWindow')
  const applicationFocusAt = body.indexOf(
    'AXUIElementCopyAttributeValue(\n      application, kAXFocusedUIElementAttribute'
  )
  const windowFocusAt = body.indexOf(
    'AXUIElementCopyAttributeValue(\n      window, kAXFocusedUIElementAttribute'
  )

  assert.ok(applicationFocusAt >= 0, '应保留 application 焦点元素入口')
  assert.ok(windowFocusAt > applicationFocusAt, '应保留目标窗口焦点元素入口')
  assert.doesNotMatch(
    body,
    /if \(FocusedWindowBelongsToTarget\([\s\S]*?if \(!result\) \{/u,
    'application focused window 不可读时不得跳过 window focused element'
  )
  assert.match(
    body,
    /AXUIElementCopyAttributeValue\(\s*window,\s*kAXFocusedUIElementAttribute/u,
    '目标窗口焦点元素必须独立尝试'
  )
})

/**
 * 校验 helper 接收 Node 侧记录的 bounds 与标题指纹，同时保持旧参数和无窗口调用兼容。
 * @returns 无返回值。
 * @author zhenghq
 */
test('AX helper 应可选接收 bounds 与标题指纹并保持旧参数兼容', () => {
  const source = readHelperSource()
  assert.match(source, /argc\s*>\s*3/u, 'helper 应检查可选 bounds 参数')
  assert.match(source, /argv\[3\]/u, 'helper 应从 argv[3] 读取 bounds JSON')
  assert.match(source, /argc\s*>\s*4/u, 'helper 应检查可选标题指纹参数')
  assert.match(source, /argv\[4\]/u, 'helper 应从 argv[4] 读取标题指纹')
})

/**
 * 校验窗口级读取失败后仍按既有顺序回退 application 焦点与鼠标位置。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口级 AX 读取失败后应保留原有应用级与鼠标位置兜底', () => {
  const source = readHelperSource()
  const readBody = source.slice(
    source.indexOf('static MacosAxReadResult ReadMacosAxSelection'),
    source.indexOf('#ifndef MACOS_AX_READER_NO_MAIN')
  )
  const windowReadAt = readBody.indexOf('CopySelectedTextFromWindow(')
  const systemFocusedAt = readBody.indexOf('kAXFocusedUIElementAttribute', windowReadAt)
  const mouseReadAt = readBody.indexOf('CopyElementAtMousePosition', systemFocusedAt)

  assert.ok(windowReadAt >= 0, '共享读取函数应先执行窗口级读取')
  assert.ok(systemFocusedAt > windowReadAt, '窗口级失败后才进入 application 焦点读取')
  assert.ok(mouseReadAt > systemFocusedAt, '最后才进入鼠标位置兜底')
})

/**
 * 校验窗口入口返回 APIDisabled 时不得提前结束多入口读取。
 * -25211 可能只影响目标应用的窗口级 AX 入口，系统焦点或鼠标位置入口
 * 仍可能返回可用元素；只有所有入口均失败后才允许输出 api-disabled。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口入口 APIDisabled 后仍应尝试系统焦点与鼠标位置入口', () => {
  const source = readHelperSource()
  const readBody = source.slice(
    source.indexOf('static MacosAxReadResult ReadMacosAxSelection'),
    source.indexOf('#ifndef MACOS_AX_READER_NO_MAIN')
  )
  const windowReadAt = readBody.indexOf('CopySelectedTextFromWindow(')
  const systemFocusedAt = readBody.indexOf('kAXFocusedUIElementAttribute', windowReadAt)
  const mouseReadAt = readBody.indexOf('CopyElementAtMousePosition', systemFocusedAt)

  assert.ok(windowReadAt >= 0, '应存在窗口级读取入口')
  assert.ok(systemFocusedAt > windowReadAt, '应存在系统焦点读取入口')
  assert.ok(mouseReadAt > systemFocusedAt, '应存在鼠标位置读取入口')

  const windowToFocusedSource = readBody.slice(windowReadAt, systemFocusedAt)
  const focusedToMouseSource = readBody.slice(systemFocusedAt, mouseReadAt)
  assert.doesNotMatch(
    windowToFocusedSource,
    /if \(apiDisabled\)[\s\S]*?return result;/u,
    '窗口入口 APIDisabled 时不得跳过系统焦点入口'
  )
  assert.doesNotMatch(
    focusedToMouseSource,
    /return result;/u,
    '系统焦点入口处理期间不得提前返回，鼠标位置入口必须继续可达'
  )
})

/**
 * 校验共享读取函数只在一个出口释放 systemWide。
 *
 * 鼠标位置入口返回 APIDisabled 后仍需走到函数尾部汇总错误；若该分支
 * 提前释放 systemWide，尾部会再次释放同一 CoreFoundation 对象并触发
 * SIGTRAP，导致进程内 N-API addon 把 Electron 主进程一起带崩。
 * @returns 无返回值。
 * @author zhenghq
 */
test('多入口 AX 读取不得重复释放 systemWide', () => {
  const source = readHelperSource()
  const readBody = source.slice(
    source.indexOf('static MacosAxReadResult ReadMacosAxSelection'),
    source.indexOf('#ifndef MACOS_AX_READER_NO_MAIN')
  )
  const systemWideCreations = readBody.match(/AXUIElementCreateSystemWide\(\)/gu) ?? []
  const systemWideReleases = readBody.match(/CFRelease\(systemWide\)/gu) ?? []
  const mouseReadAt = readBody.lastIndexOf('CopyElementAtMousePosition')
  const systemWideReleaseAt = readBody.lastIndexOf('CFRelease(systemWide)')

  assert.equal(systemWideCreations.length, 1, '共享读取函数应只创建一次 systemWide')
  assert.equal(systemWideReleases.length, 1, '共享读取函数应只在一个出口释放 systemWide')
  assert.ok(
    mouseReadAt >= 0 && systemWideReleaseAt > mouseReadAt,
    '统一释放应位于鼠标位置入口之后，确保所有入口都已尝试'
  )
})

/**
 * 校验统一出口不会把已命中的读取结果覆盖成失败诊断。
 *
 * 尾部失败汇总只能在所有入口均未命中时执行；否则窗口入口成功后仍会被
 * 写成 windowLocate=failed，系统焦点或鼠标入口成功后也会丢失 fallback 语义。
 * @returns 无返回值。
 * @author zhenghq
 */
test('多入口 AX 读取成功时不得被尾部失败汇总覆盖', () => {
  const source = readHelperSource()
  const readBody = source.slice(
    source.indexOf('static MacosAxReadResult ReadMacosAxSelection'),
    source.indexOf('#ifndef MACOS_AX_READER_NO_MAIN')
  )
  const terminalBody = readBody.slice(readBody.indexOf('CFRelease(systemWide)'))
  const failureSummaryAt = terminalBody.indexOf('if (!completed)')
  const returnAt = terminalBody.indexOf('return result;')
  assert.ok(
    failureSummaryAt >= 0 && returnAt > failureSummaryAt,
    '应在返回前设置受 completed 保护的失败汇总块'
  )
  const failureSummary = terminalBody.slice(failureSummaryAt, returnAt)
  const beforeFailureSummary = terminalBody.slice(0, failureSummaryAt)

  assert.match(
    failureSummary,
    /if \(apiDisabled\)[\s\S]*?result\.reason = @"api-disabled"/u,
    '未命中时应保留 api-disabled 原因'
  )
  assert.match(failureSummary, /if \(options\.hasWindowArgument && !result\.windowMatched\)/u,
    '仅在窗口未命中时才汇总窗口定位失败')
  assert.match(failureSummary, /result\.windowLocate = @"failed"/u,
    '未命中时应输出 failed 诊断')
  assert.doesNotMatch(beforeFailureSummary, /result\.(?:reason|windowLocate)\s*=/u,
    '失败汇总不得位于 completed 保护之外，避免覆盖 exact 或 fallback')
})

/**
 * 校验 AX 读取的核心 API 调用失败分支都释放系统级 AX 元素。
 *
 * `ReadMacosAxSelection` 只在函数尾部统一释放 `systemWide`，因此中途任何
 * `return result` 都会泄漏对象。更危险的是 addon 在 libuv 线程池反复执行，
 * 泄漏最终可能在 CoreFoundation 内部触发进程级 SIGTRAP。
 * @returns 无返回值。
 * @author zhenghq
 */
test('AX 读取核心路径不得在释放 systemWide 前提前返回', () => {
  const source = readHelperSource()
  const readBody = source.slice(
    source.indexOf('static MacosAxReadResult ReadMacosAxSelection'),
    source.indexOf('#ifndef MACOS_AX_READER_NO_MAIN')
  )
  const systemWideCreationAt = readBody.indexOf('AXUIElementCreateSystemWide()')
  const systemWideReleaseAt = readBody.lastIndexOf('CFRelease(systemWide)')
  assert.ok(systemWideCreationAt >= 0 && systemWideReleaseAt > systemWideCreationAt,
    '应存在 systemWide 创建与统一释放出口')
  const beforeRelease = readBody.slice(systemWideCreationAt, systemWideReleaseAt)
  const earlyReturnCount = (beforeRelease.match(/return result;/gu) ?? []).length

  assert.equal(earlyReturnCount, 1,
    '仅允许创建 systemWide 失败时提前返回，其余路径必须走到统一释放出口')
  assert.match(
    beforeRelease,
    /if \(!systemWide\) return result;/u,
    '唯一提前返回必须是 systemWide 创建失败分支'
  )
})

/**
 * 校验窗口级命中后不会覆盖已记录的焦点诊断。
 *
 * `CopySelectedTextFromWindow` 会把 focusStatus 设为 ready 或 target-mismatch；
 * 外层若在窗口入口后无条件写回 unknown，就会丢失可观测的焦点阶段，
 * 使 Safari/Chrome 的取词排障再次退化为只有 windowLocate 信息。
 * @returns 无返回值。
 * @author zhenghq
 */
test('窗口级读取后不得用 unknown 覆盖已记录的焦点状态', () => {
  const source = readHelperSource()
  const readBody = source.slice(
    source.indexOf('static MacosAxReadResult ReadMacosAxSelection'),
    source.indexOf('#ifndef MACOS_AX_READER_NO_MAIN')
  )
  const windowBlockStart = readBody.indexOf('if (options.hasWindowArgument)')
  const windowBlockEnd = readBody.indexOf('// 第一级与第二级', windowBlockStart)
  const windowBlock = readBody.slice(windowBlockStart, windowBlockEnd)

  assert.match(windowBlock, /result\.focusStatus = focusStatus;/u,
    '窗口入口必须保存读取阶段返回的焦点状态')
  assert.match(
    windowBlock,
    /if \(!result\.focusStatus\) \{\s*result\.focusStatus = @"unknown";\s*\}/u,
    '仅在窗口入口未返回焦点状态时才允许写入 unknown'
  )
  assert.doesNotMatch(
    windowBlock,
    /(?<!if \(!result\.focusStatus\) \{\s*)result\.focusStatus = @"unknown";/u,
    '不得在窗口入口后无条件把 ready 或 target-mismatch 覆盖为 unknown'
  )
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
 * 校验 Node 侧把入口记录的窗口边界与标题指纹传给 helper，供编号缺失时二级定位。
 * @returns 无返回值。
 * @author zhenghq
 */
test('capture.ts macOS helper 调用应可选传入 bounds 与标题指纹', () => {
  const source = readFileSync('src/main/capture.ts', 'utf8')
  const fnSource = extractFunction(source, 'async function readSelectionViaMacosHelper')

  assert.match(fnSource, /bounds/u, 'helper 调用参数应包含可选窗口边界')
  assert.match(fnSource, /titleFingerprint/u, 'helper 调用参数应包含可选标题指纹')
  assert.match(fnSource, /JSON\.stringify\(bounds\)/u, '窗口边界应以 JSON 参数传入 helper')
  assert.match(fnSource, /windowNumber === undefined && bounds === undefined/u,
    '只有窗口编号和边界都缺失时才允许使用无参数旧调用')
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
  assert.match(source, /result\.windowLocate = @"exact"/u, '精确命中必须写入 exact 诊断')
  assert.match(source, /result\.windowLocate = @"fallback"/u, '应用级退化必须写入 fallback 诊断')
  assert.match(source, /result\.windowLocate = @"failed"/u, '定位失败必须写入 failed 诊断')
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
  assert.match(source, /result\.windowLocate = @"exact"/u, '精确命中时应写入 exact 诊断')
  assert.match(source, /result\.windowLocate = @"fallback"/u, '旧路径命中时应写入 fallback 诊断')
  assert.match(source, /result\.windowLocate = @"failed"/u, '定位失败时应写入 failed 诊断')
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

/**
 * 校验 AX helper 的复制动作模式只按 Command+C 菜单快捷键定位并执行 AXPress。
 * 不能按菜单标题匹配，否则中文、英文及自定义本地化都会导致复制兜底失效。
 * @returns 无返回值。
 * @author zhenghq
 */
test('AX helper 应通过菜单快捷键执行受控复制动作', () => {
  const source = readHelperSource()

  assert.match(source, /strcmp\(argv\[1\], "--copy"\)/u, 'helper 应提供 --copy 模式')
  assert.match(source, /kAXMenuBarAttribute/u, '复制动作必须从目标应用菜单栏查找')
  assert.match(source, /kAXChildrenAttribute/u, '复制动作应递归遍历菜单子项')
  assert.match(source, /kAXMenuItemCmdCharAttribute/u, '复制动作必须匹配菜单快捷键字符')
  assert.match(source, /kAXMenuItemCmdModifiersAttribute/u, '复制动作必须校验快捷键修饰键')
  assert.match(source, /kAXEnabledAttribute/u, '复制动作只能执行启用的菜单项')
  assert.match(source, /kAXPressAction/u, '复制动作必须使用 AXPress 执行菜单项')
  assert.match(source, /kAXMenuItemModifierShift/u, '复制动作必须排除 Shift 组合键')
  assert.match(source, /kAXMenuItemModifierOption/u, '复制动作必须排除 Option 组合键')
  assert.match(source, /kAXMenuItemModifierControl/u, '复制动作必须排除 Control 组合键')
  assert.match(source, /kAXMenuItemModifierNoCommand/u, '复制动作必须排除不含 Command 的组合键')
  assert.match(source, /PERFORMED/u, '执行成功应输出固定 PERFORMED 状态')
  assert.match(source, /UNAVAILABLE/u, '找不到唯一复制菜单项应输出固定 UNAVAILABLE 状态')
  assert.match(source, /kMaxMenuTraversalDepth|maxDepth/u, '菜单遍历必须有深度上限')
  assert.match(source, /kMaxMenuNodeCount|maxNodes/u, '菜单遍历必须有节点数量上限')
})

/**
 * 校验 AX 复制动作输出解析只接受固定状态，并忽略可能混入的敏感自由文本。
 * @returns 无返回值。
 * @author zhenghq
 */
test('AX 复制动作输出应只解析固定状态', () => {
  assert.equal(parseMacosAxCopyOutput('PERFORMED'), 'performed')
  assert.equal(parseMacosAxCopyOutput('UNAVAILABLE\n'), 'unavailable')
  assert.equal(parseMacosAxCopyOutput('PERMISSION'), 'permission')
  assert.equal(parseMacosAxCopyOutput('UNKNOWN'), 'unknown')
  assert.equal(parseMacosAxCopyOutput('PERFORMED\n敏感菜单标题'), 'performed')
  assert.equal(parseMacosAxCopyOutput(''), 'unknown')
})
