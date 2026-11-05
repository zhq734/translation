import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  hasNativeBuildForceFlag,
  isNativeBuildUpToDate,
  logNativeBuildUpToDate
} from './lib/native-build-cache.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cargoManifestPath = join(root, 'sidecar/mimi-audio/Cargo.toml')
const cargoLockPath = join(root, 'sidecar/mimi-audio/Cargo.lock')
const cargoSourceDirectory = join(root, 'sidecar/mimi-audio/src')
const targetDirectory = join(root, 'sidecar/mimi-audio/target')
const outputPath = join(root, 'build/macos-subtitle-audio')
const forceBuild = hasNativeBuildForceFlag()

/** 实时字幕 sidecar 需要同时支持的 macOS Rust target。 */
const MACOS_TARGETS = [
  { rustTarget: 'aarch64-apple-darwin', artifact: join(targetDirectory, 'aarch64-apple-darwin/release/mimi-audio-sidecar') },
  { rustTarget: 'x86_64-apple-darwin', artifact: join(targetDirectory, 'x86_64-apple-darwin/release/mimi-audio-sidecar') }
]

/**
 * 递归收集 Rust sidecar 源码文件，用于判断 universal 产物是否过期。
 * @param directory 要遍历的源码目录。
 * @returns 源码文件绝对路径列表。
 * @author zhenghq
 */
function collectRustSourceFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? collectRustSourceFiles(path) : [path]
  })
}

/**
 * 判断当前平台是否需要构建 macOS 实时字幕 sidecar。
 * @returns 当前平台是否为 macOS。
 * @author zhenghq
 */
function shouldBuildForCurrentPlatform() {
  return process.platform === 'darwin'
}

/**
 * 读取已安装的 Rust target 列表，便于在交叉编译前给出明确提示。
 * @returns 已安装 target 集合；无法读取时返回空集合。
 * @author zhenghq
 */
function readInstalledRustTargets() {
  const result = spawnSync('rustup', ['target', 'list', '--installed'], { encoding: 'utf8' })
  if (result.status !== 0) return new Set()
  return new Set(result.stdout.split(/\s+/u).filter(Boolean))
}

/**
 * 读取 rustup stable 工具链的 rustc 路径，确保 Cargo 与目标标准库使用同一版本。
 * @returns rustc 路径；无法读取时返回 null。
 * @author zhenghq
 */
function resolveStableRustc() {
  const result = spawnSync('rustup', ['which', '--toolchain', 'stable', 'rustc'], {
    encoding: 'utf8'
  })
  if (result.status !== 0) return null
  return result.stdout.trim() || null
}

/**
 * 编译单个架构的 Rust sidecar。
 * @param target macOS Rust target 描述。
 * @returns 编译成功时返回 true。
 * @author zhenghq
 */
function compile(target) {
  const rustcPath = resolveStableRustc()
  if (!rustcPath) return false
  const result = spawnSync('rustup', [
    'run',
    'stable',
    'cargo',
    'build',
    '--release',
    '--manifest-path', cargoManifestPath,
    '--target', target.rustTarget
  ], {
    stdio: 'inherit',
    env: { ...process.env, RUSTC: rustcPath }
  })
  return result.status === 0
}

/**
 * 构建 arm64 与 x86_64 产物并合并为 macOS universal sidecar。
 * @returns 无返回值。
 * @author zhenghq
 */
function buildHelper() {
  if (!existsSync(cargoManifestPath)) {
    throw new Error(`缺少实时字幕 Rust sidecar 清单: ${cargoManifestPath}`)
  }
  const rustInputs = [
    cargoManifestPath,
    cargoLockPath,
    ...collectRustSourceFiles(cargoSourceDirectory)
  ].filter(existsSync)
  if (!forceBuild && isNativeBuildUpToDate([outputPath], rustInputs)) {
    logNativeBuildUpToDate('macOS realtime subtitle sidecar')
    return
  }

  const installedTargets = readInstalledRustTargets()
  const missingTargets = MACOS_TARGETS
    .map((target) => target.rustTarget)
    .filter((target) => !installedTargets.has(target))
  if (missingTargets.length > 0) {
    throw new Error([
      `缺少 Rust 交叉编译 target: ${missingTargets.join(', ')}`,
      '请先执行：',
      ...missingTargets.map((target) => `rustup target add ${target}`)
    ].join('\n'))
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  for (const target of MACOS_TARGETS) {
    if (!compile(target)) {
      throw new Error(`macOS 实时字幕 Rust sidecar ${target.rustTarget} 编译失败`)
    }
    if (!existsSync(target.artifact)) {
      throw new Error(`未找到 Rust sidecar 产物: ${target.artifact}`)
    }
  }

  const lipoResult = spawnSync('lipo', [
    '-create',
    ...MACOS_TARGETS.map((target) => target.artifact),
    '-output', outputPath
  ], { stdio: 'inherit' })
  if (lipoResult.status !== 0) {
    throw new Error('macOS 实时字幕 Rust sidecar universal 合并失败')
  }
}

if (shouldBuildForCurrentPlatform()) {
  buildHelper()
} else {
  console.log('skip macOS realtime subtitle sidecar build on non-darwin platform')
}
