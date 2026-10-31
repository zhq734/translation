import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const expectedSharpVersion = '0.34.2'
const expectedLibvipsVersion = '1.1.0'
const expectedCanvasVersion = '1.1.0'

/**
 * 通过当前 Node 启动 npm CLI，兼容 Windows 构建机上直接 spawn npm.cmd 返回 EINVAL 的情况。
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
 * 返回指定 Linux 架构的 N-API Canvas 平台包目录。
 * @param {'x64' | 'arm64'} arch Linux CPU 架构。
 * @returns {string} 平台包目录路径。
 * @author zhenghq
 */
function linuxCanvasPackageRoot(arch) {
  return join(projectRoot, 'node_modules', '@napi-rs', `canvas-linux-${arch}-gnu`)
}

/**
 * 判断指定 Linux 架构的 N-API Canvas 平台包是否完整且版本匹配。
 * @param {'x64' | 'arm64'} arch Linux CPU 架构。
 * @returns {boolean} 平台包是否可直接复用。
 * @author zhenghq
 */
function isLinuxCanvasReady(arch) {
  const packageRoot = linuxCanvasPackageRoot(arch)
  const packagePath = join(packageRoot, 'package.json')
  const bindingPath = join(packageRoot, `skia.linux-${arch}-gnu.node`)
  if (!existsSync(packagePath) || !existsSync(bindingPath)) return false
  try {
    return JSON.parse(readFileSync(packagePath, 'utf8')).version === expectedCanvasVersion
  } catch {
    return false
  }
}

/**
 * 通过 npm pack 下载指定 Linux 架构的 N-API Canvas 平台包并复制到项目。
 * @param {'x64' | 'arm64'} arch Linux CPU 架构。
 * @returns {void}
 * @author zhenghq
 */
function installLinuxCanvas(arch) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), `selection-translator-canvas-linux-${arch}-`))
  const packageName = `@napi-rs/canvas-linux-${arch}-gnu`
  try {
    const tarballName = readPackedTarballName(
      runNpm(['pack', `${packageName}@${expectedCanvasVersion}`, '--pack-destination', temporaryRoot, '--silent'], temporaryRoot),
      packageName
    )
    const sourceRoot = extractPackedPackage(join(temporaryRoot, tarballName), join(temporaryRoot, 'extract'), packageName)
    const targetRoot = linuxCanvasPackageRoot(arch)
    rmSync(targetRoot, { recursive: true, force: true })
    mkdirSync(dirname(targetRoot), { recursive: true })
    cpSync(sourceRoot, targetRoot, { recursive: true, force: true })
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

/**
 * 校验指定 Linux 架构的 N-API Canvas binding 已落盘。
 * @param {'x64' | 'arm64'} arch Linux CPU 架构。
 * @returns {void}
 * @author zhenghq
 */
function verifyLinuxCanvas(arch) {
  const bindingPath = join(linuxCanvasPackageRoot(arch), `skia.linux-${arch}-gnu.node`)
  if (!existsSync(bindingPath)) {
    throw new Error(`Linux ${arch} Canvas 运行时缺少文件: ${bindingPath}`)
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
 * 返回指定 Linux 架构的 sharp 原生包目录。
 * @param arch Linux CPU 架构，仅支持 x64 或 arm64。
 * @returns sharp 原生包目录路径。
 * @author zhenghq
 */
function linuxSharpPackageRoot(arch) {
  return join(projectRoot, 'node_modules', '@img', `sharp-linux-${arch}`)
}

/**
 * 返回指定 Linux 架构的 libvips 原生包目录。
 * @param arch Linux CPU 架构，仅支持 x64 或 arm64。
 * @returns libvips 原生包目录路径。
 * @author zhenghq
 */
function linuxLibvipsPackageRoot(arch) {
  return join(projectRoot, 'node_modules', '@img', `sharp-libvips-linux-${arch}`)
}

/**
 * 判断指定 Linux 架构的 sharp 与 libvips 原生包是否完整且版本匹配。
 * @param arch Linux CPU 架构，仅支持 x64 或 arm64。
 * @returns 原生运行时是否可直接复用。
 * @author zhenghq
 */
function isLinuxSharpReady(arch) {
  const sharpRoot = linuxSharpPackageRoot(arch)
  const libvipsRoot = linuxLibvipsPackageRoot(arch)
  const sharpPackagePath = join(sharpRoot, 'package.json')
  const libvipsPackagePath = join(libvipsRoot, 'package.json')
  const bindingPath = join(sharpRoot, 'lib', `sharp-linux-${arch}.node`)
  const libvipsPath = join(libvipsRoot, 'lib', 'libvips-cpp.so.8.16.1')
  if (
    !existsSync(sharpPackagePath) ||
    !existsSync(libvipsPackagePath) ||
    !existsSync(bindingPath) ||
    !existsSync(libvipsPath)
  ) {
    return false
  }

  try {
    const sharpPackage = JSON.parse(readFileSync(sharpPackagePath, 'utf8'))
    const libvipsPackage = JSON.parse(readFileSync(libvipsPackagePath, 'utf8'))
    return sharpPackage.version === expectedSharpVersion &&
      libvipsPackage.version === expectedLibvipsVersion
  } catch {
    return false
  }
}

/**
 * 在隔离的临时目录安装指定 Linux 架构的 sharp 与 libvips 原生包并复制到项目，
 * 避免连续 npm install 触发可选依赖裁剪而丢失另一架构。
 * @param arch Linux CPU 架构，仅支持 x64 或 arm64。
 * @returns 无返回值；安装或复制失败时抛出异常。
 * @author zhenghq
 */
function installLinuxSharp(arch) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), `selection-translator-sharp-linux-${arch}-`))
  const sharpPackageName = `@img/sharp-linux-${arch}`
  const libvipsPackageName = `@img/sharp-libvips-linux-${arch}`

  /**
   * 通过 npm pack 下载指定包并解包到目标目录，避免 npm install 的宿主平台校验。
   * @param packageSpec npm 包名与版本。
   * @param targetRoot 目标包目录。
   * @returns 无返回值；下载或解包失败时抛出异常。
   * @author zhenghq
   */
  function unpackPackage(packageSpec, targetRoot) {
    const safeName = packageSpec.replace(/^@/u, '').replace(/\//gu, '-')
    const tarballName = readPackedTarballName(
      runNpm(['pack', packageSpec, '--pack-destination', temporaryRoot, '--silent'], temporaryRoot),
      packageSpec
    )

    const tarballPath = join(temporaryRoot, tarballName)
    const extractRoot = join(temporaryRoot, `extract-${safeName}`)
    const sourceRoot = extractPackedPackage(tarballPath, extractRoot, packageSpec)
    rmSync(targetRoot, { recursive: true, force: true })
    mkdirSync(dirname(targetRoot), { recursive: true })
    cpSync(sourceRoot, targetRoot, { recursive: true, force: true })
  }

  try {
    unpackPackage(`${sharpPackageName}@${expectedSharpVersion}`, linuxSharpPackageRoot(arch))
    unpackPackage(`${libvipsPackageName}@${expectedLibvipsVersion}`, linuxLibvipsPackageRoot(arch))
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

/**
 * 校验指定 Linux 架构的 sharp binding 与 libvips 动态库均已落盘。
 * @param arch Linux CPU 架构，仅支持 x64 或 arm64。
 * @returns 无返回值；文件缺失时抛出异常。
 * @author zhenghq
 */
function verifyLinuxSharp(arch) {
  const bindingPath = join(linuxSharpPackageRoot(arch), 'lib', `sharp-linux-${arch}.node`)
  const libvipsPath = join(linuxLibvipsPackageRoot(arch), 'lib', 'libvips-cpp.so.8.16.1')

  for (const path of [bindingPath, libvipsPath]) {
    if (!existsSync(path)) {
      throw new Error(`Linux ${arch} OCR 运行时缺少文件: ${path}`)
    }
  }
}

/**
 * 为 Linux x64/arm64 安装并验证 PaddleOCR 使用的 sharp native runtime。
 * @returns 无返回值；任一架构准备失败时以非零退出码结束。
 * @author zhenghq
 */
function main() {
  const installedSharpVersion = readSharpVersion()
  if (installedSharpVersion !== expectedSharpVersion) {
    throw new Error(
      `当前 sharp 版本为 ${installedSharpVersion}，应为 ${expectedSharpVersion}；请先执行 npm install`
    )
  }

  for (const arch of ['x64', 'arm64']) {
    if (!isLinuxSharpReady(arch)) installLinuxSharp(arch)
    if (!isLinuxCanvasReady(arch)) installLinuxCanvas(arch)
  }

  // 最后统一复核，确保两个架构的 native binding 与 libvips 动态库都已落盘。
  verifyLinuxSharp('x64')
  verifyLinuxSharp('arm64')
  verifyLinuxCanvas('x64')
  verifyLinuxCanvas('arm64')

  console.log(
    `Linux OCR runtime 已就绪: sharp ${expectedSharpVersion}, @napi-rs/canvas ${expectedCanvasVersion} (x64, arm64)`
  )
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Linux OCR runtime 准备失败: ${message}`)
  process.exitCode = 1
}
