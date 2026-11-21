import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
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
const targetDirectory = join(root, 'sidecar/mimi-audio/target')
const outputPath = join(root, 'build/linux-subtitle-audio')
const forceBuild = hasNativeBuildForceFlag()

/**
 * 读取当前主机对应的 Linux Rust target。
 * @returns 当前主机架构匹配的 target 描述。
 * @author zhenghq
 */
function resolveCurrentTarget() {
  return process.arch === 'arm64'
    ? { rustTarget: 'aarch64-unknown-linux-gnu', artifact: join(targetDirectory, 'aarch64-unknown-linux-gnu/release/mimi-audio-sidecar') }
    : { rustTarget: 'x86_64-unknown-linux-gnu', artifact: join(targetDirectory, 'x86_64-unknown-linux-gnu/release/mimi-audio-sidecar') }
}

/**
 * 判断当前平台是否需要构建 Linux 实时字幕 sidecar。
 * @returns 当前平台是否为 Linux。
 * @author zhenghq
 */
function shouldBuildForCurrentPlatform() {
  return process.platform === 'linux'
}

/**
 * 编译当前架构的 Rust sidecar。
 * @param target Linux Rust target 描述。
 * @returns 编译成功时返回 true。
 * @author zhenghq
 */
function compile(target) {
  const result = spawnSync('cargo', [
    'build',
    '--release',
    '--manifest-path', cargoManifestPath,
    '--target', target.rustTarget
  ], { stdio: 'inherit' })
  return result.status === 0
}

/**
 * 构建当前架构的 Linux sidecar 并复制到打包输出路径。
 * @returns 无返回值。
 * @author zhenghq
 */
function buildHelper() {
  if (!existsSync(cargoManifestPath)) {
    throw new Error(`缺少实时字幕 Rust sidecar 清单: ${cargoManifestPath}`)
  }
  const rustInputs = [cargoManifestPath, cargoLockPath].filter(existsSync)
  if (!forceBuild && isNativeBuildUpToDate([outputPath], rustInputs)) {
    logNativeBuildUpToDate('Linux realtime subtitle sidecar')
    return
  }
  const target = resolveCurrentTarget()
  if (!compile(target)) {
    throw new Error(`Linux 实时字幕 Rust sidecar ${target.rustTarget} 编译失败`)
  }
  if (!existsSync(target.artifact)) {
    throw new Error(`未找到 Rust sidecar 产物: ${target.artifact}`)
  }
  mkdirSync(dirname(outputPath), { recursive: true })
  copyFileSync(target.artifact, outputPath)
}

if (shouldBuildForCurrentPlatform()) {
  buildHelper()
} else {
  console.log('skip Linux realtime subtitle sidecar build on non-linux platform')
}
