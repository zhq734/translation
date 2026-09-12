import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const expectedSharpVersion = '0.34.2'

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
 * 在隔离的临时目录安装指定 Windows 架构的 sharp 原生包并复制到项目，
 * 避免连续 npm install 触发可选依赖裁剪而丢失另一架构。
 * @param arch Windows CPU 架构，仅支持 x64 或 arm64。
 * @returns 无返回值；安装或复制失败时抛出异常。
 * @author zhenghq
 */
function installWindowsSharp(arch) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), `selection-translator-sharp-${arch}-`))
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const packageName = `@img/sharp-win32-${arch}`

  try {
    writeFileSync(
      join(temporaryRoot, 'package.json'),
      JSON.stringify({ name: `sharp-win32-${arch}-runtime`, private: true }, null, 2)
    )
    const result = spawnSync(
      npmExecutable,
      [
        'install',
        '--no-save',
        '--package-lock=false',
        '--include=optional',
        `--os=win32`,
        `--cpu=${arch}`,
        `${packageName}@${expectedSharpVersion}`
      ],
      {
        cwd: temporaryRoot,
        encoding: 'utf8',
        stdio: 'inherit',
        env: process.env
      }
    )

    if (result.error) throw result.error
    if (result.status !== 0) {
      throw new Error(`安装 Windows ${arch} 的 sharp ${expectedSharpVersion} 失败，退出码 ${result.status}`)
    }

    const sourceRoot = join(temporaryRoot, 'node_modules', '@img', `sharp-win32-${arch}`)
    if (!existsSync(sourceRoot)) {
      throw new Error(`npm 未安装预期的 Windows ${arch} sharp 包: ${packageName}`)
    }

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
 * 为 Windows x64/arm64 安装并验证 PaddleOCR 使用的 sharp native runtime。
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
    if (!isWindowsSharpReady(arch)) installWindowsSharp(arch)
  }

  // 最后统一复核，确保两个架构的 native binding 与 libvips DLL 都已落盘。
  verifyWindowsSharp('x64')
  verifyWindowsSharp('arm64')

  console.log(`Windows OCR runtime 已就绪: sharp ${expectedSharpVersion} (x64, arm64)`)
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Windows OCR runtime 准备失败: ${message}`)
  process.exitCode = 1
}
