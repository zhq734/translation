import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import {
  createMacosAxAddonLoader,
  resolveMacosAxAddonPath,
  type MacosAxAddon
} from '../src/main/macosAxAddon.ts'

const ADDON_SOURCE_PATH = 'helpers/macos-ax-reader/addon.mm'
const BUILD_SCRIPT_PATH = 'scripts/build-macos-ax-reader.mjs'

/**
 * 读取文件内容，文件不存在时返回空串，便于断言输出缺失路径。
 * @param path 文件路径。
 * @returns 文件文本；不存在时返回空串。
 * @author zhenghq
 */
function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/**
 * 校验构建脚本同时生成 CLI helper 与主进程 N-API addon，并把 addon 打进资源目录。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS AX 构建应生成 N-API addon 并纳入打包资源', () => {
  const buildScript = readText(BUILD_SCRIPT_PATH)
  assert.ok(existsSync(ADDON_SOURCE_PATH), `缺少 N-API addon 源码: ${ADDON_SOURCE_PATH}`)
  assert.match(buildScript, /macos-ax-reader\.node/u, '构建脚本必须生成 .node addon')
  assert.match(buildScript, /node_api\.h/u, 'addon 必须使用 Node-API 头文件')
  assert.match(buildScript, /-bundle/u, 'macOS addon 应按 bundle 方式链接')
  assert.match(buildScript, /dynamic_lookup/u, 'addon 应动态解析 Node 运行时符号')

  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
  const macResources = packageJson.build.mac.extraResources as Array<{ from: string; to: string }>
  assert.ok(
    macResources.some((entry) => entry.from === 'build/macos-ax-reader.node' &&
      entry.to === 'macos-ax-reader.node'),
    'mac extraResources 必须包含 macos-ax-reader.node'
  )
})

/**
 * 校验 addon 复用 CLI helper 的 AX 核心实现，并通过异步 N-API 暴露三类操作。
 * @returns 无返回值。
 * @author zhenghq
 */
test('N-API addon 应复用 AX 核心并提供异步读取、复制与增强接口', () => {
  const mainSource = readText('helpers/macos-ax-reader/main.m')
  const addonSource = readText(ADDON_SOURCE_PATH)

  assert.match(mainSource, /#ifndef MACOS_AX_READER_NO_MAIN/u,
    'CLI 入口必须可在 addon 编译时排除')
  assert.match(addonSource, /#define MACOS_AX_READER_NO_MAIN/u,
    'addon 必须复用 main.m 中的 AX 核心实现')
  assert.match(addonSource, /CopySelectedTextFromWindow/u, 'addon 必须复用窗口级 AX 读取')
  assert.match(addonSource, /CopySelectedTextFromAncestry/u, 'addon 必须复用祖先链 AX 读取')
  assert.match(addonSource, /napi_create_async_work/u, 'AX 调用必须通过异步任务执行')
  assert.match(addonSource, /NAPI_MODULE_INIT/u, 'addon 必须使用 Node-API 模块入口')
  assert.match(addonSource, /readSelection/u, 'addon 必须暴露 readSelection')
  assert.match(addonSource, /performCopy/u, 'addon 必须暴露 performCopy')
  assert.match(addonSource, /enhanceAccessibility/u, 'addon 必须暴露 enhanceAccessibility')
})

/**
 * 校验窗口标题指纹只在 AX 工作线程的 autoreleasepool 内转换为 Objective-C 字符串，
 * 避免把主线程创建的 NSString 指针跨线程留到异步任务执行阶段。
 * @returns 无返回值。
 * @author zhenghq
 */
test('N-API addon 的标题指纹应保存为 UTF-8 并在线程池内创建 NSString', () => {
  const addonSource = readText(ADDON_SOURCE_PATH)
  const workStart = addonSource.indexOf('struct MacosAxAddonWork')
  const workEnd = addonSource.indexOf('\n};', workStart)
  const workSource = addonSource.slice(workStart, workEnd)
  const parseStart = addonSource.indexOf('static bool ParseReadSelectionArguments(')
  const parseEnd = addonSource.indexOf('static bool ParsePidArgument(', parseStart)
  const parseSource = addonSource.slice(parseStart, parseEnd)
  const executeStart = addonSource.indexOf('static void ExecuteMacosAxAddonWork(')
  const executeEnd = addonSource.indexOf('static napi_value CreateReadSelectionResult(', executeStart)
  const executeSource = addonSource.slice(executeStart, executeEnd)

  assert.match(workSource, /std::string titleFingerprintUtf8/u,
    '工作项必须保存可跨线程的标题指纹 UTF-8 副本')
  assert.match(parseSource, /work->titleFingerprintUtf8\s*=\s*ReadOptionalString\(/u,
    '参数解析阶段只能保存 UTF-8 字符串')
  assert.doesNotMatch(parseSource, /NSString stringWithUTF8String/u,
    '参数解析阶段不得创建会跨线程失效的 NSString')
  assert.match(
    executeSource,
    /work->options\.titleFingerprint\s*=\s*\[NSString stringWithUTF8String:work->titleFingerprintUtf8\.c_str\(\)\]/u,
    '必须在线程池的 autoreleasepool 内创建 NSString'
  )
  assert.ok(
    executeSource.indexOf('work->options.titleFingerprint') <
      executeSource.indexOf('ReadMacosAxSelection(work->options)'),
    'NSString 必须在读取前于同一工作线程创建'
  )
})

/**
 * 校验 addon 路径在打包环境优先 resourcesPath，开发环境回退 build 目录。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS AX addon 路径应优先解析打包资源并回退开发构建目录', () => {
  assert.equal(
    resolveMacosAxAddonPath({
      resourcesPath: '/Applications/App.app/Contents/Resources',
      cwd: '/repo',
      fileExists: (candidate) =>
        candidate === '/Applications/App.app/Contents/Resources/macos-ax-reader.node'
    }),
    '/Applications/App.app/Contents/Resources/macos-ax-reader.node'
  )
  assert.equal(
    resolveMacosAxAddonPath({
      cwd: '/repo',
      fileExists: (candidate) => candidate === '/repo/build/macos-ax-reader.node'
    }),
    '/repo/build/macos-ax-reader.node'
  )
  assert.equal(
    resolveMacosAxAddonPath({ cwd: '/repo', fileExists: () => false }),
    null
  )
})

/**
 * 校验 addon 加载失败时返回 null，让取词管线安全回退旧 helper。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS AX addon 加载失败时应返回 null', () => {
  const loader = createMacosAxAddonLoader({
    platform: 'darwin',
    resourcesPath: '/res',
    cwd: '/repo',
    fileExists: () => true,
    requireModule: () => {
      throw new Error('invalid native module')
    }
  })
  assert.equal(loader.load(), null)
})

/**
 * 校验加载器只接受完整实现三类方法的 addon，并复用同一实例。
 * @returns 无返回值。
 * @author zhenghq
 */
test('macOS AX addon 加载器应缓存已加载实例', () => {
  let requireCount = 0
  const addon: MacosAxAddon = {
    readSelection: async () => ({ status: 'empty', text: '' }),
    performCopy: async () => 'unavailable',
    enhanceAccessibility: async () => ({ accepted: false, mode: 'none' })
  }
  const loader = createMacosAxAddonLoader({
    platform: 'darwin',
    resourcesPath: '/res',
    cwd: '/repo',
    fileExists: () => true,
    requireModule: () => {
      requireCount += 1
      return addon
    }
  })

  assert.equal(loader.load(), addon)
  assert.equal(loader.load(), addon)
  assert.equal(requireCount, 1)
})

/**
 * 校验主进程取词优先调用进程内 addon，旧 helper 仅作为兼容降级。
 * @returns 无返回值。
 * @author zhenghq
 */
test('capture 的 macOS 读取、复制与增强应优先使用进程内 addon', () => {
  const source = readText('src/main/capture.ts')
  const readStart = source.indexOf('async function readSelectionViaMacosHelper')
  const readEnd = source.indexOf('async function readSelectionViaWindowsHelper', readStart)
  const readSource = source.slice(readStart, readEnd)
  const copyStart = source.indexOf('async function performMacosAxCopy(')
  const copyEnd = source.indexOf('/**\n * 通过模拟复制快捷键', copyStart)
  const copySource = source.slice(copyStart, copyEnd)
  const enhanceStart = source.indexOf('async function requestChromiumEnhancedAx(')
  const enhanceEnd = source.indexOf('/**\n * 为已记录为源窗口', enhanceStart)
  const enhanceSource = source.slice(enhanceStart, enhanceEnd)

  assert.match(readSource, /readSelectionViaMacosAxAddon/u, '读取必须优先调用 addon')
  assert.ok(readSource.indexOf('readSelectionViaMacosAxAddon') <
    readSource.indexOf('resolveMacosAxReaderPath'), 'addon 必须早于 helper 路径解析')
  assert.match(copySource, /performMacosAxCopyViaAddon/u, '菜单复制必须优先调用 addon')
  assert.ok(copySource.indexOf('performMacosAxCopyViaAddon') <
    copySource.indexOf('resolveMacosAxReaderPath'), 'addon 必须早于 helper 路径解析')
  assert.match(enhanceSource, /performMacosAxEnhancementViaAddon/u, 'AX 增强必须优先调用 addon')
  assert.ok(enhanceSource.indexOf('performMacosAxEnhancementViaAddon') <
    enhanceSource.indexOf('resolveMacosAxReaderPath'), 'addon 必须早于 helper 路径解析')
})

/**
 * 校验 addon 已启动后的失败不会被当成加载失败再次回退 CLI helper，
 * 防止超时或异常后重复执行 AX 读取与 AXPress。
 * @returns 无返回值。
 * @author zhenghq
 */
test('addon 调用失败后不得回退 CLI helper', () => {
  const source = readText('src/main/capture.ts')
  const readStart = source.indexOf('async function readSelectionViaMacosHelper')
  const readEnd = source.indexOf('async function readSelectionViaWindowsHelper', readStart)
  const readSource = source.slice(readStart, readEnd)
  const copyStart = source.indexOf('async function performMacosAxCopy(')
  const copyEnd = source.indexOf('/**\n * 通过模拟复制快捷键', copyStart)
  const copySource = source.slice(copyStart, copyEnd)
  const enhanceStart = source.indexOf('async function requestChromiumEnhancedAx(')
  const enhanceEnd = source.indexOf('/**\n * 为已记录为源窗口', enhanceStart)
  const enhanceSource = source.slice(enhanceStart, enhanceEnd)

  assert.match(readSource, /if \(addonOutcome\.state === 'failed'\) return null/u,
    '读取失败必须立即返回，不得继续解析 helper 路径')
  assert.match(copySource, /if \(addonOutcome\.state === 'failed'\)[\s\S]*?return 'unknown'/u,
    '复制失败必须返回 unknown，不得继续解析 helper 路径')
  assert.match(enhanceSource, /if \(addonOutcome\.state === 'failed'\)[\s\S]*?return false/u,
    '增强失败必须返回 false，不得继续解析 helper 路径')
  assert.ok(readSource.indexOf("addonOutcome.state === 'failed'") <
    readSource.indexOf('resolveMacosAxReaderPath'), '读取失败分支必须早于 helper 路径解析')
  assert.ok(copySource.indexOf("addonOutcome.state === 'failed'") <
    copySource.indexOf('resolveMacosAxReaderPath'), '复制失败分支必须早于 helper 路径解析')
  assert.ok(enhanceSource.indexOf("addonOutcome.state === 'failed'") <
    enhanceSource.indexOf('resolveMacosAxReaderPath'), '增强失败分支必须早于 helper 路径解析')
})
