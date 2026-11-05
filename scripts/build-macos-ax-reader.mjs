import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  hasNativeBuildForceFlag,
  isNativeBuildUpToDate,
  logNativeBuildUpToDate
} from './lib/native-build-cache.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const helperSourcePath = join(root, 'helpers', 'macos-ax-reader', 'main.m')
const addonSourcePath = join(root, 'helpers', 'macos-ax-reader', 'addon.mm')
const helperOutputPath = join(root, 'build', 'macos-ax-reader')
const addonOutputPath = join(root, 'build', 'macos-ax-reader.node')
const addonArm64Path = join(root, 'build', 'macos-ax-reader.arm64.node')
const addonX64Path = join(root, 'build', 'macos-ax-reader.x64.node')
const helperArm64Path = join(root, 'build', 'macos-ax-reader.arm64')
const helperX64Path = join(root, 'build', 'macos-ax-reader.x64')
const moduleCachePath = join(root, 'build', 'clang-module-cache')
const nodeApiIncludePath = join(
  root,
  'node_modules',
  'koffi',
  'vendor',
  'node-api-headers',
  'include'
)
const nodeApiHeaderPath = join(nodeApiIncludePath, 'node_api.h')
const forceBuild = hasNativeBuildForceFlag()

/** 打包的 macOS 目标架构；universal 可同时覆盖 Intel 与 Apple Silicon。 */
const MACOS_ARCHITECTURES = ['arm64', 'x86_64']

/**
 * 执行一次 clang 编译，并返回是否成功。
 * @param source 源码路径。
 * @param output 输出路径。
 * @param architecture 目标架构。
 * @param extraArguments 额外编译参数。
 * @returns 编译成功时返回 true。
 * @author zhenghq
 */
function compile(source, output, architecture, extraArguments) {
  const result = spawnSync('xcrun', [
    'clang',
    '-fobjc-arc',
    source,
    '-O2',
    '-fmodules',
    '-fmodules-cache-path=' + moduleCachePath,
    '-arch', architecture,
    ...extraArguments,
    '-framework', 'ApplicationServices',
    '-framework', 'CoreGraphics',
    '-framework', 'Foundation',
    '-o', output
  ], { stdio: 'inherit' })
  return result.status === 0
}

/**
 * 将多个同类型 Mach-O 文件合并为 universal 文件；失败时回退首个可用产物。
 * @param inputs 分架构输入路径。
 * @param output universal 输出路径。
 * @param fallback 合并失败时保留的单架构文件。
 * @returns 无返回值。
 * @author zhenghq
 */
function createUniversalBinary(inputs, output, fallback) {
  if (inputs.length <= 1) {
    if (inputs[0]) {
      spawnSync('cp', [inputs[0], output], { stdio: 'inherit' })
    }
    return
  }
  const result = spawnSync('lipo', ['-create', ...inputs, '-output', output], { stdio: 'inherit' })
  if (result.status === 0) return
  console.warn(`lipo 合并失败，回退单架构产物: ${fallback}`)
  spawnSync('cp', [fallback, output], { stdio: 'inherit' })
}

/**
 * 构建每个架构的 CLI helper 与 N-API addon，并合并为 universal 产物。
 * @returns 无返回值。
 * @author zhenghq
 */
function buildMacosAxArtifacts() {
  if (!existsSync(helperSourcePath)) {
    throw new Error(`缺少 macOS AX 选区直读 helper 源码: ${helperSourcePath}`)
  }
  if (!existsSync(addonSourcePath)) {
    throw new Error(`缺少 macOS AX N-API addon 源码: ${addonSourcePath}`)
  }
  if (!existsSync(nodeApiHeaderPath)) {
    throw new Error(`缺少 Node-API 头文件: ${nodeApiIncludePath}`)
  }
  if (!forceBuild && isNativeBuildUpToDate(
    [helperOutputPath, addonOutputPath],
    [helperSourcePath, addonSourcePath, nodeApiHeaderPath]
  )) {
    logNativeBuildUpToDate('macOS AX reader helper')
    return
  }

  mkdirSync(dirname(helperOutputPath), { recursive: true })
  mkdirSync(moduleCachePath, { recursive: true })

  const helperInputs = []
  const addonInputs = []
  for (const architecture of MACOS_ARCHITECTURES) {
    const helperPath = architecture === 'arm64' ? helperArm64Path : helperX64Path
    const addonPath = architecture === 'arm64' ? addonArm64Path : addonX64Path
    if (compile(helperSourcePath, helperPath, architecture, [])) helperInputs.push(helperPath)
    if (compile(addonSourcePath, addonPath, architecture, [
      '-I', nodeApiIncludePath,
      '-bundle',
      '-undefined', 'dynamic_lookup'
    ])) {
      addonInputs.push(addonPath)
    }
  }

  if (helperInputs.length === 0) {
    throw new Error('macOS AX 选区直读 helper 编译失败')
  }
  if (addonInputs.length === 0) {
    throw new Error('macOS AX N-API addon 编译失败')
  }
  createUniversalBinary(helperInputs, helperOutputPath, helperInputs[0])
  createUniversalBinary(addonInputs, addonOutputPath, addonInputs[0])
  for (const temporaryPath of [
    helperArm64Path,
    helperX64Path,
    addonArm64Path,
    addonX64Path
  ]) {
    rmSync(temporaryPath, { force: true })
  }
}

/**
 * 判断当前平台是否需要构建 macOS AX 选区直读 helper。
 * @returns 当前平台是否为 macOS。
 * @author zhenghq
 */
function shouldBuildForCurrentPlatform() {
  return process.platform === 'darwin'
}

/**
 * 调用 clang 编译 macOS AX 选区直读 helper 与主进程 N-API addon。
 * @returns 无返回值。
 * @author zhenghq
 */
function buildHelper() {
  buildMacosAxArtifacts()
}

if (shouldBuildForCurrentPlatform()) {
  buildHelper()
} else {
  console.log('skip macOS AX reader helper build on non-darwin platform')
}
