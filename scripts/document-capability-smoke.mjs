import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const projectRoot = resolve(import.meta.dirname, '..')
const require = createRequire(join(projectRoot, 'package.json'))

/**
 * 隐藏输出中的本地绝对路径，避免冒烟结果泄露开发机目录。
 * @param value 待处理文本。
 * @returns 已脱敏文本。
 * @author zhenghq
 */
function sanitizeOutput(value) {
  return String(value ?? '').replaceAll(projectRoot, '<project>').trim()
}

/**
 * 使用 Electron 内置 Node 运行文档能力冒烟，确保 canvas 原生 ABI 与生产环境一致。
 * @returns 进程退出码。
 * @author zhenghq
 */
async function run() {
  const temporaryDirectory = mkdtempSync(join(projectRoot, '.document-capability-smoke-'))
  try {
    const bundlePath = join(temporaryDirectory, 'document-capability-smoke.mjs')
    await build({
      entryPoints: [join(projectRoot, 'scripts/document-capability-smoke-entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      outfile: bundlePath,
      logLevel: 'silent',
      external: [
        'canvas',
        'path2d-polyfill',
        'pdfjs-dist',
        'pdfjs-dist/*',
        'pdf-lib',
        '@pdf-lib/fontkit'
      ]
    })
    const electronExecutable = require('electron')
    const result = spawnSync(electronExecutable, [bundlePath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1'
      },
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024
    })
    if (result.stdout) process.stdout.write(sanitizeOutput(result.stdout) + '\n')
    if (result.stderr) process.stderr.write(sanitizeOutput(result.stderr) + '\n')
    if (result.error) process.stderr.write(sanitizeOutput(result.error.message) + '\n')
    return result.status ?? 1
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

process.exitCode = await run()
