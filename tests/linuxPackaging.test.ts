import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import test from 'node:test'

type PackageJson = {
  scripts?: Record<string, string>
  overrides?: Record<string, string>
  build?: {
    toolsets?: Record<string, string>
    linux?: { artifactName?: string; files?: string[] }
  }
}

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson
const packagingDoc = readFileSync('docs/ocr-packaging-verification.md', 'utf8')

/**
 * 校验 Linux 打包脚本使用 electron-builder 的 AppImage 目标生成 x64/arm64 安装包。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Linux 打包脚本应生成 x64 与 arm64 AppImage', () => {
  assert.equal(
    packageJson.scripts?.['dist:linux'],
    'npm run build && node scripts/prepare-linux-ocr-runtime.mjs && node scripts/prepare-linux-uiohook-runtime.mjs && electron-builder --linux AppImage --x64 --arm64 --publish never'
  )
})

/**
 * 校验 Linux 打包会预取并验证 x64/arm64 的 sharp 与 libvips 运行时，避免交叉打包
 * 把构建机的原生依赖带入 AppImage 后导致 PaddleOCR 初始化失败。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Linux 打包前应准备并校验双架构 sharp 运行时', () => {
  assert.equal(existsSync('scripts/prepare-linux-ocr-runtime.mjs'), true)
  assert.equal(packageJson.overrides?.sharp, '0.34.2')

  const prepareScript = readFileSync('scripts/prepare-linux-ocr-runtime.mjs', 'utf8')
  assert.match(prepareScript, /'x64', 'arm64'/u)
  assert.match(prepareScript, /sharp-linux-\$\{arch\}\.node/u)
  assert.match(prepareScript, /sharp-libvips-linux-\$\{arch\}/u)
  assert.match(prepareScript, /libvips-cpp\.so\.8\.16\.1/u)
  assert.match(packagingDoc, /Linux 双架构 sharp 运行时/u)
})

/**
 * 校验 Linux 交叉打包会预取 x64/arm64 的 N-API Canvas 平台包，避免目标架构缺少 Skia binding。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Linux 打包前应准备并校验双架构 N-API Canvas 运行时', () => {
  const prepareScript = readFileSync('scripts/prepare-linux-ocr-runtime.mjs', 'utf8')
  assert.match(prepareScript, /expectedCanvasVersion\s*=\s*'1\.1\.0'/u)
  assert.match(prepareScript, /@napi-rs\/canvas-linux-\$\{arch\}-gnu/u)
  assert.match(prepareScript, /skia\.linux-\$\{arch\}-gnu\.node/u)
})

/**
 * 校验 Linux AppImage 只携带 Linux Canvas 平台包，避免交叉打包把 Windows 与 macOS
 * 的 Skia binding 带入产物。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Linux 打包配置应排除非 Linux 的 N-API Canvas 平台包', () => {
  const files = packageJson.build?.linux?.files ?? []
  assert.ok(files.includes('node_modules/@napi-rs/**/*'), '@napi-rs 平台包应进入 Linux 安装包')
  for (const pattern of [
    '!node_modules/@napi-rs/canvas-win32-*/**/*',
    '!node_modules/@napi-rs/canvas-darwin-*/**/*',
    '!node_modules/@napi-rs/canvas-android-*/**/*',
    '!node_modules/@napi-rs/canvas-freebsd-*/**/*'
  ]) {
    assert.ok(files.includes(pattern), `Linux 打包应排除 ${pattern}`)
  }
  assert.ok(
    !files.some((pattern) => pattern.startsWith('!node_modules/@napi-rs/canvas-linux-')),
    '一次构建同时产出 x64/arm64，不能排除任一 Linux 架构包'
  )
})

/**
 * 校验 Linux AppImage 使用静态 runtime 工具集，避免依赖宿主机 libfuse2 与旧 AppImage runtime。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Linux AppImage 应使用静态 runtime 工具集', () => {
  assert.equal(packageJson.build?.toolsets?.appimage, '1.0.3')
})

/**
 * 校验 Linux 安装包名遵循 AppImageHub 规范，不包含多余的 Linux 字样。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Linux AppImage 文件名不应包含 Linux 字样', () => {
  const artifactName = packageJson.build?.linux?.artifactName ?? ''
  assert.equal(artifactName, 'SelectionTranslator-${version}-${arch}.${ext}')
  assert.doesNotMatch(artifactName, /linux/iu)
})

/**
 * 校验 Linux 打包前会用低 glibc 版本重新编译的 uiohook 预编译产物替换 npm 包内自带的
 * Ubuntu 22.04 产物，避免 AppImage 引用 glibc 2.34 而被判定为不兼容旧发行版。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Linux 打包前应准备低 glibc 版本的 uiohook 运行时', () => {
  assert.equal(existsSync('scripts/prepare-linux-uiohook-runtime.mjs'), true)
  assert.match(
    packageJson.scripts?.['dist:linux'] ?? '',
    /node scripts\/prepare-linux-uiohook-runtime\.mjs/u
  )

  const bindingFilenames = {
    x64: 'node.napi.node',
    arm64: 'node.napi.armv8.node'
  }
  for (const [arch, bindingFilename] of Object.entries(bindingFilenames)) {
    const bindingPath = `build/uiohook-prebuilds/linux-${arch}/${bindingFilename}`
    assert.equal(existsSync(bindingPath), true, `${bindingPath} 缺失`)
    assert.ok(statSync(bindingPath).size > 0, `${bindingPath} 为空文件`)
  }

  const prepareScript = readFileSync('scripts/prepare-linux-uiohook-runtime.mjs', 'utf8')
  // 需要剔除自带 glibc 2.34 且与目标架构无关的 loong64 产物。
  assert.match(prepareScript, /linux-loong64/u)
  // 需要在打包前实际校验产物引用的最高 glibc 版本。
  assert.match(prepareScript, /GLIBC_/u)
  assert.match(packagingDoc, /uiohook/u)
})

/**
 * 校验 uiohook 预编译产物使用 @electron/rebuild 能识别的 N-API 文件名。
 * 否则 electron-builder 会在 Linux 上触发 node-gyp 源码编译并因缺少 X11 头文件失败。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Linux uiohook 预编译产物应使用 Electron rebuild 可识别的 N-API 文件名', () => {
  const prepareScript = readFileSync('scripts/prepare-linux-uiohook-runtime.mjs', 'utf8')

  assert.match(prepareScript, /x64:\s*'node\.napi\.node'/u)
  assert.match(prepareScript, /arm64:\s*'node\.napi\.armv8\.node'/u)
  assert.doesNotMatch(
    prepareScript,
    /targetPath = join\(packagePrebuildDirectory\(arch\), 'uiohook-napi\.node'\)/u,
    '仅使用 uiohook-napi.node 会让 @electron/rebuild 误判为没有预编译产物并执行 node-gyp'
  )
})

/**
 * 校验低 glibc 的 uiohook 预编译产物不被 build 目录的忽略规则排除。
 * 这些产物需要随仓库分发，否则 CI 在 npm ci 后执行测试与 dist:linux 时会因文件缺失而失败。
 * @returns 无返回值。
 * @author zhenghq
 */
test('uiohook 预编译产物不应被 Git 忽略', () => {
  const gitignore = readFileSync('.gitignore', 'utf8')
  assert.match(gitignore, /^!build\/uiohook-prebuilds\/$/mu)
  assert.match(gitignore, /^!build\/uiohook-prebuilds\/\*\*$/mu)
})
