import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const uiohookPackageRoot = dirname(require.resolve('uiohook-napi/package.json', { paths: [projectRoot] }))
const prebuildsRoot = join(uiohookPackageRoot, 'prebuilds')
const bundledRoot = join(projectRoot, 'build', 'uiohook-prebuilds')

/** Linux 目标架构与其对应 npm 预编译目录。 */
const LINUX_ARCHITECTURES = ['x64', 'arm64']
/** npm 包自带、但不会用于 AppImage 且引用 glibc 2.34 的预编译目录。 */
const UNUSED_PREBUILD_DIRECTORIES = ['linux-loong64']
/** AppImageHub 兼容性检查要求 glibc 不高于 2.28（Ubuntu 20.04 / Debian 10）。 */
const MAX_GLIBC_VERSION = '2.28'

/**
 * 返回随仓库分发的低 glibc 预编译产物路径。
 * @param arch Linux CPU 架构，仅支持 x64 或 arm64。
 * @returns 预编译原生模块路径。
 * @author zhenghq
 */
function bundledBindingPath(arch) {
  return join(bundledRoot, `linux-${arch}`, 'uiohook-napi.node')
}

/**
 * 返回 uiohook 包内用于运行时加载的预编译目录。
 * @param arch Linux CPU 架构，仅支持 x64 或 arm64。
 * @returns npm 包内的预编译目录路径。
 * @author zhenghq
 */
function packagePrebuildDirectory(arch) {
  return join(prebuildsRoot, `linux-${arch}`)
}

/**
 * 读取 ELF 原生模块引用的最高 glibc 版本。
 *
 * 版本号以字符串常量形式保存在 ELF 的版本需求段中，直接扫描字节即可识别，
 * 这样无需依赖 objdump，可在 macOS/Windows 构建机上执行同一套校验。
 * @param bindingPath 原生模块路径。
 * @returns 最高 glibc 版本号（例如 2.28）；未检测到版本时返回 null。
 * @author zhenghq
 */
function readRequiredGlibcVersion(bindingPath) {
  const content = readFileSync(bindingPath).toString('latin1')
  const matches = content.match(/GLIBC_(\d+\.\d+)/gu)
  if (!matches) return null
  const versions = [...new Set(matches.map((version) => version.replace(/^GLIBC_/u, '')))]
  return versions.sort(compareVersion).at(-1) ?? null
}

/**
 * 按数值比较点分版本号，供排序与上限校验使用。
 * @param left 左侧版本号。
 * @param right 右侧版本号。
 * @returns 负数、0 或正数，分别表示 left 小于、等于或大于 right。
 * @author zhenghq
 */
function compareVersion(left, right) {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * 校验指定架构的低 glibc 产物存在、非空且 glibc 上限符合 AppImageHub 要求。
 * @param arch Linux CPU 架构，仅支持 x64 或 arm64。
 * @returns 无返回值；校验失败时抛出异常。
 * @author zhenghq
 */
function verifyBundledBinding(arch) {
  const bindingPath = bundledBindingPath(arch)
  if (!existsSync(bindingPath)) {
    throw new Error(`缺少 Linux ${arch} 的 uiohook 预编译产物: ${bindingPath}`)
  }

  const glibcVersion = readRequiredGlibcVersion(bindingPath)
  if (glibcVersion === null) {
    throw new Error(`无法读取 Linux ${arch} uiohook 产物的 glibc 版本: ${bindingPath}`)
  }
  if (compareVersion(glibcVersion, MAX_GLIBC_VERSION) > 0) {
    throw new Error(
      `Linux ${arch} uiohook 产物引用 glibc ${glibcVersion}，超过上限 ${MAX_GLIBC_VERSION}: ${bindingPath}`
    )
  }
}

/**
 * 用低 glibc 产物替换 npm 包内的预编译模块，并删除不会被使用却会引入高 glibc 符号的目录。
 * @returns 无返回值；准备或校验失败时抛出异常。
 * @author zhenghq
 */
function prepareLinuxUiohookRuntime() {
  if (!existsSync(uiohookPackageRoot)) {
    throw new Error('未找到 uiohook-napi，请先执行 npm install')
  }

  for (const arch of LINUX_ARCHITECTURES) {
    verifyBundledBinding(arch)
    const targetDirectory = packagePrebuildDirectory(arch)
    rmSync(targetDirectory, { recursive: true, force: true })
    cpSync(join(bundledRoot, `linux-${arch}`), targetDirectory, { recursive: true, force: true })
  }

  for (const directory of UNUSED_PREBUILD_DIRECTORIES) {
    rmSync(join(prebuildsRoot, directory), { recursive: true, force: true })
  }

  for (const arch of LINUX_ARCHITECTURES) {
    const targetPath = join(packagePrebuildDirectory(arch), 'uiohook-napi.node')
    if (!existsSync(targetPath)) {
      throw new Error(`替换后缺少 Linux ${arch} 的 uiohook 预编译产物: ${targetPath}`)
    }
    const glibcVersion = readRequiredGlibcVersion(targetPath)
    if (glibcVersion === null || compareVersion(glibcVersion, MAX_GLIBC_VERSION) > 0) {
      throw new Error(`替换后的 Linux ${arch} uiohook 产物 glibc 版本不符合要求: ${glibcVersion ?? '未知'}`)
    }
  }

  const remaining = existsSync(prebuildsRoot) ? readdirSync(prebuildsRoot).sort() : []
  console.log(`Linux uiohook runtime 已就绪: ${LINUX_ARCHITECTURES.join(', ')}；剩余预编译目录: ${remaining.join(', ')}`)
}

try {
  prepareLinuxUiohookRuntime()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Linux uiohook runtime 准备失败: ${message}`)
  process.exitCode = 1
}
