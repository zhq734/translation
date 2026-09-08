import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { resolveMacosAxReaderPath } from '../src/main/nativeReaderHost.ts'
import { parseNativeSelectionReadOutput } from '../src/shared/selectionBehavior.ts'

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
