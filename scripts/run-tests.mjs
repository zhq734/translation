import { build } from 'esbuild'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * 发现 tests 目录下的 TypeScript 测试入口。
 * @returns 按文件名排序的测试入口列表。
 * @author zhenghq
 */
function discoverTestEntries() {
  return readdirSync('tests')
    .filter((file) => file.endsWith('.test.ts'))
    .sort()
    .map((file) => join('tests', file))
}

/**
 * 将 TypeScript 测试临时打包后交给 Node.js 内置测试运行器执行，兼容项目声明的 Node.js 18+。
 * @returns 测试进程退出码。
 * @author zhenghq
 */
async function runTests() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'selection-translator-tests-'))
  try {
    const entryPoints = discoverTestEntries()
    await build({
      entryPoints,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node18',
      outdir: temporaryDirectory,
      outExtension: { '.js': '.mjs' },
      logLevel: 'silent'
    })
    const outputFiles = entryPoints.map((entry) =>
      join(temporaryDirectory, entry.replace(/^tests\//u, '').replace(/\.ts$/u, '.mjs'))
    )
    const result = spawnSync(process.execPath, ['--test', ...outputFiles], { stdio: 'inherit' })
    return result.status ?? 1
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

process.exitCode = await runTests()
