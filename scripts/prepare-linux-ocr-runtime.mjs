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
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm'
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
    const packResult = spawnSync(
      npmExecutable,
      ['pack', packageSpec, '--pack-destination', temporaryRoot, '--silent'],
      { cwd: temporaryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: process.env }
    )
    if (packResult.error) throw packResult.error
    if (packResult.status !== 0) {
      throw new Error(`下载 ${packageSpec} 失败，退出码 ${packResult.status}`)
    }

    const tarballName = String(packResult.stdout ?? '').trim().split(/\r?\n/u).filter(Boolean).at(-1)
    if (!tarballName) throw new Error(`npm pack 未返回 ${packageSpec} 的压缩包名称`)

    const tarballPath = join(temporaryRoot, tarballName)
    const extractRoot = join(temporaryRoot, `extract-${safeName}`)
    mkdirSync(extractRoot, { recursive: true })
    const extractResult = spawnSync('tar', ['-xzf', tarballPath, '-C', extractRoot], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      env: process.env
    })
    if (extractResult.error) throw extractResult.error
    if (extractResult.status !== 0) {
      throw new Error(`解包 ${packageSpec} 失败，退出码 ${extractResult.status}`)
    }

    const sourceRoot = join(extractRoot, 'package')
    if (!existsSync(sourceRoot)) throw new Error(`下载的 ${packageSpec} 缺少 package 目录`)
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
  }

  // 最后统一复核，确保两个架构的 native binding 与 libvips 动态库都已落盘。
  verifyLinuxSharp('x64')
  verifyLinuxSharp('arm64')

  console.log(`Linux OCR runtime 已就绪: sharp ${expectedSharpVersion} (x64, arm64)`)
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Linux OCR runtime 准备失败: ${message}`)
  process.exitCode = 1
}
