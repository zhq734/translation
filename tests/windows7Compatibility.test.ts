import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import {
  isWindows7Version,
  isWindows7CompatibilityRuntime
} from '../src/main/platformCompatibility.ts'
import { createTimeoutSignal } from '../src/main/abortCompatibility.ts'

/**
 * 读取项目内文本文件。
 * @param path 相对项目根目录的路径。
 * @returns 文件文本。
 * @author zhenghq
 */
function read(path: string): string {
  return readFileSync(path, 'utf8')
}

/**
 * 解析 package.json 为可检查的结构。
 * @returns 打包脚本与构建配置。
 * @author zhenghq
 */
type PackageManifest = {
  scripts?: Record<string, string>
  devDependencies?: Record<string, string>
  dependencies?: Record<string, string>
  build?: Record<string, unknown>
}

function packageJson(): PackageManifest {
  return JSON.parse(read('package.json')) as PackageManifest
}

test('Windows 7 版本识别只接受 win32 的 6.1 主次版本', () => {
  assert.equal(isWindows7Version('win32', '6.1.7601'), true)
  assert.equal(isWindows7Version('win32', '6.2.9200'), false)
  assert.equal(isWindows7Version('win32', '10.0.19045'), false)
  assert.equal(isWindows7Version('darwin', '6.1.7601'), false)
})

test('Windows 7 兼容运行时可由构建标记或系统版本识别', () => {
  assert.equal(isWindows7CompatibilityRuntime({ WIN7_BUILD: '1' }, 'darwin', '14.0'), true)
  assert.equal(isWindows7CompatibilityRuntime({}, 'win32', '6.1.7601'), true)
  assert.equal(isWindows7CompatibilityRuntime({}, 'win32', '10.0.19045'), false)
})

test('超时信号兼容层在父信号中止时同步中止并可清理', () => {
  const parent = new AbortController()
  const timeout = createTimeoutSignal(10_000, parent.signal)
  assert.equal(timeout.signal.aborted, false)
  parent.abort()
  assert.equal(timeout.signal.aborted, true)
  timeout.dispose()
  assert.equal(timeout.signal.aborted, false)
})

test('网络模块必须为 Electron 22 提供 session.fetch 回退分支', () => {
  const source = read('src/main/network.ts')
  assert.match(source, /typeof session\.fetch === 'function'/u)
  assert.match(source, /createSessionFetch|sessionNetFetch/u)
  assert.match(source, /useSessionCookies:\s*true/u)
})

test('网页阅读器必须使用 Electron 22 与 33 都支持的 BrowserView', () => {
  const source = read('src/main/webReaderWindow.ts')
  assert.match(source, /BrowserView/u)
  assert.doesNotMatch(source, /WebContentsView/u)
  assert.match(source, /window\.setBrowserView\(view\)/u)
  assert.match(source, /webContents\.canGoBack\(\)/u)
  assert.match(source, /webContents\.canGoForward\(\)/u)
})

test('Win7 兼容包必须禁用 OCR 且不加载 OCR 原生链路', () => {
  const source = read('src/main/index.ts')
  assert.match(source, /isWindows7CompatibilityRuntime/u)
  assert.match(source, /windows7\.ocrUnavailable/u)
  assert.match(source, /if \(isWindows7CompatibilityRuntime\(\)\) return/u)
})

test('Win7 兼容包必须禁用自动更新但保留 Release 页面入口', () => {
  const source = read('src/main/index.ts')
  assert.match(source, /windows7\.updateDisabled/u)
  assert.match(source, /if \(!isWindows7CompatibilityRuntime\(\)\)\s*\{\s*setTimeout\(\(\) => void checkForApplicationUpdates/u)
  assert.match(source, /openApplicationReleasePage/u)
})

test('Windows 现代包脚本保持不变并新增 Win7 构建脚本', () => {
  const json = packageJson()
  assert.equal(
    json.scripts?.['dist:win'],
    'npm run build && node scripts/prepare-windows-ocr-runtime.mjs && electron-builder --win nsis --x64 --arm64 --publish never'
  )
  assert.equal(json.scripts?.['dist:win:win7'], 'node scripts/build-win7.mjs')
})

test('Win7 构建配置固定 Electron 22、仅 x64 且不生成更新清单', () => {
  assert.equal(existsSync('electron-builder-win7.yml'), true)
  const config = read('electron-builder-win7.yml')
  assert.match(config, /electronVersion:\s*22\.3\.27/u)
  assert.match(config, /arch:\s*\n\s*- x64/u)
  assert.doesNotMatch(config, /arch:\s*\n\s*- arm64/u)
  assert.match(config, /output:\s*dist-win7/u)
  assert.match(config, /^publish:\s*null$/mu)
  assert.match(config, /differentialPackage:\s*false/u)
  const script = read('scripts/build-win7.mjs')
  assert.match(script, /WIN7_BUILD/u)
  assert.match(script, /latest\*\.yml|latest.*\.yml/u)
  assert.match(script, /app-update\.yml/u)
  assert.match(script, /\.blockmap/u)
  assert.match(script, /windows-uia-reader\.exe/u)
  assert.match(script, /build-windows-uia-reader/u)
  assert.match(script, /dist-win7/u)
  assert.match(config, /files:[\s\S]*out\/\*\*\/\*[\s\S]*uiohook-napi/u)
  assert.match(config, /asarUnpack:[\s\S]*uiohook-napi/u)
})

test('Win7 打包配置只保留 x64 运行时并排除更新与 OCR 代码块', () => {
  const config = read('electron-builder-win7.yml')

  assert.match(config, /node_modules\/@koromix\/koffi-win32-x64\/\*\*\/\*/u)
  assert.match(config, /!node_modules\/@koromix\/koffi-win32-arm64\/\*\*\/\*/u)
  assert.match(config, /!node_modules\/@koromix\/koffi-win32-ia32\/\*\*\/\*/u)
  assert.match(config, /!node_modules\/@koromix\/koffi-darwin-\*\/\*\*\/\*/u)
  assert.match(config, /!node_modules\/@koromix\/koffi-linux-\*\/\*\*\/\*/u)
  assert.match(config, /!node_modules\/uiohook-napi\/prebuilds\/win32-arm64\/\*\*\/\*/u)
  assert.match(config, /!node_modules\/uiohook-napi\/prebuilds\/darwin-\*\/\*\*\/\*/u)
  assert.match(config, /!node_modules\/uiohook-napi\/prebuilds\/linux-\*\/\*\*\/\*/u)
  assert.match(config, /!node_modules\/electron-updater\/\*\*\/\*/u)
  assert.match(config, /!node_modules\/builder-util-runtime\/\*\*\/\*/u)
  assert.match(config, /!out\/main\/updater-\*\.js/u)
  assert.match(config, /!out\/main\/ocrDispatcher-\*\.js/u)
  assert.match(config, /!out\/main\/ocrModelAssets-\*\.js/u)
  assert.match(config, /!out\/main\/paddleOcr-\*\.js/u)
  assert.match(config, /!out\/main\/systemOcr-\*\.js/u)
  assert.match(config, /!out\/main\/tesseractOcr-\*\.js/u)
  assert.doesNotMatch(config, /!out\/main\/updateManager-\*\.js/u)
})

test('Win7 构建必须提前拒绝非 Windows 主机并在失败时清理产物', () => {
  const script = read('scripts/build-win7.mjs')
  assert.match(script, /process\.platform !== 'win32'/u)
  assert.match(script, /Windows 安装包必须由 Windows CI 构建/u)
  assert.match(script, /catch\s*\(error\)[\s\S]*rmSync\(outputDirectory/u)
})

test('Win7 产物校验必须覆盖 x64 原生绑定、更新文件与 helper 大小', () => {
  const script = read('scripts/build-win7.mjs')
  assert.match(script, /app\.asar\.unpacked/u)
  assert.match(script, /uiohook-napi\/prebuilds\/win32-x64\/uiohook-napi\.node/u)
  assert.match(script, /@koromix\/koffi-win32-x64\/win32_x64\/koffi\.node/u)
  assert.match(script, /updateManager-/u)
  assert.match(script, /updater-/u)
  assert.match(script, /electron-updater/u)
  assert.match(script, /builder-util-runtime/u)
  assert.match(script, /statSync\(helperPath\)\.size/u)
})

test('Windows UIA helper 必须兼容 .NET Framework 4.x 的 C# 5 编译器', () => {
  const source = read('helpers/windows-uia-reader/Program.cs')
  assert.doesNotMatch(source, /\b(?:string|ReadRequest|AutomationElement)\?/u)
  assert.doesNotMatch(source, /\bis\s+(?:int|long)\s+[A-Za-z_]/u)
  assert.doesNotMatch(
    source,
    /SendMessageTimeout\([\s\S]*?SMTO_BLOCK\s*,\s*\d+\s*,\s*out\s+IntPtr\s+[A-Za-z_]\w*\s*\);/u
  )
  assert.match(source, /uint timeout, out IntPtr result\);/u)
  assert.match(source, /IntPtr messageResult;\s*\n\s*SendMessageTimeout\([\s\S]*?out messageResult\);/u)
  assert.doesNotMatch(source, /return\s*\(\s*"present"\s*,\s*[^,]+\s*,\s*null\s*\)/u)
  assert.match(source, /using System\.Windows\.Forms;/u)
  assert.match(source, /\[STAThread\]/u)
  assert.match(source, /class ReadSelectionResult/u)
})

test('Windows 打包前必须编译并校验 UIA helper', () => {
  assert.equal(existsSync('scripts/build-windows-uia-reader.mjs'), true)
  const buildScript = read('scripts/build-windows-uia-reader.mjs')
  assert.match(buildScript, /Framework64/u)
  assert.match(buildScript, /['"]Framework['"]/u)
  assert.match(buildScript, /Reference Assemblies/u)
  assert.match(buildScript, /GAC_MSIL/u)
  assert.match(buildScript, /GAC_32/u)
  assert.match(buildScript, /GAC_64/u)
  assert.match(buildScript, /v4\.0\.30319/u)
  assert.match(buildScript, /csc\.exe/u)
  assert.match(buildScript, /UIAutomationClient/u)
  assert.match(buildScript, /UIAutomationTypes/u)
  assert.match(buildScript, /System\.Windows\.Forms/u)
  assert.match(buildScript, /target:exe/u)
  assert.match(buildScript, /codepage:65001/u)
  assert.match(buildScript, /SHA256/u)
  assert.match(buildScript, /全部搜索路径/u)
  assert.match(buildScript, /Windows 安装包必须由 Windows CI 构建/u)

  assert.match(read('scripts/prepare-windows-ocr-runtime.mjs'), /build-windows-uia-reader/u)
})

test('CI 与一键安装脚本必须提供 Win7 x64 资产', () => {
  const workflow = read('.github/workflows/package.yml')
  assert.match(workflow, /packages-windows7/u)
  assert.match(workflow, /dist:win:win7/u)
  assert.match(workflow, /dist-win7/u)
  const installer = read('scripts/install.ps1')
  assert.match(installer, /6\.1/u)
  assert.match(installer, /Setup-win7-x64/u)
})

test('中英文 README 必须说明 Win7 限制', () => {
  const chinese = read('README.zh-CN.md')
  const english = read('README.md')
  assert.match(chinese, /Windows 7 SP1 x64/u)
  assert.match(chinese, /OCR/u)
  assert.match(chinese, /32 位/u)
  assert.match(english, /Windows 7 SP1 x64/u)
  assert.match(english, /OCR/u)
  assert.match(english, /32-bit/u)
})
