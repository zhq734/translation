import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import {
  isWindows7Version,
  isWindows7CompatibilityRuntime
} from '../src/main/platformCompatibility.ts'
import { createTimeoutSignal } from '../src/main/abortCompatibility.ts'
import { normalizeAsarEntries } from '../scripts/win7-asar-paths.mjs'

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

test('Win7 兼容包必须仅使用 Tesseract OCR 且不加载 OCR 原生链路', () => {
  const source = read('src/main/index.ts')
  assert.match(source, /isWindows7CompatibilityRuntime/u)
  assert.match(source, /windows7\.ocrTesseractOnly/u)
  assert.match(source, /bundledLangPath: join\(process\.resourcesPath, 'tessdata'\)/u)
  assert.match(source, /workerPath: resolveTesseractWorkerPath\(process\.resourcesPath, app\.isPackaged\)/u)
  assert.match(
    source,
    /if \(isWindows7CompatibilityRuntime\(\)\) \{\s*const \[\{ OcrDispatcher \}, \{ TesseractOcrEngine, resolveTesseractLangPath, resolveTesseractWorkerPath \}\] = await Promise\.all\(\[\s*import\('\.\/ocrDispatcher'\),\s*import\('\.\/tesseractOcr'\)\s*\]\)/u
  )
  assert.doesNotMatch(source, /^import\s+\{[^}]*\}\s+from\s+'\.\/tesseractOcr'$/mu)
  assert.match(source, /function resolveOcrEnginePreference\(settings: Settings\): OcrEnginePreference/u)
  assert.match(source, /return isWindows7CompatibilityRuntime\(\) \? 'tesseract' : settings\.ocrEnginePreference/u)
  assert.doesNotMatch(source, /windows7\.ocrUnavailable/u)
  assert.doesNotMatch(source, /if \(isWindows7CompatibilityRuntime\(\)\) return\s*\n\s*latestSelectionGesture/u)
})

test('Win7 设置页应固定使用 Tesseract 并禁用无效的 OCR 引擎配置', () => {
  const types = read('src/shared/types.ts')
  const main = read('src/main/index.ts')
  const html = read('src/renderer/settings.html')
  const renderer = read('src/renderer/src/settings.ts')

  assert.match(types, /win7Compatibility\?: boolean/u)
  assert.match(
    main,
    /if \(isWindows7CompatibilityRuntime\(\)\) \{\s*return \{\s*win7Compatibility: true,\s*systemAvailable: false,[\s\S]*?\}\s*\}/u
  )
  assert.match(
    html,
    /id="ocr-win7-hint"[^>]*data-i18n="settings\.ocr\.win7FixedEngine"/u
  )
  assert.match(renderer, /const ocrWin7Hint = document\.getElementById\('ocr-win7-hint'\) as HTMLElement/u)
  assert.match(renderer, /const win7 = status\.win7Compatibility === true/u)
  assert.match(renderer, /ocrWin7Hint\.hidden = !win7/u)
  assert.match(renderer, /ocrEnginePreference\.disabled = win7/u)
  assert.match(renderer, /ocrTesseractEnabled\.disabled = win7/u)
  assert.match(renderer, /ocrEnginePreference\.value = 'tesseract'/u)
  assert.match(renderer, /ocrTesseractEnabled\.checked = true/u)
  assert.match(renderer, /const win7 = latestOcrStatus\?\.win7Compatibility === true/u)
  assert.match(renderer, /ocrEnginePreference: win7 \? 'tesseract' : ocrEnginePreference\.value as OcrEnginePreference/u)
  assert.match(renderer, /ocrTesseractEnabled: win7 \? true : ocrTesseractEnabled\.checked/u)
})

test('Win7 兼容包必须使用轻量 Release 检查并保留手动更新入口', () => {
  const source = read('src/main/index.ts')
  assert.match(source, /const \{ Win7UpdateDriver \} = await import\('\.\/win7UpdateDriver'\)/u)
  assert.match(source, /new Win7UpdateDriver\(\{/u)
  assert.match(source, /installMode: 'manual'/u)
  assert.match(source, /updateAction: 'open-release'/u)
  assert.match(source, /setTimeout\(\(\) => void checkForApplicationUpdates\(\), UPDATE_CHECK_DELAY_MS\)/u)
  assert.doesNotMatch(source, /windows7\.updateDisabled/u)
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

test('Win7 构建必须排除文档翻译现代依赖与字体资源', () => {
  const config = read('electron-builder-win7.yml')
  for (const dependency of [
    'pdfjs-dist',
    'canvas',
    'pdf-lib',
    '@pdf-lib/fontkit',
    'jszip',
    'mammoth',
    'fast-xml-parser',
    'path2d-polyfill'
  ]) {
    assert.match(
      config,
      new RegExp(`!node_modules/${dependency.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/\\*\\*/\\*`, 'u'),
      `Win7 配置必须显式排除 ${dependency}`
    )
  }
  assert.match(config, /!assets\/fonts\/\*\*\/\*/u)
})

test('Win7 产物校验必须把 Windows asar 路径统一为 POSIX 形式', () => {
  assert.deepEqual(
    normalizeAsarEntries([
      '\\out\\main\\updateManager-abc.js',
      '\\node_modules\\tesseract.js\\package.json'
    ]),
    [
      '/out/main/updateManager-abc.js',
      '/node_modules/tesseract.js/package.json'
    ]
  )
  assert.deepEqual(
    normalizeAsarEntries(['/out/main/index.js', 'out/main/ocrDispatcher-def.js']),
    ['/out/main/index.js', '/out/main/ocrDispatcher-def.js']
  )
})

test('Win7 翻译弹窗与选区按钮应关闭透明合成并使用不透明背景', () => {
  const popup = read('src/main/popup.ts')
  const selectionButton = read('src/main/selectionButton.ts')
  const main = read('src/main/index.ts')
  const styles = read('src/renderer/src/style.css')
  const selectionStyles = read('src/renderer/src/selection.css')
  const toastStyles = read('src/renderer/src/toast.css')

  assert.match(popup, /import \{ isWindows7CompatibilityRuntime \} from '\.\/platformCompatibility'/u)
  assert.match(
    popup,
    /const win7Compatibility = isWindows7CompatibilityRuntime\(\)[\s\S]*?transparent:\s*!win7Compatibility[\s\S]*?backgroundColor:\s*win7Compatibility \? '#f5f5f7' : '#00000000'/u
  )
  assert.match(selectionButton, /import \{ isWindows7CompatibilityRuntime \} from '\.\/platformCompatibility'/u)
  assert.match(
    selectionButton,
    /const win7Compatibility = isWindows7CompatibilityRuntime\(\)[\s\S]*?transparent:\s*!win7Compatibility[\s\S]*?backgroundColor:\s*win7Compatibility \? '#ffffff' : '#00000000'/u
  )
  assert.match(styles, /:root\[data-win7-compatibility='true'\] html,[\s\S]*?background:\s*var\(--panel-bg\)/u)
  assert.match(styles, /:root\[data-win7-compatibility='true'\] body\s*\{[^}]*padding:\s*0;/su)
  assert.match(
    styles,
    /:root\[data-win7-compatibility='true'\] #popup\s*\{[^}]*border-radius:\s*0;[^}]*clip-path:\s*none;[^}]*box-shadow:\s*none;/su
  )
  assert.match(
    selectionStyles,
    /:root\[data-win7-compatibility='true'\] #translate\s*\{[^}]*border-radius:\s*0;[^}]*background:\s*var\(--panel-bg\);/su
  )
  const toastWindowStart = main.indexOf('function getScreenshotToastWindow()')
  const toastWindowEnd = main.indexOf('/**', toastWindowStart + 1)
  const toastWindowSource = main.slice(toastWindowStart, toastWindowEnd)
  assert.match(
    toastWindowSource,
    /const win7Compatibility = isWindows7CompatibilityRuntime\(\)[\s\S]*?transparent:\s*!win7Compatibility[\s\S]*?backgroundColor:\s*win7Compatibility \? '#f5f5f7' : '#00000000'/u
  )
  assert.match(
    toastStyles,
    /:root\[data-win7-compatibility='true'\] \.screenshot-toast\s*\{[^}]*border-radius:\s*0;[^}]*background:\s*var\(--panel-bg\);/su
  )
})

test('Win7 运行时应在首屏主题应用前标记 Renderer 根节点', () => {
  const main = read('src/main/index.ts')
  const preload = read('src/preload/index.ts')
  const themeBootstrap = read('src/renderer/public/themeBootstrap.js')
  const renderer = read('src/renderer/src/popup.ts')
  const selectionRenderer = read('src/renderer/src/selection.ts')
  const toastRenderer = read('src/renderer/src/toast.ts')

  assert.match(main, /ipcMain\.on\('app:get-win7-compatibility'/u)
  assert.match(main, /event\.returnValue = isWindows7CompatibilityRuntime\(\)/u)
  assert.match(preload, /getSelectionTranslatorWin7Compatibility/u)
  assert.match(preload, /ipcRenderer\.sendSync\('app:get-win7-compatibility'\)/u)
  assert.match(
    themeBootstrap,
    /getSelectionTranslatorWin7Compatibility\(\) === true[\s\S]*?setAttribute\('data-win7-compatibility', 'true'\)/u
  )
  assert.match(renderer, /applyWin7CompatibilityAttribute\(\)[\s\S]*?startThemeRuntime\(window\.api\)/u)
  assert.match(selectionRenderer, /applyWin7CompatibilityAttribute\(\)[\s\S]*?startThemeRuntime\(window\.api\)/u)
  assert.match(toastRenderer, /applyWin7CompatibilityAttribute\(\)[\s\S]*?startThemeRuntime\(window\.api\)/u)
})

test('Win7 OCR 覆盖模式必须恢复透明背景，避免不透明图标底遮住快照', () => {
  const selectionRenderer = read('src/renderer/src/selection.ts')
  const selectionStyles = read('src/renderer/src/selection.css')

  assert.match(
    selectionRenderer,
    /ocrMode = true\s*\n\s*document\.documentElement\.setAttribute\('data-ocr-mode', 'true'\)/u
  )
  assert.match(
    selectionRenderer,
    /ocrMode = false\s*\n\s*document\.documentElement\.removeAttribute\('data-ocr-mode'\)/u
  )
  assert.match(
    selectionStyles,
    /:root\[data-win7-compatibility='true'\]\[data-ocr-mode='true'\],[\s\S]*?background:\s*transparent;/u
  )
})

test('Win7 打包配置保留 Tesseract WASM 运行时并排除原生 OCR 与 electron-updater', () => {
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
  assert.match(config, /!out\/main\/ocrModelAssets-\*\.js/u)
  assert.match(config, /!out\/main\/paddleOcr-\*\.js/u)
  assert.match(config, /!out\/main\/systemOcr-\*\.js/u)
  assert.doesNotMatch(config, /!out\/main\/updateManager-\*\.js/u)
  assert.doesNotMatch(config, /!node_modules\/tesseract\.js\/\*\*\/\*/u)
  assert.doesNotMatch(config, /!node_modules\/tesseract\.js-core\/\*\*\/\*/u)
  assert.doesNotMatch(config, /!out\/main\/ocrDispatcher-\*\.js/u)
  assert.doesNotMatch(config, /!out\/main\/tesseractOcr-\*\.js/u)
  assert.match(config, /node_modules\/tesseract\.js\/\*\*\/\*/u)
  assert.match(config, /node_modules\/tesseract\.js-core\/\*\*\/\*/u)
  assert.match(config, /node_modules\/node-fetch\/\*\*\/\*/u)
  assert.match(config, /node_modules\/whatwg-url\/\*\*\/\*/u)
  const asarUnpackBlock = config.split('asarUnpack:')[1]?.split('afterPack:')[0] ?? ''
  for (const dependency of [
    'node-fetch',
    'whatwg-url',
    'tr46',
    'webidl-conversions',
    'wasm-feature-detect',
    'is-url',
    'bmp-js',
    'zlibjs',
    'regenerator-runtime',
    'idb-keyval'
  ]) {
    assert.ok(
      asarUnpackBlock.includes(`node_modules/${dependency}/**/*`),
      `asarUnpack 必须解包 ${dependency}`
    )
  }
  assert.match(config, /asarUnpack:[\s\S]*node_modules\/tesseract\.js\/\*\*\/\*/u)
  assert.match(config, /asarUnpack:[\s\S]*node_modules\/tesseract\.js-core\/\*\*\/\*/u)
  assert.match(config, /from: build\/win7-tessdata[\s\S]*to: tessdata/u)
})

test('Win7 构建必须下载并校验内置中英繁 OCR 模型', () => {
  const script = read('scripts/build-win7.mjs')
  assert.match(script, /chi_sim\.traineddata\.gz/u)
  assert.match(script, /eng\.traineddata\.gz/u)
  assert.match(script, /chi_tra\.traineddata\.gz/u)
  assert.match(script, /b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c/u)
  assert.match(script, /45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91/u)
  assert.match(script, /11fe2610dab05d8a880d02f193ce70203f4c4bbe061b987d5529a2c038a22743/u)
  assert.match(script, /createHash\('sha256'\)/u)
  assert.match(script, /prepareWin7Tessdata/u)
  assert.match(script, /resources[\s\S]*tessdata/u)
})

test('Win7 构建必须提前拒绝非 Windows 主机并在失败时清理产物', () => {
  const script = read('scripts/build-win7.mjs')
  assert.match(script, /process\.platform !== 'win32'/u)
  assert.match(script, /Windows 安装包必须由 Windows CI 构建/u)
  assert.match(script, /catch\s*\(error\)[\s\S]*rmSync\(outputDirectory/u)
})

test('Win7 产物校验必须覆盖 x64 原生绑定、Tesseract 运行时与 helper 大小', () => {
  const script = read('scripts/build-win7.mjs')
  const afterPack = read('scripts/win7-after-pack.cjs')
  assert.match(script, /app\.asar\.unpacked/u)
  assert.match(script, /uiohook-napi\/prebuilds\/win32-x64\/uiohook-napi\.node/u)
  assert.match(script, /@koromix\/koffi-win32-x64\/win32_x64\/koffi\.node/u)
  assert.match(script, /updateManager-/u)
  assert.match(script, /updater-/u)
  assert.match(script, /electron-updater/u)
  assert.match(script, /builder-util-runtime/u)
  assert.match(script, /tesseract\.js\/src\/worker-script\/node\/index\.js/u)
  assert.match(script, /tesseract\.js-core\/package\.json/u)
  assert.match(script, /tesseract\.js-core\/tesseract-core-simd-lstm\.wasm/u)
  assert.match(script, /win7UpdateDriver-/u)
  assert.match(script, /ocrDispatcher-/u)
  assert.match(script, /tesseractOcr-/u)
  assert.match(afterPack, /requiredUnpackedDirectories/u)
  for (const dependency of [
    'tesseract.js',
    'tesseract.js-core',
    'node-fetch',
    'whatwg-url',
    'tr46',
    'webidl-conversions',
    'wasm-feature-detect',
    'is-url',
    'bmp-js',
    'zlibjs',
    'regenerator-runtime',
    'idb-keyval'
  ]) {
    assert.match(afterPack, new RegExp(`node_modules/${dependency.replaceAll('.', '\\.')}`, 'u'))
  }
  assert.doesNotMatch(afterPack, /ocrDispatcher-\[\^\/\]\+\\\.js/u)
  assert.doesNotMatch(afterPack, /tesseractOcr-\[\^\/\]\+\\\.js/u)
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
  assert.match(chinese, /Tesseract\.js/u)
  assert.match(chinese, /WebAssembly/u)
  assert.match(chinese, /不加载 `electron-updater`/u)
  assert.match(chinese, /手动下载/u)
  assert.match(chinese, /内置简体中文、繁体中文和英文/u)
  assert.match(chinese, /其他语言首次使用才可能需要联网下载/u)
  assert.match(chinese, /TESSERACT_LANG_PATH/u)
  assert.match(chinese, /本地绝对目录或 HTTP\(S\) 镜像/u)
  assert.match(chinese, /32 位/u)
  assert.match(english, /Windows 7 SP1 x64/u)
  assert.match(english, /Tesseract\.js/u)
  assert.match(english, /WebAssembly/u)
  assert.match(english, /does not load `electron-updater`/u)
  assert.match(english, /manual(?:ly)? download/iu)
  assert.match(english, /Simplified Chinese, Traditional Chinese, and English language models are bundled/iu)
  assert.match(english, /only other languages may need to download language data on first use/iu)
  assert.match(english, /TESSERACT_LANG_PATH/u)
  assert.match(english, /absolute local directory or an HTTP\(S\) mirror/iu)
  assert.match(english, /32-bit/u)
})
