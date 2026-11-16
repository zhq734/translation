import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const expectedSharpVersion = '0.34.2'
const expectedCanvasVersion = '1.1.0'

/**
 * 通过当前 Node 启动 npm CLI，兼容 Windows 上直接 spawn npm.cmd 返回 EINVAL 的情况。
 * @param {string[]} arguments_ npm 命令参数。
 * @param {string} cwd 子进程工作目录。
 * @returns {import('node:child_process').SpawnSyncReturns<string>} npm 执行结果。
 * @author zhenghq
 */
function runNpm(arguments_, cwd) {
  const npmExecPath = process.env.npm_execpath
  return npmExecPath
    ? spawnSync(process.execPath, [npmExecPath, ...arguments_], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
        env: process.env
      })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', arguments_, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
        env: process.env,
        shell: process.platform === 'win32'
      })
}

/**
 * 从 npm pack 的标准输出中读取压缩包文件名。
 * @param {import('node:child_process').SpawnSyncReturns<string>} result npm pack 执行结果。
 * @param {string} packageName 被下载的包名。
 * @returns {string} 压缩包文件名。
 * @author zhenghq
 */
function readPackedTarballName(result, packageName) {
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`下载 ${packageName} 失败，退出码 ${result.status}`)
  }
  const tarballName = String(result.stdout ?? '').trim().split(/\r?\n/u).filter(Boolean).at(-1)
  if (!tarballName) throw new Error(`npm pack 未返回 ${packageName} 的压缩包名称`)
  return tarballName
}

/**
 * 将 npm 压缩包解压到指定临时目录。
 * @param {string} tarballPath 压缩包绝对路径。
 * @param {string} extractRoot 解压目标目录。
 * @param {string} packageName 被解压的包名。
 * @returns {string} 包根目录绝对路径。
 * @author zhenghq
 */
function extractPackedPackage(tarballPath, extractRoot, packageName) {
  mkdirSync(extractRoot, { recursive: true })
  const result = spawnSync('tar', ['-xzf', tarballPath, '-C', extractRoot], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`解包 ${packageName} 失败，退出码 ${result.status}`)
  }
  const sourceRoot = join(extractRoot, 'package')
  if (!existsSync(sourceRoot)) throw new Error(`下载的 ${packageName} 缺少 package 目录`)
  return sourceRoot
}

/**
 * 校验 Koffi 平台包的名称、版本、加载入口及目标架构非空原生库。
 * @param {string} packageRoot 平台包目录。
 * @param {string} packageName 预期平台包名。
 * @param {string} version 与主包匹配的精确版本。
 * @param {'x64' | 'arm64'} arch Windows 目标架构。
 * @returns {boolean} 是否可直接复用该平台包。
 * @author zhenghq
 */
function isWindowsKoffiReady(packageRoot, packageName, version, arch) {
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    return manifest.name === packageName && manifest.version === version &&
      ['index.js', join(`win32_${arch}`, 'koffi.node')].every((file) => {
        const stat = statSync(join(packageRoot, file))
        return stat.isFile() && stat.size > 0
      })
  } catch {
    return false
  }
}

/**
 * 按已安装 Koffi 主包的精确版本准备 Windows 双架构平台包，避免 npm ci 只安装宿主架构。
 * 复用 npm pack 和 tar，不运行 npm install，防止裁剪已准备的另一架构可选依赖。
 * @param {object} options 可注入项目根目录及 npm pack 执行器，默认使用当前项目与真实 npm。
 * @returns {void} 两个架构均完整时返回，否则抛出下载、解包或校验错误。
 * @author zhenghq
 */
export function prepareWindowsKoffi({ root = projectRoot, pack = runNpm } = {}) {
  const manifest = JSON.parse(readFileSync(join(root, 'node_modules', 'koffi', 'package.json'), 'utf8'))
  const { version } = manifest
  for (const arch of ['x64', 'arm64']) {
    const packageName = `@koromix/koffi-win32-${arch}`
    if (!version || manifest.optionalDependencies?.[packageName] !== version) {
      throw new Error(`Koffi ${version} 未声明匹配版本的 ${packageName}`)
    }
    const targetRoot = join(root, 'node_modules', '@koromix', `koffi-win32-${arch}`)
    if (isWindowsKoffiReady(targetRoot, packageName, version, arch)) continue
    const temporaryRoot = mkdtempSync(join(tmpdir(), `selection-translator-koffi-${arch}-`))
    try {
      const tarballName = readPackedTarballName(
        pack(['pack', `${packageName}@${version}`, '--pack-destination', temporaryRoot, '--silent'], temporaryRoot),
        packageName
      )
      const sourceRoot = extractPackedPackage(join(temporaryRoot, tarballName), join(temporaryRoot, 'extract'), packageName)
      if (!isWindowsKoffiReady(sourceRoot, packageName, version, arch)) {
        throw new Error(`Windows ${arch} Koffi 平台包内容不完整或版本不匹配: ${packageName}@${version}`)
      }
      rmSync(targetRoot, { recursive: true, force: true })
      mkdirSync(dirname(targetRoot), { recursive: true })
      cpSync(sourceRoot, targetRoot, { recursive: true, force: true })
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true })
    }
  }
  for (const arch of ['x64', 'arm64']) {
    const packageName = `@koromix/koffi-win32-${arch}`
    if (!isWindowsKoffiReady(join(root, 'node_modules', packageName), packageName, version, arch)) {
      throw new Error(`Windows ${arch} Koffi 运行时复核失败`)
    }
  }
  console.log(`Windows Koffi runtime 已就绪: ${version} (x64, arm64)`)
}

/**
 * 返回指定 Windows 架构的 N-API Canvas 平台包目录。
 * @param {'x64' | 'arm64'} arch Windows CPU 架构。
 * @returns {string} 平台包目录路径。
 * @author zhenghq
 */
function windowsCanvasPackageRoot(arch) {
  return join(projectRoot, 'node_modules', '@napi-rs', `canvas-win32-${arch}-msvc`)
}

/**
 * 判断指定 Windows 架构的 N-API Canvas 平台包是否完整且版本匹配。
 * @param {'x64' | 'arm64'} arch Windows CPU 架构。
 * @returns {boolean} 平台包是否可直接复用。
 * @author zhenghq
 */
function isWindowsCanvasReady(arch) {
  const packageRoot = windowsCanvasPackageRoot(arch)
  const packagePath = join(packageRoot, 'package.json')
  const bindingPath = join(packageRoot, `skia.win32-${arch}-msvc.node`)
  const icuPath = join(packageRoot, 'icudtl.dat')
  if (!existsSync(packagePath) || !existsSync(bindingPath) || !existsSync(icuPath)) return false
  try {
    return JSON.parse(readFileSync(packagePath, 'utf8')).version === expectedCanvasVersion
  } catch {
    return false
  }
}

/**
 * 通过 npm pack 下载指定 Windows 架构的 N-API Canvas 平台包并复制到项目。
 * @param {'x64' | 'arm64'} arch Windows CPU 架构。
 * @returns {void}
 * @author zhenghq
 */
function installWindowsCanvas(arch) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), `selection-translator-canvas-${arch}-`))
  const packageName = `@napi-rs/canvas-win32-${arch}-msvc`
  try {
    const tarballName = readPackedTarballName(
      runNpm(['pack', `${packageName}@${expectedCanvasVersion}`, '--pack-destination', temporaryRoot, '--silent'], temporaryRoot),
      packageName
    )
    const sourceRoot = extractPackedPackage(join(temporaryRoot, tarballName), join(temporaryRoot, 'extract'), packageName)
    const targetRoot = windowsCanvasPackageRoot(arch)
    rmSync(targetRoot, { recursive: true, force: true })
    mkdirSync(dirname(targetRoot), { recursive: true })
    cpSync(sourceRoot, targetRoot, { recursive: true, force: true })
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

/**
 * 校验指定 Windows 架构的 N-API Canvas binding 与 ICU 数据文件均已落盘。
 * @param {'x64' | 'arm64'} arch Windows CPU 架构。
 * @returns {void}
 * @author zhenghq
 */
function verifyWindowsCanvas(arch) {
  for (const path of [
    join(windowsCanvasPackageRoot(arch), `skia.win32-${arch}-msvc.node`),
    join(windowsCanvasPackageRoot(arch), 'icudtl.dat')
  ]) {
    if (!existsSync(path)) throw new Error(`Windows ${arch} Canvas 运行时缺少文件: ${path}`)
  }
}

/**
 * 编译 Windows UIA 选区直读 helper，确保安装包不会静默缺少原生取词组件。
 * @returns 无返回值；编译失败时抛出异常。
 * @author zhenghq
 */
function buildWindowsUiaReader() {
  const result = spawnSync(process.execPath, [join(projectRoot, 'scripts', 'build-windows-uia-reader.mjs')], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Windows UIA helper 构建失败，退出码 ${result.status}`)
  }
}

/**
 * 返回当前项目安装的 sharp 版本。
 * @returns sharp 的 package.json 版本号。
 * @author zhenghq
 */
function readSharpVersion() {
  const packagePath = require.resolve('sharp/package.json', { paths: [projectRoot] })
  return JSON.parse(readFileSync(packagePath, 'utf8')).version
}

/**
 * 返回指定 Windows 架构的 sharp 原生包目录。
 * @param arch Windows CPU 架构，仅支持 x64 或 arm64。
 * @returns sharp 原生包目录路径。
 * @author zhenghq
 */
function windowsSharpPackageRoot(arch) {
  return join(projectRoot, 'node_modules', '@img', `sharp-win32-${arch}`)
}

/**
 * 判断指定 Windows 架构的 sharp 原生包是否完整且版本匹配。
 * @param arch Windows CPU 架构，仅支持 x64 或 arm64。
 * @returns 原生包是否可直接复用。
 * @author zhenghq
 */
function isWindowsSharpReady(arch) {
  const packageRoot = windowsSharpPackageRoot(arch)
  const packagePath = join(packageRoot, 'package.json')
  const bindingPath = join(packageRoot, 'lib', `sharp-win32-${arch}.node`)
  const libvipsPath = join(packageRoot, 'lib', 'libvips-42.dll')
  if (!existsSync(packagePath) || !existsSync(bindingPath) || !existsSync(libvipsPath)) return false

  try {
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
    return packageJson.version === expectedSharpVersion
  } catch {
    return false
  }
}

/**
 * 在隔离的临时目录通过 npm pack 下载指定 Windows 架构的 sharp 原生包并解包到项目。
 * npm pack 不执行平台校验，可避免 x64 构建机下载 arm64 包时触发 EBADPLATFORM。
 * @param arch Windows CPU 架构，仅支持 x64 或 arm64。
 * @returns 无返回值；安装或复制失败时抛出异常。
 * @author zhenghq
 */
function installWindowsSharp(arch) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), `selection-translator-sharp-${arch}-`))
  const packageName = `@img/sharp-win32-${arch}`

  try {
    const tarballName = readPackedTarballName(
      runNpm(['pack', `${packageName}@${expectedSharpVersion}`, '--pack-destination', temporaryRoot, '--silent'], temporaryRoot),
      packageName
    )
    const sourceRoot = extractPackedPackage(join(temporaryRoot, tarballName), join(temporaryRoot, 'extract'), packageName)

    const targetRoot = windowsSharpPackageRoot(arch)
    rmSync(targetRoot, { recursive: true, force: true })
    mkdirSync(dirname(targetRoot), { recursive: true })
    cpSync(sourceRoot, targetRoot, { recursive: true, force: true })
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

/**
 * 校验指定 Windows 架构的 sharp 原生 binding 与 libvips DLL 均已落盘。
 * @param arch Windows CPU 架构，仅支持 x64 或 arm64。
 * @returns 无返回值；文件缺失时抛出异常。
 * @author zhenghq
 */
function verifyWindowsSharp(arch) {
  const packageName = `@img/sharp-win32-${arch}`
  const packageRoot = windowsSharpPackageRoot(arch)
  const bindingPath = join(packageRoot, 'lib', `sharp-win32-${arch}.node`)
  const libvipsPath = join(packageRoot, 'lib', 'libvips-42.dll')

  for (const path of [bindingPath, libvipsPath]) {
    if (!existsSync(path)) {
      throw new Error(`Windows ${arch} OCR 运行时缺少文件: ${path}`)
    }
  }
}

/**
 * 为 Windows x64/arm64 安装并验证 OCR 与 Koffi 原生运行库。
 * @returns 无返回值；任一架构准备失败时以非零退出码结束。
 * @author zhenghq
 */
function main() {
  buildWindowsUiaReader()
  prepareWindowsKoffi()

  const installedSharpVersion = readSharpVersion()
  if (installedSharpVersion !== expectedSharpVersion) {
    throw new Error(
      `当前 sharp 版本为 ${installedSharpVersion}，应为 ${expectedSharpVersion}；请先执行 npm install`
    )
  }

  for (const arch of ['x64', 'arm64']) {
    if (!isWindowsSharpReady(arch)) installWindowsSharp(arch)
    if (!isWindowsCanvasReady(arch)) installWindowsCanvas(arch)
  }

  // 最后统一复核，确保两个架构的 native binding 与 libvips DLL 都已落盘。
  verifyWindowsSharp('x64')
  verifyWindowsSharp('arm64')
  verifyWindowsCanvas('x64')
  verifyWindowsCanvas('arm64')

  console.log(
    `Windows OCR runtime 已就绪: sharp ${expectedSharpVersion}, @napi-rs/canvas ${expectedCanvasVersion} (x64, arm64)`
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Windows OCR runtime 准备失败: ${message}`)
    process.exitCode = 1
  }
}
