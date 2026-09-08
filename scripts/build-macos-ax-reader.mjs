import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = join(root, 'helpers', 'macos-ax-reader', 'main.m')
const outputPath = join(root, 'build', 'macos-ax-reader')
const moduleCachePath = join(root, 'build', 'clang-module-cache')

/**
 * 判断当前平台是否需要构建 macOS AX 选区直读 helper。
 * @returns 当前平台是否为 macOS。
 * @author zhenghq
 */
function shouldBuildForCurrentPlatform() {
  return process.platform === 'darwin'
}

/**
 * 调用 clang 编译 macOS AX 选区直读 helper。
 * @returns 无返回值。
 * @author zhenghq
 */
function buildHelper() {
  if (!existsSync(sourcePath)) {
    throw new Error(`缺少 macOS AX 选区直读 helper 源码: ${sourcePath}`)
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  mkdirSync(moduleCachePath, { recursive: true })
  const result = spawnSync('xcrun', [
    'clang',
    '-fobjc-arc',
    sourcePath,
    '-O2',
    '-fmodules',
    '-fmodules-cache-path=' + moduleCachePath,
    '-framework', 'ApplicationServices',
    '-framework', 'CoreGraphics',
    '-framework', 'Foundation',
    '-o', outputPath
  ], { stdio: 'inherit' })

  if (result.status !== 0) {
    throw new Error('macOS AX 选区直读 helper 编译失败')
  }
}

if (shouldBuildForCurrentPlatform()) {
  buildHelper()
} else {
  console.log('skip macOS AX reader helper build on non-darwin platform')
}
